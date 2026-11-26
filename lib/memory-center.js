/**
 * Read/write facade over the four memory owners.
 *
 * The facade never opens, parses, or names storage files. Adapters return records
 * and perform mutations; this module only projects an allow-listed descriptor,
 * applies scope/search rules, and serialises optimistic writes to the same id.
 *
 * Adapter contract:
 *   memory.list({ limit })                  -> { entries } | entry[]
 *   userMemory.list({ category, limit })     -> { entries } | entry[]
 *   router.snapshot()                        -> { revision, facts } | fact[]
 *   longGoal.list()                         -> goal[] | { goals }
 *
 * A writable adapter exposes update({ id, type, expectedRevision, patch,
 * descriptor, ...locator }). userMemory may instead expose record(), and memory
 * may instead expose set(), for corrections. The notebook persists `revision`
 * on each journal row and checks it under its scope lock; set() and forget()
 * both accept expectedRevision. forget({ id, type, expectedRevision, ...locator })
 * performs the owner's native deletion semantics. Adapter errors must use a code
 * such as REVISION_CONFLICT; their messages and payloads are deliberately not
 * forwarded to callers.
 *
 * @module dsh-superagent/memory-center
 */
import { createHash } from 'node:crypto'

export const MEMORY_CENTER_TYPES = Object.freeze([
  'project-rule',
  'user-fact',
  'user-preference',
  'user-decision',
  'run-note',
  'work-decision',
  'evidence',
  'source',
  'alias',
  'goal-decision',
])

export const MEMORY_CENTER_SOURCES = Object.freeze([
  'project-rules', 'user-memory', 'memory', 'router', 'long-goal',
])

const TYPE_SOURCE = Object.freeze({
  'project-rule': 'long-goal',
  'user-fact': 'user-memory',
  'user-preference': 'user-memory',
  'user-decision': 'user-memory',
  'run-note': 'memory',
  'work-decision': 'router',
  evidence: 'router',
  source: 'router',
  alias: 'router',
  'goal-decision': 'long-goal',
})

