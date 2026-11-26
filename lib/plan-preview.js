/**
 * Side-effect-free planning and approval.
 *
 * `createPlanPreview` only reads its arguments and returns a deterministic
 * preview. It never invokes a model, touches the filesystem, opens a network
 * connection, or starts a run. `createCandidatePlanPreview` additionally exposes
 * the requested tool permissions and execution environment without inventing
 * missing values. `approvePlan` binds an approval to the exact planning inputs:
 * legacy previews produce an execution specification, while candidate previews
 * produce only an approval credential. Neither form starts execution.
 *
 * @module dsh-superagent/plan-preview
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import { computeCost } from './cost.js'

const VERSION = 1
const DIGEST_PREFIX = 'sha256:'
const READ = 'filesystem.read'
const WRITE = 'filesystem.write'
const EXECUTE = 'shell.execute'
const NETWORK = 'network'

const OPERATION_PERMISSIONS = {
  read: READ,
  file: READ,
  'file.read': READ,
  'fs.read': READ,
  'filesystem.read': READ,
  readfile: READ,
  write: WRITE,
  'file.write': WRITE,
  'fs.write': WRITE,
  'filesystem.write': WRITE,
  writefile: WRITE,
  edit: WRITE,
  create: WRITE,
  delete: WRITE,
  remove: WRITE,
  move: WRITE,
  copy: WRITE,
  shell: EXECUTE,
  command: EXECUTE,
  execute: EXECUTE,
  'shell.execute': EXECUTE,
  network: NETWORK,
  http: NETWORK,
  fetch: NETWORK,
  'network.request': NETWORK,
  deploy: NETWORK,
  publish: NETWORK,
}

const DESTRUCTIVE_KINDS = new Set(['delete', 'remove', 'deploy', 'publish'])

export class PlanPreviewError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'PlanPreviewError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Clone JSON-shaped data canonically, rejecting values that cannot be planned safely. */
function canonical(value, seen = new Set()) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PlanPreviewError('INVALID_INPUT', 'Planning inputs must contain finite numbers.')
    return value
  }
  if (typeof value !== 'object') {
    throw new PlanPreviewError('INVALID_INPUT', 'Planning inputs must be JSON-shaped data.')
  }
  if (seen.has(value)) throw new PlanPreviewError('INVALID_INPUT', 'Planning inputs must not contain cycles.')
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = value.map(item => canonical(item, seen))
  } else {
    result = Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], seen)]))
  }
  seen.delete(value)
  return result
}

function stableJson(value) {
  return JSON.stringify(canonical(value))
}

function digest(value) {
  return DIGEST_PREFIX + createHash('sha256').update(stableJson(value)).digest('hex')
}

function candidateSnapshot(input) {
  if (!isObject(input)) throw new PlanPreviewError('INVALID_INPUT', 'Candidate plan preview input must be an object.')
  return canonical({
    version: VERSION,
    kind: 'candidate-plan-input',
    goal: input.goal ?? null,
    project: input.project ?? null,
    subtasks: input.subtasks ?? null,
    capabilities: input.capabilities ?? null,
    budget: input.budget ?? null,
    model: input.model ?? null,
    permissionScope: input.permissionScope ?? null,
    runtime: input.runtime ?? null,
  })
}

function isCandidateInput(input) {
  return isObject(input) && !isObject(input.inputSnapshot) && input.plan === undefined
    && ['subtasks', 'project', 'permissionScope', 'runtime', 'budget'].some(key => Object.hasOwn(input, key))
}

function sourceSnapshot(input) {
  if (!isObject(input)) throw new PlanPreviewError('INVALID_INPUT', 'Plan preview input must be an object.')
  return canonical({
    version: VERSION,
    goal: input.goal ?? null,
    plan: input.plan ?? null,
    limits: input.limits ?? null,
    capabilities: input.capabilities ?? null,
    pricing: input.pricing ?? null,
    workspace: input.workspace ?? null,
    permissionPolicy: input.permissionPolicy ?? input.permissions ?? null,
  })
}

/** Compute the same digest exposed by a preview, without creating a preview. */
export function computePlanDigest(input) {
  if (isObject(input) && isObject(input.inputSnapshot)) return digest(input.inputSnapshot)
  if (isCandidateInput(input)) return digest(candidateSnapshot(input))
  return digest(sourceSnapshot(input))
}

function issue(issues, severity, code, message, extra = {}) {
  issues.push({ severity, code, message, ...extra })
}

