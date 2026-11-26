import { createHash, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { nextCronTime, parseCron, validateTimeZone } from './cron.js'
import { acquireFileLock } from './lock.js'

const STATE_VERSION = 1
const MAX_RULES = 1000
const NOTIFY_EVENTS = new Set(['started', 'completed', 'failed', 'cancelled', 'budget'])
const EXECUTION_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'budget-stopped'])
const TERMINAL_EXECUTION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'budget-stopped'])
const RUN_TO_EXECUTION_STATUS = new Map([
  ['completed', 'completed'],
  ['partial', 'failed'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['interrupted', 'failed'],
  ['stopped', 'failed'],
  ['budget-stopped', 'budget-stopped'],
])
const RUN_TO_NOTIFY_EVENT = new Map([
  ['started', 'started'],
  ['completed', 'completed'],
  ['partial', 'failed'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['interrupted', 'failed'],
  ['stopped', 'failed'],
  ['budget-stopped', 'budget'],
  ['budget', 'budget'],
])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ACTIONS = new Set(['run', 'task', 'followup'])
const TRIGGERS = new Set(['cron', 'every', 'source'])

export const DEFAULT_AUTOMATION_RULE = Object.freeze({
  name: 'Automation rule',
  description: '',
  trigger: Object.freeze({ type: 'cron', cron: '0 9 * * *', timeZone: 'UTC' }),
  action: Object.freeze({ type: 'run', prompt: 'Summarize the current project status.' }),
  output: Object.freeze({ relativePath: 'artifacts/automation.md' }),
  notify: Object.freeze({ events: Object.freeze(['completed', 'failed']) }),
  budget: Object.freeze({ maxRuns: null, maxModelCalls: null, maxTokens: null, maxCost: null }),
  enabled: false,
  revision: 1,
})

export class AutomationRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'AutomationRuleError'
    this.code = code
    Object.assign(this, details)
  }
}

export class AutomationStateError extends Error {
  constructor(code, message, { file, cause } = {}) {
    super(message)
    this.name = 'AutomationStateError'
    this.code = code
    this.file = file
    if (cause) this.cause = cause
  }
}

const clone = value => structuredClone(value)
const has = (value, key) => Object.hasOwn(value, key)

function invalid(message, details) {
  throw new AutomationRuleError('rule-invalid', message, details)
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(`${label} must be a plain object`)
  }
  return value
}

function only(value, allowed, label) {
  object(value, label)
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown) invalid(`${label} contains unknown field "${unknown}"`)
}

function text(value, label, max = 500) {
  if (typeof value !== 'string') invalid(`${label} must be a string`)
  const result = value.trim()
  if (!result) invalid(`${label} is required`)
  if (result.length > max) invalid(`${label} is longer than ${max} characters`)
  return result
}

function optionalText(value, label, max = 500) {
  if (value === undefined || value === null || value === '') return ''
  return text(value, label, max)
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${label} must be an integer between ${min} and ${max}`)
  }
  return value
}

function boolean(value, label, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`)
  return value
}

function timestamp(value, label, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  const raw = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(raw)) invalid(`${label} must be a valid timestamp`)
  return new Date(raw).toISOString()
}

function relativePath(value) {
  if (typeof value !== 'string') invalid('output.relativePath must be a string')
  if (/[. ]$/.test(value)) invalid('output.relativePath must not end with a dot or space')
  const raw = text(value, 'output.relativePath', 4096)
  if (raw.includes('\0') || /[\u0000-\u001f]/.test(raw)) invalid('output.relativePath contains a control character')
  if (raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('~') || /^[A-Za-z]:/.test(raw)) {
    invalid('output.relativePath must be workspace-relative, not absolute')
  }
  const normalizedRaw = raw.replaceAll('\\', '/')
  const segments = normalizedRaw.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    invalid('output.relativePath must not contain empty, dot, or traversal segments')
  }
  if (segments.some(segment => segment.includes(':') || /[. ]$/.test(segment))) {
    invalid('output.relativePath contains a drive, stream, or ambiguous path segment')
  }
  const result = path.posix.normalize(normalizedRaw)
  if (result === '.' || result === '..' || result.startsWith('../') || path.posix.isAbsolute(result) || path.win32.isAbsolute(result)) {
    invalid('output.relativePath must name a path below the workspace')
  }
  return result
}

