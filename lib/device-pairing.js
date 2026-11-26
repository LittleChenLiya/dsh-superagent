/**
 * Scope-limited, revocable credentials for the mobile shell.
 *
 * The plaintext token is returned once by pair(). Only its SHA-256 digest is
 * persisted. These credentials are intentionally not accepted by the console's
 * API yet: mobile authentication is a separate integration boundary.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLock } from './lock.js'

export const DEVICE_SCOPES = Object.freeze(['chat', 'tasks', 'inbox', 'artifacts', 'approval'])
const ALLOWED_SCOPES = new Set(DEVICE_SCOPES)
const TOKEN_PREFIX = 'dsm_'
const MAX_TOKEN_LENGTH = 200

export class DevicePairingError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'DevicePairingError'
    this.status = status
    this.statusCode = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new DevicePairingError(status, code, message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function digest(token) {
  return createHash('sha256').update(token).digest('hex')
}

function publicDevice(device, at) {
  if (!device) return null
  const expired = Date.parse(device.expiresAt) <= at
  return {
    id: device.id,
    name: device.name,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    lastUsedAt: device.lastUsedAt ?? null,
    revokedAt: device.revokedAt ?? null,
    status: device.revokedAt ? 'revoked' : expired ? 'expired' : 'active',
  }
}

function normaliseDevice(value, at) {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || typeof value.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.tokenHash)
    || !Array.isArray(value.scopes) || value.scopes.length === 0
    || !value.scopes.every(scope => ALLOWED_SCOPES.has(scope))
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.expiresAt))) {
    fail(500, 'DEVICE_STORE_INVALID', 'the device pairing store contains an invalid record')
  }
  const scopes = [...new Set(value.scopes)]
  if (scopes.length !== value.scopes.length) fail(500, 'DEVICE_STORE_INVALID', 'the device pairing store contains duplicate scopes')
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name.slice(0, 80) : 'Mobile device',
    tokenHash: value.tokenHash,
    scopes,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    lastUsedAt: typeof value.lastUsedAt === 'string' && Number.isFinite(Date.parse(value.lastUsedAt)) ? value.lastUsedAt : null,
    revokedAt: typeof value.revokedAt === 'string' && Number.isFinite(Date.parse(value.revokedAt)) ? value.revokedAt : null,
    ...(Date.parse(value.expiresAt) <= at ? { expiredAt: value.expiresAt } : {}),
  }
}

/**
 * Create a file-backed device credential store.
 *
 * @param {{file?: string, stateFile?: string, now?: () => number, warn?: (message: string) => void,
 *   defaultTtlSeconds?: number, maxDevices?: number}} options
 */
