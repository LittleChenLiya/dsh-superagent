/**
 * Durable Feishu reply outbox.
 *
 * A record is persisted before dispatch and carries one stable uuid through
 * timeouts, leases and restarts. Files are replaced atomically under the shared
 * advisory lock. Provider bodies, credentials, paths and exception stacks are
 * never persisted or logged; only normalized error codes are retained.
 *
 * @module dsh-superagent/feishu-outbox
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { acquireFileLock } from '../lock.js'
import { validateFeishuSummary } from './feishu-client.js'

export { validateFeishuSummary } from './feishu-client.js'

const VERSION = 1
const STATUSES = new Set(['pending', 'sending', 'sent', 'dead'])
const MAX_RECORDS = 10_000
const DEFAULT_FILE = 'feishu-outbox.json'
// Serialize instances in this process before taking the cross-process lock.
const localQueues = new Map()

export class FeishuOutboxStateError extends Error {
  constructor(code, message, { file, cause } = {}) {
    super(message)
    this.name = 'FeishuOutboxStateError'
    this.code = code
    this.file = file
    if (cause) this.cause = cause
  }
}

function iso(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('outbox timestamps must be valid')
  return date.toISOString()
}

function timeValue(value) {
  const time = typeof value === 'number' ? value : Date.parse(value ?? '')
  return Number.isFinite(time) ? time : 0
}

function boundedText(value, limit, name) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > limit) {
    throw new TypeError(`${name} must be a non-empty string of at most ${limit} characters`)
  }
  return value.trim()
}

function safeId(value, limit, name) {
  const text = boundedText(value, limit, name)
  if (!/^[A-Za-z0-9:._/-]+$/.test(text)) throw new TypeError(`${name} contains unsupported characters`)
  return text
}

/** Stable request id for a logical notification, independent of retry count. */
export function feishuIdempotencyKey(input = {}) {
  const identity = JSON.stringify({
    source: input.source ?? 'feishu',
    instanceId: input.instanceId ?? '',
    objectId: input.objectId ?? '',
    messageId: input.messageId ?? input.rootId ?? '',
    kind: input.kind ?? 'summary',
  })
  return `feishu-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`
}

function emptyState() {
  return { version: VERSION, records: {}, updatedAt: null }
}

function recordShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.key !== 'string' || !value.key || typeof value.idempotencyKey !== 'string') return false
  if (!STATUSES.has(value.status)) return false
  if (typeof value.text !== 'string' || typeof value.messageId !== 'string') return false
  if (typeof value.source !== 'string' || typeof value.instanceId !== 'string' || typeof value.objectId !== 'string') return false
  if (!Number.isInteger(value.attempts) || value.attempts < 0) return false
  return true
}

function loadState(raw, file) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new FeishuOutboxStateError('outbox-state-invalid', `Feishu outbox is not valid JSON; original preserved: ${file}`, { file, cause })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.version !== VERSION || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)
    || Object.values(parsed.records).some(record => !recordShape(record))) {
    throw new FeishuOutboxStateError('outbox-state-unsupported', `Feishu outbox shape is unsupported; original preserved: ${file}`, { file })
  }
  // Idempotency is a uniqueness invariant, not merely a convention.
  const keys = new Set()
  for (const [key, record] of Object.entries(parsed.records)) {
    if (record.key !== key || keys.has(record.idempotencyKey)) {
      throw new FeishuOutboxStateError('outbox-state-invalid', `Feishu outbox identity is inconsistent; original preserved: ${file}`, { file })
    }
    keys.add(record.idempotencyKey)
  }
  return parsed
}

async function renameWithRetry(from, to, sleep) {
  let lastError = null
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      if (attempt >= 20) break
      await sleep(20 * attempt + (attempt % 5) * 5)
    }
  }
  const backup = `${to}.${process.pid}.${randomUUID()}.bak`
  try {
    await fsp.rename(to, backup)
  } catch {
    throw lastError
  }
  try {
    await fsp.rename(from, to)
  } catch (error) {
    await fsp.rename(backup, to).catch(() => {})
    throw error
  }
  await fsp.unlink(backup).catch(() => {})
}

function retryDelay(attempt, policy) {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1))
}

function publicRecord(record) {
  if (!record) return null
  const { leaseToken, leaseExpiresAt, ...safe } = record
  return { ...safe }
}

