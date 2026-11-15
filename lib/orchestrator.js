/**
 * Run orchestration for dsh-superagent.
 *
 * A run moves through queued -> planning -> running -> aggregating and ends in
 * completed, partial, failed, cancelled, or interrupted. Planning, subtask
 * execution, and aggregation all happen in child agents; this module owns
 * ordering, retries, quotas, cancellation, and durable status.
 *
 * A state directory can be shared by more than one host process (two profiles,
 * or a synced folder), so every decision about an active run is made from
 * persisted evidence — heartbeat, owner pid, and the run lock — and never from
 * this process's memory alone.
 *
 * The module has no host imports: `spawnChild`, `readUsage`, `notify`, and
 * `store` are injected, which keeps it testable without a running harness.
 *
 * @module dsh-superagent/orchestrator
 */
import { createHash, randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyCost, computeCost } from './cost.js'
import {
  assessRound,
  buildRoundInstruction,
  composeGoalReport,
  fingerprintWorkspace,
  hasMachineChecks,
  normalizeGoalSpec,
  parseVerdict,
  roundGoal,
  runChecks,
  verifierPrompt,
} from './goal.js'
import { extractMemoryBlock } from './memory.js'
import { extractUserMemoryBlock } from './user-memory.js'
import { ACTIVE_STATUSES, GOAL_GUARD_PREFIX, TERMINAL_STATUSES } from './store.js'
import { createWorkspaceManager } from './workspace.js'

const STATUS_POLL_MS = 250
/** How often the owning process checks for a cancel marker written elsewhere. */
const CANCEL_POLL_MS = 1000
/** How long a cancel from another process waits for the owner to acknowledge. */
const CANCEL_ACK_MS = 5000
/** How often a live run refreshes its heartbeat in the state file. */
const HEARTBEAT_MS = 30 * 1000
/** How often a running planner attempt is checked against its call budget. */
const PLANNER_POLL_MS = 250
/** A run with no heartbeat for this long is treated as orphaned. */
const ORPHAN_MS = 3 * HEARTBEAT_MS
/** A child that ignores abort must not hold a cancel call open forever. */
const DISPOSE_MS = 1500
/** Waking the owning session must not hold a finished run open forever. */
const NOTIFY_MS = 15 * 1000
/** A run lock older than this belongs to a process that never released it. */
const LOCK_STALE_MS = 10 * 60 * 1000
/** How long a start waits for another process that is claiming the same goal. */
const GOAL_GUARD_WAIT_MS = 5000
/** How often that wait re-tries the goal guard. */
const GOAL_GUARD_POLL_MS = 50

/** First retry delay for a failure that looks transient; it doubles per attempt. */
const RETRY_BASE_MS = 2000
/** A retry delay never grows past this, so a long run cannot stall for hours. */
const RETRY_CAP_MS = 60 * 1000

/** Fenced block a worker or the aggregator uses to ask for a decision. */
const ATTENTION_FENCE = /```attention[^\n]*\n([\s\S]*?)```/i

/** Instructions kept per run; older ones are dropped so a long dialog stays bounded. */
const FOLLOWUP_MAX = 8
/** Characters kept from one instruction or answer. */
const FOLLOWUP_MAX_CHARS = 1000
/** Live injection receipts kept per run; each may target several workers. */
const INJECTION_MAX = 12
/** Poll period for the measurement of one step boundary, in milliseconds. */
const INJECT_POLL_MS = 25
/** How many expired attention batches stay readable for a late answer. */
const ATTENTION_HISTORY_MAX = 5

/**
 * Which pipeline a run uses.
 *
 * `planned` is the default: a planner splits the goal, workers run in parallel,
 * and an aggregator merges their reports. `direct` is for one self-contained
 * task: a single worker does it, there is no plan and no merge, and its reply
 * is the report verbatim. Direct saves two model calls and the coordination
 * they need, so it is right for a single lookup, edit, query, or short piece of
 * writing — and wrong for a goal with parts that can be worked in parallel.
 *
 * @param {unknown} value - requested mode.
 * @returns {'planned' | 'direct'} normalized mode.
 */
export function normalizeMode(value) {
  if (value === undefined || value === null || value === '') return 'planned'
  const text = String(value).trim().toLowerCase()
  if (text === 'planned' || text === 'direct') return text
  throw new Error(
    `unknown mode ${JSON.stringify(value)}; use "planned" (multi-worker) or "direct" (one worker, no planning or aggregation)`,
  )
}

/**
 * Canonical form of a goal: case and runs of whitespace are formatting, not a
 * different request, so they must not defeat duplicate detection.
 *
 * @param {unknown} goal - raw goal text.
 * @returns {string} normalized goal, or '' when there is no goal.
 */
export function normalizeGoal(goal) {
  if (typeof goal !== 'string') return ''
  return goal.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Stable identity of one goal, used to dispatch the same work only once.
 * @param {unknown} goal - raw goal text.
 * @returns {string | null} sha256 hex of the normalized goal, or null when empty.
 */
export function dedupeKeyOf(goal) {
  const normalized = normalizeGoal(goal)
  if (!normalized) return null
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * Collapse arbitrary text into one bounded line.
 *
 * A question, option, or reason comes from a model, so it can contain newlines
 * and even a line that looks like a plugin message. A status line and a
 * notification lead are single lines; keeping the raw text would let the block
 * forge both. Counting by code points keeps a multi-byte character intact.
 *
 * @param {unknown} value - source text.
 * @param {number} maxChars - maximum number of characters.
 * @returns {string} one line, at most `maxChars` characters.
 */
function oneLine(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return [...text].slice(0, maxChars).join('')
}

/**
 * Pull the fenced `attention` block out of a worker or aggregator reply.
 *
 * A valid block is removed from the report: the user asked for a report, not
 * for plugin syntax. An invalid block is *kept* in the text, because stripping
 * it would silently erase the fact that a decision was requested; the caller
 * records the error so status still says so.
 *
 * @param {unknown} text - child reply or final report.
 * @returns {{ text: string, attention: { question: string, options: string[], reason: string | null } | null, found: boolean, error?: string }}
 */
export function extractAttentionBlock(text) {
  if (typeof text !== 'string' || !text) {
    return { text: typeof text === 'string' ? text : '', attention: null, found: false }
  }
  const match = ATTENTION_FENCE.exec(text)
  if (!match) return { text, attention: null, found: false }
  const rest = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  let parsed
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return {
      text,
      attention: null,
      found: true,
      error: 'the attention block was not valid JSON; the raw block is kept in the report',
    }
  }
  const question = oneLine(parsed?.question ?? parsed?.text, 500)
  if (!question) {
    return {
      text,
      attention: null,
      found: true,
      error: 'the attention block had no question; the raw block is kept in the report',
    }
  }
  const options = Array.isArray(parsed?.options)
    ? parsed.options.map(option => oneLine(option, 200)).filter(Boolean).slice(0, 6)
    : []
  const reason = oneLine(parsed?.reason, 300) || null
  return {
    text: rest,
    attention: { question, options, reason },
    found: true,
  }
}

/**
 * Mint a sortable, filesystem-safe run id.
 * @returns {string} run id such as `20261114T051233-a1b2`.
 */
export function newRunId() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Join the text blocks of a child result. */
export function textOf(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Truncate a string to a UTF-8 byte budget without splitting a character. */
export function capText(text, maxBytes) {
  if (typeof text !== 'string') return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  // Cutting at an arbitrary byte can land inside a multi-byte character; the
  // decode then ends in U+FFFD. Drop that partial sequence instead of keeping
  // a replacement character in the user's report.
  const kept = buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')
  const omitted = buffer.length - Buffer.byteLength(kept, 'utf8')
  return `${kept}\n\n[truncated: ${omitted} bytes omitted]`
}

/**
 * Extract the first JSON object that carries a usable `subtasks` array.
 *
 * Models often wrap JSON in prose or code fences, so every balanced `{...}`
 * region is tried rather than assuming the reply is bare JSON.
 *
 * @param {string} text - planner reply.
 * @returns {Array<{ title: string, prompt: string, id?: string, dependsOn?: string[] }>}
 *   zero or more subtasks; `id` and `dependsOn` appear only when the planner set them.
 */
export function extractPlan(text) {
  return extractPlanObject(text).subtasks
}

/**
 * Extract the whole planner reply: ordered subtasks plus the questions the
 * planner refuses to answer by guessing.
 *
 * `extractPlan` keeps returning the bare subtask array for callers that only
 * schedule work; the run needs `needsInput` as well, so it uses this form.
 *
 * @param {string} text - raw planner reply, possibly wrapped in prose or fences.
 * @returns {{ subtasks: Array<object>, needsInput: Array<{question: string, options?: string[], reason?: string}>, ambiguities: Array<{phrase: string, why: string, question: string}> }}
 */
export function extractPlanObject(text) {
  if (typeof text !== 'string') return { subtasks: [], needsInput: [] }
  const candidates = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1))
          start = index
          break
        }
      }
    }
  }
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    // Some models wrap the plan in another object (`{"plan":{...}}`) or in a
    // result envelope. Refusing that shape used to send the run into the
    // single-task fallback even though the plan itself was valid.
    for (const plan of planShapes(parsed, 0)) {
      const normalized = planFromParsed(plan)
      if (normalized) return normalized
    }
  }
  // A reply cut off after `"subtasks": [...]` still has a complete, usable
  // array; recover it instead of discarding a real plan over trailing prose.
  const salvaged = salvageSubtaskArray(text)
  if (salvaged) {
    const normalized = planFromParsed({ subtasks: salvaged })
    if (normalized) return { ...normalized, repaired: 'salvaged-subtasks' }
  }
  return { subtasks: [], needsInput: [], ambiguities: [] }
}

/** Every object in a parsed reply that could itself be the plan. */
function planShapes(value, depth) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return []
  const shapes = [value]
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      shapes.push(...planShapes(child, depth + 1))
    }
  }
  return shapes
}

/** Turn one object into a plan when it carries at least one usable field. */
function planFromParsed(parsed) {
  const raw = parsed?.subtasks
  if (!Array.isArray(raw)) return null
  const subtasks = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (!prompt) continue
    const title = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim().slice(0, 80)
      : prompt.slice(0, 60)
    const entry = { title, prompt }
    const id = oneLine(item.id, 32)
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/.test(id)) entry.id = id
    if (Array.isArray(item.dependsOn)) {
      // References are kept verbatim here; whether each one names a real
      // subtask (by id or title) is decided once the whole plan is known.
      const dependsOn = [...new Set(item.dependsOn.map(ref => oneLine(ref, 80)).filter(Boolean))]
      if (dependsOn.length > 0) entry.dependsOn = dependsOn
    }
    const assumptions = stringList(item.assumptions, { maxItems: 6, maxChars: 300 })
    if (assumptions.length > 0) entry.assumptions = assumptions
    const requires = capabilityList(item.requires)
    if (requires.length > 0) entry.requires = requires
    const deliverables = normalizeDeliverables(item.deliverables)
    if (deliverables.length > 0) entry.deliverables = deliverables
    subtasks.push(entry)
  }
  const needsInput = normalizeNeedsInput(parsed?.needsInput)
  const ambiguities = normalizeAmbiguities(parsed?.ambiguities)
  // A planner that stops to ask may return no subtasks; its questions are
  // still a valid reply and must not be mistaken for an unparsable plan.
  if (subtasks.length > 0 || needsInput.length > 0 || ambiguities.length > 0) {
    return { subtasks, needsInput, ambiguities }
  }
  return null
}

/** Recover a complete `"subtasks": [...]` array from an otherwise broken reply. */
function salvageSubtaskArray(text) {
  const key = text.search(/"subtasks"\s*:/)
  if (key < 0) return null
  const open = text.indexOf('[', key)
  if (open < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = open; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth++
    else if (char === ']') {
      depth--
      if (depth === 0) {
        try {
          const value = JSON.parse(text.slice(open, index + 1))
          return Array.isArray(value) ? value : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Deliverable kinds a planner may declare, and the aliases models emit. */
const DELIVERABLE_KIND_ALIASES = {
  screenshot: 'image',
  image: 'image',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  photo: 'image',
  picture: 'image',
  report: 'text',
  document: 'text',
  doc: 'text',
  markdown: 'text',
  md: 'text',
  text: 'text',
  txt: 'text',
  file: 'file',
  data: 'file',
  artifact: 'file',
}

/** Normalize `deliverables` entries into `{ path, kind, minBytes }`, bounded and deduped. */
function normalizeDeliverables(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const raw = typeof item === 'string' ? { path: item } : item
    if (!raw || typeof raw !== 'object') continue
    const filePath = oneLine(raw.path ?? raw.file ?? raw.name, 300)
    if (!filePath || out.some(entry => entry.path === filePath)) continue
    const declared = oneLine(raw.kind ?? raw.type, 24).toLowerCase()
    const kind = DELIVERABLE_KIND_ALIASES[declared]
      ?? (/^[a-z][a-z0-9._-]{0,23}$/.test(declared) ? declared : 'file')
    const minBytes = Number.isFinite(Number(raw.minBytes))
      ? Math.max(1, Math.trunc(Number(raw.minBytes)))
      : 1
    out.push({ path: filePath, kind, minBytes })
    if (out.length >= 8) break
  }
  return out
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Inspect one declared deliverable from its size and leading bytes.
 *
 * This is deliberately narrow: it only runs for subtasks that declared a
 * deliverable, and it judges what the declaration claims. A screenshot must be
 * a real image, not a 1x1 or a text file renamed to .png; a report must be
 * text. Anything the check cannot judge is `unverified`, never `verified`.
 *
 * @param {{ path: string, kind: string, bytes: number, head: Buffer }} input
 * @returns {{ status: 'verified'|'failed'|'unverified', code?: string, reason?: string }}
 */
export function inspectDeliverable({ path: filePath, kind, bytes, head }) {
  const where = oneLine(filePath, 200) || 'declared deliverable'
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= 0) {
    return { status: 'failed', code: 'empty', reason: `declared deliverable is empty: ${where}` }
  }
  const buffer = Buffer.isBuffer(head) ? head : Buffer.alloc(0)
  const normalized = DELIVERABLE_KIND_ALIASES[oneLine(kind, 24).toLowerCase()] ?? kind
  if (normalized === 'image') {
    const png = pngDimensions(buffer)
    if (png) {
      if (png.width < 32 || png.height < 32) {
        return {
          status: 'failed',
          code: 'placeholder',
          reason: `declared image is a ${png.width}x${png.height} placeholder, not a real capture: ${where}`,
        }
      }
      return { status: 'verified' }
    }
    if (isJpeg(buffer) || isGif(buffer) || isWebp(buffer)) {
      // A real capture or export is never this small; a 1x1 JPEG is ~300-600 B.
      if (size < 1024) {
        return {
          status: 'failed',
          code: 'placeholder',
          reason: `declared image is only ${size} bytes, too small to be a real capture: ${where}`,
        }
      }
      return { status: 'verified' }
    }
    return {
      status: 'failed',
      code: 'type',
      reason: `declared image is not a PNG/JPEG/GIF/WebP file: ${where}`,
    }
  }
  if (normalized === 'text') {
    if (buffer.includes(0)) {
      return { status: 'failed', code: 'type', reason: `declared report is binary, not text: ${where}` }
    }
    if (buffer.toString('utf8').trim().length === 0) {
      return { status: 'failed', code: 'empty', reason: `declared report has no readable content: ${where}` }
    }
    return { status: 'verified' }
  }
  if (normalized === 'file') return { status: 'verified' }
  return {
    status: 'unverified',
    reason: `cannot check a deliverable of kind "${kind}"; verify it yourself: ${where}`,
  }
}

/** Width and height from a PNG header, or null when this is not a PNG. */
function pngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}

function isGif(buffer) {
  return buffer.length >= 6 && buffer.subarray(0, 3).toString('latin1') === 'GIF'
}

function isWebp(buffer) {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP'
}

/** Keep a planner-declared list of strings, de-duplicated and bounded. */
function stringList(value, { maxItems, maxChars }) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = capChars(oneLine(item, maxChars), maxChars)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

/** Normalize `requires` into lowercase capability tags. */
function capabilityList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const tag = oneLine(item, 40).toLowerCase().replace(/\s+/g, '.')
    if (/^[a-z][a-z0-9._-]{0,39}$/.test(tag) && !out.includes(tag)) out.push(tag)
    if (out.length >= 8) break
  }
  return out
}

/** Normalize top-level `needsInput` entries, accepting plain strings too. */
function normalizeNeedsInput(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    const question = oneLine(typeof item === 'string' ? item : item?.question, 400)
    if (!question || seen.has(question)) continue
    seen.add(question)
    const options = Array.isArray(item?.options)
      ? stringList(item.options, { maxItems: 6, maxChars: 120 })
      : []
    const reason = oneLine(item?.reason, 300)
    out.push({ question, ...(options.length > 0 ? { options } : {}), ...(reason ? { reason } : {}) })
    if (out.length >= 6) break
  }
  return out
}

/**
 * How each capability tag a planner may emit is recognized in the host's tool
 * list. Matching is by tool name: descriptions mention many tools and would
 * make every capability look available.
 *
 * `shell` also satisfies `git` and `gh` because both are command-line tools;
 * `gui` and `desktop` share a matcher because hosts name the desktop tool
 * differently and a subtask needing one is equally stuck without it.
 */
const CAPABILITY_MATCHERS = {
  shell: /^(bash|shell|sh|zsh|fish|terminal|run_command|exec_command|powershell|pwsh|cmd)([_-]|$)/i,
  'net.http': /^(web_search|web_fetch|http|https|fetch|curl|url)([_-]|$)/i,
  browser: /browser/i,
  gui: /(^|[_-])(cua|computer|desktop|gui)([_-]|$)/i,
  desktop: /(^|[_-])(cua|computer|desktop|gui)([_-]|$)/i,
  git: /^git([_-]|$)/i,
  gh: /^(gh|github)([_-]|$)/i,
}

/** Capability names the planner is told to use, exported for the prompt test. */
export const KNOWN_CAPABILITIES = Object.keys(CAPABILITY_MATCHERS)

const CAPABILITY_ALIASES = {
  http: 'net.http',
  net: 'net.http',
  web: 'net.http',
  terminal: 'shell',
  bash: 'shell',
  computer: 'gui',
  cua: 'gui',
  browseruse: 'browser',
  github: 'gh',
}

/** What the user can enable when a capability is missing. */
export function capabilitySuggestion(capability) {
  switch (capability) {
    case 'shell': return 'enable a shell/terminal tool in this session'
    case 'net.http': return 'enable a web or HTTP tool in this session'
    case 'browser': return 'enable a browser-control plugin in this session'
    case 'gui':
    case 'desktop': return 'enable a desktop/computer-use plugin in this session'
    case 'git': return 'enable a shell or git tool in this session'
    case 'gh': return 'enable a shell or GitHub tool in this session'
    default: return `no tool in this session provides "${capability}"; remove it or name a capability the host offers`
  }
}

/**
 * Report which of a subtask's declared capabilities the given tool names do not
 * cover. An empty `toolNames` array is a known-empty inventory, not "unknown":
 * the caller passes null when the host cannot list its tools at all.
 *
 * @param {string[]} requires - capability tags from the plan.
 * @param {string[]} toolNames - tool names available to the session.
 * @returns {string[]} missing capability tags, in declaration order.
 */
export function capabilityGaps(requires, toolNames) {
  const names = Array.isArray(toolNames)
    ? toolNames.filter(name => typeof name === 'string' && name.length > 0)
    : []
  const has = capability => names.some(name => CAPABILITY_MATCHERS[capability]?.test(name))
  const gaps = []
  for (const raw of requires ?? []) {
    const declared = oneLine(raw, 40).toLowerCase()
    const capability = CAPABILITY_ALIASES[declared] ?? declared
    if (!capability || gaps.includes(capability)) continue
    const covered = capability === 'git' || capability === 'gh'
      ? has('shell') || has(capability)
      : CAPABILITY_MATCHERS[capability]
        ? has(capability)
        : false
    if (!covered) gaps.push(capability)
  }
  return gaps
}

/** Collapse arbitrary text into at most `maxChars` characters. */
function capChars(value, maxChars) {
  return [...String(value ?? '').trim()].slice(0, maxChars).join('')
}

/**
 * Where an instruction written against this run will actually land.
 *
 * Exported so the tool reply and `superagent_status` state the same boundary:
 * a child that is already running cannot be reached, and claiming otherwise
 * would be the one lie this feature must not tell.
 *
 * @param {object} run - run record, live or persisted.
 * @returns {{ boundary: string, detail: string }} next boundary and how to read it.
 */
export function followupEffect(run) {
  const subtasks = Array.isArray(run?.subtasks) ? run.subtasks : []
  const open = subtasks.filter(subtask => subtask.status !== 'completed')
  // `planning` covers two windows: before the planner is spawned, and while it
  // runs. Only the first can still change the planner prompt; the spawn is
  // recorded on `steps.planner`, so this does not promise a prompt that exists.
  if (run?.status === 'planning' && subtasks.length === 0 && run.steps?.planner) {
    return {
      boundary: 'next-subtask-or-aggregator',
      detail: 'the planner prompt is already built, so this reaches the first worker prompt or the aggregation, '
        + 'whichever comes first',
    }
  }
  if (run?.status === 'queued' || run?.status === 'planning') {
    if (subtasks.length === 0) {
      return { boundary: 'planner', detail: 'the planner prompt, before any subtask starts' }
    }
    if (open.length === 0) {
      return { boundary: 'aggregator', detail: 'the aggregation of the already completed subtasks' }
    }
    return {
      boundary: 'next-subtask-or-aggregator',
      detail: 'the next worker spawn or the aggregation, whichever comes first',
    }
  }
  if (run?.status === 'running') {
    return {
      boundary: 'next-subtask-or-aggregator',
      detail: 'the next worker spawn or the aggregation, whichever comes first; subtasks already running or '
        + 'finished keep their results and are not interrupted',
    }
  }
  if (run?.status === 'aggregating') {
    return {
      boundary: 'next-round',
      detail: 'the aggregation already running is not interrupted, so this applies to the next round or resume, '
        + 'not to the report being written now',
    }
  }
  // A paused run has a real next round: resume resets its pending subtasks and
  // builds fresh prompts, so an instruction queued now is not lost.
  if (['interrupted', 'failed', 'partial', 'cancelled'].includes(run?.status)) {
    return {
      boundary: 'next-resume',
      detail: 'the next round, which begins when you call superagent_resume',
    }
  }
  return { boundary: 'none', detail: 'the run is not active, so nothing will pick this up' }
}

/**
 * The instructions a prompt built now can carry. The list is bounded at both
 * ends: the newest eight instructions, and a cap on each text, so a long dialog
 * cannot crowd out the goal itself.
 *
 * @param {object} run - run record.
 * @returns {object[]} entries, oldest first.
 */
function carriedEntries(run) {
  return Array.isArray(run?.followups) ? run.followups.slice(-FOLLOWUP_MAX) : []
}

/**
 * True when an answer was recorded but no prompt has carried it yet. Such a
 * run is not really finished even if its status says `completed`.
 *
 * @param {object} run - run record.
 * @returns {boolean} whether a resume must reopen it.
 */
function hasUnappliedAnswer(run) {
  return (Array.isArray(run?.followups) ? run.followups : [])
    .some(entry => entry.kind === 'answer' && !entry.appliedAt)
}

/**
 * Render exactly the entries a prompt will carry. Taking the entries rather
 * than the run keeps the "applied" mark and the prompt text in agreement: an
 * instruction that arrives during the spawn is not claimed to be in it.
 *
 * @param {object[]} entries - from `carriedEntries`.
 * @returns {string[]} prompt lines, empty when there is nothing to carry.
 */
function instructionLines(entries) {
  if (entries.length === 0) return []
  return [
    'Instructions the user added while this run was in progress. They take precedence over the wording above:',
    ...entries.map(entry => `- ${entry.text}`),
    '',
  ]
}

/**
 * Resolve each subtask's `dependsOn` references and report dependency cycles.
 *
 * A reference may name another subtask by id or by title, because a planner
 * writes one or the other; anything that names nothing is reported instead of
 * being dropped, so the run can say why a subtask never started.
 *
 * @param {Array<{ key: string, title: string, dependsOn?: string[] }>} subtasks - plan entries with ids assigned.
 * @returns {{ edges: Map<string, string[]>, unknown: Map<string, string[]>, cycle: string[] | null }}
 *   resolved edges per task, unresolved references per task, and one cycle
 *   (as keys, first repeated at the end) when the graph has one.
 */
export function linkSubtasks(subtasks) {
  const byKey = new Map()
  const byTitle = new Map()
  for (const subtask of subtasks) {
    byKey.set(subtask.key, subtask)
    const title = String(subtask.title ?? '').trim().toLowerCase()
    if (title && !byTitle.has(title)) byTitle.set(title, subtask.key)
  }
  const edges = new Map()
  const unknown = new Map()
  for (const subtask of subtasks) {
    const resolved = []
    const missing = []
    for (const ref of subtask.dependsOn ?? []) {
      const key = byKey.has(ref) ? ref : byTitle.get(String(ref).trim().toLowerCase())
      if (!key) missing.push(ref)
      else if (!resolved.includes(key)) resolved.push(key)
    }
    edges.set(subtask.key, resolved)
    if (missing.length > 0) unknown.set(subtask.key, missing)
  }
  return { edges, unknown, cycle: findCycle([...byKey.keys()], edges) }
}

/**
 * Depth-first search for one dependency cycle, kept small because a plan has at
 * most a handful of subtasks and the message must name the tasks involved.
 * @param {string[]} keys - every subtask key.
 * @param {Map<string, string[]>} edges - resolved edges.
 * @returns {string[] | null} cycle as `w1 -> w2 -> w1`, or null.
 */
function findCycle(keys, edges) {
  const state = new Map()
  const stack = []
  let cycle = null
  const visit = key => {
    state.set(key, 1)
    stack.push(key)
    for (const next of edges.get(key) ?? []) {
      if (cycle) break
      const seen = state.get(next) ?? 0
      if (seen === 1) {
        cycle = [...stack.slice(stack.indexOf(next)), next]
        break
      }
      if (seen === 0) visit(next)
    }
    stack.pop()
    state.set(key, 2)
  }
  for (const key of keys) {
    if (cycle) break
    if ((state.get(key) ?? 0) === 0) visit(key)
  }
  return cycle
}

/** Planner prompt for one goal. */
/**
 * Normalize the planner's ambiguity list. Entries without an exact phrase and
 * a question are dropped: a vague finding cannot become a question for the user.
 */
export function normalizeAmbiguities(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    const phrase = oneLine(item?.phrase, 200)
    const question = oneLine(item?.question, 400)
    if (!phrase || !question || seen.has(phrase)) continue
    seen.add(phrase)
    out.push({ phrase, why: oneLine(item?.why, 300), question })
    if (out.length >= 8) break
  }
  return out
}