const BASE_WRITABLE = new Set(['user-fact', 'user-preference', 'user-decision', 'run-note', 'work-decision'])
const BASE_FORGETTABLE = new Set(['user-fact', 'user-preference', 'user-decision', 'run-note', 'work-decision'])
const DECISION_TYPES = new Set(['user-decision', 'work-decision'])
const USER_CATEGORIES = Object.freeze(['fact', 'preference', 'decision'])
const EDITABLE_FIELDS = new Set(['title', 'body', 'tags'])
const DESCRIPTOR_FIELDS = Object.freeze([
  'id', 'type', 'title', 'body', 'tags', 'scope', 'project', 'task', 'phase',
  'origin', 'source', 'createdAt', 'updatedAt', 'status', 'editable', 'forgettable', 'revision',
])
const TYPE_ALIASES = Object.freeze({
  fact: 'user-fact', preference: 'user-preference', decision: 'work-decision',
  note: 'run-note', memory: 'run-note', 'user-memory-decision': 'user-decision',
  'context-decision': 'work-decision',
})
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|root|tmp|var|opt|workspace|workspaces|mnt|private|etc|usr|bin|srv)\/)[^\s,;]*/gi
const POSIX_PATH = /(^|[\s("'`=])((?:\/(?!\/)[^\s"'`<>,;]+)+)/g
const FILE_URL = /file:\/\/[^\s]+/gi

const ERROR_STATUS = Object.freeze({
  INVALID_QUERY: 400, INVALID_UPDATE: 400, INVALID_REVISION: 400,
  NOT_FOUND: 404, READ_ONLY: 403, FORBIDDEN: 403, REVISION_CONFLICT: 409, SOURCE_UNAVAILABLE: 503,
})

export class MemoryCenterError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MemoryCenterError'
    this.code = code
    this.status = ERROR_STATUS[code] ?? 500
    this.statusCode = this.status
  }
}

const fail = (code, message) => { throw new MemoryCenterError(code, message) }
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const method = (adapter, name) => typeof adapter?.[name] === 'function' ? adapter[name].bind(adapter) : null

function publicText(value, limit = 2000) {
  if (typeof value !== 'string') return ''
  const clean = value
    .replace(FILE_URL, '[redacted-path]')
    .replace(ABSOLUTE_PATH, '[redacted-path]')
    .replace(POSIX_PATH, '$1[redacted-path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return [...clean].slice(0, limit).join('')
}

function publicName(value, limit = 160) {
  return publicText(value, limit)
}

function publicTags(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(values.map(tag => publicName(tag, 80).toLowerCase()).filter(Boolean))].slice(0, 32)
}

function dateText(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'number') {
    const at = new Date(value)
    return Number.isFinite(at.getTime()) ? at.toISOString() : null
  }
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

function revisionOf(record, fallback = 1) {
  const value = record?.revision ?? record?.rev
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function entriesOf(payload, keys = ['entries', 'items', 'records', 'facts', 'goals']) {
  if (Array.isArray(payload)) return payload
  if (!isObject(payload)) return []
  for (const key of keys) if (Array.isArray(payload[key])) return payload[key]
  return []
}

function descriptorId(type, parts) {
  const digest = createHash('sha256').update(JSON.stringify([type, ...parts.map(String)])).digest('hex').slice(0, 24)
  return `mc_${type.replaceAll('-', '_')}_${digest}`
}

/** Resolve correction/tombstone rows when an adapter returns its raw journal. */
function effectiveRecords(records, keyOf) {
  const current = new Map()
  records.forEach((record, index) => {
    const key = keyOf(record)
    const prior = current.get(key)
    if (!prior) { current.set(key, { record, index }); return }
    const at = Date.parse(record.updatedAt ?? record.ts ?? record.createdAt ?? '') || 0
    const priorAt = Date.parse(prior.record.updatedAt ?? prior.record.ts ?? prior.record.createdAt ?? '') || 0
    const revision = revisionOf(record, -1)
    const priorRevision = revisionOf(prior.record, -1)
    if (at > priorAt || at === priorAt && (revision > priorRevision || revision === priorRevision && index > prior.index)) {
      current.set(key, { record, index })
    }
  })
  return [...current.values()].map(({ record }) => record)
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value.trim()) ?? ''
}

function originOf(type, record) {
  const explicit = firstString(record.origin, record.originKind).toLowerCase()
  if (['user', 'run', 'external', 'system'].includes(explicit)) return explicit
  if (type === 'project-rule') return 'user'
  if (type === 'goal-decision') return record.answer || record.answeredAt ? 'user' : 'system'
  if (type === 'evidence' || type === 'source') return record.origin === 'external' ? 'external' : 'run'
  if (type === 'work-decision' || type === 'alias') return record.source === 'external' ? 'external' : 'run'
  return 'run'
}

function statusOf(type, record) {
  const status = firstString(record.status, record.state).toLowerCase()
  if (type === 'goal-decision') {
    if (record.retiredAt) return 'retired'
    return record.answer || record.answeredAt ? 'answered' : 'pending'
  }
  if (record.revoked === true || record.deleted === true) return type === 'run-note' ? 'retracted' : 'revoked'
  if (status === 'retracted') return 'retracted'
  if (['revoked', 'retired', 'deleted', 'pending', 'answered'].includes(status)) return status
  return 'active'
}

function bodyOf(type, record) {
  if (typeof record.body === 'string') return record.body
  if (type === 'user-decision') {
    return [record.choice && `choice: ${record.choice}`, record.rejected && `rejected: ${record.rejected}`,
      record.reason && `reason: ${record.reason}`, record.rollback && `rollback: ${record.rollback}`]
      .filter(Boolean).join('; ')
  }
  if (type === 'goal-decision') {
    return [record.question, record.answerText && `answer: ${record.answerText}`, record.answer && `choice: ${record.answer}`,
      record.reason && `reason: ${record.reason}`].filter(Boolean).join('; ')
  }
  return firstString(record.text, record.value, record.rule, record.content)
}

function titleOf(type, record) {
  return firstString(record.title, record.subject, record.choice, record.question, record.summary, record.key,
    type === 'project-rule' ? 'Project rule' : type)
}

function timestampPair(record) {
  const created = dateText(record.createdAt ?? record.ts ?? record.confirmedAt ?? record.observedAt ?? record.validFrom ?? record.answeredAt)
  const updated = dateText(record.updatedAt ?? record.answeredAt ?? record.retiredAt ?? record.ts ?? record.confirmedAt ?? record.observedAt ?? record.validFrom)
  return { createdAt: created, updatedAt: updated ?? created }
}

function projectOf(record, parent = null) {
  return publicName(record.project ?? record.projectId ?? parent?.project ?? parent?.projectId)
}

function scopeOf(type, record) {
  if (type === 'project-rule') return 'project'
  if (type.startsWith('user-')) return 'user'
  if (type === 'run-note') return publicName(record.scope, 40) || 'default'
  if (type === 'goal-decision') return 'goal'
  return record.phaseId || record.phase ? 'phase' : 'task'
}

function canWrite(source, type) {
  if (!BASE_WRITABLE.has(type) || !source.readable) return { update: false, forget: false }
  const adapter = source.adapter
  const update = Boolean(method(adapter, 'update')
    || (source.name === 'user-memory' && ['user-fact', 'user-preference'].includes(type) && method(adapter, 'record'))
    || (source.name === 'memory' && type === 'run-note' && method(adapter, 'set')))
  const forget = BASE_FORGETTABLE.has(type) && Boolean(method(adapter, 'forget')
    || (type === 'work-decision' && method(adapter, 'update')))
  return { update, forget }
}

function makeDescriptor(type, record, meta, source, revision) {
  const writable = canWrite(source, type)
  const project = projectOf(record, meta.parent)
  const task = publicName(record.taskId ?? record.task ?? meta.parent?.taskId)
  const phase = publicName(record.phaseId ?? record.phase)
  const origin = originOf(type, record)
  // A type being writable is not enough for a decision: its user provenance and
  // complete execution scope are part of the capability advertised to clients.
  const authorised = !DECISION_TYPES.has(type) || Boolean(origin === 'user' && project && task && phase)
  const status = statusOf(type, record)
  const withdrawn = ['retracted', 'revoked', 'retired', 'deleted'].includes(status)
  return {
    id: meta.id,
    type,
    title: publicText(withdrawn ? firstString(record.key, record.id, 'Withdrawn memory') : titleOf(type, record), 300),
    body: withdrawn ? '' : publicText(bodyOf(type, record)),
    tags: publicTags(record.tags),
    scope: scopeOf(type, record),
    project,
    task,
    phase,
    origin,
    source: publicName(record.source ?? record.sourceId ?? source.name, 120),
    ...timestampPair(record),
    status,
    editable: writable.update && authorised,
    forgettable: writable.forget && authorised,
    revision,
  }
}

function normalizeQuery(options = {}) {
  const input = isObject(options) ? options : {}
  const rawTypes = input.type ?? input.types
  const types = (Array.isArray(rawTypes) ? rawTypes : rawTypes === undefined ? [] : [rawTypes])
    .map(value => TYPE_ALIASES[value] ?? value)
  if (types.some(type => !MEMORY_CENTER_TYPES.includes(type))) fail('INVALID_QUERY', 'Unknown memory type')
  const page = input.page === undefined ? 1 : Number(input.page)
  const pageSize = input.pageSize === undefined ? 50 : Number(input.pageSize)
  if (!Number.isSafeInteger(page) || page < 1) fail('INVALID_QUERY', 'page must be a positive integer')
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) fail('INVALID_QUERY', 'pageSize must be a positive integer')
  const rawStatus = input.status ?? input.statuses
  const statuses = (Array.isArray(rawStatus) ? rawStatus : rawStatus === undefined ? [] : [rawStatus]).map(String)
  return {
    id: typeof input.id === 'string' ? input.id : '',
    types, statuses,
    search: typeof (input.search ?? input.query) === 'string' ? (input.search ?? input.query).toLowerCase().trim() : '',
    tags: publicTags(input.tags),
    project: publicName(input.project).toLowerCase(),
    task: publicName(input.task ?? input.taskId).toLowerCase(),
    phase: publicName(input.phase ?? input.phaseId).toLowerCase(),
    scope: publicName(input.scope).toLowerCase(),
    origin: publicName(input.origin).toLowerCase(),
    source: publicName(input.source).toLowerCase(),
    editable: input.editable,
    forgettable: input.forgettable,
    includeRetracted: input.includeRetracted === true || statuses.some(status => ['retracted', 'revoked', 'retired', 'deleted'].includes(status)),
    page,
    pageSize: Math.min(pageSize, 500),
  }
}

