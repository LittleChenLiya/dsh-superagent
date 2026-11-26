/**
 * Read-only quality and evidence cards for durable runs.
 *
 * The module does not run checks, inspect the network, or read files. It projects
 * evidence that callers have already authorised into bounded, JSON-safe cards:
 * acceptance checks, independent reviewer results, declared deliverables, report
 * citations/artifacts, and audit events. A declaration or a link is never promoted
 * into a successful quality check.
 *
 * Confidence is deliberately qualitative. Its level is selected by the explicit
 * rules returned with each card; it is not a probability, score, or a prediction
 * that the user's goal was achieved.
 *
 * @module dsh-superagent/evidence-center
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { hasMatchingCheckReceipt } from './goal.js'

export const EVIDENCE_CATEGORIES = Object.freeze(['machine', 'model', 'reviewer', 'source'])
export const EVIDENCE_STATUSES = Object.freeze(['passed', 'failed', 'unverified', 'recorded'])

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_TEXT = 600
const MAX_TITLE = 180
const MAX_ITEMS = 8
const MAX_LINKS = 12
const MAX_HREF = 2048
const MAX_REPORT_CHARS = 100_000
const MAX_INPUT_ITEMS = 5000
const MAX_RECEIPT = 128
const DIGEST = /^[0-9a-f]{64}$/i
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const FILE_EXTENSION = /\.([a-z0-9][a-z0-9._-]{0,31})$/i
const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid)$/i
const SENSITIVE_PARAM = /(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|credential|signature|sig|auth|cookie|session)/i
const CATEGORY_RANK = Object.freeze({ machine: 0, reviewer: 1, model: 2, source: 3 })

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function list(value, cap = MAX_INPUT_ITEMS) {
  if (!Array.isArray(value)) return []
  return value.slice(0, cap)
}

function eventList(value) {
  return Array.isArray(value) ? list(value) : list(record(value)?.events)
}

function reportText(value) {
  if (typeof value === 'string') return value
  const report = record(value)
  return report?.text ?? report?.markdown ?? report?.content ?? ''
}

function cleanText(value, limit = MAX_TEXT) {
  if (value === null || value === undefined) return ''
  let text = String(value).replace(/\u0000/g, '').replace(/[\r\n\t]+/g, ' ').trim()
  // Credentials and private keys must not survive in summaries, commands, model
  // evidence, citations, or error messages. Local artifact hrefs are handled
  // separately because the caller needs the real authorised target to open it.
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{8,}/g, '[credential redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[credential redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]')
    .replace(/((?:password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/([?&](?:token|secret|password|api[-_]?key|access[-_]?token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/([A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])[^\\/]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function textList(value, limit = MAX_ITEMS, itemLimit = 300) {
  const source = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? [value] : []
  const output = []
  const seen = new Set()
  for (const item of source.slice(0, MAX_INPUT_ITEMS)) {
    const text = cleanText(item, itemLimit)
    if (!text || seen.has(text)) continue
    seen.add(text)
    output.push(text)
    if (output.length >= limit) break
  }
  return output
}

function timeValue(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null
    value = value.toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value
    const date = new Date(millis)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null
}

function firstTime(...values) {
  for (const value of values) {
    const at = timeValue(value)
    if (at) return at
  }
  return null
}

function safeId(value, limit = 180) {
  return cleanText(value, limit) || null
}

function isWindowsPath(value) {
  return WINDOWS_ABSOLUTE.test(value) || /^[a-z]:[\\/]/i.test(value)
}

function pathFlavor(base) {
  if (isWindowsPath(base ?? '')) return path.win32
  if (base && path.posix.isAbsolute(base)) return path.posix
  return isWindowsPath(process.cwd()) ? path.win32 : path.posix
}

function pathIdentity(value) {
  const normal = value.replace(/\\/g, '/')
  return isWindowsPath(value) ? normal.toLowerCase() : normal
}

function withinRoot(root, target, flavor) {
  const relative = flavor.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${flavor.sep}`) && relative !== '..' && !flavor.isAbsolute(relative))
}

function decodeLocal(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function cleanLocalTarget(raw) {
  let value = String(raw ?? '').trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  value = value.replace(/\\([\\`*_[\]{}()#+.!<>-])/g, '$1')
  value = value.replace(/[.,;:，。；：]+$/, '')
  value = decodeLocal(value)
  const fragment = value.indexOf('#')
  if (fragment >= 0) value = value.slice(0, fragment)
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('//')) return null
  if (URL_SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null
  return value
}

/**
 * Resolve a local artifact lexically. This proves only that the normalised path
 * is inside an authorised root; it does not claim to have resolved symlinks.
 */
