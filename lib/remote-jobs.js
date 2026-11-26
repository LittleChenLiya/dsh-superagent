import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createWorkSpec, redactSensitiveText, redactSensitiveValue } from './cloud-worker.js'
import { acquireFileLock } from './lock.js'

const FORMAT = 'dsh.superagent.remote-jobs'
const FORMAT_VERSION = 1
const TERMINAL_STATES = Object.freeze(['succeeded', 'failed', 'stopped', 'timed_out'])
const STATES = new Set(['queued', 'running', 'cancelling', ...TERMINAL_STATES])
const SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*password|.*passwd|.*secret|.*credential|(?:auth|access|refresh|session|bearer)?token|api[_-]?key|access[_-]?key|private[_-]?key)$/i
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_SPEC_BYTES = 4 * 1024 * 1024
const MAX_ERROR_BYTES = 16 * 1024
const LOCK_RETRY_MS = 25

export class RemoteJobError extends Error {
  constructor(code, message, details = {}) {
    super(redactSensitiveText(message))
    this.name = 'RemoteJobError'
    this.code = code
    if (details.workerId !== undefined) this.workerId = redactSensitiveText(String(details.workerId))
    if (details.expectedRevision !== undefined) this.expectedRevision = details.expectedRevision
    if (details.actualRevision !== undefined) this.actualRevision = details.actualRevision
    if (details.quarantinePath !== undefined) this.quarantinePath = details.quarantinePath
    if (details.file !== undefined) this.file = details.file
  }
}

function fail(code, message, details) {
  throw new RemoteJobError(code, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireString(value, field, { max = 512, singleLine = true } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (singleLine && /[\0\r\n]/.test(value))) {
    fail('REMOTE_JOB_INVALID_INPUT', `${field} must be a bounded${singleLine ? ' single-line' : ''} string`)
  }
  return value
}

function requireTimestamp(value, field) {
  requireString(value, field, { max: 64 })
  if (!Number.isFinite(Date.parse(value))) fail('REMOTE_JOB_INVALID_INPUT', `${field} must be a valid timestamp`)
  return value
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('REMOTE_JOB_INVALID_INPUT', `${field} must be a positive safe integer`)
  return value
}

function requireNonnegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail('REMOTE_JOB_INVALID_INPUT', `${field} must be a non-negative safe integer`)
  return value
}

function requireRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail('REMOTE_JOB_INVALID_INPUT', `${field} must be a non-negative safe integer`)
  return value
}

function requireFence(value) {
  if ((Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value))) return value
  fail('REMOTE_JOB_INVALID_INPUT', 'fencingToken must be a non-negative integer or a bounded opaque token')
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

function sanitizeError(value) {
  if (value === undefined || value === null) return null
  const redacted = redactSensitiveValue(value)
  let body
  try {
    body = JSON.stringify(redacted, null, 2)
  } catch {
    body = JSON.stringify({ message: redactSensitiveText(String(value)) })
  }
  if (!body || body === '{}') body = JSON.stringify({ message: redactSensitiveText(String(value)) })
  const parsed = JSON.parse(body)
  if (typeof parsed === 'string') return { message: redactSensitiveText(parsed) }
  // Keep structured provider diagnostics, but never accept a credential-shaped
  // value into another field while sanitizing the error object.
  if (isPlainObject(parsed)) {
    for (const [key, child] of Object.entries(parsed)) {
      if (SECRET_KEY.test(key)) parsed[key] = '[REDACTED]'
      else parsed[key] = redactSensitiveValue(child)
    }
  }
  return truncateError(parsed)
}

function truncateError(value) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    return { message: '[REDACTED]' }
  }
  if (Buffer.byteLength(body) <= MAX_ERROR_BYTES) return value
  return { message: redactSensitiveText('Remote job error was truncated because it exceeded the persistence limit.'), originalBytes: Buffer.byteLength(body) }
}