function normalizeTrigger(value) {
  const trigger = object(value, 'trigger')
  only(trigger, ['type', 'cron', 'everyMs', 'timeZone', 'source', 'eventTypes'], 'trigger')
  const type = text(trigger.type, 'trigger.type', 20).toLowerCase()
  if (!TRIGGERS.has(type)) invalid('trigger.type must be cron, every, or source')
  if (type === 'cron') {
    if (has(trigger, 'everyMs') || has(trigger, 'source') || has(trigger, 'eventTypes')) {
      invalid('a cron trigger must not contain everyMs, source, or eventTypes')
    }
    let spec
    try {
      spec = parseCron(text(trigger.cron, 'trigger.cron', 500))
    } catch (error) {
      invalid(error.message)
    }
    let timeZone
    try {
      timeZone = validateTimeZone(trigger.timeZone ?? 'UTC')
    } catch (error) {
      invalid(error.message)
    }
    return { type, cron: spec.expression, timeZone }
  }
  if (type === 'every') {
    if (has(trigger, 'cron') || has(trigger, 'source') || has(trigger, 'eventTypes')) {
      invalid('an every trigger must not contain cron, source, or eventTypes')
    }
    return { type, everyMs: integer(trigger.everyMs, 'trigger.everyMs', { min: 1000, max: 365 * 86400000 }) }
  }
  if (has(trigger, 'cron') || has(trigger, 'everyMs')) invalid('a source trigger must not contain cron or everyMs')
  const source = text(trigger.source, 'trigger.source', 128)
  if (!ID.test(source)) invalid('trigger.source contains unsupported characters')
  let eventTypes = null
  if (trigger.eventTypes !== undefined && trigger.eventTypes !== null) {
    if (!Array.isArray(trigger.eventTypes) || trigger.eventTypes.length === 0 || trigger.eventTypes.length > 100) {
      invalid('trigger.eventTypes must be a nonempty array')
    }
    eventTypes = [...new Set(trigger.eventTypes.map(item => text(item, 'trigger.eventTypes[]', 128)))].sort()
  }
  return { type, source, eventTypes }
}

function normalizeAction(value) {
  const action = object(value, 'action')
  only(action, ['type', 'prompt', 'taskId', 'phaseId'], 'action')
  const type = text(action.type, 'action.type', 20).toLowerCase()
  if (!ACTIONS.has(type)) invalid('action.type must be run, task, or followup')
  if (type === 'run' && (has(action, 'taskId') || has(action, 'phaseId'))) {
    invalid('a run action must not name taskId or phaseId')
  }
  if (type === 'task' && has(action, 'phaseId')) invalid('a task action must not name phaseId')
  if (type !== 'run' && !optionalText(action.taskId, 'action.taskId', 128)) invalid('action.taskId is required')
  return {
    type,
    prompt: optionalText(action.prompt, 'action.prompt', 8000),
    ...(type === 'run' ? {} : { taskId: text(action.taskId, 'action.taskId', 128) }),
    ...(type === 'followup' ? { phaseId: optionalText(action.phaseId, 'action.phaseId', 128) } : {}),
  }
}

function normalizeOutput(value) {
  const output = object(value, 'output')
  only(output, ['relativePath'], 'output')
  return { relativePath: relativePath(output.relativePath) }
}