function localArtifact(raw, roots) {
  const value = cleanLocalTarget(raw)
  if (!value) return null
  const absolute = path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
  if (absolute && roots.length === 0) return null
  const flavor = pathFlavor(roots[0]?.base ?? value)
  for (const root of roots) {
    const localFlavor = pathFlavor(root.base)
    // Do not reinterpret a POSIX path through win32 merely because the host is
    // Windows, or a UNC path through posix.
    if (absolute && ((root.flavor === path.win32) !== (flavor === path.win32))) continue
    const target = localFlavor.resolve(root.base, value)
    if (!withinRoot(root.base, target, localFlavor)) continue
    return {
      kind: 'file',
      href: target,
      path: target,
      identity: `file:${pathIdentity(target)}`,
      root: root.base,
    }
  }
  return null
}

function webArtifact(raw) {
  let value = String(raw ?? '').trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  value = value.replace(/\\([\\`*_[\]{}()#+.!<>-])/g, '$1').replace(/[.,;:，。；：]+$/, '')
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || !/^https?:\/\//i.test(value)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null
  const hadCredentials = Boolean(url.username || url.password)
  url.username = ''
  url.password = ''
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key)
    else if (SENSITIVE_PARAM.test(key)) url.searchParams.set(key, '[redacted]')
  }
  const href = url.href
  return {
    kind: 'link',
    href,
    path: null,
    identity: `url:${href}`,
    credentialsRedacted: hadCredentials,
  }
}

function artifactFor(raw, roots) {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return webArtifact(value)
  return localArtifact(value, roots)
}

function artifactDescriptor(target, extra = {}) {
  if (!target) return null
  const name = cleanText(extra.name ?? extra.label ?? target.href.replace(/\\/g, '/').split('/').pop(), MAX_TITLE)
  const kind = cleanText(extra.kind ?? (target.kind === 'file' ? FILE_EXTENSION.exec(target.path)?.[1]?.toLowerCase() : 'link'), 48) || 'file'
  return {
    name: name || kind,
    kind,
    href: target.href.slice(0, MAX_HREF),
    ...(target.path ? { path: target.path.slice(0, MAX_HREF) } : {}),
    at: timeValue(extra.at),
  }
}

function markdownLinks(report) {
  const text = typeof report === 'string' ? report.slice(0, MAX_REPORT_CHARS) : ''
  if (!text) return []
  const links = []
  const seen = new Set()
  const push = (raw, label = null) => {
    const item = artifactFor(raw, [])
    // Resolution against a workspace is done by the caller. This first pass only
    // recognises safe targets and prevents repeated regex work for duplicates.
    const key = item?.identity ?? `local:${pathIdentity(cleanLocalTarget(raw) ?? '')}`
    if (!item && !key.startsWith('local:')) return
    if (seen.has(key)) return
    seen.add(key)
    links.push({ raw: item?.kind === 'link' ? String(raw).trim() : cleanLocalTarget(raw), label: cleanText(label, MAX_TITLE) || null })
  }
  for (const match of text.matchAll(/!?\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) push(match[2], match[1])
  const definitions = new Map()
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/gm)) {
    definitions.set(match[1].trim().toLowerCase(), match[2])
  }
  for (const match of text.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const target = definitions.get((match[2] || match[1]).trim().toLowerCase())
    if (target) push(target, match[1])
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>)\]}|]+/gi)) push(match[0])
  const withoutUrls = text.replace(/https?:\/\/[^\s"'`<>)\]}|]+/gi, match => ' '.repeat(match.length))
  for (const match of withoutUrls.matchAll(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)[^\s"'`<>|]+?\.(?:html?|md|pdf|docx?|xlsx?|csv|tsv|json|ya?ml|txt|log|png|jpe?g|gif|webp|svg|zip|pptx?|py|js|mjs|css)\b/gi)) push(match[0])
  return links.slice(0, 200)
}

function receiptValue(value) {
  if (value === null || value === undefined || value === '') return { value: null, state: 'missing' }
  if (typeof value !== 'string') return { value: null, state: 'invalid' }
  const receipt = value.trim()
  if (!receipt) return { value: null, state: 'missing' }
  if (receipt.length > MAX_RECEIPT || /[\u0000-\u001f\u007f]/.test(receipt)) return { value: null, state: 'invalid' }
  return { value: cleanText(receipt, MAX_RECEIPT), state: 'present' }
}

function machineReceipt(check, runId, round) {
  const receipt = receiptValue(check?.receipt)
  if (receipt.state !== 'present') return { ...receipt, verified: false }
  if (!DIGEST.test(receipt.value)) return { ...receipt, state: 'invalid', verified: false }
  if (check.integrity === false) return { ...receipt, state: 'invalid', verified: false }
  if (!runId || round === null || round === undefined) {
    // A console detail projection may carry an already-computed integrity bit.
    // Accept it only when the original round is unavailable, and still require
    // a digest-shaped receipt rather than an arbitrary "receipt-ok" string.
    return check.integrity === true
      ? { ...receipt, state: 'verified', verified: true }
      : { ...receipt, state: 'unverifiable', verified: false }
  }
  try {
    return hasMatchingCheckReceipt(runId, round, check)
      ? { ...receipt, state: 'verified', verified: true }
      : { ...receipt, state: 'invalid', verified: false }
  } catch {
    return { ...receipt, state: 'invalid', verified: false }
  }
}

function optionalReceipt(value) {
  const receipt = receiptValue(value)
  if (receipt.state === 'present') return { ...receipt, state: 'provided', verified: false }
  // Reviewer/model/source records do not have a receipt requirement in their
  // schemas. Distinguish that from a missing receipt on a machine check.
  return { ...receipt, state: receipt.state === 'invalid' ? 'invalid' : 'not-required', verified: false }
}

function confidence(status, category, options = {}) {
  if (status === 'unverified') {
    const reason = options.reason || 'the evidence is incomplete or cannot be authenticated'
    return {
      level: 'none',
      probability: false,
      rules: ['unverified-evidence'],
      explanation: `No confidence level: ${reason}. This is not a statistical probability.`,
    }
  }
  if (category === 'machine' && options.receipt === true) {
    return {
      level: 'verified',
      probability: false,
      rules: ['machine-result-with-matching-receipt'],
      explanation: 'A recorded machine result has a matching receipt. This verifies that result only, not overall goal quality; it is not a statistical probability.',
    }
  }
  if (category === 'reviewer') {
    return {
      level: options.evidence ? 'reviewed' : 'limited',
      probability: false,
      rules: options.evidence ? ['independent-review-with-concrete-evidence'] : ['independent-review-without-concrete-evidence'],
      explanation: options.evidence
        ? 'An independent reviewer supplied a valid verdict and concrete evidence. This is a qualitative review level, not a statistical probability.'
        : 'An independent reviewer supplied a valid verdict but no concrete evidence. Confidence is limited; this is not a statistical probability.',
    }
  }
  if (category === 'model') {
    return {
      level: 'model-judged',
      probability: false,
      rules: ['explicit-model-judgment'],
      explanation: 'This is only the acceptance model’s recorded judgment, without a machine receipt. It is not a statistical probability.',
    }
  }
  return {
    level: options.audit ? 'recorded' : 'referenced',
    probability: false,
    rules: options.audit ? ['audit-event-record'] : ['source-reference-only'],
    explanation: options.audit
      ? 'An audit event records that an action or decision occurred. It does not by itself prove quality; this is not a statistical probability.'
      : 'A source or artifact is referenced and clickable. A link alone does not prove its claim; this is not a statistical probability.',
  }
}

function statusFrom(value, fallback = 'unverified') {
  const status = cleanText(value, 40).toLowerCase()
  if (status === 'pass' || status === 'passed' || status === 'verified' || status === 'success' || status === 'ok') return 'passed'
  if (status === 'fail' || status === 'failed' || status === 'error' || status === 'blocked' || status === 'deny' || status === 'denied') return 'failed'
  if (status === 'recorded' || status === 'pending' || status === 'running') return 'recorded'
  return fallback
}

function rootsFor(run, options) {
  const configured = options.allowedRoots ?? options.workspaceRoot ?? options.root ?? null
  const values = Array.isArray(configured) ? configured : configured ? [configured] : []
  const candidates = values.length > 0
    ? values
    : [run?.workspace?.base, run?.goalMode?.cwd, run?.cwd, record(run?.workspace)?.dir]
  const roots = []
  const seen = new Set()
  for (const candidate of candidates) {
    const raw = typeof candidate === 'string' ? candidate.trim() : record(candidate)?.cwd ?? record(candidate)?.base
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) continue
    const flavor = pathFlavor(raw)
    const base = flavor.resolve(raw)
    const key = `${flavor === path.win32 ? 'win' : 'posix'}:${pathIdentity(base)}`
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({ base, flavor })
  }
  return roots
}

