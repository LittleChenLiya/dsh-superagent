/**
 * dsh-superagent — long-horizon autonomous runs for DeepSeek Harness.
 *
 * One goal enters; a planner decomposes it into independent subtasks; those
 * subtasks run in parallel child agents; an aggregator merges their reports.
 * Runs survive a host restart, can be cancelled, and have their token usage
 * read back from the child sessions' durable logs.
 *
 * Registered tools: superagent_start, superagent_status, superagent_list,
 * superagent_cancel, superagent_resume.
 *
 * @module dsh-superagent
 */
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import pkg from '../package.json' with { type: 'json' }
import { createOrchestrator } from './orchestrator.js'
import { createControlPlane } from './control.js'
import { classifyError, describeError, summarizeError } from './errors.js'
import { ACTIVE_STATUSES, createStore, resolveStateRoot, TERMINAL_STATUSES } from './store.js'
import { createUsageReader } from './usage.js'

export const name = 'dsh-superagent'
// The host menu and sessions are required. `subagents` is read through
// `ctx.get('subagents')`, so a profile without it still mounts the five tools;
// they then report what is missing instead of the plugin silently vanishing.
export const inject = ['tools', 'agents']

const DEFAULTS = {
  /** Directory for run state; defaults to `$DSH_HOME/state/superagent`. */
  stateDir: null,
  /** Child backend registered on `ctx.subagents`. */
  provider: 'spawn',
  /** Optional provider override for every child agent; unset inherits the parent's model route. */
  childProvider: null,
  /** Optional model override for every child agent; unset inherits the parent's model. */
  childModel: null,
  /**
   * Optional agent preset for child agents. A preset owns the child's tool
   * composition, which is the only way this host version can restrict it.
   */
  childPreset: null,
  /**
   * Delegation depth granted to child agents. 1 means a worker may not create
   * children of its own; `provider-managed` leaves the cap to the backend.
   */
  maxSubagentDepth: 1,
  /** Upper bound on planned subtasks per run. */
  maxSubtasks: 8,
  /** Upper bound on subtasks executing at once. */
  maxParallel: 3,
  /** Runs allowed to be active at the same time; further starts are rejected. */
  maxActiveRuns: 2,
  /** Attempts per subtask before it is marked failed. */
  attempts: 2,
  /** Wall-clock budget for a whole run, in minutes. */
  deadlineMinutes: 120,
  /** Hard cap on child model calls per run; 0 disables the cap. */
  maxModelCallsPerRun: 80,
  /** Hard cap on prompt + completion tokens per run; 0 disables the cap. */
  maxTokensPerRun: 2_000_000,
  /**
   * List prices per 1M tokens, keyed by model id as it appears in usage logs.
   * Only models listed here are priced; everything else is reported as unpriced
   * rather than guessed. Nothing is shipped: a stale price is worse than none.
   */
  pricing: {},
  /** Bytes kept from one subtask report. */
  resultCapBytes: 32 * 1024,
  /** Write one message back to the owning session when a run finishes unattended. */
  notifyOnComplete: true,
  /** Delete terminal runs older than this many days on mount; 0 keeps everything. */
  keepRuns: 0,
  /**
   * Loopback HTTP port for the embedding surface. `null` (default) keeps the
   * socket closed; `0` asks the OS for a free port. The bound address and its
   * bearer token are written to `<stateDir>/control.json`.
   */
  controlPort: null,
}

const REPORT_PREVIEW_CHARS = 8000

/**
 * Coerce one numeric setting into its documented range. A value like "abc"
 * would otherwise become NaN and silently remove a limit (NaN comparisons are
 * always false), which is how a quota disappears without any error.
 */
function bounded(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * A port is a whole number in 0–65535, or nothing. A malformed value must not
 * silently open a socket somewhere unexpected, so anything else stays off.
 */
function controlPortOf(value) {
  if (value === null || value === undefined || value === false) return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0 || number > 65535) return null
  return number
}

