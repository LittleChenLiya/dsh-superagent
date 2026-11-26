/**
 * Durable Agent profiles.
 *
 * A profile is deliberately only a reference to a model route: credentials stay
 * in the host environment and are never accepted by this module. Every mutation
 * runs under a cross-process file lock and replaces one JSON document by rename,
 * so readers never observe a partially written profile collection.
 *
 * @module dsh-superagent/agent-profiles
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireFileLock } from './lock.js'

export const DEFAULT_ASSISTANT_ID = 'global-assistant'
export const AGENT_ROLES = Object.freeze(['assistant', 'worker', 'reviewer', 'researcher', 'executor'])
export const EXECUTION_ROLES = Object.freeze(['worker', 'reviewer', 'researcher', 'executor'])
export const MEMORY_SCOPES = Object.freeze(['global', 'project', 'none'])
export const WORKSPACE_SCOPES = Object.freeze(['global', 'project', 'none'])

/** The built-in maximum catalogue. Installations may supply a narrower one. */
export const DEFAULT_TOOL_WHITELIST = Object.freeze([
  'read_file', 'write_file', 'edit_file', 'list_files', 'search_files',
  'run_command', 'web_search', 'browser_open', 'browser_click',
  'memory_search', 'memory_write', 'superagent_status', 'superagent_list',
  'superagent_start', 'superagent_resume', 'superagent_cancel',
  'profile_create', 'profile_update', 'profile_delete', 'permission_grant', 'agents_spawn',
])
export const DEFAULT_PERMISSION_WHITELIST = Object.freeze([
  'workspace.read', 'workspace.write', 'shell.execute', 'network.access',
  'memory.project', 'memory.global', 'browser.use', 'agents.spawn', 'profiles.manage',
])

export const DEFAULT_AGENT_PROFILE = Object.freeze({
  id: DEFAULT_ASSISTANT_ID,
  name: 'Global Assistant',
  avatar: 'assistant',
  role: 'assistant',
  model: null,
  provider: null,
  tools: Object.freeze(['read_file']),
  permissions: Object.freeze(['workspace.read', 'memory.global']),
  memoryScope: 'global',
  workspaceScope: 'global',
  enabled: true,
  revision: 1,
})

const FIELDS = Object.freeze([
  'id', 'name', 'avatar', 'role', 'model', 'provider', 'tools', 'permissions',
  'memoryScope', 'workspaceScope', 'enabled', 'revision',
])
const FIELD_SET = new Set(FIELDS)
const ROLE_SET = new Set(AGENT_ROLES)
const EXECUTION_ROLE_SET = new Set(EXECUTION_ROLES)
const MEMORY_SCOPE_SET = new Set(MEMORY_SCOPES)
const WORKSPACE_SCOPE_SET = new Set(WORKSPACE_SCOPES)
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/
const SECRET_KEY_PATTERN = /(?:api[-_]?key|access[-_]?key|private[-_]?key|secret|password|passwd|token|credential|authorization|cookie)/i
const SECRET_VALUE_PATTERN = /(?:\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:api[-_]?key|access[-_]?key|token|password|secret)\s*[:=]\s*\S+)/i
const EXECUTION_FORBIDDEN_PERMISSIONS = new Set(['profiles.manage', 'agents.spawn'])
const EXECUTION_FORBIDDEN_TOOL_PATTERN = /^(?:profile_(?:create|update|delete)|permission_grant|agents?_spawn|superagent_start)$/i
const TRUSTED_ACTORS = new Set(['admin', 'user', 'owner', 'local', 'system'])
const RESTRICTED_ACTORS = new Set([...EXECUTION_ROLES])

/** A profile validation, policy, conflict, or persistence error. */
export class AgentProfileError extends Error {
  constructor(message, code = 'INVALID_PROFILE', field = null) {
    super(message)
    this.name = 'AgentProfileError'
    this.code = code
    this.field = field
  }
}