function normalizeInput(input) {
  const empty = { auditEvents: [], citations: [], links: [], sources: [], reviewers: [] }
  if (Array.isArray(input)) return { runs: input, ...empty }
  const source = record(input) ?? {}
  if (source.id && (source.subtasks || source.goalMode || source.report !== undefined || source.acceptance)) return { runs: [source], ...empty }
  return {
    runs: list(source.runs),
    runId: source.runId ?? null,
    auditEvents: eventList(source.auditEvents ?? source.events),
    report: source.report,
    citations: list(source.citations),
    links: list(source.links),
    sources: list(source.sources),
    reviewers: list(source.reviewers ?? source.reviewerResults),
  }
}

function limitValue(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT) {
    throw new RangeError(`evidence limit must be an integer from 0 to ${MAX_LIMIT}`)
  }
  return limit
}

function cardId(identity) {
  return `evd_${createHash('sha256').update(identity).digest('base64url').slice(0, 24)}`
}

function baseCard({ run, category, kind, identity, title, status, at, subtaskId = null, provenance }) {
  return {
    id: cardId(identity),
    runId: safeId(run?.id),
    subtaskId: safeId(subtaskId),
    category,
    kind,
    title: cleanText(title || kind, MAX_TITLE) || kind,
    status,
    at,
    provenance: cleanText(provenance, 80),
    basis: { summary: '', evidence: [], issues: [] },
    receipt: null,
    receiptStatus: 'not-required',
    links: [],
    artifact: null,
    confidence: confidence(status, category),
  }
}

