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
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
import { createOrchestrator } from './orchestrator.js'
import { createControlPlane } from './control.js'
import { classifyError, describeError, summarizeError } from './errors.js'
import { createMemory, isInside, MEMORY_KINDS, normalizeScope } from './memory.js'
import { createNotifyPolicy, createOutbox } from './notify.js'
import { ACTIVE_STATUSES, createStore, resolveStateRoot, TERMINAL_STATUSES } from './store.js'
import { createUsageReader } from './usage.js'

export const name = 'dsh-superagent'
// The host menu and sessions are required. `subagents` is read through
// `ctx.get('subagents')`, so a profile without it still mounts the six tools;
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
  /** Runs allowed to be active at the same time; a start over this waits instead of failing. */
  maxActiveRuns: 2,
  /** Runs allowed to wait for a free slot when queueing is on; 0 disables queueing. */
  maxQueuedRuns: 5,
  /** How long a queued run waits before it fails, in minutes. */
  queueTimeoutMinutes: 30,
  /**
   * Queue starts that did not ask for it with `queue: true`. Off by default: a
   * caller opts in, so a script that relied on the quota error keeps seeing it.
   */
  queueOnFull: false,
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
  /**
   * Proactive messages allowed per rolling hour. Runs that finish after the cap
   * are folded into one summary instead of waking the session again.
   */
  maxNotificationsPerHour: 3,
  /**
   * Extra rounds that retry failed subtasks before the failure is reported, so
   * a transient error is healed automatically instead of asking the user.
   */
  autoResumeRounds: 1,
  /**
   * Delivery attempts for one wake-up. A followup can fail while the session
   * loop is busy; retrying it is the difference between a lost result and a
   * late one. 0 means one attempt.
   */
  notifyRetries: 2,
  /** First delay between delivery attempts; it doubles per attempt. */
  notifyRetryDelayMs: 2000,
  /**
   * Child model used on a self-heal round when the failure looks transient
   * (quota, rate limit, timeout). `null` keeps the configured route.
   */
  childModelFallback: null,
  /**
   * Cross-run notebook. Notes live under `stateDir` and never enter the package
   * or a default commit; see the privacy section of the README.
   */
  memory: true,
  /** Notebook scope; each scope is one file, so unrelated projects stay apart. */
  memoryScope: 'default',
  /** Notes kept before the notebook is compacted. */
  memoryMaxEntries: 60,
  /** Notes older than this are ignored, then compacted away. */
  memoryMaxAgeDays: 30,
  /** Notes injected into the planner and aggregator prompts. */
  memoryDigestEntries: 12,
  /** Character budget for the note part of that prompt context. */
  memoryDigestChars: 1600,
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
  // Coercion would turn "" and " " into 0, i.e. an accidental listener; only a
  // real number or a plain digit string may enable the surface.
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : null
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const number = Number(value.trim())
    return number <= 65535 ? number : null
  }
  return null
}

