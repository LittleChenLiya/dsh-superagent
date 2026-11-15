/**
 * Append-only audit trail for dsh-superagent.
 *
 * One JSON object per line, one event per action: a tool call, a path write, a
 * command, a block, a human approval, an attention decision, a run lifecycle
 * step. The file is deliberately plain JSONL so it can be read with `jq`,
 * `grep`, or a spreadsheet without this module, and so a crash cannot corrupt
 * anything except the line that was being written.
 *
 * Concurrent appends are what make an audit log trustworthy in the first place:
 * two workers finishing together must not splice their lines. Writes are
 * serialized inside the process and guarded by a `wx`-created lock file across
 * processes, and the line is written with a single append.
 *
 * This layer is independent of any path/command guard. A guard can be attached
 * with `attachGuard`; when it returns a decision the audit records it, and the
 * guard may only tighten what the policy already said.
 *
 * @module dsh-superagent/audit
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { createPolicyLoader, decide, LEVELS } from './policy.js'

/** Schema version written into every event. */
export const AUDIT_VERSION = 1

/** Event kinds this module writes. `kind` is free-form for callers, this is the vocabulary. */
export const EVENT_KINDS = [
  'run.start',
  'run.resume',
  'run.cancel',
  'run.finish',
  'tool.call',
  'path.write',
  'command.exec',
  'attention',
  'blocked',
  'approved',
]

export const CSV_COLUMNS = [
  'at',
  'id',
  'runId',
  'subtaskId',
  'actor',
  'kind',
  'action',
  'target',
  'decision',
  'result',
  'durationMs',
  'rule',
  'source',
  'meta',
]

const LOCK_TIMEOUT_MS = 10000
const LOCK_STALE_MS = 5000
const MAX_TARGET = 500
const MAX_TEXT = 200
const MAX_META_BYTES = 4000

const RANK = { allow: 0, confirm: 1, deny: 2 }

/**
 * Decisions an event may carry. Policy levels plus `attention`, which records a
 * hand-off to a person for an action that was stopped short rather than run.
 * Guard merging below still uses LEVELS only.
 */