function addLinks(card, targets) {
  const seen = new Set()
  for (const target of targets) {
    const artifact = artifactDescriptor(target)
    if (!artifact || seen.has(target.identity)) continue
    seen.add(target.identity)
    card.links.push(artifact)
    if (card.links.length >= MAX_LINKS) break
  }
  card.artifact = card.links[0] ?? null
}

function acceptanceCards(run, cards, seenChecks, settings) {
  const rounds = list(run?.goalMode?.rounds, 50)
  const add = (check, round, provenance) => {
    const item = record(check)
    if (!item || seenChecks.has(item)) return
    seenChecks.add(item)
    const source = cleanText(item.source, 32).toLowerCase()
    const reviewer = source === 'reviewer' || source === 'review'
    const category = reviewer ? 'reviewer' : source === 'model' ? 'model' : 'machine'
    const machine = category === 'machine'
    const receipt = machine ? machineReceipt(item, run?.id, round) : optionalReceipt(item.receipt)
    let status
    if (reviewer) {
      const valid = ['pass', 'fail'].includes(item.verdict) && Array.isArray(item.evidence) && Array.isArray(item.issues)
      status = valid ? statusFrom(item.verdict) : 'unverified'
      if (receipt.state === 'invalid') status = 'unverified'
    } else if (typeof item.ok !== 'boolean') {
      status = 'unverified'
    } else {
      status = item.ok ? 'passed' : 'failed'
    }
    const receiptReason = machine && receipt.state !== 'verified'
      ? `machine receipt is ${receipt.state === 'missing' ? 'missing' : 'invalid or unverifiable'}`
      : null
    if (receiptReason || receipt.state === 'invalid' || item.unverified === true) status = 'unverified'
    const identity = ['acceptance', run?.id ?? '', item.id ?? '', round ?? '', item.checkedAt ?? item.at ?? '', item.receipt ?? '', category].join('\0')
    const card = baseCard({
      run, category, kind: machine ? source || 'check' : category === 'model' ? 'acceptance' : 'review',
      identity, title: item.text ?? item.title ?? item.name ?? item.id ?? 'Acceptance check', status,
      at: firstTime(item.checkedAt, item.at, item.finishedAt, run?.finishedAt), subtaskId: item.subtaskId,
      provenance,
    })
    card.receipt = receipt.value
    card.receiptStatus = receipt.state
    const details = []
    if (item.command) details.push(`command: ${cleanText(item.command, 500)}`)
    if (item.path) details.push(`path: ${cleanText(item.path, 500)}`)
    if (Number.isFinite(item.exitCode)) details.push(`exit code: ${item.exitCode}`)
    if (Number.isFinite(item.bytes)) details.push(`bytes: ${Math.max(0, Math.trunc(item.bytes))}`)
    if (item.durationMs !== undefined) details.push(`duration ms: ${cleanText(item.durationMs, 40)}`)
    card.basis.summary = cleanText(item.detail ?? item.reason ?? item.error ?? (status === 'unverified' ? receiptReason ?? 'no usable verdict' : status), MAX_TEXT)
    card.basis.evidence = textList(item.evidence ?? item.output)
    card.basis.issues = textList(item.issues)
    card.basis.details = details.slice(0, MAX_ITEMS)
    const roots = rootsFor(run, settings)
    if (item.path) {
      const target = artifactFor(item.path, roots)
      if (target) addLinks(card, [target])
    }
    card.confidence = confidence(status, category, { reason: receiptReason ?? (reviewer && status === 'unverified' ? 'reviewer verdict schema is invalid' : null), receipt: receipt.state === 'verified', evidence: card.basis.evidence.length > 0 })
    cards.push(card)
  }
  for (let index = 0; index < rounds.length; index++) {
    const entry = record(rounds[index])
    for (const check of list(entry?.checks, 100)) add(check, entry?.round ?? index + 1, 'acceptance-round')
  }
  const acceptance = record(run?.acceptance)
  for (const check of list(acceptance?.checks ?? run?.checks, 100)) add(check, acceptance?.round, 'acceptance')
}

