/**
 * Local HTTP control plane for dsh-superagent.
 *
 * The five tools only exist inside a host session. Another UI — an editor
 * panel, a dashboard, a script — cannot call them without importing this
 * package's internals and holding a live agent. This module exposes the same
 * five operations over loopback HTTP so an embedder needs nothing but `fetch`.
 *
 * Safety properties, in order of importance:
 *
 * - Off unless `controlPort` is configured. A plugin should not open a socket
 *   just because it was installed.
 * - Bound to 127.0.0.1, never a routable interface.
 * - Every request needs `Authorization: Bearer <token>`. The token is random
 *   per process and written to `<stateDir>/control.json` with mode 0600, so it
 *   is readable by the user who runs the host and nobody else.
 * - The `Host` header must name the loopback address and port we listen on,
 *   which blocks DNS-rebinding attacks from a browser page.
 * - No CORS headers are sent, so a page on another origin cannot read replies.
 * - Bodies are capped, requests time out, and long polls are capped, so a
 *   wedged client cannot pin the host.
 *
 * The HTTP layer is transport only: every action is a callback supplied by the
 * plugin, so a start over HTTP goes through exactly the same checks as
 * `superagent_start` (live session, child guard, quota, budgets).
 *
 * @module dsh-superagent/control
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fsp from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { classifyError } from './errors.js'

/** Bodies are JSON commands, never uploaded files. */
const BODY_LIMIT = 64 * 1024
/** Longest block one request may ask for. `superagent_status` caps at 3600 s. */
const MAX_WAIT_SECONDS = 300
/** Must exceed MAX_WAIT_SECONDS, or a legitimate long poll is cut by the server. */
const REQUEST_TIMEOUT_MS = (MAX_WAIT_SECONDS + 20) * 1000
const DISCOVERY_FILE = 'control.json'
const ROUTE_HINT = 'GET / lists the endpoints; docs/embedding.md has request and response examples.'

/** Error shape used by the routing layer to choose a status code. */
class HttpError extends Error {
  constructor(status, message, { id = 'bad-request', hint } = {}) {
    super(message)
    this.status = status
    this.id = id
    this.hint = hint
  }
}

function clampWait(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.min(MAX_WAIT_SECONDS, Math.trunc(seconds))
}

