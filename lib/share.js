/**
 * Durable, read-only artifact shares and their comments.
 *
 * A share token is a bearer credential for exactly two possible capabilities:
 * reading the share's artifact scope and, for a commenter, adding a comment.
 * Owner operations (create, revoke and list) never accept a token. There are no
 * message, approval, run, or other control-plane methods in this module.
 *
 * Tokens are random 256-bit values returned only by createShare. The state file
 * contains only a SHA-256 digest (or HMAC-SHA-256 when tokenHashKey is supplied).
 * Comment actors come from the server-side actor/getActor option, never from the
 * comment request. Comment bodies remain plain text; escaping belongs to the
 * renderer.
 *
 * @module dsh-superagent/share
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { acquireFileLock } from './lock.js'

export const SHARE_STORE_VERSION = 1
export const SHARE_ROLES = Object.freeze(['viewer', 'commenter'])
export const SHARE_CAPABILITIES = Object.freeze(['share.read', 'share.comment'])

export const DEFAULT_MAX_SHARES = 200
export const DEFAULT_MAX_COMMENTS = 2000
export const DEFAULT_MAX_COMMENTS_PER_SHARE = 200
export const DEFAULT_MAX_ARTIFACTS_PER_SHARE = 64
export const DEFAULT_MAX_COMMENT_LENGTH = 2000
export const DEFAULT_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const TOKEN_PATTERN = /^shr_[A-Za-z0-9_-]{43}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const SHARE_KEYS = ['id', 'artifactIds', 'role', 'expiresAt', 'revokedAt', 'createdBy', 'tokenHash']
const COMMENT_KEYS = ['id', 'shareId', 'artifactId', 'text', 'actor', 'createdAt', 'idempotencyKeyHash']
const STATE_KEYS = ['version', 'shares', 'comments', 'updatedAt']
const ACTOR_FIELDS = ['actor', 'author', 'createdBy', 'userId']

/** An expected share/comment failure. Messages never contain a presented token. */
export class ShareError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ShareError'
    this.code = code
    this.status = status
  }
}

/** Existing state that cannot safely be read or replaced. */
export class ShareStateError extends ShareError {
  constructor(code, message, file) {
    super(code, message, 500)
    this.name = 'ShareStateError'
    this.file = file
  }
}

function fail(code, message, status) {
  throw new ShareError(code, message, status)
}

function objectOf(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-input', `${label} must be an object`)
  }
  return value
}

function positiveInteger(value, fallback, label, maximum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail('invalid-options', `${label} must be an integer between 1 and ${maximum}`)
  }
  return value
}

function epochValue(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function iso(value) {
  return new Date(value).toISOString()
}

function cleanText(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail('invalid-input', `${label} must be a string`)
  const text = value.trim()
  if (!allowEmpty && !text) fail('invalid-input', `${label} is required`)
  if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('invalid-input', `${label} must be at most ${maximum} characters and contain no control characters`)
  }
  return text
}

function cleanArtifactId(value) {
  const id = cleanText(value, 'artifactId', 200)
  if (id === '*' || id === '**') fail('invalid-input', 'artifactIds must name explicit resources, not wildcards')
  return id
}

function normalizeArtifactIds(value, maximum) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid-input', 'artifactIds must be a non-empty array')
  }
  if (value.length > maximum) fail('invalid-input', `artifactIds accepts at most ${maximum} entries`)
  const ids = value.map(cleanArtifactId)
  if (new Set(ids).size !== ids.length) fail('invalid-input', 'artifactIds must not contain duplicates')
  return ids
}

function rejectActorFields(input) {
  for (const key of ACTOR_FIELDS) {
    if (Object.hasOwn(input, key)) fail('actor-forbidden', `${key} is assigned by the server and cannot be supplied by a share client`)
  }
}

function publicShare(share) {
  return {
    id: share.id,
    artifactIds: [...share.artifactIds],
    role: share.role,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    createdBy: share.createdBy,
  }
}

function publicComment(comment) {
  return {
    id: comment.id,
    shareId: comment.shareId,
    artifactId: comment.artifactId,
    text: comment.text,
    actor: comment.actor,
    createdAt: comment.createdAt,
  }
}