function reviewerCards(run, cards, seenReviews) {
  const add = (review, subtask, provenance) => {
    const item = record(review)
    if (!item || seenReviews.has(item)) return
    seenReviews.add(item)
    const receipt = optionalReceipt(item.receipt)
    const validSchema = Array.isArray(item.evidence) && Array.isArray(item.issues)
      && ['pass', 'fail'].includes(item.verdict)
      && (!item.status || ['pass', 'fail', 'unverified', 'cancelled', 'running', 'invalid'].includes(item.status))
    const consistent = !item.status || item.status === item.verdict
    let status = validSchema && consistent ? statusFrom(item.verdict) : 'unverified'
    if (receipt.state === 'invalid') status = 'unverified'
    const identity = ['reviewer', run?.id ?? '', subtask?.id ?? subtask?.key ?? subtask?.index ?? '', item.childId ?? item.id ?? item.subtaskId ?? '', item.finishedAt ?? item.at ?? ''].join('\0')
    const card = baseCard({
      run, category: 'reviewer', kind: 'review', identity,
      title: item.title ?? subtask?.title ?? item.subtaskId ?? 'Independent review', status,
      at: firstTime(item.finishedAt, item.at, item.checkedAt, subtask?.finishedAt, run?.finishedAt),
      subtaskId: subtask?.id ?? subtask?.key ?? item.subtaskId, provenance,
    })
    card.receipt = receipt.value
    card.receiptStatus = receipt.state
    card.basis.summary = cleanText(item.error ?? item.reason ?? item.summary ?? (status === 'unverified' ? 'invalid or incomplete reviewer result' : `reviewer verdict: ${item.verdict}`), MAX_TEXT)
    card.basis.evidence = textList(item.evidence)
    card.basis.issues = textList(item.issues)
    card.basis.details = [
      ...(item.childId ? [`reviewer child: ${cleanText(item.childId, 180)}`] : []),
      ...(item.model ? [`model: ${cleanText(item.model, 180)}`] : []),
      `recorded status: ${cleanText(item.status ?? item.verdict ?? 'missing', 40)}`,
    ]
    card.confidence = confidence(status, 'reviewer', {
      reason: status === 'unverified' ? 'reviewer result is invalid, inconsistent, cancelled, or has an invalid receipt' : null,
      evidence: card.basis.evidence.length > 0,
    })
    cards.push(card)
  }
  for (const subtask of list(run?.subtasks, 1000)) {
    const task = record(subtask)
    if (!task) continue
    add(task.review, task, 'subtask-review')
    for (const review of list(task.reviews)) add(review, task, 'subtask-review-history')
  }
  for (const review of list(run?.reviews ?? run?.reviewerResults, 1000)) add(review, null, 'run-review')
}

function deliverableCards(run, cards, settings) {
  for (const subtask of list(run?.subtasks, 1000)) {
    const task = record(subtask)
    if (!task) continue
    const root = task.workspace?.dir ?? run?.workspace?.base ?? run?.goalMode?.cwd ?? task.workspace?.base
    const roots = rootsFor({ ...run, workspace: { base: root } }, settings)
    const checked = record(task.deliverableCheck)
    const items = list(checked?.items, 200)
    const declarations = list(task.deliverables, 200)
    const consumed = new Set()
    for (let index = 0; index < items.length; index++) {
      const item = record(items[index])
      if (!item) continue
      consumed.add(cleanText(item.path ?? item.href, MAX_HREF))
      const receipt = receiptValue(item.receipt)
      // Deliverable checks currently have no portable receipt verifier. A plain
      // path or a producer's "verified" label must not be mistaken for one.
      const authenticated = receipt.state === 'present' && item.receiptVerified === true
      let status = statusFrom(item.status)
      if (item.status === 'verified' && !authenticated) status = 'unverified'
      if (item.status === 'failed' && !authenticated) status = 'unverified'
      if (item.status === 'unverified' || receipt.state === 'invalid') status = 'unverified'
      if (!['passed', 'failed', 'unverified', 'recorded'].includes(status)) status = 'unverified'
      const target = artifactFor(item.path ?? item.href, roots)
      const identity = ['deliverable', run?.id ?? '', task.id ?? task.key ?? task.index ?? '', item.path ?? item.href ?? '', checked?.at ?? '', index].join('\0')
      const card = baseCard({
        run, category: 'machine', kind: 'deliverable', identity,
        title: item.name ?? item.path ?? item.href ?? 'Declared deliverable', status,
        at: firstTime(item.at, item.checkedAt, checked?.at, task.finishedAt, run?.finishedAt),
        subtaskId: task.id ?? task.key, provenance: 'deliverable-check',
      })
      card.receipt = receipt.value
      card.receiptStatus = authenticated ? 'verified' : receipt.state === 'present' ? 'unverifiable' : receipt.state
      card.basis.summary = cleanText(item.reason ?? item.detail ?? item.code ?? item.status ?? 'no deliverable check result', MAX_TEXT)
      card.basis.evidence = textList(item.evidence)
      card.basis.issues = status === 'failed' ? [card.basis.summary].filter(Boolean) : []
      card.basis.details = [
        `producer status: ${cleanText(item.status ?? 'missing', 40)}`,
        ...(Number.isFinite(item.bytes) ? [`bytes: ${Math.max(0, Math.trunc(item.bytes))}`] : []),
        ...(item.code ? [`code: ${cleanText(item.code, 80)}`] : []),
      ]
      if (target) addLinks(card, [target])
      card.confidence = confidence(status, 'machine', {
        receipt: authenticated,
        reason: status === 'unverified' ? 'deliverable receipt is missing, invalid, or has no verifier' : null,
      })
      cards.push(card)
    }
    for (const declaration of declarations) {
      const item = typeof declaration === 'string' ? { path: declaration } : record(declaration)
      const raw = cleanText(item?.path ?? item?.href, MAX_HREF)
      if (!raw || consumed.has(raw)) continue
      const target = artifactFor(raw, roots)
      const identity = ['deliverable-declaration', run?.id ?? '', task.id ?? task.key ?? task.index ?? '', raw].join('\0')
      const card = baseCard({
        run, category: 'machine', kind: 'deliverable', identity, title: item?.name ?? raw,
        status: 'unverified', at: firstTime(task.finishedAt, run?.finishedAt), subtaskId: task.id ?? task.key,
        provenance: 'deliverable-declaration',
      })
      card.receiptStatus = 'missing'
      card.basis.summary = 'Declared deliverable has no recorded verification receipt; the declaration is not proof of delivery.'
      card.basis.details = [`declared path: ${cleanText(raw, 500)}`, ...(item?.minBytes !== undefined ? [`minimum bytes: ${cleanText(item.minBytes, 40)}`] : [])]
      if (target) addLinks(card, [target])
      card.confidence = confidence('unverified', 'machine', { reason: 'declared deliverable has no verification receipt' })
      cards.push(card)
    }
  }
}

