/**
 * dsh-longhaul — long-horizon autonomous runs for DeepSeek Harness.
 *
 * One goal enters; a planner decomposes it into independent subtasks; those
 * subtasks run in parallel child agents; an aggregator merges their reports.
 * Runs survive a host restart, can be cancelled, and have their token usage
 * read back from the child sessions' durable logs.
 *
 * Registered tools: longhaul_start, longhaul_status, longhaul_list,
 * longhaul_cancel, longhaul_resume.
 *
 * @module dsh-longhaul
 */
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createOrchestrator } from './orchestrator.js'
import { classifyError, describeError, summarizeError } from './errors.js'
import { createStore, resolveStateRoot, TERMINAL_STATUSES } from './store.js'
import { createUsageReader } from './usage.js'

export const name = 'dsh-longhaul'
export const inject = ['tools', 'agents', 'subagents']

const DEFAULTS = {
  /** Directory for run state; defaults to `$DSH_HOME/state/longhaul`. */
  stateDir: null,
  /** Child backend registered on `ctx.subagents`. */
  provider: 'spawn',
  /** Optional provider override for every child agent; unset inherits the parent's model route. */
  childProvider: null,
  /** Optional model override for every child agent; unset inherits the parent's model. */
  childModel: null,
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
   * rather than guessed.
   */
  pricing: {
    'qwen-flash': { input: 0.15, output: 1.5, currency: 'CNY' },
  },
  /** Bytes kept from one subtask report. */
  resultCapBytes: 32 * 1024,
  /** Write one message back to the owning session when a run finishes unattended. */
  notifyOnComplete: true,
  /** Delete terminal runs older than this many days on mount; 0 keeps everything. */
  keepRuns: 0,
}

const REPORT_PREVIEW_CHARS = 8000

function resolveConfig(config) {
  const merged = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) merged[key] = value
    }
  }
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

