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
const MAX_CLIENTS = 16
const MAX_TEXT = 20_000
const MAX_FRAME_BYTES = 512 * 1024
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const MAX_RECORDS = 400
const MAX_RECORD_BYTES = 1024 * 1024
const HEARTBEAT_MS = 15_000
const RUN_POLL_MS = 1_200
const REQUEST_TIMEOUT_MS = 30_000
const ROUTE_HINT = 'GET / serves the console; the JSON API is under /api/console.'

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
  const startedAt = new Date().toISOString()
  const clients = new Set()
  let boundPort = null
  let server = null
  let page = null
  let starting = null
  let closing = null
  let stopRequested = false
  let currentSessionId = null
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
          mergeRecords([{ type: 'event', event: frame.event }])
        }
        broadcast(frame)
      })
    } catch (error) {
      log(`console: cannot subscribe to conversation ${sessionId}: ${messageOf(error)}`)
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
      detach()
      currentSessionId = sessionId
      resetStore(sessionId)
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
    }
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
      if (clients.size === 0) detach()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  async function handle(req, res) {
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      const pathname = parsed.pathname

      if (pathname === '/' || pathname === '/console' || pathname === '/index.html') {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        authorize(req, { allowQuery: true })
        sendText(res, 200, page, 'text/html; charset=utf-8', {
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
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