function sourceCards(context, cards, sourceMap) {
  const { run, roots, report, citations, links, sources, artifacts, provenance, at } = context
  const reportRecord = record(report)
  const reportCitations = [...citations, ...list(reportRecord?.citations)]
  const reportLinks = [...links, ...list(reportRecord?.links)]
  const add = (raw, kind = 'link') => {
    const item = typeof raw === 'string' ? { href: raw } : record(raw)
    if (!item) return
    const target = artifactFor(item.href ?? item.url ?? item.path ?? item.link ?? item.sourceUrl ?? item.target, roots)
    if (!target) return
    const runKey = safeId(run?.id) ?? ''
    const key = `${runKey}\0${target.identity}`
    const existing = sourceMap.get(key)
    const receipt = optionalReceipt(item.receipt)
    const sourceProvenance = kind === 'report-link' ? `${provenance},report-link` : kind === 'citation' ? `${provenance},citation` : provenance
    if (existing) {
      const tags = new Set(existing.provenance.split(','))
      for (const tag of sourceProvenance.split(',')) {
        if (!tags.has(tag)) {
          existing.provenance += `,${tag}`
          tags.add(tag)
        }
      }
      existing.basis.evidence = [...new Set([...existing.basis.evidence, ...textList(item.claim ?? item.quote ?? item.description, 2, 300)])].slice(0, MAX_ITEMS)
      existing.at = firstTime(item.at, item.publishedAt, existing.at, at)
      if (statusFrom(item.status, 'recorded') === 'failed') existing.status = 'failed'
      if (receipt.state === 'invalid') {
        existing.status = 'unverified'
        existing.receiptStatus = 'invalid'
      }
      existing.confidence = confidence(existing.status, 'source', { reason: existing.status === 'unverified' ? 'source receipt is invalid' : null })
      return
    }
    let status = statusFrom(item.status ?? item.result, 'recorded')
    // A reachable URL or a successful fetch is not a successful quality check.
    if (status === 'passed' || item.verified === true) status = 'recorded'
    if (receipt.state === 'invalid') status = 'unverified'
    const identity = ['source', runKey, target.identity].join('\0')
    const card = baseCard({
      run, category: 'source', kind: cleanText(item.kind ?? kind, 48) || 'link', identity,
      title: item.title ?? item.label ?? item.name ?? target.href, status,
      at: firstTime(item.at, item.publishedAt, item.retrievedAt, at), subtaskId: item.subtaskId,
      provenance: sourceProvenance,
    })
    card.receipt = receipt.value
    card.receiptStatus = receipt.state
    card.basis.summary = cleanText(item.claim ?? item.description ?? item.summary ?? item.reason ?? 'Referenced source; the link itself is not a quality verdict.', MAX_TEXT)
    card.basis.evidence = textList(item.evidence ?? (typeof item.quote === 'string' ? [item.quote] : item.quote))
    card.basis.issues = textList(item.issues)
    card.basis.details = [
      ...(item.publisher ? [`publisher: ${cleanText(item.publisher, 180)}`] : []),
      ...(item.author ? [`author: ${cleanText(item.author, 180)}`] : []),
      ...(target.credentialsRedacted ? ['URL credentials were redacted'] : []),
    ]
    addLinks(card, [target])
    card.confidence = confidence(status, 'source', { reason: status === 'unverified' ? 'source receipt is invalid' : null })
    sourceMap.set(key, card)
    cards.push(card)
  }
  for (const citation of reportCitations) add(citation, 'citation')
  for (const link of reportLinks) add(link, 'link')
  for (const source of sources) add(source, 'source')
  for (const artifact of artifacts) add(artifact, 'artifact')
  for (const link of markdownLinks(reportText(report))) add({ href: link.raw, title: link.label }, 'report-link')
}