function normalizeLease(value, fencingToken) {
  if (value === undefined || value === null) return null
  if (!isPlainObject(value)) fail('REMOTE_JOB_INVALID_INPUT', 'lease must be an object or null')
  const lease = {}
  if (value.id !== undefined) lease.id = requireString(value.id, 'lease.id')
  if (value.fencingToken !== undefined) lease.fencingToken = requireFence(value.fencingToken)
  else if (fencingToken !== undefined) lease.fencingToken = fencingToken
  if (lease.fencingToken !== undefined && lease.fencingToken !== fencingToken) {
    fail('REMOTE_JOB_LEASE_CONFLICT', 'lease.fencingToken must match fencingToken')
  }
  if (value.expiresAt !== undefined && value.expiresAt !== null) lease.expiresAt = requireTimestamp(value.expiresAt, 'lease.expiresAt')
  if (Object.keys(lease).length === 0) fail('REMOTE_JOB_INVALID_INPUT', 'lease must contain an id, fencingToken, or expiresAt')
  return lease
}

function normalizeCursor(value) {
  if (value === undefined || value === null) return 0
  return requireNonnegativeInteger(value, 'lastCursor')
}

function normalizeState(value, terminal) {
  if (!STATES.has(value)) fail('REMOTE_JOB_INVALID_INPUT', 'state must be a supported worker state')
  if (terminal === true && !TERMINAL_STATES.includes(value)) fail('REMOTE_JOB_INVALID_INPUT', 'terminal must be a terminal worker state')
  if (terminal === false && TERMINAL_STATES.includes(value)) fail('REMOTE_JOB_INVALID_INPUT', 'a terminal state cannot be marked non-terminal')
  return value
}

function normalizeTerminal(value, state) {
  if (value === undefined) return TERMINAL_STATES.includes(state)
  if (typeof value !== 'boolean') fail('REMOTE_JOB_INVALID_INPUT', 'terminal must be a boolean')
  if (value !== TERMINAL_STATES.includes(state)) fail('REMOTE_JOB_INVALID_INPUT', 'terminal must agree with state')
  return value
}