/** Read a YAML/JSON boolean without letting the string "false" mean true. */
function flag(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value === 'string') return !/^(false|0|off|no)$/i.test(value.trim())
  return Boolean(value)
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
  merged.maxQueuedRuns = bounded(merged.maxQueuedRuns, DEFAULTS.maxQueuedRuns, 0, 32)
  merged.queueTimeoutMinutes = bounded(merged.queueTimeoutMinutes, DEFAULTS.queueTimeoutMinutes, 1, 720)
  merged.queueOnFull = flag(merged.queueOnFull, DEFAULTS.queueOnFull)
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
  merged.memory = flag(merged.memory, DEFAULTS.memory)
  merged.memoryScope = normalizeScope(merged.memoryScope)
  merged.memoryMaxEntries = bounded(merged.memoryMaxEntries, DEFAULTS.memoryMaxEntries, 1, 500)
  merged.memoryMaxAgeDays = bounded(merged.memoryMaxAgeDays, DEFAULTS.memoryMaxAgeDays, 1, 3650)
  merged.memoryDigestEntries = bounded(merged.memoryDigestEntries, DEFAULTS.memoryDigestEntries, 1, 50)
  merged.memoryDigestChars = bounded(merged.memoryDigestChars, DEFAULTS.memoryDigestChars, 200, 8000)
  merged.autoResumeRounds = bounded(merged.autoResumeRounds, DEFAULTS.autoResumeRounds, 0, 3)
  merged.notifyRetries = bounded(merged.notifyRetries, DEFAULTS.notifyRetries, 0, 5)
  merged.notifyRetryDelayMs = bounded(merged.notifyRetryDelayMs, DEFAULTS.notifyRetryDelayMs, 0, 60000)
  merged.maxNotificationsPerHour = bounded(merged.maxNotificationsPerHour, DEFAULTS.maxNotificationsPerHour, 0, 1000)
  merged.childModelFallback = typeof merged.childModelFallback === 'string' && merged.childModelFallback.trim()
    ? merged.childModelFallback.trim()
    : null
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
  if (run.queue?.waiting) {
    lines.push(
      `queue: waiting for a free slot — position ${run.queue.position} of ${run.queue.of}; `
      + 'it starts automatically when an active run finishes, does not count against maxActiveRuns while it waits, '
      + `and fails if no slot frees by ${run.queue.timeoutAt}`,
    )
  } else if (run.queue?.expired) {
    lines.push(`queue: timed out after waiting ${run.queue.of > 0 ? `behind ${run.queue.of} run(s)` : 'for a slot'}; it never started`)
  } else if (run.queue?.cancelled) {
    lines.push('queue: cancelled while waiting for a slot; it never started')
  }
  const unreadable = Object.keys(run.counters?.unreadable ?? {}).length
  if (unreadable > 0) {
    lines.push(
      `usage note: ${unreadable} child session log(s) could not be read, so the token figures above cover only `
      + 'the readable ones; the model-call budget counted those children as one call each instead of ignoring them',
    )
  }
  const cost = costLine(run)
  if (cost) lines.push(cost)
  if (run.memory?.digest) {
    lines.push(
      `memory: ${run.memory.notes} note(s) and ${run.memory.runs} earlier run(s) carried into this run `
      + `(${run.memory.digestChars} chars)`,
    )
  }
  if (run.attention?.issue) {
    lines.push(`attention: ${run.attention.issue}`)
  }
  if (run.attention?.items?.length > 0) {
    const first = run.attention.items[0]
    lines.push(`needs your decision: ${first.question}${first.source ? ` (from ${first.source})` : ''}`)
    if (first.options?.length) lines.push(`options: ${first.options.join(' | ')}`)
    if (first.reason) lines.push(`why: ${first.reason}`)
    if (run.attention.items.length > 1) {
      lines.push(`and ${run.attention.items.length - 1} more question(s) recorded on the run`)
    }
  }
  if (Array.isArray(run.milestones) && run.milestones.length > 0) {
    // Times are UTC because the record is ISO; a status line is not a place to
    // start guessing the reader's timezone.
    lines.push(`milestones: ${run.milestones
      .map(milestone => `${milestone.name}@${String(milestone.at ?? '').slice(11, 19)}`)
      .join(' → ')}`)
  }
  const reportArtifact = (run.artifacts ?? []).find(artifact => artifact?.kind === 'report')
  if (reportArtifact?.path) lines.push(`report file: ${reportArtifact.path} (${reportArtifact.bytes} bytes)`)
  else if (run.artifactError) lines.push(`report file: not written — ${run.artifactError}`)
  if (run.deduped) {
    lines.push(
      'deduped: true — an active run with the same goal already exists, so this call joined it instead of starting '
      + 'a second one (pass allow_duplicate: true to start another)',
    )
  }
  if (run.selfHeal?.retried) {
    lines.push(
      `self-heal: retried ${run.selfHeal.retried} failed subtask(s) in ${run.selfHeal.rounds} extra round(s); `
      + `${run.selfHeal.recovered} recovered` + (run.selfHeal.model ? ` (on ${run.selfHeal.model})` : ''),
    )
  }
  if (run.memoryWrite?.written > 0) {
    lines.push(`memory: wrote ${run.memoryWrite.written} note(s) for the next run`)
  } else if (run.memoryWrite?.reason && /^(the memory block|write failed)/.test(run.memoryWrite.reason)) {
    lines.push(`memory note not written: ${run.memoryWrite.reason}`)
  }
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