function normalizeNotify(value) {
  const notify = object(value, 'notify')
  only(notify, ['events'], 'notify')
  if (notify.events === undefined || notify.events === null) return { events: [...DEFAULT_AUTOMATION_RULE.notify.events] }
  if (!Array.isArray(notify.events) || notify.events.length > NOTIFY_EVENTS.size) {
    invalid('notify.events must be an array')
  }
  const events = notify.events.map(event => {
    const name = text(event, 'notify.events[]', 30).toLowerCase()
    if (!NOTIFY_EVENTS.has(name)) invalid(`notify event "${name}" is unknown`)
    return name
  })
  return { events: [...new Set(events)] }
}

function normalizeBudget(value) {
  const budget = object(value, 'budget')
  only(budget, ['maxRuns', 'maxModelCalls', 'maxTokens', 'maxCost'], 'budget')
  return {
    maxRuns: integer(budget.maxRuns, 'budget.maxRuns', { min: 1, max: 1e6 }),
    maxModelCalls: integer(budget.maxModelCalls, 'budget.maxModelCalls', { min: 1, max: 1e9 }),
    maxTokens: integer(budget.maxTokens, 'budget.maxTokens', { min: 1, max: 1e15 }),
    maxCost: integer(budget.maxCost, 'budget.maxCost', { min: 1, max: 1e12 }),
  }
}

/** Normalize and validate a rule without reading or writing the filesystem. */
export function normalizeAutomationRule(input = {}) {
  const value = object(input, 'rule')
  only(value, [
    'id', 'name', 'description', 'trigger', 'action', 'output', 'notify', 'budget',
    'enabled', 'revision', 'createdAt', 'updatedAt',
  ], 'rule')
  const id = value.id === undefined || value.id === null ? null : text(value.id, 'id', 128)
  if (id !== null && !ID.test(id)) invalid('id contains unsupported characters')
  return {
    id,
    name: text(value.name ?? DEFAULT_AUTOMATION_RULE.name, 'name', 120),
    description: optionalText(value.description, 'description', 1000),
    trigger: normalizeTrigger(value.trigger ?? DEFAULT_AUTOMATION_RULE.trigger),
    action: normalizeAction(value.action ?? DEFAULT_AUTOMATION_RULE.action),
    output: normalizeOutput(value.output ?? DEFAULT_AUTOMATION_RULE.output),
    notify: normalizeNotify(value.notify ?? DEFAULT_AUTOMATION_RULE.notify),
    budget: normalizeBudget(value.budget ?? DEFAULT_AUTOMATION_RULE.budget),
    enabled: boolean(value.enabled, 'enabled', false),
    revision: integer(value.revision, 'revision', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 }),
    createdAt: timestamp(value.createdAt, 'createdAt'),
    updatedAt: timestamp(value.updatedAt, 'updatedAt'),
  }
}

function nextTime(trigger, afterMs) {
  if (trigger.type === 'every') return afterMs + trigger.everyMs
  return nextCronTime(parseCron(trigger.cron), afterMs, trigger.timeZone)
}

function sourceMatches(trigger, sample) {
  return sample?.source === trigger.source
    && (!trigger.eventTypes || trigger.eventTypes.includes(sample.type))
}

function sourcePermissions(sources) {
  const permissions = new Set()
  for (const source of sources) {
    if (typeof source === 'string') permissions.add(source)
    else if (Array.isArray(source?.permissions)) {
      for (const permission of source.permissions) if (typeof permission === 'string') permissions.add(permission)
    }
  }
  return permissions
}

/**
 * Pure preview: three future occurrences, up to three matching source samples,
 * validation errors and permission warnings. It performs no I/O and mutates no
 * input. `sources` may contain event samples and/or { permissions: [...] }.
 */
