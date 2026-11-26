import { createHash, randomUUID } from 'node:crypto'

/**
 * Serializable remote execution description. In particular, this must never
 * contain a live Agent, tool implementation, credential, AbortSignal, or
 * runtime capability. Secrets travel only as provider-side references.
 *
 * @typedef {object} WorkSpec
 * @property {{ id: string }} run
 * @property {{ id: string }} subtask
 * @property {number} attempt
 * @property {{ provider?: string, ref: string, commit?: string }} repoSnapshot
 * @property {string} prompt
 * @property {{ provider?: string, ref: string }} model
 * @property {{ allow: string[], deny?: string[] }} toolScope
 * @property {{ mode: 'manual'|'policy'|'never', scopes?: string[] }} approvalScope
 * @property {{ maxTokens?: number, maxCostUsd?: number, maxWallSeconds?: number, maxToolCalls?: number }} budget
 * @property {string} deadline An ISO-8601 timestamp.
 * @property {{ ref: string, cursor?: number, metadata?: Record<string, unknown> }} checkpoint
 * @property {{ refs: Array<{ provider: string, ref: string }> }} [secrets]
 */

const PROTOCOL = 'dsh.cloud-worker.v1'
const STATES = new Set(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'stopped', 'timed_out'])
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'stopped', 'timed_out'])
const SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*password|.*passwd|.*secret|.*credential|(?:auth|access|refresh|session|bearer)?token|api[_-]?key|access[_-]?key|private[_-]?key)$/i
const FORBIDDEN_SPEC_KEY = /secret|password|passwd|credential|(?:^|[_-])tokens?(?:$|[_-])|(?:auth|access|refresh|session|bearer)token$|api[_-]?key|private[_-]?key/i
const SECRET_TEXT = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:token|secret|password|api[_-]?key|access[_-]?key)=[^\s&"']+/gi
const SHA256 = /^[a-f0-9]{64}$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export class CloudWorkerError extends Error {
  constructor(message, details = {}) {
    super(redactSensitiveText(message))
    this.name = 'CloudWorkerError'
    this.code = details.code || 'CLOUD_WORKER_ERROR'
    if (details.status !== undefined) this.status = details.status
    if (details.retryable !== undefined) this.retryable = Boolean(details.retryable)
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs
    if (details.workerId !== undefined) this.workerId = redactSensitiveText(String(details.workerId))
    if (details.fencingToken !== undefined) this.fencingToken = details.fencingToken
    if (details.serverCode !== undefined) this.serverCode = details.serverCode
    if (details.serverMessage !== undefined) this.serverMessage = details.serverMessage
  }
}

function fail(code, message, details = {}) {
  throw new CloudWorkerError(message, { code, ...details })
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError')
}

function isAbort(error) {
  return error?.name === 'AbortError'
}

/** Redact values before they reach a logger or an error. Never log headers. */
export function redactSensitiveText(value) {
  return String(value).replace(SECRET_TEXT, '[REDACTED]').slice(0, 1000)
}

export function redactSensitiveValue(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= 8 || seen.has(value)) return '[Truncated]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactSensitiveValue(item, depth + 1, seen))
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactSensitiveValue(child, depth + 1, seen)
  }
  return result
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertJsonValue(value, path = 'workSpec', seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object') fail('CLOUD_WORKER_UNSERIALIZABLE', `${path} contains a non-serializable value`)
  if (depth > 32) fail('CLOUD_WORKER_UNSERIALIZABLE', `${path} is too deeply nested`)
  if (seen.has(value)) fail('CLOUD_WORKER_UNSERIALIZABLE', `${path} contains a cycle`)
  if (Array.isArray(value)) {
    seen.add(value)
    for (let index = 0; index < value.length; index++) assertJsonValue(value[index], `${path}[${index}]`, seen, depth + 1)
    seen.delete(value)
    return
  }
  // Reject Dates, Agents, streams, signals, class instances, and other live objects.
  if (!isPlainObject(value)) fail('CLOUD_WORKER_UNSERIALIZABLE', `${path} must contain only plain JSON objects`)
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_SPEC_KEY.test(key) && !(path === 'workSpec' && key === 'secrets')) {
      // References belong in the dedicated secrets.refs shape below.
      fail('CLOUD_WORKER_SECRET_VALUE', `${path}.${key} may not contain credential material`)
    }
    assertJsonValue(child, `${path}.${key}`, seen, depth + 1)
  }
  seen.delete(value)
}