function strings(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  return [...new Set(list.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function candidatePermissionList(value, issues, field) {
  if (value === undefined || value === null) return null
  if (isObject(value)) return unique(capabilityNames(value).map(permissionName))
  const list = Array.isArray(value) ? value : [value]
  if (list.some(item => typeof item !== 'string')) {
    issue(issues, 'block', 'permission_scope_invalid', `Permission scope ${field} must contain only tool names.`, { field })
  }
  return unique(list.filter(item => typeof item === 'string').map(item => permissionName(item)).filter(Boolean))
}

function candidatePermissionScope(value, issues) {
  if (!isObject(value)) {
    issue(issues, 'block', 'permission_scope_required', 'An explicit permission scope is required.')
    return { tools: null, allow: null, deny: null, approvalMode: null }
  }
  const scope = {
    tools: candidatePermissionList(value.tools, issues, 'tools'),
    allow: candidatePermissionList(value.allow, issues, 'allow'),
    deny: candidatePermissionList(value.deny, issues, 'deny'),
    approvalMode: optionalText(value.approvalMode),
  }
  const missing = Object.entries(scope).filter(([, item]) => item === null).map(([key]) => key)
  if (missing.length) {
    issue(issues, 'block', 'permission_scope_incomplete', `Permission scope is missing: ${missing.join(', ')}.`, { fields: missing })
  }
  return scope
}

function candidateRuntime(value, issues) {
  if (!isObject(value)) {
    issue(issues, 'block', 'runtime_required', 'An explicit execution runtime is required.')
    return {
      root: null,
      value: {
        mode: 'candidate-preview', cwd: null, isolation: null, provider: null,
        platform: null, shell: null, environment: null,
        pathEnforcement: {
          boundary: 'cwd',
          validation: 'lexical-only',
          symlinks: 'revalidate-or-reject-before-use',
        },
      },
    }
  }
  const requestedCwd = optionalText(value.cwd)
  const isolation = optionalText(value.isolation)
  const provider = optionalText(value.provider)
  const missing = [
    ...(requestedCwd === null ? ['cwd'] : []),
    ...(isolation === null ? ['isolation'] : []),
    ...(provider === null ? ['provider'] : []),
  ]
  if (missing.length) {
    issue(issues, 'block', 'runtime_incomplete', `Execution runtime is missing: ${missing.join(', ')}.`, { fields: missing })
  }
  if (value.environment !== undefined && value.environment !== null && !isObject(value.environment)) {
    issue(issues, 'warning', 'invalid_environment', 'Runtime environment overrides were ignored because they are not an object.')
  }
  const root = requestedCwd === null ? null : workspaceRoot(requestedCwd, issues)
  return {
    root,
    value: {
      mode: 'candidate-preview',
      cwd: root ?? requestedCwd,
      isolation,
      provider,
      platform: optionalText(value.platform),
      shell: optionalText(value.shell),
      environment: isObject(value.environment) ? canonical(value.environment) : null,
      pathEnforcement: {
        boundary: 'cwd',
        validation: 'lexical-only',
        symlinks: 'revalidate-or-reject-before-use',
      },
    },
  }
}

function candidateModel(value, issues) {
  if (value === undefined || value === null) return { name: null, value: null, pricing: null }
  if (typeof value === 'string' && value.trim()) return { name: value.trim(), value, pricing: null }
  if (!isObject(value)) {
    issue(issues, 'block', 'invalid_model', 'Model must be a non-empty string or an object.')
    return { name: null, value: null, pricing: null }
  }
  const name = optionalText(value.name ?? value.id ?? value.model ?? value.ref)
  if (!name) issue(issues, 'block', 'invalid_model', 'A model object must include a non-empty name, id, model, or ref.')
  const configuredPricing = value.pricing ?? value.price
    ?? (['input', 'output', 'cacheRead', 'currency'].some(key => Object.hasOwn(value, key)) ? value : null)
  return {
    name,
    value,
    pricing: isObject(configuredPricing) ? canonical(configuredPricing) : null,
  }
}

function candidateBudget(value, issues) {
  if (value === undefined || value === null) {
    issue(issues, 'warning', 'budget_missing', 'No budget was supplied; budget compliance is unverified.')
    return { configured: false, value: null, limits: {} }
  }
  let limits
  if (typeof value === 'number') limits = { maxCost: value }
  else if (isObject(value)) {
    limits = canonical(value)
    const constraintKeys = ['maxCost', 'budget', 'maxCostMicros', 'maxCostUsd', 'maxTasks', 'maxModelCalls', 'maxTokens', 'amount']
    if (!constraintKeys.some(key => limits[key] !== undefined && limits[key] !== null)) {
      issue(issues, 'block', 'invalid_budget', 'A budget object must configure at least one cost or usage limit.')
    }
    if (limits.maxCostUsd !== undefined && limits.maxCost === undefined) limits.maxCost = { USD: limits.maxCostUsd }
    if (limits.amount !== undefined && limits.maxCost === undefined) {
      if (typeof limits.currency === 'string' && limits.currency.trim()) {
        const currency = limits.currency.trim().toUpperCase()
        limits.maxCost = { [currency]: limits.amount }
      } else limits.maxCost = limits.amount
    }
  } else {
    issue(issues, 'block', 'invalid_budget', 'Budget must be a non-negative number or a limits object.')
    limits = {}
  }
  return { configured: true, value: canonical(value), limits: normaliseLimits(limits, issues) }
}

function candidateModelSettings(model, subtasks, issues) {
  const pricing = {}
  if (model.name && model.pricing) pricing[model.name] = model.pricing
  const tasks = (Array.isArray(subtasks) ? subtasks : []).map(raw => {
    if (!isObject(raw)) return raw
    const task = canonical(raw)
    const taskModel = candidateModel(task.model, issues)
    if (taskModel.name) {
      task.model = taskModel.name
      if (taskModel.pricing) pricing[taskModel.name] = taskModel.pricing
    } else if (model.name && task.model === undefined) task.model = model.name
    return task
  })
  return { tasks, pricing }
}

function candidateEstimate(estimate, budgetConfigured) {
  const result = { ...estimate, budgetConfigured }
  if (!result.complete) {
    result.cost = { ...result.cost, totalMicros: null, total: null }
    result.budget = result.budget.map(check => ({ ...check, actualMicros: null, withinBudget: null }))
    result.byTask = result.byTask.map(task => task.cost.complete
      ? task
      : { ...task, cost: { ...task.cost, totalMicros: null, total: null } })
  }
  return result
}

function candidateBudgetCoverage(limits, cost, issues) {
  if (!isObject(limits.maxCost) || !cost?.complete || !cost.records.length) return
  const budgeted = new Set(Object.keys(limits.maxCost).map(currency => currency.toUpperCase()))
  for (const currency of Object.keys(cost.byCurrency)) {
    if (!budgeted.has(currency.toUpperCase())) {
      issue(issues, 'block', 'budget_currency_missing', `The budget does not cover estimated ${currency} costs.`, { currency })
    }
  }
}

function unique(values) {
  return [...new Set(values)]
}

function nonNegativeInteger(value, fallback, issues, code, label, extra = {}) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    issue(issues, 'block', code, `${label} must be a non-negative safe integer.`, extra)
    return 0
  }
  return value
}

function permissionName(value) {
  const name = String(value).trim().toLowerCase()
  if (name === 'read' || name === 'fs.read' || name === 'file.read') return READ
  if (name === 'write' || name === 'fs.write' || name === 'file.write') return WRITE
  if (name === 'execute' || name === 'shell') return EXECUTE
  if (name === 'net' || name === 'http') return NETWORK
  return name
}

function permissionList(value) {
  if (isObject(value)) return capabilityNames(value).map(permissionName)
  return strings(value).map(permissionName)
}

function capabilityName(value) {
  const name = value.toLowerCase()
  if (name === 'fs.read' || name === 'file.read') return READ
  if (name === 'fs.write' || name === 'file.write') return WRITE
  if (name === 'shell') return EXECUTE
  if (name === 'net' || name === 'http') return NETWORK
  return name
}

function capabilityNames(value, prefix = '') {
  if (Array.isArray(value)) return value.flatMap(item => capabilityNames(item, prefix))
  if (typeof value === 'string') {
    const name = value.trim().toLowerCase()
    return name ? [capabilityName(prefix ? `${prefix}.${name}` : name)] : []
  }
  if (!isObject(value)) return []
  return Object.entries(value).flatMap(([key, enabled]) => {
    const name = key.toLowerCase()
    if (enabled === false || enabled === null) return []
    const qualified = prefix ? `${prefix}.${name}` : name
    if (enabled === true) return [capabilityName(qualified)]
    if (Array.isArray(enabled) && enabled.every(item => typeof item === 'string')) {
      return enabled.map(item => capabilityName(`${qualified}.${item.toLowerCase()}`))
    }
    if (isObject(enabled)) return capabilityNames(enabled, qualified)
    return []
  })
}

function matches(patterns, name) {
  const lower = name.toLowerCase()
  return patterns.some(pattern => {
    const candidate = pattern.toLowerCase()
    if (candidate === '*' || candidate === lower) return true
    if (lower.startsWith('model.') && patterns.some(pattern => pattern.toLowerCase() === `models.${lower.slice('model.'.length)}`)) return true
    if (!candidate.endsWith('.*')) return false
    return lower.startsWith(candidate.slice(0, -1))
  })
}

function normaliseGoal(goal, issues) {
  if (typeof goal === 'string' && goal.trim()) {
    const text = goal.trim()
    return { id: null, title: text, description: text }
  }
  if (!isObject(goal)) {
    issue(issues, 'block', 'goal_required', 'A non-empty goal string or object is required.')
    return { id: null, title: '', description: '' }
  }
  const result = canonical(goal)
  const title = typeof result.title === 'string' ? result.title.trim() : ''
  const description = typeof result.description === 'string'
    ? result.description.trim()
    : (typeof result.objective === 'string' ? result.objective.trim() : '')
  result.id = typeof result.id === 'string' ? result.id : null
  result.title = title || description
  result.description = description || title
  if (!result.title) issue(issues, 'block', 'goal_required', 'The goal must have a title or description.')
  return result
}

function workspaceRoot(workspace, issues) {
  const value = typeof workspace === 'string' ? workspace : workspace?.root
  if (typeof value !== 'string' || !value.trim() || /[\0]/.test(value)
    || /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    issue(issues, 'block', 'workspace_required', 'An absolute local workspace root is required.')
    return null
  }
  const windows = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value)
  if (!windows && !path.posix.isAbsolute(value)) {
    issue(issues, 'block', 'workspace_required', 'The workspace root must be absolute.')
    return null
  }
  return canonicalPath(windows ? path.win32.resolve(value) : path.posix.resolve(value))
}