function sameToken(given, expected) {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res, status, payload) {
  if (res.headersSent) return
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Map a thrown error to an HTTP status using the same classifier users see. */
function statusFor(error) {
  if (error instanceof HttpError) return error.status
  switch (classifyError(error).id) {
    case 'unknown-run':
      return 404
    case 'no-goal':
      return 400
    case 'run-owned':
    case 'quota':
    case 'budget':
    case 'no-agent':
    case 'no-session':
      return 409
    case 'no-subagents':
      // The host lacks a service the plugin needs; no request can fix that.
      return 503
    default:
      // Includes corrupt state: a broken file is ours to fix, not the caller's.
      return 500
  }
}

function errorPayload(error) {
  if (error instanceof HttpError) {
    // Transport-level refusals are not host failures; do not dress them in the
    // "call superagent_list and retry" hint meant for a broken run.
    return {
      ok: false,
      error: { id: error.id, summary: error.message, hint: error.hint ?? null, detail: error.message },
    }
  }
  const { id, summary, hint, detail } = classifyError(error)
  return { ok: false, error: { id, summary, hint, detail } }
}

/**
 * Read a request body as text, refusing anything over the cap.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<string>} body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        // Keep draining instead of destroying the socket: the client then gets
        // a readable 413 rather than a connection reset it cannot interpret.
        fail(new HttpError(413, `request body is larger than ${BODY_LIMIT} bytes`, {
          id: 'body-too-large',
          hint: 'send only the documented JSON fields; reports and files are not accepted here.',
        }))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
    req.on('aborted', () => fail(new HttpError(400, 'the client aborted the request', { id: 'aborted' })))
  })
}

async function readJson(req) {
  const text = (await readBody(req)).trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    return parsed
  } catch (error) {
    throw new HttpError(400, `request body is not a JSON object: ${error?.message ?? error}`, {
      id: 'bad-json',
      hint: 'send a JSON object such as {"goal": "...", "session_id": "..."}.',
    })
  }
}

/**
 * Create the control plane. Nothing is bound until `start()` is called.
 *
 * @param {object} options - dependencies.
 * @param {number} options.port - 1–65535, or 0 for an ephemeral port.
 * @param {string} options.stateRoot - directory that receives `control.json`.
 * @param {string} options.version - plugin version reported by `/health`.
 * @param {{
 *   list: (query: object) => Promise<object>,
 *   status: (runId: string, waitSeconds: number) => Promise<object>,
 *   start: (body: object) => Promise<object>,
 *   cancel: (runId: string) => Promise<object>,
 *   resume: (runId: string, body: object) => Promise<object>,
 * }} options.actions - plugin operations; each returns a serializable payload.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 */
export function createControlPlane({ port, stateRoot, version, actions, log = () => {} }) {
  const token = randomBytes(32).toString('base64url')
  const discoveryPath = path.join(stateRoot, DISCOVERY_FILE)
  const startedAt = new Date().toISOString()
  let boundPort = null
  let server = null
  let closing = null
  let starting = null
  let stopRequested = false

  const url = () => `http://127.0.0.1:${boundPort}`
  const allowedHosts = () => new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  ])

  function authorize(req) {
    if (!boundPort) {
      throw new HttpError(503, 'the control plane is not listening yet', {
        id: 'not-ready',
        hint: 'the host is still binding the port; retry in a moment. If it persists, check the host log for a controlPort error.',
      })
    }
    const host = String(req.headers.host ?? '').toLowerCase()
    // A browser page pointed at 127.0.0.1 by DNS rebinding sends its own
    // hostname here. Requiring the loopback name closes that path.
    if (!allowedHosts().has(host)) {
      throw new HttpError(
        403,
        `unexpected Host header "${host}"; the control plane answers only on 127.0.0.1 and localhost`,
        { id: 'forbidden-host', hint: `connect to ${boundPort ? url() : 'the URL in the discovery file'} directly.` },
      )
    }
    const header = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    if (!match || !sameToken(match[1], token)) {
      throw new HttpError(401, 'missing or wrong bearer token', {
        id: 'unauthorized',
        hint: `read the "token" field in ${discoveryPath} and send "Authorization: Bearer <token>". `
          + 'The token is regenerated each time the host starts.',
      })
    }
  }

  /**
   * Route one request. Kept separate from the socket so tests can drive it
   * through a real server without any special-case code.
   */
  async function handle(req, res) {
    try {
      authorize(req)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean)
      const method = req.method ?? 'GET'

      if (parts.length === 0) {
        if (method !== 'GET') throw new HttpError(405, 'only GET is allowed here', { id: 'method-not-allowed', hint: ROUTE_HINT })
        send(res, 200, {
          ok: true,
          data: {
            service: 'dsh-superagent',
            version,
            pid: process.pid,
            endpoints: ['GET /health', 'GET /runs', 'GET /runs/:id', 'POST /runs', 'POST /runs/:id/cancel', 'POST /runs/:id/resume'],
          },
        })
        return
      }

      if (parts[0] === 'health') {
        if (method !== 'GET') throw new HttpError(405, 'only GET is allowed here', { id: 'method-not-allowed', hint: ROUTE_HINT })
        const health = await actions.health?.()
        send(res, 200, {
          ok: true,
          data: {
            service: 'dsh-superagent',
            version,
            pid: process.pid,
            hostname: os.hostname(),
            stateDir: stateRoot,
            startedAt,
            uptimeSeconds: Math.round(process.uptime()),
            ...(health ?? {}),
          },
        })
        return
      }

      if (parts[0] !== 'runs' || parts.length > 3) {
        throw new HttpError(404, `no route for ${method} ${url.pathname}`, { id: 'not-found', hint: ROUTE_HINT })
      }

      if (parts.length === 1) {
        if (method === 'GET') {
          const payload = await actions.list({ limit: url.searchParams.get('limit') })
          send(res, 200, { ok: true, data: payload.data, text: payload.text })
          return
        }
        if (method === 'POST') {
          const body = await readJson(req)
          const payload = await actions.start(body)
          send(res, 202, { ok: true, data: payload.data, text: payload.text })
          return
        }
        throw new HttpError(405, `${method} is not allowed on /runs; use GET or POST`, { id: 'method-not-allowed', hint: ROUTE_HINT })
      }

      let runId = ''
      try {
        runId = decodeURIComponent(parts[1])
      } catch {
        // A malformed escape is the caller's mistake, not a host failure.
        throw new HttpError(400, `run id "${parts[1]}" is not valid percent-encoding`, { id: 'bad-run-id', hint: ROUTE_HINT })
      }
      if (!runId) throw new HttpError(400, 'run id is empty', { id: 'bad-run-id', hint: ROUTE_HINT })

      if (parts.length === 2) {
        if (method !== 'GET') throw new HttpError(405, `${method} is not allowed on /runs/:id; use GET`, { id: 'method-not-allowed', hint: ROUTE_HINT })
        const wait = clampWait(url.searchParams.get('wait'))
        const payload = await actions.status(runId, wait)
        send(res, 200, { ok: true, data: payload.data, text: payload.text })
        return
      }

      const action = parts[2]
      if (action !== 'cancel' && action !== 'resume') {
        throw new HttpError(404, `no route for ${method} ${url.pathname}`, { id: 'not-found', hint: ROUTE_HINT })
      }
      if (method !== 'POST') {
        throw new HttpError(405, `${method} is not allowed on /runs/:id/${action}; use POST`, { id: 'method-not-allowed', hint: ROUTE_HINT })
      }
      if (action === 'cancel') {
        const payload = await actions.cancel(runId)
        send(res, 200, { ok: true, data: payload.data, text: payload.text })
        return
      }
      const body = await readJson(req)
      const payload = await actions.resume(runId, body)
      send(res, 202, { ok: true, data: payload.data, text: payload.text })
    } catch (error) {
      const status = statusFor(error)
      // A 5xx is a plugin bug or a broken state directory; say so in the host
      // log as well, because the client may never read the response.
      if (status >= 500) log(`control request failed: ${error?.message ?? error}`)
      send(res, status, errorPayload(error))
    }
  }

  async function writeDiscovery() {
    const doc = {
      service: 'dsh-superagent',
      version,
      url: url(),
      token,
      pid: process.pid,
      hostname: os.hostname(),
      stateDir: stateRoot,
      startedAt,
    }
    const tmp = `${discoveryPath}.${process.pid}.tmp`
    // 0600 before any content is written: the token must never be readable by
    // another user, not even during the write.
    await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
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
      // Another process may have replaced the file after this one stopped
      // listening; deleting its discovery file would break that process.
      if (current?.pid !== process.pid) return
      await fsp.unlink(discoveryPath)
    } catch {
      // Already gone, or replaced by something unreadable. Nothing to remove.
    }
  }

  /** Close the listening socket, if any, and forget its port. */
  async function closeServer() {
    if (!server) return
    const instance = server
    server = null
    boundPort = null
    await new Promise(resolve => {
      instance.close(() => resolve())
      // Long polls hold sockets open; do not wait for them to finish.
      instance.closeAllConnections?.()
    })
  }

  return {
    discoveryPath,
    get port() {
      return boundPort
    },
    get url() {
      return boundPort ? url() : null
    },

    /**
     * Bind the loopback port and publish the discovery file.
     *
     * The whole operation is tracked in `starting` so a dispose that lands in
     * the middle of it cannot leave a listener behind: `stop()` waits for the
     * start to settle, and a start that sees `stopRequested` closes itself
     * before it ever publishes a discovery file.
     *
     * @returns {Promise<{ port: number, url: string }>} where it listens.
     */
    async start() {
      if (server) return { port: boundPort, url: url() }
      if (stopRequested) throw new Error('the control plane has been stopped; a new instance is required')
      const run = (async () => {
        const instance = createServer((req, res) => {
          handle(req, res).catch(error => {
            log(`control handler crashed: ${error?.message ?? error}`)
            send(res, 500, errorPayload(error))
          })
        })
        instance.requestTimeout = REQUEST_TIMEOUT_MS
        instance.headersTimeout = 10_000
        instance.keepAliveTimeout = 5_000
        instance.maxConnections = 64
        await new Promise((resolve, reject) => {
          const onError = error => reject(error)
          instance.once('error', onError)
          instance.listen(port, '127.0.0.1', () => {
            instance.off('error', onError)
            resolve()
          })
        })
        server = instance
        boundPort = instance.address().port
        if (stopRequested) {
          await closeServer()
          throw new Error('the control plane was stopped before it finished starting')
        }
        try {
          await writeDiscovery()
        } catch (error) {
          // Listening without a discovery file is a silent, unreachable server:
          // close it and report the real cause instead of claiming success.
          await closeServer()
          throw new Error(`cannot write the discovery file ${discoveryPath}: ${error?.message ?? error}`)
        }
        log(`control plane listening on ${url()} (token in ${discoveryPath})`)
        return { port: boundPort, url: url() }
      })()
      starting = run
      try {
        return await run
      } finally {
        starting = null
      }
    },

    /** Close the socket and remove this process's discovery file. */
    async stop() {
      stopRequested = true
      // Let a start that is already binding finish first; otherwise it could
      // publish a discovery file after this stop has cleaned up.
      if (starting) {
        try {
          await starting
        } catch {
          // A start that failed has nothing left to close.
        }
      }
      if (closing) return closing
      closing = (async () => {
        await closeServer()
        await removeDiscovery()
      })()
      return closing
    },
  }
}