const RECORDED_DECISIONS = [...LEVELS, 'attention']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function clip(value, limit) {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function serializeMeta(meta) {
  if (meta === null || meta === undefined) return null
  let text
  try {
    text = JSON.stringify(meta)
  } catch {
    return { unserializable: true }
  }
  if (text === undefined) return null
  if (text.length <= MAX_META_BYTES) return JSON.parse(text)
  return { truncated: true, bytes: text.length, preview: text.slice(0, MAX_META_BYTES) }
}

/**
 * Fill in the fields every event carries. Missing values stay `null` instead of
 * disappearing, so a consumer can rely on the column being present.
 */
export function normalizeEvent(input, { now = () => Date.now() } = {}) {
  const at = input?.at ?? new Date(now()).toISOString()
  return {
    v: AUDIT_VERSION,
    id: typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : `evt_${randomUUID()}`,
    at,
    runId: clip(input?.runId, MAX_TEXT),
    subtaskId: clip(input?.subtaskId, MAX_TEXT),
    actor: clip(input?.actor, MAX_TEXT),
    kind: clip(input?.kind, 64) ?? 'unknown',
    action: clip(input?.action, 64),
    target: clip(input?.target, MAX_TARGET),
    decision: RECORDED_DECISIONS.includes(input?.decision) ? input.decision : null,
    result: clip(input?.result, 32),
    durationMs: Number.isFinite(input?.durationMs) ? Math.max(0, Math.round(input.durationMs)) : null,
    rule: clip(input?.rule, MAX_TEXT),
    source: clip(input?.source, 64) ?? 'plugin',
    meta: serializeMeta(input?.meta),
  }
}

async function withFileLock(file, work) {
  const lock = `${file}.lock`
  const started = Date.now()
  for (;;) {
    try {
      await fsp.writeFile(lock, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, { encoding: 'utf8', flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // Windows reports a concurrent create as EPERM/EACCES now and then.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      }
      try {
        const stat = await fsp.stat(lock)
        // A process killed while holding the lock must not stop the log forever.
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.unlink(lock)
          continue
        }
      } catch {
        // The holder released it between the two calls; retry immediately.
        continue
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for the audit log lock ${lock}; another process may be stuck`)
      }
      await sleep(2 + Math.random() * 8)
    }
  }
  try {
    return await work()
  } finally {
    await fsp.unlink(lock).catch(() => {})
  }
}

/**
 * One append-only JSONL file.
 * @param {{ dir: string, file?: string, sync?: boolean, warn?: (message: string) => void, now?: () => number }} options
 */
export function createAuditLog({ dir, file = 'audit.jsonl', sync = true, warn = () => {}, now = () => Date.now() } = {}) {
  const filePath = path.isAbsolute(file) ? file : path.join(dir, file)
  let ready = null
  let chain = Promise.resolve()

  const ensureDir = () => {
    ready = ready ?? fsp.mkdir(path.dirname(filePath), { recursive: true })
    return ready
  }

  async function appendLine(line) {
    await ensureDir()
    for (let attempt = 1; ; attempt++) {
      try {
        await withFileLock(filePath, async () => {
          const handle = await fsp.open(filePath, 'a')
          try {
            const { bytesWritten } = await handle.write(line)
            if (bytesWritten !== Buffer.byteLength(line)) {
              throw new Error(`short audit write: ${bytesWritten} of ${Buffer.byteLength(line)} bytes reached ${filePath}`)
            }
            if (sync) await handle.datasync()
          } finally {
            await handle.close()
          }
        })
        return
      } catch (error) {
        // A reader holding the file can fail the open on Windows; retry before
        // reporting a lost event, because a lost event is the one thing an
        // audit log must not quietly produce.
        if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
        await sleep(20 * attempt)
      }
    }
  }

  return {
    file: filePath,
    dir,
    /**
     * Append one event. Calls are serialized in-process, so two callers in the
     * same tick still produce two whole lines in call order.
     * @param {object} input - event fields.
     * @returns {Promise<{ ok: boolean, event?: object, error?: Error }>} never throws.
     */
    async append(input) {
      const event = normalizeEvent(input, { now })
      const line = `${JSON.stringify(event)}\n`
      const run = chain.then(() => appendLine(line))
      // Keep the chain alive after a failure, so one ENOSPC does not stop the log.
      chain = run.catch(() => {})
      try {
        await run
        return { ok: true, event }
      } catch (error) {
        warn(`cannot append to the audit log ${filePath}: ${error?.message ?? error}`)
        return { ok: false, event, error }
      }
    },

    /**
     * Read every complete line. A trailing fragment is reported as torn rather
     * than parsed, and an unparsable line is counted instead of aborting the
     * read: one bad byte must not hide the other 10,000 events.
     * @returns {Promise<{ events: object[], invalid: number, torn: number }>}
     */
    async read() {
      let text
      try {
        text = await fsp.readFile(filePath, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return { events: [], invalid: 0, torn: 0 }
        throw error
      }
      const events = []
      let invalid = 0
      let torn = 0
      const lines = text.split('\n')
      const endsWithNewline = text.endsWith('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        if (i === lines.length - 1 && !endsWithNewline) {
          torn++
          continue
        }
        try {
          const parsed = JSON.parse(line)
          if (parsed && typeof parsed === 'object') events.push(parsed)
          else invalid++
        } catch {
          invalid++
        }
      }
      return { events, invalid, torn }
    },
  }
}

function within(value, from, to) {
  const at = Date.parse(value ?? '')
  if (!Number.isFinite(at)) return false
  if (from !== null && at < from) return false
  if (to !== null && at > to) return false
  return true
}

function asList(value) {
  if (value === null || value === undefined) return null
  const list = Array.isArray(value) ? value : [value]
  const cleaned = list.map(item => String(item).trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : null
}

function bound(value, label) {
  if (value === null || value === undefined || value === '') return null
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new Error(`${label} is not a timestamp this log can compare: ${JSON.stringify(value)}`)
  return at
}

/**
 * Filter events by run, subtask, kind, decision, result, actor, target text and
 * time window.
 * @param {object[]} events - parsed events, in file order.
 * @param {object} filter - query.
 * @returns {object[]} matching events in the requested order.
 */
export function filterEvents(events, filter = {}) {
  const runId = filter.runId ? String(filter.runId) : null
  const subtaskId = filter.subtaskId ? String(filter.subtaskId) : null
  const kinds = asList(filter.kind)
  const decisions = asList(filter.decision)
  const results = asList(filter.result)
  const actor = filter.actor ? String(filter.actor) : null
  const target = filter.target ? String(filter.target).toLowerCase() : null
  const from = bound(filter.since ?? filter.from, 'since')
  const to = bound(filter.until ?? filter.to, 'until')
  const matched = events.filter(event => {
    if (runId && event.runId !== runId) return false
    if (subtaskId && event.subtaskId !== subtaskId) return false
    if (kinds && !kinds.includes(event.kind)) return false
    if (decisions && !decisions.includes(event.decision)) return false
    if (results && !results.includes(event.result)) return false
    if (actor && event.actor !== actor) return false
    if (target && !String(event.target ?? '').toLowerCase().includes(target)) return false
    if ((from !== null || to !== null) && !within(event.at, from, to)) return false
    return true
  })
  if (filter.order === 'desc') matched.reverse()
  const limit = Number(filter.limit)
  if (Number.isFinite(limit) && limit > 0) return matched.slice(0, Math.trunc(limit))
  return matched
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`
  return text
}

/** Render events as a CSV document with a header row. */
export function toCsv(events) {
  const rows = [CSV_COLUMNS.join(',')]
  for (const event of events) rows.push(CSV_COLUMNS.map(column => csvCell(event[column])).join(','))
  return `${rows.join('\n')}\n`
}

/** Render events as JSONL, one normalized event per line. */
export function toJsonl(events) {
  return events.map(event => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '')
}

function defaultExportName(format, now) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  return `audit-export-${stamp}.${format === 'csv' ? 'csv' : 'jsonl'}`
}

/**
 * Optional external guard, e.g. the path/command layer that owns its own rules.
 * It receives the same request the audit layer was given and may return
 * `{ decision }` or the `{ blocked, rule, reason }` shape a tool-call guard
 * already produces. `null` means "no opinion". It may only tighten.
 * @typedef {(request: object) => Promise<object | null> | object | null} GuardHook
 */

/**
 * The audit layer the plugin and a guard both talk to.
 *
 * @param {{
 *   dir: string,
 *   policyFile?: string | null,
 *   policy?: object | null,
 *   guard?: GuardHook | null,
 *   warn?: (message: string) => void,
 *   now?: () => number,
 *   sync?: boolean,
 * }} options
 */
export function createAuditor({
  dir,
  policyFile = null,
  policy = null,
  guard = null,
  warn = () => {},
  now = () => Date.now(),
  sync = true,
} = {}) {
  const log = createAuditLog({ dir, warn, now, sync })
  const loader = policyFile ? createPolicyLoader({ file: policyFile, warn }) : null
  let fixedPolicy = policy
  let attachedGuard = guard

  async function currentPolicy() {
    if (fixedPolicy) return { policy: fixedPolicy, error: null }
    if (loader) return loader.get()
    return { policy: null, error: null }
  }

  async function resolve(request) {
    const started = now()
    const state = await currentPolicy()
    let verdict
    if (!state.policy) {
      // A configured but unreadable policy fails closed: an audit trail that
      // cannot say what was allowed must not wave the action through.
      verdict = state.error
        ? {
            decision: 'deny',
            rule: 'policy.invalid',
            reason: `the permission policy could not be loaded: ${state.error.message ?? state.error}`,
            relaxedFrom: null,
            match: null,
          }
        : decide(null, request)
    } else {
      verdict = decide(state.policy, request)
    }
    let source = verdict.rule === 'no-policy' ? 'default' : 'policy'
    if (attachedGuard) {
      let guardVerdict = null
      try {
        guardVerdict = await attachedGuard(request)
      } catch (error) {
        warn(`audit guard threw on ${request?.kind}: ${error?.message ?? error}`)
        guardVerdict = { decision: 'deny', reason: `the guard failed: ${error?.message ?? error}` }
      }
      const decision = LEVELS.includes(guardVerdict?.decision)
        ? guardVerdict.decision
        : guardVerdict?.blocked === true ? 'deny' : null
      // The guard shares the "only tighten" rule: it can add a deny or a
      // confirmation on top of the policy, never remove one.
      if (decision && RANK[decision] > RANK[verdict.decision]) {
        verdict = {
          decision,
          rule: `guard.${guardVerdict.rule ?? 'verdict'}`,
          reason: guardVerdict.reason ?? `the guard requires ${decision}`,
          relaxedFrom: null,
          match: guardVerdict.match ?? null,
        }
        source = 'guard'
      }
    }
    return { verdict, source, durationMs: now() - started }
  }

  const resultFor = decision => (decision === 'deny' ? 'blocked' : decision === 'confirm' ? 'pending' : 'ok')

  /**
   * Read and filter the log.
   * @param {object} [filter] - runId, subtaskId, kind, decision, result, actor, target, since, until, limit, order.
   */
  async function query(filter = {}) {
    const { events, invalid, torn } = await log.read()
    const matched = filterEvents(events, filter)
    return { events: matched, total: matched.length, scanned: events.length, invalid, torn, file: log.file }
  }

  /**
   * Write the matching events to one deliverable file.
   * @param {object} [options] - `format` ('jsonl' | 'csv'), `outFile`, plus any query filter.
   * @returns {Promise<{ path: string, count: number, bytes: number, format: string, invalid: number }>}
   */
  async function exportEvents(options = {}) {
    const format = options.format === 'csv' ? 'csv' : 'jsonl'
    const { events, invalid } = await query(options)
    const target = options.outFile
      ? path.resolve(options.outFile)
      : path.join(dir, defaultExportName(format, now))
    const body = format === 'csv' ? toCsv(events) : toJsonl(events)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, body, 'utf8')
    return { path: target, count: events.length, bytes: Buffer.byteLength(body), format, invalid }
  }

  const api = {
    dir,
    log,
    file: log.file,
    policyFile,

    /** Last policy problem, or null. */
    async policyError() {
      const state = await currentPolicy()
      return state.error ?? null
    },

    /** Replace the policy in memory (used by tests and by a caller that parses its own file). */
    setPolicy(next) {
      fixedPolicy = next
      return api
    },

    /** Attach or replace the external guard. Pass null to detach. */
    attachGuard(next) {
      attachedGuard = typeof next === 'function' ? next : null
      return api
    },

    /**
     * Append one event. Never throws and never blocks the caller: a failure is
     * reported to the warn sink and returned.
     * @param {object} input - event fields.
     */
    async record(input) {
      return log.append(input)
    },

    /**
     * Review one action, record the verdict, and return it. The returned
     * `eventId` is what an approval or a later execution event refers to.
     * @param {{ kind: string, runId?: string, subtaskId?: string, actor?: string, action?: string, target?: string, meta?: object }} request
     */
    async gate(request = {}) {
      const { verdict, source, durationMs } = await resolve(request)
      const result = resultFor(verdict.decision)
      const recorded = await log.append({
        runId: request.runId ?? null,
        subtaskId: request.subtaskId ?? null,
        actor: request.actor ?? null,
        kind: verdict.decision === 'deny' ? 'blocked' : request.kind,
        action: request.action ?? request.kind,
        target: request.target ?? null,
        decision: verdict.decision,
        result,
        durationMs,
        rule: verdict.rule,
        source,
        meta: {
          ...(request.meta ?? {}),
          ...(verdict.relaxedFrom ? { relaxedFrom: verdict.relaxedFrom } : {}),
          ...(verdict.decision === 'deny' ? { blockedKind: request.kind } : {}),
          reason: verdict.reason,
        },
      })
      return { ...verdict, source, eventId: recorded.ok ? recorded.event.id : null }
    },

    /**
     * Record a human decision on an event that was held for confirmation.
     * Approvals are how a policy gets relaxed on purpose: the trail shows the
     * blocked/pending event, the person, and the note.
     * @param {string} eventId - id of the held event.
     * @param {{ actor?: string, note?: string, runId?: string, kind?: string }} [options]
     */
    async approve(eventId, { actor = null, note = null, runId = null, kind = null } = {}) {
      if (!eventId) throw new Error('approve needs the id of the event being released')
      const recorded = await log.append({
        runId,
        actor,
        kind: 'approved',
        action: 'approve',
        target: eventId,
        decision: 'allow',
        result: 'approved',
        durationMs: 0,
        rule: 'manual-approval',
        source: 'human',
        meta: { approves: eventId, note, of: kind },
      })
      if (!recorded.ok) throw recorded.error ?? new Error('cannot record the approval')
      return recorded.event
    },

    /**
     * Read and filter the log.
     * @param {object} [filter] - runId, subtaskId, kind, decision, result, actor, target, since, until, limit, order.
     */
    query,

    /**
     * Write the matching events to one deliverable file.
     * @param {object} [options] - `format` ('jsonl' | 'csv'), `outFile`, plus any query filter.
     * @returns {Promise<{ path: string, count: number, bytes: number, format: string, invalid: number }>}
     */
    export: exportEvents,
  }
  return api
}
