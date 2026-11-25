/**
 * Adapter for the Host Schedule service declared by @deepseek-ai/dsh-schedule.
 * Host storage and delivery are authoritative; this module never keeps a timer
 * or a shadow copy of tasks.
 *
 * @module dsh-superagent/host-schedule
 */

const SERVICE_METHODS = ['create', 'list', 'view', 'edit', 'run', 'history', 'deleteInactive']
const PAGE_SIZE = 500

function adapterError(message, code, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.code = code
  return error
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Convert a stored Host timing record back to the management-input shape. */
function timingFromRaw(raw) {
  switch (raw?.kind) {
    case 'after':
      return { kind: 'after', after_seconds: raw.afterSeconds }
    case 'at':
      return { kind: 'at', at: raw.scheduledAt }
    case 'every':
      return { kind: 'every', every_seconds: raw.everySeconds }
    case 'daily':
      return { kind: 'daily', daily: { time: raw.time, time_zone: raw.timeZone } }
    case 'weekly':
      return {
        kind: 'weekly',
        weekly: { time: raw.time, time_zone: raw.timeZone, weekdays: raw.weekdays },
      }
    case 'cron':
      return { kind: 'cron', cron: { expression: raw.expression, time_zone: raw.timeZone } }
    case 'rrule':
      return { kind: 'rrule', rrule: raw.rrule }
    default:
      throw adapterError(
        `Host Schedule returned an unsupported timing kind ${JSON.stringify(raw?.kind)}`,
        'host-schedule-invalid-response',
      )
  }
}

function entryFromRaw(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
    throw adapterError('Host Schedule returned a task without an id', 'host-schedule-invalid-response', raw)
  }
  return {
    id: raw.id,
    title: raw.title,
    prompt: raw.prompt,
    timing: timingFromRaw(raw),
    target: raw.target,
    status: raw.status,
    updatedAt: raw.updatedAt,
  }
}

function timingFromPlan(plan) {
  const schedule = plan?.schedule
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('createFromPlan needs plan.schedule')
  }
  const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : ''
  const hasEvery = schedule.everyMinutes !== undefined && schedule.everyMinutes !== null && schedule.everyMinutes !== ''
  if (cron && hasEvery) throw new Error('createFromPlan takes plan.schedule.cron or everyMinutes, not both')
  if (cron) {
    const timeZone = String(schedule.timeZone ?? 'UTC').trim() || 'UTC'
    return { kind: 'cron', cron: { expression: cron, time_zone: timeZone } }
  }
  if (!hasEvery) throw new Error('createFromPlan needs plan.schedule.cron or everyMinutes')
  const minutes = Number(schedule.everyMinutes)
  const seconds = minutes * 60
  if (!Number.isSafeInteger(minutes) || minutes < 1 || !Number.isSafeInteger(seconds)) {
    throw new Error('createFromPlan everyMinutes must be a positive safe integer')
  }
  return { kind: 'every', every_seconds: seconds }
}

/** Keep the prompt executable without serializing owner/session identities. */
function promptFromPlan(plan) {
  const goal = typeof plan.goal === 'string' ? plan.goal.trim() : ''
  if (!goal) throw new Error('createFromPlan needs plan.goal')
  if (Object.values(plan.budget ?? {}).some(value => value != null)) {
    throw new Error('Host Schedule cannot enforce the plugin plan budget; keep this plan local')
  }
  if (plan.schedule?.missPolicy === 'none' || plan.concurrency?.humanPriority === false) {
    throw new Error('Host Schedule cannot preserve this missed-run or priority policy; keep this plan local')
  }
  const mode = plan.mode === undefined || plan.mode === null ? 'planned' : String(plan.mode).trim()
  if (mode !== 'planned' && mode !== 'direct') {
    throw new Error(`createFromPlan mode "${mode}" is unknown; use "planned" or "direct"`)
  }
  const args = {
    goal,
    mode,
    allow_duplicate: true,
    scheduled: true,
    reserve_slot: plan.concurrency?.humanPriority !== false,
    schedule_id: `host:${plan.id}`,
  }
  if (plan.goalMode) {
    args.goal_mode = true
    args.acceptance = plan.goalMode.acceptance
    args.max_rounds = plan.goalMode.maxRounds
    args.max_wall_clock_minutes = plan.goalMode.maxWallClockMinutes
    args.no_progress_rounds = plan.goalMode.noProgressRounds
    if (Object.values(plan.goalMode.budget ?? {}).some(value => value != null)) {
      throw new Error('Host Schedule cannot enforce the plugin goal-mode budget; keep this plan local')
    }
  }
  return [
    'This scheduled message is a recurring trigger. Start the run now; do not create, edit, pause, resume, or delete schedules.',
    'If superagent_start is not visible, call superagent_help first. Then call superagent_start with the recovered arguments below.',
    JSON.stringify(args, null, 2),
  ].join('\n\n')
}

/**
 * @param {object} options
 * @param {object} options.schedule - Host context containing `schedule`, or the service itself.
 * @param {Function|{warn?: Function}} [options.log] - Diagnostic sink; failures still reject.
 */