/** Raised when expectedRevision no longer matches the locked on-disk value. */
export class AgentProfileConflictError extends AgentProfileError {
  constructor(id, expectedRevision, currentRevision) {
    super(
      `agent profile ${id} revision conflict: expected ${expectedRevision}, current ${currentRevision}`,
      'REVISION_CONFLICT',
      'revision',
    )
    this.name = 'AgentProfileConflictError'
    this.profileId = id
    this.expectedRevision = expectedRevision
    this.currentRevision = currentRevision
  }
}

function fail(code, field, message) {
  throw new AgentProfileError(`${field}: ${message}`, code, field)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function inputObject(input) {
  if (input instanceof AgentProfile) return input.toJSON()
  if (!isPlainObject(input)) fail('INVALID_PROFILE', 'profile', 'must be an object')
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !FIELD_SET.has(key)) {
      fail('INVALID_PROFILE', `profile.${String(key)}`, 'is not a known profile field')
    }
  }
  return input
}

function text(value, field, { max, required = false, nullable = false } = {}) {
  if (nullable && value === null) return null
  if (typeof value !== 'string') fail('INVALID_PROFILE', field, nullable ? 'must be a string or null' : 'must be a string')
  const clean = value.trim()
  if (required ? !clean : !clean && value !== '') fail('INVALID_PROFILE', field, 'must not be empty')
  if (clean.length > max) fail('INVALID_PROFILE', field, `must be at most ${max} characters`)
  if (CONTROL_PATTERN.test(clean)) fail('INVALID_PROFILE', field, 'must not contain control characters')
  if (SECRET_VALUE_PATTERN.test(clean)) fail('SECRET_REJECTED', field, 'must not contain credentials; configure the provider route in the host environment')
  return clean
}

function stringList(value, field, allowed, { max = 64, allowEmpty = true } = {}) {
  if (!Array.isArray(value)) fail('INVALID_PROFILE', field, 'must be an array')
  if (!allowEmpty && value.length === 0) fail('INVALID_PROFILE', field, 'must not be empty')
  if (value.length > max) fail('INVALID_PROFILE', field, `must contain at most ${max} entries`)
  const result = []
  const seen = new Set()
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item.trim()) fail('INVALID_PROFILE', `${field}[${index}]`, 'must be a non-empty string')
    const clean = item.trim()
    if (clean.length > 160 || CONTROL_PATTERN.test(clean)) fail('INVALID_PROFILE', `${field}[${index}]`, 'is too long or contains control characters')
    if (seen.has(clean)) fail('INVALID_PROFILE', `${field}[${index}]`, `duplicates ${JSON.stringify(clean)}`)
    seen.add(clean)
    if (allowed && !allowed.has(clean)) {
      fail(field.startsWith('tools') ? 'TOOL_NOT_ALLOWED' : 'PERMISSION_NOT_ALLOWED', `${field}[${index}]`, 'is not in the configured whitelist')
    }
    result.push(clean)
  }
  return Object.freeze(result)
}

function policyCatalogue(value, fallback, field) {
  if (value === undefined) return new Set(fallback)
  if (!Array.isArray(value)) fail('INVALID_PROFILE', field, 'must be an array')
  if (value.length > 256) fail('INVALID_PROFILE', field, 'must contain at most 256 entries')
  const result = new Set()
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > 160 || CONTROL_PATTERN.test(item)) {
      fail('INVALID_PROFILE', `${field}[${index}]`, 'must be a non-empty, bounded name')
    }
    if (result.has(item.trim())) fail('INVALID_PROFILE', `${field}[${index}]`, 'must not contain duplicates')
    result.add(item.trim())
  }
  return result
}

function resolvePolicy(options = {}) {
  if (!isPlainObject(options)) fail('INVALID_PROFILE', 'options', 'must be an object')
  return {
    allowedTools: policyCatalogue(options.allowedTools ?? options.tools, DEFAULT_TOOL_WHITELIST, 'allowedTools'),
    allowedPermissions: policyCatalogue(
      options.allowedPermissions ?? options.permissions,
      DEFAULT_PERMISSION_WHITELIST,
      'allowedPermissions',
    ),
  }
}