function pathFlavour(root) {
  return /^[a-z]:\//i.test(root) || root.startsWith('//') ? path.win32 : path.posix
}

function comparisonPath(value) {
  const flavour = pathFlavour(value)
  return flavour === path.win32 ? value.toLowerCase() : value
}

function canonicalPath(value) {
  const normalised = value.replace(/\\/g, '/')
  if (normalised === '/') return '/'
  return normalised.replace(/\/+$/, '')
}

function inside(root, target) {
  const normalRoot = comparisonPath(canonicalPath(root))
  const normalTarget = comparisonPath(canonicalPath(target))
  return normalTarget === normalRoot || normalTarget.startsWith(`${normalRoot}/`)
}

function resolvePath(root, value) {
  if (!root || typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'invalid_path' }
  const raw = value.trim()
  if (raw.includes('\0') || /^[a-z][a-z\d+.-]*:\/\//i.test(raw) || /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
    return { ok: false, reason: 'invalid_path' }
  }
  const flavour = pathFlavour(root)
  const portable = flavour === path.win32 ? raw : raw.replace(/\\/g, '/')
  if (flavour === path.posix && (/^[a-z]:/i.test(portable) || portable.startsWith('//'))) {
    return { ok: false, reason: 'outside_workspace' }
  }
  if (/^\\\\\?\\/.test(raw)) return { ok: false, reason: 'invalid_path' }
  const absolute = canonicalPath(flavour.resolve(root, portable))
  if (!inside(root, absolute)) return { ok: false, path: absolute, reason: 'outside_workspace' }
  return { ok: true, path: absolute, reason: null }
}

function policyRoots(policy, access, root) {
  if (!root) return []
  const aliases = access === 'denied' ? ['deniedPaths', 'deniedRoots']
    : (access === 'write' || access === WRITE ? ['writePaths', 'writablePaths', 'writableRoots'] : ['readPaths', 'readRoots'])
  const configured = aliases.map(key => policy[key]).find(value => value !== undefined)
  const accessKey = access === 'denied' ? 'denied' : (access === 'write' || access === WRITE ? 'write' : 'read')
  const nested = isObject(policy.paths) ? policy.paths[accessKey] : undefined
  const filesystem = isObject(policy.filesystem) ? policy.filesystem[accessKey] : undefined
  const fallback = access === 'denied' ? [] : (policy.allowedPaths ?? (isObject(policy.paths) ? undefined : policy.paths) ?? root)
  const values = strings(configured ?? nested ?? filesystem ?? fallback)
  if (values.includes('*')) return [root]
  const roots = []
  for (const value of values) {
    const resolved = resolvePath(root, value)
    if (resolved.ok) roots.push(resolved.path)
  }
  return unique(roots)
}

function checkPath(root, value, access, policy) {
  const resolved = resolvePath(root, value)
  if (!resolved.ok) return { allowed: false, insideWorkspace: false, path: value, reason: resolved.reason }
  if (policyRoots(policy, 'denied', root).some(denied => inside(denied, resolved.path))) {
    return { allowed: false, insideWorkspace: true, path: resolved.path, reason: 'denied_path' }
  }
  const allowedRoots = policyRoots(policy, access, root)
  if (!allowedRoots.some(allowed => inside(allowed, resolved.path))) {
    return { allowed: false, insideWorkspace: true, path: resolved.path, reason: 'outside_allowed_paths' }
  }
  return { allowed: true, insideWorkspace: true, path: resolved.path, reason: null }
}

function addPathIssue(issues, taskId, access, checked, operationIndex = null) {
  const messages = {
    outside_workspace: 'Path escapes the workspace boundary.',
    denied_path: 'Path is denied by the permission policy.',
    outside_allowed_paths: 'Path is outside the permission policy roots.',
    invalid_path: 'Path is not a safe local path.',
  }
  issue(issues, 'block', 'path_not_allowed', messages[checked.reason] ?? 'Path is not allowed.', {
    taskId, path: checked.path, access, reason: checked.reason, ...(operationIndex === null ? {} : { operationIndex }),
  })
}

function rawPaths(value, access, output) {
  if (typeof value === 'string') output.push({ value, access })
  else if (Array.isArray(value)) for (const item of value) rawPaths(item, access, output)
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const itemAccess = key === 'read' || key === 'write' ? permissionName(key) : access
      rawPaths(item, itemAccess, output)
    }
  }
}

function operationKind(operation) {
  const raw = operation.type ?? operation.kind ?? operation.action ?? operation.tool ?? operation.op
  if (typeof raw !== 'string') return { kind: 'unknown', permission: null }
  const kind = raw.trim().toLowerCase()
  return { kind, permission: OPERATION_PERMISSIONS[kind] ?? null }
}

function normaliseOperation(raw, index) {
  const operation = typeof raw === 'string' ? { type: raw } : raw
  const { kind, permission } = operationKind(operation)
  const explicit = permissionName(operation.permission ?? permission ?? '')
  const paths = []
  rawPaths(operation.paths, explicit, paths)
  rawPaths(operation.readPaths, READ, paths)
  rawPaths(operation.writePaths, WRITE, paths)
  const target = operation.path ?? operation.target ?? operation.file ?? operation.resource
  if (target !== undefined && permission !== NETWORK) rawPaths(target, explicit, paths)
  const destructive = operation.destructive === true || DESTRUCTIVE_KINDS.has(kind)
  return {
    kind,
    permission: explicit || permission || null,
    paths: unique(paths.map(entry => `${entry.access}:${entry.value}`)).map(entry => {
      const separator = entry.indexOf(':')
      return { access: entry.slice(0, separator), value: entry.slice(separator + 1) }
    }),
    command: typeof operation.command === 'string' ? operation.command : null,
    requiresConfirmation: operation.requiresConfirmation === true,
    destructive,
    index,
  }
}