function emptyState() {
  return { version: SHARE_STORE_VERSION, shares: [], comments: [], updatedAt: null }
}

function exactKeys(value, allowed) {
  return Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key))
}

function validTimestamp(value, { nullable = false } = {}) {
  if (value === null && nullable) return true
  return typeof value === 'string' && epochValue(value) !== null
}

function validShare(value, maxArtifacts) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, SHARE_KEYS)) return false
  if (typeof value.id !== 'string' || !value.id || value.id.length > 100) return false
  if (!Array.isArray(value.artifactIds) || value.artifactIds.length === 0 || value.artifactIds.length > maxArtifacts) return false
  const ids = new Set()
  for (const id of value.artifactIds) {
    if (typeof id !== 'string' || !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id) || id === '*' || id === '**') return false
    if (ids.has(id)) return false
    ids.add(id)
  }
  return SHARE_ROLES.includes(value.role)
    && validTimestamp(value.expiresAt)
    && validTimestamp(value.revokedAt, { nullable: true })
    && typeof value.createdBy === 'string' && Boolean(value.createdBy) && value.createdBy.length <= 160
    && typeof value.tokenHash === 'string' && DIGEST_PATTERN.test(value.tokenHash)
}

function validComment(value, maxCommentLength) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value, COMMENT_KEYS)) return false
  for (const key of ['id', 'shareId', 'artifactId', 'actor']) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 200) return false
  }
  return typeof value.text === 'string'
    && Boolean(value.text.trim())
    && [...value.text].length <= maxCommentLength
    && !value.text.includes('\u0000')
    && validTimestamp(value.createdAt)
    && typeof value.idempotencyKeyHash === 'string'
    && DIGEST_PATTERN.test(value.idempotencyKeyHash)
}

function validateState(state, maxArtifacts, maxCommentLength) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !exactKeys(state, STATE_KEYS)) return false
  if (state.version !== SHARE_STORE_VERSION || !Array.isArray(state.shares) || !Array.isArray(state.comments)) return false
  if (!validTimestamp(state.updatedAt, { nullable: true })) return false
  if (!state.shares.every(share => validShare(share, maxArtifacts))) return false
  if (!state.comments.every(comment => validComment(comment, maxCommentLength))) return false

  const shares = new Map()
  const tokenHashes = new Set()
  for (const share of state.shares) {
    if (shares.has(share.id) || tokenHashes.has(share.tokenHash)) return false
    shares.set(share.id, share)
    tokenHashes.add(share.tokenHash)
  }
  const comments = new Set()
  const requests = new Set()
  for (const comment of state.comments) {
    const share = shares.get(comment.shareId)
    if (!share || !share.artifactIds.includes(comment.artifactId)) return false
    if (comments.has(comment.id)) return false
    comments.add(comment.id)
    const request = [comment.shareId, comment.artifactId, comment.actor, comment.idempotencyKeyHash].join('\u0000')
    if (requests.has(request)) return false
    requests.add(request)
  }
  return true
}

function requestedArtifactIds(options, maximum) {
  if (typeof options === 'string') return [cleanArtifactId(options)]
  const source = options === undefined ? {} : objectOf(options, 'read options')
  const hasOne = Object.hasOwn(source, 'artifactId')
  const hasMany = Object.hasOwn(source, 'artifactIds')
  if (hasOne && hasMany) fail('invalid-input', 'choose artifactId or artifactIds, not both')
  if (hasOne) return [cleanArtifactId(source.artifactId)]
  if (hasMany) return normalizeArtifactIds(source.artifactIds, maximum)
  return []
}

function listLimit(value, fallback, maximum, label) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail('invalid-input', `${label} must be an integer between 1 and ${maximum}`)
  }
  return value
}

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * attempt))
    }
  }
}

/**
 * Build a share store rooted at one directory.
 *
 * actor/getActor is trusted server identity used for createdBy, comment author,
 * and owner checks. It may be a string, a function, or an async function. No
 * operation accepts an actor from the share client's input object.
 *
 * @param {string | {
 *   dir?: string, root?: string, file?: string, actor?: string | (() => string | Promise<string>),
 *   getActor?: () => string | Promise<string>, now?: () => number | string | Date,
 *   maxShares?: number, maxComments?: number, maxCommentsPerShare?: number,
 *   maxArtifactsPerShare?: number, maxCommentLength?: number, defaultTtlMs?: number,
 *   tokenHashKey?: string | Buffer | null
 * }} options
 */