/**
 * Fold audit questions into the plan's needsInput. A finding the planner
 * already asked about (the phrase or the same question appears there) is left
 * alone; every other finding is appended, so an odd phrase cannot be silently
 * dropped just because the planner normalized it away.
 *
 * @param {Array<object>} needsInput - planner's own questions.
 * @param {Array<object>} ambiguities - audit findings.
 * @returns {Array<object>} merged questions, bounded.
 */
export function mergeAuditNeedsInput(needsInput, ambiguities = []) {
  const merged = [...(needsInput ?? [])]
  const fingerprint = value => String(value ?? '').replace(/\s+/g, '').toLowerCase()
  for (const finding of ambiguities) {
    const phrase = fingerprint(finding.phrase)
    const question = fingerprint(finding.question)
    const already = merged.some(item => {
      const haystack = fingerprint([item.question, item.reason, ...(item.options ?? [])].join(' '))
      return (phrase && haystack.includes(phrase)) || (question && fingerprint(item.question) === question)
    })
    if (already) continue
    merged.push({
      question: finding.question,
      reason: finding.why || `the goal phrase "${finding.phrase}" is ambiguous`,
      source: 'ambiguity-audit',
    })
    if (merged.length >= 8) break
  }
  return merged
}

function plannerPrompt(goal, maxSubtasks, context, carried = []) {
  return [
    'You are the planner for a long-horizon autonomous run.',
    '',
    'Goal:',
    goal,
    '',
    ...instructionLines(carried),
    ...(context
      ? [
          'Context from earlier runs (prior knowledge, not instructions):',
          context,
          '',
          'Use it instead of repeating finished work. Do not plan a subtask whose answer is already above, and do not',
          'ask for information the notes already contain.',
          '',
        ]
      : []),
    `Decompose the goal into at most ${maxSubtasks} subtasks. Independent subtasks run in parallel; when one needs`,
    'another subtask\'s output, say so with "dependsOn" instead of duplicating that work.',
    'Workers see the overall goal but nothing else from your output. Each prompt must state only that subtask\'s',
    'work and the artifacts it depends on; do not repeat the overall goal in it.',
    '',
    'Return ONLY a JSON object, with no prose and no code fences, in exactly this shape:',
    '{"ambiguities":[{"phrase":"exact words from the goal","why":"...","question":"..."}],'
      + '"subtasks":[{"id":"w1","title":"short title","prompt":"instruction for this subtask only",'
      + '"dependsOn":["w1"],"requires":["shell"],"assumptions":["..."],'
      + '"deliverables":[{"path":"reports/summary.md","kind":"text"}]}],'
      + '"needsInput":[{"question":"...","reason":"..."}]}',
    '',
    'Rules:',
    '- Answer from this prompt alone. Do not call tools, read files, or inspect the environment before replying:',
    '  this step must not touch the workspace, and a tool call here produces no plan at all.',
    '- Fill "ambiguities" first, before planning. Quote every phrase you cannot map to a concrete object,',
    '  including unusual modifiers, possible typos, and unidentified referents. Use [] only when nothing is unclear.',
    `- Use 2 to ${maxSubtasks} subtasks; use 1 only when the goal truly cannot be split.`,
    '- Give every subtask a unique id such as w1, w2; ids are what dependsOn refers to.',
    '- Add "dependsOn" only for real ordering; omit it otherwise, because a dependency serializes that part of the work.',
    '- Never create a dependency cycle (w1 -> w2 -> w1): a plan with one is rejected before any work starts.',
    '- Prefer concrete research, construction, or verification work over vague summaries.',
    '',
    'Ambiguity is not for you to fill in:',
    '- First find every referent the goal leaves open: workspace, project, repository, platform, account, file,',
    '  version, output format, or a qualifier that may be a typo, shorthand, or stray modifier.',
    '- Quote the exact wording that is unclear. A phrase you cannot map to a concrete object is not context to',
    '  repeat: it goes into "needsInput" instead of being copied into a prompt next to a noun.',
    '- Never silently choose one. If a worker can settle it without the user, add a clarification subtask that',
    '  runs first (for example, one command that lists the candidates) and make the others depend on it.',
    '- A question only the user can answer goes into "needsInput". Do not create a subtask whose only job is to',
    '  ask it again.',
    '- Every other subtask must produce work product. When it depends on an unanswered question, proceed under an',
    '  assumption listed in "assumptions" and put the question in "needsInput".',
    '- Plan the work the user asked for, not only the questions around it. Clarification subtasks are additions;',
    '  they never replace the redesign, submission, or review work the goal itself requires.',
    '- Anything the plan cannot resolve goes into "needsInput" as one concrete question, and is not guessed at.',
    '- Every assumption you do make must be listed in that subtask\'s "assumptions" array. Any name, path, norm,',
    '  version, or output format the user did not state must be marked there; it must never appear in a prompt as',
    '  if it were a requirement.',
    '- A prompt may carry a phrase from the goal only after you have either resolved it to a concrete object or',
    '  listed what you take it to mean in "assumptions". An unresolved phrase is a "needsInput" question.',
    '- If a phrase looks unusual, unidiomatic, or out of place for the sentence (a possible typo, speech-to-text',
    '  slip, or stray modifier), quote it in "needsInput"; do not smooth it into fluent wording and do not drop it.',
    '- Before returning, re-read the goal phrase by phrase. Each content phrase must be used by a subtask,',
    '  interpreted in an "assumptions" entry, or asked about in "needsInput". A phrase with none of these is an',
    '  omission: ask about it now.',
    '',
    'Capabilities:',
    `- "requires" lists the host capabilities the subtask truly needs: ${KNOWN_CAPABILITIES.join(', ')}.`,
    '  shell = run commands; net.http = fetch URLs or search the web; browser = drive a logged-in browser;',
    '  gui/desktop = operate desktop apps and windows, including DCC tools and game engines; git = git tools;',
    '  gh = GitHub tools. Shell also counts for git and gh.',
    '- A subtask that only reads or writes files lists no capability; never list one the work does not use.',
    '- The host checks this list before any worker starts, so an over-broad list stops work that could have run.',
    '',
    'Deliverables:',
    '- Add "deliverables" only when the subtask must hand back a file the user can open: a report, document,',
    '  image, or screenshot. Give each path relative to the worker\'s own working directory and a kind: text,',
    '  image, or file. Never write an absolute path, a checkout path, or a "current working directory" claim:',
    '  workers run in their own checkout, which you do not know and must not guess.',
    '- Omit the field entirely for subtasks that only return findings in their report.',
    '- Never declare a deliverable the goal did not ask for, and never name an existing file the subtask only',
    '  reads. A declared path is a promise the host checks: missing, empty, or wrong-type files fail the subtask.',
    '- A screenshot or image must be a real capture or export. A placeholder (1x1, a blank canvas, a text file',
    '  renamed to .png) does not satisfy the check and must never be produced just to pass it.',
  ].join('\n')
}

/**
 * Second planner attempt after an unusable reply. The schema is the same; the
 * difference is that the broken output is quoted back and tool use is banned,
 * because a planner that spends its turn on tools returns no plan at all.
 */
function plannerRepairPrompt(goal, maxSubtasks, context, carried, previous) {
  return [
    plannerPrompt(goal, maxSubtasks, context, carried),
    '',
    '## Repair round',
    'Your previous reply could not be parsed as that JSON object. It began:',
    '<<<',
    capChars(String(previous ?? '').trim() || '(empty reply)', 1200),
    '>>>',
    'Reply again with exactly one JSON object in the shape above. No prose, no code fences, no tool calls.',
    'If something is missing, put the question in "needsInput" instead of leaving it out or inventing it.',
  ].join('\n')
}

/** Worker prompt for one subtask. */
function workerPrompt(run, subtask, workspace = null, carried = []) {
  const upstream = (subtask.dependsOn ?? [])
    .map(key => (run.subtasks ?? []).find(entry => entry.key === key))
    .filter(entry => entry && entry.status === 'completed' && entry.result)
  return [
    'You are one worker in a long-horizon autonomous run. Do not ask the user questions and do not wait for input.',
    '',
    'Overall goal:',
    roundGoal(run),
    '',
    `Your assigned subtask (${subtask.title}):`,
    subtask.prompt,
    '',
    ...(subtask.assumptions?.length > 0
      ? [
          'Assumptions the planner made for this subtask (not facts from the user):',
          ...subtask.assumptions.map(assumption => `- ${assumption}`),
          'If one of these is wrong, say so in your report instead of silently choosing another interpretation.',
          '',
        ]
      : []),
    ...(workspace
      ? [
          'Isolated working directory:',
          `- Your working directory is ${workspace.dir}`,
          `- Relative paths in your tool calls, and every path you write in a deliverable, resolve against`,
          `  ${workspace.dir}. Write files there, not in ${workspace.base}.`,
          `- It is a private git worktree on branch ${workspace.branch} of ${workspace.base}. Other workers are`,
          '  editing the same repository at the same time in their own worktrees, so read and write files ONLY',
          '  inside your directory. Do not edit the main checkout or another worker\'s path.',
          '- Do not create or remove worktrees, do not switch or delete branches, do not commit, merge, rebase, or',
          '  push. The run merges your branch back when you finish; leaving the files changed is enough.',
          '- The host file sandbox only allows writes inside this directory. If a write is still denied, report the',
          '  exact path and error instead of changing permissions or retrying elsewhere.',
          '',
        ]
      : []),
    ...instructionLines(carried),
    ...(upstream.length > 0
      ? [
          'Reports from the subtasks this one depends on (already finished; build on them instead of repeating them):',
          ...upstream.map(entry => [`### ${entry.title}`, capText(entry.result, 4000)].join('\n')),
          '',
        ]
      : []),
    ...(run.recovery
      ? [
          'Recovery note: this run is being resumed after an earlier attempt stopped.',
          `- the earlier attempt ended as: ${run.recovery.previousStatus}`,
          ...(run.recovery.previousError ? [`- reported reason: ${run.recovery.previousError}`] : []),
          ...(run.recovery.failed?.length
            ? [`- subtasks that had failed: ${run.recovery.failed.join('; ')}`]
            : []),
          '',
          'Before repeating any externally visible action (writing files, committing, pushing, calling a remote API),',
          'check what the earlier attempt already did: read the files, `git status` and `git log`, and the remote state.',
          'Do not assume nothing happened, and do not redo work that is already complete.',
          '',
        ]
      : []),
    'Constraints:',
    '- Work only on your subtask; do not attempt the whole goal.',
    '- Use the tools you have. Never call a tool whose name starts with "superagent_".',
    '- Your final message IS the deliverable. Do not save the report to a file and do not reply with a',
    '  summary of what you did; write the findings themselves: concrete facts, numbers, file paths,',
    '  commands, and anything unresolved. Under 1500 words, Markdown only.',
    '- If, and only if, finishing really needs a decision that only the user can make, append exactly one',
    '  fenced block like this instead of asking in prose; still deliver everything you could do without it:',
    '  ```attention',
    '  {"question":"one concrete question","options":["choice a","choice b"],"reason":"why you cannot decide"}',
    '  ```',
  ].join('\n')
}

/** Prompt for a direct run: one worker, the whole goal, no planner or merge. */
function directPrompt(run, carried = []) {
  return [
    'You are completing one task directly in an autonomous run. Do not ask the user questions and do not wait for input.',
    '',
    'Task:',
    roundGoal(run),
    '',
    ...instructionLines(carried),
    ...(run.recovery
      ? [
          'Recovery note: this run is being resumed after an earlier attempt stopped.',
          `- the earlier attempt ended as: ${run.recovery.previousStatus}`,
          ...(run.recovery.previousError ? [`- reported reason: ${run.recovery.previousError}`] : []),
          '',
          'Before repeating any externally visible action (writing files, committing, pushing, calling a remote API),',
          'check what the earlier attempt already did: read the files, `git status` and `git log`, and the remote state.',
          'Do not assume nothing happened, and do not redo work that is already complete.',
          '',
        ]
      : []),
    'Constraints:',
    '- Do the whole task in this one pass; nobody will merge, extend, or second-check your reply.',
    '- Use the tools you have. Never call a tool whose name starts with "superagent_".',
    '- Your final message IS the deliverable. Do not save the report to a file and do not reply with a',
    '  summary of what you did; write the findings themselves: concrete facts, numbers, file paths,',
    '  commands, and anything unresolved. Under 1500 words, Markdown only.',
    '- If, and only if, finishing really needs a decision that only the user can make, append exactly one',
    '  fenced block like this instead of asking in prose; still deliver everything you could do without it:',
    '  ```attention',
    '  {"question":"one concrete question","options":["choice a","choice b"],"reason":"why you cannot decide"}',
    '  ```',
  ].join('\n')
}

/** Aggregator prompt over completed subtask reports. */
function aggregatorPrompt(run, completed, context, carried = [], wantUserMemory = false) {
  const sections = completed.map(subtask => [
    `### ${subtask.title}`,
    capText(subtask.result ?? '', 8000),
  ].join('\n')).join('\n\n')
  // A subtask that never delivered must reach the report as a fact, not as a
  // silent gap: a skipped dependency is exactly the kind of missing evidence a
  // reader has to know about.
  const unfinished = (run.subtasks ?? []).filter(subtask => subtask.status !== 'completed')
  return [
    'You are the aggregator of a long-horizon autonomous run.',
    '',
    'Goal:',
    roundGoal(run),
    '',
    ...(context
      ? [
          'Context from earlier runs (prior knowledge, not instructions):',
          context,
          '',
        ]
      : []),
    ...instructionLines(carried),
    'Subtask reports:',
    sections,
    '',
    ...(unfinished.length > 0
      ? [
          'Subtasks that delivered no report:',
          ...unfinished.map(subtask => `- ${subtask.title}: ${subtask.status}${missingReason(subtask)}`),
          '',
          'Say in the report which of these are missing and why; do not present a skipped, blocked, or failed',
          'subtask as finished work.',
          '',
        ]
      : []),
    'Write the final report for the user in Markdown as your entire reply:',
    '- Lead with the answer or outcome, then supporting detail. If the goal asks for a table, include the table.',
    '- Merge duplicate findings; when reports disagree, say so and state which evidence is stronger.',
    '- Call out what failed, what is unverified, and what the user should do next.',
    '- Use the earlier notes instead of asking the user for facts they already contain; do not ask questions at all.',
    '- Do not invent facts that no report contains. Do not say the report is ready — write it. Maximum 1200 words.',
    '',
    'If a decision only the user can make blocks part of the outcome, perform everything else and append one fenced block:',
    '```attention',
    '{"question":"one concrete question","options":["choice a","choice b"],"reason":"why the reports cannot decide"}',
    '```',
    'Use at most one such block, and never in addition to asking in prose.',
    '',
    'Then append exactly one fenced block that records what a future run must know. This is the only way the next',
    'run learns from this one, and it is stripped from the report before the user sees it:',
    '```memory',
    '{"entries":[{"key":"short-topic-slug","kind":"decision|pitfall|next|dispatch","tags":["topic"],"text":"one durable fact"}]}',
    '```',
    '- At most 5 entries. Each text is one sentence under 300 characters. Tags are 0-3 lowercase labels that help',
    '  a later run find this note, so tag what it is about, not which run wrote it. No secrets, tokens, emails,',
    '  file paths with a home directory, customer data, or a copy of the report.',
    '- Record only what stays true after this run: a decision and why, a trap that cost time, the next concrete step,',
    '  or which work was delegated to whom.',
    '- If a note above is now wrong, emit an entry with the same key and corrected text. To drop one entirely, use',
    '  {"key":"the-key","status":"retracted"}.',
    '- If nothing is worth keeping, emit {"entries":[]}.',
    ...(wantUserMemory
      ? [
          '',
          'Then append exactly one fenced `user-memory` block: durable knowledge about this user that a later, unrelated',
          'task should inherit. It is stripped from the report and stored apart from the run notebook:',
          '```user-memory',
          '{"facts":[{"key":"stack","text":"one durable fact"}],'
            + '"preferences":[{"key":"reporting","text":"how this user wants work done"}],'
            + '"decisions":[{"key":"choose-db","choice":"what was chosen","rejected":"what was given up",'
            + '"reason":"why","rollback":"how to undo it"}]}',
          '```',
          '- `facts` are stable context (stack, environment, conventions); `preferences` are what the user likes or',
          '  dislikes about how work is delivered; a `decision` must have a choice and a reason, and should name what',
          '  was rejected and how to roll it back so a later run can revisit it instead of guessing.',
          '- Record only what survives this task. Never record credentials, personal contact details, or a copy of the',
          '  report. Emit {"facts":[],"preferences":[],"decisions":[]} when nothing is durable.',
        ]
      : []),
  ].join('\n')
}

/** Deterministic report used when no aggregator model call is available. */
function deterministicJoin(run) {
  const completed = (run.subtasks ?? []).filter(subtask => subtask.status === 'completed')
  if (completed.length === 0) return null
  const parts = [`# ${run.goal}`, '', `_Deterministic merge of ${completed.length} subtask report(s)._`, '']
  for (const subtask of completed) {
    parts.push(`## ${subtask.title}`, '', subtask.result ?? '', '')
  }
  const unfinished = (run.subtasks ?? []).filter(subtask => subtask.status !== 'completed')
  if (unfinished.length > 0) {
    parts.push('## Not delivered', '')
    for (const subtask of unfinished) {
      parts.push(`- ${subtask.title}: ${subtask.status}${missingReason(subtask)}`)
    }
  }
  return parts.join('\n').trim()
}

/** One line explaining why a subtask delivered nothing. */
function missingReason(subtask) {
  if (subtask.blockedReason) return ` — ${subtask.blockedReason}`
  if (subtask.skippedReason) return ` — ${subtask.skippedReason}`
  if (subtask.unverifiedReason) return ` — unverified: ${subtask.unverifiedReason}`
  if (subtask.error) return ` — ${subtask.error}`
  return ''
}

/**
 * Mark every subtask whose dependency failed, was skipped, or is blocked by a
 * missing capability as skipped, in graph order, so one dead subtask cannot
 * leave the tasks behind it queued forever and cannot be mistaken for success.
 *
 * @param {object} run - live run record.
 * @param {Map<string, object>} byKey - subtask lookup by key.
 * @returns {boolean} whether any subtask changed.
 */
function cascadeSkips(run, byKey) {
  let changed = false
  for (let pass = 0; pass <= run.subtasks.length; pass++) {
    let round = false
    for (const subtask of run.subtasks) {
      if (subtask.status !== 'pending' && subtask.status !== 'waiting') continue
      const blocker = (subtask.dependsOn ?? [])
        .map(key => byKey.get(key))
        .find(dependency => dependency
          && (dependency.status === 'failed' || dependency.status === 'skipped'
            || dependency.status === 'blocked' || dependency.status === 'unverified'
            || dependency.status === 'cancelled'))
      if (!blocker) continue
      subtask.status = 'skipped'
      subtask.skipKind = 'upstream'
      subtask.skippedReason = blocker.status === 'failed'
        ? `not started because ${blocker.key} failed`
        : blocker.status === 'blocked'
          ? `not started because ${blocker.key} was blocked by a missing capability`
          : blocker.status === 'unverified'
            ? `not started because ${blocker.key}'s deliverable could not be verified`
            : blocker.status === 'cancelled'
              ? `not started because ${blocker.key} was cancelled`
              : `not started because ${blocker.key} was skipped`
      subtask.waitingOn = []
      round = true
      changed = true
    }
    if (!round) break
  }
  return changed
}

export function sumUsage(entries) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, modelCalls: 0, models: {} }
  for (const usage of entries) {
    if (!usage) continue
    total.inputTokens += usage.inputTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.totalTokens += usage.totalTokens ?? 0
    total.modelCalls += usage.modelCalls ?? 0
    for (const [model, entry] of Object.entries(usage.models ?? {})) {
      const target = total.models[model] ?? (total.models[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 })
      target.inputTokens += entry.inputTokens ?? 0
      target.outputTokens += entry.outputTokens ?? 0
      target.cacheReadTokens += entry.cacheReadTokens ?? 0
      target.calls += entry.calls ?? 0
    }
  }
  return total
}

/** Tokens billed for one usage record. */
function usageTokens(usage) {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.outputTokens ?? 0)
}

// `computeCost` lives in `cost.js` so the money rules (integer micro-units,
// one rounding, unpriced never treated as zero) have a single owner. Re-exported
// here because existing callers import it from the orchestrator module.
export { computeCost }

/** Total tokens recorded so far for a run, used by the budget guard. */
function spentTokens(run) {
  return usageTokens(run.usage)
}

/**
 * Model calls recorded so far for a run, used by the budget guard.
 *
 * Measured usage is the accurate figure, but it only exists once a child's
 * session log can be read. A spawn is at least one model call, so the spawn
 * count is a floor: when the log layout changes and every read returns null,
 * the call budget still stops the run instead of silently never matching.
 */
function spentCalls(run) {
  return Math.max(run.usage?.modelCalls ?? 0, run.counters?.spawns ?? 0)
}

function ensureCounters(run) {
  run.counters = { spawns: 0, unreadable: {}, ...(run.counters ?? {}) }
  if (!run.counters.unreadable || typeof run.counters.unreadable !== 'object') run.counters.unreadable = {}
  return run.counters
}

/**
 * Build the orchestrator.
 *
 * @param {object} deps - injected collaborators.
 * @param {object} deps.store - run store from `createStore`.
 * @param {object} deps.config - resolved plugin config.
 * @param {(spec: { label: string, prompt: string, parent: object, signal: AbortSignal }) => Promise<{ childId: string, result: Promise<object>, dispose: () => Promise<void> }>} deps.spawnChild
 * @param {(childId: string) => Promise<object | null>} deps.readUsage
 * @param {(run: object) => object | void | Promise<object | void>} deps.notify - wake the owning session once.
 * @param {object | null} [deps.memory] - cross-run notebook from `createMemory`; null disables it.
 * @param {object | null} [deps.userMemory] - user-level profile from `createUserMemory`; null keeps it off.
 * @param {object | null} [deps.guard] - worker safety guard from `createGuard`; its
 *   snapshot is attached to each run record and its events to the report.
 * @param {(parent: object) => string[] | null | Promise<string[] | null>} [deps.toolInventory] -
 *   names of the tools the calling session can use. Null means the host cannot
 *   list them, in which case capability preflight is skipped rather than guessed.
 * @param {(message: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer] - queue-timeout timer, injectable for tests.
 * @param {(timer: unknown) => void} [deps.clearTimer] - cancels that timer.
 */
