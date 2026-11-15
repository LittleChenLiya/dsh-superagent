/**
 * Scheduled runs: a plan that starts a run by itself, without a tool call.
 *
 * This module owns the plan record, its durable state, the cron/interval clock,
 * the missed-window policy, overlap suppression, the per-plan budget, failure
 * backoff, and the notification decision. The orchestrator stays the only way a
 * run starts: a schedule is a caller that happens to be a timer, so quota,
 * queueing, budgets, cancel, usage, and the report are the same as for a run a
 * person started.
 *
 * Everything is off until a plan exists. `init()` on an empty state directory
 * starts no timer and writes no file, which is why installing this version
 * changes nothing for someone who never calls `superagent_schedule`.
 *
 * Time zones and the clock are injectable so tests never depend on the host's
 * real time, and the next-run computation goes through `cron.js` so a plan is
 * evaluated in the zone it was written in, not the zone the host is in.
 *
 * @module dsh-superagent/schedule
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { nextCronTime, parseCron, validateTimeZone } from './cron.js'
import { normalizeGoalSpec } from './goal.js'
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from './store.js'

/** Only the newest due window is run after downtime unless the plan says otherwise. */
export const DEFAULT_MISS_POLICY = 'latest'
/** Consecutive failures before the plan pauses and says so once. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
/** How often the timer looks at the plans, in seconds. */
export const DEFAULT_TICK_SECONDS = 30
/** Bounded evidence kept per plan, so a long-lived schedule cannot grow forever. */
const HISTORY_LIMIT = 40
const MISS_LIMIT = 20
const MAX_CATCHUP_STEPS = 2000
const STATE_VERSION = 1
const MISS_POLICIES = new Set(['latest', 'none'])
const OWNER_RECOVERY = new Set(['resume', 'create', 'none'])

function oneLine(value, maxChars = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= maxChars ? text : [...text].slice(0, maxChars).join('')
}

