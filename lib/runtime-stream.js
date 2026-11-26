/**
 * Bounded, JSON-safe runtime event stream with cursor-based replay.
 *
 * This module only observes frames supplied by its caller. It performs no I/O,
 * starts no runtime services, and is deliberately independent of the view,
 * control, console, and host integrations.
 *
 * @module dsh-superagent/runtime-stream
 */
import { Buffer } from 'node:buffer'

const DEFAULT_LIMIT = 100
const DEFAULT_MAX_FRAME_BYTES = 512 * 1024
const MAX_LIMIT = 100_000
const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_DEPTH = 16
const MAX_NODES = 10_000
const FRAME_TYPES = new Set(['screenshot', 'current-action', 'state'])
const MEDIA_FIELDS = new Set(['path', 'data', 'dataUrl', 'base64', 'image', 'src', 'url'])
const SKIP = Symbol('skip')
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/
const CONTROL_CHAR_REPLACE = /[\u0000-\u001f\u007f-\u009f]/g
const WEB_URL = /^(?:https?:)?\/\//i
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
const DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif|bmp|avif|x-icon);base64,([A-Za-z0-9+/]+={0,2})$/i
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*password|.*passwd|.*secret|.*credential|.*token|api[_-]?key|access[_-]?key|private[_-]?key|signature|session[_-]?id)$/i
const SECRET_ASSIGNMENT = /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|refresh[_-]?token|authorization|cookie|credential|signature)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const SENSITIVE_QUERY = /([?&](?:token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|signature)=)[^&#\s]*/gi

function streamError(code, message) {
  const error = new Error(message)
  error.name = 'RuntimeStreamError'
  error.code = code
  return error
}

function integerOption(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Built-in redaction always runs, even when a custom redactor is supplied. */
function redactText(text, key, redact) {
  if (DATA_URL.test(text)) return text
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'

  const safe = String(text)
    .replace(CONTROL_CHAR_REPLACE, ' ')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]')
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, '[phone redacted]')
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@')

  if (typeof redact !== 'function') return safe
  const custom = redact(safe, key)
  if (typeof custom !== 'string') throw new TypeError('runtime stream redact must return a string')
  return redactText(custom, null, null)
}