function requireString(value, path, { max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\0\r\n]/.test(value)) {
    fail('CLOUD_WORKER_INVALID_SPEC', `${path} must be a bounded, non-empty single-line string`)
  }
  return value
}

function requireRef(value, path) {
  if (!isPlainObject(value)) fail('CLOUD_WORKER_INVALID_SPEC', `${path} must be an object`)
  requireString(value.ref, `${path}.ref`)
  if (value.provider !== undefined) requireString(value.provider, `${path}.provider`, { max: 128 })
  return value
}

function requireStringArray(value, path, { optional = false } = {}) {
  if (value === undefined && optional) return
  if (!Array.isArray(value) || value.length > 256) fail('CLOUD_WORKER_INVALID_SPEC', `${path} must be a bounded string array`)
  for (let index = 0; index < value.length; index++) requireString(value[index], `${path}[${index}]`, { max: 256 })
}

function requireNonnegative(value, path, { integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    fail('CLOUD_WORKER_INVALID_SPEC', `${path} must be a non-negative ${integer ? 'integer' : 'number'}`)
  }
}

function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Validate and freeze a WorkSpec, returning a JSON-cloned value with no live
 * runtime objects. The original input is never mutated.
 */
export function createWorkSpec(input) {
  if (!isPlainObject(input)) fail('CLOUD_WORKER_INVALID_SPEC', 'workSpec must be an object')
  const run = input.run
  const subtask = input.subtask
  if (!isPlainObject(run) || !isPlainObject(subtask)) fail('CLOUD_WORKER_INVALID_SPEC', 'run and subtask must contain stable string ids')
  requireString(run.id, 'run.id', { max: 256 })
  requireString(subtask.id, 'subtask.id', { max: 256 })
  if (!Number.isInteger(input.attempt) || input.attempt < 1) fail('CLOUD_WORKER_INVALID_SPEC', 'attempt must be a positive integer')
  requireRef(input.repoSnapshot, 'repoSnapshot')
  requireRef(input.model, 'model')
  requireString(input.prompt, 'prompt', { max: 1_000_000 })
  if (!isPlainObject(input.toolScope)) fail('CLOUD_WORKER_INVALID_SPEC', 'toolScope must be an object')
  requireStringArray(input.toolScope.allow, 'toolScope.allow')
  requireStringArray(input.toolScope.deny, 'toolScope.deny', { optional: true })
  if (!isPlainObject(input.approvalScope) || !['manual', 'policy', 'never'].includes(input.approvalScope.mode)) {
    fail('CLOUD_WORKER_INVALID_SPEC', 'approvalScope.mode must be manual, policy, or never')
  }
  requireStringArray(input.approvalScope.scopes, 'approvalScope.scopes', { optional: true })
  if (!isPlainObject(input.budget)) fail('CLOUD_WORKER_INVALID_SPEC', 'budget must be an object')
  for (const key of ['maxTokens', 'maxCostUsd', 'maxWallSeconds', 'maxToolCalls']) {
    if (input.budget[key] !== undefined) requireNonnegative(input.budget[key], `budget.${key}`, { integer: key !== 'maxCostUsd' })
  }
  if (input.budget.maxWallSeconds === 0) fail('CLOUD_WORKER_INVALID_SPEC', 'budget.maxWallSeconds must be positive')
  requireString(input.deadline, 'deadline', { max: 128 })
  if (!Number.isFinite(Date.parse(input.deadline))) fail('CLOUD_WORKER_INVALID_SPEC', 'deadline must be an ISO-8601 timestamp')
  requireRef(input.checkpoint, 'checkpoint')
  if (input.secrets !== undefined) {
    if (!isPlainObject(input.secrets) || !Array.isArray(input.secrets.refs) || input.secrets.refs.length > 128) {
      fail('CLOUD_WORKER_INVALID_SPEC', 'secrets must contain a bounded array of provider-side references')
    }
    for (let index = 0; index < input.secrets.refs.length; index++) requireRef(input.secrets.refs[index], `secrets.refs[${index}]`)
  }

  // Validate before JSON cloning: JSON.stringify would silently drop functions
  // and undefined, which could turn a live Agent into a misleading empty spec.
  assertJsonValue(input)
  const spec = JSON.parse(JSON.stringify(input))
  return freezeJson(spec)
}