function looksLikeArtifactTarget(value) {
  const raw = String(value ?? '').trim()
  return Boolean(raw) && (/^https?:\/\//i.test(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)
    || /^\.{1,2}[\\/]/.test(raw) || /[\\/]/.test(raw) || FILE_EXTENSION.test(raw))
}

function auditCards(run, events, cards, settings = {}) {
  for (const event of list(events, MAX_INPUT_ITEMS)) {
    const item = record(event)
    if (!item) continue
    const receipt = optionalReceipt(item.receipt)
    let status = statusFrom(item.result ?? item.status, 'recorded')
    if (status === 'passed') status = 'recorded'
    if (item.decision === 'deny') status = 'failed'
    if (item.decision === 'confirm' && status === 'recorded') status = 'recorded'
    if (receipt.state === 'invalid') status = 'unverified'
    const identity = ['audit', run?.id ?? item.runId ?? '', item.id ?? '', item.at ?? '', item.kind ?? '', item.action ?? ''].join('\0')
    const card = baseCard({
      run: { ...run, id: run?.id ?? item.runId }, category: 'source', kind: 'audit', identity,
      title: item.action ?? item.kind ?? 'Audit event', status,
      at: firstTime(item.at, item.timestamp, item.time), subtaskId: item.subtaskId, provenance: 'audit',
    })
    card.receipt = receipt.value
    card.receiptStatus = receipt.state
    card.basis.summary = cleanText(record(item.meta)?.reason ?? item.reason ?? `${item.kind ?? 'event'}: ${item.result ?? item.status ?? 'recorded'}`, MAX_TEXT)
    card.basis.evidence = []
    card.basis.issues = status === 'failed' ? [cleanText(record(item.meta)?.reason ?? item.reason ?? card.basis.summary, MAX_TEXT)].filter(Boolean) : []
    card.basis.details = [
      ...(item.actor ? [`actor: ${cleanText(item.actor, 180)}`] : []),
      ...(item.decision ? [`decision: ${cleanText(item.decision, 40)}`] : []),
      ...(item.rule ? [`rule: ${cleanText(item.rule, 180)}`] : []),
      ...(Number.isFinite(item.durationMs) ? [`duration ms: ${Math.max(0, Math.trunc(item.durationMs))}`] : []),
    ]
    const roots = rootsFor(run, settings)
    const target = looksLikeArtifactTarget(item.target) ? artifactFor(item.target, roots) : null
    if (target) addLinks(card, [target])
    card.confidence = confidence(status, 'source', { audit: true, reason: status === 'unverified' ? 'audit receipt is invalid' : null })
    cards.push(card)
  }
}

function globalSourceCards(input, options, cards, sourceMap) {
  const roots = rootsFor(null, options)
  sourceCards({
    run: { id: options.runId ?? null }, roots, report: options.report ?? input.report,
    citations: [...list(options.citations), ...input.citations], links: [...list(options.links), ...input.links],
    sources: [...list(options.sources), ...input.sources], artifacts: [],
    provenance: 'report', at: null,
  }, cards, sourceMap)
}

function sortCards(cards) {
  const rank = status => status === 'failed' ? 0 : status === 'unverified' ? 1 : status === 'passed' ? 2 : 3
  return cards.sort((left, right) => {
    const l = Date.parse(left.at ?? '') || 0
    const r = Date.parse(right.at ?? '') || 0
    return r - l || rank(left.status) - rank(right.status) || CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category] || left.id.localeCompare(right.id)
  })
}

/**
 * Aggregate evidence cards from one run, an array of runs, or a bundle.
 *
 * @param {object|object[]} input - A run, runs, or `{runs, auditEvents, report,
 *   citations, links, sources, reviewers}`. Inputs are treated as untrusted data.
 * @param {object} [options]
 * @param {number} [options.limit=100] - Maximum returned cards (0..500). Counts
 *   and truncation are reported before this cap is applied.
 * @param {string|string[]} [options.allowedRoots] - Explicit local-link boundary.
 *   Without it, each run's workspace/goal directory is used.
 * @param {string} [options.runId] - Scope audit events and bundle-level sources.
 * @param {'machine'|'model'|'reviewer'|'source'} [options.category] - Optional filter.
 * @param {'passed'|'failed'|'unverified'|'recorded'} [options.status] - Optional filter.
 * @returns {{cards: object[], summary: object, confidencePolicy: object}}
 */