function shellPathEntries(command) {
  if (!command) return []
  const entries = []
  const windows = command.match(/[a-z]:[\\/][^\s"'|;&]+/gi) ?? []
  const unc = command.match(/\\\\[^\s"'|;&]+/g) ?? []
  const posix = command.match(/(?:^|[\s"'=])\/[^\s"'|;&]+/g) ?? []
  const traversal = command.match(/(?:^|[\s"'=])[^\s"'|;&]*(?:\.\.[\\/])[^\s"'|;&]*/g) ?? []
  for (const match of [...windows, ...unc, ...posix, ...traversal]) {
    entries.push(match.trim().replace(/^[\s"'=]+/, '').replace(/["']$/, ''))
  }
  return entries
}

function allowedPermissions(policy) {
  if (policy.allowed === false) return []
  if (policy.allowedPermissions !== undefined) return permissionList(policy.allowedPermissions)
  if (policy.permissions !== undefined) return permissionList(policy.permissions)
  return [READ]
}

function deniedPermissions(policy) {
  return permissionList(policy.deniedPermissions ?? policy.denied ?? [])
}

function permissionMatches(patterns, permission) {
  if (!permission) return false
  return patterns.some(pattern => {
    if (pattern === '*') return true
    if (pattern === permission) return true
    const namespace = permission.split('.')[0]
    return pattern === `${namespace}.*`
  })
}

function permissionAllowed(policy, permission) {
  return permissionMatches(allowedPermissions(policy), permission)
    && !permissionMatches(deniedPermissions(policy), permission)
}

function tokenEstimate(task, issues, taskId) {
  const source = task.estimatedTokens ?? task.tokens ?? task
  const tokens = { input: 0, output: 0, cacheRead: 0 }
  const fields = [
    ['input', task.estimatedInputTokens ?? task.inputTokens],
    ['output', task.estimatedOutputTokens ?? task.outputTokens],
    ['cacheRead', task.estimatedCacheReadTokens ?? task.cacheReadTokens],
  ]
  for (const [name, value] of fields) {
    if (value !== undefined) tokens[name] = nonNegativeInteger(value, 0, issues, 'invalid_token_estimate', `${name} token estimate`, { taskId })
  }
  if (isObject(source)) {
    const aliases = {
      input: ['input', 'inputTokens', 'promptTokens'],
      output: ['output', 'outputTokens', 'completionTokens'],
      cacheRead: ['cacheRead', 'cacheReadTokens', 'cachedInputTokens'],
    }
    for (const [name, keys] of Object.entries(aliases)) {
      const key = keys.find(candidate => source[candidate] !== undefined)
      if (key !== undefined) tokens[name] = nonNegativeInteger(source[key], 0, issues, 'invalid_token_estimate', `${name} token estimate`, { taskId })
    }
  } else if (typeof source === 'number') {
    tokens.input = nonNegativeInteger(source, 0, issues, 'invalid_token_estimate', 'Token estimate', { taskId })
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead
  return tokens
}

function emptyCost(currency) {
  return {
    currency, totalMicros: 0, total: 0, mixedCurrency: false,
    byCurrency: { [currency]: 0 }, byModel: {}, byModelMicros: {}, records: [], unpriced: [], complete: true,
  }
}

function normaliseLimits(limits, issues) {
  const result = isObject(limits) ? canonical(limits) : {}
  if (limits !== undefined && limits !== null && !isObject(limits)) {
    issue(issues, 'block', 'invalid_limits', 'Limits must be an object.')
  }
  if (result.budget !== undefined && result.maxCost === undefined) result.maxCost = result.budget
  result.maxTasks = nonNegativeInteger(result.maxTasks, null, issues, 'invalid_limits', 'maxTasks')
  result.maxModelCalls = nonNegativeInteger(result.maxModelCalls, null, issues, 'invalid_limits', 'maxModelCalls')
  result.maxTokens = nonNegativeInteger(result.maxTokens, null, issues, 'invalid_limits', 'maxTokens')
  result.maxCostMicros = nonNegativeInteger(result.maxCostMicros, null, issues, 'invalid_limits', 'maxCostMicros')
  if (result.maxCost !== undefined && result.maxCost !== null) {
    if (typeof result.maxCost === 'number') {
      if (!Number.isFinite(result.maxCost) || result.maxCost < 0) issue(issues, 'block', 'invalid_limits', 'maxCost must be non-negative.')
    } else if (!isObject(result.maxCost)) {
      issue(issues, 'block', 'invalid_limits', 'maxCost must be a number or currency-keyed object.')
    } else {
      for (const [currency, amount] of Object.entries(result.maxCost)) {
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
          issue(issues, 'block', 'invalid_limits', `maxCost for ${currency} must be non-negative.`)
        }
      }
    }
  }
  return result
}

function budgetCheck(limits, cost, issues) {
  const checks = []
  if (limits.maxCostMicros !== null) {
    const currency = cost.currency
    if (currency === null) {
      issue(issues, 'block', 'budget_unverifiable', 'A mixed-currency estimate cannot be checked against a scalar budget.')
    } else {
      checks.push({ currency, limitMicros: limits.maxCostMicros, actualMicros: cost.totalMicros })
    }
  }
  if (isObject(limits.maxCost)) {
    for (const [code, amount] of Object.entries(limits.maxCost)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) continue
      const currency = code.toUpperCase()
      const actualMicros = cost.byCurrency[currency] ?? 0
      checks.push({ currency, limitMicros: Math.round(amount * 1_000_000), actualMicros })
    }
  } else if (typeof limits.maxCost === 'number' && Number.isFinite(limits.maxCost) && limits.maxCost >= 0) {
    if (cost.currency === null) {
      issue(issues, 'block', 'budget_unverifiable', 'A mixed-currency estimate cannot be checked against a scalar budget.')
    } else {
      checks.push({ currency: cost.currency, limitMicros: Math.round(limits.maxCost * 1_000_000), actualMicros: cost.totalMicros })
    }
  }
  for (const check of checks) {
    check.withinBudget = check.actualMicros <= check.limitMicros
    if (!check.withinBudget) {
      issue(issues, 'block', 'budget_exceeded', `Estimated ${check.currency} cost exceeds the configured budget.`, check)
    }
  }
  return checks
}

function buildGraph(tasks, issues) {
  const byId = new Map()
  const duplicates = new Set()
  for (const task of tasks) {
    if (byId.has(task.id)) {
      duplicates.add(task.id)
      issue(issues, 'block', 'duplicate_task_id', `Duplicate subtask id: ${task.id}.`, { taskId: task.id })
    } else byId.set(task.id, task)
  }
  const position = new Map(tasks.map((task, index) => [task.id, index]))
  const adjacency = new Map(tasks.map(task => [task.id, []]))
  let invalidEdges = duplicates.size > 0
  for (const task of tasks) {
    const dependencies = []
    for (const dependency of strings(task.dependsOn)) {
      if (dependency === task.id || !byId.has(dependency)) {
        invalidEdges = true
        issue(issues, 'block', dependency === task.id ? 'dependency_cycle' : 'dependency_missing',
          dependency === task.id ? `Subtask ${task.id} depends on itself.` : `Subtask ${task.id} depends on missing subtask ${dependency}.`,
          { taskId: task.id, dependency })
      }
      if (byId.has(dependency)) dependencies.push(dependency)
      adjacency.get(dependency)?.push(task.id)
    }
    task.dependsOn = unique(dependencies).sort((a, b) => position.get(a) - position.get(b))
  }
  const indegree = new Map(tasks.map(task => [task.id, task.dependsOn.length]))
  const queue = tasks.filter(task => indegree.get(task.id) === 0).map(task => task.id)
  const executionOrder = []
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]
    executionOrder.push(id)
    for (const dependent of adjacency.get(id) ?? []) {
      indegree.set(dependent, indegree.get(dependent) - 1)
      if (indegree.get(dependent) === 0) queue.push(dependent)
    }
  }
  const acyclic = executionOrder.length === tasks.length && !invalidEdges
  if (executionOrder.length !== tasks.length) {
    const state = new Map()
    const stack = []
    const reported = new Set()
    const visit = id => {
      state.set(id, 1)
      stack.push(id)
      for (const dependency of byId.get(id)?.dependsOn ?? []) {
        if (state.get(dependency) === 1) {
          const start = stack.indexOf(dependency)
          const cycle = [...stack.slice(start), dependency]
          const key = [...new Set(cycle)].sort().join('|')
          if (!reported.has(key)) {
            reported.add(key)
            issue(issues, 'block', 'dependency_cycle', `Dependency cycle: ${cycle.join(' -> ')}.`, { taskId: dependency, cycle })
          }
        } else if (!state.get(dependency)) visit(dependency)
      }
      stack.pop()
      state.set(id, 2)
    }
    for (const task of tasks) if (!state.get(task.id)) visit(task.id)
  }
  const levels = new Map()
  if (acyclic) {
    for (const id of executionOrder) {
      const dependencies = byId.get(id).dependsOn
      levels.set(id, dependencies.length ? Math.max(...dependencies.map(dependency => levels.get(dependency))) + 1 : 0)
    }
  }
  const edges = tasks.flatMap(task => task.dependsOn.map(from => ({ from, to: task.id })))
  return {
    tasks,
    edges,
    roots: tasks.filter(task => task.dependsOn.length === 0).map(task => task.id),
    executionOrder: acyclic ? executionOrder : [],
    levels: acyclic ? [...levels.entries()].sort((a, b) => a[1] - b[1] || position.get(a[0]) - position.get(b[0])).map(([id, level]) => ({ id, level })) : [],
    acyclic,
  }
}

function normaliseTasks(plan, root, capabilities, policy, issues) {
  const list = Array.isArray(plan) ? plan : (plan?.subtasks ?? plan?.tasks)
  if (!Array.isArray(list) || list.length === 0) {
    issue(issues, 'block', 'plan_required', 'The candidate plan must contain at least one subtask.')
    return []
  }
  const tasks = []
  for (const [index, raw] of list.entries()) {
    if (!isObject(raw)) {
      issue(issues, 'block', 'invalid_subtask', `Subtask ${index + 1} must be an object.`)
      continue
    }
    const fallbackId = `task-${index + 1}`
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId
    if (id === fallbackId) issue(issues, 'warning', 'task_id_generated', `Subtask ${index + 1} had no id; ${id} was generated.`, { taskId: id })
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null
    const hasCalls = raw.modelCalls !== undefined || raw.calls !== undefined || raw.estimatedCalls !== undefined
    const calls = nonNegativeInteger(raw.modelCalls ?? raw.calls ?? raw.estimatedCalls,
      model ? 1 : 0, issues, 'invalid_model_calls', 'Estimated model calls', { taskId: id })
    if (calls > 0 && !model) issue(issues, 'block', 'model_required', `Subtask ${id} requests model calls without a model.`, { taskId: id })
    const requiredCapabilities = unique([...capabilityNames(raw.capabilities), ...(model ? [`model.${model}`] : [])])
    const rawOperations = raw.operations ?? raw.actions
    const operations = rawOperations === undefined || rawOperations === null ? []
      : (Array.isArray(rawOperations) ? rawOperations : [rawOperations]).map(normaliseOperation)
    const taskPermissions = unique([...permissionList(raw.permissions), ...operations.map(operation => operation.permission).filter(Boolean)])
    for (const permission of taskPermissions) {
      if (!requiredCapabilities.includes(permission)) requiredCapabilities.push(permission)
    }
    for (const capability of requiredCapabilities) {
      if (!matches(capabilities, capability)) {
        issue(issues, 'block', 'capability_missing', `Subtask ${id} requires unavailable capability ${capability}.`, { taskId: id, capability })
      }
    }
    const taskPaths = []
    rawPaths(raw.paths, READ, taskPaths)
    rawPaths(raw.readPaths, READ, taskPaths)
    rawPaths(raw.writePaths, WRITE, taskPaths)
    if (raw.path !== undefined) rawPaths(raw.path, READ, taskPaths)
    const pathChecks = []
    const requireConfirmation = []
    for (const permission of taskPermissions) {
      if (!permissionAllowed(policy, permission)) {
        issue(issues, 'block', 'permission_not_allowed', `Subtask ${id} requests denied permission ${permission}.`, { taskId: id, permission })
      }
      if (matches(permissionList(policy.requireConfirmation), permission)) requireConfirmation.push(`permission:${permission}`)
    }
    for (const operation of operations) {
      if (!operation.permission) {
        issue(issues, 'block', 'unsupported_operation', `Subtask ${id} uses unsupported operation ${operation.kind}.`, { taskId: id, operation: operation.kind })
      } else {
        if (!permissionAllowed(policy, operation.permission)) {
          issue(issues, 'block', 'permission_not_allowed', `Subtask ${id} requests denied permission ${operation.permission}.`, { taskId: id, permission: operation.permission })
        }
        if (matches(permissionList(policy.requireConfirmation), operation.permission)) requireConfirmation.push(`permission:${operation.permission}`)
      }
      for (const entry of operation.paths) {
        const checked = checkPath(root, entry.value, entry.access, policy)
        pathChecks.push({ taskId: id, ...checked, access: entry.access, operationIndex: operation.index })
        if (!checked.allowed) addPathIssue(issues, id, entry.access, checked, operation.index)
      }
      if (operation.command) {
        for (const commandPath of shellPathEntries(operation.command)) {
          const checked = checkPath(root, commandPath, READ, policy)
          pathChecks.push({ taskId: id, ...checked, access: READ, operationIndex: operation.index })
          if (!checked.allowed) addPathIssue(issues, id, READ, checked, operation.index)
        }
        issue(issues, 'warning', 'shell_command_review', `Subtask ${id} contains a shell command; review expansions and arguments before execution.`, { taskId: id, operationIndex: operation.index })
        if (/\$\(|`|\$\{|\$[A-Za-z_]/.test(operation.command)) requireConfirmation.push(`shell-expansion:${operation.index}`)
      }
      if (operation.destructive || operation.requiresConfirmation) requireConfirmation.push(`operation:${operation.index}`)
    }
    for (const entry of taskPaths) {
      const checked = checkPath(root, entry.value, entry.access, policy)
      pathChecks.push({ taskId: id, ...checked, access: entry.access })
      if (!checked.allowed) addPathIssue(issues, id, entry.access, checked)
    }
    const cwdValue = raw.cwd ?? raw.workingDirectory
    let cwd = root
    if (cwdValue !== undefined) {
      const checked = checkPath(root, cwdValue, READ, policy)
      cwd = checked.path
      pathChecks.push({ taskId: id, ...checked, access: 'cwd' })
      if (!checked.allowed) addPathIssue(issues, id, 'cwd', checked)
    }
    if (raw.requiresConfirmation === true) requireConfirmation.push('task')
    for (const entry of operationPaths(operations, pathChecks)) operations.find(operation => operation.index === entry.operationIndex).resolvedPaths = entry.paths
    tasks.push({
      id,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id,
      description: typeof raw.description === 'string' ? raw.description
        : (typeof raw.prompt === 'string' ? raw.prompt : (typeof raw.instruction === 'string' ? raw.instruction : '')),
      dependsOn: strings(raw.dependsOn ?? raw.dependencies),
      model,
      modelCalls: calls,
      estimatedTokens: tokenEstimate(raw, issues, id),
      capabilities: requiredCapabilities,
      permissions: taskPermissions,
      operations,
      cwd,
      requiresConfirmation: raw.requiresConfirmation === true,
      confirmationIds: unique(requireConfirmation),
      pathChecks,
    })
  }
  return tasks
}

function operationPaths(operations, checks) {
  return operations.map(operation => ({
    operationIndex: operation.index,
    paths: checks.filter(check => check.operationIndex === operation.index).map(check => ({
      path: check.path, access: check.access, allowed: check.allowed, insideWorkspace: check.insideWorkspace,
    })),
  }))
}

function normaliseRuntime(workspace, root, policy, capabilities, issues) {
  const source = isObject(workspace) ? workspace : {}
  const requestedCwd = source.cwd ?? root ?? '.'
  const cwd = root ? resolvePath(root, requestedCwd) : { ok: false, path: requestedCwd }
  if (root && !cwd.ok) {
    issue(issues, 'block', 'workspace_cwd_not_allowed', 'The runtime cwd must be an allowed path inside the workspace.', { path: requestedCwd })
  }
  if (source.environment !== undefined && !isObject(source.environment)) {
    issue(issues, 'warning', 'invalid_environment', 'Workspace environment overrides were ignored because they are not an object.')
  }
  return {
    mode: 'preview',
    platform: typeof source.platform === 'string' ? source.platform : process.platform,
    nodeVersion: process.version,
    shell: typeof source.shell === 'string' ? source.shell : null,
    sandbox: typeof source.sandbox === 'string' ? source.sandbox : 'workspace',
    cwd: cwd.path ?? root,
    environment: isObject(source.environment) ? canonical(source.environment) : {},
    networkAllowed: permissionAllowed(policy, NETWORK) && matches(capabilities, NETWORK),
    pathEnforcement: {
      boundary: 'workspace',
      validation: 'lexical-only',
      symlinks: 'revalidate-or-reject-before-use',
    },
  }
}

function permissionScope(tasks, root, policy) {
  return {
    allowed: allowedPermissions(policy),
    denied: deniedPermissions(policy),
    filesystemRoots: { read: policyRoots(policy, READ, root), write: policyRoots(policy, WRITE, root) },
    taskScopes: tasks.map(task => ({
      taskId: task.id,
      permissions: task.permissions,
      paths: task.pathChecks.map(check => ({
        path: check.path, access: check.access, allowed: check.allowed, insideWorkspace: check.insideWorkspace,
      })),
    })),
  }
}

function estimatePlan(tasks, pricing, limits, issues) {
  const models = {}
  const byTask = []
  let modelCalls = 0
  let callsWithoutModel = 0
  const totals = { input: 0, output: 0, cacheRead: 0, total: 0 }
  for (const task of tasks) {
    modelCalls += task.modelCalls
    if (task.modelCalls > 0 && !task.model) callsWithoutModel += task.modelCalls
    for (const name of ['input', 'output', 'cacheRead', 'total']) totals[name] += task.estimatedTokens[name]
    if (task.modelCalls > 0 && task.model) {
      const entry = models[task.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
      entry.calls += task.modelCalls
      entry.inputTokens += task.estimatedTokens.input
      entry.outputTokens += task.estimatedTokens.output
      entry.cacheReadTokens += task.estimatedTokens.cacheRead
    }
    byTask.push({
      taskId: task.id,
      model: task.model,
      modelCalls: task.modelCalls,
      tokens: task.estimatedTokens,
      cost: task.modelCalls > 0 && task.model ? computeCost({ modelCalls: task.modelCalls, models: { [task.model]: {
        calls: task.modelCalls,
        inputTokens: task.estimatedTokens.input,
        outputTokens: task.estimatedTokens.output,
        cacheReadTokens: task.estimatedTokens.cacheRead,
      } } }, pricing) : emptyCost(limits.currency ?? 'USD'),
    })
  }
  // Reuse the project's audited integer-micro cost implementation. It performs
  // arithmetic only and deliberately treats an unknown price as unknown.
  const cost = modelCalls > 0 ? computeCost({ modelCalls, models }, pricing) : emptyCost(limits.currency ?? 'USD')
  for (const model of cost?.unpriced ?? []) {
    issue(issues, 'block', 'pricing_missing', `No valid price is configured for model ${model}.`, { model })
  }
  if (cost && !cost.complete || callsWithoutModel > 0) {
    issue(issues, 'warning', 'budget_unverified', 'Budget compliance is unverified because a model is unpriced or unspecified.')
  }
  if (limits.maxModelCalls !== null && modelCalls > limits.maxModelCalls) {
    issue(issues, 'block', 'model_call_limit_exceeded', `Estimated model calls (${modelCalls}) exceed the limit (${limits.maxModelCalls}).`)
  }
  if (limits.maxTokens !== null && totals.total > limits.maxTokens) {
    issue(issues, 'block', 'token_limit_exceeded', `Estimated tokens (${totals.total}) exceed the limit (${limits.maxTokens}).`)
  }
  if (limits.maxTasks !== null && tasks.length > limits.maxTasks) {
    issue(issues, 'block', 'task_limit_exceeded', `Subtask count (${tasks.length}) exceeds the limit (${limits.maxTasks}).`)
  }
  const budget = cost ? budgetCheck(limits, cost, issues) : []
  return {
    modelCalls,
    tokens: totals,
    cost,
    complete: Boolean(cost?.complete) && callsWithoutModel === 0,
    budget,
    byTask,
  }
}

function previewProjection(preview) {
  return {
    goal: preview.goal,
    project: preview.project,
    model: preview.model,
    budget: preview.budget,
    dag: preview.dag,
    estimate: preview.estimate,
    permissionScope: preview.permissionScope,
    runtime: preview.runtime,
    limits: preview.limits,
    capabilities: preview.capabilities,
    issues: preview.issues,
    pendingConfirmations: preview.pendingConfirmations,
    risks: preview.risks,
    riskLevel: preview.riskLevel,
    status: preview.status,
    canApprove: preview.canApprove,
    sideEffects: preview.sideEffects,
    executionStarted: preview.executionStarted,
  }
}

/**
 * Build a deterministic, side-effect-free preview of a candidate plan.
 *
 * @param {object} input
 * @param {string|object} input.goal
 * @param {object|object[]} input.plan Candidate `{ subtasks }`, `{ tasks }`, or subtask array.
 * @param {object} [input.limits]
 * @param {string[]|object} [input.capabilities]
 * @param {object} [input.pricing]
 * @param {string|object} input.workspace Absolute workspace root or workspace object.
 * @param {object} [input.permissionPolicy]
 * @returns {object} preview
 */
export function createPlanPreview(input = {}) {
  const inputSnapshot = sourceSnapshot(input)
  const issues = []
  const goal = normaliseGoal(inputSnapshot.goal, issues)
  const root = workspaceRoot(inputSnapshot.workspace, issues)
  const policy = isObject(inputSnapshot.permissionPolicy) ? inputSnapshot.permissionPolicy : {}
  const capabilities = unique(capabilityNames(inputSnapshot.capabilities))
  const pricing = isObject(inputSnapshot.pricing) ? inputSnapshot.pricing : {}
  const limits = normaliseLimits(inputSnapshot.limits, issues)
  const runtime = normaliseRuntime(inputSnapshot.workspace, root, policy, capabilities, issues)
  const tasks = normaliseTasks(inputSnapshot.plan, root, capabilities, policy, issues)
  const dag = buildGraph(tasks, issues)
  const estimate = estimatePlan(tasks, pricing, limits, issues)
  const pendingConfirmations = tasks.flatMap(task => task.confirmationIds.map(id => ({
    id: `${task.id}:${id}`,
    taskId: task.id,
    reason: 'The plan explicitly requires confirmation for this task, operation, permission, or shell expansion.',
  })))
  const scope = permissionScope(tasks, root, policy)
  const blocks = issues.filter(item => item.severity === 'block')
  const warnings = issues.filter(item => item.severity === 'warning')
  const status = blocks.length ? 'blocked' : (pendingConfirmations.length ? 'needs_confirmation' : 'ready')
  const riskLevel = blocks.length ? 'high' : (warnings.length || pendingConfirmations.length ? 'medium' : 'low')
  return {
    schemaVersion: VERSION,
    kind: 'plan-preview',
    inputSnapshot,
    planDigest: digest(inputSnapshot),
    goal,
    dag,
    estimate,
    capabilities: { available: capabilities, required: unique(tasks.flatMap(task => task.capabilities)), missing: unique(issues.filter(item => item.code === 'capability_missing').map(item => item.capability)) },
    permissionScope: scope,
    runtime,
    limits,
    risks: issues.map(item => ({ severity: item.severity, code: item.code, message: item.message, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.path ? { path: item.path } : {}) })),
    pendingConfirmations,
    issues,
    blocks,
    warnings,
    riskLevel,
    status,
    canApprove: status !== 'blocked',
    sideEffects: 'none',
    executionStarted: false,
  }
}

/** Alias for callers that prefer a verb-first API. */
export const previewPlan = createPlanPreview

/**
 * Build a side-effect-free preview of a pre-execution candidate plan.
 *
 * Unlike the legacy preview, this API requires permissions and runtime details
 * to be supplied explicitly. Missing values stay null and fail closed; an
 * omitted budget is reported as a warning rather than invented.
 *
 * @param {object} input
 * @param {string|object} input.goal
 * @param {string|object} input.project
 * @param {object[]} input.subtasks
 * @param {string[]|object} [input.capabilities]
 * @param {number|object} [input.budget]
 * @param {string|object} [input.model] Model name or `{ name, pricing }`.
 * @param {{tools:string[]|object,allow:string[]|object,deny:string[]|object,approvalMode:string}} input.permissionScope
 * @param {{cwd:string,isolation:string,provider:string}} input.runtime
 * @returns {object} candidate preview with status `ready` or `blocked`
 */
export function createCandidatePlanPreview(input = {}) {
  const inputSnapshot = candidateSnapshot(input)
  const issues = []
  const goal = normaliseGoal(inputSnapshot.goal, issues)
  if (inputSnapshot.project === null) {
    issue(issues, 'block', 'project_required', 'A project string or object is required.')
  } else if ((typeof inputSnapshot.project !== 'string' && !isObject(inputSnapshot.project))
    || (typeof inputSnapshot.project === 'string' && !inputSnapshot.project.trim())) {
    issue(issues, 'block', 'invalid_project', 'Project must be a non-empty string or an object.')
  }
  const requestedScope = candidatePermissionScope(inputSnapshot.permissionScope, issues)
  const runtimeResult = candidateRuntime(inputSnapshot.runtime, issues)
  const model = candidateModel(inputSnapshot.model, issues)
  const budget = candidateBudget(inputSnapshot.budget, issues)
  const modelSettings = candidateModelSettings(model, inputSnapshot.subtasks, issues)
  const legacy = createPlanPreview({
    goal: inputSnapshot.goal,
    plan: { subtasks: modelSettings.tasks },
    limits: budget.limits,
    capabilities: permissionList(inputSnapshot.capabilities),
    pricing: modelSettings.pricing,
    workspace: runtimeResult.root,
    permissionPolicy: {
      allowedPermissions: requestedScope.allow ?? [],
      deniedPermissions: requestedScope.deny ?? [],
    },
  })
  for (const item of legacy.issues) {
    if (item.code === 'workspace_required' && issues.some(existing => existing.code === item.code)) continue
    if (item.code === 'pricing_missing' && !budget.configured) {
      issues.push({ ...item, severity: 'warning', message: `${item.message} Cost is unknown; no budget was supplied.` })
    } else issues.push(item)
  }
  candidateBudgetCoverage(budget.limits, legacy.estimate.cost, issues)
  const capabilities = legacy.capabilities
  for (const task of legacy.dag.tasks) {
    for (const permission of task.permissions) {
      if (requestedScope.tools !== null && !matches(requestedScope.tools, permission)) {
        issue(issues, 'block', 'tool_not_in_scope', `Subtask ${task.id} requires tool ${permission}, which is outside the requested tool scope.`, { taskId: task.id, permission })
      }
      if (requestedScope.deny !== null && matches(requestedScope.deny, permission)) {
        issue(issues, 'block', 'tool_denied', `Subtask ${task.id} requires denied tool ${permission}.`, { taskId: task.id, permission })
      }
    }
  }
  for (const tool of requestedScope.tools ?? []) {
    if (!matches(capabilities.available, tool)) {
      issue(issues, 'block', 'capability_missing', `Requested tool ${tool} is unavailable.`, { capability: tool })
    }
  }
  for (const confirmation of legacy.pendingConfirmations) {
    issue(issues, 'warning', 'confirmation_required', confirmation.reason, { taskId: confirmation.taskId, confirmationId: confirmation.id })
  }
  const blocks = issues.filter(item => item.severity === 'block')
  const warnings = issues.filter(item => item.severity === 'warning')
  const status = blocks.length ? 'blocked' : 'ready'
  return {
    schemaVersion: VERSION,
    kind: 'candidate-plan-preview',
    inputSnapshot,
    planDigest: digest(inputSnapshot),
    goal,
    project: inputSnapshot.project,
    model: model.value,
    budget: budget.value,
    dag: legacy.dag,
    estimate: candidateEstimate(legacy.estimate, budget.configured),
    capabilities,
    permissionScope: {
      ...requestedScope,
      filesystemRoots: {
        read: permissionAllowed({ allowedPermissions: requestedScope.allow ?? [], deniedPermissions: requestedScope.deny ?? [] }, READ)
          ? legacy.permissionScope.filesystemRoots.read : [],
        write: permissionAllowed({ allowedPermissions: requestedScope.allow ?? [], deniedPermissions: requestedScope.deny ?? [] }, WRITE)
          ? legacy.permissionScope.filesystemRoots.write : [],
      },
      taskScopes: legacy.permissionScope.taskScopes,
    },
    runtime: runtimeResult.value,
    limits: budget.limits,
    pendingConfirmations: legacy.pendingConfirmations,
    issues,
    blocks,
    warnings,
    riskLevel: blocks.length ? 'high' : (warnings.length ? 'medium' : 'low'),
    status,
    canApprove: status === 'ready',
    sideEffects: 'none',
    executionStarted: false,
  }
}

function assertPreviewIntegrity(preview) {
  if (!isObject(preview) || !['plan-preview', 'candidate-plan-preview'].includes(preview.kind) || !isObject(preview.inputSnapshot)) {
    throw new PlanPreviewError('INVALID_PREVIEW', 'Approval requires a plan preview created by this module.')
  }
  const expected = preview.kind === 'candidate-plan-preview'
    ? createCandidatePlanPreview(preview.inputSnapshot)
    : createPlanPreview(preview.inputSnapshot)
  if (preview.planDigest !== expected.planDigest) {
    throw new PlanPreviewError('PLAN_DIGEST_MISMATCH', 'The preview digest does not match its planning inputs.')
  }
  if (stableJson(previewProjection(preview)) !== stableJson(previewProjection(expected))) {
    throw new PlanPreviewError('PLAN_TAMPERED', 'The preview differs from the canonical plan bound to its digest.')
  }
  return expected
}

function confirmations(value) {
  if (!Array.isArray(value)) return []
  return unique(value.map(item => {
    if (typeof item === 'string') return item
    if (isObject(item) && item.confirmed !== false && typeof item.id === 'string') return item.id
    return ''
  }).filter(Boolean))
}

/**
 * Approve an intact, unblocked preview and return a digest-bound artifact.
 * Legacy previews return a normalised execution spec. Candidate previews return
 * only an approval credential containing the approved scope and runtime. This
 * function only creates data; starting a run remains another system's job.
 *
 * @param {object} preview
 * @param {{planDigest: string, confirmations?: Array<string|{id:string}>, approvedBy?: string}|string} approval
 * @returns {object} execution specification or candidate-plan approval credential
 */
export function approvePlan(preview, approval) {
  const request = typeof approval === 'string' ? { planDigest: approval } : approval
  if (!isObject(request) || typeof request.planDigest !== 'string' || !request.planDigest) {
    throw new PlanPreviewError('PLAN_DIGEST_REQUIRED', 'Approval must include the exact plan digest.')
  }
  const expected = assertPreviewIntegrity(preview)
  if (request.planDigest !== expected.planDigest) {
    throw new PlanPreviewError('PLAN_DIGEST_MISMATCH', 'The approval digest does not match this preview.')
  }
  if (expected.status === 'blocked') {
    throw new PlanPreviewError('PLAN_BLOCKED', 'A blocked plan cannot be approved.', { blocks: expected.blocks })
  }
  const acknowledged = confirmations(request.confirmations)
  const missing = expected.pendingConfirmations.filter(item => !acknowledged.includes(item.id))
  if (missing.length) {
    throw new PlanPreviewError('CONFIRMATION_REQUIRED', 'All required plan confirmations must be acknowledged.', { missing })
  }
  if (expected.kind === 'candidate-plan-preview') {
    return canonical({
      schemaVersion: VERSION,
      kind: 'plan-approval-credential',
      state: 'approved',
      planDigest: expected.planDigest,
      approvedBy: typeof request.approvedBy === 'string' ? request.approvedBy : null,
      goal: expected.goal,
      project: expected.project,
      permissionScope: expected.permissionScope,
      runtime: expected.runtime,
      approval: { confirmations: acknowledged },
      executionStarted: false,
    })
  }
  return canonical({
    schemaVersion: VERSION,
    kind: 'execution-spec',
    state: 'approved',
    planDigest: expected.planDigest,
    approvedBy: typeof request.approvedBy === 'string' ? request.approvedBy : null,
    goal: expected.goal,
    dag: expected.dag,
    estimate: expected.estimate,
    limits: expected.limits,
    capabilities: expected.capabilities,
    permissionScope: expected.permissionScope,
    runtime: { ...expected.runtime, mode: 'execute' },
    approval: { confirmations: acknowledged },
    executionStarted: false,
  })
}

/** Alias that makes the returned artifact explicit. */
export const approveExecutionSpec = approvePlan
