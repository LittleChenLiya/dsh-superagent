/**
 * Minimal Feishu sending client. It accepts app credentials, never a caller
 * supplied access token, and keeps the token in memory only.
 *
 * Transport failures are normalized so the durable outbox can make retry
 * decisions without inspecting provider response bodies or exception stacks.
 *
 * @module dsh-superagent/feishu-client
 */

export const FEISHU_API_ORIGIN = 'https://open.feishu.cn'
export const FEISHU_SUMMARY_LIMIT = 800

const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'
const REPLY_PATH = '/open-apis/im/v1/messages'
const MAX_RESPONSE_BYTES = 64 * 1024
const RETRYABLE_PLATFORM_CODES = new Set([
  99991400, 99991401, 99991663, 99991664, 99991668, 99991672,
])

export class FeishuApiError extends Error {
  constructor(code, { message, status = 0, platformCode = null, retryable = false, retryAfterMs = 0 } = {}) {
    // Messages are selected from a fixed vocabulary, never copied from HTTP
    // bodies or caught exceptions (which may contain credentials or paths).
    super(message)
    this.name = 'FeishuApiError'
    this.code = code
    this.status = status
    this.platformCode = platformCode
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

const CREDENTIAL_PATTERN = new RegExp([
  '(?:app[_-]?secret|client[_-]?secret|tenant[_-]?access[_-]?token|access[_-]?token|authorization|bearer)',
  '(?:secret|password|passwd|credential|api[_-]?key)',
  '(?:-----BEGIN [A-Z ]*PRIVATE KEY-----)',
].join('|'), 'iu')

/**
 * Validate a deliberately small notification template. Sensitive values are
 * rejected, not silently truncated: half a secret or path is still a leak.
 *
 * @param {string|{summary?: string, text?: string, title?: string, status?: string}} input
 * @returns {{ok: true, text: string} | {ok: false, code: string}}
 */
export function validateFeishuSummary(input) {
  let text
  if (typeof input === 'string') text = input
  else if (input && typeof input === 'object' && !Array.isArray(input)) {
    const summary = input.summary ?? input.text
    if (typeof summary !== 'string') return { ok: false, code: 'summary-required' }
    const clip = (value, limit) => {
      if (value == null || value === '') return ''
      if (typeof value !== 'string' || !value.trim() || Array.from(value).length > limit) {
        return null
      }
      return value.trim()
    }
    const title = clip(input.title, 80)
    const status = clip(input.status, 40)
    if (title === null || status === null) return { ok: false, code: 'summary-template-invalid' }
    text = [title && `[${title}]`, status && `[${status}]`, summary].filter(Boolean).join(' ')
  } else return { ok: false, code: 'summary-required' }

  if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'summary-required' }
  if (Array.from(text).length > FEISHU_SUMMARY_LIMIT) return { ok: false, code: 'summary-too-long' }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return { ok: false, code: 'summary-control-characters' }
  if (CREDENTIAL_PATTERN.test(text)) return { ok: false, code: 'summary-credential' }
  // Stack frames, tracebacks and explicit stack labels must not become chat text.
  if (/^\s*at\s+\S+\s*\([^\n)]+:\d+(?::\d+)?\)\s*$/mu.test(text)
    || /^\s*at\s+(?:async\s+)?[^\s(]+\s+[^\n)]+:\d+(?::\d+)?\s*$/mu.test(text)
    || /(?:stack\s*trace|traceback|堆栈|调用栈)/iu.test(text)
    || /(?:^|\n)\s*(?:Error|TypeError|ReferenceError|SyntaxError):[^\n]*\n\s*at\s/iu.test(text)) {
    return { ok: false, code: 'summary-stack' }
  }
  // Reject absolute POSIX/Windows/UNC/file paths and userinfo-bearing URLs.
  if (/(?:^|[\s("'=])(?:\/(?:[^\s/]+\/)*[^\s]*|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|file:\/\/)/u.test(text)
    || /https?:\/\/[^\s/@]+:[^\s/@]+@/iu.test(text)) {
    return { ok: false, code: 'summary-absolute-path' }
  }
  // This channel is a notification, not a report transport.
  if (/(?:完整报告|完整输出|完整正文|原始报告|附件报告|report\s+attached|full\s+report)/iu.test(text)
    || /(?:^|\n)\s*#{1,6}\s+(?:执行|任务|完整|最终|summary|report)/iu.test(text)
    || /```|\[(?:完整)?报告\]\s*[:：]/iu.test(text)) {
    return { ok: false, code: 'summary-full-report' }
  }
  return { ok: true, text: text.trim() }
}

function credential(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new TypeError(`${name} must be a non-empty app credential reference`)
  }
  return value
}

function messageId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new TypeError('messageId must be a Feishu message id')
  }
  return value
}

function retryAfterMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0
  const raw = String(value).trim()
  if (!raw) return 0
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Date.parse(raw)
  const milliseconds = /^\d+(?:\.\d+)?$/.test(raw) ? seconds * 1000 : seconds
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, 24 * 60 * 60 * 1000)) : 0
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name)
  return value == null ? '' : String(value)
}

function timeoutError() {
  return new FeishuApiError('timeout', { message: 'Feishu request timed out', retryable: true })
}

function networkError() {
  return new FeishuApiError('network', { message: 'Feishu transport is unavailable', retryable: true })
}

async function readResponse(response) {
  if (!response || typeof response !== 'object') {
    throw new FeishuApiError('invalid-response', { message: 'Feishu returned an invalid response' })
  }
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new FeishuApiError('invalid-response', { message: 'Feishu response is too large' })
  }
  let raw
  if (typeof response.text === 'function') raw = await response.text()
  else if (typeof response.arrayBuffer === 'function') raw = Buffer.from(await response.arrayBuffer()).toString('utf8')
  else raw = ''
  if (Buffer.byteLength(String(raw), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new FeishuApiError('invalid-response', { message: 'Feishu response is too large' })
  }
  let payload = null
  try {
    payload = JSON.parse(String(raw))
  } catch {
    payload = null
  }
  return { status: Number(response.status) || 0, payload, retryAfterMs: retryAfterMs(responseHeader(response, 'retry-after')) }
}

function providerError({ status, payload, retryAfterMs, operation }) {
  const platformCode = Number.isInteger(payload?.code) ? payload.code : null
  const rateLimited = status === 429 || platformCode === 99991400
  const serverFailure = status >= 500
  const tokenFailure = platformCode != null && RETRYABLE_PLATFORM_CODES.has(platformCode)
  if (rateLimited) {
    return new FeishuApiError('rate-limited', {
      message: 'Feishu rate limit reached', status, platformCode, retryable: true, retryAfterMs,
    })
  }
  if (serverFailure) {
    return new FeishuApiError('server', {
      message: 'Feishu service is temporarily unavailable', status, platformCode, retryable: true, retryAfterMs,
    })
  }
  if (tokenFailure) {
    return new FeishuApiError('token-rejected', {
      message: 'Feishu rejected the tenant access token', status, platformCode, retryable: true,
    })
  }
  return new FeishuApiError('rejected', {
    message: `Feishu ${operation} request was rejected`, status, platformCode, retryable: false,
  })
}

/**
 * Build a stateless-configuration, in-memory-token Feishu client.
 *
 * @param {object} options
 * @param {{appId: string, appSecret: string}} options.credentials app references only
 * @param {typeof fetch} [options.fetchImpl] injectable transport (required in tests)
 * @param {() => number} [options.now] injectable epoch-millisecond clock
 * @param {number} [options.timeoutMs] per-request timeout, default 10 seconds
 * @param {number} [options.tokenSkewMs] refresh this long before expiry
 * @param {(event: object) => void} [options.log] receives metadata only, no secrets/bodies
 */
export function createFeishuClient({
  credentials,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 10_000,
  tokenSkewMs = 60_000,
  log = () => {},
} = {}) {
  // Destructure only the two supported references. Supplying token/accessToken
  // instead is an error rather than an alternate authentication mechanism.
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new TypeError('credentials must contain appId and appSecret references')
  }
  const appId = credential(credentials.appId, 'appId')
  const appSecret = credential(credentials.appSecret, 'appSecret')
  if (['tenantAccessToken', 'tenant_access_token', 'accessToken', 'token'].some(key => key in credentials)) {
    throw new TypeError('credentials must contain only appId and appSecret references')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
  if (!Number.isFinite(tokenSkewMs) || tokenSkewMs < 0) throw new TypeError('tokenSkewMs must be non-negative')

  let cached = null
  let tokenInFlight = null

  function clearTokenCache() {
    cached = null
  }

  async function request(url, { method = 'GET', body, auth = true, operation }) {
    const controller = new AbortController()
    let timer
    const abort = () => controller.abort()
    try {
      timer = setTimeout(abort, timeoutMs)
      timer.unref?.()
      const headers = { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' }
      if (auth) {
        const token = await getToken()
        headers.authorization = `Bearer ${token}`
      }
      const response = await fetchImpl(url, {
        method, headers, body: body == null ? undefined : JSON.stringify(body), signal: controller.signal,
      })
      const result = await readResponse(response)
      if (result.status < 200 || result.status >= 300) {
        throw providerError({ ...result, operation })
      }
      if (!result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload)
        || !Number.isInteger(result.payload.code)) {
        throw new FeishuApiError('invalid-response', { message: 'Feishu returned an invalid response' })
      }
      if (result.payload.code !== 0) {
        throw providerError({ ...result, operation })
      }
      return result.payload
    } catch (cause) {
      if (cause instanceof FeishuApiError) throw cause
      if (controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(cause?.name)) throw timeoutError()
      if (['ERR_ABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(cause?.code)) {
        throw timeoutError()
      }
      throw networkError()
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchToken() {
    log({ event: 'feishu-token-request' })
    const payload = await request(`${FEISHU_API_ORIGIN}${TOKEN_PATH}`, {
      method: 'POST', auth: false, operation: 'authentication',
      body: { app_id: appId, app_secret: appSecret },
    })
    const token = typeof payload?.tenant_access_token === 'string' ? payload.tenant_access_token : ''
    const expire = Number(payload?.expire)
    if (!token || token.length > 4096 || !Number.isFinite(expire) || expire <= 0) {
      throw new FeishuApiError('invalid-response', { message: 'Feishu returned an invalid token response' })
    }
    return { token, expiresAt: now() + expire * 1000 - tokenSkewMs }
  }

  async function getToken() {
    if (cached && now() < cached.expiresAt) return cached.token
    if (!tokenInFlight) {
      tokenInFlight = fetchToken().then(token => {
        cached = token
        return token
      }).finally(() => {
        tokenInFlight = null
      })
    }
    return (await tokenInFlight).token
  }

  /**
   * Reply to the exact incoming message, retaining its thread/topic context.
   * The uuid is the stable idempotency key used for every transport retry.
   */
  async function replyToMessage({ messageId: id, text, uuid }) {
    const target = messageId(id)
    const checked = validateFeishuSummary(text)
    if (!checked.ok) {
      const error = new TypeError(`Feishu summary rejected: ${checked.code}`)
      error.code = checked.code
      throw error
    }
    if (typeof uuid !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(uuid)) {
      throw new TypeError('uuid must be a stable idempotency key')
    }
    const send = () => request(`${FEISHU_API_ORIGIN}${REPLY_PATH}/${encodeURIComponent(target)}/reply`, {
      method: 'POST', operation: 'reply',
      body: { msg_type: 'text', content: JSON.stringify({ text: checked.text }), uuid },
    })
    try {
      const payload = await send()
      const sentId = payload?.data?.message_id
      if (typeof sentId !== 'string' || !sentId || sentId.length > 200) {
        throw new FeishuApiError('invalid-response', { message: 'Feishu returned no message id' })
      }
      return { messageId: sentId }
    } catch (error) {
      // A stale/rejected token gets one transparent refresh. The caller's uuid
      // remains unchanged, so this cannot become a second logical message.
      if (error.code === 'token-rejected' || (error.status === 401 && error.code === 'rejected')) {
        clearTokenCache()
        const payload = await send()
        const sentId = payload?.data?.message_id
        if (typeof sentId !== 'string' || !sentId || sentId.length > 200) {
          throw new FeishuApiError('invalid-response', { message: 'Feishu returned no message id' })
        }
        return { messageId: sentId }
      }
      throw error
    }
  }

  return { getTenantAccessToken: getToken, replyToMessage, clearTokenCache }
}
