/**
 * dsh-superagent — a loopback conversation console.
 *
 * The page is a real conversation against a host Session (`sessionController`)
 * and a live run panel beside it. This module owns the socket, the one-time
 * token, the Host header check, and the SSE fan-out; it does not invent an
 * assistant. When the host exposes no conversation session API the page says so
 * and never pretends to be a chat.
 *
 * @module dsh-superagent/console
 */
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createServer, request } from 'node:http'
import path from 'node:path'
import { isInside } from './memory.js'
import {
  errorPayload,
  readJson,
  sameToken,
  send,
  sendText,
  statusFor,
  WorkbenchError,
} from './workbench.js'
import { isBatchMessage, MAX_BATCH_TEXT } from './router.js'

const DISCOVERY_FILE = 'console.json'
// The conversation the page was last showing is the only thing the console has
// to remember across a host restart: messages and runs are both durable on the
// host side, but neither can be found again without this id.
const TIMELINE_FILE = 'console-timeline.json'
const MAX_CLIENTS = 16
const MAX_TEXT = 20_000
const MAX_FRAME_BYTES = 512 * 1024
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const MAX_RECORDS = 400
const MAX_RECORD_BYTES = 1024 * 1024
const HEARTBEAT_MS = 15_000
const RUN_POLL_MS = 1_200
// A short delay keeps a streamed turn from rewriting the timeline per token.
const TIMELINE_SAVE_MS = 400
// The remembered transcript is a lean window on disk, not a second log: keep the
// most recent turns only, and let the host's runs and artifacts carry the rest.
const TIMELINE_MAX_RECORDS = 120
const TIMELINE_MAX_BYTES = 160 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const ROUTE_HINT = 'GET / serves the console; the JSON API is under /api/console.'
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
// A file dropped on the composer is copied into the conversation's own
// workspace. The cap is generous for a screenshot or a deck, small enough that
// a stray folder cannot fill the disk through the page.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
// base64 inflates the payload by about a third; the JSON wrapper needs a little
// more room than the decoded file itself.
const UPLOAD_BODY_LIMIT = 12 * 1024 * 1024
const UPLOAD_DIR = '.superagent/uploads'
const UPLOAD_TYPES = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.pdf', '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.yml', '.yaml', '.xml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf',
  '.zip', '.tar', '.gz', '.7z',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.css', '.html', '.htm', '.sql', '.sh',
  '.ps1', '.toml', '.ini', '.ipynb',
])
const UPLOAD_TYPES_TEXT = '图片、PDF、Markdown/文本、CSV/JSON、Office 文档、压缩包或代码文件'
// Which notices a person already read. The notices themselves are derived from
// durable runs on every load, so reopening the page after a run finished shows
// "跑完了" without this file having to hold a second copy of the run history.
const NOTICE_FILE = 'console-notices.json'
const MAX_READ_NOTICES = 200

/** Types the console may preview inline; anything else is refused, not sniffed. */
const ARTIFACT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.csv', 'text/plain; charset=utf-8'],
  ['.tsv', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.yml', 'text/plain; charset=utf-8'],
  ['.yaml', 'text/plain; charset=utf-8'],
  ['.py', 'text/plain; charset=utf-8'],
  ['.js', 'text/plain; charset=utf-8'],
  ['.mjs', 'text/plain; charset=utf-8'],
  ['.css', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
])

// The host seats this page in its main panel, so the page has to name the
// framing origin in `frame-ancestors`. A desktop shell serves its chrome from a
// custom scheme (`dsh-app://app` today); CSP has no wildcard that covers
// "whatever scheme the shell uses", so the list is the loopback origins plus the
// scheme in use, and the client half reports the page's own `protocol//host` on
// `parent` — a scheme change then needs no new release here.
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
const BASE_FRAME_ANCESTORS = Object.freeze([
  "'self'",
  'http://127.0.0.1:*',
  'http://localhost:*',
  'http://[::1]:*',
  'dsh-app:',
])
// One source expression, nothing else: a scheme, optionally followed by `//host`.
// No quotes, spaces, semicolons or commas can slip through into the header.
const ANCESTOR_TOKEN = /^[a-z][a-z0-9+.-]*:(?:\/\/[a-z0-9._~%\-[\]:]+)?$/i

/**
 * Turn the `parent` hint from the client half into one CSP source expression.
 *
 * Only two kinds of framer are legitimate: the loopback page the web profile
 * serves, and the desktop shell's own non-http(s) scheme. An http(s) parent that
 * is not loopback is refused, so a page on the internet cannot seat itself
 * around the token even if the token leaked into a link.
 *
 * @param {string} reported - the framing page's `protocol//host`, or ''.
 * @returns {string} a source expression, or '' when the value is not usable.
 */
function ancestorSource(reported) {
  const raw = reported.trim()
  if (!raw || raw.length > 200 || !ANCESTOR_TOKEN.test(raw)) return ''
  let url = null
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (!url.hostname) return ''
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if ((scheme === 'http' || scheme === 'https') && !LOOPBACK_NAMES.has(url.hostname)) return ''
  return `${url.protocol}//${url.host}`
}

/**
 * An artifact page runs with an opaque origin so its scripts cannot reach the
 * console's token or storage, while still rendering its own styles and CDNs.
 */
const ARTIFACT_PAGE_CSP = "sandbox allow-scripts allow-popups allow-forms; default-src 'none'; "
  + "script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; "
  + "img-src data: https:; font-src data: https:; connect-src https:; media-src https: data:"

/** @param {unknown} value @returns {string} */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Cap one SSE frame. A large history snapshot must not let one write pin the
 * socket or grow without bound; the page is told what was dropped instead.
 *
 * @param {object} frame - frame produced by the host adapter.
 * @returns {object} a JSON-safe frame, or a truncation marker.
 */
function boundedFrame(frame) {
  if (!frame || typeof frame !== 'object') return { type: 'error', code: 'bad-frame' }
  let text
  try {
    text = JSON.stringify(frame)
  } catch (error) {
    return { type: 'error', code: 'unserializable-frame', message: messageOf(error) }
  }
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_FRAME_BYTES) {
    return {
      type: 'truncated',
      frameType: typeof frame.type === 'string' ? frame.type : 'unknown',
      bytes,
      limit: MAX_FRAME_BYTES,
    }
  }
  return frame
}

/**
 * Cap the opening history by trimming its oldest records rather than replacing
 * the whole frame: a long conversation must still show what just happened.
 *
 * @param {object} frame - `stream.snapshot` frame from the host adapter.
 * @returns {object} a frame that fits one SSE write.
 */
function boundedSnapshot(frame) {
  let records = Array.isArray(frame.records) ? frame.records.slice() : []
  let dropped = Number.isInteger(frame.droppedRecords) ? frame.droppedRecords : 0
  const build = () => ({
    ...frame,
    records,
    ...(dropped > 0 ? { droppedRecords: dropped } : {}),
  })
  let text = JSON.stringify(build())
  while (Buffer.byteLength(text) > MAX_FRAME_BYTES && records.length > 0) {
    const cut = Math.max(1, Math.ceil(records.length / 4))
    records = records.slice(cut)
    dropped += cut
    text = JSON.stringify(build())
  }
  return Buffer.byteLength(text) > MAX_FRAME_BYTES ? boundedFrame(frame) : build()
}

/**
 * Create one loopback console.
 *
 * @param {object} options - dependencies.
 * @param {number} options.port - 1–65535, or 0 for an ephemeral port.
 * @param {string} options.stateRoot - plugin state directory for the discovery file.
 * @param {object} options.host - host adapter; see README.
 * @param {string} options.version - plugin version reported by `/api/health`.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 * @param {number} [options.maxUploadBytes] - per-file cap for dropped files.
 */