export function createDevicePairingStore({
  file,
  stateFile,
  now = () => Date.now(),
  warn = () => {},
  defaultTtlSeconds = 30 * 24 * 60 * 60,
  maxDevices = 100,
} = {}) {
  const target = file ?? stateFile
  if (typeof target !== 'string' || !target.trim()) throw new TypeError('createDevicePairingStore requires a file')
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (!Number.isSafeInteger(defaultTtlSeconds) || defaultTtlSeconds < 1 || defaultTtlSeconds > 365 * 24 * 60 * 60) {
    throw new TypeError('defaultTtlSeconds must be an integer from 1 to 31536000')
  }
  if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 10_000) {
    throw new TypeError('maxDevices must be an integer from 1 to 10000')
  }
  const storeFile = path.resolve(target.trim())
  let mutationTail = Promise.resolve()
  let disposed = false

  async function read() {
    let text
    try {
      text = await fsp.readFile(storeFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, devices: [] }
      throw error
    }
    let document
    try {
      document = JSON.parse(text)
    } catch {
      fail(500, 'DEVICE_STORE_CORRUPT', 'the device pairing store is not valid JSON')
    }
    if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.devices)) {
      fail(500, 'DEVICE_STORE_INVALID', 'the device pairing store has an unsupported shape')
    }
    const devices = document.devices.map(device => normaliseDevice(device, now()))
    const ids = new Set()
    const hashes = new Set()
    for (const device of devices) {
      if (ids.has(device.id) || hashes.has(device.tokenHash)) {
        fail(500, 'DEVICE_STORE_INVALID', 'the device pairing store contains duplicate device records')
      }
      ids.add(device.id)
      hashes.add(device.tokenHash)
    }
    return { version: 1, devices }
  }

  async function replace(document) {
    await fsp.mkdir(path.dirname(storeFile), { recursive: true })
    const temporary = `${storeFile}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      for (let attempt = 0; ; attempt++) {
        try {
          await fsp.rename(temporary, storeFile)
          break
        } catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 4) throw error
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
        }
      }
      try { await fsp.chmod(storeFile, 0o600) } catch { /* Windows uses the existing ACL. */ }
    } finally {
      await fsp.unlink(temporary).catch(() => {})
    }
  }

  function cleanupDocument(document) {
    const at = now()
    const before = document.devices.length
    // Expired credentials can never verify again. Revoked records are kept for
    // status/audit, but bounded so repeated pairings cannot grow the file forever.
    document.devices = document.devices.filter(device => Date.parse(device.expiresAt) > at)
    const retainedLimit = maxDevices * 4
    if (document.devices.length > retainedLimit) {
      const revoked = document.devices.filter(device => device.revokedAt)
        .sort((left, right) => String(left.revokedAt).localeCompare(String(right.revokedAt)))
      const remove = new Set(revoked.slice(0, document.devices.length - retainedLimit).map(device => device.id))
      document.devices = document.devices.filter(device => !remove.has(device.id))
    }
    return before - document.devices.length
  }

  function serialise(action) {
    if (disposed) return Promise.reject(new DevicePairingError(503, 'DEVICE_STORE_DISPOSED', 'the device pairing store is disposed'))
    const next = mutationTail.catch(() => {}).then(action)
    mutationTail = next.catch(() => {})
    return next
  }

  function withLock(action) {
    return serialise(async () => {
      await fsp.mkdir(path.dirname(storeFile), { recursive: true })
      const release = await acquireFileLock(`${storeFile}.lock`, {
        now,
        staleMs: 30_000,
        retries: 100,
        retryDelayMs: 10,
      })
      if (!release) fail(503, 'DEVICE_STORE_BUSY', 'the device pairing store is locked; try again shortly')
      try {
        return await action()
      } finally {
        await release()
      }
    })
  }

  function parseScopes(input) {
    if (input === undefined) return [...DEVICE_SCOPES]
    if (!Array.isArray(input) || input.length === 0 || input.length > DEVICE_SCOPES.length
      || input.some(scope => typeof scope !== 'string' || !ALLOWED_SCOPES.has(scope))) {
      fail(400, 'INVALID_DEVICE_SCOPES', `scopes must contain only: ${DEVICE_SCOPES.join(', ')}`)
    }
    const scopes = [...new Set(input)]
    if (scopes.length !== input.length) fail(400, 'INVALID_DEVICE_SCOPES', 'scopes must not contain duplicates')
    return scopes
  }

  async function pair(input = {}) {
    if (!isRecord(input)) fail(400, 'INVALID_DEVICE_PAIR', 'device pairing options must be an object')
    const scopes = parseScopes(input.scopes)
    const name = input.name === undefined ? 'Mobile device' : String(input.name).trim().slice(0, 80)
    if (!name) fail(400, 'INVALID_DEVICE_NAME', 'name must be a non-empty string')
    const ttl = input.expiresInSeconds ?? defaultTtlSeconds
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 365 * 24 * 60 * 60) {
      fail(400, 'INVALID_DEVICE_EXPIRY', 'expiresInSeconds must be an integer from 1 to 31536000')
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const createdAt = new Date(now()).toISOString()
    const device = {
      id: randomUUID(),
      name,
      tokenHash: digest(token),
      scopes,
      createdAt,
      expiresAt: new Date(now() + ttl * 1000).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    }
    return withLock(async () => {
      const document = await read()
      cleanupDocument(document)
      const active = document.devices.filter(item => !item.revokedAt && Date.parse(item.expiresAt) > now())
      if (active.length >= maxDevices) fail(409, 'DEVICE_LIMIT', `at most ${maxDevices} active mobile devices are allowed`)
      document.devices.push(device)
      await replace(document)
      return { ...publicDevice(device, now()), token }
    })
  }

  async function verify(token) {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !token.startsWith(TOKEN_PREFIX)) return null
    const tokenHash = digest(token)
    return withLock(async () => {
      const document = await read()
      const expected = Buffer.from(tokenHash, 'hex')
      let matched = null
      for (const device of document.devices) {
        const candidate = Buffer.from(device.tokenHash, 'hex')
        if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
          matched = device
          break
        }
      }
      if (!matched || matched.revokedAt || Date.parse(matched.expiresAt) <= now()) return null
      matched.lastUsedAt = new Date(now()).toISOString()
      await replace(document)
      return publicDevice(matched, now())
    })
  }

  async function status(id) {
    return serialise(async () => {
      const document = await read()
      if (id !== undefined && id !== null && id !== '') {
        if (typeof id !== 'string') fail(400, 'INVALID_DEVICE_ID', 'device id must be a string')
        const device = document.devices.find(item => item.id === id)
        if (!device) fail(404, 'DEVICE_NOT_FOUND', 'unknown mobile device')
        return publicDevice(device, now())
      }
      return document.devices
        .map(device => publicDevice(device, now()))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    })
  }

  async function revoke(id) {
    if (typeof id !== 'string' || !id.trim()) fail(400, 'INVALID_DEVICE_ID', 'device id is required')
    return withLock(async () => {
      const document = await read()
      const device = document.devices.find(item => item.id === id.trim())
      if (!device) fail(404, 'DEVICE_NOT_FOUND', 'unknown mobile device')
      if (!device.revokedAt) {
        device.revokedAt = new Date(now()).toISOString()
        await replace(document)
      }
      return publicDevice(device, now())
    })
  }

  async function cleanup() {
    return withLock(async () => {
      const document = await read()
      const removed = cleanupDocument(document)
      if (removed > 0) await replace(document)
      return { removed, remaining: document.devices.length }
    })
  }

  async function dispose() {
    disposed = true
    await mutationTail
  }

  return { file: storeFile, stateFile: storeFile, pair, verify, status, revoke, cleanup, dispose }
}

export default { DEVICE_SCOPES, DevicePairingError, createDevicePairingStore }