function normalizeJob(input, { existing = null, now, enforceCapacity = false, maxJobs, bumpRevision = false, expiredAt, persisted = false } = {}) {
  if (!isPlainObject(input)) fail('REMOTE_JOB_INVALID_INPUT', 'job must be a plain object')
  const state = normalizeState(input.state ?? existing?.state ?? 'queued', input.terminal ?? existing?.terminal)
  const terminal = normalizeTerminal(input.terminal ?? existing?.terminal, state)
  const fencingToken = requireFence(input.fencingToken ?? existing?.fencingToken)
  const lease = normalizeLease(input.lease === undefined ? existing?.lease : input.lease, fencingToken)
  const createdAt = requireTimestamp(input.createdAt ?? existing?.createdAt ?? now(), 'createdAt')
  const updatedAt = requireTimestamp(input.updatedAt ?? now(), 'updatedAt')
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('REMOTE_JOB_INVALID_INPUT', 'updatedAt must not precede createdAt')
  const workSpec = createWorkSpec(input.workSpec ?? existing?.workSpec)
  if (Buffer.byteLength(JSON.stringify(workSpec)) > MAX_SPEC_BYTES) fail('REMOTE_JOB_CAPACITY', 'workSpec is too large to persist')
  const attempt = requirePositiveInteger(input.attempt ?? workSpec.attempt, 'attempt')
  const runId = input.runId === undefined ? workSpec.run.id : requireString(input.runId, 'runId', { max: 256 })
  const subtaskId = input.subtaskId === undefined ? workSpec.subtask.id : requireString(input.subtaskId, 'subtaskId', { max: 256 })
  if (runId !== workSpec.run.id || subtaskId !== workSpec.subtask.id || attempt !== workSpec.attempt) {
    fail('REMOTE_JOB_INVALID_INPUT', 'worker identity and attempt must agree with workSpec')
  }
  const expectedRevision = requireRevision(input.revision ?? 0, 'revision')
  if (!existing && !persisted && expectedRevision !== 0) fail('REMOTE_JOB_REVISION_CONFLICT', 'A new job must start at revision zero', {
    expectedRevision: expectedRevision, actualRevision: 0,
  })
  if (existing && expectedRevision !== existing.revision) fail('REMOTE_JOB_REVISION_CONFLICT', 'The job changed; reload it before writing', {
    expectedRevision: expectedRevision, actualRevision: existing.revision,
  })
  const revision = bumpRevision ? (existing ? existing.revision + 1 : 1) : expectedRevision
  if (!Number.isSafeInteger(revision)) fail('REMOTE_JOB_REVISION_EXHAUSTED', 'The job revision cannot be incremented safely')
  if (existing) {
    const immutable = ['workerId', 'runId', 'subtaskId', 'attempt', 'createdAt']
    for (const key of immutable) {
      if (input[key] !== undefined && input[key] !== existing[key]) fail('REMOTE_JOB_IDENTITY_CONFLICT', `${key} cannot change for an existing job`)
    }
    if (existing.terminal) {
      if (state !== existing.state) fail('REMOTE_JOB_TERMINAL', 'A terminal job cannot change state')
      if (JSON.stringify(lease) !== JSON.stringify(existing.lease)) fail('REMOTE_JOB_TERMINAL', 'A terminal job cannot acquire a different lease')
      if (input.lastCursor !== undefined && input.lastCursor !== existing.lastCursor) fail('REMOTE_JOB_TERMINAL', 'A terminal job cannot move its cursor')
      if (input.error !== undefined && JSON.stringify(sanitizeError(input.error)) !== JSON.stringify(existing.error)) {
        fail('REMOTE_JOB_TERMINAL', 'A terminal job cannot change its error')
      }
    } else if ((expiredAt === undefined || Date.parse(existing.lease?.expiresAt ?? existing.createdAt) > expiredAt)
      && (input.lease !== undefined || input.fencingToken !== undefined)) {
      if (!sameFence(fencingToken, existing.fencingToken)) fail('REMOTE_JOB_LEASE_CONFLICT', 'An active worker cannot change its fencing token')
      if (lease?.id !== undefined && existing.lease?.id !== undefined && lease.id !== existing.lease.id) {
        fail('REMOTE_JOB_LEASE_CONFLICT', 'An active worker cannot change its lease id')
      }
      if (lease?.expiresAt !== undefined && existing.lease?.expiresAt !== undefined && Date.parse(lease.expiresAt) < Date.parse(existing.lease.expiresAt)) {
        fail('REMOTE_JOB_LEASE_CONFLICT', 'An active worker cannot shorten its lease')
      }
    }
  } else if (terminal && state === 'queued') {
    fail('REMOTE_JOB_INVALID_INPUT', 'queued cannot be a terminal state')
  }
  if (enforceCapacity && !existing) requirePositiveInteger(maxJobs, 'maxJobs')
  return freezeJson({
    workerId: requireString(input.workerId, 'workerId'),
    runId,
    subtaskId,
    attempt,
    lease,
    fencingToken,
    workSpec,
    state,
    terminal,
    createdAt,
    updatedAt,
    lastCursor: normalizeCursor(input.lastCursor ?? existing?.lastCursor),
    error: sanitizeError(input.error === undefined ? existing?.error : input.error),
    revision,
  })
}