function matches(entry, query) {
  if (query.id && entry.id !== query.id) return false
  if (query.types.length && !query.types.includes(entry.type)) return false
  if (!query.includeRetracted && ['retracted', 'revoked', 'retired', 'deleted'].includes(entry.status)) return false
  if (query.statuses.length && !query.statuses.includes(entry.status)) return false
  if (query.tags.length && !query.tags.every(tag => entry.tags.includes(tag))) return false
  for (const field of ['project', 'task', 'phase', 'scope', 'origin', 'source']) {
    if (query[field] && String(entry[field] ?? '').toLowerCase() !== query[field]) return false
  }
  if (query.editable !== undefined && entry.editable !== Boolean(query.editable)) return false
  if (query.forgettable !== undefined && entry.forgettable !== Boolean(query.forgettable)) return false
  if (query.search) {
    const haystack = [entry.title, entry.body, entry.project, entry.task, entry.phase, entry.source, ...entry.tags]
      .join('\n').toLowerCase()
    if (!query.search.split(/\s+/).filter(Boolean).every(term => haystack.includes(term))) return false
  }
  return true
}

function paginate(entries, query) {
  const pages = Math.max(1, Math.ceil(entries.length / query.pageSize))
  const offset = (query.page - 1) * query.pageSize
  return {
    total: entries.length,
    page: query.page,
    pageSize: query.pageSize,
    pageCount: pages,
    hasMore: query.page < pages,
    entries: entries.slice(offset, offset + query.pageSize),
  }
}