function canonicalProfile(input, policy, { defaultId = true } = {}) {
  const source = inputObject(input)
  const role = source.role === undefined ? 'assistant' : source.role
  if (typeof role !== 'string' || !ROLE_SET.has(role)) fail('INVALID_PROFILE', 'role', 'is not a supported Agent role')
  const id = source.id === undefined && defaultId ? (role === 'assistant' ? DEFAULT_ASSISTANT_ID : randomUUID()) : source.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail('INVALID_PROFILE', 'id', 'must be a bounded identifier using letters, numbers, ".", ":", "_", or "-"')
  const memoryScope = source.memoryScope === undefined ? (role === 'assistant' ? 'global' : 'project') : source.memoryScope
  const workspaceScope = source.workspaceScope === undefined ? (role === 'assistant' ? 'global' : 'project') : source.workspaceScope
  if (typeof memoryScope !== 'string' || !MEMORY_SCOPE_SET.has(memoryScope)) fail('INVALID_PROFILE', 'memoryScope', 'must be "global", "project", or "none"')
  if (typeof workspaceScope !== 'string' || !WORKSPACE_SCOPE_SET.has(workspaceScope)) fail('INVALID_PROFILE', 'workspaceScope', 'must be "global", "project", or "none"')
  if (role === 'assistant') {
    if (id !== DEFAULT_ASSISTANT_ID) fail('ASSISTANT_EXISTS', 'id', `assistant profiles must use the reserved id ${DEFAULT_ASSISTANT_ID}`)
    if (workspaceScope !== 'global') fail('INVALID_PROFILE', 'workspaceScope', 'assistant profiles must use the global workspace scope')
    if (memoryScope !== 'global') fail('INVALID_PROFILE', 'memoryScope', 'assistant profiles must use global memory')
  }
  const enabled = source.enabled === undefined ? true : source.enabled
  if (typeof enabled !== 'boolean') fail('INVALID_PROFILE', 'enabled', 'must be a boolean')
  const revision = source.revision === undefined ? 1 : source.revision
  if (!Number.isSafeInteger(revision) || revision < 1) fail('INVALID_PROFILE', 'revision', 'must be a positive safe integer')

  const profile = {
    id,
    name: text(source.name === undefined ? (role === 'assistant' ? 'Global Assistant' : `${role} Agent`) : source.name, 'name', { max: 120, required: true }),
    avatar: text(source.avatar === undefined ? (role === 'assistant' ? 'assistant' : 'bot') : source.avatar, 'avatar', { max: 2048 }),
    role,
    model: text(source.model === undefined ? null : source.model, 'model', { max: 200, nullable: true }),
    provider: text(source.provider === undefined ? null : source.provider, 'provider', { max: 200, nullable: true }),
    tools: stringList(source.tools === undefined ? (role === 'assistant' ? DEFAULT_AGENT_PROFILE.tools : []) : source.tools, 'tools', policy.allowedTools),
    permissions: stringList(
      source.permissions === undefined ? (role === 'assistant' ? DEFAULT_AGENT_PROFILE.permissions : []) : source.permissions,
      'permissions',
      policy.allowedPermissions,
      { max: 32 },
    ),
    memoryScope,
    workspaceScope,
    enabled,
    revision,
  }

  if (profile.avatar && !/^(?:[A-Za-z0-9._~-]+(?:\/[\w./~-]+)?|https:\/\/\S+|data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+|\/[\w./~-]+)$/.test(profile.avatar)) {
    fail('INVALID_PROFILE', 'avatar', 'must be an avatar name or asset path, an HTTPS URL, or an image data URL')
  }
  if (EXECUTION_ROLE_SET.has(role)) {
    const forbiddenPermission = profile.permissions.find(item => EXECUTION_FORBIDDEN_PERMISSIONS.has(item))
    if (forbiddenPermission) fail('PERMISSION_NOT_ALLOWED', 'permissions', `execution roles cannot hold ${forbiddenPermission}`)
    const forbiddenTool = profile.tools.find(item => EXECUTION_FORBIDDEN_TOOL_PATTERN.test(item))
    if (forbiddenTool) fail('TOOL_NOT_ALLOWED', 'tools', `execution roles cannot hold ${forbiddenTool}`)
  }
  return profile
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function plainSnapshot(profile) {
  return {
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
    role: profile.role,
    model: profile.model,
    provider: profile.provider,
    tools: [...profile.tools],
    permissions: [...profile.permissions],
    memoryScope: profile.memoryScope,
    workspaceScope: profile.workspaceScope,
    enabled: profile.enabled,
    revision: profile.revision,
  }
}

/**
 * Immutable canonical AgentProfile value. Persistence and UI snapshots contain
 * exactly these fields; unknown fields (including credentials) are rejected.
 */
export class AgentProfile {
  constructor(input = {}, options = {}) {
    const profile = canonicalProfile(input, resolvePolicy(options))
    Object.assign(this, profile, { tools: Object.freeze([...profile.tools]), permissions: Object.freeze([...profile.permissions]) })
    Object.freeze(this)
  }

  toJSON() {
    return plainSnapshot(this)
  }

  snapshot() {
    return this.toJSON()
  }
}

/** Validate without writing and return an independent canonical profile. */
export function validateAgentProfile(input = {}, options = {}) {
  return deepFreeze(canonicalProfile(input, resolvePolicy(options)))
}

/** Alias for callers that use normalisation terminology. */
export const normalizeAgentProfile = validateAgentProfile

function redactUnknown(value, key = null) {
  if (key && SECRET_KEY_PATTERN.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return SECRET_VALUE_PATTERN.test(value) ? '[REDACTED]' : value
  if (Array.isArray(value)) return value.map(item => redactUnknown(item))
  if (isPlainObject(value)) {
    const result = {}
    for (const [childKey, child] of Object.entries(value)) result[childKey] = redactUnknown(child, childKey)
    return result
  }
  return value == null || ['number', 'boolean'].includes(typeof value) ? value : '[REDACTED]'
}

/**
 * Make a UI/audit snapshot safe even when the source has extra nested fields.
 * Store snapshots are canonical and therefore contain no extra fields at all.
 */
export function redactAgentProfile(input) {
  if (!isPlainObject(input)) return null
  return redactUnknown(inputObjectSnapshot(input))
}

function inputObjectSnapshot(input) {
  if (input instanceof AgentProfile) return input.toJSON()
  if (!isPlainObject(input)) return {}
  const result = {}
  for (const [key, value] of Object.entries(input)) result[key] = value
  return result
}

function actorDescriptor(actor) {
  if (actor === undefined || actor === null) return { role: 'local', id: null, restricted: false }
  let role
  let id = null
  if (typeof actor === 'string') {
    const separator = actor.indexOf(':')
    role = separator < 0 ? actor : actor.slice(0, separator)
    id = separator < 0 ? null : actor.slice(separator + 1) || null
  } else if (isPlainObject(actor)) {
    role = actor.role ?? actor.type ?? actor.kind ?? 'user'
    id = actor.profileId ?? actor.id ?? null
  } else {
    fail('ACTOR_FORBIDDEN', 'actor', 'must be a role string or an actor object')
  }
  if (typeof role !== 'string' || (!TRUSTED_ACTORS.has(role) && !RESTRICTED_ACTORS.has(role))) {
    fail('ACTOR_FORBIDDEN', 'actor.role', 'is not a recognized principal role')
  }
  if (id !== null && (typeof id !== 'string' || !ID_PATTERN.test(id))) fail('ACTOR_FORBIDDEN', 'actor.id', 'must be a bounded profile identifier')
  return { role, id, restricted: RESTRICTED_ACTORS.has(role) }
}

function requireWritableActor(actor) {
  const descriptor = actorDescriptor(actor)
  if (descriptor.restricted) fail('WORKER_FORBIDDEN', 'actor', 'execution roles are read-only and cannot create, modify, disable, or delete profiles')
  return descriptor
}

function assertActorCanRead(actor, profile) {
  const descriptor = actorDescriptor(actor)
  if (descriptor.restricted && (!descriptor.id || profile.id !== descriptor.id || profile.role !== descriptor.role)) {
    fail('WORKER_FORBIDDEN', 'actor', 'an execution role can only read its own identified profile')
  }
  return descriptor
}

function actorCanRead(descriptor, profile) {
  return !descriptor.restricted || (descriptor.id !== null && descriptor.id === profile.id && descriptor.role === profile.role)
}

function parseOptions(options, numericRevision) {
  if (typeof options === 'number') return { expectedRevision: options }
  if (options === undefined || options === null) return { expectedRevision: numericRevision }
  if (!isPlainObject(options)) fail('INVALID_PROFILE', 'options', 'must be an object')
  return { ...options, expectedRevision: options.expectedRevision ?? numericRevision }
}

function expectedRevision(value) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_PROFILE', 'expectedRevision', 'must be a positive safe integer')
  return value
}

function checkRevision(profile, revision) {
  const wanted = expectedRevision(revision)
  if (wanted !== undefined && wanted !== profile.revision) throw new AgentProfileConflictError(profile.id, wanted, profile.revision)
}

function storeError(code, message) {
  return new AgentProfileError(message, code)
}

function validateDocument(document, policy) {
  if (!isPlainObject(document) || document.version !== 1 || !Array.isArray(document.profiles)) {
    throw storeError('CORRUPT_STORE', 'agent profile store must have version 1 and a profiles array')
  }
  if (Reflect.ownKeys(document).some(key => key !== 'version' && key !== 'profiles')) {
    throw storeError('CORRUPT_STORE', 'agent profile store contains unknown top-level fields')
  }
  if (document.profiles.length > 10_000) throw storeError('CORRUPT_STORE', 'agent profile store exceeds the document limit')
  const profiles = new Map()
  let globalAssistants = 0
  for (const [index, input] of document.profiles.entries()) {
    let profile
    try {
      profile = canonicalProfile(input, policy, { defaultId: false })
    } catch (error) {
      throw storeError('CORRUPT_STORE', `agent profile store contains an invalid profile at index ${index}: ${error.message}`)
    }
    if (profiles.has(profile.id)) throw storeError('CORRUPT_STORE', `agent profile store contains duplicate id ${profile.id}`)
    if (profile.role === 'assistant' && profile.workspaceScope === 'global') {
      globalAssistants++
      if (profile.id !== DEFAULT_ASSISTANT_ID) throw storeError('CORRUPT_STORE', 'the unique global assistant must use the reserved id')
    }
    profiles.set(profile.id, profile)
  }
  if (!profiles.has(DEFAULT_ASSISTANT_ID)) throw storeError('CORRUPT_STORE', 'agent profile store is missing the default global assistant')
  if (globalAssistants !== 1) throw storeError('CORRUPT_STORE', 'agent profile store must contain exactly one global assistant')
  return profiles
}

function defaultForPolicy(policy) {
  return {
    ...DEFAULT_AGENT_PROFILE,
    tools: DEFAULT_AGENT_PROFILE.tools.filter(tool => policy.allowedTools.has(tool)),
    permissions: DEFAULT_AGENT_PROFILE.permissions.filter(permission => policy.allowedPermissions.has(permission)),
  }
}

function newDocument(profiles) {
  return { version: 1, profiles: [...profiles.values()].map(plainSnapshot) }
}

async function replaceFile(file, value) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(temporary, file)
        return
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * attempt))
      }
    }
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {})
    throw error
  }
}