function fenceRank(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  return null
}

function validateFence(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value)) return value
  fail('CLOUD_WORKER_INVALID_FENCE', 'A non-negative integer or bounded opaque fencing token is required')
}

function parseRetryAfter(value, now) {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now()), 60_000) : 0
}

function safeServerError(body, fallback) {
  if (!isPlainObject(body)) return { code: null, message: redactSensitiveText(fallback) }
  const error = isPlainObject(body.error) ? body.error : {}
  const rawCode = body.code || error.code
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode) ? rawCode : null
  const rawMessage = body.message || error.message
  const message = typeof rawMessage === 'string' ? redactSensitiveText(rawMessage).slice(0, 300) : redactSensitiveText(fallback)
  return { code, message }
}

function hashBase64(content, encoding) {
  if (encoding !== 'base64' || typeof content !== 'string' || !BASE64.test(content)) {
    fail('CLOUD_WORKER_ARTIFACT_ENCODING', 'Artifact content must be canonical base64')
  }
  const bytes = Buffer.from(content, 'base64')
  // Buffer's decoder is permissive; round-tripping excludes ignored characters.
  if (bytes.toString('base64') !== content) fail('CLOUD_WORKER_ARTIFACT_ENCODING', 'Artifact content must be canonical base64')
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function safeArtifactPath(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\0\\:]/.test(path) || path.startsWith('/') || path.includes('\r') || path.includes('\n')) {
    fail('CLOUD_WORKER_ARTIFACT_PATH', 'Artifact paths must be bounded relative POSIX paths')
  }
  if (path.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('CLOUD_WORKER_ARTIFACT_PATH', 'Artifact paths may not contain empty, dot, or parent segments')
  }
  return path
}

/** Verify every artifact's declared size and SHA-256 before exposing it. */
export function verifyArtifactManifest(input) {
  const manifest = input?.manifest && isPlainObject(input.manifest) ? input.manifest : input
  if (!isPlainObject(manifest) || !Array.isArray(manifest.entries) || manifest.entries.length > 10_000) {
    fail('CLOUD_WORKER_ARTIFACT_MANIFEST', 'An artifact manifest with bounded entries is required')
  }
  if (manifest.algorithm !== undefined && manifest.algorithm !== 'sha256') {
    fail('CLOUD_WORKER_ARTIFACT_ALGORITHM', 'Only SHA-256 artifact manifests are supported')
  }
  const paths = new Set()
  const entries = manifest.entries.map((entry, index) => {
    if (!isPlainObject(entry)) fail('CLOUD_WORKER_ARTIFACT_MANIFEST', `entries[${index}] must be an object`)
    const path = safeArtifactPath(entry.path)
    if (paths.has(path)) fail('CLOUD_WORKER_ARTIFACT_DUPLICATE', 'Artifact paths must be unique')
    paths.add(path)
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
      fail('CLOUD_WORKER_ARTIFACT_DIGEST', `entries[${index}].sha256 must be a SHA-256 hex digest`)
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail('CLOUD_WORKER_ARTIFACT_SIZE', `entries[${index}].size must be a non-negative integer`)
    const content = entry.content ?? entry.contentBase64
    if (content === undefined) fail('CLOUD_WORKER_ARTIFACT_CONTENT', `entries[${index}] must include inline base64 content`)
    const { bytes, sha256 } = hashBase64(content, entry.encoding ?? 'base64')
    if (bytes.length !== entry.size) fail('CLOUD_WORKER_ARTIFACT_SIZE', `Artifact size mismatch at entries[${index}]`)
    if (sha256 !== entry.sha256.toLowerCase()) fail('CLOUD_WORKER_ARTIFACT_DIGEST', `Artifact SHA-256 mismatch at entries[${index}]`)
    return { path, size: entry.size, sha256, encoding: 'base64', content }
  })
  return { version: manifest.version ?? 1, algorithm: 'sha256', entries }
}