export function createShareStore(options = {}) {
  if (typeof options === 'string') options = { dir: options }
  options = objectOf(options, 'share store options')
  const dir = options.dir ?? options.root
  if (typeof dir !== 'string' || !dir.trim()) fail('invalid-options', 'share store dir is required')
  const root = path.resolve(dir)
  const file = path.isAbsolute(options.file ?? '') ? options.file : path.join(root, options.file ?? 'shares.json')
  const maxShares = positiveInteger(options.maxShares, DEFAULT_MAX_SHARES, 'maxShares', 100_000)
  const maxComments = positiveInteger(options.maxComments, DEFAULT_MAX_COMMENTS, 'maxComments', 1_000_000)
  const maxCommentsPerShare = positiveInteger(
    options.maxCommentsPerShare, DEFAULT_MAX_COMMENTS_PER_SHARE, 'maxCommentsPerShare', maxComments,
  )
  const maxArtifacts = positiveInteger(
    options.maxArtifactsPerShare, DEFAULT_MAX_ARTIFACTS_PER_SHARE, 'maxArtifactsPerShare', 1000,
  )
  const maxCommentLength = positiveInteger(
    options.maxCommentLength, DEFAULT_MAX_COMMENT_LENGTH, 'maxCommentLength', 20_000,
  )
  const defaultTtlMs = positiveInteger(options.defaultTtlMs, DEFAULT_SHARE_TTL_MS, 'defaultTtlMs', Number.MAX_SAFE_INTEGER)
  const now = options.now ?? (() => Date.now())
  if (typeof now !== 'function') fail('invalid-options', 'now must be a function')
  if (options.actor !== undefined && options.getActor !== undefined) {
    fail('invalid-options', 'choose actor or getActor, not both')
  }
  const actorOption = options.getActor ?? options.actor ?? 'server'
  if (!['string', 'function'].includes(typeof actorOption)) fail('invalid-options', 'actor must be a string or function')

  let hashKey = null
  if (options.tokenHashKey !== undefined && options.tokenHashKey !== null) {
    hashKey = Buffer.isBuffer(options.tokenHashKey) || ArrayBuffer.isView(options.tokenHashKey)
      ? Buffer.from(options.tokenHashKey)
      : typeof options.tokenHashKey === 'string' && options.tokenHashKey
        ? Buffer.from(options.tokenHashKey, 'utf8')
        : null
    if (!hashKey) fail('invalid-options', 'tokenHashKey must be a non-empty string or bytes')
  }

  const digest = value => (hashKey
    ? createHmac('sha256', hashKey).update(value).digest('hex')
    : createHash('sha256').update(value).digest('hex'))
  let writes = Promise.resolve()

  function clock() {
    const value = epochValue(now())
    if (value === null) fail('invalid-options', 'now must return a valid date or epoch millisecond value')
    return value
  }

  async function currentActor() {
    const value = typeof actorOption === 'function' ? await actorOption() : actorOption
    return cleanText(value, 'server actor', 160)
  }

  async function readState() {
    let raw
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState()
      throw new ShareStateError('share-state-unreadable', `share state cannot be read: ${file}`, file)
    }
    let state
    try {
      state = JSON.parse(raw)
    } catch {
      throw new ShareStateError('share-state-invalid', `share state is not valid JSON and was left untouched: ${file}`, file)
    }
    if (!validateState(state, maxArtifacts, maxCommentLength)) {
      throw new ShareStateError('share-state-unsupported', `share state has an unsupported shape and was left untouched: ${file}`, file)
    }
    return state
  }

  async function load() {
    await writes
    return readState()
  }

  async function writeState(state) {
    const tmp = `${file}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await fsp.open(tmp, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(state), 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await renameWithRetry(tmp, file)
    } finally {
      if (handle) await handle.close().catch(() => {})
      await fsp.unlink(tmp).catch(() => {})
    }
  }

  function mutate(update) {
    const run = writes.then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const release = await acquireFileLock(`${file}.lock`, { retries: 30, retryDelayMs: 10 })
      if (!release) fail('share-store-locked', 'share state is locked by another writer', 503)
      try {
        const state = await readState()
        const at = clock()
        const result = update(state, at)
        if (!result.changed) return result.value
        state.updatedAt = iso(at)
        await writeState(state)
        return result.value
      } finally {
        await release()
      }
    })
    writes = run.catch(() => {})
    return run
  }

  function shareForToken(state, token, at) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      fail('share-token-invalid', 'share token is invalid', 401)
    }
    const presented = digest(token)
    let found = null
    for (const share of state.shares) {
      const left = Buffer.from(presented, 'hex')
      const right = Buffer.from(share.tokenHash, 'hex')
      if (left.length === right.length && timingSafeEqual(left, right)) found = share
    }
    if (!found) fail('share-token-invalid', 'share token is invalid', 401)
    if (found.revokedAt !== null) fail('share-revoked', 'share has been revoked', 403)
    if (epochValue(found.expiresAt) <= at) fail('share-expired', 'share has expired', 410)
    return found
  }

  function checkScope(share, artifactIds) {
    for (const artifactId of artifactIds) {
      if (!share.artifactIds.includes(artifactId)) {
        fail('resource-out-of-scope', 'resource is outside this share', 403)
      }
    }
  }

  /** Owner-only create. The returned token is never persisted or returned again. */
  async function createShare(input = {}) {
    input = objectOf(input, 'share')
    rejectActorFields(input)
    for (const key of ['id', 'token', 'tokenHash', 'revokedAt']) {
      if (Object.hasOwn(input, key)) fail('invalid-input', `${key} is assigned by the server`)
    }
    const artifactIds = normalizeArtifactIds(input.artifactIds, maxArtifacts)
    const role = input.role ?? 'viewer'
    if (!SHARE_ROLES.includes(role)) fail('invalid-input', 'role must be viewer or commenter')
    const at = clock()
    const hasTtl = Object.hasOwn(input, 'ttlMs') || Object.hasOwn(input, 'expiresInMs')
    if (hasTtl && input.expiresAt !== undefined) fail('invalid-input', 'choose expiresAt or ttlMs, not both')
    let expires
    if (input.expiresAt !== undefined) expires = epochValue(input.expiresAt)
    else {
      const ttl = input.ttlMs ?? input.expiresInMs ?? defaultTtlMs
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > Number.MAX_SAFE_INTEGER) {
        fail('invalid-input', 'ttlMs must be a positive integer')
      }
      expires = at + ttl
    }
    if (expires === null || !Number.isFinite(new Date(expires).getTime())) {
      fail('invalid-input', 'expiresAt must be a valid date')
    }
    if (expires <= at) fail('invalid-input', 'expiresAt must be in the future')
    const createdBy = await currentActor()
    const token = `shr_${randomBytes(32).toString('base64url')}`
    const share = {
      id: `share_${randomUUID()}`,
      artifactIds,
      role,
      expiresAt: iso(expires),
      revokedAt: null,
      createdBy,
      tokenHash: digest(token),
    }
    await mutate(state => {
      if (state.shares.length >= maxShares) fail('share-capacity-reached', 'share capacity has been reached', 429)
      state.shares.push(share)
      return { changed: true, value: share }
    })
    return { share: publicShare(share), token }
  }

  /** Token-only read of the share metadata and its explicit capabilities. */
  async function readShare(token, readOptions = {}) {
    const artifactIds = requestedArtifactIds(readOptions, maxArtifacts)
    const state = await load()
    const share = shareForToken(state, token, clock())
    checkScope(share, artifactIds)
    return {
      ...publicShare(share),
      capabilities: share.role === 'commenter' ? [...SHARE_CAPABILITIES] : ['share.read'],
    }
  }

  /** Owner-only, idempotent revocation. A token cannot call this operation. */
  async function revokeShare(shareId) {
    const id = cleanText(shareId, 'shareId', 100)
    const actor = await currentActor()
    const share = await mutate((state, at) => {
      const found = state.shares.find(item => item.id === id && item.createdBy === actor)
      if (!found) fail('share-not-found', 'share was not found', 404)
      const changed = found.revokedAt === null
      if (changed) found.revokedAt = iso(at)
      return { changed, value: found }
    })
    return publicShare(share)
  }

  /** Owner-only listing. Revoked shares remain visible unless explicitly filtered. */
  async function listShares(listOptions = {}) {
    listOptions = objectOf(listOptions, 'list options')
    rejectActorFields(listOptions)
    const actor = await currentActor()
    const includeRevoked = listOptions.includeRevoked !== false
    const limit = listLimit(listOptions.limit, Math.min(100, maxShares), maxShares, 'limit')
    const state = await load()
    return state.shares
      .filter(share => share.createdBy === actor && (includeRevoked || share.revokedAt === null))
      .slice(-limit)
      .reverse()
      .map(publicShare)
  }

  /** Add a plain-text comment. Duplicate idempotency keys replay the first result. */
  async function createComment(token, input = {}) {
    input = objectOf(input, 'comment')
    rejectActorFields(input)
    for (const key of ['id', 'shareId', 'createdAt']) {
      if (Object.hasOwn(input, key)) fail('invalid-input', `${key} is assigned by the server`)
    }
    const artifactId = cleanArtifactId(input.artifactId)
    if (typeof input.text !== 'string') fail('invalid-input', 'text must be a string')
    const text = input.text.trim()
    if (!text) fail('invalid-input', 'text is required')
    if (text.includes('\u0000')) fail('invalid-input', 'text must not contain NUL characters')
    if ([...text].length > maxCommentLength) {
      fail('comment-too-long', `comment must be at most ${maxCommentLength} characters`, 413)
    }
    const idempotencyKey = cleanText(input.idempotencyKey, 'idempotencyKey', 128)
    const idempotencyKeyHash = digest(idempotencyKey)
    const actor = await currentActor()
    const result = await mutate((state, at) => {
      const share = shareForToken(state, token, at)
      checkScope(share, [artifactId])
      if (share.role !== 'commenter') fail('commenter-required', 'this share does not allow comments', 403)
      const existing = state.comments.find(comment => comment.shareId === share.id
        && comment.artifactId === artifactId
        && comment.actor === actor
        && comment.idempotencyKeyHash === idempotencyKeyHash)
      if (existing) {
        if (existing.text !== text) fail('idempotency-conflict', 'idempotency key was already used for different comment text', 409)
        return { changed: false, value: { comment: publicComment(existing), replayed: true } }
      }
      if (state.comments.length >= maxComments) fail('comment-capacity-reached', 'comment capacity has been reached', 429)
      const forShare = state.comments.reduce((count, comment) => count + (comment.shareId === share.id ? 1 : 0), 0)
      if (forShare >= maxCommentsPerShare) {
        fail('comment-capacity-reached', 'comment capacity for this share has been reached', 429)
      }
      const comment = {
        id: `comment_${randomUUID()}`,
        shareId: share.id,
        artifactId,
        text,
        actor,
        createdAt: iso(at),
        idempotencyKeyHash,
      }
      state.comments.push(comment)
      return { changed: true, value: { comment: publicComment(comment), replayed: false } }
    })
    return { ...result.comment, replayed: result.replayed }
  }

  /** Token-only comment listing, optionally restricted to one shared artifact. */
  async function listComments(token, readOptions = {}) {
    const artifactIds = requestedArtifactIds(readOptions, maxArtifacts)
    const limit = listLimit(readOptions?.limit, Math.min(100, maxComments), maxComments, 'limit')
    const state = await load()
    const share = shareForToken(state, token, clock())
    checkScope(share, artifactIds)
    const allowed = new Set(artifactIds.length > 0 ? artifactIds : share.artifactIds)
    return state.comments
      .filter(comment => comment.shareId === share.id && allowed.has(comment.artifactId))
      .slice(0, limit)
      .map(publicComment)
  }

  const api = {
    dir: root,
    file,
    createShare,
    readShare,
    revokeShare,
    listShares,
    createComment,
    listComments,
    // Short aliases match the create/read/revoke/list vocabulary without adding
    // any token-capability dispatch surface.
    create: createShare,
    read: readShare,
    revoke: revokeShare,
    list: listShares,
    comments: { create: createComment, list: listComments },
  }
  return api
}