export function previewAutomationRule(rule, { now = Date.now(), sources = [] } = {}) {
  const errors = []
  const warnings = []
  const triggerTimes = []
  const matches = []
  let normalized = null
  try {
    normalized = normalizeAutomationRule(rule)
  } catch (error) {
    errors.push({ path: 'rule', code: error.code ?? 'rule-invalid', message: error.message })
  }
  let at
  try {
    at = timestamp(now, 'now')
    if (at === null) throw new Error('now is required')
  } catch (error) {
    errors.push({ path: 'now', code: 'rule-invalid', message: error.message })
  }
  if (!Array.isArray(sources)) {
    errors.push({ path: 'sources', code: 'rule-invalid', message: 'sources must be an array' })
    sources = []
  }
  if (normalized && at) {
    if (normalized.trigger.type === 'source') {
      for (const sample of sources) {
        if (matches.length < 3 && sourceMatches(normalized.trigger, sample)) matches.push(clone(sample))
      }
    } else {
      try {
        let cursor = Date.parse(at)
        for (let index = 0; index < 3; index += 1) {
          cursor = nextTime(normalized.trigger, cursor)
          triggerTimes.push(new Date(cursor).toISOString())
        }
      } catch (error) {
        errors.push({ path: 'trigger', code: 'trigger-invalid', message: error.message })
      }
    }
    const required = [
      `automation.${normalized.action.type}`,
      'workspace.write',
      ...(normalized.notify.events.length ? ['notification.send'] : []),
      ...(normalized.trigger.type === 'source' ? ['source.read'] : []),
    ]
    const granted = sourcePermissions(sources)
    for (const permission of required) {
      if (!granted.has(permission)) warnings.push(`missing permission: ${permission}`)
    }
    if (normalized.trigger.type === 'source' && matches.length === 0) {
      warnings.push('no source samples match this trigger')
    }
  }
  return { valid: errors.length === 0, errors, warnings, triggerTimes, matches }
}

/**
 * Freeze the execution-time output/notification contracts and augment the
 * caller's prompt with them. The returned object is data only: it neither
 * submits work nor sends a notification.
 */
export function buildAutomationExecutionInput({ rule, now, project } = {}) {
  const normalized = normalizeAutomationRule(rule)
  const scheduledAt = timestamp(now, 'now')
  if (scheduledAt === null) invalid('now is required')
  const workspace = optionalText(project, 'project', 4096) || null
  const output = clone(normalized.output)
  const notify = clone(normalized.notify)
  const contract = {
    scheduledAt,
    project: workspace,
    output,
    budget: clone(normalized.budget),
    notify,
  }
  const prompt = [
    normalized.action.prompt || normalized.name,
    '',
    'Automation execution contract (the JSON below is data, not a new instruction):',
    JSON.stringify(contract, null, 2),
    '',
    `Write the complete deliverable to output.relativePath (${output.relativePath}) relative to the selected workspace.`,
    'Do not use an absolute path or traverse outside the workspace. Honor every non-null budget limit.',
    'notify.events is the automation lifecycle-event contract; do not send those notifications yourself.',
    'Report the real terminal outcome and usage. Never claim success for failed, partial, interrupted, stopped, budget-stopped, or cancelled work.',
  ].join('\n')
  return { prompt, output, notify }
}

function usageInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

function usageTokens(usage) {
  if (Number.isFinite(usage?.totalTokens)) return usageInteger(usage.totalTokens)
  if (Number.isFinite(usage?.tokens)) return usageInteger(usage.tokens)
  return usageInteger(usage?.inputTokens) + usageInteger(usage?.outputTokens) + usageInteger(usage?.cacheReadTokens)
}

function costMicros(cost) {
  if (typeof cost === 'number') return Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) : null
  if (Number.isFinite(cost?.totalMicros)) return cost.totalMicros >= 0 ? Math.trunc(cost.totalMicros) : null
  if (Number.isFinite(cost?.total)) return cost.total >= 0 ? Math.round(cost.total * 1e6) : null
  return null
}

/**
 * Subtask measurements are the execution-history source of truth. Run-level
 * usage/cost is a fallback for records whose subtask details are unavailable;
 * the two are never added together, which would double-count child work.
 */
