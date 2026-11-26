/**
 * Normalize Feishu/Lark event subscriptions into the same small record shape
 * used by the GitHub source.
 *
 * Two things happen before an event becomes data:
 *
 * 1. The raw HTTP body is authenticated with the official request signature:
 *    `sha256(timestamp + nonce + encryptKey + rawBody)`. The timestamp window
 *    also rules out a replay of an older signed body.
 * 2. An encrypted body (`{"encrypt":"..."}`) is decrypted with AES-256-CBC,
 *    where the key is `sha256(encryptKey)` and the first 16 bytes of the
 *    ciphertext are the IV.
 *
 * The normalizer itself reads no clock, files, environment or network. Message
 * text is attacker-controlled and is returned as bounded data; it is never
 * interpreted as an instruction.
 *
 * @module dsh-superagent/feishu-events
 */

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

export const FEISHU_TEXT_LIMIT = 2000
const SUPPORTED = new Set(['im.message.receive_v1'])

function truncate(value, limit) {
  if (typeof value !== 'string') return null
  const points = Array.from(value)
  return points.length > limit ? points.slice(0, limit).join('') : value
}

function text(value, limit = 200) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? truncate(trimmed, limit) : null
}

function isoTime(value) {
  if (typeof value === 'string' && value.trim()) {
    const time = new Date(value)
    return Number.isNaN(time.getTime()) ? null : time.toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const time = new Date(value)
    return Number.isNaN(time.getTime()) ? null : time.toISOString()
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  return null
}

function safeEqual(left, right) {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Verify one signed Feishu request.
 *
 * @param {object} input
 * @param {string} input.timestamp value of `X-Lark-Request-Timestamp`.
 * @param {string} input.nonce value of `X-Lark-Request-Nonce`.
 * @param {string} input.signature value of `X-Lark-Signature` (hex sha256).
 * @param {string|Buffer} input.body the exact raw request body.
 * @param {string} input.encryptKey the app's encrypt key.
 * @param {number} [input.now] current epoch milliseconds; injectable for tests.
 * @param {number} [input.maxSkewSeconds] accepted clock skew, default 300.
 * @returns {boolean}
 */
export function verifyFeishuSignature({
  timestamp, nonce, signature, body, encryptKey, now = Date.now(), maxSkewSeconds = 300,
}) {
  if (!encryptKey || !timestamp || !nonce || !signature) return false
  if (!/^\d{1,12}$/u.test(String(timestamp))) return false
  if (!/^[0-9a-f]{64}$/iu.test(String(signature))) return false
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > maxSkewSeconds) return false
  const expected = createHash('sha256')
    .update(`${timestamp}${nonce}${encryptKey}`)
    .update(Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8'))
    .digest('hex')
  return safeEqual(expected.toLowerCase(), String(signature).toLowerCase())
}

function parseJson(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(String(value ?? ''))
  } catch {
    return null
  }
}

/**
 * Decrypt an encrypted Feishu event body. Returns the parsed payload, or null
 * when the body is malformed or cannot be authenticated by decryption.
 */
export function decryptFeishuPayload(body, encryptKey) {
  if (!encryptKey) return null
  const parsed = parseJson(body)
  if (!parsed || typeof parsed.encrypt !== 'string' || !parsed.encrypt) return null
  try {
    const raw = Buffer.from(parsed.encrypt, 'base64')
    if (raw.length <= 16) return null
    const key = createHash('sha256').update(encryptKey).digest()
    const decipher = createDecipheriv('aes-256-cbc', key, raw.subarray(0, 16))
    const clear = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()])
    return parseJson(clear.toString('utf8'))
  } catch {
    return null
  }
}

/** A URL verification handshake, or null for every other payload. */
export function feishuHandshake(payload) {
  if (!payload || typeof payload !== 'object' || payload.type !== 'url_verification') return null
  const challenge = text(payload.challenge, 512)
  if (!challenge) return null
  return { challenge, token: text(payload.token, 200) }
}

function messageText(message) {
  if (!message || typeof message !== 'object') return null
  if (message.message_type !== 'text') return null
  const content = parseJson(message.content)
  return text(content?.text, FEISHU_TEXT_LIMIT)
}

/**
 * Turn one decoded Feishu event into a work-event record.
 *
 * @param {object} input
 * @param {object} input.payload decoded subscription payload (schema 2.0).
 * @param {string|number|Date} input.receivedAt when the HTTP layer accepted it.
 * @returns {null | {
 *   source: 'feishu',
 *   eventId: string,
 *   type: string,
 *   tenant: { key: string },
 *   anchor: { kind: 'message', id: string },
 *   actor: { openId: string } | null,
 *   receivedAt: string,
 *   objectId: string,
 *   subject: object,
 * }}
 */
export function normalizeFeishuEvent({ payload, receivedAt } = {}) {
  if (!payload || typeof payload !== 'object') return null
  const header = payload.header
  if (!header || typeof header !== 'object') return null
  if (!SUPPORTED.has(header.event_type)) return null
  const eventId = text(header.event_id, 160)
  const tenantKey = text(header.tenant_key, 120)
  const received = isoTime(receivedAt)
  if (!eventId || !tenantKey || !received) return null
  const event = payload.event
  const message = event?.message
  if (!message || typeof message !== 'object') return null
  const messageId = text(message.message_id, 200)
  const chatId = text(message.chat_id, 200)
  const openId = text(event.sender?.sender_id?.open_id, 120)
  const chatType = text(message.chat_type, 40)
  if (!messageId) return null
  // A reply belongs to its thread root. Feishu puts the root in `root_id`;
  // messages without one (including root messages themselves) stand alone.
  // The event key still uses `event_id`, so redelivery stays idempotent.
  const rootId = text(message.root_id, 200) ?? messageId
  return {
    source: 'feishu',
    eventId: `feishu:${eventId}`,
    type: header.event_type,
    tenant: { key: tenantKey },
    anchor: { kind: 'message', id: messageId },
    actor: openId ? { openId } : null,
    receivedAt: received,
    objectId: `feishu:${tenantKey}:message:${rootId}`,
    subject: {
      messageId,
      rootId,
      parentId: text(message.parent_id, 200),
      chatId,
      chatType,
      actor: openId,
      openId,
      messageType: text(message.message_type, 40),
      text: messageText(message),
      createTime: isoTime(message.create_time),
    },
  }
}