function facetsOf(entries) {
  const count = field => Object.fromEntries([...new Set(entries.map(entry => entry[field]))]
    .sort().map(value => [value, entries.filter(entry => entry[field] === value).length]))
  return { types: count('type'), sources: count('source'), statuses: count('status') }
}

function cloneDescriptor(entry) {
  return Object.fromEntries(DESCRIPTOR_FIELDS.map(field => [field, field === 'tags' ? [...entry.tags] : entry[field]]))
}

function adapterError(error) {
  const code = String(error?.code ?? '').toUpperCase()
  if (['REVISION_CONFLICT', 'REVISION_MISMATCH', 'EXPECTED_REVISION_MISMATCH', 'CONFLICT'].includes(code)
    || error?.status === 409 || error?.conflict === true
    || error?.expectedRevision !== undefined && error?.currentRevision !== undefined) {
    return new MemoryCenterError('REVISION_CONFLICT', 'Memory changed; refresh and retry with the current expectedRevision')
  }
  if (['FORBIDDEN', 'READ_ONLY', 'NOT_WRITABLE'].includes(code)) {
    return new MemoryCenterError('READ_ONLY', 'This memory is read-only')
  }
  if (['NOT_FOUND', 'UNKNOWN_RECORD'].includes(code)) return new MemoryCenterError('NOT_FOUND', 'Memory record was not found')
  return new MemoryCenterError('SOURCE_UNAVAILABLE', 'Memory adapter is unavailable')
}