/**
 * @param {object} options
 * @param {string} [options.stateFile] durable JSON file
 * @param {{replyToMessage: Function}} options.client sending client
 * @param {{findBinding: Function}} [options.bindingStore] source store used to reject revoked bindings
 * @param {() => number} [options.now] injectable clock
 * @param {number} [options.leaseMs] sending lease duration
 * @param {number} [options.maxAttempts] total attempts, including the first
 * @param {number} [options.baseDelayMs] first retry delay
 * @param {number} [options.maxDelayMs] retry delay cap
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable retry/file-lock sleep
 * @param {(event: object) => void} [options.log] metadata only
 */
export function createFeishuOutbox({
  stateFile = DEFAULT_FILE,
  client,
  bindingStore = null,
  now = () => Date.now(),
  leaseMs = 30_000,
  maxAttempts = 6,
  baseDelayMs = 1_000,
  maxDelayMs = 60_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  if (typeof stateFile !== 'string' || !stateFile.trim()) throw new TypeError('stateFile is required')
  if (!client || typeof client.replyToMessage !== 'function') throw new TypeError('client.replyToMessage is required')
  for (const [name, value, allowZero] of [
    ['leaseMs', leaseMs, false], ['maxAttempts', maxAttempts, false],
    ['baseDelayMs', baseDelayMs, true], ['maxDelayMs', maxDelayMs, true],
  ]) {
    if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) throw new TypeError(`${name} is invalid`)
  }
  if (!Number.isInteger(maxAttempts)) throw new TypeError('maxAttempts must be an integer')
  const file = path.resolve(stateFile)
  const policy = { leaseMs, maxAttempts, baseDelayMs, maxDelayMs }
  const inFlight = new Map()

  async function readUnlocked() {
    let raw
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState()
      throw new FeishuOutboxStateError('outbox-state-unreadable', `Cannot read Feishu outbox: ${file}`, { file, cause: error })
    }
    return loadState(raw, file)
  }

  async function read() {
    return readUnlocked()
  }

  function mutate(update) {
    const previous = localQueues.get(file) ?? Promise.resolve()
    const write = previous.then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const release = await acquireFileLock(`${file}.lock`, {
        now, retries: 200, retryDelayMs: 5,
        // Persistence must also work when a test supplies a manual retry clock.
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      })
      if (!release) throw new FeishuOutboxStateError('outbox-locked', 'Feishu outbox is temporarily locked', { file })
      let tmp
      try {
        const state = await readUnlocked()
        const result = update(state)
        if (!result?.changed) return result?.state ?? state
        state.updatedAt = iso(now())
        tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
        await fsp.writeFile(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
        await renameWithRetry(tmp, file, sleep)
        return result.state
      } finally {
        if (tmp) await fsp.unlink(tmp).catch(() => {})
        await release()
      }
    })
    const tail = write.catch(() => {})
    localQueues.set(file, tail)
    tail.then(() => {
      if (localQueues.get(file) === tail) localQueues.delete(file)
    })
    return write
  }

  async function bindingAllowed(record) {
    if (!bindingStore) return true
    if (typeof bindingStore.findBinding !== 'function') throw new TypeError('bindingStore.findBinding is required')
    const binding = await bindingStore.findBinding({
      source: record.source, instanceId: record.instanceId, objectId: record.objectId,
    })
    return Boolean(binding && !binding.revokedAt && (!record.bindingId || binding.id === record.bindingId))
  }

  /** Persist before returning. Duplicate idempotency keys never create a second row. */
  async function enqueue(input = {}) {
    const checked = validateFeishuSummary(input.summary ?? input.text ?? input.template)
    if (!checked.ok) {
      const error = new TypeError(`Feishu summary rejected: ${checked.code}`)
      error.code = checked.code
      throw error
    }
    const source = input.source ?? 'feishu'
    if (source !== 'feishu') throw new TypeError('Feishu outbox only accepts feishu bindings')
    const instanceId = safeId(input.instanceId, 160, 'instanceId')
    const objectId = safeId(input.objectId, 240, 'objectId')
    const target = input.messageId ?? input.rootId
    if (typeof target !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(target)) {
      throw new TypeError('messageId must be a Feishu message id')
    }
    const bindingId = input.bindingId == null || input.bindingId === ''
      ? null : safeId(input.bindingId, 100, 'bindingId')
    const idempotencyKey = input.idempotencyKey == null || input.idempotencyKey === ''
      ? feishuIdempotencyKey({ source, instanceId, objectId, messageId: target, kind: input.kind })
      : safeId(input.idempotencyKey, 100, 'idempotencyKey')
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
      throw new TypeError('idempotencyKey must be 8-100 letters, digits, underscores or hyphens')
    }
    const key = createHash('sha256').update(idempotencyKey).digest('hex')
    const candidate = {
      key, idempotencyKey, source, instanceId, objectId, bindingId,
      messageId: target, text: checked.text, status: 'pending', attempts: 0,
      createdAt: iso(now()), updatedAt: iso(now()), nextAttemptAt: iso(now()),
      lastError: null, platformMessageId: null,
    }
    let duplicate = false
    const state = await mutate(saved => {
      const existing = Object.values(saved.records).find(record => record.idempotencyKey === idempotencyKey)
      if (existing) {
        duplicate = true
        return { changed: false, state: saved }
      }
      if (Object.keys(saved.records).length >= MAX_RECORDS) {
        const terminal = Object.entries(saved.records)
          .filter(([, record]) => record.status === 'sent' || record.status === 'dead')
          .sort((left, right) => timeValue(left[1].updatedAt) - timeValue(right[1].updatedAt))[0]
        if (!terminal) throw new FeishuOutboxStateError('outbox-full', 'Feishu outbox has no free record slots', { file })
        delete saved.records[terminal[0]]
      }
      saved.records[key] = candidate
      return { changed: true, state: saved }
    })
    const record = state.records[key]
    return { ...publicRecord(record), created: !duplicate }
  }

  /** Atomically take one due record. Sending leases survive process death. */
  async function claim(owner = randomUUID(), onlyKey = null) {
    let claimedKey = null
    const state = await mutate(saved => {
      const at = now()
      const candidates = Object.values(saved.records)
        .filter(record => (!onlyKey || record.key === onlyKey) && (record.status === 'pending' || (record.status === 'sending'
          && timeValue(record.leaseExpiresAt) <= at)))
        .sort((left, right) => timeValue(left.createdAt) - timeValue(right.createdAt))
      let changed = false
      for (const record of candidates) {
        if (record.status === 'pending' && timeValue(record.nextAttemptAt) > at) continue
        if (record.attempts >= policy.maxAttempts) {
          Object.assign(record, {
            status: 'dead', updatedAt: iso(at), leaseToken: null, leaseExpiresAt: null,
            lastError: 'retries-exhausted',
          })
          changed = true
          continue
        }
        Object.assign(record, {
          status: 'sending', attempts: record.attempts + 1, updatedAt: iso(at),
          leaseToken: `${process.pid}:${owner}`, leaseExpiresAt: iso(at + policy.leaseMs),
          lastError: null,
        })
        claimedKey = record.key
        return { changed: true, state: saved, key: claimedKey }
      }
      return { changed, state: saved, key: null }
    })
    return claimedKey ? savedCopy(state.records[claimedKey]) : null
  }

  function savedCopy(record) {
    return { ...record }
  }

  async function finish(key, leaseToken, patch) {
    let applied = false
    const state = await mutate(saved => {
      const record = saved.records[key]
      // A worker whose lease expired must not overwrite its successor's state.
      if (!record || record.status !== 'sending' || record.leaseToken !== leaseToken) {
        return { changed: false, state: saved }
      }
      applied = true
      delete record.leaseToken
      delete record.leaseExpiresAt
      Object.assign(record, patch, { updatedAt: iso(now()) })
      return { changed: true, state: saved }
    })
    return { ...state, applied }
  }

  async function retryOrDie(record, code, retryAfterMs = 0) {
    const at = now()
    const exhausted = record.attempts >= policy.maxAttempts
    const delay = Math.max(retryDelay(record.attempts, policy), retryAfterMs)
    const lastError = exhausted ? 'retries-exhausted' : code
    const { applied } = await finish(record.key, record.leaseToken, exhausted ? {
      status: 'dead', lastError, platformMessageId: null,
    } : {
      status: 'pending', lastError: code, nextAttemptAt: iso(at + delay),
    })
    return !applied ? 'superseded' : exhausted ? 'dead' : 'pending'
  }

  async function deliver(record) {
    if (!(await bindingAllowed(record))) {
      const { applied } = await finish(record.key, record.leaseToken, {
        status: 'dead', lastError: 'binding-revoked', platformMessageId: null,
      })
      if (!applied) return { key: record.key, status: 'superseded', code: 'binding-revoked' }
      log({ event: 'feishu-outbox-dead', key: record.key, code: 'binding-revoked' })
      return { key: record.key, status: 'dead', code: 'binding-revoked' }
    }
    try {
      const result = await client.replyToMessage({
        messageId: record.messageId, text: record.text, uuid: record.idempotencyKey,
      })
      const platformMessageId = typeof result?.messageId === 'string' ? result.messageId : null
      if (!platformMessageId || platformMessageId.length > 200) {
        const status = await retryOrDie(record, 'invalid-response')
        return { key: record.key, status, code: 'invalid-response' }
      }
      const { applied } = await finish(record.key, record.leaseToken, {
        status: 'sent', lastError: null, platformMessageId, nextAttemptAt: null, sentAt: iso(now()),
      })
      const status = applied ? 'sent' : 'superseded'
      log({ event: 'feishu-outbox-sent', key: record.key })
      return { key: record.key, status, platformMessageId }
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,40}$/.test(error.code)
        ? error.code : 'delivery-failed'
      const retryable = error?.retryable === true
        || ['timeout', 'network', 'rate-limited', 'server', 'token-rejected'].includes(code)
      if (!retryable) {
        const { applied } = await finish(record.key, record.leaseToken, {
          status: 'dead', lastError: code, platformMessageId: null,
        })
        if (!applied) return { key: record.key, status: 'superseded', code }
        log({ event: 'feishu-outbox-dead', key: record.key, code })
        return { key: record.key, status: 'dead', code }
      }
      const status = await retryOrDie(record, code,
        Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0)
      log({ event: 'feishu-outbox-retry', key: record.key, code })
      return { key: record.key, status, code }
    }
  }

  function dispatch(key) {
    if (inFlight.has(key)) return inFlight.get(key)
    const run = (async () => {
      const record = await claim(randomUUID(), key)
      if (!record || record.key !== key) return { key, status: 'not-due' }
      return deliver(record)
    })().finally(() => inFlight.delete(key))
    inFlight.set(key, run)
    return run
  }

  /** Send due records once. Backoff deadlines are respected by the durable scan. */
  async function flush({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer')
    const state = await read()
    const at = now()
    const due = Object.values(state.records)
      .filter(record => (record.status === 'pending' && timeValue(record.nextAttemptAt) <= at)
        || (record.status === 'sending' && timeValue(record.leaseExpiresAt) <= at))
      .sort((left, right) => timeValue(left.createdAt) - timeValue(right.createdAt))
      .slice(0, limit)
    const results = []
    for (const record of due) results.push(await dispatch(record.key))
    return results
  }

  /** Startup/crash recovery scans durable deadlines and expired sending leases. */
  async function recover({ limit = 100, force = false } = {}) {
    if (force) {
      await mutate(state => {
        let changed = false
        for (const record of Object.values(state.records)) {
          if (record.status !== 'pending') continue
          record.nextAttemptAt = iso(now())
          record.updatedAt = record.nextAttemptAt
          changed = true
        }
        return { state, changed }
      })
    }
    return flush({ limit })
  }

  async function get(key) {
    return publicRecord((await read()).records[key] ?? null)
  }

  async function list({ status = null, limit = 100 } = {}) {
    if (status != null && !STATUSES.has(status)) throw new TypeError('unknown outbox status')
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer')
    const records = Object.values((await read()).records)
      .filter(record => status == null || record.status === status)
      .sort((left, right) => timeValue(right.createdAt) - timeValue(left.createdAt))
      .slice(0, limit)
    return records.map(publicRecord)
  }

  async function snapshot() {
    const records = Object.values((await read()).records)
    const counts = { pending: 0, sending: 0, sent: 0, dead: 0 }
    for (const record of records) counts[record.status] += 1
    return { file, counts, total: records.length }
  }

  return { stateFile: file, enqueue, flush, recover, get, list, snapshot, flushInFlight: () => Promise.allSettled([...inFlight.values()]) }
}