export function buildEvidenceCenter(input = {}, options = {}) {
  const settings = record(options) ?? {}
  const limit = limitValue(settings.limit)
  if (settings.category && !EVIDENCE_CATEGORIES.includes(settings.category)) throw new RangeError(`unknown evidence category: ${settings.category}`)
  if (settings.status && !EVIDENCE_STATUSES.includes(settings.status)) throw new RangeError(`unknown evidence status: ${settings.status}`)
  const bundle = normalizeInput(input)
  const cards = []
  const sourceMap = new Map()
  const seenChecks = new WeakSet()
  const seenReviews = new WeakSet()
  const runsById = new Map(bundle.runs.map(run => [safeId(record(run)?.id), record(run)]).filter(([id]) => Boolean(id)))
  const runIds = new Set(runsById.keys())
  const scopedRunId = safeId(settings.runId ?? bundle.runId)

  for (const rawRun of bundle.runs) {
    const run = record(rawRun)
    if (!run) continue
    if (scopedRunId && safeId(run.id) !== scopedRunId) continue
    acceptanceCards(run, cards, seenChecks, settings)
    reviewerCards(run, cards, seenReviews)
    deliverableCards(run, cards, settings)
    sourceCards({
      run, roots: rootsFor(run, settings), report: run.report ?? run.output,
      citations: list(run.citations ?? run.reportCitations), links: list(run.reportLinks ?? run.links),
      sources: list(run.sources), artifacts: list(run.artifacts), provenance: 'run', at: firstTime(run.finishedAt, run.createdAt),
    }, cards, sourceMap)
    auditCards(run, eventList(run.auditEvents), cards, settings)
  }

  const extraEvents = [...eventList(settings.auditEvents), ...bundle.auditEvents]
  const knownEvents = []
  const anonymousEvents = []
  for (const event of extraEvents) {
    const item = record(event)
    if (!item) continue
    const eventRunId = safeId(item.runId)
    if (scopedRunId && eventRunId !== scopedRunId) continue
    if (eventRunId && runIds.has(eventRunId)) knownEvents.push(item)
    else if (!eventRunId || runIds.size === 0) anonymousEvents.push(item)
    // Events belonging to a run outside the selected bundle are not authorised
    // merely because they happened to share the same audit file.
  }
  for (const runId of runIds) {
    const events = knownEvents.filter(event => safeId(event.runId) === runId)
    if (events.length > 0) auditCards(runsById.get(runId), events, cards, settings)
  }
  if (anonymousEvents.length > 0) auditCards({ id: scopedRunId }, anonymousEvents, cards, settings)
  for (const review of bundle.reviewers) {
    const item = record(review)
    if (!item || (scopedRunId && safeId(item.runId) !== scopedRunId)) continue
    if (runIds.size > 0 && safeId(item.runId) && !runIds.has(safeId(item.runId))) continue
    reviewerCards({ id: item.runId ?? scopedRunId, reviews: [item] }, cards, seenReviews)
  }
  globalSourceCards(bundle, settings, cards, sourceMap)

  // Clones of the same check/link can arrive through both a durable run and its
  // console projection. Keep the richest card without counting it twice.
  const deduped = new Map()
  for (const card of cards) {
    const previous = deduped.get(card.id)
    if (!previous) {
      deduped.set(card.id, card)
      continue
    }
    previous.provenance = [...new Set(previous.provenance.split(',').concat(card.provenance.split(',')))].join(',')
    previous.basis.evidence = [...new Set([...previous.basis.evidence, ...card.basis.evidence])].slice(0, MAX_ITEMS)
    previous.basis.issues = [...new Set([...previous.basis.issues, ...card.basis.issues])].slice(0, MAX_ITEMS)
    previous.links = [...new Map([...previous.links, ...card.links].map(item => [item.href, item])).values()].slice(0, MAX_LINKS)
    previous.artifact = previous.links[0] ?? card.artifact
    if (card.status === 'failed' || (card.status === 'unverified' && previous.status !== 'failed')) previous.status = card.status
    previous.confidence = confidence(previous.status, previous.category, {
      receipt: previous.receiptStatus === 'verified', evidence: previous.basis.evidence.length > 0,
      audit: previous.kind === 'audit', reason: previous.status === 'unverified' ? 'merged evidence contains an unverified result' : null,
    })
  }
  const matched = sortCards([...deduped.values()])
    .filter(card => (!settings.category || card.category === settings.category) && (!settings.status || card.status === settings.status))
  const returned = matched.slice(0, limit)
  const byCategory = Object.fromEntries(EVIDENCE_CATEGORIES.map(category => [category, 0]))
  const byStatus = Object.fromEntries(EVIDENCE_STATUSES.map(status => [status, 0]))
  for (const card of matched) {
    byCategory[card.category]++
    byStatus[card.status]++
  }
  return {
    cards: returned,
    summary: {
      total: matched.length,
      returned: returned.length,
      omitted: matched.length - returned.length,
      truncated: matched.length > returned.length,
      byCategory,
      byStatus,
    },
    confidencePolicy: {
      method: 'explicit-rules',
      probability: false,
      levels: ['verified', 'reviewed', 'limited', 'model-judged', 'referenced', 'recorded', 'none'],
      explanation: 'Confidence is a qualitative label for the evidence on each card, selected only by its listed rules. No probabilities are estimated and cards are not combined into a success score.',
    },
  }
}

/** Convenient alias for callers that name the action rather than the view. */
export const collectEvidenceCards = buildEvidenceCenter