function normalizeOptions(options) {
  if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'options must be an object')
  const maxJobs = options.maxJobs ?? 1000
  requirePositiveInteger(maxJobs, 'maxJobs')
  if (maxJobs > 100_000) fail('REMOTE_JOB_INVALID_INPUT', 'maxJobs must not exceed 100000')
  if (options.now !== undefined && typeof options.now !== 'function') fail('REMOTE_JOB_INVALID_INPUT', 'now must be a function')
  if (options.warn !== undefined && typeof options.warn !== 'function') fail('REMOTE_JOB_INVALID_INPUT', 'warn must be a function')
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 60_000) fail('REMOTE_JOB_INVALID_INPUT', 'lockTimeoutMs must be between 1 and 60000')
  return { maxJobs, now: options.now ?? Date.now, warn: options.warn ?? (() => {}), lockTimeoutMs }
}

function timestampOf(now, previous) {
  let value = now()
  if (typeof value === 'number' && Number.isFinite(value)) value = new Date(value).toISOString()
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('REMOTE_JOB_INVALID_INPUT', 'now() must return a valid timestamp or millisecond epoch')
  if (previous && Date.parse(value) < Date.parse(previous)) value = previous
  return value
}

function sameFence(left, right) {
  return typeof left === typeof right && left === right
}

function fenceNewer(incoming, current) {
  if (sameFence(incoming, current)) return true
  if (typeof incoming === 'number' && typeof current === 'number') return incoming >= current
  // Opaque tokens have no portable ordering; a different token is the provider's
  // explicit replacement. There is no safe way to infer which opaque token is old.
  return true
}

function leaseActive(job, at) {
  return !job.terminal && (!job.lease?.expiresAt || Date.parse(job.lease.expiresAt) > at)
}

function expiredLease(job, lease, at) {
  if (!lease || !TERMINAL_STATES.includes(job.state) || Date.parse(lease.expiresAt ?? job.createdAt) <= at) return null
  return { workerId: job.workerId, revision: job.revision, state: job.state, lease, at: new Date(at).toISOString() }
}

function validateDocument(payload, file, maxJobs) {
  if (!isPlainObject(payload) || payload.format !== FORMAT || payload.formatVersion !== FORMAT_VERSION || !Array.isArray(payload.jobs)) {
    fail('REMOTE_JOB_CORRUPT', 'The remote job file is not a supported store document', { file })
  }
  if (payload.jobs.length > maxJobs) fail('REMOTE_JOB_CAPACITY', 'The remote job file exceeds the configured capacity', { file })
  const ids = new Set()
  const jobs = payload.jobs.map((entry, index) => {
    try {
      const job = normalizeJob(entry, { now: () => entry?.updatedAt ?? 0, persisted: true })
      if (job.revision !== entry.revision) fail('REMOTE_JOB_CORRUPT', 'The persisted job revision is invalid')
      if (ids.has(job.workerId)) fail('REMOTE_JOB_CORRUPT', 'The remote job file contains duplicate worker ids')
      ids.add(job.workerId)
      return job
    } catch (error) {
      if (error instanceof RemoteJobError && ['REMOTE_JOB_CORRUPT', 'REMOTE_JOB_INVALID_INPUT'].includes(error.code)) {
        fail('REMOTE_JOB_CORRUPT', `The remote job file has an invalid job at index ${index}`, { file })
      }
      throw error
    }
  })
  return { ...payload, jobs }
}

/**
 * Atomic, cross-process durable storage for remote Worker jobs.
 *
 * `put` is create-or-replace for one worker id. New jobs receive revision 1;
 * every changed record increments its revision, and a replacement must carry
 * the persisted revision. `markState` and `markTerminal` update the newest revision
 * and return `{ changed: false }` on an idempotent terminal repeat. No operation
 * clears terminal jobs, including recover(). Expired active leases reject
 * mutations until put() installs an equal-or-newer fencing token and lease, or
 * markState/markTerminal/advanceCursor renew the lease with the same fencing
 * token. advanceCursor atomically persists a monotonic event cursor.
 */