function sanitize(value, redact, key = '', depth = 0, seen = new WeakSet(), budget = { nodes: 0 }) {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) throw new RangeError('runtime frame is too complex')
  if (typeof value === 'string') return redactText(value, key, redact)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return SKIP
  if (typeof value === 'bigint') throw new TypeError('runtime frames cannot contain bigint values')
  if (value instanceof Date) return redactText(value.toISOString(), key, redact)
  if (!Array.isArray(value) && !isPlainObject(value)) throw new TypeError('runtime frames must contain JSON-safe values')
  if (seen.has(value)) throw new TypeError('runtime frames cannot contain cycles')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map(item => {
        const cleaned = sanitize(item, redact, key, depth + 1, seen, budget)
        return cleaned === SKIP ? null : cleaned
      })
    }
    const result = {}
    for (const [childKey, child] of Object.entries(value)) {
      const cleaned = sanitize(child, redact, childKey, depth + 1, seen, budget)
      if (cleaned !== SKIP) Object.defineProperty(result, childKey, {
        value: cleaned, enumerable: true, configurable: true, writable: true,
      })
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function validatePath(value) {
  if (!value || value.length > 4096 || CONTROL_CHARS.test(value)) throw new TypeError('invalid screenshot path')
  if (WEB_URL.test(value) || value.startsWith('//') || value.startsWith('\\\\')) {
    throw new TypeError('screenshot URLs are not allowed')
  }
  if (URI_SCHEME.test(value) && !WINDOWS_DRIVE.test(value)) {
    throw new TypeError('screenshot must be a path or an image data URL')
  }
}

function validateDataUrl(value, maxFrameBytes) {
  const match = DATA_URL.exec(value)
  if (!match) throw new TypeError('screenshot data must be a base64 image data URL')
  const payload = match[1]
  if (payload.length % 4 !== 0 || Buffer.byteLength(payload) > maxFrameBytes) {
    throw new TypeError('screenshot base64 payload is invalid or too large')
  }
  if (Buffer.from(payload, 'base64').byteLength > maxFrameBytes) {
    throw new TypeError('screenshot image is too large')
  }
}

/** Validate before redaction so control characters cannot be silently cleaned. */
function validateScreenshot(value, maxFrameBytes, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) throw new RangeError('screenshot frame is too complex')
  if (typeof value === 'string') {
    if (CONTROL_CHARS.test(value)) throw new TypeError('screenshot frames cannot contain control characters')
    if (WEB_URL.test(value)) throw new TypeError('screenshot URLs are not allowed')
    return 0
  }
  if (!value || typeof value !== 'object') return 0
  if (seen.has(value)) throw new TypeError('runtime frames cannot contain cycles')
  seen.add(value)
  try {
    let mediaCount = 0
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value)
    for (const [key, child] of entries) {
      if (CONTROL_CHARS.test(key)) throw new TypeError('screenshot frames cannot contain control characters')
      if (MEDIA_FIELDS.has(key) && child !== undefined && child !== null && child !== '') {
        mediaCount += 1
        if (typeof child !== 'string') throw new TypeError('screenshot media must be a string')
        if (key === 'path') validatePath(child)
        else validateDataUrl(child, maxFrameBytes)
      } else {
        mediaCount += validateScreenshot(child, maxFrameBytes, depth + 1, seen)
      }
    }
    if (mediaCount > 1) throw new TypeError('screenshot frame must contain exactly one path or data URL')
    return mediaCount
  } finally {
    seen.delete(value)
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Create an isolated runtime event stream.
 *
 * @param {object} [options]
 * @param {number} [options.limit=100] Maximum retained frames (1–100000).
 * @param {number} [options.maxFrameBytes=524288] Maximum serialized UTF-8 frame bytes.
 * @param {boolean|((text: string, key: string|null) => string)} [options.redact=true]
 *   Optional extra text redactor; built-in credential redaction cannot be disabled.
 * @returns {{
 *   publish(frame: object): {accepted: boolean, cursor: number, dropped: number},
 *   subscribe(listener: Function): Function,
 *   read(options?: {cursor?: number, limit?: number}): {events: object[], nextCursor: number, reset: boolean},
 *   snapshot(): object,
 *   dispose(): void,
 * }} stream
 */
export function createRuntimeStream({
  limit = DEFAULT_LIMIT,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  redact = true,
} = {}) {
  const capacity = integerOption(limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')
  const frameLimit = integerOption(maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 1, MAX_FRAME_BYTES, 'maxFrameBytes')
  if (redact !== true && typeof redact !== 'function') {
    throw new TypeError('redact must be true or a function')
  }
  const customRedact = typeof redact === 'function' ? redact : null
  let ring = new Array(capacity)
  let head = 0
  let size = 0
  let lastCursor = 0
  let dropped = 0
  let disposed = false
  const subscribers = new Set()
  const notifications = []
  const latest = { screenshot: null, currentAction: null, state: null }
  let flushing = false

  function bufferedEvents() {
    const events = []
    for (let index = 0; index < size; index += 1) events.push(clone(ring[(head + index) % capacity]))
    return events
  }

  function snapshot() {
    return {
      events: bufferedEvents(),
      nextCursor: lastCursor,
      current: clone(latest),
      dropped,
      disposed,
    }
  }

  function emit(event) {
    notifications.push({ event, subscribers: [...subscribers] })
    if (flushing) return
    flushing = true
    try {
      // Queue reentrant publishes so every subscriber observes the same order.
      while (notifications.length > 0) {
        const notification = notifications.shift()
        for (const subscription of notification.subscribers) {
          if (!subscribers.has(subscription)) continue
          try {
            subscription.listener(clone(notification.event))
          } catch {
            // A consumer cannot interrupt the producer or other consumers.
          }
        }
      }
    } finally {
      notifications.length = 0
      flushing = false
    }
  }

  function publish(frame) {
    if (disposed || !isPlainObject(frame) || !FRAME_TYPES.has(frame.type)) {
      return { accepted: false, cursor: lastCursor, dropped: 0 }
    }
    if (lastCursor === Number.MAX_SAFE_INTEGER) return { accepted: false, cursor: lastCursor, dropped: 0 }

    let event
    try {
      if (frame.type === 'screenshot' && validateScreenshot(frame, frameLimit) !== 1) {
        throw new TypeError('screenshot frame must contain exactly one path or data URL')
      }
      const safe = sanitize(frame, customRedact)
      if (safe.type === 'screenshot' && validateScreenshot(safe, frameLimit) !== 1) {
        throw new TypeError('screenshot frame must contain exactly one path or data URL')
      }
      event = { ...safe, cursor: lastCursor + 1 }
      if (Buffer.byteLength(JSON.stringify(event), 'utf8') > frameLimit) return { accepted: false, cursor: lastCursor, dropped: 0 }
    } catch {
      return { accepted: false, cursor: lastCursor, dropped: 0 }
    }

    let evicted = 0
    if (size === capacity) {
      ring[head] = undefined
      head = (head + 1) % capacity
      size -= 1
      dropped += 1
      evicted = 1
    }
    ring[(head + size) % capacity] = event
    size += 1
    lastCursor = event.cursor
    if (event.type === 'screenshot') latest.screenshot = event
    else if (event.type === 'current-action') latest.currentAction = event
    else latest.state = event

    // Periodically compact the physical array without changing chronological order.
    if (head > 1024 && head * 2 >= capacity) {
      ring = [...bufferedEvents(), ...new Array(capacity - size)]
      head = 0
    }
    emit(event)
    return { accepted: true, cursor: event.cursor, dropped: evicted }
  }

  function subscribe(listener) {
    if (disposed) throw streamError('DISPOSED', 'runtime stream is disposed')
    if (typeof listener !== 'function') throw new TypeError('runtime stream subscriber must be a function')
    const subscription = { listener }
    subscribers.add(subscription)
    const unsubscribe = () => { subscribers.delete(subscription) }
    unsubscribe.unsubscribe = unsubscribe
    return unsubscribe
  }

  function read({ cursor = 0, limit: readLimit = capacity } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError('cursor must be a non-negative safe integer')
    const count = integerOption(readLimit, capacity, 0, MAX_LIMIT, 'read limit')
    const oldestCursor = size > 0 ? ring[head].cursor : lastCursor + 1
    if (disposed || cursor > lastCursor || cursor < oldestCursor - 1) {
      return { events: bufferedEvents(), nextCursor: lastCursor, reset: true }
    }
    const events = []
    for (let index = 0; index < size && events.length < count; index += 1) {
      const event = ring[(head + index) % capacity]
      if (event.cursor > cursor) events.push(clone(event))
    }
    return { events, nextCursor: events.length > 0 ? events.at(-1).cursor : cursor, reset: false }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    subscribers.clear()
    notifications.length = 0
    ring = new Array(capacity)
    head = 0
    size = 0
    latest.screenshot = null
    latest.currentAction = null
    latest.state = null
  }

  return { publish, subscribe, read, snapshot, dispose }
}