function numberIn(value, { label, min, max, fallback = null }) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number, got ${JSON.stringify(value)}`)
  const whole = Math.trunc(number)
  if (whole < min || whole > max) throw new Error(`${label} must be between ${min} and ${max}, got ${whole}`)
  return whole
}

function normalizeBudget(raw) {
  const empty = {
    maxModelCalls: null,
    maxTokens: null,
    maxTotalModelCalls: null,
    maxTotalTokens: null,
    maxTotalRuns: null,
  }
  if (raw === undefined || raw === null) return empty
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('budget must be an object with max_model_calls, max_tokens, max_total_tokens, max_total_runs')
  }
  return {
    maxModelCalls: numberIn(raw.maxModelCalls, { label: 'budget.maxModelCalls', min: 1, max: 10000 }),
    maxTokens: numberIn(raw.maxTokens, { label: 'budget.maxTokens', min: 1, max: 1e12 }),
    maxTotalModelCalls: numberIn(raw.maxTotalModelCalls, { label: 'budget.maxTotalModelCalls', min: 1, max: 1e9 }),
    maxTotalTokens: numberIn(raw.maxTotalTokens, { label: 'budget.maxTotalTokens', min: 1, max: 1e15 }),
    maxTotalRuns: numberIn(raw.maxTotalRuns, { label: 'budget.maxTotalRuns', min: 1, max: 1e6 }),
  }
}

/**
 * Validate one create request into the canonical plan shape.
 *
 * Cron errors are raised here, not when the first window is due: a plan that
 * cannot be parsed must not be persisted as if it were fine. The error carries
 * the 1-based field number from `CronError`.
 *
 * @param {object} input - camelCase create request from the tool layer.
 * @param {{ now: () => number }} options - injected clock.
 * @returns {object} plan ready to persist.
 */
export function normalizeScheduleInput(input = {}, { now }) {
  const name = oneLine(input.name, 80)
  if (!name) throw new Error('name is required; it is what the plan is called in list and in notifications')
  const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
  if (!goal) throw new Error('goal is required; a schedule without a goal would start an empty run')
  if (goal.length > 8000) throw new Error('goal is longer than 8000 characters')

  const cron = typeof input.cron === 'string' && input.cron.trim() ? input.cron.trim() : null
  const everyMinutes = numberIn(input.everyMinutes, { label: 'everyMinutes', min: 1, max: 10080 })
  if (cron && everyMinutes) throw new Error('a schedule takes cron or everyMinutes, not both')
  if (!cron && !everyMinutes) throw new Error('a schedule needs cron (5 fields) or everyMinutes (a fixed interval)')
  const spec = cron ? parseCron(cron) : null

  const timeZone = validateTimeZone(input.timeZone ?? 'UTC')
  const missPolicyRaw = String(input.missPolicy ?? DEFAULT_MISS_POLICY).trim().toLowerCase()
  if (!MISS_POLICIES.has(missPolicyRaw)) {
    throw new Error(`missPolicy "${input.missPolicy}" is unknown; use "latest" (default) or "none"`)
  }
  const mode = input.mode === undefined || input.mode === null ? 'planned' : String(input.mode).trim().toLowerCase()
  if (mode !== 'planned' && mode !== 'direct') throw new Error(`mode "${input.mode}" is unknown; use "planned" or "direct"`)

  const goalMode = input.goalMode === undefined || input.goalMode === null ? null : normalizeGoalSpec(input.goalMode)
  const budget = normalizeBudget(input.budget)
  const humanPriority = input.humanPriority === undefined || input.humanPriority === null
    ? true
    : Boolean(input.humanPriority)
  const ownerSessionId = String(input.ownerSessionId ?? '').trim()
  if (!ownerSessionId) {
    throw new Error('ownerSessionId is required: a scheduled run is owned by a live session, and the scheduler cannot invent one')
  }
  const ownerRecovery = input.ownerRecovery === undefined || input.ownerRecovery === null
    ? null
    : String(input.ownerRecovery).trim().toLowerCase()
  if (ownerRecovery !== null && !OWNER_RECOVERY.has(ownerRecovery)) {
    throw new Error(`ownerRecovery "${input.ownerRecovery}" is unknown; use "resume", "create", or "none"`)
  }

  const createdAt = new Date(now()).toISOString()
  const plan = {
    id: `sch-${randomUUID().slice(0, 8)}`,
    schemaVersion: STATE_VERSION,
    name,
    goal,
    mode,
    enabled: true,
    pausedReason: null,
    schedule: {
      cron: cron ? spec.expression : null,
      everyMinutes,
      timeZone,
      missPolicy: missPolicyRaw,
    },
    goalMode,
    budget,
    concurrency: { humanPriority },
    ownerSessionId,
    // How the host can recover the owner after a restart. "none" is recorded
    // at create time so the plan never passes for portable when it is not.
    ownerRecovery,
    requiresLiveSession: ownerRecovery === 'none',
    cwd: input.cwd ? path.resolve(String(input.cwd)) : null,
    createdAt,
    updatedAt: createdAt,
    nextRunAt: null,
    lastRunAt: null,
    lastAttemptAt: null,
    lastRunId: null,
    lastStatus: null,
    lastOutcome: null,
    lastReason: null,
    activeRunId: null,
    consecutiveFailures: 0,
    totalRuns: 0,
    catchUpRuns: 0,
    skippedRuns: 0,
    totalTokens: 0,
    totalModelCalls: 0,
    missedRuns: 0,
    misses: [],
    history: [],
    lastDeferAt: null,
    ownerBlocked: false,
  }
  plan.nextRunAt = new Date(
    spec ? nextCronTime(spec, now(), timeZone) : now() + everyMinutes * 60000,
  ).toISOString()
  return plan
}

/** Persisted fields added after v1 must read as defaults, not as `undefined`. */
function migratePlan(raw) {
  const plan = { ...raw }
  plan.schedule = { missPolicy: DEFAULT_MISS_POLICY, timeZone: 'UTC', cron: null, everyMinutes: null, ...(raw.schedule ?? {}) }
  plan.budget = normalizeBudget(raw.budget)
  plan.concurrency = { humanPriority: true, ...(raw.concurrency ?? {}) }
  plan.history = Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : []
  plan.misses = Array.isArray(raw.misses) ? raw.misses.slice(-MISS_LIMIT) : []
  plan.enabled = raw.enabled !== false
  plan.pausedReason = typeof raw.pausedReason === 'string' ? raw.pausedReason : null
  plan.consecutiveFailures = Number(raw.consecutiveFailures) || 0
  plan.totalRuns = Number(raw.totalRuns) || 0
  plan.catchUpRuns = Number(raw.catchUpRuns) || 0
  plan.skippedRuns = Number(raw.skippedRuns) || 0
  plan.totalTokens = Number(raw.totalTokens) || 0
  plan.totalModelCalls = Number(raw.totalModelCalls) || 0
  plan.missedRuns = Number(raw.missedRuns) || 0
  plan.activeRunId = raw.activeRunId ?? null
  plan.goalMode = raw.goalMode ?? null
  plan.ownerRecovery = OWNER_RECOVERY.has(raw.ownerRecovery) ? raw.ownerRecovery : null
  plan.requiresLiveSession = raw.requiresLiveSession === true || plan.ownerRecovery === 'none'
  plan.ownerBlocked = raw.ownerBlocked === true
  plan.cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : null
  return plan
}

/**
 * Build the scheduler bound to one state directory.
 *
 * @param {object} options - dependencies and defaults.
 * @param {string} options.stateFile - `<stateDir>/schedules.json`.
 * @param {object} options.orchestrator - `{ start, status }`, normally the real orchestrator.
 * @param {(plan: object) => Promise<object | null> | object | null} [options.resolveOwner] -
 *   the agent that owns a run for this plan. Called for every window, so it may
 *   restore a persisted session or create a fresh one after a host restart. It
 *   may return an agent, `{ agent, sessionId }` (when the restored session has a
 *   different id), or null when the host cannot provide one.
 * @param {(input: { event: string, plan: object, run: object | null, message: string }) => Promise<unknown>} [options.notify]
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {(fn: () => void, ms: number) => unknown} [options.setInterval] - timer, injectable for tests.
 * @param {(timer: unknown) => void} [options.clearInterval] - cancels that timer.
 * @param {number} [options.tickSeconds] - how often the timer calls `tick`.
 * @param {boolean} [options.humanPriority] - reserve a concurrency slot for manual runs.
 * @param {number} [options.maxConsecutiveFailures] - failures before the plan pauses.
 * @param {number} [options.maxActiveRuns] - operator quota, used for reporting and the reserved slot.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 */
export function createScheduler({
  stateFile,
  orchestrator,
  resolveOwner = () => null,
  notify = async () => {},
  now = () => Date.now(),
  setInterval: setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearInterval: clearIntervalFn = timer => clearInterval(timer),
  tickSeconds = DEFAULT_TICK_SECONDS,
  humanPriority = true,
  maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  maxActiveRuns = 2,
  warn = () => {},
}) {
  if (!stateFile) throw new Error('createScheduler needs a stateFile')
  if (!orchestrator || typeof orchestrator.start !== 'function' || typeof orchestrator.status !== 'function') {
    throw new Error('createScheduler needs an orchestrator with start() and status()')
  }

  /** @type {Map<string, object>} */
  const plans = new Map()
  const parsed = new Map()
  let loaded = false
  let timer = null
  let gate = Promise.resolve()
  let ticking = false

  function serialize(task) {
    const result = gate.then(task, task)
    gate = result.catch(() => {})
    return result
  }

  function clone(value) {
    return structuredClone(value)
  }

  function record(plan, event, reason = null) {
    plan.history.push({ at: new Date(now()).toISOString(), event, reason })
    plan.history = plan.history.slice(-HISTORY_LIMIT)
    plan.updatedAt = new Date(now()).toISOString()
  }

  function parsedFor(plan) {
    if (!plan.schedule.cron) return null
    const key = `${plan.schedule.cron}\u0000${plan.schedule.timeZone}`
    let spec = parsed.get(key)
    if (!spec) {
      spec = parseCron(plan.schedule.cron)
      parsed.set(key, spec)
    }
    return spec
  }

  /** Next planned instant strictly after `afterMs`, in the plan's own zone. */
  function nextTimeFor(plan, afterMs) {
    if (plan.schedule.everyMinutes) return afterMs + plan.schedule.everyMinutes * 60000
    return nextCronTime(parsedFor(plan), afterMs, plan.schedule.timeZone)
  }

  async function load() {
    if (loaded) return
    loaded = true
    let raw
    try {
      raw = await fsp.readFile(stateFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`cannot read the schedule file ${stateFile}: ${error?.message ?? error}`)
      return
    }
    let parsedState
    try {
      parsedState = JSON.parse(raw)
    } catch (error) {
      // Keep the evidence instead of overwriting a file a human may be able to
      // repair; starting empty means the plugin still mounts.
      const kept = `${stateFile}.corrupt-${Date.now()}`
      await fsp.rename(stateFile, kept).catch(() => {})
      warn(`the schedule file ${stateFile} is not valid JSON (${error?.message ?? error}); kept it at ${kept}`)
      return
    }
    const entries = Array.isArray(parsedState?.plans) ? parsedState.plans : []
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue
      let plan
      try {
        plan = migratePlan(entry)
        // A hand-edited cron must not fire a wrong plan; disabling it is visible
        // in list, while mounting with an exception would break every tool.
        if (plan.schedule.cron) parseCron(plan.schedule.cron)
        validateTimeZone(plan.schedule.timeZone)
      } catch (error) {
        warn(`schedule ${entry.id} in ${stateFile} cannot be used: ${error?.message ?? error}`)
        continue
      }
      plans.set(plan.id, plan)
    }
  }

  async function persist() {
    const state = {
      version: STATE_VERSION,
      savedAt: new Date(now()).toISOString(),
      plans: [...plans.values()],
    }
    const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`
    await fsp.mkdir(path.dirname(stateFile), { recursive: true })
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await fsp.rename(tmp, stateFile)
  }

  function ensureTimer() {
    const wanted = [...plans.values()].some(plan => plan.enabled)
    if (wanted && !timer) {
      timer = setIntervalFn(() => {
        tick().catch(error => warn(`scheduled tick failed: ${error?.message ?? error}`))
      }, Math.max(1, Number(tickSeconds) || DEFAULT_TICK_SECONDS) * 1000)
      timer?.unref?.()
      return
    }
    if (!wanted && timer) {
      clearIntervalFn(timer)
      timer = null
    }
  }

  function requirePlan(id) {
    const key = String(id ?? '').trim()
    if (!key) throw new Error('a schedule id is required; call action="list" to see the ids')
    const plan = plans.get(key)
    if (!plan) throw new Error(`no schedule with id "${key}"; call action="list" to see the ids`)
    return plan
  }

  /** Why this plan may not start another run, or null when it still can. */
  function budgetBlock(plan) {
    const budget = plan.budget ?? {}
    if (budget.maxTotalRuns && plan.totalRuns >= budget.maxTotalRuns) {
      return `run limit reached (${plan.totalRuns}/${budget.maxTotalRuns} runs)`
    }
    if (budget.maxTotalModelCalls && plan.totalModelCalls >= budget.maxTotalModelCalls) {
      return `model-call budget reached (${plan.totalModelCalls}/${budget.maxTotalModelCalls} calls)`
    }
    if (budget.maxTotalTokens && plan.totalTokens >= budget.maxTotalTokens) {
      return `token budget reached (${plan.totalTokens}/${budget.maxTotalTokens} tokens)`
    }
    return null
  }

  async function readRun(runId) {
    if (!runId) return null
    try {
      return await orchestrator.status(runId)
    } catch {
      return null
    }
  }

  function messageFor(plan, event, detail, run) {
    const head = `[superagent] schedule "${plan.name}" (${plan.id}): ${event}`
    const lines = [detail ? `${head} — ${detail}` : head]
    if (run?.id) lines.push(`Run: ${run.id}.`)
    if (!plan.enabled) {
      lines.push(`The plan is paused${plan.pausedReason ? ` (${plan.pausedReason})` : ''}; resume it with superagent_schedule action="resume".`)
    } else if (plan.nextRunAt) {
      lines.push(`Next run: ${plan.nextRunAt}.`)
    }
    lines.push('Call superagent_schedule action="list" for the plan and superagent_status for the run report.')
    return lines.join(' ')
  }

  async function safeNotify(plan, event, detail, run) {
    try {
      await notify({ event, plan: clone(plan), run: run ? clone(run) : null, message: messageFor(plan, event, detail, run) })
    } catch (error) {
      warn(`cannot deliver the "${event}" notification for schedule ${plan.id}: ${error?.message ?? error}`)
    }
  }

  /**
   * Turn a finished run into the plan's outcome, and decide whether the user
   * hears about it. Notifications are the exception: an achieved goal, a first
   * failure, a budget stop, an open decision, and the pause after repeated
   * failures. The failure in between is recorded in history and stays silent.
   */
  async function applyOutcome(plan, run) {
    plan.activeRunId = null
    if (!run) {
      plan.lastStatus = 'missing'
      plan.lastOutcome = 'failed'
      plan.lastReason = 'the run record disappeared from the state directory'
      await recordFailure(plan, plan.lastReason, null)
      return
    }
    plan.lastStatus = run.status
    const usage = run.usage ?? null
    if (usage) {
      plan.totalTokens += Number(usage.totalTokens) || 0
      plan.totalModelCalls += Number(usage.modelCalls) || 0
    }
    const open = (run.attention?.items ?? []).find(item => !item.answer) ?? null
    const budgetish = run.goalMode?.stop?.reason === 'budget'
      || /budget/i.test(String(run.error ?? ''))
      || /budget/i.test(String(run.goalMode?.stop?.detail ?? ''))
    let outcome
    if (open) outcome = 'needs-decision'
    else if (budgetish) outcome = 'budget'
    else if (run.status === 'completed') outcome = 'achieved'
    else if (run.status === 'cancelled') outcome = 'cancelled'
    else outcome = 'failed'

    if (outcome === 'achieved') {
      plan.consecutiveFailures = 0
      plan.lastOutcome = 'achieved'
      plan.lastReason = 'the run completed'
      record(plan, 'achieved', plan.lastReason)
      await safeNotify(plan, 'achieved', 'the run completed', run)
      return outcome
    }
    if (outcome === 'budget') {
      plan.enabled = false
      plan.pausedReason = `budget reached: ${oneLine(run.error ?? run.goalMode?.stop?.detail ?? 'the run hit its budget', 200)}`
      plan.lastOutcome = 'budget'
      plan.lastReason = plan.pausedReason
      record(plan, 'budget', plan.pausedReason)
      await safeNotify(plan, 'budget', plan.pausedReason, run)
      return outcome
    }
    if (outcome === 'needs-decision') {
      plan.enabled = false
      plan.pausedReason = `needs a decision: ${oneLine(open.question, 200)}`
      plan.lastOutcome = 'needs-decision'
      plan.lastReason = plan.pausedReason
      record(plan, 'needs-decision', plan.pausedReason)
      await safeNotify(plan, 'needs-decision', plan.pausedReason, run)
      return outcome
    }
    if (outcome === 'cancelled') {
      plan.lastOutcome = 'cancelled'
      plan.lastReason = 'the run was cancelled; a cancelled run is not announced'
      record(plan, 'cancelled', plan.lastReason)
      return outcome
    }
    const reason = oneLine(run.error ?? run.goalMode?.stop?.detail ?? `the run ended as ${run.status}`, 300)
    await recordFailure(plan, reason, run)
    return outcome
  }

  /**
   * A failure increments the streak. Only the first failure of a streak is
   * announced; the pause at the limit is announced once. That is the backoff:
   * a plan failing every half hour cannot wake the session every half hour.
   */
  async function recordFailure(plan, reason, run) {
    plan.consecutiveFailures = (Number(plan.consecutiveFailures) || 0) + 1
    plan.lastOutcome = 'failed'
    plan.lastReason = reason
    record(plan, 'failed', reason)
    if (plan.consecutiveFailures === 1) {
      await safeNotify(plan, 'failed', reason, run)
    }
    const limit = Math.max(1, Number(maxConsecutiveFailures) || DEFAULT_MAX_CONSECUTIVE_FAILURES)
    if (plan.consecutiveFailures >= limit) {
      plan.enabled = false
      plan.pausedReason = `paused after ${plan.consecutiveFailures} consecutive failure(s): ${reason}`
      record(plan, 'paused', plan.pausedReason)
      await safeNotify(plan, 'paused', plan.pausedReason, run)
    }
  }

  /** Per-run limits: the run's own budget stop and the plan's ceiling. */
  function startArgsFor(plan, parent, ownerSessionId) {
    const goalBudget = {}
    const calls = plan.budget.maxModelCalls ?? plan.goalMode?.budget?.maxModelCalls ?? null
    const tokens = plan.budget.maxTokens ?? plan.goalMode?.budget?.maxTokens ?? null
    if (calls !== null) goalBudget.maxModelCalls = calls
    if (tokens !== null) goalBudget.maxTokens = tokens
    return {
      goal: plan.goal,
      parentSessionId: ownerSessionId,
      parent,
      mode: plan.mode,
      allowDuplicate: true,
      queue: false,
      goalMode: plan.goalMode ? { ...plan.goalMode, budget: Object.keys(goalBudget).length ? goalBudget : null } : null,
      overrides: {
        maxModelCalls: plan.budget.maxModelCalls ?? undefined,
        maxTokens: plan.budget.maxTokens ?? undefined,
      },
      origin: { kind: 'scheduled', scheduleId: plan.id, scheduleName: plan.name },
      reserveSlot: plan.concurrency.humanPriority !== false && humanPriority,
      muted: true,
    }
  }

  /**
   * The agent a run for this plan should be owned by.
   *
   * A plan outlives the host process that created it, so the session is asked
   * for again on every window: a live agent is used as is, a persisted one is
   * resumed, and (when the host allows it) a fresh session is created. When the
   * id changes, the plan adopts the new one so later windows and notifications
   * do not look at a dead session.
   *
   * @param {object} plan - plan whose window is firing.
   * @returns {Promise<{agent: object | null, reason: string | null}>}
   */
  async function ownerFor(plan) {
    let resolved = null
    let failure = null
    try {
      resolved = await resolveOwner(plan)
    } catch (error) {
      failure = oneLine(error?.message ?? error, 300)
    }
    const agent = resolved?.agent ?? resolved
    if (agent && typeof agent === 'object' && agent.id) {
      const sessionId = typeof resolved?.sessionId === 'string' && resolved.sessionId
        ? resolved.sessionId
        : plan.ownerSessionId
      if (sessionId !== plan.ownerSessionId) {
        record(plan, 'owner-recovered', `the plan now runs as session ${sessionId}`)
        plan.ownerSessionId = sessionId
      }
      if (plan.ownerBlocked) {
        plan.ownerBlocked = false
        record(plan, 'owner-restored', `session ${sessionId} is usable again`)
      }
      return { agent, reason: null }
    }
    return { agent: null, reason: failure ?? `the owning session ${plan.ownerSessionId} is not live` }
  }

  /** Start one run for `dueAt`; returns `{ run }` or a skip/defer record. */
  async function startPlan(plan, dueAt, { catchUp = false, missedCount = 0 } = {}) {
    const owner = await ownerFor(plan)
    if (!owner.agent) {
      const reason = `${owner.reason}, so the scheduled run has no agent to own its children`
      plan.nextRunAt = new Date(nextTimeFor(plan, dueAt)).toISOString()
      plan.lastOutcome = 'failed'
      plan.lastReason = reason
      // A host without a way to restore a session is known at create time. It
      // must not look like a run failing on its own terms, and it must not
      // silently pause: the window is recorded as blocked and announced once.
      if (plan.requiresLiveSession || plan.ownerRecovery === 'none') {
        plan.lastOutcome = 'blocked'
        if (!plan.ownerBlocked) {
          plan.ownerBlocked = true
          record(plan, 'blocked', `${reason}; this host requires a resident session for scheduled runs`)
          await safeNotify(plan, 'blocked', `${reason}; keep that session open or run the plan from a resident host`, null)
        }
        return { event: 'blocked', reason }
      }
      await recordFailure(plan, reason, null)
      return { event: 'failed', reason }
    }
    try {
      const run = await orchestrator.start(startArgsFor(plan, owner.agent, plan.ownerSessionId))
      plan.nextRunAt = new Date(nextTimeFor(plan, dueAt)).toISOString()
      plan.lastRunAt = new Date(dueAt).toISOString()
      plan.lastAttemptAt = new Date(now()).toISOString()
      plan.lastRunId = run.id
      plan.lastStatus = run.status
      plan.activeRunId = run.id
      plan.totalRuns += 1
      if (catchUp) {
        plan.catchUpRuns += 1
        record(plan, 'started', `catch-up run ${run.id} for the ${new Date(dueAt).toISOString()} window, `
          + `after ${missedCount} missed window(s)`)
      } else {
        record(plan, 'started', `run ${run.id} for the ${new Date(dueAt).toISOString()} window`)
      }
      return { event: 'started', run }
    } catch (error) {
      if (error?.code === 'scheduled-deferred') {
        // The due window is not consumed: the next tick tries again once the
        // manual run that holds the reserved slot has finished.
        plan.lastOutcome = 'deferred'
        plan.lastReason = oneLine(error.message, 300)
        if (plan.lastDeferAt !== plan.nextRunAt) {
          plan.lastDeferAt = plan.nextRunAt
          record(plan, 'deferred', plan.lastReason)
        }
        return { event: 'deferred', reason: plan.lastReason }
      }
      plan.nextRunAt = new Date(nextTimeFor(plan, dueAt)).toISOString()
      const reason = oneLine(error?.message ?? error, 300)
      plan.lastOutcome = 'failed'
      plan.lastReason = reason
      await recordFailure(plan, reason, null)
      return { event: 'failed', reason }
    }
  }

  /**
   * How many windows were missed and which one is the newest.
   *
   * A long downtime can cover thousands of windows. Only the newest is a
   * candidate to run; the rest are counted and recorded as missed. The loop is
   * bounded so an expression that matches every minute cannot make one tick
   * spend minutes computing history.
   */
  function dueWindows(plan, firstDue, at) {
    let latest = firstDue
    let missed = 0
    for (let step = 0; step < MAX_CATCHUP_STEPS; step++) {
      let next
      try {
        next = nextTimeFor(plan, latest)
      } catch {
        break
      }
      if (!Number.isFinite(next) || next > at) break
      latest = next
      missed += 1
    }
    if (missed >= MAX_CATCHUP_STEPS) return { latestDue: at, missed, capped: true }
    return { latestDue: latest, missed, capped: false }
  }

  function recordMissed(plan, missed, latestDue, capped) {
    if (missed <= 0) return
    plan.missedRuns += missed
    const latestIso = new Date(latestDue).toISOString()
    const reason = capped
      ? `host was not running for at least ${missed} window(s); miss policy "${plan.schedule.missPolicy}" runs only the newest, now`
      : `host was not running for ${missed} window(s); miss policy "${plan.schedule.missPolicy}" kept only the ${latestIso} window`
    plan.misses.push({ at: new Date(now()).toISOString(), count: missed, latestDue: latestIso, policy: plan.schedule.missPolicy, reason })
    plan.misses = plan.misses.slice(-MISS_LIMIT)
    record(plan, 'missed', reason)
  }

  async function tickPlan(plan, at) {
    if (!plan.enabled) return null
    if (plan.activeRunId) {
      const run = await readRun(plan.activeRunId)
      if (run && ACTIVE_STATUSES.has(run.status)) {
        const due = Date.parse(plan.nextRunAt ?? '')
        if (!Number.isFinite(due) || due > at) return null
        // Requirement: no second run while the previous one is still working.
        plan.nextRunAt = new Date(nextTimeFor(plan, at)).toISOString()
        plan.lastOutcome = 'skipped'
        plan.lastReason = 'skipped: previous run still active'
        plan.lastAttemptAt = new Date(now()).toISOString()
        plan.skippedRuns += 1
        record(plan, 'skipped', `${plan.lastReason} (${run.id})`)
        return { event: 'skipped', reason: plan.lastReason, runId: run.id }
      }
      const outcome = await applyOutcome(plan, run)
      // A failure limit, a budget stop, or an open decision pauses the plan.
      // Applying the outcome must not then start another window in the same tick.
      if (!plan.enabled) return { event: outcome ?? 'paused', reason: plan.lastReason }
    }
    const blocked = budgetBlock(plan)
    if (blocked) {
      plan.enabled = false
      plan.pausedReason = `budget reached: ${blocked}`
      plan.lastOutcome = 'budget'
      plan.lastReason = plan.pausedReason
      record(plan, 'budget', plan.pausedReason)
      await safeNotify(plan, 'budget', plan.pausedReason, null)
      return { event: 'budget', reason: plan.pausedReason }
    }
    let due = Date.parse(plan.nextRunAt ?? '')
    if (!Number.isFinite(due)) {
      plan.nextRunAt = new Date(nextTimeFor(plan, at)).toISOString()
      return null
    }
    if (due > at) return null
    const { latestDue, missed, capped } = dueWindows(plan, due, at)
    if (plan.schedule.missPolicy === 'none') {
      // "none" also skips the window that is due right now, so the count that
      // goes into the report is the discarded history plus this one.
      recordMissed(plan, missed + 1, latestDue, capped)
      // Stay on the plan's own grid: the next window after the newest missed
      // one, not "one interval from the moment the host happened to notice".
      plan.nextRunAt = new Date(nextTimeFor(plan, latestDue)).toISOString()
      return { event: 'missed', missed: missed + 1, reason: plan.misses.at(-1)?.reason ?? null }
    }
    if (missed > 0) recordMissed(plan, missed, latestDue, capped)
    // The newest missed window is executed now, not just counted: that is what
    // "latest" means. It is recorded as a catch-up so the run total and the
    // missed total can be read against each other.
    return startPlan(plan, latestDue, { catchUp: missed > 0, missedCount: missed })
  }

  /**
   * Evaluate every plan at one instant. Public because tests and an embedding
   * host use it instead of waiting for the timer.
   *
   * @param {number} [at] - epoch milliseconds; defaults to the injected clock.
   * @returns {Promise<object[]>} one record per plan that acted.
   */
  async function tick(at = now()) {
    if (ticking) return []
    ticking = true
    try {
      return await serialize(async () => {
        await load()
        const outcomes = []
        for (const plan of plans.values()) {
          if (!plan.enabled) continue
          const result = await tickPlan(plan, at)
          if (result) outcomes.push({ id: plan.id, ...result })
        }
        // An install with no plan must stay indistinguishable from one without
        // this feature, so an empty tick writes nothing.
        if (plans.size > 0) await persist()
        ensureTimer()
        return outcomes
      })
    } finally {
      ticking = false
    }
  }

  return {
    stateFile,

    /** Load plans, reconcile runs finished while the host was down, arm the timer. */
    async init() {
      const summary = await serialize(async () => {
        await load()
        for (const plan of plans.values()) {
          if (!plan.activeRunId) continue
          const run = await readRun(plan.activeRunId)
          if (run && TERMINAL_STATUSES.has(run.status)) await applyOutcome(plan, run)
        }
        ensureTimer()
        return { plans: plans.size, running: Boolean(timer) }
      })
      // A window that came due while the host was down is handled now, not up
      // to a whole tick later. `tick` serializes itself, so it runs after the
      // block above rather than inside it.
      if (summary.plans > 0) await tick()
      return summary
    },

    /** True when a timer is armed; false on an empty plan list (the default). */
    isRunning() {
      return Boolean(timer)
    },

    async create(input) {
      return serialize(async () => {
        await load()
        const plan = normalizeScheduleInput(input, { now })
        plans.set(plan.id, plan)
        await persist()
        ensureTimer()
        return clone(plan)
      })
    },

    async list() {
      await load()
      return [...plans.values()]
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .map(clone)
    },

    async pause(id, reason = 'paused by request') {
      return serialize(async () => {
        await load()
        const plan = requirePlan(id)
        plan.enabled = false
        plan.pausedReason = reason
        plan.lastOutcome = 'paused'
        plan.lastReason = reason
        record(plan, 'paused', reason)
        await persist()
        ensureTimer()
        return clone(plan)
      })
    },

    async resume(id) {
      return serialize(async () => {
        await load()
        const plan = requirePlan(id)
        plan.enabled = true
        plan.pausedReason = null
        plan.consecutiveFailures = 0
        plan.lastOutcome = null
        plan.lastReason = null
        // A resume must not replay the windows that passed while it was paused.
        plan.nextRunAt = new Date(nextTimeFor(plan, now())).toISOString()
        record(plan, 'resumed', `next run ${plan.nextRunAt}`)
        await persist()
        ensureTimer()
        return clone(plan)
      })
    },

    async remove(id) {
      return serialize(async () => {
        await load()
        const plan = requirePlan(id)
        plans.delete(plan.id)
        record(plan, 'deleted', 'the plan was removed; the runs it already started keep their records')
        await persist()
        ensureTimer()
        return { id: plan.id, name: plan.name }
      })
    },

    /** Start one run now, without changing the plan's next window. */
    async runNow(id) {
      return serialize(async () => {
        await load()
        const plan = requirePlan(id)
        if (plan.activeRunId) {
          const run = await readRun(plan.activeRunId)
          if (run && ACTIVE_STATUSES.has(run.status)) {
            throw new Error(`schedule "${plan.id}" skipped: previous run still active (${run.id})`)
          }
          await applyOutcome(plan, run)
        }
        const blocked = budgetBlock(plan)
        if (blocked) throw new Error(`schedule "${plan.id}" cannot start: budget reached: ${blocked}`)
        const owner = await ownerFor(plan)
        if (!owner.agent) {
          const suffix = plan.requiresLiveSession || plan.ownerRecovery === 'none'
            ? '; this host has no way to restore a session, so the plan needs a resident session'
            : ''
          throw new Error(`schedule "${plan.id}" cannot start: ${owner.reason}${suffix}`)
        }
        const run = await orchestrator.start(startArgsFor(plan, owner.agent, plan.ownerSessionId))
        plan.lastRunId = run.id
        plan.lastStatus = run.status
        plan.activeRunId = run.id
        plan.lastAttemptAt = new Date(now()).toISOString()
        plan.totalRuns += 1
        record(plan, 'started-now', `run ${run.id}; the next planned window is ${plan.nextRunAt}`)
        await persist()
        return { plan: clone(plan), run }
      })
    },

    tick,

    /** Disarm the timer; used by tests and by a host that unmounts the plugin. */
    stop() {
      if (timer) {
        clearIntervalFn(timer)
        timer = null
      }
    },
  }
}