/** What a failed run already tried, so the message is not just "it broke". */
function triedLine(run) {
  const attempts = run.limits?.attempts ?? 1
  const parts = [`tried: ${attempts} attempt(s) per subtask`]
  if (run.selfHeal?.rounds > 0) {
    parts.push(`${run.selfHeal.rounds} self-heal round(s), ${run.selfHeal.recovered ?? 0} recovered`)
  }
  if (run.selfHeal?.model) parts.push(`switched to ${run.selfHeal.model} for the retry`)
  return `${parts.join('; ')}.`
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
    if (stats.memory) {
      lines.push(`memory: ${stats.memory.entries} note(s), ${formatBytes(stats.memory.bytes)} in ${path.dirname(stats.memory.path)}`)
    }
    if (stats.pendingNotifications > 0) {
      lines.push(`notifications: ${stats.pendingNotifications} run(s) held back by the hourly limit; `
        + 'they are folded into the next message')
    }
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

  // A state directory inside the installed package would put the notebook in a
  // directory that is meant to be shipped byte-for-byte from git. Refuse rather
  // than rely on the `.gitignore` the notebook writes for itself.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const memoryBlocked = isInside(store.root, packageRoot)
  const memory = cfg.memory && !memoryBlocked ? createMemory(store.root, { warn: log }) : null
  if (cfg.memory && memoryBlocked) {
    log(`cross-run memory stays off: stateDir ${store.root} is inside the installed package; point stateDir elsewhere`)
  }
  const notifyPolicy = createNotifyPolicy({
    stateFile: path.join(store.root, 'notifications.json'),
    maxPerHour: cfg.maxNotificationsPerHour,
    warn: log,
  })
  // One wake-up per run, delivered in order per session. A busy session loop
  // can reject a followup, so the same message is retried with backoff instead
  // of being reported as lost on the first refusal.
  const outbox = createOutbox({ retries: cfg.notifyRetries, delayMs: cfg.notifyRetryDelayMs })

  /** Child sessions spawned by this process; a run may not be started from one. */
  const childIds = new Set()

  /**
   * The subagent service is optional, so it is read from the service store at
   * call time rather than declared as an injection: a profile without it must
   * still mount the six tools (they then explain what is missing), and reading
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
   * The notification policy decides first: a cancelled run is never announced,
   * and a burst above the hourly cap is buffered instead of waking the session
   * once per run. The followup is awaited: an unhandled rejection from it would
   * otherwise escape as a host-level error while the run already claims it was
   * delivered.
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
    // Reserve only once the session is known to exist: a missing session is not
    // an interruption and must not consume the hourly budget.
    const verdict = await notifyPolicy.reserve(run)
    if (!verdict.allowed) return { delivered: false, reason: verdict.reason }

    const completed = run.subtasks.filter(subtask => subtask.status === 'completed').length
    const decision = run.attention?.items?.[0] ?? null
    const lines = decision
      ? [`[superagent] needs your decision on run ${run.id}: ${decision.question}`]
      : [`[superagent] run ${run.id} finished: ${run.status} (${completed}/${run.subtasks.length} subtasks).`]
    if (decision) {
      if (decision.options?.length) lines.push(`Options: ${decision.options.join(' / ')}.`)
      lines.push(`The run itself ended as ${run.status} (${completed}/${run.subtasks.length} subtasks).`)
    } else if (run.attention?.issue) {
      // A malformed block asked for a decision too; keeping it quiet would look
      // like an ordinary finished run.
      lines.push(`Attention: ${run.attention.issue}.`)
    }
    if (!decision && run.status !== 'completed') lines.push(triedLine(run))
    if (verdict.batch.length > 0) {
      lines.push(
        'Also finished since the last update: '
        + `${verdict.batch.map(item => `${item.id} ${item.status}`).join('; ')}.`,
      )
    }
    lines.push(`Call superagent_status with run_id="${run.id}" to read the report.`)
    try {
      await outbox.enqueue(run.parentSessionId, () => agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: lines.join(' ') }],
        source: { kind: 'user' },
      }))
      run.notified = true
      return { delivered: true }
    } catch (error) {
      log(`cannot notify session ${run.parentSessionId}: ${error?.message ?? error}`)
      // The folded runs were reserved but never delivered. Put them back so the
      // next allowed message still carries them, up to the policy's retry cap.
      await notifyPolicy.restore(verdict.batch).catch(restoreError => {
        log(`cannot restore ${verdict.batch.length} batched notification(s): ${restoreError?.message ?? restoreError}`)
      })
      return { delivered: false, reason: `waking the session failed: ${error?.message ?? error}` }
    }
  }

  const orchestrator = createOrchestrator({
    store,
    config: cfg,
    log,
    readUsage,
    memory,
    notify: notifyParent,
    async spawnChild({ label, prompt, parent, signal, model }) {
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
      // Only the self-heal round passes a model override; everything else keeps
      // the configured route.
      const childModel = model ?? cfg.childModel
      if (cfg.childProvider) agentOptions.provider = cfg.childProvider
      if (childModel) agentOptions.model = childModel
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
      return { error: describeError('refused: a superagent worker may not start, resume, or cancel runs; finish your subtask instead') }
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
      + 'Pass mode "direct" for a single self-contained task instead: one worker does it, there is no planner '
      + 'or aggregator, and its reply is the report verbatim — use it for one lookup, one edit, one query, or '
      + 'one short piece of writing, not for a goal with parts that can be worked in parallel. '
      + 'The call returns immediately with a run id; poll it with superagent_status. Runs are persisted, '
      + 'so they survive a host restart and can be resumed or cancelled.',
    properties: {
      goal: { type: 'string', description: 'The complete goal for the run. Be specific about the expected outcome.' },
      mode: {
        type: 'string',
        enum: ['planned', 'direct'],
        description: 'planned (default): planner, parallel workers, merged report. direct: one worker runs the whole '
          + 'goal, with no planning or aggregation, and its reply is returned unchanged. Choose direct only when the '
          + 'task is one self-contained pass that gains nothing from splitting.',
      },
      queue: {
        type: 'boolean',
        description: 'When maxActiveRuns is already in use, wait for a free slot instead of failing. The run returns '
          + `status "queued" with its position, starts automatically when another run finishes, and gives up after `
          + `queueTimeoutMinutes (default ${DEFAULTS.queueTimeoutMinutes}). Off by default; at most maxQueuedRuns `
          + `(default ${DEFAULTS.maxQueuedRuns}) may wait.`,
      },
      max_subtasks: { type: 'number', description: `Cap on planned subtasks (default ${DEFAULTS.maxSubtasks}, max 16).` },
      max_parallel: { type: 'number', description: `Subtasks allowed to run at once (default ${DEFAULTS.maxParallel}, max 8).` },
      deadline_minutes: { type: 'number', description: `Wall-clock budget in minutes (default ${DEFAULTS.deadlineMinutes}).` },
      allow_duplicate: {
        type: 'boolean',
        description: 'Start a second run for the same goal even when an active run already has it. '
          + 'By default the active run id is returned instead, so a retry cannot double the spend.',
      },
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
          allowDuplicate: args.allow_duplicate === true,
          mode: args.mode,
          queue: args.queue === true,
          overrides: {
            maxSubtasks: args.max_subtasks,
            maxParallel: args.max_parallel,
            deadlineMinutes: args.deadline_minutes,
          },
        })
        const waitSeconds = Number(args.wait_seconds) || 0
        if (waitSeconds > 0) {
          const finished = await orchestrator.status(run.id, waitSeconds)
          // `status` reads the stored run, which never has the transient join
          // marker; carry it over so the caller can still see it joined.
          return formatRun(run.deduped ? { ...finished, deduped: true } : finished)
        }
        if (run.queue?.waiting) {
          return `${formatRun(run, { includeReport: false })}\n\nQueued, not started: the run begins automatically when `
            + 'an active run finishes. Poll with superagent_status or cancel it with superagent_cancel.'
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
        const memoryStats = memory
          ? await memory.stats({ scope: cfg.memoryScope, maxAgeDays: cfg.memoryMaxAgeDays }).catch(() => null)
          : null
        const notifyState = await notifyPolicy.summary().catch(() => null)
        const extra = stats
          ? {
              ...stats,
              root: store.root,
              memory: memoryStats,
              pendingNotifications: notifyState?.pending?.length ?? 0,
            }
          : null
        return formatList(runs, Math.max(1, Math.min(100, Number(args.limit) || 20)), extra)
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
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
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
      force: {
        type: 'boolean',
        description: 'Resume even when maxActiveRuns is already in use. Off by default, so a script or a loop cannot '
          + 'bypass the active-run cap by resuming repeatedly.',
      },
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
        const run = await orchestrator.resume(
          String(args.run_id ?? '').trim(),
          check.agent,
          exec.clientTimeZone,
          { force: args.force === true },
        )
        const waitSeconds = Number(args.wait_seconds) || 0
        const current = waitSeconds > 0 ? await orchestrator.status(run.id, waitSeconds) : run
        return formatRun(current)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_memory',
    description:
      'Read or correct the cross-run notebook: short notes that earlier runs left for the next one. '
      + 'A note is advisory and can be stale; a new note with the same key supersedes it, and forget retracts it.',
    properties: {
      action: { type: 'string', enum: ['list', 'set', 'forget'], description: 'List notes, set (add or correct) one, or forget one.' },
      key: { type: 'string', description: 'Short topic key. A new note with the same key replaces the older one.' },
      kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'decision, pitfall, next, dispatch, or note.' },
      text: { type: 'string', description: 'The durable fact to record (set only).' },
      scope: {
        type: 'string',
        description: 'Notebook scope: "rules" for project rules, "profile" for user preferences, '
          + 'or the run scope (default) that earlier runs write to.',
      },
      limit: { type: 'number', description: 'Maximum notes to print (default 20).' },
    },
    required: ['action'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      if (!memory) {
        return describeError(
          'cross-run memory is disabled (memory: false, or stateDir points inside the installed package)',
        )
      }
      try {
        await ready
        if (stateError) return describeError(stateError)
        const action = String(args.action ?? '').trim().toLowerCase()
        // A run writes to the configured scope; `rules` and `profile` are
        // curated by hand and read into every run, so the tool can address
        // them explicitly.
        const scope = args.scope === undefined || args.scope === null
          ? cfg.memoryScope
          : normalizeScope(args.scope)
        if (action === 'list') {
          // Capped at 30: this output goes straight into the model context, and a
          // 200-row dump would cost more than the notes are worth.
          const limit = Math.max(1, Math.min(30, Number(args.limit) || 20))
          const result = await memory.list({ scope, limit, maxAgeDays: cfg.memoryMaxAgeDays })
          if (result.total === 0) return `no notes recorded in scope "${scope}" (${result.path})`
          const rows = result.entries.map(entry => `- ${entry.key} [${entry.kind}] ${entry.text}`)
          const notes = result.bad ? `\n\n${result.bad} unreadable line(s) skipped` : ''
          return `${result.total} note(s) in scope "${scope}" (${result.path})\n\n${rows.join('\n')}${notes}`
        }
        if (action === 'forget') {
          const key = String(args.key ?? '').trim()
          if (!key) return describeError('forget needs the key of the note to retract; call action="list" first')
          const result = await memory.forget({ scope, key })
          return result.forgotten
            ? `retracted "${key}" in scope "${scope}"; later runs will not see it`
            : describeError(result.reason ?? 'cannot retract that note')
        }
        if (action === 'set') {
          const key = String(args.key ?? '').trim()
          const text = String(args.text ?? '').trim()
          if (!key || !text) return describeError('set needs both key and text')
          const result = await memory.set({ scope, key, kind: args.kind, text })
          return result.written > 0
            ? `recorded "${key}" in scope "${scope}"; later runs will see it`
            : describeError(result.reason ?? 'cannot record that note')
        }
        return describeError(`unknown action "${args.action}"; use list, set, or forget`)
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
        // Liveness only: a probe must not sweep or reclaim runs, so this
        // deliberately does no state-directory work. Use GET /runs to ask what
        // is running.
        async health() {
          return { runs: 'GET /runs' }
        },
        async list({ limit } = {}) {
          await ready
          if (stateError) throw stateError
          const runs = await orchestrator.list()
          const stats = typeof store.stats === 'function' ? await store.stats() : null
          const rows = Math.max(1, Math.min(100, Number(limit) || 20))
          const visible = runs.slice(0, rows)
          return {
            data: { runs: visible, stats: stats ? { ...stats, root: store.root } : null },
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
          const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
          if (!goal) {
            // Report the caller's mistake as written in the docs: a missing goal
            // is 400, not "you also did not name a session".
            throw new Error('goal is required; pass a concrete goal string')
          }
          const agent = resolveSession(body.session_id)
          const run = await orchestrator.start({
            goal,
            parentSessionId: agent.id,
            parent: agent,
            clientTimeZone: body.time_zone,
            allowDuplicate: body.allow_duplicate === true,
            mode: body.mode,
            queue: body.queue === true,
            overrides: {
              maxSubtasks: body.max_subtasks,
              maxParallel: body.max_parallel,
              deadlineMinutes: body.deadline_minutes,
            },
          })
          const waitSeconds = clampControlWait(body.wait_seconds)
          if (waitSeconds > 0) {
            const finished = await orchestrator.status(run.id, waitSeconds)
            const current = run.deduped ? { ...finished, deduped: true } : finished
            return { data: { run: current }, text: formatRun(current) }
          }
          if (run.queue?.waiting) {
            return {
              data: { run },
              text: `${formatRun(run, { includeReport: false })}\n\nQueued, not started: it begins automatically when `
                + `an active run finishes. Poll GET /runs/${run.id} or cancel it.`,
            }
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
          const run = await orchestrator.resume(
            String(runId ?? '').trim(),
            agent,
            body.time_zone,
            { force: body.force === true || body.override_quota === true },
          )
          const waitSeconds = clampControlWait(body.wait_seconds)
          const current = waitSeconds > 0 ? await orchestrator.status(run.id, waitSeconds) : run
          return { data: { run: current }, text: formatRun(current) }
        },
      },
    })
    let disposed = false
    const stopControl = () => {
      disposed = true
      return control.stop().catch(error => log(`cannot stop the control plane: ${error?.message ?? error}`))
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => stopControl, 'dsh-superagent control plane')
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', stopControl)
    }
    // The state directory is created by `orchestrator.recover()`, which `ready`
    // awaits. Starting before it exists makes the discovery write fail with
    // ENOENT and would leave the plane off for the whole host lifetime.
    ready
      .then(() => {
        if (disposed || stateError) return null
        return control.start()
      })
      .catch(error => {
        log(
          `control plane is not listening: ${error?.message ?? error}; `
          + 'check that controlPort is free and the state directory is writable, '
          + 'or remove controlPort to keep the socket closed',
        )
      })
  }

  log(`registered 6 tools; state ${store.root}${cfg.controlPort === null ? '' : `; control port ${cfg.controlPort}`}`)
}