function resolveConfig(config) {
  const merged = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) merged[key] = value
    }
  }
  merged.maxSubtasks = bounded(merged.maxSubtasks, DEFAULTS.maxSubtasks, 1, 16)
  merged.maxParallel = bounded(merged.maxParallel, DEFAULTS.maxParallel, 1, 8)
  merged.maxActiveRuns = bounded(merged.maxActiveRuns, DEFAULTS.maxActiveRuns, 1, 8)
  merged.attempts = bounded(merged.attempts, DEFAULTS.attempts, 1, 5)
  merged.deadlineMinutes = bounded(merged.deadlineMinutes, DEFAULTS.deadlineMinutes, 1, 720)
  merged.maxModelCallsPerRun = bounded(merged.maxModelCallsPerRun, DEFAULTS.maxModelCallsPerRun, 0, 10000)
  merged.maxTokensPerRun = bounded(merged.maxTokensPerRun, DEFAULTS.maxTokensPerRun, 0, 1e12)
  merged.resultCapBytes = bounded(merged.resultCapBytes, DEFAULTS.resultCapBytes, 1024, 1024 * 1024)
  merged.keepRuns = bounded(merged.keepRuns, DEFAULTS.keepRuns, 0, 3650)
  merged.controlPort = controlPortOf(merged.controlPort)
  merged.maxSubagentDepth = merged.maxSubagentDepth === 'provider-managed'
    ? 'provider-managed'
    : bounded(merged.maxSubagentDepth, DEFAULTS.maxSubagentDepth, 0, 4)
  // Per-model prices merge, so a user can add one route without restating the
  // built-in table.
  merged.pricing = { ...DEFAULTS.pricing, ...(config?.pricing ?? {}) }
  return merged
}