/** File-backed profile store. Construct once and share it, or open one per process. */
export class AgentProfileStore {
  constructor(options = {}) {
    if (!isPlainObject(options)) fail('INVALID_PROFILE', 'options', 'must be an object')
    const target = options.file ?? options.stateFile ?? options.storageFile
    if (typeof target !== 'string' || !target.trim()) throw new AgentProfileError('createAgentProfileStore requires a file', 'INVALID_OPTIONS', 'file')
    this.file = path.resolve(target.trim())
    this.stateFile = this.file
    this.policy = resolvePolicy(options)
    this.maxProfiles = options.maxProfiles ?? options.capacity ?? 100
    if (!Number.isSafeInteger(this.maxProfiles) || this.maxProfiles < 1 || this.maxProfiles > 10_000) {
      fail('INVALID_OPTIONS', 'maxProfiles', 'must be an integer from 1 to 10000')
    }
    this.now = options.now ?? (() => Date.now())
    if (typeof this.now !== 'function') fail('INVALID_OPTIONS', 'now', 'must be a function')
    this.lockOptions = {
      now: this.now,
      staleMs: options.staleMs ?? 30_000,
      retries: options.lockRetries ?? 100,
      retryDelayMs: options.lockRetryDelayMs ?? 10,
    }
    this.initialized = null
  }