export function createConsole({
  port,
  stateRoot,
  host,
  router = null,
  version,
  log = () => {},
  maxUploadBytes = MAX_UPLOAD_BYTES,
}) {
  if (!host || typeof host !== 'object') throw new Error('createConsole needs a host adapter')
  const token = randomBytes(32).toString('base64url')
  const instanceId = randomBytes(6).toString('hex')
  const discoveryPath = path.join(stateRoot, DISCOVERY_FILE)
  const timelinePath = path.join(stateRoot, TIMELINE_FILE)
  const noticePath = path.join(stateRoot, NOTICE_FILE)
  const uploadLimit = Number.isFinite(maxUploadBytes) && maxUploadBytes > 0
    ? Math.floor(maxUploadBytes)
    : MAX_UPLOAD_BYTES
  const noticeRead = new Set()
  let noticeSave = Promise.resolve()
  const startedAt = new Date().toISOString()
  const clients = new Set()
  // Approval questions raised inside this conversation wait here until the open
  // page answers them. Nothing resolves on its own: a page that never answers
  // fails closed to `cancelled`, and no path grants a call without a decision.
  const approvals = new Map()
  // Tools the person chose to let through for the rest of this conversation.
  // The host only grants one call at a time, so this list is the console's own
  // scope, cleared whenever the conversation changes.
  const sessionAllowedTools = new Set()
  let boundPort = null
  let server = null
  let page = null
  let starting = null
  let closing = null
  let stopRequested = false
  let stopRouterEvents = null
  const timeline = router ? { sessionId: null, records: [] } : readTimeline()
  let currentSessionId = timeline.sessionId
  // Only a remembered conversation is forgotten on failure: a fresh one that
  // cannot stream should stay, so the next message resumes it instead of
  // silently starting another.
  let rememberedSessionId = currentSessionId
  let unsubscribe = null
  let runTimer = null
  let lastRuns = null
  let lastGoals = []
  let lastRunsJson = ''
  let seq = 0
  // The host's follow opening is not a reliable transcript: after a turn its
  // snapshot can come back with only the session's setup records, so a
  // reconnect that trusted it showed an empty conversation. Keep our own
  // bounded copy of the durable session events and rebuild the opening window
  // from it instead.
  const store = {
    sessionId: null,
    header: null,
    cursor: -1,
    dropped: 0,
    entries: [],
    bytes: 0,
    seen: new Set(),
  }
  let timelineTimer = null
  let timelineOversized = false
  if (currentSessionId) {
    // Seeding before any client attaches is what makes the first opening after
    // a restart carry the same words the last one did. The store belongs to the
    // remembered conversation even when it had no transcript yet.
    store.sessionId = currentSessionId
    if (timeline.records.length > 0) mergeRecords(timeline.records)
    // A file written by an older build can exceed the bound this one enforces.
    // Rewrite it once at startup so the "bounded timeline" claim holds on disk,
    // not only for writes that follow a new turn.
    timelineOversized = store.dropped > 0
      || timeline.records.length > TIMELINE_MAX_RECORDS
      || timeline.records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0) > TIMELINE_MAX_BYTES
  }
  loadNoticeRead()

  const url = () => `http://127.0.0.1:${boundPort}`
  const allowedHosts = () => new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  ])

  function capabilities() {
    try {
      const value = host.capabilities()
      if (!value || typeof value !== 'object') return { chat: false, reason: 'the host returned no capabilities' }
      return {
        chat: value.chat === true,
        reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null,
      }
    } catch (error) {
      return { chat: false, reason: `cannot read host capabilities: ${messageOf(error)}` }
    }
  }

  /**
   * The conversation the page last showed, read back after a restart so the
   * console reopens the same conversation instead of an empty one. The host
   * keeps runs and messages durable, but its follow opening does not replay the
   * messages after a restart, so the transcript window travels here too. A
   * missing or damaged file is simply "nothing remembered" — history is never
   * invented.
   *
   * @returns {{sessionId: string|null, records: Array<object>}} what to reopen.
   */
  function readTimeline() {
    try {
      const parsed = JSON.parse(readFileSync(timelinePath, 'utf8'))
      const sessionId = typeof parsed?.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : null
      const records = Array.isArray(parsed?.records) ? parsed.records : []
      return { sessionId, records: sessionId ? records : [] }
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`console: cannot read ${timelinePath}: ${messageOf(error)}`)
      return { sessionId: null, records: [] }
    }
  }

  /**
   * Remember the session the page shows and the transcript it shows there. The
   * write is debounced and bounded; a failure is logged, never fatal.
   *
   * @param {boolean} [immediate] - write now instead of on the next tick.
   * @returns {Promise<void>|undefined} the write when immediate, so a stop can wait.
   */
  function saveTimeline(immediate = false) {
    if (timelineTimer && immediate) {
      clearTimeout(timelineTimer)
      timelineTimer = null
    }
    if (!immediate) {
      if (timelineTimer) return
      timelineTimer = setTimeout(() => {
        timelineTimer = null
        saveTimeline(true)
      }, TIMELINE_SAVE_MS)
      timelineTimer.unref?.()
      return
    }
    const tidied = []
    let bytes = 0
    const owned = !store.sessionId || store.sessionId === currentSessionId
    for (let index = owned ? store.entries.length - 1 : -1; index >= 0; index -= 1) {
      const record = store.entries[index].record
      const size = Buffer.byteLength(JSON.stringify(record))
      if (tidied.length >= TIMELINE_MAX_RECORDS || bytes + size > TIMELINE_MAX_BYTES) break
      tidied.unshift(record)
      bytes += size
    }
    const body = `${JSON.stringify({
      version: 1,
      sessionId: currentSessionId,
      savedAt: new Date().toISOString(),
      records: tidied,
    })}\n`
    const tmp = `${timelinePath}.${process.pid}.tmp`
    // The state directory may not exist yet when a stop flushes the timeline
    // during startup, so create it instead of failing the flush with ENOENT.
    return fsp.mkdir(path.dirname(timelinePath), { recursive: true })
      .then(() => fsp.writeFile(tmp, body, 'utf8'))
      .then(() => replaceTimeline(tmp))
      .catch(error => log(`console: cannot save ${timelinePath}: ${messageOf(error)}`))
  }

  /**
   * Swap the finished timeline file into place. Windows refuses the rename
   * while another handle still holds the target open, so a plain rename turns
   * an ordinary concurrent read into a lost-history write. Retrying briefly is
   * the whole fix; a real filesystem error still surfaces to the caller.
   *
   * @param {string} tmp - fully written temporary file beside the target.
   * @param {string} [target] - destination; the timeline file by default.
   * @returns {Promise<void>} resolves once the target holds the new bytes.
   */
  async function replaceTimeline(tmp, target = timelinePath) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, target)
        return
      } catch (error) {
        const transient = error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY'
        if (!transient || attempt >= 4) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
      }
    }
  }

  /** Remembered notice ids, so a badge does not come back after a reload. */
  function loadNoticeRead() {
    try {
      const parsed = JSON.parse(readFileSync(noticePath, 'utf8'))
      for (const id of Array.isArray(parsed?.read) ? parsed.read : []) {
        if (typeof id === 'string' && id.trim()) noticeRead.add(id.trim())
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`console: cannot read ${noticePath}: ${messageOf(error)}`)
    }
  }

  /**
   * Persist the read set. It is bounded, so a console used for months cannot
   * grow the file without limit; the oldest ids fall off first.
   *
   * @returns {Promise<void>} resolves once the file is replaced (or the failure logged).
   */
  function saveNoticeRead() {
    const ids = [...noticeRead].slice(-MAX_READ_NOTICES)
    noticeRead.clear()
    for (const id of ids) noticeRead.add(id)
    const tmp = `${noticePath}.${process.pid}.tmp`
    noticeSave = noticeSave.then(async () => {
      await fsp.mkdir(path.dirname(noticePath), { recursive: true })
      await fsp.writeFile(tmp, `${JSON.stringify({ version: 1, read: ids })}\n`, 'utf8')
      await replaceTimeline(tmp, noticePath)
    }).catch(error => {
      log(`console: cannot save ${noticePath}: ${messageOf(error)}`)
    })
    return noticeSave
  }

  function authorize(req, { allowQuery = false } = {}) {
    if (!boundPort) {
      throw new WorkbenchError(503, 'the console is not listening yet', { id: 'not-ready' })
    }
    const hostHeader = String(req.headers.host ?? '').toLowerCase()
    if (!allowedHosts().has(hostHeader)) {
      throw new WorkbenchError(403, `unexpected Host header "${hostHeader}"; the console answers only on 127.0.0.1 and localhost`, {
        id: 'forbidden-host',
        hint: `open ${url()} directly.`,
      })
    }
    const header = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    let given = match?.[1] ?? ''
    if (!given && allowQuery) {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
      if (query) given = query
    }
    if (!given || !sameToken(given, token)) {
      throw new WorkbenchError(401, 'missing or wrong access token', {
        id: 'unauthorized',
        hint: `read the "token" field in ${discoveryPath}, then open "url?token=<token>" once. `
          + 'The token is regenerated each time the host starts.',
      })
    }
  }

  function nextSeq() {
    seq += 1
    return seq
  }

  function writeFrame(res, frame) {
    if (res.destroyed || res.writableEnded) return false
    const body = JSON.stringify(frame)
    res.write(`event: console\ndata: ${body}\n\n`)
    // A `false` return is ordinary backpressure, not a dead socket. The socket
    // keeps the bytes; only a tab that let its buffer grow past the cap is
    // dropped, so one stalled reader cannot pin memory for everyone.
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      log(`console: dropping a stream that stopped reading (${res.writableLength} bytes buffered)`)
      res.destroy()
      clients.delete(res)
      return false
    }
    return true
  }

  function broadcast(frame) {
    const withSeq = { ...boundedFrame(frame), seq: nextSeq(), at: new Date().toISOString() }
    for (const res of clients) {
      try {
        writeFrame(res, withSeq)
      } catch {
        clients.delete(res)
      }
    }
    return withSeq
  }

  /**
   * Put one host approval question to the open page and wait for its answer.
   * No client, a closed stream, or a timeout all fail closed to `cancelled`, so
   * a blocked call is never granted without a person deciding it here.
   *
   * @param {object} request - approval question projected for display.
   * @param {string} [request.toolName] - the tool asking for the decision.
   * @param {string|null} [request.callId] - the exact tool call, when known.
   * @param {string|null} [request.reason] - the asker's own explanation.
   * @param {object|null} [request.displayReason] - localized copy of it.
   * @param {string|null} [request.agentId] - agent that asked, for mapping to a lane.
   * @param {string|null} [request.source] - short human label for that agent.
   * @param {string|null} [request.callArguments] - the blocked call's raw arguments, so the page can name the path.
   * @returns {Promise<'allowed-once'|'rejected'|'cancelled'>} the decision.
   */
  function askApproval(request = {}) {
    if (!router && clients.size === 0) return Promise.resolve('cancelled')
    const toolName = typeof request.toolName === 'string' && request.toolName ? request.toolName : 'tool'
    const ownerSessionId = request.ownerSessionId ?? currentSessionId
    if (ownerSessionId === currentSessionId && sessionAllowedTools.has(toolName)) {
      broadcast({ type: 'approval', action: 'auto', toolName })
      return Promise.resolve('allowed-once')
    }
    const id = `ap_${randomBytes(6).toString('hex')}`
    const askedAt = Date.now()
    const payload = {
      id,
      toolName,
      callId: request.callId ?? null,
      callArguments: typeof request.callArguments === 'string' ? request.callArguments.slice(0, 4000) : null,
      reason: typeof request.reason === 'string' ? request.reason : null,
      displayReason: request.displayReason && typeof request.displayReason === 'object'
        ? request.displayReason
        : null,
      agentId: request.agentId ?? null,
      ownerSessionId,
      source: request.source ?? null,
      askedAt: new Date(askedAt).toISOString(),
      expiresAt: new Date(askedAt + APPROVAL_TIMEOUT_MS).toISOString(),
    }
    return new Promise(resolve => {
      const settle = outcome => {
        const pending = approvals.get(id)
        if (!pending) return
        approvals.delete(id)
        if (pending.timer) clearTimeout(pending.timer)
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        if (!approvals.has(id)) return
        settle('cancelled')
        broadcast({ type: 'approval', action: 'expired', id })
      }, APPROVAL_TIMEOUT_MS)
      timer.unref?.()
      approvals.set(id, { payload, timer, settle })
      broadcast({ type: 'approval', action: 'asked', approval: payload })
    })
  }

  function resetStore(sessionId = null) {
    store.sessionId = sessionId
    store.header = null
    store.cursor = -1
    store.dropped = 0
    store.entries = []
    store.bytes = 0
    store.seen = new Set()
  }

  /**
   * Add durable records to the transcript window, skipping ones already held.
   *
   * @param {Array<object>} records - `SessionHistoryRecord`s from the host.
   * @returns {number} how many records were new.
   */
  function mergeRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return 0
    let added = 0
    for (const record of records) {
      const eventSeq = record?.type === 'event' ? record.event?.seq : undefined
      if (Number.isInteger(eventSeq)) {
        if (store.seen.has(eventSeq)) continue
        store.seen.add(eventSeq)
        if (eventSeq > store.cursor) store.cursor = eventSeq
      }
      const size = Buffer.byteLength(JSON.stringify(record))
      store.entries.push({ record, seq: Number.isInteger(eventSeq) ? eventSeq : -1, size })
      store.bytes += size
      added += 1
    }
    if (!added) return 0
    store.entries.sort((left, right) => left.seq - right.seq)
    while (store.entries.length > MAX_RECORDS || (store.bytes > MAX_RECORD_BYTES && store.entries.length > 1)) {
      const entry = store.entries.shift()
      store.bytes -= entry.size
      if (entry.seq >= 0) store.seen.delete(entry.seq)
      store.dropped += 1
    }
    return added
  }

  function transcriptFrame() {
    if (!store.sessionId || store.entries.length === 0) return null
    return {
      type: 'stream.snapshot',
      header: store.header ?? { id: store.sessionId },
      cursor: store.cursor,
      records: store.entries.map(entry => entry.record),
      hasMore: false,
      ...(store.dropped > 0 ? { droppedRecords: store.dropped } : {}),
    }
  }

  function detach() {
    if (runTimer) {
      clearInterval(runTimer)
      runTimer = null
    }
    if (typeof unsubscribe === 'function') {
      try {
        unsubscribe()
      } catch (error) {
        log(`console: cannot stop the session stream: ${messageOf(error)}`)
      }
    }
    unsubscribe = null
    lastRuns = null
    lastGoals = []
    lastRunsJson = ''
  }

  async function refreshRuns({ force = false } = {}) {
    const sessionId = currentSessionId
    if (!sessionId) return []
    let runs
    let goals
    try {
      const rows = await Promise.all([host.listRuns(sessionId), host.listGoals?.(sessionId) ?? []])
      runs = rows[0]
      goals = rows[1]
    } catch (error) {
      log(`console: cannot list runs for ${sessionId}: ${messageOf(error)}`)
      if (force) {
        throw new WorkbenchError(502, `cannot list runs for this conversation: ${messageOf(error)}`, {
          id: 'runs-unavailable',
        })
      }
      return []
    }
    const rows = Array.isArray(runs) ? runs : []
    if (currentSessionId !== sessionId) return []
    lastGoals = Array.isArray(goals) ? goals : []
    const json = JSON.stringify([rows, lastGoals])
    lastRuns = rows
    if (force || json !== lastRunsJson) {
      lastRunsJson = json
      broadcast({ type: 'runs', sessionId, runs: rows, goals: lastGoals })
    }
    return rows
  }

  function attach(sessionId) {
    if (typeof host.subscribe !== 'function' || unsubscribe) return
    try {
      unsubscribe = host.subscribe(sessionId, frame => {
        if (currentSessionId !== sessionId) return
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'stream.snapshot') {
          if (frame.header) store.header = frame.header
          const added = mergeRecords(frame.records)
          if (added > 0) saveTimeline()
          // Forward the opening only when it carried records we did not hold.
          // Replaying the host's post-turn snapshot (usually just the setup
          // records) would make the page clear the history it already has.
          if (added > 0) {
            const merged = transcriptFrame()
            if (merged) broadcast(boundedSnapshot(merged))
          }
          return
        }
        if (frame.type === 'session.event' && frame.event) {
          if (mergeRecords([{ type: 'event', event: frame.event }]) > 0) saveTimeline()
        }
        broadcast(frame)
      })
    } catch (error) {
      log(`console: cannot subscribe to conversation ${sessionId}: ${messageOf(error)}`)
      if (rememberedSessionId && rememberedSessionId === sessionId) {
        rememberedSessionId = null
        currentSessionId = null
        resetStore(null)
        saveTimeline(true)
      }
      broadcast({
        type: 'error',
        code: 'stream-unavailable',
        message: `the conversation stream could not start: ${messageOf(error)}`,
      })
    }
    runTimer = setInterval(() => {
      refreshRuns().catch(() => {})
    }, RUN_POLL_MS)
    runTimer.unref?.()
    refreshRuns({ force: true }).catch(() => {})
  }

  async function createSession(options) {
    const caps = capabilities()
    if (!caps.chat) {
      throw new WorkbenchError(503, caps.reason ?? 'the host exposes no conversation session API', {
        id: 'console-unavailable',
        hint: 'the host must mount sessionController; this page does not fake a conversation when it is missing.',
      })
    }
    let created
    try {
      created = await host.createSession(options)
    } catch (error) {
      throw new WorkbenchError(502, `cannot create a conversation session: ${messageOf(error)}`, {
        id: 'session-create-failed',
      })
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new WorkbenchError(502, 'the host created a session but returned no id', { id: 'session-create-failed' })
    }
    markPanel(sessionId)
    if (currentSessionId !== sessionId) {
      sessionAllowedTools.clear()
      detach()
      currentSessionId = sessionId
      resetStore(sessionId)
      saveTimeline(true)
      // The follow stream opens with a snapshot, so it starts when the first
      // browser subscribes rather than when the session is created. Otherwise
      // the snapshot is written to nobody.
      broadcast({ type: 'session', sessionId, mode: 'chat' })
      // A page that is already listening asked for the new conversation, so
      // re-attach for it instead of waiting for another connection.
      if (clients.size > 0) attach(sessionId)
    }
    return { sessionId, capabilities: caps }
  }

  /**
   * Show a conversation the host already has. The page reloads afterwards, so
   * it re-runs bootstrap and replays that session through the normal path
   * instead of the console inventing a second rendering pipeline.
   *
   * @param {string} sessionId - a conversation this console created.
   */
  async function switchSession(sessionId) {
    const caps = capabilities()
    if (!caps.chat) {
      throw new WorkbenchError(503, caps.reason ?? 'the host exposes no conversation session API', {
        id: 'console-unavailable',
      })
    }
    if (typeof host.openSession !== 'function') {
      throw new WorkbenchError(501, 'this host cannot reopen a conversation', { id: 'switch-unavailable' })
    }
    const target = await host.openSession(sessionId)
    if (!target) {
      throw new WorkbenchError(404, 'no such conversation in this console space', {
        id: 'unknown-session',
        hint: 'the history list only contains conversations this console created.',
      })
    }
    if (target.sessionId === currentSessionId) {
      return { sessionId: target.sessionId, capabilities: caps, switched: false }
    }
    currentSessionId = target.sessionId
    rememberedSessionId = target.sessionId
    markPanel(target.sessionId)
    sessionAllowedTools.clear()
    detach()
    resetStore(target.sessionId)
    await saveTimeline(true)
    broadcast({ type: 'session', sessionId: target.sessionId, mode: 'chat', switched: true })
    if (clients.size > 0) attach(target.sessionId)
    refreshRuns({ force: true }).catch(() => {})
    return { sessionId: target.sessionId, capabilities: caps }
  }

  async function ensureSession() {
    if (currentSessionId) {
      markPanel(currentSessionId)
      return { sessionId: currentSessionId, capabilities: capabilities() }
    }
    return createSession()
  }

  async function taskSession(owner, id) {
    if (router && !owner && id) {
      const bench = await host.workbench(null, { query: id, limit: 30 })
      owner = bench.runs?.find(run => run.id === id)?.parentSessionId
        ?? bench.goals?.find(goal => goal.id === id)?.ownerSessionId
    }
    if (!owner || owner === currentSessionId) return currentSessionId
    const known = await host.openSession?.(owner)
    if (known?.sessionId !== owner) {
      throw new WorkbenchError(404, '找不到任务所属会话', { id: 'unknown-session' })
    }
    return owner
  }

  function workbenchInbox(workbench) {
    const pending = [...approvals.values()].map(({ payload }) => ({
      id: `approval:${payload.id}`, kind: 'approval',
      sessionId: payload.ownerSessionId, title: payload.toolName, item: payload,
    }))
    return [...pending, ...(workbench.inbox ?? [])].map(entry => ({
      ...entry,
      project: workbench.sessionProjects?.[entry.sessionId] ?? null,
      read: noticeRead.has(entry.id),
    }))
  }

  /** Tell the node half this session is driven from the panel, so its core tools stay on. */
  function markPanel(sessionId) {
    try {
      host.markPanelSession?.(sessionId)
    } catch {
      // A host without the hook just keeps the previous tool list.
    }
  }

  async function state() {
    const caps = capabilities()
    if (currentSessionId && !runTimer) await refreshRuns()
    return {
      mode: router ? 'router' : caps.chat ? 'chat' : 'unavailable',
      capabilities: caps,
      sessionId: currentSessionId,
      runs: currentSessionId ? lastRuns ?? [] : [],
      goals: currentSessionId ? lastGoals : [],
      approvals: [...approvals.values()].map(entry => entry.payload),
      readNoticeIds: [...noticeRead],
      ...(router ? { router: await router.snapshot() } : {}),
    }
  }

  /**
   * A conversation opened for the first time in this process (a switch, or a
   * restart where the local timeline only keeps one session) has no cached
   * transcript. Seed it from that session's own committed events so the page
   * shows what happened, rather than an empty thread that looks like lost work.
   *
   * @param {string} sessionId - conversation whose events should be read.
   */
  async function seedFromHost(sessionId) {
    if (typeof host.readSessionEvents !== 'function') return
    let records
    try {
      records = await host.readSessionEvents(sessionId)
    } catch {
      return
    }
    if (!Array.isArray(records) || records.length === 0) return
    // A live follow may have filled the transcript while this read was in
    // flight; its events are newer and mergeRecords de-duplicates by seq.
    if (store.sessionId !== sessionId) return
    if (store.entries.length > 0) return
    if (mergeRecords(records) === 0) return
    saveTimeline()
    const frame = transcriptFrame()
    if (frame) broadcast({ ...boundedSnapshot(frame), seq: nextSeq(), at: new Date().toISOString() })
  }

  function openStream(req, res) {
    const caps = capabilities()
    if (!caps.chat) {
      throw new WorkbenchError(503, caps.reason ?? 'the host exposes no conversation session API', {
        id: 'console-unavailable',
      })
    }
    if (clients.size >= MAX_CLIENTS) {
      throw new WorkbenchError(503, 'too many console streams are already open', { id: 'too-many-streams' })
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    })
    res.flushHeaders?.()
    clients.add(res)
    writeFrame(res, {
      type: 'hello',
      seq: nextSeq(),
      at: new Date().toISOString(),
      sessionId: currentSessionId,
      mode: router ? 'router' : 'chat',
      capabilities: caps,
    })
    // Every tab — first, second, or a reconnect — starts from the transcript
    // the console accumulated for this conversation, so a refresh shows the
    // same history instead of an empty page.
    const cached = store.sessionId === currentSessionId ? transcriptFrame() : null
    if (cached) {
      writeFrame(res, { ...boundedSnapshot(cached), seq: nextSeq(), at: new Date().toISOString() })
    }
    if (lastRuns) {
      writeFrame(res, { type: 'runs', seq: nextSeq(), at: new Date().toISOString(), sessionId: currentSessionId, runs: lastRuns, goals: lastGoals })
    }
    if (currentSessionId) {
      attach(currentSessionId)
      if (!cached) seedFromHost(currentSessionId).catch(() => {})
    }
    const heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return
      try {
        res.write(': ping\n\n')
      } catch {
        // The close handler below removes the client.
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
    const cleanup = () => {
      clearInterval(heartbeat)
      clients.delete(res)
      // With nobody watching there is no reason to keep the follow loop alive.
      // The transcript stays cached so a reconnect can rebuild the page.
      // Pending approvals deliberately survive this: closing or switching the
      // panel must not answer them. They stay parked for the tool call and
      // expire on their own deadline, so reopening the page still shows the
      // question instead of a call that failed behind the user's back.
      if (clients.size === 0) detach()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  /**
   * Serve one file that a run report names. The report is the allowlist: a
   * token holder cannot read an arbitrary path unless the agent already wrote
   * that path into a report for this conversation.
   *
   * @param {object} parsed - request URL.
   * @param {import('node:http').ServerResponse} res - response sink.
   */
  async function serveArtifact(parsed, res) {
    const { target } = await listedArtifact(parsed)
    const download = parsed.searchParams.get('download') === '1'
    const type = ARTIFACT_TYPES.get(path.extname(target).toLowerCase())
    if (!type && !download) {
      throw new WorkbenchError(415, 'this file type is not previewable in the console', { id: 'artifact-type' })
    }
    let stat
    try {
      stat = await fsp.stat(target)
    } catch {
      throw new WorkbenchError(404, 'the run named this file but it is no longer on disk', { id: 'artifact-missing' })
    }
    if (!stat.isFile()) throw new WorkbenchError(404, 'that path is not a file', { id: 'artifact-not-file' })
    if (stat.size > MAX_ARTIFACT_BYTES && !download) {
      throw new WorkbenchError(413, `the file is above the ${MAX_ARTIFACT_BYTES}-byte preview limit`, {
        id: 'artifact-too-large',
      })
    }
    const body = await fsp.readFile(target)
    const name = path.basename(target).replace(/["\\]/g, '_')
    const headers = {
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
    }
    if (type?.startsWith('text/html') && !download) headers['content-security-policy'] = ARTIFACT_PAGE_CSP
    sendText(res, 200, body, download ? 'application/octet-stream' : type, headers)
  }

  /**
   * Resolve an artifact path against the run reports that name it. Reports are
   * the allowlist: a console client cannot ask for an arbitrary file, only one
   * the agent already wrote about.
   *
   * @param {URL} parsed - request URL carrying `path` and optionally `runId`.
   * @returns {Promise<{raw: string, target: string}>} resolved file.
   */
  async function listedArtifact(parsed) {
    const runId = (parsed.searchParams.get('runId') || '').trim()
    const sessionId = await taskSession(parsed.searchParams.get('owner'), runId)
    if (!sessionId) throw new WorkbenchError(409, 'there is no conversation yet', { id: 'no-session' })
    const raw = (parsed.searchParams.get('path') || '').trim()
    if (!raw) throw new WorkbenchError(400, 'path is required', { id: 'missing-path' })
    const workspace = !path.isAbsolute(raw) ? await host.sessionWorkspace?.(sessionId) : null
    const target = path.resolve(workspace ?? process.cwd(), raw)
    if (workspace) {
      const relative = path.relative(workspace, target)
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        throw new WorkbenchError(403, 'artifact path is outside this project', { id: 'artifact-outside-project' })
      }
    }
    let reports = []
    let verified = []
    if (runId && typeof host.readRun === 'function') {
      const run = await host.readRun(sessionId, runId)
      reports = typeof run?.report === 'string' ? [run.report] : []
      verified = run?.artifacts ?? []
    } else if (typeof host.listRuns === 'function') {
      const rows = await host.listRuns(sessionId)
      reports = (Array.isArray(rows) ? rows : [])
        .map(run => run?.report)
        .filter(report => typeof report === 'string')
    }
    const variants = [raw, target, target.replace(/\\/g, '/'), target.replace(/\//g, '\\')]
    const listed = verified.some(item => variants.includes(item.href))
      || reports.some(report => variants.some(value => value && report.includes(value)))
    if (!listed) {
      throw new WorkbenchError(403, 'this path is not named in any run report', {
        id: 'artifact-not-listed',
        hint: 'only files a run reported can be previewed here; copy the path and open it in your editor instead.',
      })
    }
    return { raw, target }
  }

  /**
   * Show one artifact in the platform file manager. The same report allowlist
   * applies, so this cannot be used as an arbitrary "open anything" oracle.
   *
   * @param {string} target - absolute file path already vetted by listedArtifact.
   */
  function revealInFolder(target) {
    if (process.platform === 'win32') {
      const child = spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' })
      child.unref()
      return
    }
    const command = process.platform === 'darwin' ? ['open', ['-R', target]] : ['xdg-open', [path.dirname(target)]]
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
    child.unref()
  }

  /**
   * A dropped or pasted file keeps its readable name but loses every path bit
   * and every character Windows reserves, so it can only ever become one file
   * inside the upload directory.
   *
   * @param {unknown} raw - name supplied by the page.
   * @returns {string} a bare file name, possibly empty.
   */
  function safeUploadName(raw) {
    const base = path.basename(String(raw ?? '').replace(/\\/g, '/'))
    const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim()
    return [...cleaned].slice(0, 80).join('')
  }

  /**
   * Write the bytes under `dir` without ever overwriting an earlier drop.
   *
   * @param {string} dir - upload directory inside the workspace.
   * @param {string} name - bare file name.
   * @param {Buffer} bytes - decoded content.
   * @returns {Promise<string>} the path actually written.
   */
  async function writeUpload(dir, name, bytes) {
    await fsp.mkdir(dir, { recursive: true })
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`
      const target = path.join(dir, candidate)
      if (!isInside(target, dir)) {
        throw new WorkbenchError(400, '文件名不合法，写不进工作区', { id: 'upload-name' })
      }
      try {
        await fsp.writeFile(target, bytes, { flag: 'wx' })
        return target
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    throw new WorkbenchError(409, '同名文件太多了，换个名字再放一次', { id: 'upload-crowded' })
  }

  /** The per-file cap in words, so both size failures read the same. */
  function uploadCapText() {
    if (uploadLimit >= 1024 * 1024) return `${Math.round(uploadLimit / (1024 * 1024))}MB`
    return `${Math.max(1, Math.round(uploadLimit / 1024))}KB`
  }

  /**
   * Copy one dropped or pasted file into the conversation's workspace.
   *
   * The page sends bytes and a display name, never a destination: the host
   * resolves the conversation's own workspace and this module keeps the write
   * under it. Unknown extensions are refused instead of sniffed, and the path
   * that would escape the workspace is refused rather than quietly renamed.
   *
   * @param {object} req - the upload request.
   * @param {import('node:http').ServerResponse} res - response sink.
   */
  async function acceptUpload(req, res) {
    const sessionId = currentSessionId
    if (!router && !sessionId) {
      throw new WorkbenchError(409, '先在对话里说一句话，再把文件放进来', {
        id: 'no-session',
        hint: '文件要落在对话的工作区里，所以先有一条对话。',
      })
    }
    let body
    try {
      body = await readJson(req, { limit: UPLOAD_BODY_LIMIT })
    } catch (error) {
      // The generic body cap speaks about editor saves; a drop deserves a
      // sentence about the file the person just tried to add.
      if (error?.status === 413) {
        throw new WorkbenchError(413, `这个文件太大了，单个文件最多 ${uploadCapText()}`, {
          id: 'upload-too-large',
          hint: '压缩一下再放，或者把文件路径写进消息里让我直接读。',
        })
      }
      throw error
    }
    if (typeof body.sessionId === 'string' && body.sessionId && body.sessionId !== sessionId) {
      throw new WorkbenchError(409, '文件要放进当前对话的工作区', {
        id: 'session-mismatch',
        hint: '刷新页面后再放一次。',
      })
    }
    const name = safeUploadName(body.name)
    if (!name) throw new WorkbenchError(400, '文件名不能为空', { id: 'missing-name' })
    const ext = path.extname(name).toLowerCase()
    if (!UPLOAD_TYPES.has(ext)) {
      throw new WorkbenchError(415, `不能放 ${ext ? `${ext} 文件` : '没有扩展名的文件'}`, {
        id: 'upload-type',
        hint: `可以放：${UPLOAD_TYPES_TEXT}。`,
      })
    }
    const data = typeof body.data === 'string' ? body.data : ''
    if (!data) throw new WorkbenchError(400, '这个文件没有内容', { id: 'missing-data' })
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) {
      throw new WorkbenchError(400, '这个文件是空的，或者内容读不出来', { id: 'upload-empty' })
    }
    if (bytes.length > uploadLimit) {
      const mb = (bytes.length / (1024 * 1024)).toFixed(1)
      throw new WorkbenchError(413, `${name} 有 ${mb}MB，超过单个 ${uploadCapText()} 的上限`, {
        id: 'upload-too-large',
        hint: '压缩一下再放，或者把文件路径写进消息里让我直接读。',
      })
    }
    if (typeof host.sessionWorkspace !== 'function') {
      throw new WorkbenchError(501, 'this host cannot tell the console where its workspace is', {
        id: 'workspace-unavailable',
      })
    }
    let workspace
    try {
      const project = router && body.project
      const approved = project ? (await host.workbench(null)).projects.some(item => item.cwd === project) : false
      if (project && !approved) throw new Error('找不到上传目标工作区')
      workspace = approved ? project : await host.sessionWorkspace(sessionId)
    } catch (error) {
      throw new WorkbenchError(502, `cannot resolve the conversation workspace: ${messageOf(error)}`, {
        id: 'workspace-unavailable',
      })
    }
    if (typeof workspace !== 'string' || !workspace) {
      throw new WorkbenchError(502, 'the host returned no workspace for this conversation', {
        id: 'workspace-unavailable',
      })
    }
    const root = path.resolve(workspace)
    const folder = sessionId.slice(0, 12).replace(/[^a-zA-Z0-9._-]/g, '')
    const dir = path.resolve(root, UPLOAD_DIR, folder || 'session')
    if (!isInside(dir, root) || !isInside(path.join(dir, name), dir)) {
      throw new WorkbenchError(400, '工作区路径不合法，文件没有落盘', { id: 'upload-escape' })
    }
    const target = await writeUpload(dir, name, bytes)
    send(res, 200, {
      ok: true,
      data: { path: target, name: path.basename(target), size: bytes.length, dir },
    })
  }

  async function handle(req, res) {
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      const pathname = parsed.pathname

      if (pathname === '/' || pathname === '/console' || pathname === '/index.html') {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        authorize(req, { allowQuery: true })
        // The host seats this page in the "超级智能体" main panel, so framing is
        // allowed from loopback origins and from the shell scheme the client
        // half reports — the token still gates the page.
        const ancestors = [...BASE_FRAME_ANCESTORS]
        const reported = ancestorSource(parsed.searchParams.get('parent') ?? '')
        if (reported && !ancestors.includes(reported)) ancestors.push(reported)
        sendText(res, 200, page, 'text/html; charset=utf-8', {
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            + "connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; "
            + `frame-ancestors ${ancestors.join(' ')}`,
        })
        return
      }

      // A preview opens in its own tab, which cannot carry an Authorization
      // header, so this one route also accepts the console token in the query.
      if (pathname === '/api/console/artifact') {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        authorize(req, { allowQuery: true })
        await serveArtifact(parsed, res)
        return
      }

      authorize(req)
      const parts = pathname.split('/').filter(Boolean)
      if (parts[0] !== 'api' || parts[1] !== 'console') {
        throw new WorkbenchError(404, `no route for ${method} ${pathname}`, { id: 'not-found', hint: ROUTE_HINT })
      }
      const leaf = parts[2] ?? ''

      if (router && (['session', 'sessions', 'cancel'].includes(leaf)
        || (leaf === 'workbench' && method === 'POST') || (leaf === 'goals' && parts.length === 3 && method === 'POST'))) {
        throw new WorkbenchError(405, '请直接向超级智能体发送消息，或在任务卡上操作。', { id: 'router-only' })
      }
      if (router && leaf === 'router' && parts.length === 3 && method === 'GET') {
        send(res, 200, { ok: true, data: await router.snapshot() })
        return
      }
      if (router && leaf === 'router' && parts[3] === 'choose' && parts.length === 4 && method === 'POST') {
        const body = await readJson(req)
        send(res, 200, { ok: true, data: await router.chooseTarget(body) })
        return
      }

      if (leaf === 'artifact' && parts.length === 4 && parts[3] === 'reveal') {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const { target } = await listedArtifact(parsed)
        revealInFolder(target)
        send(res, 200, { ok: true, data: { revealed: true, path: target } })
        return
      }

      if (leaf === 'health' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        const caps = capabilities()
        send(res, 200, {
          ok: true,
          data: {
            service: 'dsh-superagent-console',
            version,
            pid: process.pid,
            startedAt,
            mode: caps.chat ? 'chat' : 'unavailable',
            capabilities: caps,
            sessionId: currentSessionId,
          },
        })
        return
      }

      if (leaf === 'state' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        send(res, 200, { ok: true, data: await state() })
        return
      }

      if (leaf === 'workbench' && parts.length === 3 && typeof host.workbench === 'function') {
        if (method === 'POST' && typeof host.nameWorkbench === 'function') {
          const body = await readJson(req)
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (!name || name.length > 32 || /[\r\n]/.test(name)) {
            throw new WorkbenchError(400, '名称须在 1 到 32 个字之间', { id: 'invalid-assistant-name' })
          }
          await host.nameWorkbench(name)
        } else if (method !== 'GET') {
          throw new WorkbenchError(405, 'method not allowed', { id: 'method-not-allowed' })
        }
        const sessionId = currentSessionId
        const query = router ? (parsed.searchParams.get('q') ?? '').slice(0, 200) : ''
        const workbench = await host.workbench(sessionId, { query, ...(query ? { limit: 50 } : {}) })
        send(res, 200, { ok: true, data: { ...workbench, sessionId, inbox: workbenchInbox(workbench) } })
        return
      }

      if (router && leaf === 'projects' && parts.length === 3 && method === 'POST') {
        const body = await readJson(req)
        send(res, 200, { ok: true, data: { project: await host.registerProject(body.cwd) } })
        return
      }

      if (leaf === 'projects' && parts[3] === 'pick' && parts.length === 4 && method === 'POST' && host.pickProject) {
        const controller = new AbortController()
        const abort = () => controller.abort()
        res.once('close', abort)
        try {
          const cwd = await host.pickProject(controller.signal)
          if (!controller.signal.aborted) send(res, 200, { ok: true, data: { cwd } })
        } finally {
          res.off('close', abort)
        }
        return
      }

      if (leaf === 'goals' && method === 'POST' && (parts.length === 3 || parts.length === 5)) {
        const body = await readJson(req)
        const creating = parts.length === 3
        const action = parts[4]
        if (creating ? !host.createGoal : !host.actOnGoal || !['answer', 'pause', 'resume', 'cancel', 'retry_phase'].includes(action)) {
          throw new WorkbenchError(404, 'goal action unavailable', { id: 'goal-action-unavailable' })
        }
        const text = String(body.text ?? '').trim()
        if (creating && !text) throw new WorkbenchError(400, '请输入要委托的目标', { id: 'goal-required' })
        const sessionId = creating ? (await ensureSession()).sessionId : await taskSession(parsed.searchParams.get('owner'))
        if (!sessionId || (body.sessionId && body.sessionId !== sessionId)) {
          throw new WorkbenchError(409, '会话已切换，请回到目标原来的会话', { id: 'session-mismatch' })
        }
        const goal = creating ? await host.createGoal(sessionId, text)
          : await host.actOnGoal(sessionId, decodeURIComponent(parts[3]), action, body)
        if (!goal) throw new WorkbenchError(404, '本会话中没有这条目标', { id: 'unknown-goal' })
        await refreshRuns().catch(() => {})
        send(res, 200, { ok: true, data: { goal, sessionId } })
        return
      }

      // Notices are derived from durable runs on every load; only the ids a
      // person has already read need remembering.
      if (leaf === 'notices' && parts.length === 4 && parts[3] === 'read') {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const ids = Array.isArray(body?.ids)
          ? body.ids
            .filter(id => typeof id === 'string' && id.trim())
            .map(id => id.trim())
            .slice(0, MAX_READ_NOTICES)
          : []
        if (ids.length === 0) throw new WorkbenchError(400, 'ids is required', { id: 'missing-ids' })
        let added = 0
        for (const id of ids) {
          if (noticeRead.has(id)) continue
          noticeRead.add(id)
          added += 1
        }
        if (added > 0) await saveNoticeRead()
        send(res, 200, { ok: true, data: { read: ids.length, added } })
        return
      }

      if (leaf === 'tools' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        const sessionId = currentSessionId
        if (!sessionId) {
          send(res, 200, { ok: true, data: { sessionId: null, tools: null, reason: 'no-session' } })
          return
        }
        if (typeof host.listTools !== 'function') {
          send(res, 200, { ok: true, data: { sessionId, tools: null, reason: 'this host cannot enumerate tools' } })
          return
        }
        try {
          const tools = await host.listTools(sessionId)
          send(res, 200, { ok: true, data: { sessionId, tools, reason: null } })
        } catch (error) {
          send(res, 200, { ok: true, data: { sessionId, tools: null, reason: messageOf(error) } })
        }
        return
      }

      if (leaf === 'bootstrap' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const created = router ? {} : await ensureSession()
        send(res, 200, { ok: true, data: { ...(await state()), ...created } })
        return
      }

      if (leaf === 'session' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const created = await createSession({ cwd: body.cwd })
        send(res, 200, { ok: true, data: created })
        return
      }

      if (leaf === 'sessions' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        if (typeof host.listSessions !== 'function') {
          send(res, 200, { ok: true, data: { sessions: [], currentSessionId, reason: 'this host cannot list conversations' } })
          return
        }
        try {
          const sessions = await host.listSessions()
          send(res, 200, { ok: true, data: { sessions, currentSessionId, reason: null } })
        } catch (error) {
          send(res, 200, { ok: true, data: { sessions: [], currentSessionId, reason: messageOf(error) } })
        }
        return
      }

      if (leaf === 'schedules' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        try {
          const sessions = typeof host.listSchedules === 'function' ? await host.listSchedules() : []
          send(res, 200, { ok: true, data: { sessions, currentSessionId, reason: null } })
        } catch (error) {
          send(res, 200, { ok: true, data: { sessions: [], currentSessionId, reason: messageOf(error) } })
        }
        return
      }

      if (leaf === 'session' && parts.length === 4 && parts[3] === 'switch') {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) throw new WorkbenchError(400, 'sessionId is required', { id: 'missing-session-id' })
        send(res, 200, { ok: true, data: await switchSession(sessionId) })
        return
      }

      if (leaf === 'cancel' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const ensured = await ensureSession()
        if (typeof body.sessionId === 'string' && body.sessionId && body.sessionId !== ensured.sessionId) {
          throw new WorkbenchError(409, 'the cancel targets a conversation this console is not showing', {
            id: 'session-mismatch',
            hint: 'reload the page; the console keeps one active conversation at a time.',
          })
        }
        if (typeof host.cancelTurn !== 'function') {
          throw new WorkbenchError(501, 'this host cannot stop a turn', { id: 'cancel-unsupported' })
        }
        try {
          await host.cancelTurn(ensured.sessionId)
        } catch (error) {
          throw new WorkbenchError(502, `the host refused to stop the turn: ${messageOf(error)}`, {
            id: 'cancel-failed',
          })
        }
        broadcast({ type: 'canceling', sessionId: ensured.sessionId })
        send(res, 200, { ok: true, data: { canceling: true } })
        return
      }

      if (leaf === 'message' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new WorkbenchError(400, 'text is required', { id: 'missing-text' })
        const limit = router && isBatchMessage(text) ? MAX_BATCH_TEXT : MAX_TEXT
        if (text.length > limit) {
          throw new WorkbenchError(413, `text is above the ${limit}-character limit`, { id: 'text-too-long' })
        }
        if (router) {
          const target = typeof body.target === 'string' ? body.target : null
          const data = await router.submit({
            text, target, id: body.id,
            phaseId: typeof body.phaseId === 'string' ? body.phaseId : null,
            contextMode: body.contextMode === 'snapshot' ? 'snapshot' : null,
            project: typeof body.project === 'string' ? body.project : null,
            intent: target && body.intent === 'followup' ? 'followup' : null,
          })
          send(res, 200, { ok: true, data })
          return
        }
        const mode = body.mode === 'steer' ? 'steer' : 'queue'
        const ensured = await ensureSession()
        if (typeof body.sessionId === 'string' && body.sessionId && body.sessionId !== ensured.sessionId) {
          throw new WorkbenchError(409, 'the message targets a conversation this console is not showing', {
            id: 'session-mismatch',
            hint: 'reload the page; the console keeps one active conversation at a time.',
          })
        }
        try {
          await host.prompt({ sessionId: ensured.sessionId, text, mode })
        } catch (error) {
          throw new WorkbenchError(502, `the host refused the message: ${messageOf(error)}`, {
            id: 'prompt-failed',
          })
        }
        const accepted = broadcast({ type: 'accepted', sessionId: ensured.sessionId, text, mode })
        refreshRuns().catch(() => {})
        send(res, 200, { ok: true, data: { accepted: true, sessionId: ensured.sessionId, mode, seq: accepted.seq } })
        return
      }

      // A file dropped on the composer is copied into this conversation's
      // workspace, then its path is what the page writes into the message.
      if (leaf === 'upload' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        await acceptUpload(req, res)
        return
      }

      if (leaf === 'events' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        openStream(req, res)
        return
      }

      if (leaf === 'approval' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const id = typeof body?.id === 'string' ? body.id.trim() : ''
        const wanted = body?.decision
        const decision = wanted === 'allow'
          ? 'allowed-once'
          : wanted === 'allow-tool' ? 'allowed-tool'
            : wanted === 'reject' ? 'rejected' : null
        if (!id) throw new WorkbenchError(400, 'id is required', { id: 'missing-approval-id' })
        if (!decision) {
          throw new WorkbenchError(400, 'decision must be allow, allow-tool or reject', { id: 'bad-approval-decision' })
        }
        const pending = approvals.get(id)
        if (!pending) {
          throw new WorkbenchError(409, 'this approval is no longer waiting for you', {
            id: 'approval-gone',
            hint: 'reload the page: the question expired, or another window already answered it.',
          })
        }
        if (decision === 'allowed-tool') {
          if (pending.payload.ownerSessionId !== currentSessionId) {
            throw new WorkbenchError(409, '请在任务所属会话中设置工具的会话授权', { id: 'approval-session-mismatch' })
          }
          sessionAllowedTools.add(pending.payload.toolName)
          pending.settle('allowed-once')
          broadcast({ type: 'approval', action: 'decided', id, outcome: 'allowed-once', scope: 'tool' })
          send(res, 200, { ok: true, data: { id, outcome: 'allowed-once', scope: 'tool', toolName: pending.payload.toolName } })
          return
        }
        pending.settle(decision)
        broadcast({ type: 'approval', action: 'decided', id, outcome: decision })
        send(res, 200, { ok: true, data: { id, outcome: decision } })
        return
      }

      if (leaf === 'answer' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const runId = typeof body.runId === 'string' ? body.runId.trim() : ''
        const attentionId = typeof body.attentionId === 'string' && body.attentionId.trim()
          ? body.attentionId.trim()
          : null
        const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
        if (!runId) throw new WorkbenchError(400, 'runId is required', { id: 'missing-run-id' })
        if (!answer) throw new WorkbenchError(400, 'answer is required', { id: 'missing-answer' })
        const owner = body.owner ?? parsed.searchParams.get('owner')
        const sessionId = owner || router ? await taskSession(owner, runId) : (await ensureSession()).sessionId
        if (!sessionId) throw new WorkbenchError(409, '请选择问题所属的任务', { id: 'missing-task-owner' })
        let result
        try {
          result = await host.answer({ sessionId, runId, attentionId, answer })
        } catch (error) {
          throw new WorkbenchError(502, `the answer was not applied: ${messageOf(error)}`, {
            id: 'answer-failed',
          })
        }
        broadcast({ type: 'answered', sessionId, runId, attentionId, answer })
        await refreshRuns({ force: true }).catch(() => {})
        send(res, 200, { ok: true, data: result ?? { runId, attentionId, answer } })
        return
      }

      if (leaf === 'wizard' && parts.length <= 4) {
        const action = parts[3] ?? 'status'
        const requireHost = name => {
          if (typeof host[name] !== 'function') {
            throw new WorkbenchError(501, `this host does not implement ${name}`, {
              id: 'wizard-unavailable',
              hint: 'update the plugin or open the console from a host that provides the wizard hooks.',
            })
          }
        }
        if (action === 'status') {
          if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
          requireHost('wizardStatus')
          const probe = ['1', 'true'].includes(parsed.searchParams.get('probe') ?? '')
          send(res, 200, {
            ok: true,
            data: await host.wizardStatus({ sessionId: currentSessionId, probe }),
          })
          return
        }
        if (!['preview', 'save', 'rollback', 'trial'].includes(action)) {
          throw new WorkbenchError(404, `no route for ${method} ${pathname}`, { id: 'not-found', hint: ROUTE_HINT })
        }
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        if (action === 'preview') {
          requireHost('wizardPreview')
          send(res, 200, { ok: true, data: await host.wizardPreview(body ?? {}) })
          return
        }
        if (action === 'save') {
          requireHost('wizardSave')
          send(res, 200, { ok: true, data: await host.wizardSave(body ?? {}) })
          return
        }
        if (action === 'rollback') {
          requireHost('wizardRollback')
          const id = typeof body?.id === 'string' ? body.id.trim() : ''
          if (!id) throw new WorkbenchError(400, 'id is required', { id: 'missing-backup-id' })
          send(res, 200, { ok: true, data: await host.wizardRollback(id) })
          return
        }
        requireHost('wizardTrial')
        send(res, 200, { ok: true, data: await host.wizardTrial() })
        return
      }

      if (leaf === 'runs' && parts.length === 6 && parts[4] === 'worker' && method === 'GET' && host.readWorkerSession) {
        const sessionId = await taskSession(parsed.searchParams.get('owner'))
        const record = sessionId && await host.readWorkerSession(sessionId, decodeURIComponent(parts[3]), decodeURIComponent(parts[5]))
        if (!record) throw new WorkbenchError(404, '本会话中没有这条工作线', { id: 'unknown-worker' })
        send(res, 200, { ok: true, data: record })
        return
      }

      if (leaf === 'runs' && parts.length === 5 && parts[4] === 'instruction' && method === 'POST' && host.instructRun) {
        const body = await readJson(req)
        const sessionId = await taskSession(parsed.searchParams.get('owner'))
        if (!sessionId || body.sessionId !== sessionId) {
          throw new WorkbenchError(409, '会话已切换，请回到任务原来的会话', { id: 'session-mismatch' })
        }
        const text = String(body.text ?? '').trim()
        const mode = body.mode
        if (!text || (mode !== 'followup' && (mode !== 'inject' || !Number.isInteger(body.subtaskIndex)))) {
          throw new WorkbenchError(400, '请输入指令并选择任务或工作线', { id: 'invalid-instruction' })
        }
        const receipt = await host.instructRun(sessionId, decodeURIComponent(parts[3]), { text, mode, subtaskIndex: body.subtaskIndex })
        if (!receipt) throw new WorkbenchError(404, '本会话中没有这条任务', { id: 'unknown-run' })
        await refreshRuns().catch(() => {})
        send(res, 200, { ok: true, data: receipt })
        return
      }

      if (leaf === 'runs' && parts.length === 5 && parts[4] === 'cancel') {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const runId = decodeURIComponent(parts[3])
        const sessionId = await taskSession(body.owner ?? parsed.searchParams.get('owner'), runId)
        if (!sessionId) throw new WorkbenchError(409, 'no conversation is open', { id: 'no-session' })
        if (typeof host.cancelRun !== 'function') {
          throw new WorkbenchError(501, 'this host cannot cancel runs from the console', { id: 'cancel-unavailable' })
        }
        let result
        try {
          result = await host.cancelRun(sessionId, runId)
        } catch (error) {
          throw new WorkbenchError(502, `the run was not cancelled: ${messageOf(error)}`, { id: 'cancel-failed' })
        }
        if (!result) throw new WorkbenchError(404, `no run ${runId} for this conversation`, { id: 'unknown-run' })
        await refreshRuns({ force: true }).catch(() => {})
        send(res, 200, { ok: true, data: result })
        return
      }

      if (leaf === 'runs' && parts.length <= 4) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        const runId = parts[3] ? decodeURIComponent(parts[3]) : null
        if (router && !runId) {
          send(res, 200, { ok: true, data: { runs: (await host.workbench(null)).runs ?? [] } })
          return
        }
        const sessionId = runId ? await taskSession(parsed.searchParams.get('owner'), runId) : currentSessionId
        if (!sessionId) {
          if (runId) throw new WorkbenchError(404, '找不到任务', { id: 'unknown-run' })
          send(res, 200, { ok: true, data: { runs: [] } })
          return
        }
        if (parts.length === 3) {
          send(res, 200, { ok: true, data: { runs: await refreshRuns({ force: true }) } })
          return
        }
        if (typeof host.readRun !== 'function') {
          throw new WorkbenchError(404, `no route for ${method} ${pathname}`, { id: 'not-found' })
        }
        const run = await host.readRun(sessionId, runId)
        if (!run) throw new WorkbenchError(404, `no run ${runId} for this conversation`, { id: 'unknown-run' })
        send(res, 200, { ok: true, data: run })
        return
      }

      throw new WorkbenchError(404, `no route for ${method} ${pathname}`, { id: 'not-found', hint: ROUTE_HINT })
    } catch (error) {
      if (statusFor(error) >= 500) log(`console request failed: ${messageOf(error)}`)
      send(res, statusFor(error), errorPayload(error))
    }
  }

  async function writeDiscovery() {
    const caps = capabilities()
    const doc = {
      service: 'dsh-superagent-console',
      version,
      url: url(),
      token,
      pid: process.pid,
      instanceId,
      startedAt,
      mode: caps.chat ? 'chat' : 'unavailable',
    }
    const tmp = `${discoveryPath}.${process.pid}.${instanceId}.tmp`
    const handle = await fsp.open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await fsp.rename(tmp, discoveryPath)
    try {
      await fsp.chmod(discoveryPath, 0o600)
    } catch {
      // Windows ignores most mode bits; the file's ACL still applies.
    }
  }

  async function removeDiscovery() {
    try {
      const current = JSON.parse(await fsp.readFile(discoveryPath, 'utf8'))
      if (current?.instanceId !== instanceId) return
      await fsp.unlink(discoveryPath)
    } catch {
      // Already gone, or replaced by another instance.
    }
    await fsp.unlink(`${discoveryPath}.${process.pid}.${instanceId}.tmp`).catch(() => {})
  }

  async function closeServer() {
    if (!server) return
    const instance = server
    server = null
    boundPort = null
    await new Promise(resolve => {
      instance.close(() => resolve())
      instance.closeAllConnections?.()
    })
  }

  /**
   * Forward one request from the host's own origin to this console.
   *
   * The host's main panel renders natively inside the shell page, so it cannot
   * frame this loopback page: a cross-origin fetch would need CORS headers and
   * a private-network exemption. Instead the node half exposes a single prefix
   * route on the host web server (`/superagent/api` → `/api`) and this handler
   * relays it, adding the bearer token the browser never sees. Streaming
   * responses (the event feed) are piped, not buffered.
   *
   * @param {import('node:http').IncomingMessage} req - request from the host origin.
   * @param {import('node:http').ServerResponse} res - response back to the host origin.
   */
  function proxy(req, res) {
    if (!boundPort) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, message: 'the console is not listening yet', reason: 'not-ready' }))
      return
    }
    const prefix = '/superagent/api'
    const incoming = String(req.url ?? '/')
    const target = incoming.startsWith(prefix) ? `/api${incoming.slice(prefix.length)}` : '/api/console/state'
    const headers = { ...req.headers, host: `127.0.0.1:${boundPort}`, authorization: `Bearer ${token}` }
    // The upstream answer is neither compressed nor chunk-framed for us.
    delete headers['accept-encoding']
    delete headers['if-none-match']
    delete headers['if-modified-since']
    const upstream = request({
      host: '127.0.0.1',
      port: boundPort,
      method: req.method,
      path: target,
      headers,
    }, answer => {
      // Hop-by-hop headers belong to each leg, not to the relayed message.
      const carried = { ...answer.headers }
      delete carried.connection
      delete carried['keep-alive']
      delete carried['transfer-encoding']
      res.writeHead(answer.statusCode ?? 502, carried)
      res.flushHeaders?.()
      answer.pipe(res)
    })
    upstream.on('error', error => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, message: `the console did not answer: ${messageOf(error)}` }))
        return
      }
      res.destroy()
    })
    // A closed panel or a finished stream stops the upstream leg too.
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }

  return {
    discoveryPath,
    askApproval,
    proxy,
    /** The conversation this page currently shows; null before one is created. */
    get sessionId() {
      return currentSessionId
    },
    get token() {
      return token
    },
    get port() {
      return boundPort
    },
    get url() {
      return boundPort ? url() : null
    },

    /** Bind the loopback port, load the page, and publish the discovery file. */
    async start() {
      if (server) return { port: boundPort, url: url() }
      if (starting) return starting
      if (stopRequested) throw new Error('the console has been stopped; a new instance is required')
      const run = (async () => {
        page = await fsp.readFile(new URL('../public/console.html', import.meta.url), 'utf8')
        const instance = createServer((req, res) => {
          handle(req, res).catch(error => {
            log(`console handler crashed: ${messageOf(error)}`)
            send(res, 500, errorPayload(error))
          })
        })
        instance.requestTimeout = REQUEST_TIMEOUT_MS
        instance.headersTimeout = 10_000
        instance.keepAliveTimeout = 5_000
        instance.maxConnections = 64
        await new Promise((resolve, reject) => {
          instance.once('error', reject)
          instance.listen(port, '127.0.0.1', () => {
            instance.off('error', reject)
            resolve()
          })
        })
        const address = instance.address()
        if (!address || typeof address === 'string') throw new Error('the console listener has no TCP address')
        boundPort = address.port
        server = instance
        await writeDiscovery()
        if (router) {
          stopRouterEvents = router.subscribe(revision => broadcast({ type: 'router.changed', revision }))
          router.start()
        }
        // Warm the run list for a remembered conversation. The host keeps runs
        // durable, so this is a read; without it `/state` and the first
        // bootstrap report "no runs" until some page has attached, which reads
        // as lost history even though the runs are on disk.
        if (currentSessionId) refreshRuns().catch(() => {})
        if (timelineOversized) saveTimeline(true)
        return { port: boundPort, url: url() }
      })()
      starting = run
      try {
        return await run
      } finally {
        starting = null
      }
    },

    /** Close the socket, stop the stream, and remove the discovery file. */
    async stop() {
      if (closing) return closing
      stopRequested = true
      closing = (async () => {
        detach()
        // Flush before forgetting the id: a graceful stop must leave the next
        // start able to reopen this conversation, not erase it. Await it so a
        // restart that follows immediately cannot read a half-written file.
        if (!router) await saveTimeline(true)
        else {
          stopRouterEvents?.()
          for (const pending of approvals.values()) pending.settle('cancelled')
          await router.stop()
        }
        currentSessionId = null
        for (const res of clients) {
          try {
            writeFrame(res, { type: 'closed', seq: nextSeq(), at: new Date().toISOString() })
            res.end()
          } catch {
            // The socket is already gone.
          }
        }
        clients.clear()
        await closeServer()
        await removeDiscovery()
      })()
      try {
        await closing
      } finally {
        closing = null
      }
    },
  }
}