function preview(text, limit = REPORT_PREVIEW_CHARS) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n[report truncated to ${limit} characters; full text is in the run state file]`
}

function durationText(ms) {
  const seconds = Math.max(0, ms / 1000)
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

function elapsed(run) {
  const start = Date.parse(run.startedAt)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unknown'
  const wall = Math.max(0, end - start)
  const active = Number.isFinite(run.activeMs) ? run.activeMs : wall
  // A resumed run can span hours of downtime. Reporting one number would make
  // it look like the model worked all that time.
  if (run.resumedAt && wall - active > 5000) {
    return `${durationText(active)} running, ${durationText(wall)} since it was started (includes time stopped)`
  }
  return durationText(wall)
}

function usageLine(usage, status) {
  if (!usage || !usage.modelCalls) {
    if (ACTIVE_STATUSES.has(status)) {
      return 'usage: accounting pending — token usage is read from child session logs while the run is in progress'
    }
    return 'usage: not recorded — no child session log was readable for this run '
      + '(usually a run created before usage tracking, or a sessions directory that moved); '
      + 'token and cost figures are unavailable'
  }
  const models = Object.entries(usage.models ?? {})
    .map(([model, entry]) => `${model}: ${entry.calls} call(s) ${entry.inputTokens} in / ${entry.outputTokens} out`)
    .join('; ')
  const cached = usage.cacheReadTokens ? ` (+${usage.cacheReadTokens} prompt tokens served from cache)` : ''
  return `usage: input ${usage.inputTokens}${cached}, output ${usage.outputTokens}, calls ${usage.modelCalls}`
    + (models ? ` (${models})` : '')
}

function currencySymbol(code) {
  if (code === 'CNY') return '¥'
  if (code === 'USD') return '$'
  if (code === 'EUR') return '€'
  return `${code} `
}

/**
 * Cost line for one run. The number is an estimate from the configured list
 * prices; models without a price are named instead of guessed so a user can
 * always tell how much of the spend the figure covers.
 */
function costLine(run) {
  if (!run.usage || !run.usage.modelCalls) return null
  const models = Object.keys(run.usage.models ?? {})
  const cost = run.cost
  if (!cost || Object.keys(cost.byModel).length === 0) {
    return `cost: not computed — no price configured for ${models.join(', ') || 'this model'}; `
      + 'add a pricing entry in cordis.patch.yml to get an estimate'
  }
  const money = `${currencySymbol(cost.currency)}${cost.total.toFixed(4)}`
  if (cost.complete) return `cost: ${money} (estimate; all models priced)`
  return `cost: at least ${money} (estimate; no price for ${cost.unpriced.join(', ')})`
}

/** Render one run as text for a tool result. */
function formatRun(run, { includeReport = true } = {}) {
  const completed = run.subtasks.filter(subtask => subtask.status === 'completed').length
  const lines = [
    `run ${run.id} — ${run.status}`,
    `goal: ${run.goal}`,
    `plan: ${run.plan?.mode ?? 'pending'}; subtasks ${completed}/${run.subtasks.length} completed; `
      + `max ${run.limits.maxParallel} in parallel; ${run.limits.attempts} attempt(s) each`,
    `elapsed: ${elapsed(run)}`,
    usageLine(run.usage, run.status),
  ]
  const unreadable = Object.keys(run.counters?.unreadable ?? {}).length
  if (unreadable > 0) {
    lines.push(
      `usage note: ${unreadable} child session log(s) could not be read, so the token figures above cover only `
      + 'the readable ones; the model-call budget counted those children as one call each instead of ignoring them',
    )
  }
  const cost = costLine(run)
  if (cost) lines.push(cost)
  if (run.resumedAt) lines.push(`resumed at: ${run.resumedAt}`)
  if (run.reclaimed) lines.push(`reclaimed: ${run.reclaimed.basis}`)
  if (run.status === 'interrupted' && run.error) {
    // Not a failure: the host went away and the run is waiting to be resumed.
    lines.push(`note: ${run.error}`)
  } else if (run.status !== 'cancelled' && run.error) {
    lines.push(`error: ${summarizeError(run.error)}`)
    if (run.status === 'failed') lines.push(`hint: ${classifyError(run.error).hint}`)
  }
  if (notifyFailed(run)) {
    lines.push(`notify: not delivered — ${run.notify.reason}`)
  }
  if (run.cancelPending) {
    lines.push('cancel: requested, but the process running this run has not confirmed yet; check superagent_status again in a few seconds')
  }
  for (const subtask of run.subtasks) {
    const tokens = subtask.usage ? ` ${subtask.usage.inputTokens} in / ${subtask.usage.outputTokens} out` : ''
    const detail = subtask.error ? ` — ${summarizeError(subtask.error)}` : ''
    // A cancelled run never judged its unfinished subtasks, so calling them
    // "pending" or "failed (attempts 0)" would misreport what happened.
    const status = run.status === 'cancelled' && subtask.status !== 'completed'
      ? (subtask.attempts > 0 ? 'cancelled' : 'skipped')
      : subtask.status
    lines.push(`  [${subtask.index}] ${status} (attempts ${subtask.attempts}) ${subtask.title}${tokens}${detail}`)
  }
  const failed = run.subtasks.find(subtask => subtask.error)
  if (failed) {
    const hint = classifyError(failed.error).hint
    if (classifyError(failed.error).id !== 'unclassified') lines.push('', `hint: ${hint}`)
  }
  if (includeReport && run.report) {
    lines.push('', 'report:', '', preview(run.report))
  }
  if (!TERMINAL_STATUSES.has(run.status)) {
    lines.push('', `next: superagent_status run_id="${run.id}" wait_seconds=120`)
  } else if (run.status === 'interrupted') {
    lines.push('', `next: superagent_resume run_id="${run.id}"`)
  }
  return lines.join('\n')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** True when a run finished but its owner was never told, and that is a problem. */
function notifyFailed(run) {
  if (!run.notify || run.notify.delivered) return false
  return !/^(skipped|disabled):/.test(String(run.notify.reason ?? ''))
}

function formatList(runs, limit, stats = null) {
  if (runs.length === 0) return 'no superagent runs recorded'
  const rows = runs.slice(0, limit).map(run => {
    const completed = run.subtasks.filter(subtask => subtask.status === 'completed').length
    return `${run.id}  ${run.status.padEnd(11)}  ${completed}/${run.subtasks.length} done  `
      + `${run.goal.slice(0, 70)}${notifyFailed(run) ? '  (result not delivered to the session)' : ''}`
  })
  const lines = [`${runs.length} run(s):`, ...rows]
  if (stats) {
    lines.push('', `state: ${stats.files} file(s), ${formatBytes(stats.bytes)} in ${stats.root}`
      + (stats.corrupt ? ` (${stats.corrupt} quarantined file(s))` : ''))
  }
  return lines.join('\n')
}

function toolText(text) {
  return [{ type: 'text', text }]
}

function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, ...(spec.required?.length ? { required: spec.required } : {}) },
    output: { schema: { type: 'string' }, render: (_args, value) => toolText(value) },
    execute: spec.execute,
  }
}

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis context.
 * @param {object} [config] - row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const log = message => console.error(`[dsh-superagent] ${message}`)
  const configuredPort = config?.controlPort
  const cfg = resolveConfig(config)
  if (configuredPort !== undefined && configuredPort !== null && cfg.controlPort === null) {
    log(`controlPort ${JSON.stringify(configuredPort)} is not a whole number in 0–65535; the local HTTP control plane stays off`)
  }
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    console.error('[dsh-superagent] host exposes no tools service; plugin disabled')
    return
  }

  const store = createStore(resolveStateRoot(cfg.stateDir), { warn: log })
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const readUsage = createUsageReader({ sessionsRoot: path.join(home, 'sessions'), warn: log })

  /** Child sessions spawned by this process; a run may not be started from one. */
  const childIds = new Set()

  /**
   * The subagent service is optional, so it is read from the service store at
   * call time rather than declared as an injection: a profile without it must
   * still mount the five tools (they then explain what is missing), and reading
   * it lazily also sees a service that registers after this plugin.
   */
  function getSubagents() {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('subagents')
      if (service) return service
    }
    // The direct property is topology-sensitive on a real host; it is only a
    // fallback for test contexts that provide the service without a registry.
    try {
      return ctx.subagents
    } catch {
      return undefined
    }
  }

  /** Remember a child id for the recursion guard without growing forever. */
  function rememberChild(childId) {
    if (!childId) return
    childIds.add(childId)
    if (childIds.size > 512) childIds.delete(childIds.values().next().value)
  }

  /**
   * Map a run outcome to one message for the owning session.
   *
   * The followup is awaited: an unhandled rejection from it would otherwise
   * escape as a host-level error while the run already claims it was delivered.
   */
  async function notifyParent(run) {
    if (run.notified) return { delivered: false, reason: 'skipped: the owning session was already notified' }
    if (!cfg.notifyOnComplete) return { delivered: false, reason: 'disabled: notifyOnComplete is false' }
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = agents && typeof agents.get === 'function' ? agents.get(run.parentSessionId) : undefined
    if (!agent || typeof agent.followup !== 'function') {
      log(`run ${run.id} finished but its session ${run.parentSessionId} is no longer live`)
      return {
        delivered: false,
        reason: `the owning session ${run.parentSessionId} is no longer live; read the report with superagent_status`,
      }
    }
    const completed = run.subtasks.filter(subtask => subtask.status === 'completed').length
    const text = [
      `[superagent] run ${run.id} finished: ${run.status} (${completed}/${run.subtasks.length} subtasks).`,
      `Call superagent_status with run_id="${run.id}" to read the report.`,
    ].join(' ')
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      run.notified = true
      return { delivered: true }
    } catch (error) {
      log(`cannot notify session ${run.parentSessionId}: ${error?.message ?? error}`)
      return { delivered: false, reason: `waking the session failed: ${error?.message ?? error}` }
    }
  }

  const orchestrator = createOrchestrator({
    store,
    config: cfg,
    log,
    readUsage,
    notify: notifyParent,
    async spawnChild({ label, prompt, parent, signal }) {
      const subagents = getSubagents()
      if (!subagents || typeof subagents.startActivation !== 'function') {
        const error = new Error('subagent service is unavailable; dsh-superagent needs the host subagents service')
        // The service can also disappear in the middle of a run, when the host
        // is shutting down. The orchestrator turns this code into `interrupted`
        // instead of a failed subtask, so the run stays resumable.
        error.code = 'subagent-unavailable'
        throw error
      }
      const provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(cfg.provider) : undefined
      const capabilities = provider?.capabilities ?? null
      const agentOptions = {}
      if (cfg.childProvider) agentOptions.provider = cfg.childProvider
      if (cfg.childModel) agentOptions.model = cfg.childModel
      const request = {
        parent,
        prompt: [{ type: 'text', text: prompt }],
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      }
      // A preset is the host's only way to give a child a narrower tool set:
      // the start request has no tool filter in dsh 0.2.2-rc.1.
      if (cfg.childPreset) {
        if (capabilities && !capabilities.agentPreset) {
          throw new Error(
            `childPreset "${cfg.childPreset}" cannot be applied: subagent provider "${cfg.provider}" does not support `
            + 'independent agent presets, so this child would run with this session\'s tools',
          )
        }
        request.agentPreset = cfg.childPreset
      }
      // Recursion is bounded unless the operator explicitly left it to the
      // backend. Silently dropping the cap would hand 8 parallel workers the
      // right to spawn their own armies.
      if (cfg.maxSubagentDepth !== 'provider-managed') {
        if (capabilities && !capabilities.depthLimit) {
          throw new Error(
            `subagent provider "${cfg.provider}" cannot enforce maxSubagentDepth (${cfg.maxSubagentDepth}), so child `
            + 'agents could spawn their own children without limit; set maxSubagentDepth: provider-managed to accept '
            + 'the backend\'s own cap',
          )
        }
        request.maxDepth = cfg.maxSubagentDepth
      }
      const activation = await subagents.startActivation({
        provider: cfg.provider,
        label,
        request,
        signal,
        delivery: 'caller',
      })
      rememberChild(activation.childId)
      return {
        childId: activation.childId,
        result: activation.result,
        dispose: async () => {
          try {
            await activation.dispose()
          } catch (error) {
            log(`dispose failed for ${activation.childId}: ${error?.message ?? error}`)
          }
        },
      }
    },
  })

  // Recovery runs once at mount; tools wait for it so a run left active by a
  // dead host reads as interrupted before the first tool call sees it. A
  // failure to initialize the state directory is kept and reported by every
  // tool: hiding it behind "no runs recorded" is how a broken stateDir looks
  // like an empty one.
  let stateError = null
  const ready = (async () => {
    try {
      await orchestrator.recover()
    } catch (error) {
      stateError = error instanceof Error ? error : new Error(String(error))
      log(`state directory is not usable: ${stateError.message}`)
      return
    }
    if (!(cfg.keepRuns > 0) || typeof store.prune !== 'function') return
    try {
      const { removed } = await store.prune({ olderThanDays: cfg.keepRuns })
      if (removed.length > 0) {
        log(`pruned ${removed.length} terminal run(s) older than ${cfg.keepRuns} day(s): ${removed.join(', ')}`)
      }
    } catch (error) {
      log(`cannot prune old runs: ${error?.message ?? error}`)
    }
  })()

  /** True when the host actually provides a subagent service. */
  function hasSubagents() {
    const subagents = getSubagents()
    return Boolean(subagents && typeof subagents.startActivation === 'function')
  }

  function requireAgent(exec) {
    const agent = exec?.agent
    if (!agent || typeof agent !== 'object' || !agent.id) return { error: describeError('no live agent in this tool call context') }
    if (childIds.has(agent.id)) {
      return { error: describeError('refused: a superagent worker may not start or resume runs; finish your subtask instead') }
    }
    return { agent }
  }

  /**
   * Resolve the session named by an HTTP caller. An embedded start is a normal
   * run: it needs a live agent to own the children, and the same recursion
   * guard as a tool call. A synthetic parent would spawn children no session
   * owns, so a missing session is an error, never a fallback.
   * @param {unknown} sessionId - `session_id` from the request body.
   * @returns {object} live agent.
   */
  function resolveSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!id) {
      throw new Error(
        'no live agent: session_id is required; an HTTP-started run needs an open session to own its child agents',
      )
    }
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
    if (!agent || typeof agent !== 'object' || !agent.id) {
      throw new Error(
        `no live agent: session ${id} is not open in this host process; open that session, or start the run from a `
        + 'tool call inside it',
      )
    }
    if (childIds.has(agent.id)) {
      throw new Error('refused: a superagent worker may not start or resume runs; finish your subtask instead')
    }
    return agent
  }

  ctx.tools.register(defineTool({
    name: 'superagent_start',
    description:
      'Start a long-horizon autonomous run: a planner decomposes the goal into independent subtasks, '
      + 'the subtasks run in parallel child agents, and their reports are merged into one final report. '
      + 'The call returns immediately with a run id; poll it with superagent_status. Runs are persisted, '
      + 'so they survive a host restart and can be resumed or cancelled.',
    properties: {
      goal: { type: 'string', description: 'The complete goal for the run. Be specific about the expected outcome.' },
      max_subtasks: { type: 'number', description: `Cap on planned subtasks (default ${DEFAULTS.maxSubtasks}, max 16).` },
      max_parallel: { type: 'number', description: `Subtasks allowed to run at once (default ${DEFAULTS.maxParallel}, max 8).` },
      deadline_minutes: { type: 'number', description: `Wall-clock budget in minutes (default ${DEFAULTS.deadlineMinutes}).` },
      wait_seconds: { type: 'number', description: 'Block up to this many seconds for a terminal status before returning (0 returns immediately).' },
    },
    required: ['goal'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        if (!hasSubagents()) {
          return describeError(
            'subagent service is unavailable; dsh-superagent needs the host subagents service to create planner, '
            + 'worker, and aggregator agents. Enable it in this profile (the base bundle provides it) and restart.',
          )
        }
        const run = await orchestrator.start({
          goal: args.goal,
          parentSessionId: check.agent.id,
          parent: check.agent,
          clientTimeZone: exec.clientTimeZone,
          overrides: {
            maxSubtasks: args.max_subtasks,
            maxParallel: args.max_parallel,
            deadlineMinutes: args.deadline_minutes,
          },
        })
        const waitSeconds = Number(args.wait_seconds) || 0
        if (waitSeconds > 0) {
          const finished = await orchestrator.status(run.id, waitSeconds)
          return formatRun(finished)
        }
        return `${formatRun(run, { includeReport: false })}\n\nStarted in the background. Poll with superagent_status; `
          + 'the run keeps going after this tool call returns.'
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_status',
    description:
      'Read one superagent run: status, subtask outcomes, measured token usage, and the final report. '
      + 'With wait_seconds it blocks until the run reaches a terminal state or the wait expires.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by superagent_start.' },
      wait_seconds: { type: 'number', description: 'Block up to this many seconds for a terminal state (default 0).' },
    },
    required: ['run_id'],
    async execute(args = {}) {
      try {
        await ready
        if (stateError) return describeError(stateError)
        const run = await orchestrator.status(String(args.run_id ?? '').trim(), Number(args.wait_seconds) || 0)
        return formatRun(run)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_list',
    description: 'List recorded superagent runs, newest first, with status and progress.',
    properties: {
      limit: { type: 'number', description: 'Maximum rows to print (default 20).' },
    },
    async execute(args = {}) {
      try {
        await ready
        if (stateError) return describeError(stateError)
        const runs = await orchestrator.list()
        const stats = typeof store.stats === 'function' ? await store.stats() : null
        return formatList(runs, Math.max(1, Math.min(100, Number(args.limit) || 20)), stats ? { ...stats, root: store.root } : null)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_cancel',
    description:
      'Cancel a superagent run: stops running subtasks, marks the run cancelled, and keeps the state file '
      + 'so the partial work stays inspectable.',
    properties: {
      run_id: { type: 'string', description: 'Run id to cancel.' },
    },
    required: ['run_id'],
    async execute(args = {}) {
      try {
        await ready
        if (stateError) return describeError(stateError)
        const run = await orchestrator.cancel(String(args.run_id ?? '').trim())
        const head = run.status === 'cancelled'
          ? `cancelled ${run.id}`
          : run.cancelPending
            ? `cancel requested for ${run.id}, not confirmed by the owning process yet`
            : `${run.id} is ${run.status}; nothing to cancel`
        return `${head}\n\n${formatRun(run, { includeReport: false })}`
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_resume',
    description:
      'Resume a run that was interrupted by a host restart, ran out of time, or failed part way. '
      + 'Completed subtasks are kept; pending and failed ones run again.',
    properties: {
      run_id: { type: 'string', description: 'Run id to resume.' },
      wait_seconds: { type: 'number', description: 'Block up to this many seconds for a terminal state (default 0).' },
    },
    required: ['run_id'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        if (!hasSubagents()) {
          return describeError(
            'subagent service is unavailable; resuming a run needs the host subagents service to create child agents.',
          )
        }
        const run = await orchestrator.resume(String(args.run_id ?? '').trim(), check.agent, exec.clientTimeZone)
        const waitSeconds = Number(args.wait_seconds) || 0
        const current = waitSeconds > 0 ? await orchestrator.status(run.id, waitSeconds) : run
        return formatRun(current)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  // The embedding surface is opt-in: mounting the plugin must not open a port
  // unasked. When it is on, every request goes through the same orchestrator as
  // the tools, so quota, budgets, ownership, and cancel behave identically.
  if (cfg.controlPort !== null) {
    const clampControlWait = value => {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0) return 0
      return Math.min(300, Math.trunc(seconds))
    }
    const control = createControlPlane({
      port: cfg.controlPort,
      stateRoot: store.root,
      version: pkg.version,
      log,
      actions: {
        async health() {
          return { activeRuns: await orchestrator.activeCount() }
        },
        async list({ limit } = {}) {
          await ready
          if (stateError) throw stateError
          const runs = await orchestrator.list()
          const stats = typeof store.stats === 'function' ? await store.stats() : null
          const rows = Math.max(1, Math.min(100, Number(limit) || 20))
          return {
            data: { runs, stats: stats ? { ...stats, root: store.root } : null },
            text: formatList(runs, rows, stats ? { ...stats, root: store.root } : null),
          }
        },
        async status(runId, waitSeconds) {
          await ready
          if (stateError) throw stateError
          const run = await orchestrator.status(String(runId ?? '').trim(), clampControlWait(waitSeconds))
          return { data: { run }, text: formatRun(run) }
        },
        async start(body = {}) {
          await ready
          if (stateError) throw stateError
          if (!hasSubagents()) {
            throw new Error(
              'subagent service is unavailable; dsh-superagent needs the host subagents service to create planner, '
              + 'worker, and aggregator agents. Enable it in this profile (the base bundle provides it) and restart.',
            )
          }
          const agent = resolveSession(body.session_id)
          const run = await orchestrator.start({
            goal: body.goal,
            parentSessionId: agent.id,
            parent: agent,
            clientTimeZone: body.time_zone,
            overrides: {
              maxSubtasks: body.max_subtasks,
              maxParallel: body.max_parallel,
              deadlineMinutes: body.deadline_minutes,
            },
          })
          const waitSeconds = clampControlWait(body.wait_seconds)
          if (waitSeconds > 0) {
            const finished = await orchestrator.status(run.id, waitSeconds)
            return { data: { run: finished }, text: formatRun(finished) }
          }
          return {
            data: { run },
            text: `${formatRun(run, { includeReport: false })}\n\nStarted in the background. Poll `
              + `GET /runs/${run.id} or call superagent_status.`,
          }
        },
        async cancel(runId) {
          await ready
          if (stateError) throw stateError
          const run = await orchestrator.cancel(String(runId ?? '').trim())
          const head = run.status === 'cancelled'
            ? `cancelled ${run.id}`
            : run.cancelPending
              ? `cancel requested for ${run.id}, not confirmed by the owning process yet`
              : `${run.id} is ${run.status}; nothing to cancel`
          return { data: { run }, text: `${head}\n\n${formatRun(run, { includeReport: false })}` }
        },
        async resume(runId, body = {}) {
          await ready
          if (stateError) throw stateError
          if (!hasSubagents()) {
            throw new Error('subagent service is unavailable; resuming a run needs the host subagents service to create child agents.')
          }
          const agent = resolveSession(body.session_id)
          const run = await orchestrator.resume(String(runId ?? '').trim(), agent, body.time_zone)
          const waitSeconds = clampControlWait(body.wait_seconds)
          const current = waitSeconds > 0 ? await orchestrator.status(run.id, waitSeconds) : run
          return { data: { run: current }, text: formatRun(current) }
        },
      },
    })
    const stopControl = () => control.stop().catch(error => log(`cannot stop the control plane: ${error?.message ?? error}`))
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => stopControl, 'dsh-superagent control plane')
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', stopControl)
    }
    control.start().catch(error => {
      log(
        `control plane is not listening: ${error?.message ?? error}; `
        + 'choose a free controlPort, or remove it to keep the socket closed',
      )
    })
  }

  log(`registered 5 tools; state ${store.root}${cfg.controlPort === null ? '' : `; control port ${cfg.controlPort}`}`)
}