/**
 * @param {object} [options]
 * @param {object} [options.memory] cross-run notebook adapter
 * @param {object} [options.userMemory] user profile adapter
 * @param {object} [options.router] work-context adapter
 * @param {object} [options.longGoal] long-goal adapter
 * @param {boolean|object} [options.enabled] global or per-source feature switch
 */
export function createMemoryCenter({ memory = null, userMemory = null, router = null, longGoal = null,
  enabled = true } = {}) {
  const adapters = { 'user-memory': userMemory, memory, router, 'long-goal': longGoal }
  const revisions = new Map()
  const mutationTails = new Map()

  function sourceEnabled(name) {
    if (enabled === false) return false
    return !isObject(enabled) || enabled[name] !== false
  }

  function hasReader(adapter) {
    return Boolean(method(adapter, 'list') || method(adapter, 'snapshot') || method(adapter, 'read'))
  }

  function sourcesStatus() {
    const sources = {}
    for (const name of MEMORY_CENTER_SOURCES) {
      const adapter = adapters[name === 'project-rules' ? 'long-goal' : name]
      const readable = sourceEnabled(name) && hasReader(adapter)
      sources[name] = readable
        ? { status: 'ready', enabled: true, readable: true, adapter, name }
        : { status: 'disabled', enabled: false, readable: false, adapter, name, reason: sourceEnabled(name) ? 'adapter unavailable' : 'disabled' }
    }
    return sources
  }

  async function listUser(source) {
    const list = method(source.adapter, 'list')
    const entries = []
    for (const category of USER_CATEGORIES) {
      const payload = await list({ category, limit: 10000 })
      const categoryRecords = effectiveRecords(entriesOf(payload).filter(record => isObject(record)
        && USER_CATEGORIES.includes(firstString(record.category, category))), record => record.key ?? record.id)
      for (const record of categoryRecords) {
        const actualCategory = firstString(record.category, category)
        const type = `user-${actualCategory}`
        entries.push({ type, record,
          meta: { id: descriptorId(type, [actualCategory, record.key ?? record.id]), key: record.key ?? record.id,
            category: actualCategory, recordId: record.id ?? record.key } })
      }
    }
    return entries
  }

  async function listMemory(source) {
    const list = method(source.adapter, 'list')
    const read = method(source.adapter, 'read')
    const payload = list ? await list({ limit: 10000 }) : await read({ scope: 'default' })
    const records = effectiveRecords(entriesOf(payload).filter(isObject),
      record => JSON.stringify([record.scope ?? 'default', record.key ?? record.id]))
    return records.map(record => ({
      type: 'run-note', record,
      meta: { id: descriptorId('run-note', [record.scope ?? 'default', record.key ?? record.id]),
        key: record.key ?? record.id, scope: record.scope ?? 'default', kind: record.kind, recordId: record.id ?? record.key },
    }))
  }

  async function listRouter(source) {
    const snapshot = method(source.adapter, 'snapshot')
    const list = method(source.adapter, 'list')
    const payload = snapshot ? await snapshot() : await list({ limit: 10000 })
    const records = Array.isArray(payload) ? payload : isObject(payload) && Array.isArray(payload.facts) ? payload.facts : []
    const fallbackRevision = isObject(payload) ? revisionOf(payload, 0) : 0
    return records.filter(isObject).map(record => {
      const type = record.kind === 'decision' ? 'work-decision'
        : ['evidence', 'source', 'alias'].includes(record.kind) ? record.kind : null
      if (!type) return null
      return { type, record, fallbackRevision,
        meta: { id: descriptorId(type, [record.id ?? record.taskId, record.kind, record.key, record.phaseId]),
          recordId: record.id, key: record.key, kind: record.kind } }
    }).filter(Boolean)
  }

  async function listGoals(source) {
    const payload = await method(source.adapter, 'list')()
    const goals = entriesOf(payload, ['goals', 'items', 'entries']).filter(isObject)
    const entries = []
    for (const goal of goals) {
      const rules = Array.isArray(goal.projectRules) ? goal.projectRules : []
      rules.forEach((rule, index) => {
        const record = isObject(rule) ? { project: goal.project, ...rule }
          : { project: goal.project, body: rule, title: `Project rule ${index + 1}` }
        entries.push({ type: 'project-rule', record, parent: goal,
          meta: { id: descriptorId('project-rule', [goal.id, record.id ?? index]), recordId: record.id, index } })
      })
      for (const decision of (Array.isArray(goal.decisions) ? goal.decisions : []).filter(isObject)) {
        entries.push({ type: 'goal-decision', record: { project: goal.project, ...decision }, parent: goal,
          meta: { id: descriptorId('goal-decision', [goal.id, decision.id]), recordId: decision.id, goalId: goal.id } })
      }
    }
    return entries
  }

  async function collect() {
    const statuses = sourcesStatus()
    const readSource = async (name, read) => {
      const source = statuses[name]
      if (!source.readable) return []
      try { return await read(source) }
      catch { source.status = 'error'; source.reason = 'adapter unavailable'; return [] }
    }
    const goalReader = statuses['project-rules'].readable ? 'project-rules'
      : statuses['long-goal'].readable ? 'long-goal' : 'project-rules'
    const [goals, userEntries, memoryEntries, routerEntries] = await Promise.all([
      readSource(goalReader, listGoals),
      readSource('user-memory', listUser),
      readSource('memory', listMemory),
      readSource('router', listRouter),
    ])
    // Both long-goal projections come from one read, so rules and decisions in
    // a snapshot always describe the same adapter revision.
    if (statuses['project-rules'].readable && statuses['long-goal'].readable) {
      statuses['long-goal'].status = statuses['project-rules'].status
      statuses['long-goal'].reason = statuses['project-rules'].reason
    }
    const groups = [goals.filter(item => item.type === 'project-rule'), userEntries, memoryEntries, routerEntries,
      goals.filter(item => item.type === 'goal-decision')]
    const entries = groups.flat().map(item => {
      // Run-note tokens come only from the notebook's durable journal rows. The
      // local fallback remains for other owners whose adapters do not expose a
      // record revision.
      const fallbackRevision = TYPE_SOURCE[item.type] === 'memory'
        ? item.fallbackRevision ?? 1
        : revisions.get(item.meta.id) ?? item.fallbackRevision ?? 1
      const descriptor = makeDescriptor(item.type, item.record, item.meta, statuses[TYPE_SOURCE[item.type]],
        revisionOf(item.record, fallbackRevision))
      Object.defineProperty(descriptor, '_item', { value: item, enumerable: false })
      return descriptor
    })
    entries.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
      || String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || left.id.localeCompare(right.id))
    return { entries, statuses }
  }

  function publicSources(statuses) {
    return Object.fromEntries(Object.entries(statuses).map(([name, source]) => [name,
      { status: source.status, enabled: source.enabled, readable: source.readable, ...(source.reason ? { reason: source.reason } : {}) }]))
  }

  async function snapshot(options = {}) {
    const query = normalizeQuery(options)
    const { entries, statuses } = await collect()
    const filtered = entries.filter(entry => matches(entry, query))
    const ready = Object.values(statuses).some(source => source.readable)
    return {
      enabled: ready,
      disabled: !ready,
      ...(ready ? {} : { reason: enabled === false ? 'disabled' : 'no memory adapter is available' }),
      sources: publicSources(statuses),
      ...paginate(filtered.map(cloneDescriptor), query),
      facets: facetsOf(filtered),
    }
  }

  function assertWritable(entry) {
    if (!entry.editable) fail('READ_ONLY', 'This memory type is read-only')
    if (DECISION_TYPES.has(entry.type)) {
      if (entry.origin !== 'user' || !entry.project || !entry.task || !entry.phase) {
        fail('FORBIDDEN', 'A user decision requires origin=user and explicit project, task, and phase')
      }
    }
  }

  function parseUpdate(input, patch, options) {
    let id
    let changes
    let expectedRevision
    if (typeof input === 'string') {
      id = input
      expectedRevision = options?.expectedRevision ?? (isObject(patch) ? patch.expectedRevision : undefined)
      changes = isObject(patch) && own(patch, 'expectedRevision')
        ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'expectedRevision')) : patch
    } else {
      if (!isObject(input)) fail('INVALID_UPDATE', 'update requires a descriptor id or object')
      id = input.id
      if (own(input, 'patch') || own(input, 'changes')) changes = input.patch ?? input.changes
      else changes = Object.fromEntries(Object.entries(input).filter(([key]) => EDITABLE_FIELDS.has(key)))
      expectedRevision = input.expectedRevision
    }
    if (typeof id !== 'string' || !id) fail('NOT_FOUND', 'Memory record was not found')
    if (!isObject(changes) || Object.keys(changes).some(key => !EDITABLE_FIELDS.has(key)) || Object.keys(changes).length === 0) {
      fail('INVALID_UPDATE', 'update accepts only title, body, and tags')
    }
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      fail('INVALID_REVISION', 'expectedRevision must be a non-negative integer')
    }
    const normalized = {}
    if (own(changes, 'title')) normalized.title = publicText(changes.title, 300)
    if (own(changes, 'body')) normalized.body = publicText(changes.body)
    if (own(changes, 'tags')) normalized.tags = publicTags(changes.tags)
    if (own(normalized, 'body') && !normalized.body) fail('INVALID_UPDATE', 'body must be a non-empty string')
    return { id, patch: normalized, expectedRevision }
  }

  function parseForget(input, options) {
    const value = typeof input === 'string' ? { id: input, ...(isObject(options) ? options : {}) } : input
    if (!isObject(value) || typeof value.id !== 'string' || !value.id) fail('NOT_FOUND', 'Memory record was not found')
    if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) {
      fail('INVALID_REVISION', 'expectedRevision must be a non-negative integer')
    }
    return { id: value.id, expectedRevision: value.expectedRevision }
  }

  function checkRevision(entry, expectedRevision) {
    if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
      fail('REVISION_CONFLICT', 'Memory changed; refresh and retry with the current expectedRevision')
    }
  }

  function locator(entry) {
    const item = entry._item
    return {
      id: entry.id, type: entry.type, source: TYPE_SOURCE[entry.type],
      recordId: item.meta.recordId, key: item.meta.key, category: item.meta.category,
      scope: item.meta.scope ?? entry.scope, kind: item.meta.kind,
      project: entry.project, task: entry.task, phase: entry.phase,
    }
  }

  function revisionResult(entry, result) {
    const returnedRevision = result?.entry?.revision ?? result?.descriptor?.revision ?? result?.revision
    const revision = Number.isSafeInteger(returnedRevision) && returnedRevision >= 0 ? returnedRevision : entry.revision + 1
    if (TYPE_SOURCE[entry.type] !== 'memory') revisions.set(entry.id, revision)
    return revision
  }

  async function writeUpdate(entry, patch, expectedRevision) {
    const source = adapters[TYPE_SOURCE[entry.type]]
    const item = entry._item
    const update = method(source, 'update')
    let result
    if (!update && own(patch, 'title')) {
      fail('INVALID_UPDATE', 'Changing title requires an adapter with update support')
    }
    if (update) {
      result = await update({ ...locator(entry), expectedRevision, patch, descriptor: cloneDescriptor(entry) })
    } else if (TYPE_SOURCE[entry.type] === 'user-memory') {
      result = await method(source, 'record')({ category: item.meta.category, runId: null,
        entry: { key: item.meta.key, text: patch.body ?? entry.body, tags: patch.tags ?? entry.tags } })
    } else if (entry.type === 'run-note') {
      result = await method(source, 'set')({ scope: item.meta.scope ?? entry.scope, key: item.meta.key,
        kind: item.meta.kind ?? 'note', text: patch.body ?? entry.body,
        tags: patch.tags ?? entry.tags, expectedRevision })
    } else fail('READ_ONLY', 'This memory adapter cannot update this type')
    if (result === false || result?.ok === false) fail('SOURCE_UNAVAILABLE', 'Memory adapter rejected the update')
    return revisionResult(entry, result)
  }

  async function writeForget(entry, expectedRevision) {
    const source = adapters[TYPE_SOURCE[entry.type]]
    const forget = method(source, 'forget')
    let result
    if (forget) result = await forget({ ...locator(entry), expectedRevision, descriptor: cloneDescriptor(entry) })
    else if (entry.type === 'work-decision') {
      result = await method(source, 'update')({ ...locator(entry), expectedRevision, operation: 'forget',
        patch: { revoked: true, status: 'revoked' }, descriptor: cloneDescriptor(entry) })
    } else fail('READ_ONLY', 'This memory adapter cannot forget this type')
    if (result === false || result?.ok === false) fail('SOURCE_UNAVAILABLE', 'Memory adapter rejected the deletion')
    return revisionResult(entry, result)
  }

  function serialise(id, task) {
    const previous = mutationTails.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    mutationTails.set(id, next)
    return next.finally(() => { if (mutationTails.get(id) === next) mutationTails.delete(id) })
  }

  async function update(input, patch, options) {
    const request = parseUpdate(input, patch, options)
    return serialise(request.id, async () => {
      const entry = (await collect()).entries.find(candidate => candidate.id === request.id)
      if (!entry) fail('NOT_FOUND', 'Memory record was not found')
      assertWritable(entry)
      checkRevision(entry, request.expectedRevision)
      try { await writeUpdate(entry, request.patch, request.expectedRevision) }
      catch (error) {
        if (error instanceof MemoryCenterError) throw error
        throw adapterError(error)
      }
      const fresh = (await collect()).entries.find(candidate => candidate.id === request.id)
      if (!fresh) fail('NOT_FOUND', 'Memory record disappeared after the update')
      if (fresh.revision === entry.revision) fail('SOURCE_UNAVAILABLE', 'Memory adapter did not advance the record revision')
      return cloneDescriptor(fresh)
    })
  }

  async function forget(input, options) {
    const request = parseForget(input, options)
    return serialise(request.id, async () => {
      const entry = (await collect()).entries.find(candidate => candidate.id === request.id)
      if (!entry) fail('NOT_FOUND', 'Memory record was not found')
      if (!entry.forgettable) fail('READ_ONLY', 'This memory type is read-only')
      assertWritable(entry)
      checkRevision(entry, request.expectedRevision)
      let revision
      try { revision = await writeForget(entry, request.expectedRevision) }
      catch (error) {
        if (error instanceof MemoryCenterError) throw error
        throw adapterError(error)
      }
      const physical = TYPE_SOURCE[entry.type] === 'user-memory'
      const fresh = (await collect()).entries.find(candidate => candidate.id === request.id)
      if (physical && fresh) fail('SOURCE_UNAVAILABLE', 'Memory adapter did not physically delete the record')
      if (!physical && fresh && !['retracted', 'revoked', 'retired', 'deleted'].includes(fresh.status)) {
        fail('SOURCE_UNAVAILABLE', 'Memory adapter did not withdraw the record')
      }
      return { id: entry.id, type: entry.type, forgotten: true,
        mode: physical ? 'physical' : 'tombstone',
        status: physical ? 'deleted' : entry.type === 'run-note' ? 'retracted' : 'revoked',
        revision,
        ...(physical || !fresh ? {} : { descriptor: cloneDescriptor(fresh) }) }
    })
  }

  return {
    snapshot,
    query: snapshot,
    update,
    forget,
    status: () => {
      const sources = publicSources(sourcesStatus())
      const ready = Object.values(sources).some(source => source.readable)
      return { enabled: ready, disabled: !ready, sources }
    },
    types: [...MEMORY_CENTER_TYPES],
  }
}