/** One plan in the form `superagent_schedule action="list"` uses. */
export function formatScheduleList(plans) {
  if (!Array.isArray(plans) || plans.length === 0) {
    return 'no scheduled runs; the scheduler is idle and nothing runs unless a plan is created with action="create"'
  }
  const lines = [`${plans.length} scheduled run(s):`]
  for (const plan of plans) {
    const when = plan.schedule.cron
      ? `cron ${plan.schedule.cron} (${plan.schedule.timeZone})`
      : `every ${plan.schedule.everyMinutes} minute(s) (${plan.schedule.timeZone})`
    const state = plan.enabled ? 'enabled' : `paused: ${plan.pausedReason ?? 'no reason recorded'}`
    lines.push(
      `- ${plan.id}  ${plan.name} — ${state}`,
      `  when: ${when}; miss policy ${plan.schedule.missPolicy}; next ${plan.nextRunAt ?? 'not computed'}`,
      `  last: ${plan.lastStatus ?? 'never'}; failures in a row ${plan.consecutiveFailures}; `
        + `runs ${plan.totalRuns} (${plan.catchUpRuns ?? 0} catch-up); missed ${plan.missedRuns}; `
        + `skipped ${plan.skippedRuns ?? 0}`,
      ...(plan.requiresLiveSession
        ? ['  warning: this host cannot restore a session after a restart; the plan needs a resident session']
        : []),
    )
  }
  return lines.join('\n')
}