function elapsed(run) {
  const start = Date.parse(run.startedAt)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unknown'
  const seconds = Math.max(0, (end - start) / 1000)
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

function usageLine(usage) {
  if (!usage || !usage.modelCalls) {
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
    usageLine(run.usage),
  ]
  const cost = costLine(run)
  if (cost) lines.push(cost)
  if (run.resumedAt) lines.push(`resumed at: ${run.resumedAt}`)
  if (run.reclaimed) lines.push(`reclaimed: ${run.reclaimed.basis}`)
  if (run.status !== 'cancelled' && run.error) {
    lines.push(`error: ${summarizeError(run.error)}`)
    if (run.status === 'failed') lines.push(`hint: ${classifyError(run.error).hint}`)
  }
  if (notifyFailed(run)) {
    lines.push(`notify: not delivered — ${run.notify.reason}`)
  }
  if (run.cancelPending) {
    lines.push('cancel: requested, but the process running this run has not confirmed yet; check longhaul_status again in a few seconds')
  }
  for (const subtask of run.subtasks) {
    const tokens = subtask.usage ? ` ${subtask.usage.inputTokens} in / ${subtask.usage.outputTokens} out` : ''
    const detail = subtask.error ? ` — ${summarizeError(subtask.error)}` : ''
    lines.push(`  [${subtask.index}] ${subtask.status} (attempts ${subtask.attempts}) ${subtask.title}${tokens}${detail}`)
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
    lines.push('', `next: longhaul_status run_id="${run.id}" wait_seconds=120`)
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
  if (runs.length === 0) return 'no longhaul runs recorded'
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
  const cfg = resolveConfig(config)
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    console.error('[dsh-longhaul] host exposes no tools service; plugin disabled')
    return
  }

  const log = message => console.error(`[dsh-longhaul] ${message}`)
  const store = createStore(resolveStateRoot(cfg.stateDir), { warn: log })
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const readUsage = createUsageReader({ sessionsRoot: path.join(home, 'sessions'), warn: log })

  /** Child sessions spawned by this process; a run may not be started from one. */
  const childIds = new Set()
  const subagents = ctx.subagents

  function notifyParent(run) {
    if (run.notified) return { delivered: false, reason: 'skipped: the owning session was already notified' }
    if (!cfg.notifyOnComplete) return { delivered: false, reason: 'disabled: notifyOnComplete is false' }
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = agents && typeof agents.get === 'function' ? agents.get(run.parentSessionId) : undefined
    if (!agent || typeof agent.followup !== 'function') {
      log(`run ${run.id} finished but its session ${run.parentSessionId} is no longer live`)
      return {
        delivered: false,
        reason: `the owning session ${run.parentSessionId} is no longer live; read the report with longhaul_status`,
      }
    }
    const completed = run.subtasks.filter(subtask => subtask.status === 'completed').length
    const text = [
      `[longhaul] run ${run.id} finished: ${run.status} (${completed}/${run.subtasks.length} subtasks).`,
      `Call longhaul_status with run_id="${run.id}" to read the report.`,
    ].join(' ')
    try {
      agent.followup({
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
      if (!subagents || typeof subagents.startActivation !== 'function') {
        throw new Error('subagent service is unavailable; dsh-longhaul needs ctx.subagents')
      }
      const agentOptions = {}
      if (cfg.childProvider) agentOptions.provider = cfg.childProvider
      if (cfg.childModel) agentOptions.model = cfg.childModel
      const activation = await subagents.startActivation({
        provider: cfg.provider,
        label,
        request: {
          parent,
          prompt: [{ type: 'text', text: prompt }],
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        },
        signal,
        delivery: 'caller',
      })
      childIds.add(activation.childId)
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
  // dead host reads as interrupted before the first tool call sees it.
  const ready = orchestrator.recover()
    .then(async () => {
      if (!(cfg.keepRuns > 0) || typeof store.prune !== 'function') return
      const { removed } = await store.prune({ olderThanDays: cfg.keepRuns })
      if (removed.length > 0) {
        log(`pruned ${removed.length} terminal run(s) older than ${cfg.keepRuns} day(s): ${removed.join(', ')}`)
      }
    })
    .catch(error => log(`recovery failed: ${error?.message ?? error}`))

  function requireAgent(exec) {
    const agent = exec?.agent
    if (!agent || typeof agent !== 'object' || !agent.id) return { error: describeError('no live agent in this tool call context') }
    if (childIds.has(agent.id)) {
      return { error: describeError('refused: a longhaul worker may not start or resume runs; finish your subtask instead') }
    }
    return { agent }
  }

  ctx.tools.register(defineTool({
    name: 'longhaul_start',
    description:
      'Start a long-horizon autonomous run: a planner decomposes the goal into independent subtasks, '
      + 'the subtasks run in parallel child agents, and their reports are merged into one final report. '
      + 'The call returns immediately with a run id; poll it with longhaul_status. Runs are persisted, '
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
      await ready
      try {
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
        return `${formatRun(run, { includeReport: false })}\n\nStarted in the background. Poll with longhaul_status; `
          + 'the run keeps going after this tool call returns.'
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'longhaul_status',
    description:
      'Read one longhaul run: status, subtask outcomes, measured token usage, and the final report. '
      + 'With wait_seconds it blocks until the run reaches a terminal state or the wait expires.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by longhaul_start.' },
      wait_seconds: { type: 'number', description: 'Block up to this many seconds for a terminal state (default 0).' },
    },
    required: ['run_id'],
    async execute(args = {}) {
      await ready
      try {
        const run = await orchestrator.status(String(args.run_id ?? '').trim(), Number(args.wait_seconds) || 0)
        return formatRun(run)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'longhaul_list',
    description: 'List recorded longhaul runs, newest first, with status and progress.',
    properties: {
      limit: { type: 'number', description: 'Maximum rows to print (default 20).' },
    },
    async execute(args = {}) {
      await ready
      try {
        const runs = await orchestrator.list()
        const stats = typeof store.stats === 'function' ? await store.stats() : null
        return formatList(runs, Math.max(1, Math.min(100, Number(args.limit) || 20)), stats ? { ...stats, root: store.root } : null)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'longhaul_cancel',
    description:
      'Cancel a longhaul run: stops running subtasks, marks the run cancelled, and keeps the state file '
      + 'so the partial work stays inspectable.',
    properties: {
      run_id: { type: 'string', description: 'Run id to cancel.' },
    },
    required: ['run_id'],
    async execute(args = {}) {
      await ready
      try {
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
    name: 'longhaul_resume',
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
      await ready
      try {
        const run = await orchestrator.resume(String(args.run_id ?? '').trim(), check.agent, exec.clientTimeZone)
        const waitSeconds = Number(args.wait_seconds) || 0
        const current = waitSeconds > 0 ? await orchestrator.status(run.id, waitSeconds) : run
        return formatRun(current)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  log(`registered 5 tools; state ${store.root}`)
}
