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
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import {
  errorPayload,
  readJson,
  sameToken,
  send,
  sendText,
  statusFor,
  WorkbenchError,
} from './workbench.js'

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
 */
export function createConsole({ port, stateRoot, host, version, log = () => {} }) {
  if (!host || typeof host !== 'object') throw new Error('createConsole needs a host adapter')
  const token = randomBytes(32).toString('base64url')
  const instanceId = randomBytes(6).toString('hex')
  const discoveryPath = path.join(stateRoot, DISCOVERY_FILE)
  const timelinePath = path.join(stateRoot, TIMELINE_FILE)
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
  const timeline = readTimeline()
  let currentSessionId = timeline.sessionId
  // Only a remembered conversation is forgotten on failure: a fresh one that
  // cannot stream should stay, so the next message resumes it instead of
  // silently starting another.
  let rememberedSessionId = currentSessionId
  let unsubscribe = null
  let runTimer = null
  let lastRuns = null
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
   * @returns {Promise<void>} resolves once the target holds the new bytes.
   */
  async function replaceTimeline(tmp) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, timelinePath)
        return
      } catch (error) {
        const transient = error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY'
        if (!transient || attempt >= 4) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
      }
    }
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
    if (clients.size === 0) return Promise.resolve('cancelled')
    const toolName = typeof request.toolName === 'string' && request.toolName ? request.toolName : 'tool'
    if (sessionAllowedTools.has(toolName)) {
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
    lastRunsJson = ''
  }

  async function refreshRuns({ force = false } = {}) {
    const sessionId = currentSessionId
    if (!sessionId) return []
    let runs
    try {
      runs = await host.listRuns(sessionId)
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
    const json = JSON.stringify(rows)
    lastRuns = rows
    if (force || json !== lastRunsJson) {
      lastRunsJson = json
      broadcast({ type: 'runs', sessionId, runs: rows })
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

  async function createSession() {
    const caps = capabilities()
    if (!caps.chat) {
      throw new WorkbenchError(503, caps.reason ?? 'the host exposes no conversation session API', {
        id: 'console-unavailable',
        hint: 'the host must mount sessionController; this page does not fake a conversation when it is missing.',
      })
    }
    let created
    try {
      created = await host.createSession()
    } catch (error) {
      throw new WorkbenchError(502, `cannot create a conversation session: ${messageOf(error)}`, {
        id: 'session-create-failed',
      })
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new WorkbenchError(502, 'the host created a session but returned no id', { id: 'session-create-failed' })
    }
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
    if (currentSessionId) return { sessionId: currentSessionId, capabilities: capabilities() }
    return createSession()
  }

  async function state() {
    const caps = capabilities()
    return {
      mode: caps.chat ? 'chat' : 'unavailable',
      capabilities: caps,
      sessionId: currentSessionId,
      runs: currentSessionId ? lastRuns ?? [] : [],
      approvals: [...approvals.values()].map(entry => entry.payload),
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
    if (!currentSessionId) {
      throw new WorkbenchError(409, 'create a conversation session before opening the event stream', {
        id: 'no-session',
        hint: 'POST /api/console/session first.',
      })
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
      mode: 'chat',
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
      writeFrame(res, { type: 'runs', seq: nextSeq(), at: new Date().toISOString(), sessionId: currentSessionId, runs: lastRuns })
    }
    attach(currentSessionId)
    if (!cached) seedFromHost(currentSessionId).catch(() => {})
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
      if (clients.size === 0) {
        detach()
        // A decision can no longer arrive: settle every pending question
        // cancelled now instead of leaving the tool call parked until the
        // ten-minute deadline. Cancellation is the fail-closed outcome, so a
        // closed page or a dropped stream never approves anything.
        for (const entry of [...approvals.values()]) entry.settle('cancelled')
      }
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
    const sessionId = currentSessionId
    if (!sessionId) throw new WorkbenchError(409, 'there is no conversation yet', { id: 'no-session' })
    const raw = (parsed.searchParams.get('path') || '').trim()
    if (!raw) throw new WorkbenchError(400, 'path is required', { id: 'missing-path' })
    const target = path.resolve(raw)
    const runId = (parsed.searchParams.get('runId') || '').trim()
    let reports = []
    if (runId && typeof host.readRun === 'function') {
      const run = await host.readRun(sessionId, runId)
      reports = typeof run?.report === 'string' ? [run.report] : []
    } else if (typeof host.listRuns === 'function') {
      const rows = await host.listRuns(sessionId)
      reports = (Array.isArray(rows) ? rows : [])
        .map(run => run?.report)
        .filter(report => typeof report === 'string')
    }
    const variants = [raw, target, target.replace(/\\/g, '/'), target.replace(/\//g, '\\')]
    const listed = reports.some(report => variants.some(value => value && report.includes(value)))
    if (!listed) {
      throw new WorkbenchError(403, 'this path is not named in any run report', {
        id: 'artifact-not-listed',
        hint: 'only files a run reported can be previewed here; copy the path and open it in your editor instead.',
      })
    }
    const type = ARTIFACT_TYPES.get(path.extname(target).toLowerCase())
    if (!type) {
      throw new WorkbenchError(415, 'this file type is not previewable in the console', { id: 'artifact-type' })
    }
    let stat
    try {
      stat = await fsp.stat(target)
    } catch {
      throw new WorkbenchError(404, 'the run named this file but it is no longer on disk', { id: 'artifact-missing' })
    }
    if (!stat.isFile()) throw new WorkbenchError(404, 'that path is not a file', { id: 'artifact-not-file' })
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new WorkbenchError(413, `the file is above the ${MAX_ARTIFACT_BYTES}-byte preview limit`, {
        id: 'artifact-too-large',
      })
    }
    const body = await fsp.readFile(target)
    const headers = {
      'content-disposition': `inline; filename="${path.basename(target).replace(/["\\]/g, '_')}"`,
    }
    if (type.startsWith('text/html')) headers['content-security-policy'] = ARTIFACT_PAGE_CSP
    sendText(res, 200, body, type, headers)
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
        // allowed from loopback origins only — the token still gates the page.
        sendText(res, 200, page, 'text/html; charset=utf-8', {
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            + "connect-src 'self'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; "
            + "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*",
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
        const created = await ensureSession()
        send(res, 200, { ok: true, data: { ...(await state()), ...created } })
        return
      }

      if (leaf === 'session' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const created = await createSession()
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

      if (leaf === 'session' && parts.length === 4 && parts[3] === 'switch') {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId) throw new WorkbenchError(400, 'sessionId is required', { id: 'missing-session-id' })
        send(res, 200, { ok: true, data: await switchSession(sessionId) })
        return
      }

      if (leaf === 'message' && parts.length === 3) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) throw new WorkbenchError(400, 'text is required', { id: 'missing-text' })
        if (text.length > MAX_TEXT) {
          throw new WorkbenchError(413, `text is above the ${MAX_TEXT}-character limit`, { id: 'text-too-long' })
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
        const ensured = await ensureSession()
        let result
        try {
          result = await host.answer({ sessionId: ensured.sessionId, runId, attentionId, answer })
        } catch (error) {
          throw new WorkbenchError(502, `the answer was not applied: ${messageOf(error)}`, {
            id: 'answer-failed',
          })
        }
        broadcast({ type: 'answered', sessionId: ensured.sessionId, runId, attentionId, answer })
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

      if (leaf === 'runs' && parts.length === 5 && parts[4] === 'cancel') {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        if (!currentSessionId) throw new WorkbenchError(409, 'no conversation is open', { id: 'no-session' })
        if (typeof host.cancelRun !== 'function') {
          throw new WorkbenchError(501, 'this host cannot cancel runs from the console', { id: 'cancel-unavailable' })
        }
        const runId = decodeURIComponent(parts[3])
        let result
        try {
          result = await host.cancelRun(currentSessionId, runId)
        } catch (error) {
          throw new WorkbenchError(502, `the run was not cancelled: ${messageOf(error)}`, { id: 'cancel-failed' })
        }
        if (!result) throw new WorkbenchError(404, `no run ${runId} for this conversation`, { id: 'unknown-run' })
        broadcast({ type: 'canceling', sessionId: currentSessionId, runId, status: result.status })
        await refreshRuns({ force: true }).catch(() => {})
        send(res, 200, { ok: true, data: result })
        return
      }

      if (leaf === 'runs' && parts.length <= 4) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        if (!currentSessionId) {
          send(res, 200, { ok: true, data: { runs: [] } })
          return
        }
        if (parts.length === 3) {
          send(res, 200, { ok: true, data: { runs: await refreshRuns({ force: true }) } })
          return
        }
        const runId = decodeURIComponent(parts[3])
        if (typeof host.readRun !== 'function') {
          throw new WorkbenchError(404, `no route for ${method} ${pathname}`, { id: 'not-found' })
        }
        const run = await host.readRun(currentSessionId, runId)
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

  return {
    discoveryPath,
    askApproval,
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
        await saveTimeline(true)
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