export function createRemoteJobStore({ file, now = Date.now, maxJobs = 1000, warn = () => {}, lockTimeoutMs = 10_000 } = {}) {
  const options = normalizeOptions({ now, maxJobs, warn, lockTimeoutMs })
  const clock = options.now
  const capacity = options.maxJobs
  requireString(file, 'file', { max: 4096 })
  const stateFile = path.resolve(file)
  const lockFile = `${stateFile}.lock`
  const dir = path.dirname(stateFile)
  const corrupt = new Map()
  let writeTail = Promise.resolve()

  async function readFile(file, missing = null) {
    try {
      return await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return missing
      throw error
    }
  }

  async function parseDocument(text) {
    if (!text) return { format: FORMAT, formatVersion: FORMAT_VERSION, jobs: [] }
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail('REMOTE_JOB_CAPACITY', 'The remote job file is too large')
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      fail('REMOTE_JOB_CORRUPT', 'The remote job file is not valid JSON', { file: stateFile })
    }
    return validateDocument(payload, stateFile, options.maxJobs)
  }

  async function quarantine(file, error) {
    const target = `${file}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`
    try {
      await fsp.rename(file, target)
      corrupt.set(file, target)
      options.warn(`remote job state ${file} was invalid; preserved at ${target}`)
      if (error instanceof RemoteJobError) error.quarantinePath = target
      return target
    } catch (renameError) {
      if (renameError?.code !== 'ENOENT') throw renameError
      return null
    }
  }

  async function load({ quarantineCorrupt = true } = {}) {
    const text = await readFile(stateFile)
    try {
      return { document: await parseDocument(text), text }
    } catch (error) {
      if (!quarantineCorrupt || error?.code !== 'REMOTE_JOB_CORRUPT') throw error
      await quarantine(stateFile, error)
      return { document: { format: FORMAT, formatVersion: FORMAT_VERSION, jobs: [] }, text: null }
    }
  }

  async function renameAtomic(tmp) {
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(tmp, stateFile)
        return
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * attempt))
      }
    }
  }

  async function writeDocument(document) {
    const body = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) fail('REMOTE_JOB_CAPACITY', 'The remote job file would exceed its size limit')
    const tmp = path.join(dir, `.${path.basename(stateFile)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await fsp.writeFile(tmp, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await renameAtomic(tmp)
    } finally {
      await fsp.unlink(tmp).catch(() => {})
    }
  }

  async function init() {
    await fsp.mkdir(dir, { recursive: true })
    return withLock(async () => {
      const { document, text } = await load()
      if (text === null) await writeDocument(document)
      return document
    })
  }

  async function withLock(operation) {
    const prior = writeTail.catch(() => {})
    let releaseLock
    const work = prior.then(async () => {
      releaseLock = await acquireFileLock(lockFile, {
        staleMs: 30_000,
        retries: Math.ceil(options.lockTimeoutMs / LOCK_RETRY_MS),
        retryDelayMs: LOCK_RETRY_MS,
        now: () => Date.now(),
      })
      if (!releaseLock) fail('REMOTE_JOB_LOCK_BUSY', 'The remote job store is locked by another process')
      try {
        return await operation()
      } finally {
        await releaseLock()
      }
    })
    writeTail = work.catch(() => {})
    return work
  }

  function find(document, workerId) {
    return document.jobs.find(job => job.workerId === workerId) ?? null
  }

  async function put(workerId, job, options = {}) {
    if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'put options must be an object')
    requireString(workerId, 'workerId')
    if (options.expectedRevision !== undefined) requireRevision(options.expectedRevision, 'expectedRevision')
    return withLock(async () => {
      const { document } = await load({ quarantineCorrupt: false })
      const existing = find(document, workerId)
      if (options.expectedRevision !== undefined && options.expectedRevision !== (existing?.revision ?? 0)) {
        fail('REMOTE_JOB_REVISION_CONFLICT', 'The job changed before put', { expectedRevision: options.expectedRevision, actualRevision: existing?.revision ?? 0 })
      }
      const at = Date.parse(timestampOf(options.now ?? clock))
      if (existing?.terminal) {
        if (existing.state !== job?.state) fail('REMOTE_JOB_TERMINAL', 'A terminal job cannot change state')
        const incomingFence = job?.fencingToken ?? job?.lease?.fencingToken
        if (incomingFence !== undefined && !sameFence(incomingFence, existing.fencingToken)) {
          fail('REMOTE_JOB_LEASE_CONFLICT', 'A terminal job cannot change its fencing token', { workerId, revision: existing.revision })
        }
      }
      if (existing && !leaseActive(existing, at)) {
        const incomingFence = job?.fencingToken ?? job?.lease?.fencingToken
        const lease = job?.lease
        if (incomingFence === undefined || !fenceNewer(incomingFence, existing.fencingToken)
          || !lease || lease.expiresAt === undefined || Date.parse(lease.expiresAt) <= at) {
          fail('REMOTE_JOB_LEASE_EXPIRED', 'The expired lease cannot mutate the job; a newer lease and fencing token are required', { workerId, revision: existing.revision })
        }
      }
      const normalized = normalizeJob({ ...job, workerId, revision: job?.revision ?? existing?.revision ?? 0 }, {
        existing,
        now: () => timestampOf(options.now ?? clock),
        enforceCapacity: true,
        maxJobs: capacity,
        bumpRevision: true,
        expiredAt: at,
      })
      if (existing?.terminal) return jsonClone(existing)
      const jobs = existing
        ? document.jobs.map(item => item.workerId === workerId ? normalized : item)
        : [...document.jobs, normalized]
      if (jobs.length > capacity) fail('REMOTE_JOB_CAPACITY', 'The remote job capacity limit would be exceeded')
      await writeDocument({ ...document, jobs })
      return jsonClone(normalized)
    })
  }

  async function get(workerId, options = {}) {
    if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'get options must be an object')
    requireString(workerId, 'workerId')
    if (options.revision !== undefined) requireRevision(options.revision, 'revision')
    return withLock(async () => {
      const { document } = await load()
      const job = find(document, workerId)
      if (!job || (options.revision !== undefined && job.revision !== options.revision)) return null
      return jsonClone(job)
    })
  }

  async function list(options = {}) {
    if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'list options must be an object')
    if (options.includeTerminal !== undefined && typeof options.includeTerminal !== 'boolean') fail('REMOTE_JOB_INVALID_INPUT', 'includeTerminal must be a boolean')
    return withLock(async () => {
      const { document } = await load()
      const jobs = document.jobs.filter(job => options.includeTerminal !== false || !job.terminal)
      return jobs.map(job => jsonClone(job))
    })
  }

  async function remove(workerId, options = {}) {
    if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'remove options must be an object')
    requireString(workerId, 'workerId')
    if (options.revision !== undefined) requireRevision(options.revision, 'revision')
    if (options.expectedFencingToken !== undefined) requireFence(options.expectedFencingToken)
    return withLock(async () => {
      const { document } = await load()
      const job = find(document, workerId)
      if (!job) return false
      if (options.revision !== undefined && options.revision !== job.revision) {
        fail('REMOTE_JOB_REVISION_CONFLICT', 'The job changed before remove', { expectedRevision: options.revision, actualRevision: job.revision })
      }
      const at = Date.parse(timestampOf(options.now ?? clock))
      if (!job.terminal && !leaseActive(job, at)) fail('REMOTE_JOB_LEASE_EXPIRED', 'The expired lease cannot remove the job', { workerId, revision: job.revision })
      if (options.expectedFencingToken !== undefined && !sameFence(options.expectedFencingToken, job.fencingToken)) {
        fail('REMOTE_JOB_LEASE_CONFLICT', 'The fencing token does not own this job', { workerId, revision: job.revision })
      }
      await writeDocument({ ...document, jobs: document.jobs.filter(item => item.workerId !== workerId) })
      return true
    })
  }

  function assertOwnership(job, guard, lease = job.lease) {
    if (!guard) fail('REMOTE_JOB_LEASE_REQUIRED', 'A current revision, lease, and fencing token are required')
    if (guard.revision !== job.revision) fail('REMOTE_JOB_REVISION_CONFLICT', 'The job changed before mutation', { expectedRevision: guard.revision, actualRevision: job.revision })
    if (!guard.lease || !sameFence(guard.fencingToken, job.fencingToken)
      || !sameFence(guard.lease.fencingToken ?? guard.fencingToken, job.fencingToken)) {
      fail('REMOTE_JOB_LEASE_CONFLICT', 'The worker lease or fencing token is stale', { workerId: job.workerId, revision: job.revision })
    }
    if (guard.lease.id !== undefined && guard.lease.id !== lease?.id) fail('REMOTE_JOB_LEASE_CONFLICT', 'The lease id is stale', { workerId: job.workerId, revision: job.revision })
  }

  function mutationLease(job, options, at) {
    const guard = mutationGuard(options, job)
    const active = leaseActive(job, at)
    const replacement = options.lease === undefined ? null : normalizeLease(options.lease, job.fencingToken)
    if (options.lease !== undefined && !replacement) fail('REMOTE_JOB_LEASE_REQUIRED', 'A replacement lease must be an object')
    const lease = replacement ? { ...job.lease, ...replacement } : job.lease

    // Ownership is checked before expiry so a stale worker cannot probe lease
    // state. Once expired, the same fence may install a fresh lease (including a
    // new lease id), but it cannot replace or change the fencing token.
    assertOwnership(job, guard, active ? job.lease : lease)
    if (!active) {
      if (!replacement?.expiresAt || Date.parse(replacement.expiresAt) <= at) {
        fail('REMOTE_JOB_LEASE_EXPIRED', 'The expired lease requires a fresh lease with the same fencing token', { workerId: job.workerId, revision: job.revision })
      }
    } else if (replacement?.expiresAt !== undefined && job.lease?.expiresAt !== undefined
      && Date.parse(replacement.expiresAt) < Date.parse(job.lease.expiresAt)) {
      fail('REMOTE_JOB_LEASE_CONFLICT', 'An active worker cannot shorten its lease', { workerId: job.workerId, revision: job.revision })
    }
    return lease
  }

  function mutationGuard(options, job) {
    if (options.expectedRevision !== undefined) requireRevision(options.expectedRevision, 'expectedRevision')
    if (options.expectedFencingToken !== undefined) requireFence(options.expectedFencingToken)
    const lease = options.lease === undefined ? job?.lease : options.lease
    return {
      revision: options.expectedRevision ?? options.revision ?? job?.revision,
      fencingToken: options.expectedFencingToken ?? options.fencingToken ?? lease?.fencingToken ?? job?.fencingToken,
      lease,
    }
  }

  async function markState(workerId, state, options = {}) {
    if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'markState options must be an object')
    requireString(workerId, 'workerId')
    if (!STATES.has(state)) fail('REMOTE_JOB_INVALID_INPUT', 'state must be a supported worker state')
    if (options.error !== undefined && TERMINAL_STATES.includes(state)) fail('REMOTE_JOB_INVALID_INPUT', 'use markTerminal to persist a terminal error')
    return withLock(async () => {
      const { document } = await load()
      const job = find(document, workerId)
      if (!job) return null
      const at = Date.parse(timestampOf(options.now ?? clock))
      if (job.terminal) {
        const guard = mutationGuard(options, job)
        assertOwnership(job, guard)
        return { changed: false, job: jsonClone(job), expiredLease: expiredLease(job, guard.lease, at) }
      }
      const lease = mutationLease(job, options, at)
      const leaseChanged = JSON.stringify(lease) !== JSON.stringify(job.lease)
      if (state === job.state && options.error === undefined && !leaseChanged) return { changed: false, job: jsonClone(job) }
      if (TERMINAL_STATES.includes(state)) fail('REMOTE_JOB_INVALID_INPUT', 'use markTerminal to persist a terminal state')
      const next = normalizeJob({ ...job, state, lease, error: options.error, updatedAt: new Date(at).toISOString() }, { existing: job, now: () => new Date(at).toISOString(), bumpRevision: true, expiredAt: at })
      await writeDocument({ ...document, jobs: document.jobs.map(item => item.workerId === workerId ? next : item) })
      return { changed: true, job: jsonClone(next) }
    })
  }

  async function markTerminal(workerId, terminal, options = {}) {
    if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'markTerminal options must be an object')
    requireString(workerId, 'workerId')
    if (!TERMINAL_STATES.includes(terminal)) fail('REMOTE_JOB_INVALID_INPUT', 'terminal must be succeeded, failed, stopped, or timed_out')
    return withLock(async () => {
      const { document } = await load()
      const job = find(document, workerId)
      if (!job) return null
      const at = Date.parse(timestampOf(options.now ?? clock))
      if (job.terminal) {
        const guard = mutationGuard(options, job)
        assertOwnership(job, guard)
        return { changed: false, job: jsonClone(job), expiredLease: expiredLease(job, guard.lease, at) }
      }
      const lease = mutationLease(job, options, at)
      if (terminal === job.state && options.error === undefined
        && JSON.stringify(lease) === JSON.stringify(job.lease)) return { changed: false, job: jsonClone(job) }
      const next = normalizeJob({ ...job, state: terminal, terminal: true, lease, error: options.error, updatedAt: new Date(at).toISOString() }, { existing: job, now: () => new Date(at).toISOString(), bumpRevision: true, expiredAt: at })
      await writeDocument({ ...document, jobs: document.jobs.map(item => item.workerId === workerId ? next : item) })
      return { changed: true, job: jsonClone(next) }
    })
  }

  async function advanceCursor(workerId, cursor, options = {}) {
    if (!isPlainObject(options)) fail('REMOTE_JOB_INVALID_INPUT', 'advanceCursor options must be an object')
    requireString(workerId, 'workerId')
    requireNonnegativeInteger(cursor, 'cursor')
    return withLock(async () => {
      const { document } = await load()
      const job = find(document, workerId)
      if (!job) return null
      const at = Date.parse(timestampOf(options.now ?? clock))
      if (job.terminal) {
        assertOwnership(job, mutationGuard(options, job))
        if (cursor !== job.lastCursor) fail('REMOTE_JOB_TERMINAL', 'A terminal job cannot move its cursor', { workerId, revision: job.revision })
        return { changed: false, job: jsonClone(job) }
      }
      if (cursor < job.lastCursor) fail('REMOTE_JOB_CURSOR_REGRESSION', 'The event cursor cannot move backwards', { workerId, revision: job.revision })
      const lease = mutationLease(job, options, at)
      const leaseChanged = JSON.stringify(lease) !== JSON.stringify(job.lease)
      if (cursor === job.lastCursor && !leaseChanged) return { changed: false, job: jsonClone(job) }
      const next = normalizeJob({ ...job, lease, lastCursor: cursor, updatedAt: new Date(at).toISOString() }, {
        existing: job, now: () => new Date(at).toISOString(), bumpRevision: true, expiredAt: at,
      })
      await writeDocument({ ...document, jobs: document.jobs.map(item => item.workerId === workerId ? next : item) })
      return { changed: true, job: jsonClone(next) }
    })
  }

  async function recover() {
    await init()
    return withLock(async () => {
      const { document } = await load()
      return document.jobs.filter(job => !job.terminal).map(job => jsonClone(job))
    })
  }

  return Object.freeze({ file: stateFile, lockFile, init, put, get, list, remove, markState, markTerminal, advanceCursor, recover, corrupt })
}