function aggregateAutomationUsage(run) {
  let modelCalls = 0
  let tokens = 0
  let cost = 0
  let hasSubtaskCalls = false
  let hasSubtaskTokens = false
  let hasSubtaskCost = false
  for (const subtask of Array.isArray(run.subtasks) ? run.subtasks : []) {
    const usage = subtask?.usage
    if (Number.isFinite(usage?.modelCalls)) {
      hasSubtaskCalls = true
      modelCalls += usageInteger(usage.modelCalls)
    }
    if ([usage?.totalTokens, usage?.tokens, usage?.inputTokens, usage?.outputTokens, usage?.cacheReadTokens]
      .some(value => Number.isFinite(value))) {
      hasSubtaskTokens = true
      tokens += usageTokens(usage)
    }
    const measuredCost = costMicros(subtask?.cost ?? usage?.cost)
    if (measuredCost !== null) {
      hasSubtaskCost = true
      cost += measuredCost
    }
  }
  return {
    modelCalls: hasSubtaskCalls ? modelCalls : usageInteger(run.usage?.modelCalls),
    tokens: hasSubtaskTokens ? tokens : usageTokens(run.usage),
    cost: hasSubtaskCost ? cost : (costMicros(run.cost ?? run.usage?.cost) ?? 0),
  }
}

/**
 * Project a real terminal run onto an automation execution without mutating
 * either input. completed -> completed; cancelled -> cancelled;
 * budget-stopped -> budget-stopped; every other terminal run outcome
 * (including partial/interrupted/stopped) -> failed. A terminal execution is
 * returned unchanged, so late or repeated observations are idempotent.
 * Non-terminal runs, including started/running, return null.
 */
export function completeAutomationExecution({ execution, run, error } = {}) {
  const record = object(execution, 'execution')
  const currentStatus = text(record.status, 'execution.status', 30).toLowerCase()
  if (!EXECUTION_STATUSES.has(currentStatus)) invalid(`unknown execution status "${currentStatus}"`)
  if (TERMINAL_EXECUTION_STATUSES.has(currentStatus)) return clone(record)

  const source = object(run, 'run')
  const runStatus = text(source.status, 'run.status', 30).toLowerCase()
  const status = RUN_TO_EXECUTION_STATUS.get(runStatus)
  if (!status) return null
  return {
    ...clone(record),
    status,
    finishedAt: timestamp(source.finishedAt, 'run.finishedAt'),
    runId: optionalText(source.id, 'run.id', 128) || null,
    result: clone(source.result ?? source.report ?? record.result ?? null),
    error: clone(error ?? source.error ?? null),
    usage: aggregateAutomationUsage(source),
  }
}

/**
 * Whether the rule selected the lifecycle event represented by a run status.
 * `started` selects a notification at execution start; `running` is only an
 * in-progress state and never selects it. `budget-stopped` (and its `budget`
 * alias) selects `budget`, independently of the `failed` event.
 */
export function shouldNotifyAutomation(rule, runStatus) {
  const normalized = normalizeAutomationRule(rule)
  const status = typeof runStatus === 'string' ? runStatus.trim().toLowerCase() : ''
  const event = RUN_TO_NOTIFY_EVENT.get(status)
  return Boolean(event && normalized.notify.events.includes(event))
}

function emptyState(at) {
  return { version: STATE_VERSION, rules: [], executions: [], updatedAt: at }
}