/** One plan in full, used by create/resume replies and by tests. */
export function formatSchedule(plan) {
  const when = plan.schedule.cron
    ? `cron "${plan.schedule.cron}" in ${plan.schedule.timeZone}`
    : `every ${plan.schedule.everyMinutes} minute(s) in ${plan.schedule.timeZone}`
  const budget = plan.budget ?? {}
  const budgetLines = [
    budget.maxModelCalls ? `model calls per run ${budget.maxModelCalls}` : null,
    budget.maxTokens ? `tokens per run ${budget.maxTokens}` : null,
    budget.maxTotalModelCalls ? `model calls total ${budget.maxTotalModelCalls}` : null,
    budget.maxTotalTokens ? `tokens total ${budget.maxTotalTokens}` : null,
    budget.maxTotalRuns ? `runs total ${budget.maxTotalRuns}` : null,
  ].filter(Boolean)
  const lines = [
    `schedule ${plan.id} — ${plan.name}`,
    `goal: ${oneLine(plan.goal, 300)}${plan.goal.length > 300 ? '…' : ''}`,
    `when: ${when}; miss policy ${plan.schedule.missPolicy}`,
    `next: ${plan.nextRunAt ?? 'not computed'}; last: ${plan.lastStatus ?? 'never'}`,
    `owner: session ${plan.ownerSessionId}; mode ${plan.mode}${plan.goalMode ? '; goal mode on' : ''}`
      + `${plan.ownerRecovery ? `; restart recovery ${plan.ownerRecovery}` : ''}`
      + `${plan.requiresLiveSession ? ' (needs a resident session)' : ''}`,
    `budget: ${budgetLines.length > 0 ? budgetLines.join(', ') : 'none beyond the operator caps'}`,
    `human priority: ${plan.concurrency.humanPriority !== false ? 'on (one slot stays free for manual runs)' : 'off'}`,
    `failures in a row: ${plan.consecutiveFailures}; total runs: ${plan.totalRuns} `
      + `(${plan.catchUpRuns ?? 0} catch-up); missed windows: ${plan.missedRuns}; skipped: ${plan.skippedRuns ?? 0}`,
  ]
  if (!plan.enabled) lines.push(`paused: ${plan.pausedReason ?? 'no reason recorded'}`)
  if (plan.history.length > 0) {
    lines.push('recent:')
    for (const entry of plan.history.slice(-5)) {
      lines.push(`- ${entry.at} ${entry.event}${entry.reason ? `: ${entry.reason}` : ''}`)
    }
  }
  return lines.join('\n')
}