export function createHostScheduleAdapter({ schedule: host, log } = {}) {
  function service() {
    try {
      // Accepting the service directly also supports embedders that already resolved ctx.schedule.
      let value = typeof host === 'function' ? host() : host
      if (value && typeof value === 'object' && 'schedule' in value) value = value.schedule
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }

  function missingMethods(value) {
    return value ? SERVICE_METHODS.filter(name => typeof value[name] !== 'function') : [...SERVICE_METHODS]
  }

  function available() {
    return missingMethods(service()).length === 0
  }

  function report(operation, error) {
    const message = `[dsh-superagent] Host Schedule ${operation} failed: ${messageOf(error)}`
    try {
      if (typeof log === 'function') log(message)
      else if (typeof log?.warn === 'function') log.warn(message)
      else if (typeof log?.error === 'function') log.error(message)
    } catch {
      // Diagnostics must never replace the operation's original rejection.
    }
  }

  function requireService(operation) {
    const value = service()
    const missing = missingMethods(value)
    if (missing.length > 0) {
      throw adapterError(
        `Host Schedule is unavailable for ${operation}: ctx.schedule is missing required method(s) ${missing.join(', ')}; no local fallback`,
        'host-schedule-unavailable',
      )
    }
    return value
  }

  async function invoke(operation, method, args) {
    try {
      const value = requireService(operation)
      return await value[method](...args)
    } catch (error) {
      report(operation, error)
      throw error
    }
  }

  function requireTask(raw, operation) {
    if (raw && typeof raw.code === 'string') {
      throw adapterError(
        `Host Schedule ${operation} refused: ${raw.code}${raw.id ? ` (${raw.id})` : ''}`,
        raw.code,
        raw,
      )
    }
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) {
      throw adapterError(`Host Schedule ${operation} returned an invalid task`, 'host-schedule-invalid-response', raw)
    }
    return raw
  }

  async function createFromPlan(plan, sessionId) {
    const targetSessionId = String(sessionId ?? '').trim()
    if (!targetSessionId) throw new Error('createFromPlan needs sessionId for the Host Schedule session target')
    const timing = timingFromPlan(plan)
    const prompt = promptFromPlan(plan)
    const title = typeof plan?.name === 'string' ? plan.name.trim() : ''
    if (!title) throw new Error('createFromPlan needs plan.name')
    const raw = requireTask(await invoke('create', 'create', [{
      title,
      prompt,
      timing,
      target: { kind: 'session', sessionId: targetSessionId },
    }, targetSessionId]), 'create')
    return { id: raw.id, raw }
  }

  async function list() {
    const first = await invoke('list', 'list', [{ limit: PAGE_SIZE, offset: 0 }])
    if (!first || !Array.isArray(first.items)) {
      throw adapterError('Host Schedule list returned an invalid page', 'host-schedule-invalid-response', first)
    }
    const items = [...first.items]
    const total = first.total === undefined ? items.length : Number(first.total)
    if (!Number.isSafeInteger(total) || total < 0) {
      throw adapterError('Host Schedule list returned an invalid total', 'host-schedule-invalid-response', first)
    }
    for (let offset = items.length; offset < total; offset += PAGE_SIZE) {
      const page = await invoke('list', 'list', [{ limit: PAGE_SIZE, offset }])
      if (!page || !Array.isArray(page.items) || page.items.length === 0) {
        throw adapterError('Host Schedule list ended before its reported total', 'host-schedule-invalid-response', page)
      }
      items.push(...page.items)
    }
    return items.map(entryFromRaw)
  }

  async function pause(id) {
    const raw = requireTask(await invoke('pause', 'edit', [{ id, action: 'update', patch: { active: false } }]), 'pause')
    return { id: raw.id, raw }
  }

  async function resume(id) {
    const raw = requireTask(await invoke('resume', 'edit', [{ id, action: 'update', patch: { active: true } }]), 'resume')
    return { id: raw.id, raw }
  }

  async function remove(id) {
    const raw = requireTask(await invoke('remove', 'edit', [{ id, action: 'delete' }]), 'remove')
    return { id: raw.id, raw }
  }

  async function runNow(id) {
    const raw = requireTask(await invoke('runNow', 'run', [{ id }]), 'runNow')
    return { id: raw.id, raw }
  }

  async function view(id) {
    const raw = requireTask(await invoke('view', 'view', [{ id }]), 'view')
    return { id: raw.id, raw }
  }

  async function history(id, limit = 100, before) {
    const request = { id, limit, ...(before === undefined ? {} : { before }) }
    const raw = await invoke('history', 'history', [request])
    if (raw && typeof raw.code === 'string') {
      throw adapterError(`Host Schedule history refused: ${raw.code}`, raw.code, raw)
    }
    return raw
  }

  async function deleteInactive() {
    return invoke('deleteInactive', 'deleteInactive', [])
  }

  return { available, createFromPlan, list, pause, resume, remove, runNow, view, history, deleteInactive }
}