function credentialExpiry(value) {
  if (value === undefined || value === null) return null
  const numeric = typeof value === 'number' ? value : Number(value)
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

function assertBaseUrl(baseUrl) {
  let url
  try { url = new URL(baseUrl) } catch { fail('CLOUD_WORKER_CONFIG', 'baseUrl must be an absolute HTTP(S) URL') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail('CLOUD_WORKER_CONFIG', 'baseUrl must be an HTTP(S) origin or path without credentials, query, or fragment')
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    fail('CLOUD_WORKER_CONFIG', 'Remote cloud worker endpoints must use HTTPS')
  }
  return url.toString().replace(/\/$/, '')
}

function abortableDelay(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Create an HTTP client implementing the remote Worker provider contract.
 *
 * Protocol endpoints (all bodies/responses are JSON):
 * - POST   /v1/workers                         { workSpec }
 * - GET    /v1/workers/:id
 * - GET    /v1/workers/:id/events?cursor=N      { events, nextCursor, hasMore, state? }
 * - POST   /v1/workers/:id/reattach            { cursor }
 * - POST   /v1/workers/:id/cancel               { expectedFencingToken }
 * - POST   /v1/workers/:id/artifacts/finalize   { expectedFencingToken }
 *
 * Authenticated worker reads/writes carry X-Worker-Lease-Id and
 * X-Worker-Fencing-Token. A 409/STALE_FENCE response is never retried.
 * `credentials` may be a short-lived token object or an async token resolver.
 * No credential is sent when it resolves to null/undefined.
 */
export function createRemoteWorkerProvider(options = {}) {
  if (!isPlainObject(options)) fail('CLOUD_WORKER_CONFIG', 'Provider options must be an object')
  const baseUrl = assertBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') fail('CLOUD_WORKER_CONFIG', 'fetchImpl must be a function')
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxRetries = options.maxRetries ?? 2
  const retryBaseMs = options.retryBaseMs ?? 100
  const retryMaxMs = options.retryMaxMs ?? 5_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const eventMaxReconnects = options.eventMaxReconnects ?? 5
  const now = options.now || (() => Date.now())
  const logger = options.logger
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxRetries) || maxRetries < 0 ||
      !Number.isFinite(retryBaseMs) || retryBaseMs < 0 || !Number.isFinite(retryMaxMs) || retryMaxMs < retryBaseMs ||
      !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || !Number.isInteger(eventMaxReconnects) || eventMaxReconnects < 0) {
    fail('CLOUD_WORKER_CONFIG', 'Invalid retry, timeout, or event polling configuration')
  }
  const credentials = options.credentials ?? options.auth
  if (credentials !== undefined && typeof credentials !== 'function' && !isPlainObject(credentials) && typeof credentials !== 'string') {
    fail('CLOUD_WORKER_CONFIG', 'credentials must be a token, token object, or async resolver')
  }

  let closed = false
  const subscriptions = new Set()
  const knownFences = new Map()

  function log(event, details = {}) {
    if (!logger) return
    for (const method of ['debug', 'warn', 'error']) {
      if (typeof logger[method] === 'function') {
        logger[method](redactSensitiveValue({ event, ...details }))
        return
      }
    }
    if (typeof logger === 'function') logger(redactSensitiveValue({ event, ...details }))
  }

  function ensureOpen() {
    if (closed) fail('CLOUD_WORKER_CLOSED', 'The cloud worker provider is closed')
  }

  async function authorizationHeaders() {
    if (credentials === undefined || credentials === null) return {}
    let resolved
    try {
      resolved = typeof credentials === 'function' ? await credentials() : credentials
    } catch {
      // Resolver errors can embed tokens or signed URLs; never propagate them.
      fail('CLOUD_WORKER_AUTH', 'The cloud worker credential resolver failed')
    }
    if (resolved === undefined || resolved === null) return {}
    const token = typeof resolved === 'string' ? resolved : resolved.token
    if (typeof token !== 'string' || !token || token.length > 16_384 || /[\r\n]/.test(token)) {
      fail('CLOUD_WORKER_AUTH', 'The credential resolver must return a bounded token or no credentials')
    }
    const expiresAt = credentialExpiry(typeof resolved === 'string' ? undefined : resolved.expiresAt)
    if (expiresAt !== null && !Number.isFinite(expiresAt)) fail('CLOUD_WORKER_AUTH', 'credential expiresAt must be a valid timestamp')
    if (expiresAt !== null && expiresAt <= now() + 1_000) fail('CLOUD_WORKER_AUTH_EXPIRED', 'The short-lived cloud worker token has expired')
    return { Authorization: `Bearer ${token}` }
  }

  function observeFence(workerId, fencingToken) {
    validateFence(fencingToken)
    const token = validateFence(fencingToken)
    const previous = knownFences.get(workerId)
    if (previous !== undefined) {
      const oldRank = fenceRank(previous)
      const newRank = fenceRank(token)
      if (oldRank !== null && newRank !== null) {
        if (newRank < oldRank) fail('CLOUD_WORKER_STALE_FENCE', 'The worker returned an older fencing token', { workerId, fencingToken: previous })
        knownFences.set(workerId, newRank)
        return
      }
      if (previous !== token) fail('CLOUD_WORKER_STALE_FENCE', 'The worker returned a different opaque fencing token', { workerId, fencingToken: previous })
    }
    knownFences.set(workerId, token)
  }

  function assertCurrentFence(workerId, fencingToken) {
    const token = validateFence(fencingToken)
    const previous = knownFences.get(workerId)
    if (previous !== undefined) {
      const oldRank = fenceRank(previous)
      const newRank = fenceRank(token)
      if (oldRank !== null && newRank !== null ? newRank < oldRank : previous !== token) {
        fail('CLOUD_WORKER_STALE_FENCE', 'A stale worker lease cannot access this execution', { workerId, fencingToken: previous })
      }
    }
    return token
  }

  function leaseHeaders(options) {
    const leaseId = options.leaseId ?? options.lease?.id ?? options.lease?.leaseId
    requireString(leaseId, 'leaseId', { max: 512 })
    const token = assertCurrentFence(options.workerId, options.fencingToken ?? options.lease?.fencingToken)
    return { 'X-Worker-Lease-Id': leaseId, 'X-Worker-Fencing-Token': String(token) }
  }

  async function requestJson({ method, path, body, headers = {}, signal, retryable = true, workerId }) {
    if (signal?.aborted) throw abortError()
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw abortError()
      const controller = new AbortController()
      let timedOut = false
      let removeAbort = () => {}
      const onAbort = () => controller.abort(signal.reason)
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new DOMException('Cloud worker request timed out', 'TimeoutError'))
      }, timeoutMs)
      try {
        const auth = await authorizationHeaders()
        if (signal?.aborted) throw abortError()
        const response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: { Accept: 'application/json', ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        })
        if (!response || typeof response.status !== 'number') fail('CLOUD_WORKER_PROTOCOL', 'The cloud worker endpoint returned an invalid HTTP response')
        const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'), now())
        const retryableStatus = response.status === 408 || response.status === 429 || response.status >= 500
        if (!response.ok) {
          let payload = null
          try {
            const text = await response.text()
            payload = JSON.parse(text.slice(0, 65_536))
          } catch { /* Error bodies are optional and are never trusted/logged verbatim. */ }
          const server = safeServerError(payload, `HTTP ${response.status}`)
          const code = response.status === 401 ? 'CLOUD_WORKER_UNAUTHORIZED'
            : response.status === 403 ? 'CLOUD_WORKER_FORBIDDEN'
              : response.status === 409 && (server.code === 'STALE_FENCE' || server.code === 'FENCING_REQUIRED') ? 'CLOUD_WORKER_STALE_FENCE'
                : response.status === 429 ? 'CLOUD_WORKER_RATE_LIMITED' : 'CLOUD_WORKER_HTTP'
          if (code === 'CLOUD_WORKER_STALE_FENCE') {
            const current = payload?.currentFencingToken ?? payload?.error?.currentFencingToken
            if (current !== undefined) observeFence(workerId, current)
          }
          const error = new CloudWorkerError(`Cloud worker request failed: ${server.message}`, {
            code,
            status: response.status,
            retryable: retryable && retryableStatus && code !== 'CLOUD_WORKER_STALE_FENCE',
            retryAfterMs,
            workerId,
            serverCode: server.code,
            serverMessage: server.message,
          })
          log('http_error', { method, path, status: response.status, code, workerId, attempt })
          if (!error.retryable || attempt === maxRetries) throw error
          lastError = error
          await abortableDelay(Math.max(retryAfterMs, Math.min(retryMaxMs, retryBaseMs * 2 ** attempt)), signal)
          continue
        }
        let payload
        try {
          const text = await response.text()
          payload = JSON.parse(text)
        } catch {
          fail('CLOUD_WORKER_PROTOCOL', 'The cloud worker endpoint returned invalid JSON', { status: response.status, workerId })
        }
        if (!isPlainObject(payload)) fail('CLOUD_WORKER_PROTOCOL', 'The cloud worker endpoint must return a JSON object', { status: response.status, workerId })
        return payload
      } catch (error) {
        if (timedOut) {
          lastError = new CloudWorkerError('Cloud worker request timed out', {
            code: 'CLOUD_WORKER_TIMEOUT', retryable, workerId,
          })
        } else if (isAbort(error)) {
          throw error
        } else if (error instanceof CloudWorkerError) {
          throw error
        } else {
          // Deliberately omit the raw network error: URLs and headers can carry credentials.
          lastError = new CloudWorkerError('Cloud worker network request failed', {
            code: 'CLOUD_WORKER_NETWORK', retryable, workerId,
          })
        }
        if (!retryable || attempt === maxRetries || signal?.aborted) throw lastError
        log('network_retry', { method, path, code: lastError.code, attempt, workerId })
        await abortableDelay(Math.min(retryMaxMs, retryBaseMs * 2 ** attempt), signal)
      } finally {
        clearTimeout(timer)
        removeAbort()
      }
    }
    throw lastError
  }

  function workerPath(workerId) {
    requireString(workerId, 'workerId', { max: 512 })
    return `/v1/workers/${encodeURIComponent(workerId)}`
  }

  function parseState(payload, workerId) {
    if (payload.workerId !== undefined && payload.workerId !== workerId) fail('CLOUD_WORKER_PROTOCOL', 'The response belongs to a different worker')
    if (!STATES.has(payload.state)) fail('CLOUD_WORKER_PROTOCOL', 'The response contains an invalid worker state')
    if (payload.fencingToken !== undefined) observeFence(workerId, payload.fencingToken)
    return payload.state
  }

  const provider = {
    capabilities: Object.freeze({
      protocol: PROTOCOL,
      operations: Object.freeze(['submit', 'snapshot', 'events', 'reattach', 'cancel', 'finalizeArtifacts']),
      eventDelivery: 'cursor',
      eventCursor: 'non-negative-integer-sequence',
      artifactDigest: 'sha256',
      artifactTransfer: 'inline-base64',
      cancellation: 'asynchronous',
      authentication: Object.freeze(['short-lived-bearer-token', 'provider-secret-reference']),
      fencing: 'monotonic-worker-token',
    }),

    async submit(workSpec, options = {}) {
      ensureOpen()
      const spec = createWorkSpec(workSpec)
      const idempotencyKey = requireString(
        options.idempotencyKey ?? `dsh:${spec.run.id}:${spec.subtask.id}:${spec.attempt}`,
        'idempotencyKey',
        { max: 512 },
      )
      const payload = await requestJson({
        method: 'POST', path: '/v1/workers', body: { workSpec: spec },
        headers: { 'Idempotency-Key': idempotencyKey }, signal: options.signal,
      })
      const workerId = requireString(payload.workerId, 'workerId', { max: 512 })
      const leaseId = requireString(payload.leaseId, 'leaseId', { max: 512 })
      const fencingToken = validateFence(payload.fencingToken)
      observeFence(workerId, fencingToken)
      const state = parseState(payload, workerId)
      const leaseExpiresAt = payload.leaseExpiresAt ?? payload.lease?.expiresAt
      if (leaseExpiresAt !== undefined && !Number.isFinite(Date.parse(leaseExpiresAt))) {
        fail('CLOUD_WORKER_PROTOCOL', 'leaseExpiresAt must be an ISO-8601 timestamp')
      }
      log('submitted', { workerId, attempt: spec.attempt })
      return {
        workerId,
        state,
        lease: { id: leaseId, fencingToken, expiresAt: leaseExpiresAt },
        leaseId,
        fencingToken,
        leaseExpiresAt,
        snapshot: payload.snapshot,
      }
    },

    async snapshot(workerId, options = {}) {
      ensureOpen()
      const path = workerPath(workerId)
      const payload = await requestJson({
        method: 'GET', path, headers: leaseHeaders({ workerId, ...options }), signal: options.signal, workerId,
      })
      const state = parseState(payload, workerId)
      return { ...payload, workerId, state }
    },

    /** Returns an abortable async event stream. Reconnects use the last committed cursor. */
    events(workerId, options = {}) {
      ensureOpen()
      const path = workerPath(workerId)
      const headers = leaseHeaders({ workerId, ...options })
      const initialCursor = options.cursor ?? 0
      if (!Number.isSafeInteger(initialCursor) || initialCursor < 0) fail('CLOUD_WORKER_INVALID_CURSOR', 'Event cursor must be a non-negative integer')
      const maxReconnects = options.maxReconnects ?? eventMaxReconnects
      if (!Number.isInteger(maxReconnects) || maxReconnects < 0) fail('CLOUD_WORKER_CONFIG', 'maxReconnects must be a non-negative integer')
      const providerSelf = provider
      return {
        [Symbol.asyncIterator]() {
          return (async function* streamEvents() {
            const controller = new AbortController()
            subscriptions.add(controller)
            let detachCaller = () => {}
            if (options.signal) {
              const onAbort = () => controller.abort(options.signal.reason)
              if (options.signal.aborted) controller.abort(options.signal.reason)
              else {
                options.signal.addEventListener('abort', onAbort, { once: true })
                detachCaller = () => options.signal.removeEventListener('abort', onAbort)
              }
            }
            let cursor = initialCursor
            let reconnects = 0
            try {
              while (!providerSelf.closed && !controller.signal.aborted) {
                let payload
                try {
                  payload = await requestJson({
                    method: 'GET', path: `${path}/events?cursor=${cursor}`, headers,
                    signal: controller.signal, workerId,
                  })
                } catch (error) {
                  if (providerSelf.closed || controller.signal.aborted || isAbort(error)) return
                  if (!error.retryable || reconnects >= maxReconnects) throw error
                  reconnects++
                  log('events_reconnect', { workerId, cursor, code: error.code, reconnects })
                  try { await abortableDelay(Math.max(error.retryAfterMs || 0, Math.min(retryMaxMs, retryBaseMs * 2 ** (reconnects - 1))), controller.signal) } catch { return }
                  continue
                }
                reconnects = 0
                if (payload.workerId !== undefined && payload.workerId !== workerId) fail('CLOUD_WORKER_PROTOCOL', 'The event stream belongs to a different worker')
                if (payload.fencingToken !== undefined) observeFence(workerId, payload.fencingToken)
                if (!Array.isArray(payload.events)) fail('CLOUD_WORKER_PROTOCOL', 'Event pages must contain an events array')
                for (const event of payload.events) {
                  if (!isPlainObject(event) || !Number.isSafeInteger(event.sequence) || event.sequence <= cursor) {
                    fail('CLOUD_WORKER_EVENT_CURSOR', 'Events must have strictly increasing integer sequence cursors')
                  }
                  if (event.fencingToken !== undefined) observeFence(workerId, event.fencingToken)
                  cursor = event.sequence
                  yield { ...event, cursor }
                }
                if (!Number.isSafeInteger(payload.nextCursor) || payload.nextCursor < cursor || payload.nextCursor < 0) {
                  fail('CLOUD_WORKER_EVENT_CURSOR', 'nextCursor must not move backwards')
                }
                if (typeof payload.hasMore !== 'boolean') fail('CLOUD_WORKER_PROTOCOL', 'Event pages must declare hasMore')
                cursor = payload.nextCursor
                const state = payload.state
                if (state !== undefined && !STATES.has(state)) fail('CLOUD_WORKER_PROTOCOL', 'The event stream contains an invalid worker state')
                if (state && TERMINAL_STATES.has(state)) return
                if (!payload.hasMore) {
                  try { await abortableDelay(options.pollIntervalMs ?? pollIntervalMs, controller.signal) } catch { return }
                }
              }
            } finally {
              detachCaller()
              subscriptions.delete(controller)
            }
          })()
        },
      }
    },

    /** Renew an expired lease and resume events from the supplied committed cursor. */
    async reattach(workerId, options = {}) {
      ensureOpen()
      const cursor = options.cursor === undefined ? 0 : options.cursor
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail('CLOUD_WORKER_INVALID_CURSOR', 'Reattach cursor must be a non-negative integer')
      const path = workerPath(workerId)
      const headers = leaseHeaders({ workerId, ...options })
      const payload = await requestJson({
        method: 'POST', path: `${path}/reattach`, body: { cursor },
        headers, signal: options.signal, workerId,
      })
      if (payload.workerId !== workerId) fail('CLOUD_WORKER_PROTOCOL', 'The response belongs to a different worker')
      const state = parseState(payload, workerId)
      if (typeof payload.leaseId !== 'string' || !payload.leaseId || payload.leaseId.length > 512 || /[\0\r\n]/.test(payload.leaseId)) {
        fail('CLOUD_WORKER_PROTOCOL', 'The response contains an invalid leaseId')
      }
      const leaseId = payload.leaseId
      const fencingToken = validateFence(payload.fencingToken)
      observeFence(workerId, fencingToken)
      const leaseExpiresAt = payload.leaseExpiresAt ?? payload.lease?.expiresAt
      if (typeof leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(leaseExpiresAt))) {
        fail('CLOUD_WORKER_PROTOCOL', 'leaseExpiresAt must be an ISO-8601 timestamp')
      }
      if (!Number.isSafeInteger(payload.nextCursor) || payload.nextCursor < cursor) {
        fail('CLOUD_WORKER_EVENT_CURSOR', 'nextCursor must not move backwards')
      }
      return {
        workerId,
        state,
        lease: { id: leaseId, fencingToken, expiresAt: leaseExpiresAt },
        leaseId,
        fencingToken,
        leaseExpiresAt,
        nextCursor: payload.nextCursor,
      }
    },

    async cancel(workerId, options = {}) {
      ensureOpen()
      const headers = leaseHeaders({ workerId, ...options })
      const expectedFencingToken = options.expectedFencingToken ?? options.fencingToken ?? options.lease?.fencingToken
      assertCurrentFence(workerId, expectedFencingToken)
      const payload = await requestJson({
        method: 'POST', path: `${workerPath(workerId)}/cancel`,
        body: { expectedFencingToken },
        headers: { ...headers, 'Idempotency-Key': options.idempotencyKey ?? randomUUID() },
        signal: options.signal, workerId,
      })
      parseState(payload, workerId)
      // Cancellation is accepted, not observed completion. Even a server race
      // that already stopped the worker does not let this call claim it did so.
      return { workerId, status: 'cancelling', state: 'cancelling', requestedAt: payload.requestedAt ?? new Date(now()).toISOString() }
    },

    async finalizeArtifacts(workerId, options = {}) {
      ensureOpen()
      const headers = leaseHeaders({ workerId, ...options })
      const expectedFencingToken = options.expectedFencingToken ?? options.fencingToken ?? options.lease?.fencingToken
      assertCurrentFence(workerId, expectedFencingToken)
      const payload = await requestJson({
        method: 'POST', path: `${workerPath(workerId)}/artifacts/finalize`,
        body: { expectedFencingToken },
        headers: { ...headers, 'Idempotency-Key': options.idempotencyKey ?? randomUUID() },
        signal: options.signal, workerId,
      })
      if (payload.workerId !== undefined && payload.workerId !== workerId) fail('CLOUD_WORKER_PROTOCOL', 'Artifacts belong to a different worker')
      if (payload.state !== undefined) parseState(payload, workerId)
      if (payload.fencingToken !== undefined) observeFence(workerId, payload.fencingToken)
      const manifest = verifyArtifactManifest(payload.manifest ?? payload.artifacts)
      return {
        workerId,
        artifactId: payload.artifactId,
        finalizedAt: payload.finalizedAt,
        manifest,
      }
    },

    /** Shutdown disconnects local subscriptions only. It never sends cancel. */
    close() {
      if (closed) return
      closed = true
      for (const controller of subscriptions) controller.abort(new DOMException('Cloud worker subscriptions closed', 'AbortError'))
      subscriptions.clear()
    },

    async [Symbol.asyncDispose]() {
      this.close()
    },
  }
  return Object.freeze(provider)
}