  async readFile() {
    let source
    try {
      source = await fsp.readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return null
    }
    let document
    try {
      document = JSON.parse(source)
    } catch (error) {
      throw storeError('CORRUPT_STORE', `agent profile store is not valid JSON: ${error.message}`)
    }
    const profiles = validateDocument(document, this.policy)
    if (profiles.size > this.maxProfiles) {
      throw storeError('CAPACITY_EXCEEDED', `agent profile store has ${profiles.size} profiles, exceeding capacity ${this.maxProfiles}`)
    }
    return profiles
  }

  async withLock(action) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    const release = await acquireFileLock(`${this.file}.lock`, this.lockOptions)
    if (!release) throw storeError('LOCK_UNAVAILABLE', `cannot lock agent profile store ${this.file}; try again shortly`)
    try {
      return await action()
    } finally {
      await release()
    }
  }

  async loadOrInitialize() {
    return this.withLock(async () => {
      const existing = await this.readFile()
      if (existing) return existing
      const profile = canonicalProfile(defaultForPolicy(this.policy), this.policy, { defaultId: false })
      const profiles = new Map([[profile.id, profile]])
      await replaceFile(this.file, newDocument(profiles))
      return profiles
    })
  }

  async initialize() {
    if (!this.initialized) this.initialized = this.loadOrInitialize()
    try {
      await this.initialized
      return this
    } catch (error) {
      this.initialized = null
      throw error
    }
  }

  async find(id, options = {}) {
    await this.initialize()
    if (typeof id !== 'string' || !id.trim()) fail('NOT_FOUND', 'id', 'must be a non-empty profile id')
    const profiles = await this.readFile()
    const profile = profiles.get(id.trim())
    if (!profile) throw storeError('PROFILE_NOT_FOUND', `unknown agent profile ${id.trim()}`)
    assertActorCanRead(options.actor, profile)
    return profile
  }

  async get(id, options = {}) {
    return plainSnapshot(await this.find(id, options))
  }

  async getProfile(id, options = {}) {
    return this.get(id, options)
  }

  async getDefault(options = {}) {
    return this.get(DEFAULT_ASSISTANT_ID, options)
  }

  async getDefaultAssistant(options = {}) {
    return this.getDefault(options)
  }

  async getEnabled(id, options = {}) {
    const profile = await this.find(id, options)
    if (!profile.enabled) throw storeError('PROFILE_DISABLED', `agent profile ${profile.id} is disabled`)
    return plainSnapshot(profile)
  }

  async requireEnabled(id, options = {}) {
    return this.getEnabled(id, options)
  }

  async create(input = {}, options = {}) {
    requireWritableActor(options?.actor)
    const profile = canonicalProfile(input, this.policy)
    profile.revision = 1
    if (profile.role === 'assistant') {
      throw storeError('ASSISTANT_EXISTS', 'the global assistant already exists; additional assistant profiles cannot be created')
    }
    return this.withLock(async () => {
      let profiles = await this.readFile()
      if (!profiles) {
        // initialize() uses this same lock, so create a missing collection here.
        const initial = canonicalProfile(defaultForPolicy(this.policy), this.policy, { defaultId: false })
        profiles = new Map([[initial.id, initial]])
      }
      if (profiles.has(profile.id)) throw storeError('PROFILE_EXISTS', `agent profile ${profile.id} already exists`)
      if (profiles.size >= this.maxProfiles) throw storeError('CAPACITY_EXCEEDED', `agent profile capacity ${this.maxProfiles} has been reached`)
      profiles.set(profile.id, profile)
      await replaceFile(this.file, newDocument(profiles))
      return plainSnapshot(profile)
    })
  }

  async createProfile(input = {}, options = {}) {
    return this.create(input, options)
  }

  async update(id, patch = {}, options = {}, numericRevision) {
    requireWritableActor(options?.actor)
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) fail('INVALID_PROFILE', 'patch', 'must be an object')
    for (const key of Reflect.ownKeys(patch)) {
      if (typeof key !== 'string' || !FIELD_SET.has(key)) fail('INVALID_PROFILE', `patch.${String(key)}`, 'is not a known profile field')
    }
    const settings = parseOptions(options, numericRevision)
    requireWritableActor(settings.actor)
    const revision = expectedRevision(settings.expectedRevision)
    if (Object.hasOwn(patch, 'revision') && patch.revision === undefined) fail('INVALID_PROFILE', 'expectedRevision', 'must be a positive safe integer')
    if (Object.hasOwn(patch, 'revision') && revision === undefined) {
      // Accept the returned snapshot as a patch for optimistic clients.
      return this.update(id, patch, { ...settings, expectedRevision: patch.revision })
    }
    const requested = expectedRevision(patch.revision)
    if (requested !== undefined && revision !== undefined && requested !== revision) {
      fail('INVALID_PROFILE', 'revision', 'does not match expectedRevision')
    }
    const wantedRevision = revision ?? requested
    return this.withLock(async () => {
      let profiles = await this.readFile()
      if (!profiles) {
        const initial = canonicalProfile(defaultForPolicy(this.policy), this.policy, { defaultId: false })
        profiles = new Map([[initial.id, initial]])
      }
      const current = profiles.get(id)
      if (!current) throw storeError('PROFILE_NOT_FOUND', `unknown agent profile ${id}`)
      checkRevision(current, wantedRevision)
      if (Object.hasOwn(patch, 'id') && patch.id !== current.id) fail('IMMUTABLE_FIELD', 'id', 'cannot be changed')
      if (Object.hasOwn(patch, 'role') && patch.role !== current.role) fail('IMMUTABLE_FIELD', 'role', 'cannot be changed; create a separate execution profile')
      if (current.id === DEFAULT_ASSISTANT_ID) {
        if (Object.hasOwn(patch, 'workspaceScope') && patch.workspaceScope !== undefined && patch.workspaceScope !== 'global') {
          fail('DEFAULT_PROFILE_IMMUTABLE', 'workspaceScope', 'the default assistant must keep the global workspace scope')
        }
        if (Object.hasOwn(patch, 'memoryScope') && patch.memoryScope !== undefined && patch.memoryScope !== 'global') {
          fail('DEFAULT_PROFILE_IMMUTABLE', 'memoryScope', 'the default assistant must keep global memory')
        }
      }
      const draft = { ...plainSnapshot(current) }
      for (const key of FIELDS) {
        if (key !== 'revision' && Object.hasOwn(patch, key)) draft[key] = patch[key]
      }
      const next = canonicalProfile(draft, this.policy, { defaultId: false })
      next.revision = current.revision + 1
      if (!Number.isSafeInteger(next.revision)) fail('REVISION_LIMIT', 'revision', 'cannot be incremented safely')
      profiles.set(id, next)
      await replaceFile(this.file, newDocument(profiles))
      return plainSnapshot(next)
    })
  }

  async updateProfile(id, patch = {}, options = {}, numericRevision) {
    return this.update(id, patch, options, numericRevision)
  }

  async remove(id, options = {}, numericRevision) {
    requireWritableActor(options?.actor)
    const settings = parseOptions(options, numericRevision)
    requireWritableActor(settings.actor)
    if (id === DEFAULT_ASSISTANT_ID) fail('DEFAULT_PROFILE_IMMUTABLE', 'id', 'the default global assistant cannot be deleted; disable it instead')
    return this.withLock(async () => {
      let profiles = await this.readFile()
      if (!profiles) {
        const initial = canonicalProfile(defaultForPolicy(this.policy), this.policy, { defaultId: false })
        profiles = new Map([[initial.id, initial]])
        await replaceFile(this.file, newDocument(profiles))
      }
      const current = profiles.get(id)
      if (!current) throw storeError('PROFILE_NOT_FOUND', `unknown agent profile ${id}`)
      checkRevision(current, settings.expectedRevision)
      profiles.delete(id)
      await replaceFile(this.file, newDocument(profiles))
      return plainSnapshot(current)
    })
  }

  async deleteProfile(id, options = {}, numericRevision) {
    return this.remove(id, options, numericRevision)
  }

  async list(filter = {}, options = {}) {
    if (!isPlainObject(filter)) fail('INVALID_PROFILE', 'filter', 'must be an object')
    const settings = { ...options, ...filter }
    await this.initialize()
    const profiles = await this.readFile()
    const descriptor = actorDescriptor(settings.actor)
    const includeDisabled = settings.includeDisabled === true
    if (typeof includeDisabled !== 'boolean') fail('INVALID_PROFILE', 'includeDisabled', 'must be a boolean')
    let result = [...profiles.values()].filter(profile => {
      if (!actorCanRead(descriptor, profile)) return false
      if (!includeDisabled && !profile.enabled) return false
      if (settings.role !== undefined && profile.role !== settings.role) return false
      if (settings.enabled !== undefined && profile.enabled !== settings.enabled) return false
      if (settings.memoryScope !== undefined && profile.memoryScope !== settings.memoryScope) return false
      if (settings.workspaceScope !== undefined && profile.workspaceScope !== settings.workspaceScope) return false
      return true
    })
    result.sort((left, right) => left.id.localeCompare(right.id))
    return result.map(plainSnapshot)
  }

  /** UI project-assistant feed: execution roles are intentionally excluded. */
  async listAssistants(options = {}) {
    return this.list({ ...options, role: 'assistant' }, options)
  }

  async listProjectAssistants(options = {}) {
    return this.list({ ...options, role: 'assistant', workspaceScope: 'project' }, options)
  }

  async listExecutors(options = {}) {
    await this.initialize()
    const profiles = await this.readFile()
    const descriptor = actorDescriptor(options?.actor)
    return [...profiles.values()]
      .filter(profile => EXECUTION_ROLE_SET.has(profile.role)
        && (options?.includeDisabled === true || profile.enabled)
        && actorCanRead(descriptor, profile))
      .map(plainSnapshot)
  }

  async snapshot(id, options = {}) {
    const settings = typeof options === 'boolean' ? { includeDisabled: options } : options
    const profile = settings.includeDisabled ? await this.get(id, settings) : await this.getEnabled(id, settings)
    return redactAgentProfile(profile)
  }

  async setEnabled(id, enabled, options = {}) {
    if (typeof enabled !== 'boolean') fail('INVALID_PROFILE', 'enabled', 'must be a boolean')
    return this.update(id, { enabled }, options)
  }

  async disable(id, options = {}) {
    return this.setEnabled(id, false, options)
  }

  async enable(id, options = {}) {
    return this.setEnabled(id, true, options)
  }

  async readDetailed(options = {}) {
    await this.initialize()
    const profiles = await this.readFile()
    const descriptor = actorDescriptor(options?.actor)
    return {
      file: this.file,
      version: 1,
      count: profiles.size,
      capacity: this.maxProfiles,
      profiles: [...profiles.values()]
        .filter(profile => actorCanRead(descriptor, profile))
        .map(plainSnapshot),
    }
  }
}

/** Create a lazy store; initialize() or the first operation creates the default. */
export function createAgentProfileStore(options = {}) {
  return new AgentProfileStore(options)
}

export const openAgentProfileStore = createAgentProfileStore

/** Convenience for startup code that wants initialization errors immediately. */
export async function initializeAgentProfiles(options = {}) {
  const store = createAgentProfileStore(options)
  await store.initialize()
  return store
}

export default {
  DEFAULT_ASSISTANT_ID,
  AGENT_ROLES,
  EXECUTION_ROLES,
  MEMORY_SCOPES,
  WORKSPACE_SCOPES,
  DEFAULT_TOOL_WHITELIST,
  DEFAULT_PERMISSION_WHITELIST,
  DEFAULT_AGENT_PROFILE,
  AgentProfileError,
  AgentProfileConflictError,
  AgentProfile,
  AgentProfileStore,
  validateAgentProfile,
  normalizeAgentProfile,
  redactAgentProfile,
  createAgentProfileStore,
  openAgentProfileStore,
  initializeAgentProfiles,
}