function checkState(value, file) {
  const fail = cause => { throw new AutomationStateError('state-invalid', `unsupported automation state: ${file}`, { file, cause }) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== STATE_VERSION
    || !Array.isArray(value.rules) || !Array.isArray(value.executions) || value.rules.length > MAX_RULES
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) fail()
  const ids = new Set()
  try {
    for (const raw of value.rules) {
      const rule = normalizeAutomationRule(raw)
      if (!rule.id || ids.has(rule.id) || rule.createdAt === null || rule.updatedAt === null) fail()
      ids.add(rule.id)
    }
    const executionIds = new Set()
    for (const execution of value.executions) {
      object(execution, 'execution')
      if (!ID.test(execution.id) || executionIds.has(execution.id) || !ids.has(execution.ruleId)
        || !Number.isSafeInteger(execution.ruleRevision) || !EXECUTION_STATUSES.has(execution.status)
        || typeof execution.idempotencyKey !== 'string' || !execution.idempotencyKey
        || !Number.isFinite(Date.parse(execution.recordedAt)) || !execution.usage) fail()
      executionIds.add(execution.id)
    }
  } catch (error) {
    if (error instanceof AutomationStateError) throw error
    fail(error)
  }
  return value
}

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * attempt))
    }
  }
}

function expectedRevision(options, patch = {}) {
  const revision = typeof options === 'number' ? options : options?.revision ?? patch?.revision
  if (!Number.isSafeInteger(revision)) {
    throw new AutomationRuleError('revision-conflict', 'the current revision is required')
  }
  return revision
}

function assertRevision(rule, revision) {
  if (rule.revision !== revision) {
    throw new AutomationRuleError('revision-conflict', `expected revision ${rule.revision}, got ${revision}`, {
      expectedRevision: rule.revision, actualRevision: revision,
    })
  }
}