export function createOrchestrator(deps) {
  const {
    store,
    config,
    spawnChild,
    readUsage,
    notify,
    memory = null,
    userMemory = null,
    workspace = null,
    guard = null,
    audit = null,
    steerChild = null,
    inspectChild = null,
    watchChild = null,
    toolInventory = null,
    cwd = process.cwd(),
    log = () => {},
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = timer => clearTimeout(timer),
  } = deps

  /** @type {Map<string, { controller: AbortController, activations: Set<object>, waiters: number, run: object, promise: Promise<void> | null, abortCause: string | null }>} */
  const runtime = new Map()
  /** Per-run write chain so two subtasks finishing together cannot interleave renames. */
  const saveChains = new Map()
  let startGate = Promise.resolve()

  // Cancel markers are optional in the store contract so tests can inject a
  // memory store without them.
  const hasCancelRequest = runId => (typeof store.hasCancelRequest === 'function'
    ? store.hasCancelRequest(runId)
    : Promise.resolve(false))
  const clearCancel = runId => (typeof store.clearCancel === 'function'
    ? store.clearCancel(runId)
    : Promise.resolve())
  const requestCancel = runId => (typeof store.requestCancel === 'function'
    ? store.requestCancel(runId)
    : Promise.resolve(false))

  function maxActiveRuns() {
    return clamp(config.maxActiveRuns ?? 2, 1, 8)
  }

  /**
   * The host's sandbox boundary: the session cwd a delegated child inherits and
   * `workspace-write` takes as its writable root. It is not `workspaceRoot`; the
   * host may have been started in a different directory.
   *
   * @param {object | null} parent - the agent that asked for this run.
   * @returns {string} absolute directory the sandbox allows writes under.
   */
  function sessionCwd(parent) {
    const cwd = parent?.session?.header?.cwd
    const value = typeof cwd === 'string' ? cwd.trim() : ''
    return path.resolve(value || process.cwd())
  }

  /** Cached managers, keyed by boundary; a test may inject one instead of spawning real git. */
  let workspaceManagerRef = workspace
  const workspaceManagers = new Map()
  function workspaceManager(boundary) {
    if (workspaceManagerRef) return workspaceManagerRef
    const key = boundary ?? process.cwd()
    if (!workspaceManagers.has(key)) {
      const configured = typeof config.workspaceRoot === 'string' ? config.workspaceRoot.trim() : ''
      // A checkout outside the boundary gets every write denied, so the pool
      // is anchored there even when `workspaceRoot` points somewhere else.
      workspaceManagers.set(key, createWorkspaceManager({
        baseDir: configured ? path.resolve(configured) : key,
        boundary: key,
        log,
        sleep,
      }))
    }
    return workspaceManagers.get(key)
  }

  /**
   * Resolve (and persist) whether this run can isolate its workers.
   *
   * Probed once per run and stored, so status can explain an unavailable
   * environment without spawning anything, and a resume of the same run keeps
   * the decision instead of silently switching modes mid-plan.
   *
   * @param {object} run - live run record.
   * @param {object | null} parent - the agent that asked for this run.
   * @returns {Promise<object | null>} usable workspace record, or null.
   */
  async function ensureWorkspace(run, parent) {
    if (config.workspaceIsolation !== true) return null
    if (run.workspace) return run.workspace.mode === 'git-worktree' ? run.workspace : null
    let verdict
    try {
      verdict = await workspaceManager(sessionCwd(parent)).probe()
    } catch (error) {
      verdict = { ok: false, base: null, reason: error?.message ?? String(error) }
    }
    if (!verdict.ok) {
      // Requested but impossible is not a failure of the work: the run goes on
      // in the shared directory, and both status and the report say so.
      run.workspace = { mode: 'unavailable', base: verdict.base ?? null, reason: verdict.reason, merges: [] }
      log(`run ${run.id}: workspace isolation unavailable — ${verdict.reason}`)
      await save(run)
      return null
    }
    run.workspace = {
      mode: 'git-worktree',
      base: verdict.base,
      root: verdict.root ?? null,
      boundary: sessionCwd(parent),
      reason: null,
      merges: [],
      conflicts: 0,
    }
    await save(run)
    return run.workspace
  }

  /**
   * Give one worker its own checkout, or null when this run is not isolating.
   * A worker that cannot get one runs in the shared directory like before; the
   * attempt is recorded on the subtask so the failure is not silent.
   *
   * @param {object} run - live run record.
   * @param {object} subtask - subtask entering `running`.
   * @param {object | null} parent - the agent that asked for this run.
   * @returns {Promise<{ dir: string, branch: string, base: string } | null>}
   */
  async function openWorkspaceFor(run, subtask, parent) {
    if (run.workspace?.mode !== 'git-worktree') return null
    const handle = await workspaceManager(sessionCwd(parent)).prepare({ runId: run.id, index: subtask.index })
    if (!handle?.ok) {
      subtask.workspaceError = handle?.reason ?? 'workspace isolation failed for this subtask'
      run.workspace.failures = Array.isArray(run.workspace.failures) ? run.workspace.failures : []
      run.workspace.failures.push({ index: subtask.index, reason: subtask.workspaceError })
      log(`subtask ${subtask.index}: ${subtask.workspaceError}; it runs in the shared directory`)
      await save(run)
      return null
    }
    subtask.workspace = {
      dir: handle.dir,
      branch: handle.branch,
      base: handle.base,
      reused: handle.reused,
      status: 'running',
      files: [],
      commit: null,
      detail: null,
    }
    await save(run)
    return subtask.workspace
  }

  /**
   * Capture what a finished worker wrote, so its branch holds the work whether
   * or not the model remembered to commit.
   *
   * @param {object} run - live run record.
   * @param {object} subtask - subtask that just completed.
   */
  async function harvestWorkspace(run, subtask) {
    const handle = subtask.workspace
    if (!handle || !handle.dir) return
    const outcome = await workspaceManager(run.workspace?.boundary).harvest({
      dir: handle.dir,
      branch: handle.branch,
      index: subtask.index,
      title: subtask.title,
    })
    handle.status = outcome.status
    handle.files = outcome.files
    handle.commit = outcome.commit
    handle.detail = outcome.detail
    if (outcome.status === 'no-changes') {
      // An empty checkout is debris; drop it now instead of leaving it behind.
      await workspaceManager(run.workspace?.boundary).release({ dir: handle.dir, branch: handle.branch }).catch(() => {})
      handle.dir = null
      handle.branch = null
    }
    await save(run)
  }

  /**
   * Directory against which a subtask's declared deliverables are resolved:
   * its own checkout when isolated, the shared checkout otherwise.
   */
  function deliverableRoot(run, subtask) {
    return subtask.workspace?.dir ?? run.workspace?.base ?? config.workspaceRoot ?? cwd
  }

  /**
   * Check the files a subtask promised to hand back before it is allowed to
   * count as completed.
   *
   * Only subtasks that declared deliverables are checked; a task that returns
   * findings in its report is unaffected. A missing, empty, outside-the-root,
   * or wrong-type file fails the subtask. A missing file that exists in the
   * shared checkout instead is reported as `misplaced`, so a worker that wrote
   * outside its root is not confused with one that produced nothing. A kind
   * this plugin cannot judge is `unverified` — it stops the completion claim
   * without asserting the file is bad.
   *
   * @param {object} run - live run record.
   * @param {object} subtask - subtask whose worker just claimed completion.
   * @returns {Promise<{ at: string, root: string, items: Array<object>, failed: Array<object>, unverified: Array<object> } | null>}
   */
  async function verifyDeliverables(run, subtask) {
    const declared = subtask.deliverables ?? []
    if (declared.length === 0) return null
    const root = path.resolve(deliverableRoot(run, subtask))
    const items = []
    for (const entry of declared) {
      const resolved = path.resolve(root, entry.path)
      // A plan cannot widen its own reach by naming ../../ or an absolute path.
      const inside = resolved === root || resolved.startsWith(root + path.sep)
      if (!inside) {
        items.push({
          ...entry,
          status: 'failed',
          reason: `declared deliverable is outside the working directory: ${entry.path}`,
        })
        continue
      }
      let stats
      try {
        stats = await fsp.stat(resolved)
      } catch (error) {
        const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
        if (!missing) {
          items.push({
            ...entry,
            status: 'unverified',
            reason: `could not read ${entry.path}: ${error?.message ?? error}`,
          })
          continue
        }
        // Not found where this worker was supposed to write. Before calling it
        // missing, check whether the file landed in the shared checkout: that is
        // a misplaced write, not an empty result.
        const misplaced = await misplacedDeliverable(run, subtask, entry)
        items.push({
          ...entry,
          status: 'failed',
          code: misplaced ? 'misplaced' : 'missing',
          reason: misplaced
            ? `declared deliverable "${entry.path}" exists only in the shared checkout (${misplaced}), not in `
              + `this worker's isolated checkout (${root})`
            : `declared deliverable "${entry.path}" is missing`,
        })
        continue
      }
      if (!stats.isFile()) {
        items.push({
          ...entry,
          status: 'failed',
          reason: `declared deliverable "${entry.path}" is not a file`,
        })
        continue
      }
      const minBytes = Number.isFinite(Number(entry.minBytes))
        ? Math.max(1, Math.trunc(Number(entry.minBytes)))
        : 1
      if (stats.size < minBytes) {
        items.push({
          ...entry,
          bytes: stats.size,
          status: 'failed',
          code: 'empty',
          reason: `declared deliverable "${entry.path}" is empty (${stats.size} bytes)`,
        })
        continue
      }
      let head = Buffer.alloc(0)
      try {
        const handle = await fsp.open(resolved, 'r')
        try {
          // Type checks only need the header; a huge report is not loaded whole.
          const length = Math.min(stats.size, 65536)
          const buffer = Buffer.alloc(length)
          const { bytesRead } = await handle.read(buffer, 0, length, 0)
          head = buffer.subarray(0, bytesRead)
        } finally {
          await handle.close()
        }
      } catch (error) {
        items.push({
          ...entry,
          status: 'unverified',
          reason: `could not read ${entry.path}: ${error?.message ?? error}`,
        })
        continue
      }
      items.push({
        ...entry,
        bytes: stats.size,
        ...inspectDeliverable({ path: entry.path, kind: entry.kind, bytes: stats.size, head }),
      })
    }
    return {
      at: new Date(now()).toISOString(),
      root,
      items,
      failed: items.filter(item => item.status === 'failed'),
      unverified: items.filter(item => item.status === 'unverified'),
    }
  }

  /**
   * Look for a missing deliverable in the shared checkout.
   *
   * This is a diagnosis, not an acceptable location. With isolation on, the
   * worker starts in its own checkout, so a copy in the base checkout means the
   * write ignored that root. Keeping the two cases apart matters: "missing"
   * means no file was produced, while "misplaced" means the file exists where
   * neither the merge nor the check will see it — a different defect.
   *
   * @param {object} run - live run record.
   * @param {object} subtask - subtask being verified.
   * @param {object} entry - declared deliverable.
   * @returns {Promise<string|null>} absolute path when it exists only in the base checkout.
   */
  async function misplacedDeliverable(run, subtask, entry) {
    if (run.workspace?.mode !== 'git-worktree') return null
    const base = run.workspace.base ? path.resolve(run.workspace.base) : null
    const here = path.resolve(deliverableRoot(run, subtask))
    if (!base || base === here) return null
    const candidate = path.resolve(base, entry.path)
    if (candidate !== base && !candidate.startsWith(base + path.sep)) return null
    try {
      const stats = await fsp.stat(candidate)
      return stats.isFile() ? candidate : null
    } catch {
      return null
    }
  }

  /**
   * Checkouts that no merge covers, so a kept worktree is never invisible.
   *
   * A worker that failed or was cancelled still leaves files behind; reporting
   * them is the difference between "the run kept something for you" and a
   * directory nobody knows about.
   *
   * @param {object} run - live run record.
   * @returns {Array<object>} merge-shaped rows for `run.workspace.merges`.
   */
  function leftoverWorkspaces(run) {
    return (run.subtasks ?? [])
      .filter(subtask => subtask.workspace?.dir && subtask.workspace.status !== 'committed')
      .map(subtask => ({
        index: subtask.index,
        branch: subtask.workspace.branch,
        dir: subtask.workspace.dir,
        status: 'unmerged',
        files: [],
        detail: 'the worker did not finish, so its checkout was left untouched for a resume',
      }))
  }

  /**
   * Merge every worker branch back into the main checkout.
   *
   * A conflict aborts the merge and keeps both sides intact; the file list
   * lands on the run and in the status text, which is how a conflict reaches
   * the user instead of disappearing into a log line.
   *
   * @param {object} run - live run record.
   */
  async function mergeWorkspaces(run) {
    if (run.workspace?.mode !== 'git-worktree') return
    const workers = (run.subtasks ?? [])
      .filter(subtask => subtask.workspace?.dir && subtask.workspace.status === 'committed')
      .map(subtask => ({
        index: subtask.index,
        title: subtask.title,
        dir: subtask.workspace.dir,
        branch: subtask.workspace.branch,
      }))
    if (workers.length === 0) {
      run.workspace.merges = leftoverWorkspaces(run)
      return
    }
    const outcomes = await workspaceManager(run.workspace?.boundary).mergeAll(workers)
    run.workspace.merges = [...outcomes, ...leftoverWorkspaces(run)]
    run.workspace.conflicts = outcomes.filter(outcome => outcome.status === 'conflict').length
    for (const outcome of outcomes) {
      const subtask = (run.subtasks ?? []).find(entry => entry.index === outcome.index)
      if (subtask?.workspace) {
        subtask.workspace.merged = outcome.status
        subtask.workspace.detail = outcome.detail
        if (outcome.status === 'merged') subtask.workspace.dir = null
      }
    }
    await save(run)
  }

  function save(run) {
    run.updatedAt = new Date(now()).toISOString()
    // The guard is process-wide and owned by the caller; copy its counters onto
    // the record so status and the stored run show what was blocked.
    const snapshot = guard?.snapshot?.(run.id)
    if (snapshot) run.guard = snapshot
    const previous = saveChains.get(run.id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => store.write(run))
    saveChains.set(run.id, next)
    return next
  }

  function liveRun(runId) {
    return runtime.get(runId)?.run ?? null
  }

  /** Runs waiting for a free slot, in admission order. */
  const queue = []
  let queueTicker = null
  let pumping = null

  /** How many starts may wait at once; 0 turns queueing off entirely. */
  function maxQueuedRuns() {
    return clamp(config.maxQueuedRuns ?? 5, 0, 32)
  }

  function queueTimeoutMs() {
    return clamp(config.queueTimeoutMinutes ?? 30, 1, 720) * 60000
  }

  /**
   * Queueing happens when the caller asks for it (`queue: true`) or the profile
   * made it the default. The default stays "reject" so an existing script that
   * relied on the quota error keeps seeing it.
   */
  function queueEnabled(requested) {
    return maxQueuedRuns() > 0 && (requested === true || config.queueOnFull === true)
  }

  function isWaiting(run) {
    return run?.queue?.waiting === true
  }

  /**
   * Another active run of the same schedule, if any.
   *
   * A plan may own one active run at a time, and the run records are the lock:
   * a timer-driven start and a person's resume both take the start gate and
   * both read this, so whichever comes second sees the first. Without it a
   * resume that revives a failed run and a catch-up for the same window can
   * both become active, and every later window is then skipped behind the pair.
   *
   * @param {string | null} runId - the run being started or resumed, if it exists yet.
   * @param {object | null} origin - origin of the run being started, for a start.
   * @returns {Promise<object | null>} the active peer, or null.
   */
  async function activePeerForScheduled(runId, origin) {
    const planId = origin?.kind === 'scheduled' ? origin.scheduleId : null
    if (!planId) return null
    const runs = new Map()
    for (const run of await store.list()) runs.set(run.id, run)
    for (const [id, rt] of runtime) runs.set(id, rt.run)
    for (const run of runs.values()) {
      if (runId && run.id === runId) continue
      if (run.origin?.kind !== 'scheduled' || run.origin.scheduleId !== planId) continue
      if (ACTIVE_STATUSES.has(run.status) && !isWaiting(run)) return run
    }
    return null
  }

  /** Persist the queue positions so `status` and `list` show the real place in line. */
  async function refreshQueuePositions() {
    let changed = false
    for (let index = 0; index < queue.length; index++) {
      const run = queue[index].run
      run.queue = run.queue ?? {}
      if (run.queue.position === index + 1 && run.queue.of === queue.length) continue
      run.queue.position = index + 1
      run.queue.of = queue.length
      changed = true
    }
    if (changed) await Promise.all(queue.map(entry => save(entry.run).catch(() => {})))
  }

  /**
   * A waiting run must look alive to another process sharing the state
   * directory; otherwise its heartbeat ages out and that process's sweep would
   * reclaim a run this one is still holding.
   */
  function ensureQueueTicker() {
    if (queueTicker || queue.length === 0) return
    queueTicker = setInterval(() => {
      for (const entry of queue) {
        if (!isWaiting(entry.run)) continue
        entry.run.heartbeatAt = new Date(now()).toISOString()
        entry.run.ownerPid = process.pid
        save(entry.run).catch(() => {})
      }
    }, HEARTBEAT_MS)
    queueTicker.unref?.()
  }

  function stopQueueTicker() {
    if (!queueTicker) return
    clearInterval(queueTicker)
    queueTicker = null
  }

  /** Hold one run until a slot frees or its queue timeout expires. */
  function enqueue(run, parent) {
    const entry = { run, parent, timer: null }
    const remaining = Math.max(0, Date.parse(run.queue.timeoutAt) - now())
    entry.timer = setTimer(() => {
      expireQueued(entry).catch(error => log(`cannot expire queued run ${run.id}: ${error?.message ?? error}`))
    }, remaining)
    entry.timer?.unref?.()
    queue.push(entry)
    ensureQueueTicker()
    return entry
  }

  /**
   * Start queued runs while slots are free, oldest first. Serialized with
   * `start` and `resume` so two admissions cannot both take the last slot.
   */
  function pumpQueue() {
    if (pumping) return pumping
    pumping = serialize(async () => {
      try {
        while (queue.length > 0) {
          const active = await activeCount()
          if (active >= maxActiveRuns()) break
          const entry = queue.shift()
          if (entry.timer) clearTimer(entry.timer)
          if (!isWaiting(entry.run)) continue
          await promote(entry)
        }
      } catch (error) {
        log(`cannot start queued runs: ${error?.message ?? error}`)
      } finally {
        pumping = null
        if (queue.length === 0) stopQueueTicker()
        await refreshQueuePositions().catch(() => {})
      }
    })
    return pumping
  }

  /**
   * Move one waiting run into execution. Its task clock starts now: time spent
   * in line must not eat the deadline the user chose for the work.
   */
  async function promote(entry) {
    const run = entry.run
    run.queue = { ...(run.queue ?? {}), waiting: false, startedAt: new Date(now()).toISOString() }
    run.startedAt = new Date(now()).toISOString()
    run.deadlineAt = new Date(now() + run.limits.deadlineMinutes * 60000).toISOString()
    run.ownerPid = process.pid
    run.ownerHost = os.hostname()
    run.heartbeatAt = new Date(now()).toISOString()
    await takeRunLock(run.id)
    try {
      await save(run)
    } catch (error) {
      await releaseRunLock(run.id)
      throw error
    }
    schedule(run, entry.parent)
    log(`queued run ${run.id} got a free slot and started`)
  }

  /**
   * A run that never got a slot is failed, not cancelled: nobody chose to stop
   * it. It settles through the normal path so its status, usage, and
   * notification row look like every other finished run.
   */
  async function expireQueued(entry) {
    const index = queue.indexOf(entry)
    if (index < 0) return
    queue.splice(index, 1)
    if (queue.length === 0) stopQueueTicker()
    const run = entry.run
    if (!isWaiting(run)) return
    run.queue = { ...run.queue, waiting: false, expired: true }
    run.error = `queued for ${queueTimeoutMs() / 60000} minute(s) without a free slot (maxActiveRuns is ${maxActiveRuns()}); `
      + 'the run never started, so nothing was spent. Start it again once a slot is free, raise maxActiveRuns, '
      + 'or raise queueTimeoutMinutes.'
    await settle(run, {
      controller: new AbortController(),
      activations: new Set(),
      subtaskAborts: new Map(),
      cancelledSubtasks: new Set(),
      waiters: 0,
      run,
      promise: null,
      abortCause: null,
      activeStart: now(),
    })
    await refreshQueuePositions().catch(() => {})
    await pumpQueue().catch(() => {})
  }

  /**
   * Write one audit event. The trail is an observer: a failure is logged and
   * dropped, never allowed to change the outcome of the run it describes.
   * `audit` is optional so a host without the audit layer behaves exactly as
   * it did before it existed.
   *
   * @param {object} event - fields for `audit.record`.
   */
  function auditRecord(event) {
    if (!audit || typeof audit.record !== 'function') return Promise.resolve()
    return Promise.resolve()
      .then(() => audit.record(event))
      .catch(error => log(`cannot write an audit event for run ${event?.runId ?? 'unknown'}: ${error?.message ?? error}`))
  }

  /**
   * Record one phase transition on the run. Milestones are observational only:
   * they appear in `superagent_status` and never wake the session, which is what
   * keeps "progress is visible" from turning into "progress is noisy".
   *
   * @param {object} run - live run record.
   * @param {'plan_ready'|'running'|'aggregating'|'settled'} name - phase name.
   */
  function addMilestone(run, name) {
    run.milestones = Array.isArray(run.milestones) ? run.milestones : []
    if (run.milestones.at(-1)?.name === name) return
    run.milestones.push({ name, at: new Date(now()).toISOString() })
    // A run can be resumed several times; keep the history bounded.
    if (run.milestones.length > 16) run.milestones = run.milestones.slice(-16)
  }

  /**
   * Keep the first thing that needs a human. Official super-agent has exactly
   * one Attention per report; a second worker asking something is recorded, but
   * the notification leads with the first question so the message stays short.
   *
   * @param {object} run - live run record.
   * @param {string} source - `subtask-<n>` or `aggregator`.
   * @param {{ question: string, options: string[], reason: string | null }} attention - parsed block.
   */
  function recordAttention(run, source, attention) {
    if (!attention) return
    run.attention = run.attention ?? { at: new Date(now()).toISOString(), items: [] }
    if (!Array.isArray(run.attention.items)) run.attention.items = []
    // The id is what an answer is matched against. It comes from a counter on
    // the run, not from the array position, so archiving the question on resume
    // cannot make an old id point at a different question later.
    run.attentionSeq = (Number(run.attentionSeq) || 0) + 1
    run.attention.items.push({
      id: `q${run.attentionSeq}`,
      source,
      question: attention.question,
      options: attention.options ?? [],
      reason: attention.reason ?? null,
    })
    auditRecord({
      runId: run.id,
      subtaskId: source,
      actor: 'agent',
      kind: 'attention',
      action: 'attention.request',
      target: attention.question,
      result: 'pending',
      meta: { options: attention.options ?? [], reason: attention.reason ?? null },
    })
  }

  /**
   * Remember that a block asked for a decision but could not be used. The raw
   * block stays in the report, and status prints this line so the user can see
   * that a decision was requested instead of silently getting a finished run.
   *
   * @param {object} run - live run record.
   * @param {string} source - `subtask-<n>` or `aggregator`.
   * @param {string | undefined} issue - why the block was unusable.
   */
  function recordAttentionIssue(run, source, issue) {
    if (!issue) return
    run.attention = run.attention ?? { at: new Date(now()).toISOString(), items: [] }
    if (!Array.isArray(run.attention.items)) run.attention.items = []
    run.attention.issue = oneLine(`${issue} (from ${source})`, 300)
  }

  /**
   * Append one instruction to the run's dialog log.
   *
   * The log is the only durable record of what was asked after the run started
   * and when it first reached a prompt, so `superagent_status` and the tool
   * reply can both say plainly whether the running work ever saw it.
   *
   * @param {object} run - run record.
   * @param {{ kind: 'followup'|'answer', text: string, attentionId?: string | null }} spec - entry.
   * @returns {object} the stored entry.
   */
  function pushFollowup(run, spec) {
    run.followups = Array.isArray(run.followups) ? run.followups : []
    const entry = {
      id: `f${(Number(run.followupSeq) || 0) + 1}`,
      kind: spec.kind,
      attentionId: spec.attentionId ?? null,
      text: capChars(spec.text, FOLLOWUP_MAX_CHARS),
      at: new Date(now()).toISOString(),
      appliedAt: null,
      appliedAtStage: null,
      missedAt: null,
      missedReason: null,
    }
    run.followupSeq = Number(run.followupSeq) || 0
    run.followupSeq++
    run.followups.push(entry)
    if (run.followups.length > FOLLOWUP_MAX) run.followups = run.followups.slice(-FOLLOWUP_MAX)
    return entry
  }

  /**
   * Record the first prompt that carried the pending instructions. The text is
   * still included in later prompts — an instruction given at subtask 2 must
   * reach the aggregator too — so this is an audit trail, not a delivery queue.
   *
   * @param {object[]} entries - the entries the prompt was built from.
   * @param {string} stage - `planner`, `subtask-<n>`, or `aggregator`.
   * @returns {boolean} true when something changed and the run needs a save.
   */
  function markFollowupsApplied(entries, stage) {
    const at = new Date(now()).toISOString()
    let changed = false
    for (const entry of entries) {
      if (entry.appliedAt) continue
      entry.appliedAt = at
      entry.appliedAtStage = stage
      changed = true
    }
    return changed
  }

  /**
   * Record one live injection and its per-worker receipts.
   *
   * This is a separate trail from `run.followups` on purpose: a followup is
   * carried by the next prompt built for the run, while an injection is handed
   * to an inbox that is already executing. Mixing them would make status
   * promise a boundary that the message never uses.
   *
   * @param {object} run - live run record.
   * @param {string} text - the instruction.
   * @returns {object} the stored entry, with an empty `targets` list.
   */
  function pushInjection(run, text) {
    run.injections = Array.isArray(run.injections) ? run.injections : []
    const entry = {
      id: `i${(Number(run.injectionSeq) || 0) + 1}`,
      text: capChars(text, FOLLOWUP_MAX_CHARS),
      at: new Date(now()).toISOString(),
      delivery: 'steer',
      status: 'pending',
      followupId: null,
      targets: [],
    }
    run.injectionSeq = (Number(run.injectionSeq) || 0) + 1
    run.injections.push(entry)
    if (run.injections.length > INJECTION_MAX) run.injections = run.injections.slice(-INJECTION_MAX)
    return entry
  }

  /** Watchers are runtime state, never persisted with the run. */
  const injectionWatches = new Map()
  const watchKey = (runId, injectionId, childId) => `${runId}:${injectionId}:${childId}`

  function stopWatch(runId, injectionId, childId) {
    const key = watchKey(runId, injectionId, childId)
    const stop = injectionWatches.get(key)
    if (!stop) return
    injectionWatches.delete(key)
    try {
      stop()
    } catch (error) {
      log(`cannot stop the injection watcher for ${childId}: ${error?.message ?? error}`)
    }
  }

  function stopRunWatches(runId) {
    for (const key of [...injectionWatches.keys()]) {
      if (key.split(':')[0] !== runId) continue
      stopWatch(...key.split(':'))
    }
  }

  /**
   * Recompute the run totals kept for status and tool replies.
   * @param {object} run - live run record.
   */
  function refreshInjectionStats(run) {
    const targets = (run.injections ?? []).flatMap(entry => entry.targets ?? [])
    const applied = targets.filter(target => target.status === 'applied')
    const latencies = applied.map(target => target.latencyMs).filter(value => Number.isFinite(value))
    for (const entry of run.injections ?? []) {
      if (entry.status === 'degraded') continue
      const own = entry.targets ?? []
      if (own.length === 0) entry.status = 'failed'
      else if (own.some(target => target.status === 'pending')) entry.status = 'pending'
      else if (own.every(target => target.status === 'applied')) entry.status = 'applied'
      else if (own.some(target => target.status === 'applied')) entry.status = 'partial'
      else entry.status = 'missed'
    }
    run.injectionStats = {
      accepted: targets.filter(target => Boolean(target.messageId)).length,
      applied: applied.length,
      missed: targets.filter(target => target.status === 'missed').length,
      failed: targets.filter(target => target.status === 'failed').length,
      pending: targets.filter(target => target.status === 'pending').length,
      lastLatencyMs: latencies.length ? latencies[latencies.length - 1] : null,
      worstLatencyMs: latencies.length ? Math.max(...latencies) : null,
      samples: latencies.length,
    }
  }

  /**
   * Move one worker receipt out of `pending`, once.
   *
   * `applied` is only recorded with the claim time the caller observed; a
   * dispatch that settles without observing a claim is not upgraded here.
   *
   * @param {object} run - live run record.
   * @param {object} target - one receipt.
   * @param {'applied'|'missed'} status - observed outcome.
   * @param {{ at?: number, reason?: string }} [detail] - claim time or miss reason.
   * @returns {boolean} whether the receipt changed.
   */
  function finishInjectionTarget(run, target, status, detail = {}) {
    if (!target || target.status !== 'pending') return false
    target.status = status
    if (status === 'applied') {
      const at = Number.isFinite(detail.at) ? detail.at : now()
      const accepted = Date.parse(target.acceptedAt ?? '')
      target.appliedAt = new Date(at).toISOString()
      target.latencyMs = Number.isFinite(accepted) ? Math.max(0, at - accepted) : null
    } else {
      target.missedAt = new Date(now()).toISOString()
      target.missedReason = detail.reason ?? 'the child never reached another step boundary'
      target.latencyMs = null
    }
    return true
  }

  /**
   * Persist a receipt change without holding up the caller's serialized action.
   * @param {object} run - live run record.
   * @param {object} target - one receipt.
   * @param {'applied'|'missed'} status - observed outcome.
   * @param {{ at?: number, reason?: string }} [detail] - claim time or miss reason.
   */
  function recordInjectionTarget(run, target, status, detail) {
    if (!finishInjectionTarget(run, target, status, detail)) return
    refreshInjectionStats(run)
    save(run).catch(error => log(`cannot persist the injection state of run ${run.id}: ${error?.message ?? error}`))
  }

  /**
   * Poll one accepted message until the child claims it.
   *
   * @param {object} run - live run record.
   * @param {object} entry - injection receipt.
   * @param {object} target - one worker receipt.
   */
  function watchInjection(run, entry, target) {
    if (typeof watchChild !== 'function' || !target.messageId) return
    const stop = watchChild(target.childId, target.messageId, {
      onClaimed: at => recordInjectionTarget(run, target, 'applied', { at }),
      onGone: () => recordInjectionTarget(run, target, 'missed', {
        reason: 'the child activation was disposed before it reached another step boundary',
      }),
    })
    const key = watchKey(run.id, entry.id, target.childId)
    const previous = injectionWatches.get(key)
    if (previous) {
      try {
        previous()
      } catch {
        // A stale watcher that cannot stop is harmless; the new one owns the receipt.
      }
    }
    injectionWatches.set(key, () => {
      if (stop && typeof stop.stop === 'function') stop.stop()
      else if (typeof stop === 'function') stop()
    })
    // The message can be claimed before the first poll: one immediate read keeps
    // a fast delivery from being displayed as pending for a full period.
    if (typeof stop?.check === 'function') {
      try {
        stop.check()
      } catch {
        // The poll keeps running; a failed first read is not a delivery failure.
      }
    }
  }

  /**
   * Close every receipt aimed at one child that is leaving its attempt.
   *
   * Runs before disposal, so the inbox is still readable: a message that is
   * gone was claimed, and one that is still there never reached a prompt.
   *
   * @param {object} run - live run record.
   * @param {string | null | undefined} childId - departing child.
   * @param {string} reason - why a still-pending message will not be read.
   * @returns {boolean} whether the run needs a save.
   */
  function settleChildInjections(run, childId, reason) {
    if (!childId) return false
    const targets = (run.injections ?? [])
      .flatMap(entry => (entry.targets ?? []).map(target => ({ entry, target })))
      .filter(({ target }) => target.childId === childId && target.status === 'pending')
    if (targets.length === 0) return false
    let inspected = null
    try {
      inspected = typeof inspectChild === 'function' ? inspectChild(childId) : null
    } catch {
      inspected = null
    }
    let changed = false
    for (const { entry, target } of targets) {
      stopWatch(run.id, entry.id, target.childId)
      const live = Boolean(inspected?.live)
      const stillPending = live && inspected?.pending?.has?.(String(target.messageId))
      changed = finishInjectionTarget(run, target, live && !stillPending ? 'applied' : 'missed', {
        reason: live
          ? reason
          : 'the child was gone before the message reached another step boundary',
      }) || changed
    }
    if (changed) refreshInjectionStats(run)
    return changed
  }

  /**
   * Deliver one instruction into the workers that are running now.
   *
   * Delivery is a steer: `agent-loop` claims it at the next pre-step, so it is
   * part of the child's next model request instead of interrupting the one in
   * flight. A child that had already decided to stop runs one more turn when
   * the inbox is non-empty, which is why a live, uncancelled child consumes it.
   * The latency is measured from acceptance to that claim and written on the
   * receipt; the theoretical bound is the remainder of the running step.
   *
   * @param {string} runId - run identity.
   * @param {string} text - the instruction.
   * @param {object} parent - live agent that owns the run.
   * @param {{ subtaskIndex?: number | string | null }} [options] - narrow to one worker.
   * @returns {Promise<{ run: object, injection: object, degraded: object | null, effect: object }>}
   */
  async function inject(runId, text, parent, options = {}) {
    const id = String(runId ?? '').trim()
    if (!id) throw new Error('run_id is required')
    const message = capChars(text, FOLLOWUP_MAX_CHARS)
    if (!message) throw new Error('message is required; pass the instruction the running workers should read')
    if (!parent || typeof parent !== 'object') throw new Error('superagent requires a live parent agent')
    const rawIndex = options.subtaskIndex
    const wanted = rawIndex === undefined || rawIndex === null || rawIndex === ''
      ? null
      : Number(rawIndex)
    if (wanted !== null && !Number.isInteger(wanted)) {
      throw new Error('subtask_index must be a whole number from superagent_status')
    }
    return serialize(async () => {
      const rt = runtime.get(id)
      const run = rt?.run ?? await loadRun(id)
      assertResumeOwner(run, parent)
      if (!ACTIVE_STATUSES.has(run.status)) {
        throw new Error(
          `run ${id} is ${run.status}, so no child is running to receive a live instruction. `
          + 'Use superagent_followup to queue it for the next prompt.',
        )
      }
      if (!rt) {
        throw new Error(
          `run ${id} is active but owned by another process; a live instruction must come from the process that owns `
          + 'its children, because only that process holds their inboxes.',
        )
      }
      const running = (run.subtasks ?? []).filter(subtask => subtask.status === 'running' && subtask.childId)
      const selected = wanted === null ? running : running.filter(subtask => subtask.index === wanted)
      // A running subtask can be between attempts, where its old child id no
      // longer resolves. Steering a dead inbox would look like delivery, so the
      // live ones are selected here and the reply names the gap otherwise.
      const live = typeof inspectChild === 'function'
        ? selected.filter(subtask => {
          try {
            return Boolean(inspectChild(subtask.childId)?.live)
          } catch {
            return false
          }
        })
        : selected
      const targets = live
      if (targets.length === 0) {
        const who = wanted === null ? 'no worker is live' : `worker ${wanted} is not live`
        const activity = (run.subtasks ?? [])
          .filter(subtask => subtask.status === 'running')
          .map(subtask => `#${subtask.index}`)
          .join(', ')
        throw new Error(
          `${who} on run ${id} (status ${run.status}${activity ? `, attempts in progress: ${activity}` : ''}), so `
          + 'there is no inbox to steer right now. superagent_followup queues the instruction for the next prompt '
          + 'instead.',
        )
      }
      const entry = pushInjection(run, message)
      let unsupported = null
      for (const subtask of targets) {
        const target = {
          subtaskIndex: subtask.index,
          childId: subtask.childId,
          messageId: null,
          via: null,
          acceptedAt: new Date(now()).toISOString(),
          status: 'pending',
          appliedAt: null,
          latencyMs: null,
          missedAt: null,
          missedReason: null,
          error: null,
        }
        entry.targets.push(target)
        if (typeof steerChild !== 'function') {
          target.status = 'failed'
          target.error = 'this host exposes no live channel into a running child'
          unsupported = target.error
          continue
        }
        try {
          const receipt = await steerChild({
            parent,
            childId: target.childId,
            text: message,
            signal: rt.controller.signal,
          })
          target.messageId = String(receipt?.messageId ?? '')
          target.via = receipt?.via ?? null
          watchInjection(run, entry, target)
        } catch (error) {
          target.status = 'failed'
          target.error = error?.message ?? String(error)
          if (error?.code === 'inject-unsupported') unsupported = target.error
          else if (error?.code === 'inject-child-gone') target.error = `${target.error}; the worker already settled`
        }
      }
      let degraded = null
      if (unsupported && entry.targets.every(target => target.status === 'failed')) {
        // No live channel at all. Do not pretend the instruction was delivered:
        // queue it exactly where superagent_followup would, and label the
        // receipt as degraded so status cannot read as a live delivery.
        const followup = pushFollowup(run, { kind: 'followup', text: message })
        entry.status = 'degraded'
        entry.followupId = followup.id
        degraded = { followup, effect: followupEffect(run), reason: unsupported }
      }
      refreshInjectionStats(run)
      await save(run)
      return { run, injection: entry, degraded, effect: followupEffect(run) }
    })
  }

  /**
   * Wait for the receipts of one injection to leave `pending`.
   *
   * The claim is observed by a poll, so the reported latency has that
   * resolution; waiting does not change delivery, only what the reply can say.
   *
   * @param {object} run - live run record.
   * @param {object} entry - injection receipt.
   * @param {number} [seconds] - upper bound on the wait.
   * @returns {Promise<object>} the same entry, updated in place.
   */
  async function waitForInjection(run, entry, seconds) {
    const limit = Math.max(0, Number(seconds) || 0) * 1000
    if (limit <= 0) return entry
    const started = now()
    while (now() - started < limit) {
      if (!(entry.targets ?? []).some(target => target.status === 'pending')) break
      await sleep(Math.min(INJECT_POLL_MS * 2, Math.max(5, limit - (now() - started))))
    }
    return entry
  }

  /**
   * Write the final report next to the run state, so the outcome has an address
   * the user can open or attach, not only a paragraph in a tool reply. The
   * directory carries its own `.gitignore` for the same reason the memory
   * directory does: a stateDir inside a repository must not leak run output.
   *
   * @param {object} run - terminal run with `report`.
   */
  async function writeReportArtifact(run) {
    const root = typeof store.root === 'string' ? store.root : null
    if (!root || typeof run.report !== 'string' || !run.report.trim()) return
    const dir = path.join(root, 'reports')
    const file = path.join(dir, `${run.id}.md`)
    try {
      await fsp.mkdir(dir, { recursive: true })
      const ignore = path.join(dir, '.gitignore')
      try {
        await fsp.access(ignore)
      } catch {
        await fsp.writeFile(ignore, '*\n', 'utf8')
      }
      const body = `${run.report.trim()}\n`
      const tmp = path.join(dir, `.${run.id}.${process.pid}.tmp`)
      await fsp.writeFile(tmp, body, 'utf8')
      for (let attempt = 1; ; attempt++) {
        try {
          await fsp.rename(tmp, file)
          break
        } catch (error) {
          if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
          await sleep(20 * attempt)
        }
      }
      run.artifacts = (Array.isArray(run.artifacts) ? run.artifacts : [])
        .filter(artifact => artifact?.path !== file)
      run.artifacts.push({
        kind: 'report',
        path: file,
        bytes: Buffer.byteLength(body, 'utf8'),
        at: new Date(now()).toISOString(),
      })
      run.artifactError = null
    } catch (error) {
      run.artifactError = `cannot write the report file: ${error?.message ?? error}`
      log(`run ${run.id}: ${run.artifactError}`)
    }
  }

  /** Cached machine identity of the state directory. */
  let ownerRef = null
  async function ownerIdentity() {
    if (ownerRef) return ownerRef
    const host = os.hostname()
    const existing = typeof store.readOwner === 'function' ? await store.readOwner() : null
    if (existing && typeof existing.hostname === 'string') {
      ownerRef = { hostname: host, local: existing.hostname === host, ownerHostname: existing.hostname }
      return ownerRef
    }
    if (typeof store.writeOwner === 'function') {
      await store.writeOwner({ hostname: host, createdAt: new Date(now()).toISOString() })
    }
    ownerRef = { hostname: host, local: true, ownerHostname: host }
    return ownerRef
  }

  /**
   * @param {unknown} pid - pid recorded by the process that owned the run.
   * @returns {boolean | null} true when alive, false when gone, null when unknown.
   */
  function pidAlive(pid) {
    const number = Number(pid)
    if (!Number.isInteger(number) || number <= 0) return null
    try {
      process.kill(number, 0)
      return true
    } catch (error) {
      // EPERM means the process exists but belongs to another user.
      return error?.code === 'EPERM'
    }
  }

  /**
   * Decide whether an active run still has a live owner.
   *
   * Used by recovery, orphan sweeping, and resume, so all three agree: a run
   * that somebody can still be working on is never rewritten. The heartbeat
   * alone proves ownership on a shared directory; a pid is only evidence when
   * the state directory belongs to this machine. A live run lock counts as
   * ownership because the holder is the process that may be spending.
   *
   * @param {object} run - persisted run record.
   * @returns {Promise<{ live: boolean, basis: string, heartbeatAt: number, owner: object, pidChecked: boolean }>}
   */
  async function ownership(run) {
    const owner = await ownerIdentity()
    const heartbeat = Date.parse(run.heartbeatAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt)
    const heartbeatIso = Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : 'unknown'
    const fresh = Number.isFinite(heartbeat) && heartbeat > now() - ORPHAN_MS
    // A pid only means something when the run was written on this machine. On
    // a shared directory the run may belong to a host whose pids are unrelated
    // to ours, so the heartbeat is the only evidence there.
    const localWriter = run.ownerHost ? run.ownerHost === os.hostname() : owner.local
    const alive = localWriter ? pidAlive(run.ownerPid) : null

    if (alive === true) {
      return { live: true, basis: `owner pid ${run.ownerPid} is still running`, heartbeatAt: heartbeat, owner, pidChecked: true }
    }
    if (typeof store.readLock === 'function') {
      const holder = await store.readLock(run.id).catch(() => null)
      if (holder && holder.hostname === os.hostname() && pidAlive(holder.pid) === true) {
        return { live: true, basis: `pid ${holder.pid} holds the run lock`, heartbeatAt: heartbeat, owner, pidChecked: true }
      }
    }
    // A heartbeat can be a few seconds old when the host is killed, and waiting
    // 90 s for it to expire would strand a run that this machine can prove is
    // dead. On the same machine, a missing pid outranks a fresh timestamp.
    if (alive === false) {
      return {
        live: false,
        basis: `owner pid ${run.ownerPid} is not running and this state directory is local`,
        heartbeatAt: heartbeat,
        owner,
        pidChecked: true,
      }
    }
    if (fresh) {
      return { live: true, basis: `its heartbeat was refreshed at ${heartbeatIso}`, heartbeatAt: heartbeat, owner, pidChecked: false }
    }
    const basis = owner.local
      ? `owner pid ${run.ownerPid ?? 'unknown'} is not running and its heartbeat stopped at ${heartbeatIso}`
      : `the state directory is shared with ${owner.ownerHostname}, so a local pid proves nothing; the heartbeat stopped at ${heartbeatIso}`
    return { live: false, basis, heartbeatAt: heartbeat, owner, pidChecked: owner.local }
  }

  /**
   * Rewrite a run whose owner is gone. Never silent: the exact evidence is
   * stored on the run and printed by status.
   */
  function reclaim(run, verdict, cancelled = false) {
    run.status = cancelled ? 'cancelled' : 'interrupted'
    run.error = cancelled
      ? 'cancelled by superagent_cancel while no process was running it'
      : 'host process stopped while the run was active'
    run.finishedAt = new Date(now()).toISOString()
    if (run.queue?.waiting) run.queue = { ...run.queue, waiting: false, lost: true }
    run.reclaimed = {
      at: new Date(now()).toISOString(),
      basis: verdict.basis,
      heartbeatAt: Number.isFinite(verdict.heartbeatAt) ? new Date(verdict.heartbeatAt).toISOString() : null,
      ownerPid: run.ownerPid ?? null,
      pidChecked: verdict.pidChecked,
      sharedWith: verdict.owner.local ? null : verdict.owner.ownerHostname,
    }
    for (const subtask of run.subtasks ?? []) {
      if (subtask.status === 'running') subtask.status = 'pending'
    }
    // The owner died before it could settle, so publish what is already known
    // about the spend: a reclaimed run must not claim its cost is unknown when
    // its child logs were readable.
    const entries = Object.values(run.usageByChild ?? {})
    if (entries.length > 0) run.usage = sumUsage(entries)
    for (const subtask of run.subtasks ?? []) {
      if (subtask.childId && run.usageByChild?.[subtask.childId]) {
        subtask.usage = run.usageByChild[subtask.childId]
      }
    }
    applyCost(run, config.pricing)
  }

  async function releaseRunLock(runId) {
    if (typeof store.releaseLock !== 'function') return
    try {
      await store.releaseLock(runId)
    } catch (error) {
      log(`cannot release the lock for run ${runId}: ${error?.message ?? error}`)
    }
  }

  /**
   * Claim the exclusive right to schedule a run.
   *
   * Two profiles can point at one state directory, so a resume must not be
   * decided from a read alone: both processes would see a terminal run and both
   * would schedule it. The lock makes one of them lose.
   */
  async function takeRunLock(runId) {
    if (typeof store.acquireLock !== 'function') return
    const holder = { pid: process.pid, hostname: os.hostname(), at: new Date(now()).toISOString() }
    let attempt = await store.acquireLock(runId, holder)
    if (!attempt.acquired) {
      const current = attempt.holder
      // A lock left by a process on this machine that no longer exists is
      // evidence of a crash, not of a live owner. A lock on another machine has
      // no checkable pid, so its age is the only evidence: past LOCK_STALE_MS
      // the process that took it is no longer plausibly still scheduling.
      const deadHere = current && current.hostname === os.hostname() && pidAlive(current.pid) === false
      const aliveHere = current && current.hostname === os.hostname() && pidAlive(current.pid) === true
      const age = now() - Date.parse(current?.at ?? '')
      const stale = !Number.isFinite(age) || age > LOCK_STALE_MS
      // Age is only evidence when the holder cannot be checked: a live process
      // on this machine may legitimately schedule a long run for hours.
      if (deadHere || (stale && !aliveHere)) {
        await releaseRunLock(runId)
        attempt = await store.acquireLock(runId, holder)
      }
      if (!attempt.acquired) {
        const held = attempt.holder
        const who = held
          ? `pid ${held.pid ?? 'unknown'} on ${held.hostname ?? 'an unknown host'}`
          : 'another process'
        throw new Error(`run ${runId} is already being started by ${who}; wait for it to finish or cancel it`)
      }
    }
  }

  /** The lock id used for one goal; it fits the id pattern the store validates. */
  function goalGuardId(key) {
    return `${GOAL_GUARD_PREFIX}${key.slice(0, 40)}`
  }

  /**
   * The active run that already covers one goal, if any.
   *
   * The list on disk is the authority, because another host may own the run; a
   * run this process is finishing keeps its in-memory status until the terminal
   * write lands, so the runtime copy wins when both exist.
   *
   * @param {string} key - `dedupeKeyOf(goal)` of the goal being started.
   * @param {string} parentSessionId - session that would own the new run.
   * @returns {Promise<object | null>} the newest active run for that goal in this session.
   */
  async function activeRunForGoal(key, parentSessionId) {
    const runs = new Map()
    for (const run of await store.list()) runs.set(run.id, run)
    for (const [runId, rt] of runtime) if (rt.run) runs.set(runId, rt.run)
    const hits = [...runs.values()]
      // A goal is only the same work inside the session that asked for it: two
      // sessions may legitimately run the same generic goal at the same time.
      .filter(run => run.parentSessionId === parentSessionId
        && ACTIVE_STATUSES.has(run.status)
        && (run.dedupeKey ?? dedupeKeyOf(run.goal)) === key)
    if (hits.length === 0) return null
    hits.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return hits[0]
  }

  /**
   * Run `task` while holding the claim on one goal.
   *
   * Two processes sharing a state directory would otherwise both list the runs,
   * both see nothing active, and both create a run for the same goal. The claim
   * is keyed by the goal rather than by a run id, which does not exist yet. The
   * winner writes the run record before it releases the claim, so the loser's
   * own check under the lock finds that record and joins it instead.
   *
   * A guard whose owner is gone is broken exactly like a run lock. A merely
   * slow owner is waited for, because a duplicate costs money; past the wait a
   * real start proceeds without the guard, since refusing it because a file was
   * left behind would be the worse failure.
   *
   * @template T
   * @param {string} key - `dedupeKeyOf(goal)`.
   * @param {() => Promise<T>} task - runs while the claim is held.
   * @returns {Promise<T>} the task's result.
   */
  async function withGoalGuard(key, task) {
    if (typeof store.acquireLock !== 'function' || typeof store.releaseLock !== 'function') return task()
    const id = goalGuardId(key)
    const holder = { pid: process.pid, hostname: os.hostname(), at: new Date(now()).toISOString() }
    const endsAt = now() + GOAL_GUARD_WAIT_MS
    let locked = false
    while (!locked && now() < endsAt) {
      const attempt = await store.acquireLock(id, holder)
      if (attempt.acquired) {
        locked = true
        break
      }
      const current = attempt.holder
      const local = Boolean(current) && current.hostname === os.hostname()
      const age = now() - Date.parse(current?.at ?? '')
      const stale = !Number.isFinite(age) || age > LOCK_STALE_MS
      const aliveHere = local && pidAlive(current.pid) === true
      // A lock on this machine whose pid is gone is evidence of a crash; an
      // uncheckable lock is broken only once it is old.
      if ((local && pidAlive(current.pid) === false) || (stale && !aliveHere)) {
        await store.releaseLock(id)
        continue
      }
      await sleep(GOAL_GUARD_POLL_MS)
    }
    try {
      return await task()
    } finally {
      if (locked) {
        try {
          await store.releaseLock(id)
        } catch (error) {
          log(`cannot release the goal guard ${id}: ${error?.message ?? error}`)
        }
      }
    }
  }

  /**
   * Reclaim runs whose owning process is gone, so an orphan cannot hold the
   * active-run quota forever.
   *
   * @returns {Promise<string[]>} reclaimed run ids, in list order.
   */
  async function sweepOrphans() {
    const stale = (await store.list()).filter(run => ACTIVE_STATUSES.has(run.status) && !runtime.has(run.id))
    if (stale.length === 0) return []
    const reclaimed = []
    for (const run of stale) {
      const verdict = await ownership(run)
      if (verdict.live) continue
      reclaim(run, verdict)
      await save(run)
      await releaseRunLock(run.id)
      log(`run ${run.id} was active with no live owner; reclaimed its quota (${verdict.basis})`)
      reclaimed.push(run.id)
    }
    return reclaimed
  }

  async function activeCount() {
    try {
      await sweepOrphans()
    } catch (error) {
      log(`cannot check for orphaned runs: ${error?.message ?? error}`)
    }
    let count = 0
    for (const rt of runtime.values()) {
      // A run waiting for a slot is not spending anything yet, so it must not
      // consume the quota that decides when it may start.
      if (rt.run && ACTIVE_STATUSES.has(rt.run.status) && !isWaiting(rt.run)) count++
    }
    for (const run of await store.list()) {
      if (runtime.has(run.id)) continue
      if (ACTIVE_STATUSES.has(run.status) && !isWaiting(run)) count++
    }
    return count
  }

  function quotaMessage(active, queued = 0) {
    const waiting = queued > 0 ? ` ${queued} run(s) are already queued, so this start would wait behind them.` : ''
    return `quota exceeded: ${active} active run(s) and maxActiveRuns is ${maxActiveRuns()}.${waiting} `
      + 'Let one finish with superagent_status or cancel it with superagent_cancel.'
  }

  function buildLimits(overrides = {}) {
    // A caller may narrow a limit but never widen the operator's cap: the
    // config is the spending and blast-radius control, and a model-written tool
    // argument must not be able to raise it.
    const narrowed = (override, cap) => (
      override === undefined || override === null ? cap : Math.min(Number(override), cap)
    )
    const limits = {
      maxSubtasks: clamp(narrowed(overrides.maxSubtasks, config.maxSubtasks), 1, 16),
      maxParallel: clamp(narrowed(overrides.maxParallel, config.maxParallel), 1, 8),
      deadlineMinutes: clamp(narrowed(overrides.deadlineMinutes, config.deadlineMinutes), 1, 720),
      attempts: clamp(config.attempts, 1, 5),
      maxModelCalls: clamp(narrowed(overrides.maxModelCalls, config.maxModelCallsPerRun), 0, 10000),
      maxTokens: clamp(narrowed(overrides.maxTokens, config.maxTokensPerRun), 0, 1e12),
    }
    limits.maxParallel = Math.min(limits.maxParallel, limits.maxSubtasks)
    return limits
  }

  /** Memory limits, clamped once so a bad config cannot remove the cap. */
  function memorySettings() {
    return {
      scope: typeof config.memoryScope === 'string' && config.memoryScope ? config.memoryScope : 'default',
      maxEntries: clamp(config.memoryMaxEntries ?? 60, 1, 500),
      maxAgeDays: clamp(config.memoryMaxAgeDays ?? 30, 1, 3650),
      digestEntries: clamp(config.memoryDigestEntries ?? 12, 1, 50),
      digestChars: clamp(config.memoryDigestChars ?? 1600, 200, 8000),
    }
  }

  /**
   * Build the bounded context carried into planning and aggregation: exact run
   * history from the store plus the curated notes. Returns null when there is
   * nothing to carry, so a first run's prompts stay unchanged.
   *
   * Notes are layered: `rules` holds project rules, `profile` holds user
   * preferences, `memoryScope` holds what earlier runs learned, and the optional
   * user-level profile holds facts, preferences and decisions that outlive one
   * task. The first two are curated by hand (the `superagent_memory` tool), so
   * they always come before run notes: a rule must not be drowned out by recent
   * observations.
   *
   * @param {string | null} currentId - run being started or resumed.
   * @param {string} goal - the run's goal, used to recall the notes that matter.
   */
  async function memoryContext(currentId, goal = '') {
    if (!memory && !userMemory) return null
    const settings = memorySettings()
    const layers = []
    let noteCount = 0
    let userNoteCount = 0
    try {
      if (memory) {
        for (const [label, scope] of [
          ['Project rules', 'rules'],
          ['User profile', 'profile'],
        ]) {
          const text = await memory.digest({
            scope,
            maxEntries: settings.digestEntries,
            maxChars: Math.floor(settings.digestChars / 3),
            maxAgeDays: settings.maxAgeDays,
          })
          if (!text) continue
          const read = await memory.read({ scope, maxAgeDays: settings.maxAgeDays })
          noteCount += read.entries.length
          layers.push(`${label} (scope "${scope}"):\n${text}`)
        }
      }
      // The learned profile sits between the hand-curated layers and this run's
      // notebook: it is about the user, so it outranks one run's observations.
      if (userMemory) {
        const learned = await userMemory.digest({
          query: goal,
          maxEntries: 6,
          maxChars: Math.floor(settings.digestChars / 2),
        })
        if (learned) {
          const userStats = await userMemory.stats()
          userNoteCount = userStats.total
          layers.push(
            'User profile learned across tasks (facts, preferences, decisions with rationale; may be stale, '
            + 'verify before relying on it):\n' + learned,
          )
        }
      }
      if (memory) {
        const notes = await memory.digest({
          scope: settings.scope,
          // Rank notes against this goal instead of only taking the newest ones,
          // so a run with many predecessors still finds the relevant experience.
          query: goal,
          maxEntries: settings.digestEntries,
          maxChars: settings.digestChars,
          maxAgeDays: settings.maxAgeDays,
        })
        if (notes) {
          const read = await memory.read({ scope: settings.scope, maxAgeDays: settings.maxAgeDays })
          noteCount += read.entries.length
          layers.push(notes)
        }
      }
    } catch (error) {
      log(`cannot read cross-run memory: ${error?.message ?? error}`)
    }
    const notes = layers.join('\n\n')

    let history = ''
    let runCount = 0
    try {
      const runs = (await store.list())
        .filter(run => run.id !== currentId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 6)
      runCount = runs.length
      history = runs.map(run => {
        const subtasks = run.subtasks ?? []
        const done = subtasks.filter(subtask => subtask.status === 'completed').length
        const goal = [...String(run.goal ?? '').replace(/\s+/g, ' ').trim()].slice(0, 90).join('')
        return `- ${String(run.createdAt ?? '').slice(0, 10)} ${run.status} ${done}/${subtasks.length} ${goal} (run ${run.id})`
      }).join('\n')
    } catch (error) {
      log(`cannot read earlier runs for the memory context: ${error?.message ?? error}`)
    }

    if (!notes && !history) return null
    const parts = []
    if (history) parts.push('Earlier runs in this state directory (newest first):', history)
    if (notes) {
      parts.push(
        'Notes left by earlier runs and the operator (may be stale; verify before relying on them; correct a wrong '
        + 'one by writing a new entry with the same key):',
        notes,
      )
    }
    const digest = parts.join('\n\n').slice(0, 2600)
    return {
      digest,
      notes: noteCount,
      userNotes: userNoteCount,
      runs: runCount,
      digestChars: digest.length,
      scopes: ['rules', 'profile', settings.scope],
    }
  }

  /** A failure that a retry on another attempt or route can plausibly fix. */
  function looksTransient(text) {
    return /quota|rate.?limit|\b429\b|overload|capacity|timed?\s?out|timeout|unavailable|ECONNRESET|ETIMEDOUT|\b50[0234]\b/i
      .test(String(text ?? ''))
  }

  /** Extra rounds that retry failed subtasks automatically; 0 disables. */
  function selfHealRounds() {
    return clamp(config.autoResumeRounds ?? 1, 0, 3)
  }

  /**
   * Report why a run may not start another child, or null when it still can.
   * Both budgets are hard stops: they exist so a pathological goal cannot spend
   * quietly, so they are checked before a spawn rather than after.
   */
  function budgetStop(run) {
    const calls = spentCalls(run)
    const tokens = spentTokens(run)
    if (run.limits.maxModelCalls > 0 && calls >= run.limits.maxModelCalls) {
      return `model-call budget reached (${calls}/${run.limits.maxModelCalls} calls)`
    }
    if (run.limits.maxTokens > 0 && tokens >= run.limits.maxTokens) {
      return `token budget reached (${tokens}/${run.limits.maxTokens} tokens)`
    }
    return null
  }

  /**
   * Spawn one child under the run's abort signal and budget.
   * @param {object} run - live run record.
   * @param {object} rt - runtime entry.
   * @param {{ label: string, prompt: string, parent: object }} spec - child request.
   */
  async function spawn(run, rt, spec) {
    const blocked = budgetStop(run)
    if (blocked) {
      if (!rt.abortCause) rt.abortCause = 'budget'
      if (!run.error) run.error = blocked
      if (!rt.controller.signal.aborted) rt.controller.abort(new Error(blocked))
      throw new Error(`budget exceeded: ${blocked}; raise maxModelCallsPerRun or maxTokensPerRun if this was intended`)
    }
    // Counted before the child exists and persisted before it can spend, so a
    // crash cannot lose the only evidence of a model call.
    ensureCounters(run).spawns += 1
    await save(run)
    // runId lets the caller bind the child to this run's guard counters.
    return spawnAbortable({ ...spec, runId: run.id }, rt.controller.signal)
  }

  /**
   * Create one child, but stop waiting for it as soon as the run is aborted.
   *
   * A provider that queues activations can leave `startActivation` pending long
   * after the run was cancelled or ran out of time. Without this the run would
   * hang in planning/running while its heartbeat kept it looking alive, so no
   * recovery path could ever reclaim it. A child that appears after the abort is
   * disposed immediately instead of being left to spend.
   */
  function spawnAbortable(spec, signal) {
    const pending = spawnChild({ ...spec, signal })
    if (!signal) return pending
    if (signal.aborted) {
      pending.then(handle => disposeQuietly(handle), () => {})
      return Promise.reject(new Error('aborted'))
    }
    return new Promise((resolve, reject) => {
      let done = false
      const onAbort = () => {
        if (done) return
        done = true
        // The `pending` handler registered below disposes the handle if it
        // arrives late, so the child is not left spending in the background.
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(
        handle => {
          if (done) {
            disposeQuietly(handle)
            return
          }
          done = true
          signal.removeEventListener('abort', onAbort)
          resolve(handle)
        },
        error => {
          if (done) return
          done = true
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /**
   * Read one run for a tool call, turning the two failure modes a user can hit
   * into sentences instead of a null.
   * @param {string} runId - run identity.
   */
  async function loadRun(runId) {
    const run = await store.read(runId)
    if (run) return run
    const quarantined = store.corrupt?.get?.(runId)
    if (quarantined) {
      throw new Error(
        `state file for run ${runId} is not valid JSON, so the run cannot be read. `
        + `The original file was kept at ${quarantined}. Inspect it, then delete it; `
        + 'the run is skipped by superagent_list until you do.',
      )
    }
    throw new Error(`unknown run ${runId}; call superagent_list to see recorded run ids`)
  }

  /**
   * Mark runs left active by a previous host process as interrupted.
   *
   * A run that another live process owns is left completely alone: rewriting it
   * here would make two processes fight over the same file while the first one
   * keeps spending, and a later resume would then run everything twice.
   */
  async function recover() {
    await store.init()
    const recovered = []
    for (const run of await store.list()) {
      if (!ACTIVE_STATUSES.has(run.status)) {
        if (await hasCancelRequest(run.id)) await clearCancel(run.id)
        continue
      }
      if (runtime.has(run.id)) continue
      const verdict = await ownership(run)
      if (verdict.live) {
        log(`run ${run.id} is still owned (${verdict.basis}); leaving it running`)
        continue
      }
      reclaim(run, verdict, await hasCancelRequest(run.id))
      await save(run)
      await clearCancel(run.id)
      await releaseRunLock(run.id)
      recovered.push(run.id)
    }
    return recovered
  }

  /**
   * Fold one child's usage snapshot into the run. The snapshot is cumulative,
   * so the last read for a child replaces the earlier one instead of adding.
   * Called at start, on every heartbeat, and on success or failure, which is
   * why an unreadable log degrades to the spawn floor instead of to zero.
   */
  async function recordUsage(run, childId) {
    let usage = null
    try {
      usage = await readUsage(childId)
    } catch (error) {
      log(`cannot read usage for child ${childId}: ${error?.message ?? error}`)
    }
    if (!usage) {
      ensureCounters(run).unreadable[childId] = true
      return null
    }
    run.usageByChild = run.usageByChild ?? {}
    run.usageByChild[childId] = usage
    run.usage = sumUsage(Object.values(run.usageByChild))
    return usage
  }

  /** Refresh usage for children that are still running, from the heartbeat. */
  async function refreshUsage(run, rt) {
    const handles = [...rt.activations]
    for (const handle of handles) await recordUsage(run, handle.childId)
  }

  /**
   * Wait for a child result, but stop waiting when the run is aborted. Without
   * this a child that ignores its abort signal keeps the whole run open.
   */
  function abortable(promise, signal) {
    if (!signal) return promise
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        promise.catch(() => {})
        reject(new Error('aborted'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        value => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /**
   * Bound one planner attempt by wall-clock time and model calls.
   *
   * A planner that starts calling tools can loop for dozens of model calls
   * without ever returning a plan. Without a bound the whole run budget is
   * spent before an honest failure can be written; both limits therefore stop
   * the child and fail the attempt instead of letting it run on.
   */
  function guardPlannerAttempt(promise, { ms, budget, baseCalls, readCalls, onStop }) {
    if (!ms && !budget) return promise
    return new Promise((resolve, reject) => {
      let done = false
      let timer = null
      let poller = null
      const finish = () => {
        done = true
        if (timer) clearTimeout(timer)
        if (poller) clearInterval(poller)
      }
      const stop = error => {
        if (done) return
        finish()
        try {
          onStop?.(error)
        } catch {
          // Stopping the child is best effort; the attempt still fails.
        }
        reject(error)
      }
      if (ms) {
        timer = setTimeout(() => {
          const error = new Error(`planner attempt timed out after ${ms}ms`)
          error.code = 'planner-timeout'
          stop(error)
        }, ms)
      }
      if (budget) {
        // The child's usage file is the only live signal the host exposes, so
        // the budget is enforced by polling it rather than by asking the child.
        poller = setInterval(async () => {
          if (done) return
          let calls = 0
          try {
            calls = Number(await readCalls()) || 0
          } catch {
            return
          }
          if (done) return
          if (baseCalls + calls >= budget) {
            const error = new Error(
              `planner stopped at the model-call budget (${baseCalls + calls}/${budget} calls)`,
            )
            error.code = 'planner-budget'
            stop(error)
          }
        }, PLANNER_POLL_MS)
      }
      promise.then(
        value => {
          if (done) return
          finish()
          resolve(value)
        },
        error => {
          if (done) return
          finish()
          reject(error)
        },
      )
    })
  }

  async function disposeQuietly(handle) {
    if (!handle || typeof handle.dispose !== 'function') return
    try {
      await Promise.race([
        Promise.resolve().then(() => handle.dispose()),
        sleep(DISPOSE_MS),
      ])
    } catch (error) {
      log(`child dispose failed: ${error?.message ?? error}`)
    }
  }

  /**
   * The host's subagent service disappeared while this run was active, which
   * in practice means the host is shutting down. That is not a subtask
   * failure: the work never got a chance to run. Remember the cause so the run
   * settles as `interrupted` (resumable) instead of `failed`, and abort the
   * remaining children.
   */
  function markHostGone(rt, error) {
    if (rt.abortCause) return
    rt.abortCause = 'host-gone'
    if (!rt.controller.signal.aborted) {
      rt.controller.abort(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async function makePlan(run, parent, rt) {
    const goal = roundGoal(run)
    const carried = carriedEntries(run)
    let previous = ''
    let attempts = 0
    let lastReason = ''
    // Every planner call is recorded with its cost so a stuck plan can be
    // diagnosed from the run file instead of from the session archive.
    const plannerAttempts = []
    run.steps.planner = { childId: null, attempts: plannerAttempts }
    const callBudget = Number(config.plannerMaxModelCalls) > 0
      ? Math.trunc(Number(config.plannerMaxModelCalls))
      : 0
    const callsSpent = () => plannerAttempts.reduce((total, entry) => total + (entry.modelCalls ?? 0), 0)
    // A real planner occasionally answers with prose, a nested envelope, or a
    // reply truncated mid-JSON. One repair round with the broken reply quoted
    // back is cheap; inventing a single do-everything task is not.
    for (let round = 1; round <= 2; round++) {
      attempts = round
      const spent = callsSpent()
      if (callBudget > 0 && spent >= callBudget) {
        lastReason = `planner model-call budget reached (${spent}/${callBudget} calls)`
        log(`planner attempt ${round} not started: ${lastReason}`)
        break
      }
      let record = null
      const startedAt = now()
      try {
        const handle = await spawn(run, rt, {
          label: 'superagent-plan',
          prompt: round === 1
            ? plannerPrompt(goal, run.limits.maxSubtasks, run.memory?.digest ?? '', carried)
            : plannerRepairPrompt(goal, run.limits.maxSubtasks, run.memory?.digest ?? '', carried, previous),
          parent,
          // A planner only needs to read the prompt and answer with JSON. In a
          // host that declares a tool-less preset, this is what stops the child
          // from inheriting bash/edit tools and looping instead of planning.
          ...(config.plannerPreset ? { preset: config.plannerPreset } : {}),
          // Planning is one cheap JSON turn; a stronger model here can be worth
          // it even when workers stay on a fast route.
          ...(config.plannerModel ? { model: config.plannerModel } : {}),
          ...(config.plannerProvider ? { provider: config.plannerProvider } : {}),
        })
        // The planner prompt carried them, so record where they landed before
        // the run moves on; status must not claim they are still waiting.
        if (carried.length > 0 && markFollowupsApplied(carried, 'planner')) await save(run)
        rt.activations.add(handle)
        record = {
          attempt: round,
          childId: handle.childId,
          startedAt: new Date(startedAt).toISOString(),
          outcome: null,
          ms: null,
          modelCalls: null,
          tokens: null,
        }
        plannerAttempts.push(record)
        run.steps.planner.childId = handle.childId
        await save(run)
        try {
          const plannerMs = Number(config.plannerTimeoutSeconds) > 0
            ? Number(config.plannerTimeoutSeconds) * 1000
            : 0
          const result = await guardPlannerAttempt(abortable(handle.result, rt.controller.signal), {
            ms: plannerMs,
            budget: callBudget,
            baseCalls: spent,
            readCalls: async () => {
              const usage = await recordUsage(run, handle.childId)
              return usage?.modelCalls ?? 0
            },
            onStop: error => {
              log(`planner attempt ${round} stopped: ${error?.message ?? error}`)
              Promise.resolve(handle.dispose()).catch(() => {})
            },
          })
          if (!result || result.output === undefined) {
            // A disposed child can settle without a result; that is a failed
            // attempt with a reason, not a reason to read `output` of nothing.
            const error = new Error('planner attempt finished without a result')
            error.code = 'planner-empty'
            throw error
          }
          const text = textOf(result.output)
          previous = text
          const parsed = extractPlanObject(text)
          const subtasks = parsed.subtasks.slice(0, run.limits.maxSubtasks)
          const ambiguities = parsed.ambiguities ?? []
          // The planner is asked to list ambiguity before planning, but a
          // finding it then forgets must still be asked: merge it here instead
          // of trusting that needsInput stayed in sync.
          const needsInput = mergeAuditNeedsInput(parsed.needsInput, ambiguities)
          if (subtasks.length > 0) {
            if (parsed.repaired) log(`planner reply needed ${parsed.repaired}; recovered ${subtasks.length} subtask(s)`)
            record.outcome = 'planned'
            return {
              mode: 'planned',
              subtasks,
              needsInput,
              ...(parsed.repaired ? { repaired: parsed.repaired } : {}),
              ...(ambiguities.length > 0 ? { ambiguities } : {}),
            }
          }
          if (needsInput.length > 0) {
            // The planner refused to plan rather than guess. Starting a worker
            // anyway would recreate the behaviour this is meant to stop.
            record.outcome = 'needs-input'
            return {
              mode: 'needs-input',
              subtasks: [],
              needsInput,
              ...(ambiguities.length > 0 ? { ambiguities } : {}),
            }
          }
          record.outcome = 'unparsable'
          lastReason = `attempt ${round} replied with no parsable plan (${text.length} chars)`
          log(`planner reply on attempt ${round} had no parsable plan (${text.length} chars)`)
        } finally {
          const usage = await recordUsage(run, handle.childId)
          if (record) {
            record.ms = now() - startedAt
            record.modelCalls = usage?.modelCalls ?? null
            record.tokens = usage?.totalTokens ?? null
            record.outcome = record.outcome ?? 'no-plan'
            await save(run)
          }
          rt.activations.delete(handle)
          await disposeQuietly(handle)
        }
      } catch (error) {
        lastReason = error?.message ?? String(error)
        if (record) {
          record.outcome = error?.code ?? 'error'
          record.error = lastReason
        }
        log(`planner attempt ${round} failed: ${lastReason}`)
        if (error?.code === 'subagent-unavailable') {
          markHostGone(rt, error)
          break
        }
      }
    }
    // No fallback worker. A single "complete the goal" task looks like a plan
    // while dropping the ambiguity handling and capability preflight the plan
    // exists to enforce, so an unusable reply stops the run instead.
    return {
      mode: 'invalid',
      subtasks: [],
      needsInput: [],
      attempts,
      ...(lastReason ? { reason: lastReason } : {}),
      ...(previous ? { reply: capChars(previous, 1200) } : {}),
    }
  }

  async function runSubtask(run, subtask, parent, rt, { model = null } = {}) {
    const key = subtask.key ?? `w${subtask.index}`
    if (rt.cancelledSubtasks?.has(key)) {
      // A cancelled subtask stays cancelled: a retry pass, a self-heal round,
      // or the next graph tick must not quietly start it again.
      subtask.status = 'cancelled'
      subtask.finishedAt = subtask.finishedAt ?? new Date(now()).toISOString()
      subtask.cancelledAt = subtask.cancelledAt ?? subtask.finishedAt
      return
    }
    // The board can stop one subtask without stopping the run. Its own
    // controller is combined with the run's, so both reasons still abort this
    // child and only this child.
    const own = new AbortController()
    rt.subtaskAborts = rt.subtaskAborts ?? new Map()
    rt.subtaskAborts.set(key, own)
    const runSignal = rt.controller.signal
    const signal = typeof AbortSignal.any === 'function'
      ? AbortSignal.any([runSignal, own.signal])
      : runSignal
    for (let attempt = subtask.attempts + 1; attempt <= run.limits.attempts; attempt++) {
      if (signal.aborted) break
      subtask.status = 'running'
      subtask.attempts = attempt
      subtask.startedAt = subtask.startedAt ?? new Date(now()).toISOString()
      // An instruction that arrived after this subtask was queued reaches it
      // here, at the last moment before the prompt is built.
      const carried = carriedEntries(run)
      markFollowupsApplied(carried, `subtask-${subtask.index}`)
      await save(run)

      let handle = null
      // A retry reuses the checkout from the previous attempt, so work the
      // earlier attempt already wrote is not thrown away.
      const workspace = await openWorkspaceFor(run, subtask, parent)
      try {
        handle = await spawn(run, rt, {
          label: run.mode === 'direct' ? 'superagent-direct' : `superagent-${subtask.index}`,
          prompt: run.mode === 'direct'
            ? directPrompt(run, carried)
            : workerPrompt(run, subtask, workspace, carried),
          parent,
          model,
          // The worker's relative writes must land in the checkout the
          // deliverable check reads, not in the shared checkout.
          ...(workspace?.dir ? { cwd: workspace.dir } : {}),
          // The permission escalation and the audit trail are per plan entry;
          // this is the same identifier attention items use.
          subtaskId: `subtask-${subtask.index}`,
          requires: subtask.requires ?? [],
        })
        rt.activations.add(handle)
        subtask.childId = handle.childId
        await save(run)

        const result = await abortable(handle.result, signal)
        if (rt.cancelledSubtasks?.has(key) || own.signal.aborted) break
        const raw = textOf(result.output)
        subtask.stopReason = result.stopReason
        if (result.stopReason === 'completed' && raw) {
          // A worker may append one fenced block to ask for a decision. Strip it
          // before the report is stored: the delivered result must be the
          // findings, while the question becomes a structured attention item.
          const cleaned = extractAttentionBlock(raw)
          if (cleaned.found) {
            if (cleaned.attention) recordAttention(run, `subtask-${subtask.index}`, cleaned.attention)
            else recordAttentionIssue(run, `subtask-${subtask.index}`, cleaned.error)
            if (cleaned.error) log(`subtask ${subtask.index}: ${cleaned.error}`)
          }
          // A valid block is stripped; an unusable one stays in the worker result
          // so the report the user reads still contains what was asked.
          const text = cleaned.attention ? cleaned.text : raw
          // Completion is a claim about an artifact, not about the turn ending.
          // A declared file must exist, be non-empty, and match the kind the
          // plan declared; with no declaration the reply is the artifact, so it
          // must not be empty either.
          const verdict = await verifyDeliverables(run, subtask)
          if (verdict) {
            subtask.deliverables = verdict.items
            subtask.deliverableCheck = {
              at: verdict.at,
              checked: verdict.items.length,
              verified: verdict.items.filter(item => item.status === 'verified').length,
              failed: verdict.failed.length,
              misplaced: verdict.items.filter(item => item.code === 'misplaced').length,
              unverified: verdict.unverified.length,
            }
          }
          const problems = []
          if (verdict?.failed.length > 0) problems.push(...verdict.failed.map(item => item.reason))
          if (!verdict && !text.trim()) problems.push('the reply was empty and no deliverable was declared')
          if (problems.length > 0) {
            // A missing or wrong artifact is retryable: the next attempt may
            // still write what it promised. It is never counted as completed.
            subtask.error = `empty deliverable: ${problems.join('; ')}`
            log(`subtask ${subtask.index} attempt ${attempt} did not deliver: ${subtask.error}`)
          } else if (verdict?.unverified.length > 0) {
            // The file may be fine, but this session cannot judge it. Claiming
            // completion would be a guess, so the subtask stays out of the
            // completed count until a person or a capable tool checks it.
            subtask.status = 'unverified'
            subtask.unverifiedReason = verdict.unverified.map(item => item.reason).join('; ')
            subtask.result = capText(text, config.resultCapBytes)
            subtask.error = null
            subtask.finishedAt = new Date(now()).toISOString()
            await recordUsage(run, handle.childId)
            await save(run)
            log(`subtask ${subtask.index}: deliverable could not be verified: ${subtask.unverifiedReason}`)
            return
          } else {
            subtask.status = 'completed'
            subtask.result = capText(text, config.resultCapBytes)
            subtask.error = null
            subtask.finishedAt = new Date(now()).toISOString()
            await recordUsage(run, handle.childId)
            await harvestWorkspace(run, subtask)
            await save(run)
            return
          }
        } else {
          subtask.error = result.stopReason === 'completed' && !raw
            ? 'empty deliverable: the worker returned no text and declared no file'
            : result.diagnostic || `child stopped with reason "${result.stopReason}"`
          log(`subtask ${subtask.index} attempt ${attempt} did not complete: ${subtask.error}`)
        }
      } catch (error) {
        subtask.error = error?.message ?? String(error)
        log(`subtask ${subtask.index} attempt ${attempt} threw: ${subtask.error}`)
        if (error?.code === 'subagent-unavailable') {
          // The host is going away; leave the subtask as work to do rather
          // than burning the remaining attempts on a service that is gone.
          subtask.error = null
          subtask.stopReason = null
          markHostGone(rt, error)
        }
      } finally {
        if (handle) {
          // A failed attempt still spent tokens, so read it before disposing.
          await recordUsage(run, handle.childId)
          // Receipts are resolved while the inbox is still readable: a message
          // still waiting here never entered a prompt for this attempt.
          if (settleChildInjections(
            run,
            handle.childId,
            'the child finished its turn before the instruction reached another step boundary',
          )) await save(run)
          rt.activations.delete(handle)
          await disposeQuietly(handle)
        }
      }

      if (signal.aborted) break
      if (attempt < run.limits.attempts) {
        subtask.status = 'pending'
        await save(run)
        // Retrying a rate limit immediately burns the next attempt against the
        // same limit. A transient failure therefore waits 2s, 4s, 8s... while
        // any other failure keeps the short, existing delay: it may be fixed by
        // a different model answer rather than by time.
        const delay = looksTransient(subtask.error)
          ? Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1))
          : 1000 * attempt
        await sleep(delay)
      }
    }

    if (subtask.status !== 'completed') {
      if (rt.cancelledSubtasks?.has(key) || own.signal.aborted) {
        // The person stopped this subtask on purpose. It is neither a failure
        // nor resumable work: `cancelled` says exactly what happened.
        subtask.status = 'cancelled'
        subtask.error = null
        subtask.stopReason = 'cancelled'
        subtask.cancelledAt = new Date(now()).toISOString()
        subtask.finishedAt = subtask.cancelledAt
      } else if (signal.aborted) {
        // Cancelled or out of time: the subtask did not fail on its own terms,
        // so leave it resumable instead of recording a failure.
        subtask.status = 'pending'
        subtask.error = null
        subtask.stopReason = null
      } else {
        subtask.status = 'failed'
        subtask.finishedAt = new Date(now()).toISOString()
      }
      await save(run)
    }
  }

  /**
   * Run the subtask graph: a task starts as soon as every task it depends on has
   * completed, and at most `maxParallel` execute at once. A task that is only
   * held back by a dependency is marked `waiting` with the keys it waits for, so
   * status tells it apart from one that is actually running.
   *
   * A task whose dependency failed or was skipped is marked `skipped` with the
   * reason and never runs. Those skips are revived on the next call (self-heal,
   * resume) if the dependency completes then, so a retry can still unblock them.
   *
   * @param {object} run - live run record.
   * @param {object} parent - calling session.
   * @param {object} rt - runtime record with the abort controller.
   * @param {{ model?: string | null }} [options] - child model override.
   */
  async function runGraph(run, parent, rt, { model = null } = {}) {
    const signal = rt.controller.signal
    const byKey = new Map(run.subtasks.map(subtask => [subtask.key, subtask]))
    let revived = false
    for (const subtask of run.subtasks) {
      if (subtask.status === 'skipped' && subtask.skipKind === 'upstream') {
        subtask.status = 'pending'
        subtask.skipKind = null
        subtask.skippedReason = null
        subtask.waitingOn = []
        revived = true
      }
    }
    if (revived) await save(run)

    const inFlight = new Map()
    while (!signal.aborted) {
      let dirty = cascadeSkips(run, byKey)
      for (const subtask of run.subtasks) {
        if (signal.aborted) break
        if (subtask.status !== 'pending' && subtask.status !== 'waiting') continue
        if (inFlight.has(subtask.key)) continue
        const outstanding = (subtask.dependsOn ?? [])
          .map(key => byKey.get(key))
          .filter(dependency => dependency && dependency.status !== 'completed')
        if (outstanding.length > 0) {
          const waitingOn = outstanding.map(dependency => dependency.key)
          if (subtask.status !== 'waiting' || subtask.waitingOn.join() !== waitingOn.join()) {
            subtask.waitingOn = waitingOn
            if (subtask.status !== 'waiting') subtask.status = 'waiting'
            dirty = true
          }
          continue
        }
        if (subtask.status === 'waiting') {
          subtask.status = 'pending'
          subtask.waitingOn = []
          dirty = true
        }
        if (inFlight.size >= run.limits.maxParallel) break
        const task = runSubtask(run, subtask, parent, rt, { model })
          .catch(error => log(`subtask ${subtask.index} graph runner threw: ${error?.message ?? error}`))
          .finally(() => inFlight.delete(subtask.key))
        inFlight.set(subtask.key, task)
      }
      if (dirty) await save(run)
      // Nothing is executing, so nothing can finish and no dependency can clear.
      if (inFlight.size === 0) break
      await Promise.race(inFlight.values())
    }

    // Leaving a subtask as `waiting` after the graph stopped would claim it is
    // still held back by live work. An aborted run keeps it resumable instead.
    let leftover = false
    for (const subtask of run.subtasks) {
      if (subtask.status === 'waiting') {
        subtask.status = 'pending'
        subtask.waitingOn = []
        leftover = true
      }
    }
    if (leftover) await save(run)
  }

  async function aggregate(run, parent, rt) {
    const completed = run.subtasks.filter(subtask => subtask.status === 'completed')
    if (completed.length === 0) return null
    if (rt.controller.signal.aborted) return deterministicJoin(run)
    // One report needs no merging, but it does need a prompt when the user has
    // since added an instruction or answered a question: the shortcut would
    // return the old text and silently drop the decision.
    const hasInstructions = (run.followups ?? []).length > 0
    if (completed.length === 1 && !hasInstructions) return `# ${run.goal}\n\n${completed[0].result ?? ''}`.trim()

    try {
      // Instructions that arrived while the workers ran land here, and this is
      // the last boundary a terminal run has: the report can honor them even
      // when no worker will start again.
      const carried = carriedEntries(run)
      if (carried.length > 0 && markFollowupsApplied(carried, 'aggregator')) await save(run)
      const handle = await spawn(run, rt, {
        label: 'superagent-aggregate',
        prompt: aggregatorPrompt(run, completed, run.memory?.digest ?? '', carried, Boolean(userMemory)),
        parent,
      })
      rt.activations.add(handle)
      run.steps.aggregator = { childId: handle.childId }
      try {
        const result = await abortable(handle.result, rt.controller.signal)
        const text = textOf(result.output)
        if (result.stopReason === 'completed' && text) return text
        log(`aggregator did not complete (${result.stopReason}); using deterministic merge`)
      } finally {
        await recordUsage(run, handle.childId)
        rt.activations.delete(handle)
        await disposeQuietly(handle)
      }
    } catch (error) {
      log(`aggregator failed: ${error?.message ?? error}`)
      if (error?.code === 'subagent-unavailable') markHostGone(rt, error)
    }
    return deterministicJoin(run)
  }

  function terminalStatus(run, rt) {
    if (rt.abortCause === 'cancelled') return 'cancelled'
    // The host went away mid-run. Nothing failed on its own terms, so the run
    // must stay resumable instead of being buried as `failed`.
    if (rt.abortCause === 'host-gone') return 'interrupted'
    const subtasks = run.subtasks ?? []
    const completed = subtasks.filter(subtask => subtask.status === 'completed').length
    // A goal run is complete only when its acceptance step said so. Reaching a
    // limit or stalling leaves the work partial even when every subtask of the
    // last round finished: the goal, not the round, is what was started.
    if (run.goalMode) return run.goalMode.achieved ? 'completed' : (completed > 0 ? 'partial' : 'failed')
    // Everything that did not finish was either stopped on purpose or waiting
    // on something that was. Calling that "failed" would blame the person who
    // pressed stop, so the run reports the same word the subtask does.
    const cancelled = subtasks.filter(subtask => subtask.status === 'cancelled').length
    if (completed === 0 && cancelled > 0) {
      return subtasks.every(subtask => subtask.status === 'cancelled' || subtask.status === 'skipped')
        ? 'cancelled'
        : 'failed'
    }
    if (completed === 0) return 'failed'
    if (rt.abortCause === 'deadline') {
      return completed === subtasks.length ? 'completed' : 'partial'
    }
    return completed === subtasks.length ? 'completed' : 'partial'
  }

  /**
   * Watch for a cancel written by another process. The marker is checked from
   * inside the owning process, which is the only place that can abort children;
   * that is why cancel is a file and not a state-file rewrite.
   */
  function watchCancel(run, rt) {
    const timer = setInterval(() => {
      hasCancelRequest(run.id).then(requested => {
        if (!requested || rt.controller.signal.aborted) return
        rt.abortCause = 'cancelled'
        rt.controller.abort(new Error('cancelled by superagent_cancel from another process'))
        // Aborting the signal alone does not stop a child that is already
        // running; dispose its activation so it stops spending tokens.
        for (const handle of [...rt.activations]) disposeQuietly(handle)
      }).catch(() => {})
    }, CANCEL_POLL_MS)
    timer.unref?.()
    return timer
  }

  /**
   * A caller waiting inside this process will read the terminal result itself,
   * so waking the session would be duplicate noise. A caller in *another*
   * process is deliberately not treated this way: it can time out just before
   * the run settles, in which case suppressing the wake-up would lose the only
   * notification the user gets.
   */
  function watchedHere(rt) {
    return rt.waiters > 0
  }

  /**
   * Compute the terminal state, decide about notifying, and write it exactly
   * once. Writing the terminal status first and the notify outcome second left
   * a window where readers saw a finished run with no notify line at all.
   */
  async function settle(run, rt) {
    // Usage is stored per child so repeated reads replace rather than add. A
    // run written before that field existed keeps whatever total it had.
    const entries = Object.values(run.usageByChild ?? {})
    if (entries.length > 0) run.usage = sumUsage(entries)
    // The per-subtask figure is read when the child finishes, which can race a
    // log flush; the settle pass has the final snapshot, so publish it here.
    for (const subtask of run.subtasks ?? []) {
      if (subtask.childId && run.usageByChild?.[subtask.childId]) {
        subtask.usage = run.usageByChild[subtask.childId]
      }
    }
    applyCost(run, config.pricing)
    let nextStatus = terminalStatus(run, rt)
    const finishedAt = new Date(now()).toISOString()

    // An instruction that arrived in the last moments of a run never reached a
    // prompt. Record that instead of leaving it looking delivered: the user
    // has to know it did not shape anything.
    for (const entry of run.followups ?? []) {
      if (entry.appliedAt || entry.missedAt) continue
      entry.missedAt = finishedAt
      entry.missedReason = 'the run settled before another boundary ran; start a new run to apply it'
    }

    // A live injection has no boundary of its own: once the run is over, an
    // untouched receipt is a miss, and the queue that carried it is gone.
    let injectionsChanged = false
    for (const injection of run.injections ?? []) {
      for (const target of injection.targets ?? []) {
        if (target.status !== 'pending') continue
        stopWatch(run.id, injection.id, target.childId)
        finishInjectionTarget(run, target, 'missed', {
          reason: 'the run settled before the child reached another step boundary',
        })
        injectionsChanged = true
      }
    }
    if (injectionsChanged) refreshInjectionStats(run)

    // The aggregator appends a fenced notebook block to its report. Strip it in
    // every case so the user never sees plugin syntax, then persist it when the
    // notebook is enabled. A write failure is recorded on the run but never
    // allowed to fail the run itself: memory is an optimisation, not a result.
    if (typeof run.report === 'string' && run.report) {
      // An attention block is the aggregator's way of separating "here is the
      // outcome" from "you must decide this". It is stripped first, so the
      // report and the artifact never contain the fence.
      const attention = extractAttentionBlock(run.report)
      if (attention.found) {
        if (attention.attention) {
          run.report = attention.text
          recordAttention(run, 'aggregator', attention.attention)
        } else {
          // Keep the raw block in the report and record why it could not be used:
          // a malformed decision request is still a decision request.
          recordAttentionIssue(run, 'aggregator', attention.error)
        }
        if (attention.error) log(`run ${run.id}: ${attention.error}`)
      }
      const extracted = extractMemoryBlock(run.report)
      if (extracted.found) {
        // Assign even when the stripped report is empty: a report that was only
        // a notebook block must not survive into the user-facing result.
        run.report = extracted.report
        if (memory && TERMINAL_STATUSES.has(nextStatus)) {
          const settings = memorySettings()
          try {
            const result = await memory.write({
              scope: settings.scope,
              runId: run.id,
              entries: extracted.entries,
              maxEntries: settings.maxEntries,
              maxAgeDays: settings.maxAgeDays,
            })
            run.memoryWrite = {
              at: new Date(now()).toISOString(),
              written: result.written,
              reason: extracted.error ?? result.reason ?? null,
            }
          } catch (writeError) {
            log(`cannot write cross-run memory for run ${run.id}: ${writeError?.message ?? writeError}`)
            run.memoryWrite = {
              at: new Date(now()).toISOString(),
              written: 0,
              reason: `write failed: ${writeError?.message ?? writeError}`,
            }
          }
        } else if (extracted.error) {
          run.memoryWrite = { at: new Date(now()).toISOString(), written: 0, reason: extracted.error }
        }
      }
    }
    // The user-level profile has its own fence and its own lifetime. It is read
    // only when the layer is enabled, and a write failure is recorded rather
    // than escalated: like the run notebook, it must never fail the run.
    if (userMemory && TERMINAL_STATUSES.has(nextStatus) && typeof run.report === 'string' && run.report) {
      const block = extractUserMemoryBlock(run.report)
      if (block.found) {
        run.report = block.report
        try {
          const written = await userMemory.writeBlock({ runId: run.id, block: block.block })
          run.userMemoryWrite = {
            at: new Date(now()).toISOString(),
            written: written.fact + written.preference + written.decision,
            reason: block.error ?? null,
          }
        } catch (writeError) {
          log(`cannot write user-level memory for run ${run.id}: ${writeError?.message ?? writeError}`)
          run.userMemoryWrite = {
            at: new Date(now()).toISOString(),
            written: 0,
            reason: `write failed: ${writeError?.message ?? writeError}`,
          }
        }
      }
    }
    // The guard's event list belongs in the user-facing report, not only in the
    // status line: a blocked command is part of what happened during the run.
    const guardSection = guard?.reportSection?.(run.id)
    if (guardSection && typeof run.report === 'string' && run.report) {
      run.report = `${run.report.trimEnd()}\n\n${guardSection}`
    }
    // Stripping an attention-only or notebook-only reply can leave nothing
    // behind. A run that "completed" with no artifact is not a completion:
    // keep the evidence and downgrade it so a schedule does not report success
    // for an empty result.
    if (nextStatus === 'completed' && !String(run.report ?? '').trim()) {
      nextStatus = 'partial'
      run.error = run.error || 'the run produced an empty deliverable; an empty report is not a completion'
      log(`run ${run.id}: completed with an empty report; recorded as partial`)
    }
    // The report gets a durable address before the run is announced, so a
    // notification or status line can point at a file that already exists.
    if (TERMINAL_STATUSES.has(nextStatus)) await writeReportArtifact(run)
    addMilestone(run, 'settled')
    let error = run.error
    if (rt.abortCause === 'cancelled') {
      error = 'cancelled by superagent_cancel'
    } else if (rt.abortCause === 'host-gone') {
      error = 'the host shut down while this run was active; run superagent_resume in a new host to finish it'
    } else if (nextStatus === 'failed' && !error) {
      error = run.subtasks.map(subtask => subtask.error ?? subtask.skippedReason).filter(Boolean).slice(0, 3).join('; ')
        || 'no subtask completed'
    }
    if (rt.abortCause === 'deadline' && !error) error = 'deadline exceeded'

    let outcome = null
    if (TERMINAL_STATUSES.has(nextStatus)) {
      if (run.notifyMuted) {
        // A scheduled run is announced by the scheduler, which knows whether
        // this plan already woke the session about a failure. Waking the parent
        // here too would turn a half-hourly plan into half-hourly noise.
        outcome = { delivered: false, reason: 'muted: the run was started by a schedule; the scheduler reports its outcome' }
      } else if (watchedHere(rt)) {
        outcome = { delivered: false, reason: 'skipped: a caller in this process is reading the run' }
      } else {
        try {
          // `notify` may wait on the host's session loop; cap it so a finished
          // run cannot stay active on disk (and be reclaimed by another process)
          // just because a wake-up is slow.
          outcome = await withTimeout(
            Promise.resolve().then(() => notify({ ...run, status: nextStatus, finishedAt, error })),
            NOTIFY_MS,
            () => ({
              delivered: false,
              reason: `the owning session did not accept the wake-up within ${NOTIFY_MS / 1000}s`,
            }),
          )
          outcome = outcome ?? { delivered: true }
        } catch (notifyError) {
          outcome = { delivered: false, reason: `notification threw: ${notifyError?.message ?? notifyError}` }
          log(`notification failed for ${run.id}: ${notifyError?.message ?? notifyError}`)
        }
      }
    }

    // The terminal status and its notify row land in the same write, so a
    // reader never sees a finished run that still claims to be active and never
    // sees a finished run whose notify row is missing.
    run.status = nextStatus
    run.finishedAt = finishedAt
    run.activeMs = (Number.isFinite(run.activeMs) ? run.activeMs : 0) + Math.max(0, now() - rt.activeStart)
    run.error = error
    run.cancelPending = false
    if (outcome) {
      run.notify = {
        at: new Date(now()).toISOString(),
        delivered: outcome.delivered !== false,
        reason: outcome.reason ?? null,
      }
      if (outcome.delivered !== false) run.notified = true
    }
    await save(run)
    // Awaited: the trail must contain the outcome before the run is published
    // as terminal, or a crash right here would leave a finished run with no
    // record of how it finished. A failure is still only logged.
    await auditRecord({
      runId: run.id,
      actor: `session:${run.parentSessionId}`,
      kind: 'run.finish',
      action: 'settle',
      target: oneLine(run.goal, 200),
      result: nextStatus,
      durationMs: run.activeMs,
      meta: {
        subtasks: run.subtasks.length,
        completed: run.subtasks.filter(subtask => subtask.status === 'completed').length,
        attention: Boolean(run.attention?.items?.length),
        error: error ? oneLine(error, 300) : null,
      },
    })
    // The run is terminal, so a leftover marker would only make the next mount
    // rewrite a finished run; drop it now.
    await clearCancel(run.id)
    await releaseRunLock(run.id)
  }

  /**
   * Resolve with `promise`, or with `onTimeout()` after `ms`.
   *
   * The timer is cleared when the promise wins: a stray 15s timer would keep a
   * finished host process (and a test runner) alive for no reason.
   */
  function withTimeout(promise, ms, onTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(onTimeout()), ms)
      timer.unref?.()
      promise.then(
        value => {
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  /** One subtask record, shared by the planned pipeline and direct mode. */
  function makeSubtask(entry, index) {
    return {
      index: index + 1,
      title: entry.title,
      prompt: entry.prompt,
      requires: Array.isArray(entry.requires) ? entry.requires : [],
      deliverables: Array.isArray(entry.deliverables) ? entry.deliverables : [],
      assumptions: Array.isArray(entry.assumptions) ? entry.assumptions : [],
      deliverableCheck: null,
      status: 'pending',
      attempts: 0,
      childId: null,
      stopReason: null,
      error: null,
      result: null,
      usage: null,
      startedAt: null,
      finishedAt: null,
    }
  }

  /**
   * Compare each subtask's declared capabilities with the tools the calling
   * session actually has. A missing capability blocks that subtask before a
   * worker is spawned and is never counted as a success.
   *
   * When the host cannot list its tools, the preflight says so and does not
   * block: guessing an inventory would either stop work that could run or
   * promise a capability that does not exist.
   *
   * @param {object} run - live run record.
   * @param {object} parent - calling session.
   */
  async function preflightCapabilities(run, parent) {
    const candidates = run.subtasks.filter(subtask =>
      subtask.status === 'pending' || subtask.status === 'waiting' || subtask.status === 'blocked')
    if (!candidates.some(subtask => (subtask.requires ?? []).length > 0)) {
      run.preflight = { at: new Date(now()).toISOString(), status: 'no-requirements', blocked: 0 }
      await save(run)
      return
    }
    const unavailable = async reason => {
      run.preflight = {
        at: new Date(now()).toISOString(),
        status: 'unavailable',
        blocked: 0,
        reason,
      }
      await save(run)
      log(`capability preflight skipped: ${reason}`)
    }
    if (typeof toolInventory !== 'function') {
      await unavailable('the host did not expose a tool inventory')
      return
    }
    let tools
    try {
      tools = await toolInventory(parent)
    } catch (error) {
      await unavailable(`the host tool inventory could not be read (${error?.message ?? error})`)
      return
    }
    if (!Array.isArray(tools)) {
      await unavailable('the host did not expose a tool inventory')
      return
    }
    const inventory = [...new Set(tools.filter(name => typeof name === 'string' && name.length > 0))]
    let changed = false
    for (const subtask of candidates) {
      const gaps = capabilityGaps(subtask.requires ?? [], inventory)
      if (gaps.length > 0) {
        if (subtask.status !== 'blocked' || (subtask.missingCapabilities ?? []).join() !== gaps.join()) {
          changed = true
        }
        subtask.status = 'blocked'
        subtask.blockKind = 'capability'
        subtask.missingCapabilities = gaps
        subtask.blockedReason = `missing ${gaps.join(', ')} capability; not started`
        subtask.waitingOn = []
      } else if (subtask.status === 'blocked') {
        // A resume in a session that now has the tool may still run this work.
        subtask.status = 'pending'
        subtask.blockKind = null
        subtask.missingCapabilities = []
        subtask.blockedReason = null
        changed = true
      }
    }
    const blocked = candidates.filter(subtask => subtask.status === 'blocked')
    run.preflight = {
      at: new Date(now()).toISOString(),
      status: 'checked',
      toolCount: inventory.length,
      blocked: blocked.length,
    }
    await save(run)
    if (blocked.length > 0) {
      log(
        `capability preflight: ${blocked.length}/${candidates.length} subtask(s) blocked; `
        + blocked.map(subtask => `${subtask.key} needs ${subtask.missingCapabilities.join(', ')}`).join('; ')
        + ` (${inventory.length} tool(s) available)`,
      )
    } else {
      log(`capability preflight: every declared capability is covered by ${inventory.length} tool(s)`)
    }
    if (changed) await save(run)
  }

  /** Deterministic report for a planner that stopped to ask instead of guessing. */
  function needsInputReport(run) {
    const lines = [
      `# ${run.goal}`,
      '',
      'No worker was started: the planner needs answers before it can plan this safely.',
      '',
      '## Questions',
      '',
    ]
    for (const item of run.plan?.needsInput ?? []) {
      lines.push(`- ${item.question}${item.reason ? ` — ${item.reason}` : ''}`)
    }
    const ambiguities = run.plan?.ambiguities ?? []
    if (ambiguities.length > 0) {
      lines.push('', '## Wording it refused to guess at', '')
      for (const item of ambiguities) lines.push(`- "${item.phrase}"${item.why ? ` — ${item.why}` : ''}`)
    }
    return lines.join('\n').trim()
  }

  /** Deterministic report when the planner never produced a usable plan. */
  function invalidPlanReport(run) {
    const lines = [
      `# ${run.goal}`,
      '',
      'No worker was started: the planner did not return a plan this run could execute.',
      '',
      `- The reply was not a JSON object with a "subtasks" array (${run.plan?.attempts ?? 1} attempt(s), `
        + 'including one repair round where the unusable reply was quoted back).',
      ...(run.plan?.invalidReason ? [`- Last planner attempt: ${run.plan.invalidReason}`] : []),
      '- The goal was deliberately not handed to a fallback "complete the goal" worker: that would skip the '
        + 'ambiguity questions and the capability preflight, which is how a run spends tokens on work it cannot do.',
      '',
      '## What to do',
      '',
      '- Retry the run, or split the goal into one task per line so each part can be planned and checked separately.',
      '- If part of the goal is unclear, say what each name or phrase refers to; the planner will ask instead of '
        + 'guessing when it can parse the request.',
    ]
    if (run.plan?.invalidReply) {
      lines.push('', '## Start of the reply that could not be parsed', '', '```text', run.plan.invalidReply, '```')
    }
    return lines.join('\n').trim()
  }

  /** Deterministic report for a plan that cannot start at all. */
  function capabilityGapReport(run) {
    const blocked = run.subtasks.filter(subtask => subtask.status === 'blocked')
    const lines = [
      `# ${run.goal}`,
      '',
      'No worker was started: every planned subtask needs a capability this session does not have.',
      '',
      '## Capability gaps',
      '',
    ]
    for (const subtask of blocked) {
      const gaps = subtask.missingCapabilities ?? []
      lines.push(`- **${subtask.key} — ${subtask.title}**: needs ${gaps.join(', ')}`)
      for (const suggestion of new Set(gaps.map(capabilitySuggestion))) lines.push(`  - ${suggestion}`)
    }
    const needsInput = run.plan?.needsInput ?? []
    if (needsInput.length > 0) {
      lines.push('', '## Input needed from you', '')
      for (const item of needsInput) {
        lines.push(`- ${item.question}${item.reason ? ` — ${item.reason}` : ''}`)
      }
    }
    const assumed = run.subtasks.filter(subtask => (subtask.assumptions ?? []).length > 0)
    if (assumed.length > 0) {
      lines.push('', '## Assumptions the planner recorded', '')
      for (const subtask of assumed) {
        for (const assumption of subtask.assumptions) lines.push(`- ${subtask.key}: ${assumption}`)
      }
    }
    return lines.join('\n').trim()
  }

  /** Planner, parallel workers, self-heal, then one merged report. */
  async function runPlanned(run, parent, rt) {
    if (!Array.isArray(run.subtasks) || run.subtasks.length === 0) {
      run.status = 'planning'
      await save(run)
      const plan = await makePlan(run, parent, rt)
      run.plan = {
        mode: plan.mode,
        subtasks: plan.subtasks,
        ...(plan.needsInput?.length > 0 ? { needsInput: plan.needsInput } : {}),
        ...(plan.ambiguities?.length > 0 ? { ambiguities: plan.ambiguities } : {}),
        ...(plan.repaired ? { repaired: plan.repaired } : {}),
        ...(plan.mode === 'invalid' ? { attempts: plan.attempts ?? 1 } : {}),
        ...(plan.mode === 'invalid' && plan.reason ? { invalidReason: plan.reason } : {}),
      }
      if (plan.mode === 'invalid') {
        // The host going away is not the planner's fault; leave the run
        // resumable instead of recording an unusable plan.
        if (rt.abortCause === 'host-gone') {
          await save(run)
          return
        }
        run.plan.invalidReply = plan.reply ? capChars(plan.reply, 600) : null
        run.report = invalidPlanReport(run)
        run.error = `planner did not return a usable plan after ${plan.attempts ?? 1} attempt(s); `
          + 'no worker was started'
          + (plan.reason ? ` (${plan.reason})` : '')
        addMilestone(run, 'plan_invalid')
        await save(run)
        log(`${run.error}; the goal was not handed to a fallback worker`)
        return
      }
      // Replanning after an answer must not pile up the same questions.
      if (Array.isArray(run.attention?.items)) {
        run.attention.items = run.attention.items.filter(item => item.source !== 'planner')
      }
      // A question the planner would not answer by guessing is a question for
      // the user, not something the workers may quietly decide.
      for (const item of plan.needsInput ?? []) {
        recordAttention(run, 'planner', {
          question: item.question,
          options: item.options ?? [],
          reason: item.reason ?? 'the planner could not resolve this from the goal without guessing',
        })
      }
      const entries = plan.subtasks.map((entry, index) => ({
        key: entry.id ?? `w${index + 1}`,
        title: entry.title,
        dependsOn: entry.dependsOn ?? [],
      }))
      const keys = new Set(entries.map(entry => entry.key))
      if (keys.size !== entries.length) {
        throw new Error(
          'plan rejected: duplicate subtask ids; dependsOn would be ambiguous, so replan with unique ids',
        )
      }
      const linked = linkSubtasks(entries)
      if (linked.cycle) {
        // A cycle cannot be scheduled, and picking an arbitrary edge to drop
        // would change what the planner asked for. Reject the plan and name
        // the tasks involved so the next attempt can be fixed.
        throw new Error(
          `plan rejected: dependency cycle ${linked.cycle.join(' -> ')}; `
          + 'no subtask was started, so replan without the cycle',
        )
      }
      run.subtasks = plan.subtasks.map((entry, index) => {
        const key = entries[index].key
        const missing = linked.unknown.get(key) ?? []
        return {
          ...makeSubtask(entry, index),
          key,
          dependsOn: linked.edges.get(key) ?? [],
          waitingOn: [],
          status: missing.length > 0 ? 'skipped' : 'pending',
          skipKind: missing.length > 0 ? 'missing' : null,
          skippedReason: missing.length > 0
            ? `depends on unknown subtask ${missing.map(ref => `"${ref}"`).join(', ')}`
            : null,
        }
      })
      await save(run)
      addMilestone(run, 'plan_ready')
      await save(run)
    }

    if (run.subtasks.length === 0 && (run.plan?.needsInput?.length ?? 0) > 0) {
      run.report = needsInputReport(run)
      run.error = `planner needs input before it can plan: ${run.plan.needsInput[0].question}`
      addMilestone(run, 'needs_input')
      await save(run)
      log(`planner stopped before any worker started: ${run.error}`)
      return
    }

    // Check declared capabilities against the tools this session really has
    // before spending a single worker token on work that cannot run.
    await preflightCapabilities(run, parent)
    const blockedNow = run.subtasks.filter(subtask => subtask.status === 'blocked')
    const openNow = run.subtasks.filter(subtask => subtask.status !== 'completed')
    if (blockedNow.length > 0 && openNow.length === blockedNow.length) {
      run.report = capabilityGapReport(run)
      run.error = `no worker started: every planned subtask needs a capability this session lacks `
        + `(${[...new Set(blockedNow.flatMap(subtask => subtask.missingCapabilities ?? []))].join(', ')})`
      addMilestone(run, 'preflight_blocked')
      await save(run)
      log(`capability preflight stopped the run before any worker started: ${run.error}`)
      return
    }

    const open = run.subtasks.filter(subtask => subtask.status !== 'completed')
    if (open.length > 0) {
      run.status = 'running'
      addMilestone(run, 'running')
      await save(run)
      await runGraph(run, parent, rt)
    }

    // Self-heal before reporting: a failed subtask gets another full round
    // while the run is not aborted and the budget still allows it. A failure
    // that looks transient (quota, rate limit, timeout) may switch to the
    // configured fallback child model on that round. Only what still fails
    // after this is reported to the user, with what was tried.
    const rounds = selfHealRounds()
    const fallbackModel = typeof config.childModelFallback === 'string' && config.childModelFallback.trim()
      ? config.childModelFallback.trim()
      : null
    for (let round = 1; round <= rounds; round++) {
      if (rt.controller.signal.aborted) break
      // Only a failure that looks transient is retried as a whole round.
      // Re-running a refusal or a permanent error would double the spend
      // without changing the outcome, which is the opposite of self-healing.
      const retryable = run.subtasks.filter(subtask => subtask.status === 'failed' && looksTransient(subtask.error))
      if (retryable.length === 0) break
      if (budgetStop(run)) {
        log(`not retrying ${retryable.length} failed subtask(s): ${budgetStop(run)}`)
        break
      }
      const useFallback = Boolean(fallbackModel && retryable.some(subtask => looksTransient(subtask.error)))
      run.selfHeal = {
        rounds: round,
        retried: retryable.length,
        recovered: 0,
        model: useFallback ? fallbackModel : null,
      }
      for (const subtask of retryable) {
        subtask.status = 'pending'
        subtask.attempts = 0
        subtask.error = null
        subtask.stopReason = null
        subtask.finishedAt = null
      }
      log(
        `self-heal round ${round}: retrying ${retryable.length} failed subtask(s)`
        + (useFallback ? ` on ${fallbackModel}` : ''),
      )
      await save(run)
      // The graph re-runs the retried task and revives the downstream tasks
      // that were skipped because of it, in dependency order.
      await runGraph(run, parent, rt, { model: useFallback ? fallbackModel : null })
      run.selfHeal.recovered = retryable.filter(subtask => subtask.status === 'completed').length
      await save(run)
    }

    if (run.subtasks.some(subtask => subtask.status === 'completed') && !rt.controller.signal.aborted) {
      run.status = 'aggregating'
      addMilestone(run, 'aggregating')
      await save(run)
      run.report = await aggregate(run, parent, rt)
    } else if (!run.report) {
      run.report = deterministicJoin(run)
    }
  }

  /**
   * Direct mode: one worker does the whole goal. There is no planner and no
   * aggregator, so the child's reply becomes the report verbatim; the run
   * record, quota, deadline, cancel, budget, and usage accounting are the same
   * as for a planned run.
   */
  async function runDirect(run, parent, rt) {
    if (!Array.isArray(run.subtasks) || run.subtasks.length === 0) {
      const entry = { title: 'Complete the goal', prompt: run.goal }
      run.plan = { mode: 'direct', subtasks: [entry] }
      run.subtasks = [makeSubtask(entry, 0)]
      await save(run)
    }
    const subtask = run.subtasks.find(item => item.status !== 'completed') ?? run.subtasks[run.subtasks.length - 1]
    if (subtask && subtask.status !== 'completed') {
      run.status = 'running'
      addMilestone(run, 'running')
      await save(run)
      await runSubtask(run, subtask, parent, rt)
    }
    if (subtask?.status === 'completed') run.report = subtask.result ?? null
    else if (!run.report) run.report = deterministicJoin(run)
  }

  /**
   * A limit that can be read between rounds. `needs-decision` comes first:
   * spending another round while a question is open would ask the model to guess
   * the answer the human was asked for. A stall is checked before the round
   * count so the report names the more specific reason.
   */
  function goalHardStop(run, { assessment = null, failures = [] } = {}) {
    const goalMode = run.goalMode
    const open = (run.attention?.items ?? []).filter(item => !item.answer)
    if (open.length > 0) {
      return { reason: 'needs-decision', detail: oneLine(open[0].question, 200) }
    }
    const blocked = budgetStop(run)
    if (blocked) return { reason: 'budget', detail: blocked }
    const started = Date.parse(goalMode.startedAt ?? '')
    const elapsed = Number.isFinite(started) ? now() - started : 0
    if (elapsed >= goalMode.maxWallClockMinutes * 60000) {
      return {
        reason: 'wall-clock',
        detail: `${Math.round(elapsed / 60000)} of ${goalMode.maxWallClockMinutes} minute(s) used`,
      }
    }
    if (assessment?.stalled) {
      return {
        reason: assessment.stalled,
        detail: assessment.stalled === 'no-changes'
          ? 'the round left the workspace unchanged'
          : `${failures.map(item => item.id).join(', ')} failed ${assessment.streak} round(s) in a row`,
      }
    }
    if ((goalMode.rounds ?? []).length - (goalMode.roundBase ?? 0) >= goalMode.maxRounds) {
      return { reason: 'rounds', detail: `maxRounds is ${goalMode.maxRounds}` }
    }
    return null
  }

  /**
   * Execute one round: plan or run direct, then judge the acceptance conditions.
   *
   * A round starts from an empty subtask list, so the planner sees the previous
   * failure and can choose a different decomposition instead of replaying the
   * old plan. `roundGoal` puts that feedback in the planner, worker, direct, and
   * aggregator prompts.
   */
  async function runGoalRound(run, parent, rt) {
    const goalMode = run.goalMode
    const roundNumber = goalMode.rounds.length + 1
    const startedAt = new Date(now()).toISOString()
    const machineChecked = hasMachineChecks(goalMode)
    const before = machineChecked ? await fingerprintWorkspace(goalMode.cwd).catch(() => null) : null

    run.subtasks = []
    run.plan = null
    run.selfHeal = null
    run.report = null
    run.status = 'running'
    addMilestone(run, `goal_round_${roundNumber}`)
    await save(run)

    if (run.mode === 'direct') await runDirect(run, parent, rt)
    else await runPlanned(run, parent, rt)

    const roundReport = run.report
    const subtasks = run.subtasks ?? []
    const completed = subtasks.filter(subtask => subtask.status === 'completed').length
    if (rt.controller.signal.aborted) {
      goalMode.stop = {
        reason: 'aborted',
        detail: `the run stopped during round ${roundNumber} (${rt.abortCause ?? 'cancelled'})`,
        at: new Date(now()).toISOString(),
        round: roundNumber,
      }
      return
    }

    // The machine part runs whatever the judge will say, so the verdict rests on
    // exit codes even when the model also has to answer for other conditions.
    const checks = await runChecks(goalMode, { signal: rt.controller.signal })
    const failedChecks = () => checks.filter(check => check.ok === false).map(check => ({
      id: check.id,
      text: check.text,
      source: check.source,
      why: check.detail ?? 'the condition did not hold',
    }))

    let verdictNext = null
    const open = (run.attention?.items ?? []).filter(item => !item.answer)
    if (open.length === 0) {
      const judged = checks.filter(check => check.source === 'model')
      if (judged.length > 0) {
        const round = { round: roundNumber, report: roundReport, checks }
        let verdict = null
        try {
          const handle = await spawn(run, rt, {
            label: 'superagent-accept',
            prompt: verifierPrompt(run, round, checks),
            parent,
          })
          rt.activations.add(handle)
          run.steps.goalAcceptance = { round: roundNumber, childId: handle.childId }
          try {
            const result = await abortable(handle.result, rt.controller.signal)
            verdict = parseVerdict(textOf(result.output))
          } finally {
            await recordUsage(run, handle.childId)
            rt.activations.delete(handle)
            await disposeQuietly(handle)
          }
        } catch (error) {
          verdict = { verdict: null, error: `the acceptance judge failed: ${error?.message ?? error}` }
        }
        if (verdict.error) {
          // The judge failing is not the work failing, but the loop cannot call
          // an unjudged condition met either. The report says which happened.
          for (const check of judged) {
            check.ok = false
            check.detail = verdict.error
          }
        } else if (verdict.verdict.achieved) {
          for (const check of judged) {
            check.ok = true
            check.detail = 'met, judged from the round report'
          }
          verdictNext = verdict.verdict.next
        } else {
          const byId = new Map(verdict.verdict.failed.map(entry => [entry.id, entry.why]))
          for (const check of judged) {
            check.ok = false
            check.detail = byId.get(check.id)
              ?? verdict.verdict.next
              ?? 'judged not met from the round report'
          }
          verdictNext = verdict.verdict.next
        }
      }
    }

    const failures = failedChecks()
    const achieved = failures.length === 0 && checks.length > 0
    const after = machineChecked ? await fingerprintWorkspace(goalMode.cwd).catch(() => null) : null
    const changed = before === null || after === null ? null : before !== after
    const assessment = assessRound({
      previous: goalMode.rounds.at(-1) ?? null,
      failed: failures,
      changed,
      machineChecked,
      noProgressRounds: goalMode.noProgressRounds,
    })
    goalMode.rounds.push({
      round: roundNumber,
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      subtasks: { total: subtasks.length, completed },
      checks,
      changed,
      failed: failures,
      failedSignature: assessment.signature,
      streak: assessment.streak,
      achieved,
      next: verdictNext,
      report: capText(roundReport ?? '', 4000),
    })
    run.recovery = null

    if (achieved) {
      goalMode.achieved = true
      goalMode.nextInstruction = null
      await save(run)
      return
    }
    const stop = goalHardStop(run, { assessment, failures })
    if (stop) {
      goalMode.stop = { ...stop, at: new Date(now()).toISOString(), round: roundNumber }
      await save(run)
      return
    }
    goalMode.nextInstruction = buildRoundInstruction(roundNumber, failures, verdictNext)
    await save(run)
  }

  /**
   * Goal mode: run rounds until the acceptance conditions hold or a hard stop
   * decides a human is needed. Only the final settle notifies, so every round
   * between the first and the last is silent by construction.
   */
  async function runGoalLoop(run, parent, rt) {
    const goalMode = run.goalMode
    goalMode.rounds = Array.isArray(goalMode.rounds) ? goalMode.rounds : []
    goalMode.stop = null
    goalMode.achieved = false
    goalMode.startedAt = new Date(now()).toISOString()
    goalMode.cwd = goalMode.cwd ?? process.cwd()
    goalMode.roundBase = Number.isFinite(goalMode.roundBase) ? goalMode.roundBase : 0
    while (!rt.controller.signal.aborted) {
      const stop = goalHardStop(run)
      if (stop) {
        goalMode.stop = { ...stop, at: new Date(now()).toISOString(), round: goalMode.rounds.length }
        break
      }
      await runGoalRound(run, parent, rt)
      if (goalMode.achieved || goalMode.stop) break
    }
    if (!goalMode.stop && !goalMode.achieved && rt.controller.signal.aborted) {
      goalMode.stop = {
        reason: 'aborted',
        detail: `the run stopped before the goal was reached (${rt.abortCause ?? 'cancelled'})`,
        at: new Date(now()).toISOString(),
        round: goalMode.rounds.length,
      }
    }
    goalMode.nextInstruction = null
    run.report = composeGoalReport(run)
    await save(run)
  }

  async function execute(run, parent, rt) {
    rt.activeStart = now()
    const remaining = Math.max(0, Date.parse(run.deadlineAt) - now())
    const timer = setTimeout(() => {
      rt.abortCause = 'deadline'
      rt.controller.abort(new Error(`deadline exceeded after ${run.limits.deadlineMinutes} minutes`))
    }, remaining)
    timer.unref?.()
    const cancelTimer = watchCancel(run, rt)
    // The heartbeat is what makes an orphan detectable after a crash on a
    // machine whose pids this process cannot check (shared state directory).
    const beat = setInterval(() => {
      run.heartbeatAt = new Date(now()).toISOString()
      run.ownerPid = process.pid
      refreshUsage(run, rt).then(() => save(run)).catch(() => {})
    }, HEARTBEAT_MS)
    beat.unref?.()

    try {
      ensureCounters(run)
      // Decided once, before any child runs, so the whole plan uses one mode and
      // status can already say whether isolation is on.
      await ensureWorkspace(run, parent)
      if (run.goalMode) {
        try {
          await runGoalLoop(run, parent, rt)
        } catch (error) {
          // Hitting the model-call or token budget aborts the controller inside
          // `spawn`. A goal run reports that as its stop reason instead of
          // turning a cap the caller set into an unexplained failure.
          if (rt.abortCause !== 'budget') throw error
          run.goalMode.stop = {
            reason: 'budget',
            detail: run.error ?? oneLine(error?.message, 300),
            at: new Date(now()).toISOString(),
            round: run.goalMode.rounds?.length ?? 0,
          }
          run.report = composeGoalReport(run)
          await save(run)
        }
      } else if (run.mode === 'direct') await runDirect(run, parent, rt)
      else await runPlanned(run, parent, rt)

      // Merge before the report: a conflict is part of what happened, and the
      // report is written from the run, so it must exist by now. A run that
      // stopped early keeps its branches instead of merging half-finished work;
      // a resume picks the same worktrees up again. Direct mode has a single
      // worker, but it is isolated the same way, so it merges here too.
      if (run.workspace?.mode === 'git-worktree') {
        if (rt.controller.signal.aborted) {
          run.workspace.deferred = 'the run stopped before merging; the worker branches are kept for a resume'
          await save(run)
        } else {
          await mergeWorkspaces(run)
        }
      }
    } catch (error) {
      run.error = error?.message ?? String(error)
      log(`run ${run.id} failed: ${run.error}`)
      // Stop any child still running; without this the run would end while its
      // subtasks keep burning tokens.
      rt.controller.abort(error instanceof Error ? error : new Error(String(error)))
    } finally {
      clearTimeout(timer)
      clearInterval(cancelTimer)
      // The heartbeat keeps running until the terminal write lands: waking the
      // session can take a few seconds, and a frozen heartbeat during that
      // window would let another process treat a live run as orphaned.
      try {
        await settle(run, rt)
      } catch (error) {
        // Never leave a run active because finalizing it threw.
        log(`cannot finalize run ${run.id}: ${error?.message ?? error}`)
        if (ACTIVE_STATUSES.has(run.status)) {
          run.status = 'failed'
          run.finishedAt = run.finishedAt ?? new Date(now()).toISOString()
          run.error = run.error ?? `finalizing the run failed: ${error?.message ?? error}`
        }
        try {
          await store.write(run)
        } catch (writeError) {
          log(`cannot persist the terminal state of run ${run.id}: ${writeError?.message ?? writeError}`)
        }
        await releaseRunLock(run.id)
      } finally {
        clearInterval(beat)
      }
    }
  }

  function schedule(run, parent) {
    run.ownerPid = process.pid
    run.ownerHost = os.hostname()
    run.heartbeatAt = new Date(now()).toISOString()
    const rt = {
      controller: new AbortController(),
      activations: new Set(),
      // Per-subtask stop buttons: a board cancel aborts only its own child,
      // while `cancelledSubtasks` stops a retry from starting it again.
      subtaskAborts: new Map(),
      cancelledSubtasks: new Set(),
      waiters: 0,
      run,
      promise: null,
      abortCause: null,
    }
    runtime.set(run.id, rt)
    rt.promise = execute(run, parent, rt)
      .catch(async error => {
        log(`run ${run.id} crashed: ${error?.message ?? error}`)
        if (!ACTIVE_STATUSES.has(run.status)) return
        run.status = 'failed'
        run.finishedAt = new Date(now()).toISOString()
        run.error = error?.message ?? String(error)
        try {
          await store.write(run)
        } catch (writeError) {
          log(`cannot persist the crash state of run ${run.id}: ${writeError?.message ?? writeError}`)
        }
        await releaseRunLock(run.id)
      })
      .then(() => {
        // Finished runs are read from disk from now on; keeping them here would
        // grow these maps for the lifetime of the host.
        stopRunWatches(run.id)
        runtime.delete(run.id)
        saveChains.delete(run.id)
        // The slot this run held may let a waiting run start.
        pumpQueue().catch(() => {})
      })
    return rt
  }

  /** Serialize starts and resumes so a quota check cannot interleave. */
  function serialize(task) {
    const result = startGate.then(task, task)
    startGate = result.catch(() => {})
    return result
  }

  async function start({
    goal,
    parentSessionId,
    parent,
    clientTimeZone,
    overrides = {},
    allowDuplicate = false,
    queue: wantsQueue = false,
    mode: requestedMode,
    approvePolicy = false,
    goalMode: requestedGoalMode = null,
    origin = null,
    reserveSlot = false,
    muted = false,
  }) {
    const trimmed = typeof goal === 'string' ? goal.trim() : ''
    if (!trimmed) throw new Error('goal is required')
    if (!parent || typeof parent !== 'object') throw new Error('superagent requires a live parent agent')
    const mode = normalizeMode(requestedMode)
    // Off unless the caller asks for it: a start with no goal spec behaves
    // exactly as it did before goal mode existed.
    const goalSpec = requestedGoalMode === null || requestedGoalMode === undefined
      ? null
      : normalizeGoalSpec(requestedGoalMode)
    // A goal budget can only narrow the operator's cap, exactly like the other
    // overrides, and it is kept so a resume spends against the same ceiling.
    const goalBudget = goalSpec?.budget
      ? {
          ...(goalSpec.budget.maxModelCalls === null ? {} : { maxModelCalls: goalSpec.budget.maxModelCalls }),
          ...(goalSpec.budget.maxTokens === null ? {} : { maxTokens: goalSpec.budget.maxTokens }),
        }
      : {}

    const limits = buildLimits({ ...overrides, ...goalBudget })
    // Kept so a resume can rebuild the limits from the *current* config
    // instead of freezing whatever was set when the run first started.
    const keptOverrides = {}
    for (const key of ['maxSubtasks', 'maxParallel', 'deadlineMinutes']) {
      if (overrides[key] !== undefined && overrides[key] !== null) keptOverrides[key] = overrides[key]
    }
    for (const [key, value] of Object.entries(goalBudget)) keptOverrides[key] = value
    const dedupeKey = dedupeKeyOf(trimmed)
    // The goal claim is held across "list, check, write" so two processes
    // sharing a state directory cannot both conclude that nothing is running.
    return serialize(() => withGoalGuard(dedupeKey, async () => {
      const active = await activeCount()
      // The same goal twice is much more often a retry than a second piece of
      // work: the caller lost the run id, or a model re-issued the call. Return
      // the active run instead of paying for a second plan. `allowDuplicate` is
      // the escape hatch for a genuinely repeated task.
      if (!allowDuplicate) {
        const existing = await activeRunForGoal(dedupeKey, parentSessionId)
        if (existing) {
          log(`run ${existing.id} already has this goal; returning it instead of starting a duplicate`)
          return { ...existing, deduped: true }
        }
      }
      const waiting = queue.length
      const scheduled = origin?.kind === 'scheduled'
      if (scheduled) {
        const peer = await activePeerForScheduled(null, origin)
        if (peer) {
          // One plan, one active run. The scheduler turns this into a skipped
          // window; any other caller is told which run is in the way.
          const error = new Error(
            `schedule ${origin.scheduleId} already has an active run (${peer.id}); `
            + 'a plan runs one thing at a time',
          )
          error.code = 'schedule-busy'
          error.runId = peer.id
          throw error
        }
      }
      // A run already in line is first in line: a new start must not jump it.
      // A scheduled start never queues and, when the plan asks for human
      // priority, never takes the last slot: a manual start must still find a
      // free slot even if the timer fired first. The check lives here, inside
      // the start gate, so a manual start cannot slip in between a scheduler
      // check and its spawn.
      const cap = scheduled && reserveSlot ? Math.max(1, maxActiveRuns() - 1) : maxActiveRuns()
      const atCapacity = scheduled
        ? active >= cap || waiting > 0
        : active >= maxActiveRuns() || waiting > 0
      if (scheduled && atCapacity) {
        const error = new Error(
          `scheduled start deferred: ${active} active run(s), ${waiting} waiting, and a scheduled run may use `
          + `${cap} of ${maxActiveRuns()} slot(s)${reserveSlot ? ' (one slot is reserved for manual runs)' : ''}`,
        )
        error.code = 'scheduled-deferred'
        throw error
      }
      if (atCapacity) {
        if (!queueEnabled(wantsQueue)) throw new Error(quotaMessage(active, waiting))
        if (waiting >= maxQueuedRuns()) {
          throw new Error(
            `quota exceeded: ${active} active run(s), maxActiveRuns is ${maxActiveRuns()}, and the queue is full `
            + `(${waiting} waiting, maxQueuedRuns is ${maxQueuedRuns()}). Let one finish with superagent_status or `
            + 'cancel one with superagent_cancel.',
          )
        }
      }
      // A permission policy decides whether this start may exist at all. The
      // verdict is recorded before the run is written, so a refused start still
      // leaves evidence of what was asked for and why it was stopped.
      const runId = newRunId()
      if (audit && typeof audit.gate === 'function') {
        const verdict = await audit.gate({
          runId,
          kind: 'run.start',
          action: 'superagent_start',
          actor: `session:${parentSessionId}`,
          target: oneLine(trimmed, 200),
          meta: { goalChars: trimmed.length },
        })
        const trail = verdict.eventId ? ` (audit event ${verdict.eventId})` : ''
        if (verdict.decision === 'deny') {
          throw new Error(`refused by the permission policy: ${verdict.reason}${trail}`)
        }
        if (verdict.decision === 'confirm') {
          if (!approvePolicy) {
            throw new Error(
              `the permission policy holds this start for confirmation: ${verdict.reason}${trail}; `
              + 'call superagent_start again with approve_policy: true to release it',
            )
          }
          await audit.approve(verdict.eventId, {
            actor: `session:${parentSessionId}`,
            note: 'approve_policy on superagent_start',
            runId,
            kind: 'run.start',
          })
        }
      }
      // Read once, here: the digest is part of the run record, so a status call
      // can show exactly what the planner was told, and a resumed run does not
      // silently change the context its plan was based on.
      const context = await memoryContext(null, trimmed)
      const run = {
        id: runId,
        schemaVersion: 1,
        goal: trimmed,
        dedupeKey,
        status: 'queued',
        mode,
        goalMode: goalSpec
          ? {
              enabled: true,
              acceptance: goalSpec.acceptance,
              maxRounds: goalSpec.maxRounds,
              maxWallClockMinutes: goalSpec.maxWallClockMinutes,
              noProgressRounds: goalSpec.noProgressRounds,
              budget: goalSpec.budget,
              cwd: goalSpec.cwd ?? process.cwd(),
              // Stamped when the loop actually starts, so a queued run is not
              // charged for the time it waited for a free slot.
              startedAt: null,
              rounds: [],
              stop: null,
              achieved: false,
              nextInstruction: null,
            }
          : null,
        queue: null,
        // Where this run came from. Null is a manual start, which is the shape
        // every existing run had, so old records and readers are unchanged.
        origin: origin ?? null,
        notifyMuted: muted === true,
        parentSessionId,
        clientTimeZone: clientTimeZone ?? null,
        createdAt: new Date(now()).toISOString(),
        updatedAt: null,
        startedAt: new Date(now()).toISOString(),
        deadlineAt: new Date(now() + limits.deadlineMinutes * 60000).toISOString(),
        finishedAt: null,
        resumedAt: null,
        limits,
        overrides: keptOverrides,
        plan: null,
        subtasks: [],
        steps: {},
        report: null,
        attention: null,
        // Questions move here when a resume retires them, so a late answer can
        // still be told apart from an id that never existed.
        attentionHistory: [],
        attentionSeq: 0,
        // Instructions and answers given to this run after it started.
        followups: [],
        followupSeq: 0,
        milestones: [],
        artifacts: [],
        memory: context,
        memoryWrite: null,
        selfHeal: null,
        error: null,
        usage: null,
        notified: false,
        counters: { spawns: 0, unreadable: {} },
        usageByChild: {},
      }
      if (atCapacity) {
        // Waiting runs are persisted with an owner and a heartbeat so another
        // process sharing this directory can tell a live queue from a dead one.
        run.queue = {
          waiting: true,
          position: waiting + 1,
          of: waiting + 1,
          enqueuedAt: new Date(now()).toISOString(),
          timeoutAt: new Date(now() + queueTimeoutMs()).toISOString(),
        }
        run.ownerPid = process.pid
        run.ownerHost = os.hostname()
        run.heartbeatAt = new Date(now()).toISOString()
        await store.write(run)
        enqueue(run, parent)
        await refreshQueuePositions()
        log(`run ${run.id} is queued at position ${run.queue.position} (${active} active run(s))`)
        return run
      }
      await takeRunLock(run.id)
      try {
        await store.write(run)
      } catch (error) {
        await releaseRunLock(run.id)
        throw error
      }
      schedule(run, parent)
      return run
    }))
  }

  /** A run may only be resumed by the session that started it. */
  function assertResumeOwner(run, parent) {
    if (run.parentSessionId && parent?.id && run.parentSessionId !== parent.id) {
      throw new Error(
        `run ${run.id} belongs to session ${run.parentSessionId}, not ${parent.id}; `
        + 'resume it from that session, or start a new run from this one',
      )
    }
  }

  // A resume only finishes work that already exists, so it is never counted
  // against `maxActiveRuns`: a person asking to finish an interrupted run is
  // always let through. An options bag is still accepted so an older caller
  // that passes `force` keeps working; it no longer changes the outcome.
  /**
   * Resume under the start gate. Split from `resume` so answering a question
   * can record the answer and reopen the run in one serialized step instead of
   * waiting on a nested gate (which would deadlock on the promise it is holding).
   *
   * `reopen` lets `superagent_answer` continue a `completed` run: its subtasks
   * stay done and only the aggregation runs again, now with the answer.
   */
  async function resumeLocked(runId, parent, clientTimeZone, { reopen = false, approvePolicy = false, only = null } = {}) {
    const id = String(runId ?? '').trim()
    if (!parent || typeof parent !== 'object') throw new Error('superagent requires a live parent agent')
    {
      if (runtime.has(id)) {
        throw new Error(`run ${id} is still active in this process; wait for it with superagent_status or cancel it`)
      }
      let run = await loadRun(id)
      assertResumeOwner(run, parent)
      // A completed run is normally finished for good. The exception is an
      // answer that was recorded but never applied because the reopen failed
      // (quota, lock): then resume is the recovery path and must actually run
      // the aggregation again, not return the old report.
      let reopenCompleted = reopen || hasUnappliedAnswer(run)
      if (run.status === 'completed' && !reopenCompleted) return run
      if (ACTIVE_STATUSES.has(run.status)) {
        const verdict = await ownership(run)
        if (verdict.live) {
          throw new Error(
            `run ${id} is still owned by a live process (${verdict.basis}); resuming it here would run the same `
            + 'subtasks twice and double the spend. Cancel it with superagent_cancel first, or wait for it to finish.',
          )
        }
      }

      await takeRunLock(id)
      let scheduled = false
      try {
        // Re-read under the lock: another process may have started the run
        // between the check above and the claim.
        run = await loadRun(id)
        assertResumeOwner(run, parent)
        reopenCompleted = reopen || hasUnappliedAnswer(run)
        if (run.status === 'completed' && !reopenCompleted) return run
        // Resuming puts this run back to work, so it obeys the same one-active-
        // run-per-plan rule the timer does, under the same start gate. A plan
        // that already has a live run must be waited for or cancelled, not run
        // beside: two active runs are what made every later window skip.
        const peer = await activePeerForScheduled(run.id, run.origin)
        if (peer) {
          throw new Error(
            `run ${id} belongs to schedule ${run.origin.scheduleId}, which already has an active run `
            + `(${peer.id}); wait for it or cancel it before resuming this run`,
          )
        }
        // A resume spends the remaining budget again, so a per-run deny applies
        // to it as well; otherwise a policy added mid-run could be bypassed by
        // resuming the run instead of starting a new one.
        if (audit && typeof audit.gate === 'function') {
          const verdict = await audit.gate({
            runId: run.id,
            kind: 'run.resume',
            action: 'superagent_resume',
            actor: `session:${parent.id}`,
            target: oneLine(run.goal, 200),
          })
          const trail = verdict.eventId ? ` (audit event ${verdict.eventId})` : ''
          if (verdict.decision === 'deny') {
            throw new Error(`refused by the permission policy: ${verdict.reason}${trail}`)
          }
          if (verdict.decision === 'confirm') {
            if (!approvePolicy) {
              throw new Error(
                `the permission policy holds this resume for confirmation: ${verdict.reason}${trail}; `
                + 'call superagent_resume again with approve_policy: true to release it',
              )
            }
            await audit.approve(verdict.eventId, {
              actor: `session:${parent.id}`,
              note: 'approve_policy on superagent_resume',
              runId: run.id,
              kind: 'run.resume',
            })
          }
        }
        if (ACTIVE_STATUSES.has(run.status)) {
          const verdict = await ownership(run)
          if (verdict.live) {
            throw new Error(`run ${id} is still owned by a live process (${verdict.basis}); not resuming it here`)
          }
          reclaim(run, verdict, await hasCancelRequest(id))
          await save(run)
          await clearCancel(id)
        }

        // A resume is a person's action on a run that already exists, so it is
        // not gated by `maxActiveRuns`; only a start creates new spend. The
        // sweep still runs, so an orphan cannot hide behind a resumed run.
        const failedBefore = (run.subtasks ?? [])
          .filter(subtask => subtask.status !== 'completed' && subtask.error)
          .map(subtask => `${subtask.title}: ${String(subtask.error).replace(/\s+/g, ' ').slice(0, 160)}`)
          .slice(0, 3)
        run.recovery = {
          at: new Date(now()).toISOString(),
          previousStatus: run.status,
          previousError: run.error ? String(run.error).replace(/\s+/g, ' ').slice(0, 300) : null,
          failed: failedBefore,
        }

        // `only` restricts a resume to named subtasks. The board uses it to
        // rerun one subtask without restarting unrelated failed work; an empty
        // list means "rerun none" and is how an accepted review re-aggregates.
        const onlyKeys = Array.isArray(only) ? new Set(only.map(String)) : null
        for (const subtask of run.subtasks ?? []) {
          if (subtask.status === 'completed') continue
          if (onlyKeys && !onlyKeys.has(String(subtask.key))) continue
          // A dependency on a subtask the plan never contained cannot be fixed
          // by resuming: nothing would ever clear it.
          if (subtask.skipKind === 'missing') continue
          subtask.status = 'pending'
          subtask.attempts = 0
          subtask.error = null
          subtask.stopReason = null
          subtask.finishedAt = null
          subtask.skipKind = null
          subtask.skippedReason = null
          subtask.waitingOn = []
        }
        run.status = 'queued'
        // A reopened run has nothing left to execute, so the old report must go:
        // keeping it would return the report that ignored the answer.
        run.report = reopenCompleted ? null : (run.plan ? run.report : null)
        run.error = null
        run.finishedAt = null
        run.reclaimed = null
        run.cancelPending = false
        // A queued marker from an earlier attempt would keep this run out of the
        // active count after it is scheduled again.
        run.queue = null
        // A resumed run completes a second time, so it must be able to wake the
        // session again; keeping the old outcome would silence it forever.
        run.notified = false
        run.notify = null
        // These describe the previous settle. Keeping them would report an old
        // self-heal round or memory write against the new attempt.
        run.selfHeal = null
        run.memoryWrite = null
        // A question from the previous attempt was already reported; keeping it
        // would attach an old decision to the new outcome. It is archived rather
        // than dropped, so a late answer is refused as expired instead of
        // looking like an id that never existed.
        if (run.attention && ((run.attention.items ?? []).length > 0 || run.attention.issue)) {
          run.attentionHistory = Array.isArray(run.attentionHistory) ? run.attentionHistory : []
          run.attentionHistory.push({ ...run.attention, expiredAt: new Date(now()).toISOString() })
          if (run.attentionHistory.length > ATTENTION_HISTORY_MAX) {
            run.attentionHistory = run.attentionHistory.slice(-ATTENTION_HISTORY_MAX)
          }
        }
        run.attention = null
        // An instruction that missed the previous attempt gets another chance:
        // the new round builds fresh prompts.
        for (const entry of run.followups ?? []) {
          entry.missedAt = null
          entry.missedReason = null
        }
        run.dedupeKey = run.dedupeKey ?? dedupeKeyOf(run.goal)
        run.resumedAt = new Date(now()).toISOString()
        // A resume replans nothing, but the aggregator still runs, so refresh
        // the digest the notes have advanced since the run started.
        run.memory = await memoryContext(run.id, run.goal)
        run.clientTimeZone = clientTimeZone ?? run.clientTimeZone ?? null
        // The limits are rebuilt from the config that is active now, keeping
        // everything already spent: that is what makes "raise the cap, then
        // resume" work. Without this the old caps stayed in force forever.
        run.limits = buildLimits(run.overrides ?? {})
        run.deadlineAt = new Date(now() + run.limits.deadlineMinutes * 60000).toISOString()
        if (run.goalMode) {
          // A resume is a person asking the loop for another attempt: the round
          // and wall-clock allowances restart, while `rounds` keeps the history
          // the report and the next prompt still need.
          run.goalMode.roundBase = run.goalMode.rounds?.length ?? 0
          run.goalMode.startedAt = new Date(now()).toISOString()
          run.goalMode.stop = null
          run.goalMode.achieved = false
        }
        ensureCounters(run)
        await save(run)
        schedule(run, parent)
        auditRecord({
          runId: run.id,
          actor: `session:${parent.id}`,
          kind: 'run.resume',
          action: 'superagent_resume',
          target: oneLine(run.goal, 200),
          result: 'queued',
          meta: { previousStatus: run.recovery?.previousStatus ?? null },
        })
        scheduled = true
        return run
      } finally {
        if (!scheduled) await releaseRunLock(id)
      }
    }
  }

  /** Serialize resumes; `resumeLocked` assumes the start gate is already held. */
  function resume(runId, parent, clientTimeZone, options) {
    return serialize(() => resumeLocked(runId, parent, clientTimeZone, options))
  }

  /**
   * Add an instruction to a run that is already executing.
   *
   * The host exposes no way to append a message to a child activation, so this
   * is deliberately not a live channel: the instruction is queued on the run
   * and the next prompt built for it carries it. The reply says which prompt
   * that will be. A run owned by another process is refused rather than written:
   * that owner's next save would overwrite the change and the instruction would
   * silently vanish.
   *
   * @param {string} runId - run identity.
   * @param {string} text - the instruction.
   * @param {object} parent - live agent that owns the run.
   * @returns {Promise<{ run: object, followup: object, effect: { boundary: string, detail: string } }>}
   */
  async function followup(runId, text, parent) {
    const id = String(runId ?? '').trim()
    if (!id) throw new Error('run_id is required')
    const message = capChars(text, FOLLOWUP_MAX_CHARS)
    if (!message) throw new Error('message is required; pass the instruction to add to the run')
    if (!parent || typeof parent !== 'object') throw new Error('superagent requires a live parent agent')
    return serialize(async () => {
      const rt = runtime.get(id)
      if (rt && ACTIVE_STATUSES.has(rt.run.status)) {
        const run = rt.run
        assertResumeOwner(run, parent)
        const entry = pushFollowup(run, { kind: 'followup', text: message })
        await save(run)
        return { run, followup: entry, effect: followupEffect(run) }
      }
      const run = await loadRun(id)
      assertResumeOwner(run, parent)
      if (ACTIVE_STATUSES.has(run.status)) {
        throw new Error(
          `run ${id} is active but owned by another process; an instruction written here would be overwritten by `
          + 'that process\'s next save. Send it from the session that owns the run, or cancel the run and resume it '
          + 'here first.',
        )
      }
      if (run.status !== 'completed') {
        // A paused run will build fresh prompts when it is resumed, so queueing
        // the instruction now is a real delivery, not a courtesy.
        const entry = pushFollowup(run, { kind: 'followup', text: message })
        await save(run)
        return { run, followup: entry, effect: followupEffect(run) }
      }
      throw new Error(
        `run ${id} is completed, so it is not running and cannot take an instruction. `
        + 'Start a new run, or answer a pending question with superagent_answer.',
      )
    })
  }

  /**
   * Answer one structured attention item and let the run continue.
   *
   * The answer is matched by id, never by array position, and is recorded on
   * the item it answers. An active run picks it up at its next boundary; a
   * terminal run is reopened so its aggregation runs again with the decision —
   * that is the difference between continuing this run and starting another one.
   *
   * @param {string} runId - run identity.
   * @param {string | null | undefined} attentionId - `q1` from status; optional only when one question is open.
   * @param {string} text - the decision.
   * @param {object} parent - live agent that owns the run.
   * @param {string | undefined} clientTimeZone - forwarded to a resume.
   * @returns {Promise<object>} run plus which question was answered and whether the run restarted.
   */
  async function answer(runId, attentionId, text, parent, clientTimeZone) {
    const id = String(runId ?? '').trim()
    if (!id) throw new Error('run_id is required')
    const value = capChars(text, FOLLOWUP_MAX_CHARS)
    if (!value) throw new Error('answer is required; pass the decision the run should use')
    if (!parent || typeof parent !== 'object') throw new Error('superagent requires a live parent agent')
    return serialize(async () => {
      const rt = runtime.get(id)
      const run = rt?.run ?? await loadRun(id)
      assertResumeOwner(run, parent)
      const picked = selectAttention(run, attentionId, value)
      const at = new Date(now()).toISOString()
      picked.item.answer = value
      picked.item.answeredAt = at
      const entry = pushFollowup(run, {
        kind: 'answer',
        attentionId: picked.id,
        text: `Answer to question ${picked.id} ("${picked.item.question}"): ${value}. `
          + 'Apply this decision and continue the work.',
      })
      await save(run)

      if (ACTIVE_STATUSES.has(run.status)) {
        return { run, attention: picked.item, attentionId: picked.id, followup: entry, resumed: false, effect: followupEffect(run) }
      }
      try {
        const resumed = await resumeLocked(id, parent, clientTimeZone, { reopen: true })
        return { run: resumed, attention: picked.item, attentionId: picked.id, followup: entry, resumed: true, effect: followupEffect(resumed) }
      } catch (error) {
        // The answer is durable; only the restart failed. Saying so is better
        // than pretending the decision was applied or losing it.
        return {
          run: (await store.read(id)) ?? run,
          attention: picked.item,
          attentionId: picked.id,
          followup: entry,
          resumed: false,
          reason: error?.message ?? String(error),
        }
      }
    })
  }

  /**
   * Find the question an answer belongs to, and refuse the three ways an answer
   * can miss: an id that was never asked, a question retired by a resume, and a
   * question already answered. A free-form answer is allowed — options are
   * suggestions — but an answer that matches another question's option is
   * treated as a misdirected answer and named as such.
   *
   * @param {object} run - run record.
   * @param {unknown} requested - `attention_id` as given.
   * @param {string} value - the answer text.
   * @returns {{ item: object, id: string }} the matched question.
   */
  function selectAttention(run, requested, value) {
    const items = Array.isArray(run.attention?.items) ? run.attention.items : []
    const idOf = (item, index) => item?.id ?? `q${index + 1}`
    const idIn = item => idOf(item, items.indexOf(item))
    const open = items.filter(item => !item.answer)
    const wanted = String(requested ?? '').trim()
    const alreadyAnswered = item => `question ${idIn(item)} was already answered at ${item.answeredAt}: `
      + `${item.answer}. Answering again would replace a decision the run already acted on.`
    const describeOpen = () => (open.length === 0
      ? 'this run is not waiting for an answer'
      : `open question(s): ${open.map(idIn).join(', ')}`)

    if (!wanted) {
      // An id is optional only when there is exactly one question it could mean.
      if (open.length === 1) return { item: open[0], id: idIn(open[0]) }
      if (open.length > 1) {
        throw new Error(
          `run ${run.id} has ${open.length} open questions, so an answer needs attention_id to say which one: `
          + `${open.map(idIn).join(', ')}.`,
        )
      }
      if (items.length > 0) throw new Error(alreadyAnswered(items[0]))
      throw new Error(`run ${run.id} is not waiting for an answer (${describeOpen()}).`)
    }

    const match = open.find(item => idIn(item) === wanted)
    if (match) return { item: match, id: wanted }
    const answeredItem = items.find(item => idIn(item) === wanted)
    if (answeredItem) throw new Error(alreadyAnswered(answeredItem))

    for (const batch of Array.isArray(run.attentionHistory) ? run.attentionHistory : []) {
      const retired = (batch.items ?? []).find((item, position) => idOf(item, position) === wanted)
      if (!retired) continue
      if (retired.answer) {
        throw new Error(
          `question ${wanted} was already answered at ${retired.answeredAt}: ${retired.answer}. `
          + 'It is no longer open, so there is nothing to change.',
        )
      }
      throw new Error(
        `question ${wanted} expired at ${batch.expiredAt}: the run was resumed after asking it, so that question no `
        + 'longer blocks anything and an answer now would attach to work that is not waiting for it. '
        + 'Read superagent_status for the current question.',
      )
    }

    // The id is wrong, but the text is exactly another question's option: that
    // is a misdirected answer, and naming the right id is more useful than
    // "no such question".
    const misdirected = items.findIndex((item, position) => idOf(item, position) !== wanted
      && (item.options ?? []).some(option => String(option).trim().toLowerCase() === value.toLowerCase()))
    if (misdirected >= 0) {
      const other = items[misdirected]
      throw new Error(
        `"${value}" is one of the options of question ${idOf(other, misdirected)} ("${other.question}"), not of `
        + `${wanted}. Pass attention_id="${idOf(other, misdirected)}" if that is the question you mean.`,
      )
    }
    throw new Error(`no question ${wanted} on run ${run.id}; ${describeOpen()}.`)
  }

  /** Resolve one subtask by its plan key (`w2`) or by its 1-based index. */
  function findSubtask(run, target) {
    const wanted = String(target ?? '').trim()
    if (!wanted) throw new Error('subtask is required; pass its key (w2) or its 1-based index')
    const byKey = (run.subtasks ?? []).find(subtask => subtask.key === wanted)
    if (byKey) return byKey
    const asIndex = Number(wanted)
    if (Number.isInteger(asIndex) && asIndex > 0) {
      const byIndex = (run.subtasks ?? []).find(subtask => subtask.index === asIndex)
      if (byIndex) return byIndex
    }
    const known = (run.subtasks ?? []).map(subtask => subtask.key).join(', ')
    throw new Error(`no subtask ${wanted} on run ${run.id}; it has ${known || '(none)'}`)
  }

  /**
   * Stop one subtask while the rest of the run keeps going.
   *
   * This is deliberately narrower than `cancel`: the run's own controller is
   * untouched, so other workers, the planner's remaining graph, and the final
   * report still run. Dependents of the stopped subtask are skipped by the
   * normal cascade, with the reason kept on each one.
   *
   * @param {string} runId - run identity.
   * @param {string} target - subtask key or 1-based index.
   * @returns {Promise<object>} the updated run.
   */
  async function cancelSubtask(runId, target) {
    const id = String(runId ?? '').trim()
    if (!id) throw new Error('run_id is required')
    const rt = runtime.get(id)
    if (!rt || !ACTIVE_STATUSES.has(rt.run.status)) {
      const run = await loadRun(id)
      throw new Error(
        `run ${id} is ${run.status}, so there is no running subtask to stop; `
        + 'use rerun on the board if that work should run again',
      )
    }
    const subtask = findSubtask(rt.run, target)
    if (subtask.status === 'completed') {
      throw new Error(`subtask ${subtask.key} already completed; rerun it on the board if it needs another pass`)
    }
    if (subtask.status === 'cancelled') return rt.run
    const at = new Date(now()).toISOString()
    rt.cancelledSubtasks.add(subtask.key)
    subtask.status = 'cancelled'
    subtask.error = null
    subtask.stopReason = 'cancelled'
    subtask.cancelledAt = at
    subtask.finishedAt = at
    subtask.cancelledBy = 'board'
    subtask.waitingOn = []
    const own = rt.subtaskAborts?.get(subtask.key)
    own?.abort(new Error('subtask cancelled from the board'))
    for (const handle of [...rt.activations]) {
      if (subtask.childId && handle.childId === subtask.childId) await disposeQuietly(handle)
    }
    await save(rt.run)
    await auditRecord({
      runId: id,
      subtaskId: `subtask-${subtask.index}`,
      actor: 'session',
      kind: 'subtask.cancel',
      action: 'board_cancel_subtask',
      target: subtask.title,
      result: 'cancelled',
    })
    return rt.run
  }

  /**
   * Put one finished or skipped subtask back to `pending` and run only it.
   *
   * Completed siblings are not touched, so this is not a run restart. A
   * subtask that was skipped because this one failed is revived too, because
   * its dependency is about to run again; unrelated failures are left alone.
   *
   * @param {string} runId - run identity.
   * @param {string} target - subtask key or 1-based index.
   * @param {object} parent - live agent that owns the run.
   * @param {string} [clientTimeZone] - forwarded to the resume.
   * @returns {Promise<object>} the queued run.
   */
  async function rerunSubtask(runId, target, parent, clientTimeZone) {
    const id = String(runId ?? '').trim()
    if (!id) throw new Error('run_id is required')
    return serialize(async () => {
      if (runtime.has(id)) {
        throw new Error(`run ${id} is still active; wait for it to finish or stop the subtask first`)
      }
      const run = await loadRun(id)
      assertResumeOwner(run, parent)
      const subtask = findSubtask(run, target)
      if (subtask.status === 'running' || subtask.status === 'pending' || subtask.status === 'waiting') {
        throw new Error(`subtask ${subtask.key} is already waiting to run; resume the run instead`)
      }
      const keys = new Set([subtask.key])
      // A skip caused by this dependency is not a verdict on that subtask:
      // revive it so the rerun can actually unblock it.
      for (const candidate of run.subtasks ?? []) {
        if (candidate.status === 'skipped' && candidate.skipKind === 'upstream'
          && (candidate.dependsOn ?? []).some(dep => dep === subtask.key || keys.has(dep))) {
          keys.add(candidate.key)
          candidate.status = 'pending'
          candidate.skipKind = null
          candidate.skippedReason = null
          candidate.waitingOn = []
        }
      }
      subtask.status = 'pending'
      subtask.attempts = 0
      subtask.error = null
      subtask.stopReason = null
      subtask.result = null
      subtask.usage = null
      subtask.childId = null
      subtask.startedAt = null
      subtask.finishedAt = null
      subtask.cancelledAt = null
      subtask.cancelledBy = null
      subtask.waitingOn = []
      subtask.skipKind = null
      subtask.skippedReason = null
      subtask.blockKind = null
      subtask.blockedReason = null
      subtask.unverifiedReason = null
      subtask.deliverableCheck = null
      subtask.deliverables = []
      await save(run)
      const resumed = await resumeLocked(id, parent, clientTimeZone, {
        reopen: true,
        only: [...keys],
      })
      await auditRecord({
        runId: id,
        subtaskId: `subtask-${subtask.index}`,
        actor: `session:${parent?.id ?? 'unknown'}`,
        kind: 'subtask.rerun',
        action: 'board_rerun_subtask',
        target: subtask.title,
        result: 'queued',
      })
      return resumed
    })
  }

  /**
   * Accept or reject an `unverified` deliverable from the board.
   *
   * An unverified subtask is one the session could not judge on its own; a
   * person saying "I checked it" is the missing capability. Accepting reopens
   * the run so the report includes it, and only the report runs again.
   *
   * @param {string} runId - run identity.
   * @param {string} target - subtask key or 1-based index.
   * @param {'accept' | 'reject'} verdict - the person's decision.
   * @param {object} parent - live agent that owns the run.
   * @param {string} [clientTimeZone] - forwarded to the resume.
   * @param {string} [note] - optional reason kept on the audit line.
   * @returns {Promise<object>} the run or a note when the review was only recorded.
   */
  async function reviewSubtask(runId, target, verdict, parent, clientTimeZone, note = null) {
    const id = String(runId ?? '').trim()
    if (!id) throw new Error('run_id is required')
    if (verdict !== 'accept' && verdict !== 'reject') {
      throw new Error('verdict must be accept or reject')
    }
    return serialize(async () => {
      if (runtime.has(id)) {
        throw new Error(`run ${id} is still active; wait for it to finish before reviewing its deliverables`)
      }
      const run = await loadRun(id)
      assertResumeOwner(run, parent)
      const subtask = findSubtask(run, target)
      if (subtask.status !== 'unverified') {
        throw new Error(`subtask ${subtask.key} is ${subtask.status}, not waiting for a review`)
      }
      const at = new Date(now()).toISOString()
      subtask.reviewedAt = at
      subtask.reviewedBy = `session:${parent?.id ?? 'unknown'}`
      subtask.reviewNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null
      if (verdict === 'accept') {
        subtask.status = 'completed'
        subtask.result = subtask.result ?? '(deliverable accepted by a person)'
        subtask.error = null
        subtask.unverifiedReason = null
        subtask.finishedAt = at
        await save(run)
        const resumed = await resumeLocked(id, parent, clientTimeZone, { reopen: true, only: [] })
        await auditRecord({
          runId: id,
          subtaskId: `subtask-${subtask.index}`,
          actor: `session:${parent?.id ?? 'unknown'}`,
          kind: 'subtask.review',
          action: 'board_accept_subtask',
          target: subtask.title,
          result: 'completed',
          meta: { note: subtask.reviewNote },
        })
        return resumed
      }
      subtask.status = 'failed'
      subtask.error = `验收未通过${subtask.reviewNote ? `：${subtask.reviewNote}` : ''}`
      subtask.finishedAt = at
      await save(run)
      await auditRecord({
        runId: id,
        subtaskId: `subtask-${subtask.index}`,
        actor: `session:${parent?.id ?? 'unknown'}`,
        kind: 'subtask.review',
        action: 'board_reject_subtask',
        target: subtask.title,
        result: 'failed',
        meta: { note: subtask.reviewNote },
      })
      return run
    })
  }

  async function cancel(runId) {
    // A run that never got a slot has no owner process to ask: remove it from
    // the line here, so no timer can start it afterwards.
    const queuedIndex = queue.findIndex(entry => entry.run.id === runId)
    if (queuedIndex >= 0) {
      const entry = queue.splice(queuedIndex, 1)[0]
      if (entry.timer) clearTimer(entry.timer)
      if (queue.length === 0) stopQueueTicker()
      const run = entry.run
      if (isWaiting(run)) {
        run.queue = { ...run.queue, waiting: false, cancelled: true }
        run.status = 'cancelled'
        run.error = 'cancelled before a free slot was available; nothing was spent'
        run.finishedAt = new Date(now()).toISOString()
        run.activeMs = Number.isFinite(run.activeMs) ? run.activeMs : 0
        await save(run)
        await clearCancel(run.id)
        await releaseRunLock(run.id)
      }
      await refreshQueuePositions().catch(() => {})
      pumpQueue().catch(() => {})
      return run
    }

    const rt = runtime.get(runId)
    if (rt && ACTIVE_STATUSES.has(rt.run.status)) {
      rt.abortCause = 'cancelled'
      rt.controller.abort(new Error('cancelled by superagent_cancel'))
      const activations = [...rt.activations]
      // A child that ignores its abort must not hold this call open; the
      // timeout is per child and they are disposed in parallel.
      await Promise.all(activations.map(handle => disposeQuietly(handle)))
      await Promise.race([rt.promise ?? Promise.resolve(), sleep(CANCEL_ACK_MS)])
      if (ACTIVE_STATUSES.has(rt.run.status)) {
        rt.run.cancelPending = true
        await save(rt.run).catch(() => {})
      }
      auditRecord({
        runId,
        actor: 'session',
        kind: 'run.cancel',
        action: 'superagent_cancel',
        result: ACTIVE_STATUSES.has(rt.run.status) ? 'requested' : 'cancelled',
        meta: { ownedHere: true },
      })
      return rt.run
    }

    const run = await loadRun(runId)
    if (!ACTIVE_STATUSES.has(run.status)) return run

    // This process does not own the run, so it cannot abort the children. Ask
    // the owner through the marker file and wait for it to rewrite the state.
    // Writing `cancelled` here would be a lie: the owner would overwrite it on
    // its next save and keep spending.
    await requestCancel(runId)
    auditRecord({
      runId,
      actor: 'session',
      kind: 'run.cancel',
      action: 'superagent_cancel',
      result: 'requested',
      meta: { ownedHere: false },
    })
    const endsAt = now() + CANCEL_ACK_MS
    while (now() < endsAt) {
      await sleep(STATUS_POLL_MS)
      const current = await store.read(runId)
      if (!current) return run
      if (!ACTIVE_STATUSES.has(current.status)) return current
    }
    // The owner did not confirm in time. Do not rewrite the state file from
    // here: the owner would overwrite it on its next save. The request marker
    // stays on disk, and `status` reports it as a pending cancel.
    return { ...run, cancelPending: true }
  }

  async function status(runId, waitSeconds = 0) {
    const read = async () => liveRun(runId) ?? await store.read(runId)
    let run = await read()
    if (!run) {
      await loadRun(runId)
      throw new Error(`unknown run ${runId}`)
    }
    // A terminal status is only published after the run's final write, so a
    // caller that sees one gets the notify row and usage totals with it.
    const owner = runtime.get(runId)
    if (owner && TERMINAL_STATUSES.has(run.status)) {
      await withTimeout(Promise.resolve(owner.promise).catch(() => undefined), NOTIFY_MS + 5000, () => undefined)
      run = (await read()) ?? run
    }
    const limit = clamp(waitSeconds, 0, 3600)
    if (ACTIVE_STATUSES.has(run.status) && !run.cancelPending && await hasCancelRequest(runId)) {
      // The owning process may live elsewhere; the marker is the only evidence
      // that a cancel was asked for and not yet acknowledged.
      run = { ...run, cancelPending: true }
    }
    if (limit <= 0 || TERMINAL_STATUSES.has(run.status)) return run

    const rt = runtime.get(runId)
    if (rt) rt.waiters++
    try {
      const endsAt = now() + limit * 1000
      while (now() < endsAt) {
        await sleep(STATUS_POLL_MS)
        run = await read()
        if (!run || TERMINAL_STATUSES.has(run.status)) break
      }
    } finally {
      if (rt) rt.waiters = Math.max(0, rt.waiters - 1)
    }

    if (!run) throw new Error(`run ${runId} disappeared from the state directory while waiting for it`)
    const live = runtime.get(runId)
    // Wait for this process's own final write, so a caller that sees a terminal
    // status can immediately trust what is on disk. Bounded, because finalizing
    // includes waking the session and must not turn a status call into a hang.
    if (live && TERMINAL_STATUSES.has(live.run.status)) {
      await withTimeout(Promise.resolve(live.promise).catch(() => undefined), NOTIFY_MS + 5000, () => undefined)
    }
    return liveRun(runId) ?? run
  }

  async function list() {
    const merged = new Map()
    for (const run of await store.list()) merged.set(run.id, run)
    for (const [runId, rt] of runtime) merged.set(runId, rt.run)
    return [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  /**
   * Resolve once every run started by this process has finished. Used by tests
   * instead of sleeping, and by embedders that need a quiescent state.
   */
  /**
   * The quota as it stands, split by who started each run.
   *
   * The scheduler uses this for its report and to explain a deferral; the
   * reservation itself is enforced in `start()`, because only that path is
   * serialized with the quota check.
   */
  async function activeSnapshot() {
    try {
      await sweepOrphans()
    } catch (error) {
      log(`cannot check for orphaned runs: ${error?.message ?? error}`)
    }
    const runs = new Map()
    for (const run of await store.list()) runs.set(run.id, run)
    for (const [id, rt] of runtime) runs.set(id, rt.run)
    const active = [...runs.values()].filter(run => ACTIVE_STATUSES.has(run.status) && !isWaiting(run))
    const waiting = queue.map(entry => entry.run)
    const scheduled = run => run.origin?.kind === 'scheduled'
    return {
      active: active.length,
      scheduledActive: active.filter(scheduled).length,
      manualActive: active.filter(run => !scheduled(run)).length,
      waiting: waiting.length,
      scheduledWaiting: waiting.filter(scheduled).length,
      manualWaiting: waiting.filter(run => !scheduled(run)).length,
      maxActiveRuns: maxActiveRuns(),
      maxQueuedRuns: maxQueuedRuns(),
    }
  }

  async function idle() {
    await Promise.all([...runtime.values()].map(rt => rt.promise?.catch(() => {})))
  }

  return {
    recover,
    start,
    resume,
    cancel,
    cancelSubtask,
    rerunSubtask,
    reviewSubtask,
    followup,
    answer,
    inject,
    waitForInjection,
    status,
    list,
    idle,
    activeCount,
    activeSnapshot,
    liveRun,
  }
}