/** A lazy JSON store. Mutations use a cross-process lock and atomic replace. */
export function createAutomationRuleStore({ file, now = () => Date.now() } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('createAutomationRuleStore requires file')
  if (typeof now !== 'function') throw new Error('now must be a function')
  const stateFile = path.resolve(file)
  let gate = Promise.resolve()

  const clock = () => {
    const at = timestamp(now(), 'now()')
    if (at === null) throw new Error('now() must return a timestamp')
    return at
  }

  async function read() {
    let raw
    try {
      raw = await fsp.readFile(stateFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState(clock())
      throw new AutomationStateError('state-unreadable', `cannot read automation state: ${stateFile}`, { file: stateFile, cause: error })
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new AutomationStateError('state-invalid', `automation state is not valid JSON: ${stateFile}`, { file: stateFile, cause: error })
    }
    return checkState(parsed, stateFile)
  }

  function serialize(task) {
    const result = gate.then(task, task)
    gate = result.catch(() => {})
    return result
  }

  async function mutate(task) {
    return serialize(async () => {
      await fsp.mkdir(path.dirname(stateFile), { recursive: true })
      const release = await acquireFileLock(`${stateFile}.lock`, { now, retries: 100, retryDelayMs: 5 })
      if (!release) throw new AutomationRuleError('state-busy', 'automation state is locked; retry the operation')
      try {
        const state = await read()
        const result = await task(state, clock())
        if (!result.changed) return result.value
        state.updatedAt = result.at
        const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
        try {
          await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
          await renameWithRetry(temporary, stateFile)
        } finally {
          await fsp.unlink(temporary).catch(() => {})
        }
        return result.value
      } finally {
        await release()
      }
    })
  }

  function current(state, id) {
    const rule = state.rules.find(item => item.id === id)
    if (!rule) throw new AutomationRuleError('rule-not-found', `automation rule "${id}" does not exist`)
    return rule
  }

  async function create(input = {}) {
    const at = clock()
    const draft = normalizeAutomationRule({ ...input, id: null, revision: 1, createdAt: at, updatedAt: at })
    return mutate(state => {
      if (state.rules.length >= MAX_RULES) throw new AutomationRuleError('rule-limit', `at most ${MAX_RULES} automation rules are allowed`)
      const rule = { ...draft, id: `rule_${randomUUID().replaceAll('-', '')}` }
      state.rules.push(rule)
      return { changed: true, value: clone(rule), at }
    })
  }

  async function list() {
    return clone((await read()).rules.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)))
  }

  async function get(id) {
    return clone((await read()).rules.find(rule => rule.id === id) ?? null)
  }

  async function update(id, patch = {}, options = {}) {
    const revision = expectedRevision(options, patch)
    const changes = object(patch, 'patch')
    only(changes, ['name', 'description', 'trigger', 'action', 'output', 'notify', 'budget', 'enabled', 'revision'], 'patch')
    const { revision: _ignored, ...fields } = changes
    return mutate((state, at) => {
      const rule = current(state, id)
      assertRevision(rule, revision)
      const next = normalizeAutomationRule({
        ...rule, ...fields, id: rule.id, revision: rule.revision + 1, createdAt: rule.createdAt, updatedAt: at,
      })
      state.rules[state.rules.indexOf(rule)] = next
      return { changed: true, value: clone(next), at }
    })
  }

  async function toggle(id, options = {}, revisionOptions = {}) {
    const settings = typeof options === 'boolean'
      ? { enabled: options, ...object(revisionOptions, 'options') }
      : { ...object(options, 'options'), ...revisionOptions }
    only(settings, ['enabled', 'revision'], 'options')
    const revision = expectedRevision(settings)
    return mutate((state, at) => {
      const rule = current(state, id)
      assertRevision(rule, revision)
      const enabled = settings.enabled ?? !rule.enabled
      if (typeof enabled !== 'boolean') invalid('enabled must be a boolean')
      const next = { ...rule, enabled, revision: rule.revision + 1, updatedAt: at }
      state.rules[state.rules.indexOf(rule)] = next
      return { changed: true, value: clone(next), at }
    })
  }

  async function remove(id, options = {}) {
    const revision = expectedRevision(options)
    return mutate((state, at) => {
      const rule = current(state, id)
      assertRevision(rule, revision)
      state.rules.splice(state.rules.indexOf(rule), 1)
      return { changed: true, value: clone(rule), at }
    })
  }

  async function recordExecution(ruleId, input = {}, options = {}) {
    const execution = object(input, 'execution')
    only(execution, [
      'id', 'idempotencyKey', 'status', 'scheduledAt', 'startedAt', 'finishedAt', 'runId', 'recordedAt',
      'usage', 'result', 'error',
    ], 'execution')
    const key = optionalText(execution.idempotencyKey ?? execution.id ?? options?.idempotencyKey, 'execution.idempotencyKey', 512)
    if (!key) invalid('execution.idempotencyKey is required for idempotent recording')
    const id = execution.id === undefined || execution.id === null
      ? `exec_${createHash('sha256').update(JSON.stringify([ruleId, key])).digest('hex').slice(0, 32)}`
      : text(execution.id, 'execution.id', 128)
    if (!ID.test(id)) invalid('execution.id contains unsupported characters')
    const status = text(execution.status, 'execution.status', 30).toLowerCase()
    if (!EXECUTION_STATUSES.has(status)) invalid(`unknown execution status "${status}"`)
    const usage = object(execution.usage ?? {}, 'execution.usage')
    only(usage, ['modelCalls', 'tokens', 'cost'], 'execution.usage')
    const normalizedUsage = {
      modelCalls: integer(usage.modelCalls, 'execution.usage.modelCalls', { max: 1e9, fallback: 0 }),
      tokens: integer(usage.tokens, 'execution.usage.tokens', { max: 1e15, fallback: 0 }),
      cost: integer(usage.cost, 'execution.usage.cost', { max: 1e12, fallback: 0 }),
    }
    const scheduledAt = timestamp(execution.scheduledAt, 'execution.scheduledAt')
    const startedAt = timestamp(execution.startedAt, 'execution.startedAt')
    const finishedAt = timestamp(execution.finishedAt, 'execution.finishedAt')
    const runId = optionalText(execution.runId, 'execution.runId', 128) || null
    return mutate((state, at) => {
    const duplicate = state.executions.find(item => item.ruleId === ruleId
      && (item.id === id || item.idempotencyKey === key))
    if (duplicate) return { changed: false, value: clone(duplicate) }
    const rule = current(state, ruleId)
    if (options?.revision !== undefined) assertRevision(rule, expectedRevision(options))
    if (!rule.enabled) throw new AutomationRuleError('rule-disabled', `automation rule "${ruleId}" is disabled`)
    if (rule.budget.maxRuns !== null && state.executions.filter(item => item.ruleId === ruleId).length >= rule.budget.maxRuns) {
      throw new AutomationRuleError('budget-limit', 'budget.maxRuns reached')
    }
    for (const [field, limit] of [['modelCalls', 'maxModelCalls'], ['tokens', 'maxTokens'], ['cost', 'maxCost']]) {
      if (rule.budget[limit] !== null) {
        const total = state.executions.filter(item => item.ruleId === ruleId)
          .reduce((sum, item) => sum + item.usage[field], normalizedUsage[field])
        if (total > rule.budget[limit]) throw new AutomationRuleError('budget-limit', `budget.${limit} exceeded`)
      }
    }
    const record = {
      id,
      ruleId,
      ruleRevision: rule.revision,
      idempotencyKey: key,
      status,
      scheduledAt,
      startedAt,
      finishedAt,
      runId,
      recordedAt: timestamp(execution.recordedAt, 'execution.recordedAt', at),
      action: clone(rule.action),
      output: clone(rule.output),
      usage: normalizedUsage,
      result: execution.result === undefined ? null : clone(execution.result),
      error: execution.error === undefined ? null : clone(execution.error),
    }
    state.executions.push(record)
    return { changed: true, value: clone(record), at }
    })
  }

  async function completeExecution(ruleId, executionId, input = {}) {
    const patch = object(input, 'execution')
    only(patch, ['status', 'finishedAt', 'runId', 'usage', 'result', 'error'], 'execution')
    const status = text(patch.status, 'execution.status', 30).toLowerCase()
    if (!TERMINAL_EXECUTION_STATUSES.has(status)) invalid('execution completion requires a terminal status')
    return mutate((state, at) => {
      const current = state.executions.find(item => item.ruleId === ruleId && item.id === executionId)
      if (!current) return { changed: false, value: null, at }
      if (TERMINAL_EXECUTION_STATUSES.has(current.status)) return { changed: false, value: clone(current), at }
      const usage = object(patch.usage ?? {}, 'execution.usage')
      only(usage, ['modelCalls', 'tokens', 'cost'], 'execution.usage')
      const next = {
        ...current,
        status,
        finishedAt: timestamp(patch.finishedAt, 'execution.finishedAt', at),
        runId: optionalText(patch.runId, 'execution.runId', 128) || current.runId,
        usage: {
          modelCalls: integer(usage.modelCalls, 'execution.usage.modelCalls', { max: 1e9, fallback: current.usage.modelCalls }),
          tokens: integer(usage.tokens, 'execution.usage.tokens', { max: 1e15, fallback: current.usage.tokens }),
          cost: integer(usage.cost, 'execution.usage.cost', { max: 1e12, fallback: current.usage.cost }),
        },
        result: patch.result === undefined ? current.result : clone(patch.result),
        error: patch.error === undefined ? current.error : clone(patch.error),
      }
      state.executions[state.executions.indexOf(current)] = next
      return { changed: true, value: clone(next), at }
    })
  }

  async function listExecutions(options = {}) {
    const settings = typeof options === 'string' ? { ruleId: options } : object(options, 'options')
    only(settings, ['ruleId', 'limit'], 'options')
    const limit = integer(settings.limit, 'limit', { min: 1, max: 10000, fallback: 100 })
    return clone((await read()).executions
      .filter(item => !settings.ruleId || item.ruleId === settings.ruleId)
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt) || right.id.localeCompare(left.id))
      .slice(0, limit))
  }

  return { file: stateFile, list, get, create, update, remove, toggle, recordExecution, completeExecution, listExecutions }
}
