/**
 * dsh-superagent — long-horizon autonomous runs for DeepSeek Harness.
 *
 * One goal enters; a planner decomposes it into subtasks; independent subtasks
 * run in parallel child agents while a declared dependency holds the rest back;
 * an aggregator merges their reports. Runs survive a host restart, can be
 * cancelled, and have their token usage read back from the child sessions'
 * durable logs.
 *
 * Registered tools: superagent_start, superagent_status, superagent_list,
 * superagent_cancel, superagent_resume, superagent_followup, superagent_inject,
 * superagent_answer, superagent_memory, superagent_template, superagent_audit.
 *
 * @module dsh-superagent
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
import { createAuditor } from './audit.js'
import { createOrchestrator, followupEffect } from './orchestrator.js'
import { createChildSteerer, createChildWatcher, INJECT_POLL_MS, pendingIds } from './inject.js'
import { createControlPlane } from './control.js'
import { formatMoney } from './cost.js'
import { createGuard } from './guard.js'
import { classifyError, describeError, summarizeError } from './errors.js'
import { createLedger } from './ledger.js'
import { createMemory, isInside, MEMORY_KINDS, normalizeScope } from './memory.js'
import { createNotifyPolicy, createOutbox } from './notify.js'
import { ACTIVE_STATUSES, createStore, resolveStateRoot, TERMINAL_STATUSES } from './store.js'
import { createTemplateStore, expandTemplate, formatTemplateDetail, formatTemplateList, TemplateError } from './templates.js'
import { createUsageReader } from './usage.js'
import { describeWorkspace } from './workspace.js'
import { createRunChangeTracker, createWorkbench } from './workbench.js'

export const name = 'dsh-superagent'
// The host menu and sessions are required. `subagents` is read through
// `ctx.get('subagents')`, so a profile without it still mounts the eleven tools;
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
   * Poll period, in milliseconds, used to observe when a running child claims
   * an injected message. It is the resolution of every reported latency, so it
   * is deliberately visible instead of rounded away.
   */
  injectPollMs: INJECT_POLL_MS,
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
   * Safety guard for child tool calls. Workers inherit the session's filesystem
   * and credentials, so this policy is enforced on the host's tool pipeline.
   * Defaults stand in `lib/guard.js`; see “Safety guard” in the README.
   */
  guard: {
    enabled: true,
    /** Extra writable roots; the child session workspace and OS temp dir are implicit. */
    allowWriteRoots: [],
    /** Extra paths denied for both reading and writing. */
    denyPaths: [],
    /** Extra `{ id, pattern, reason }` command denials. */
    denyCommands: [],
    /** `{ id, pattern, reason }` entries that override a denial; every use is recorded. */
    allowCommands: [],
    /** Events kept per run; the counters still include events beyond the cap. */
    maxEvents: 50,
  },
  /**
   * Append-only audit trail under `<stateDir>/audit/audit.jsonl`. It is an
   * observer layer: turning it off removes the trail, never the run behaviour.
   */
  audit: true,
  /**
   * Permission policy for runs. Unset means `<stateDir>/policy.json` when that
   * file exists, so dropping a policy next to the state is enough to enable it.
   * An empty state means "no policy", which is exactly the old behaviour.
   */
  policyFile: null,
  /** Where the audit JSONL lives; defaults to `<stateDir>/audit`. */
  auditDir: null,
  /**
   * Loopback HTTP port for the embedding surface. `null` (default) keeps the
   * socket closed; `0` asks the OS for a free port. The bound address and its
   * bearer token are written to `<stateDir>/control.json`.
   */
  controlPort: null,
  /**
   * Run every worker in its own git worktree of `workspaceRoot`, so parallel
   * workers cannot overwrite each other's files. Off by default: it needs a
   * git repository and it moves files, which is not something a plugin should
   * start doing unasked.
   */
  workspaceIsolation: false,
  /** Repository whose worktrees isolate the workers; defaults to the host's cwd. */
  workspaceRoot: null,
  /**
   * Loopback HTTP port for the local workspace panel. `null` (default) keeps it
   * off; `0` asks the OS for a free port. The bound address and its one-time
   * token are written to `<stateDir>/workbench.json`.
   */
  workbenchPort: null,
  /**
   * Directory the panel may read and edit. Everything outside it is refused.
   * Defaults to the host process's working directory.
   */
  workbenchRoot: null,
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
  merged.workbenchPort = controlPortOf(merged.workbenchPort)
  merged.workbenchRoot = typeof merged.workbenchRoot === 'string' && merged.workbenchRoot.trim()
    ? merged.workbenchRoot.trim()
    : null
  merged.maxSubagentDepth = merged.maxSubagentDepth === 'provider-managed'
    ? 'provider-managed'
    : bounded(merged.maxSubagentDepth, DEFAULTS.maxSubagentDepth, 0, 4)
  // Per-model prices merge, so a user can add one route without restating the
  // built-in table.
  merged.pricing = { ...DEFAULTS.pricing, ...(config?.pricing ?? {}) }
  merged.memory = flag(merged.memory, DEFAULTS.memory)
  merged.audit = flag(merged.audit, DEFAULTS.audit)
  merged.policyFile = typeof merged.policyFile === 'string' && merged.policyFile.trim()
    ? merged.policyFile.trim()
    : null
  merged.auditDir = typeof merged.auditDir === 'string' && merged.auditDir.trim()
    ? merged.auditDir.trim()
    : null
  merged.memoryScope = normalizeScope(merged.memoryScope)
  merged.memoryMaxEntries = bounded(merged.memoryMaxEntries, DEFAULTS.memoryMaxEntries, 1, 500)
  merged.memoryMaxAgeDays = bounded(merged.memoryMaxAgeDays, DEFAULTS.memoryMaxAgeDays, 1, 3650)
  merged.memoryDigestEntries = bounded(merged.memoryDigestEntries, DEFAULTS.memoryDigestEntries, 1, 50)
  merged.memoryDigestChars = bounded(merged.memoryDigestChars, DEFAULTS.memoryDigestChars, 200, 8000)
  merged.autoResumeRounds = bounded(merged.autoResumeRounds, DEFAULTS.autoResumeRounds, 0, 3)
  merged.notifyRetries = bounded(merged.notifyRetries, DEFAULTS.notifyRetries, 0, 5)
  merged.notifyRetryDelayMs = bounded(merged.notifyRetryDelayMs, DEFAULTS.notifyRetryDelayMs, 0, 60000)
  merged.injectPollMs = bounded(merged.injectPollMs, DEFAULTS.injectPollMs, 10, 1000)
  merged.maxNotificationsPerHour = bounded(merged.maxNotificationsPerHour, DEFAULTS.maxNotificationsPerHour, 0, 1000)
  merged.childModelFallback = typeof merged.childModelFallback === 'string' && merged.childModelFallback.trim()
    ? merged.childModelFallback.trim()
    : null
  merged.workspaceIsolation = flag(merged.workspaceIsolation, DEFAULTS.workspaceIsolation)
  // A blank path would resolve to the cwd, which is how isolation would silently
  // point at the wrong repository; blank therefore means "use the default".
  merged.workspaceRoot = typeof merged.workspaceRoot === 'string' && merged.workspaceRoot.trim()
    ? merged.workspaceRoot.trim()
    : null
  // The guard block merges so a user can set only `allowCommands` without
  // restating the rest of the defaults.
  merged.guard = {
    ...DEFAULTS.guard,
    ...(config?.guard && typeof config.guard === 'object' ? config.guard : {}),
  }
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

/**
 * Cost line for one run. The number is an estimate from the configured list
 * prices; models without a price are named instead of guessed so a user can
 * always tell how much of the spend the figure covers.
 */
function costLine(run) {
  if (!run.usage || !run.usage.modelCalls) return null
  const models = Object.keys(run.usage.models ?? {})
  const cost = run.cost
  // An all-unpriced run has no priced line at all. Printing 0.0000 there would
  // claim the run was free, which is the one thing an estimate must not do.
  const priced = Boolean(cost) && Object.keys(cost.byModel ?? {}).length > 0
  if (!priced) {
    const named = cost?.unpriced?.length ? cost.unpriced.join(', ') : (models.join(', ') || 'this model')
    return `cost: not computed — no price configured for ${named}; `
      + 'add a pricing entry in cordis.patch.yml to get an estimate'
  }
  const money = formatMoney(cost)
  if (cost.complete) return `cost: ${money} (estimate; all models priced)`
  return `cost: at least ${money} (estimate; no price for ${cost.unpriced.join(', ')})`
}

/** Spend for one subtask: measured when priced, explicit when not. */
function subtaskCostText(subtask) {
  if (!subtask?.usage || !subtask.usage.modelCalls) return ''
  const cost = subtask.cost
  if (!cost || Object.keys(cost.byModel ?? {}).length === 0) {
    const named = cost?.unpriced?.length ? ` (${cost.unpriced.join(', ')})` : ''
    return `, cost unpriced${named}`
  }
  return `, ${formatMoney(cost)}${cost.complete ? '' : '+'}`
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
  if (run.guard && (run.guard.blocked > 0 || run.guard.allowed > 0)) {
    const rules = Object.entries(run.guard.byRule ?? {})
      .map(([rule, count]) => `${rule} ×${count}`)
      .join(', ')
    lines.push(
      `guard: ${run.guard.blocked} tool call(s) blocked; ${run.guard.allowed} explicit allow(s) recorded`
      + (rules ? ` (${rules})` : ''),
    )
    for (const event of (run.guard.events ?? []).filter(item => item.decision === 'blocked').slice(0, 3)) {
      const detail = String(event.detail ?? '').replace(/\s+/g, ' ').slice(0, 120)
      lines.push(`  blocked ${event.tool}${event.label ? ` (${event.label})` : ''}: ${detail} — ${event.rule}`)
    }
  }
  if (run.attention?.issue) {
    lines.push(`attention: ${run.attention.issue}`)
  }
  if (run.attention?.items?.length > 0) {
    const items = run.attention.items
    const idOf = item => item.id ?? `q${items.indexOf(item) + 1}`
    const open = items.filter(item => !item.answer)
    const first = open[0] ?? items[0]
    if (open.length > 0) {
      lines.push(`needs your decision: ${first.question}${first.source ? ` (from ${first.source})` : ''}`)
      if (first.options?.length) lines.push(`options: ${first.options.join(' | ')}`)
      if (first.reason) lines.push(`why: ${first.reason}`)
      lines.push(`attention id: ${idOf(first)}`)
    } else {
      // Answering does not hide the question: the record shows what was decided.
      lines.push(`answered [${idOf(first)}]: ${first.question} — ${first.answer}`)
    }
    if (open.length > 1) {
      lines.push(`and ${open.length - 1} more open question(s): ${open.slice(1).map(idOf).join(', ')}`)
    }
  }
  if (Array.isArray(run.followups) && run.followups.length > 0) {
    const pending = run.followups.filter(entry => !entry.appliedAt)
    const missed = pending.filter(entry => entry.missedAt)
    const applied = run.followups.length - pending.length
    if (applied > 0) {
      const stages = [...new Set(run.followups.filter(entry => entry.appliedAt).map(entry => entry.appliedAtStage))]
      lines.push(`instructions: ${applied} added during the run, applied at ${stages.join(' / ')}`)
    }
    if (pending.length > missed.length) {
      lines.push(
        `instructions: ${pending.length - missed.length} waiting; they take effect at ${followupEffect(run).detail}`,
      )
    }
    if (missed.length > 0) {
      lines.push(
        `instructions: ${missed.length} never took effect — ${missed[0].missedReason ?? 'the run settled first'}`,
      )
    }
  }
  if (Array.isArray(run.injections) && run.injections.length > 0) {
    const degraded = run.injections.filter(entry => entry.status === 'degraded')
    const targets = run.injections.flatMap(entry => entry.targets ?? [])
    const applied = targets.filter(target => target.status === 'applied')
    const pending = targets.filter(target => target.status === 'pending')
    const missed = targets.filter(target => target.status === 'missed' || target.status === 'failed')
    const worst = run.injectionStats?.worstLatencyMs
    if (applied.length > 0) {
      lines.push(
        `live injections: ${applied.length} reached a child's next step`
        + (Number.isFinite(worst) ? ` (worst measured ${worst} ms)` : ''),
      )
    }
    if (pending.length > 0) {
      lines.push(`live injections: ${pending.length} accepted and waiting for a child's next step boundary`)
    }
    if (missed.length > 0) {
      lines.push(
        `live injections: ${missed.length} never entered a prompt — `
        + `${missed[0].missedReason ?? missed[0].error ?? 'the child left first'}`,
      )
    }
    if (degraded.length > 0) {
      lines.push(
        `live injections: ${degraded.length} could not be delivered live and were queued; they take effect at `
        + followupEffect(run).detail,
      )
    }
  }
  if (Array.isArray(run.milestones) && run.milestones.length > 0) {
    // Times are UTC because the record is ISO; a status line is not a place to
    // start guessing the reader's timezone.
    lines.push(`milestones: ${run.milestones
      .map(milestone => `${milestone.name}@${String(milestone.at ?? '').slice(11, 19)}`)
      .join(' → ')}`)
  }
  lines.push(...describeWorkspace(run.workspace))
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
    const tokens = subtask.usage
      ? ` ${subtask.usage.inputTokens} in / ${subtask.usage.outputTokens} out${subtaskCostText(subtask)}`
      : ''
    // A subtask waiting on a dependency is not running and not failed; saying
    // which tasks it waits for is the difference between "stuck" and "queued".
    const waiting = subtask.status === 'waiting' && subtask.waitingOn?.length > 0
      ? ` — waiting on ${subtask.waitingOn.join(', ')}`
      : ''
    const skipped = subtask.status === 'skipped' && subtask.skippedReason
      ? ` — skipped: ${subtask.skippedReason}`
      : ''
    const detail = skipped || (subtask.error ? ` — ${summarizeError(subtask.error)}` : '')
    // A cancelled run never judged its unfinished subtasks, so calling them
    // "pending" or "failed (attempts 0)" would misreport what happened.
    const status = run.status === 'cancelled' && subtask.status !== 'completed'
      ? (subtask.attempts > 0 ? 'cancelled' : 'skipped')
      : subtask.status
    lines.push(`  [${subtask.index}] ${status} (attempts ${subtask.attempts}) ${subtask.title}${tokens}${waiting}${detail}`)
  }
  const failed = run.subtasks.find(subtask => subtask.error)
  if (failed) {
    const hint = classifyError(failed.error).hint
    if (classifyError(failed.error).id !== 'unclassified') lines.push('', `hint: ${hint}`)
  }
  if (includeReport && run.report) {
    lines.push('', 'report:', '', preview(run.report))
  }
  const openQuestion = (run.attention?.items ?? []).find(item => !item.answer)
  if (openQuestion) {
    // The user can act on this line directly; the id is what makes the answer
    // land on the question it belongs to.
    lines.push('', `next: superagent_answer run_id="${run.id}" attention_id="${openQuestion.id ?? 'q1'}" answer="..."`)
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

/**
 * The reply for one live injection.
 *
 * The wording separates four states instead of collapsing them into "sent":
 * accepted (the child's inbox holds the message), applied (a step boundary
 * claimed it, with the measured delay), pending (still waiting for that
 * boundary), and missed (the child left before it could read the message).
 *
 * @param {object} run - live run record.
 * @param {object} entry - injection receipt.
 * @param {object | null} degraded - queued-as-followup fallback, when the host has no live channel.
 * @param {{ pollMs: number }} options - poll resolution used for the measurement.
 * @returns {string} the tool reply.
 */
function formatInjectionReply(run, entry, degraded, { pollMs }) {
  const targets = entry?.targets ?? []
  const accepted = targets.filter(target => target.messageId)
  const applied = targets.filter(target => target.status === 'applied')
  const missed = targets.filter(target => target.status === 'missed')
  const failed = targets.filter(target => target.status === 'failed')
  const pending = targets.filter(target => target.status === 'pending')
  const lines = []

  if (degraded) {
    lines.push(
      `instruction ${entry.id} could not be delivered live on run ${run.id}: ${degraded.reason}`,
      `it was queued as instruction ${degraded.followup.id} instead, and takes effect at ${degraded.effect.detail} `
      + `(boundary: ${degraded.effect.boundary}).`,
      'a worker that is already running is not interrupted and does not see it.',
    )
    return lines.join('\n')
  }

  lines.push(
    `instruction ${entry.id} accepted by ${accepted.length}/${targets.length} running worker(s) on run ${run.id} — `
    + `${run.status}`,
  )
  for (const target of targets) {
    const who = `subtask ${target.subtaskIndex} (child ${target.childId})`
    if (target.status === 'applied') {
      lines.push(`  ${who}: seen at the child's next step after ${target.latencyMs ?? '?'} ms${target.via ? ` via ${target.via}` : ''}`)
    } else if (target.status === 'pending') {
      lines.push(`  ${who}: accepted (message ${target.messageId}); it has not reached a step boundary yet`)
    } else if (target.status === 'missed') {
      lines.push(`  ${who}: missed — ${target.missedReason}`)
    } else {
      lines.push(`  ${who}: not delivered — ${target.error ?? 'unknown error'}`)
    }
  }
  const stats = run.injectionStats
  const worst = Number.isFinite(stats?.worstLatencyMs) ? `${stats.worstLatencyMs} ms` : 'not measured yet'
  lines.push(
    'delivery: steering is read at the child\'s next step boundary, just before its next model request. It does not '
    + 'interrupt a model call already in flight, so the worst case is the remainder of that step (its model response '
    + 'plus tool batch).',
    `measured on this run: worst ${worst} over ${stats?.samples ?? 0} claimed message(s); the poll resolution is `
    + `${pollMs} ms.`,
  )
  if (pending.length > 0) {
    lines.push(
      `not seen yet: ${pending.length} message(s) are still waiting at a live child's boundary; this reply does not `
      + 'claim they were read. superagent_status shows the receipt once the boundary claims it.',
    )
  }
  if (missed.length + failed.length > 0) {
    lines.push(
      `${missed.length + failed.length} message(s) never entered a prompt. If the work must still change, send the `
      + 'instruction again to a running worker, or use superagent_followup for the next prompt.',
    )
  }
  lines.push('', formatRun(run, { includeReport: false }))
  return lines.join('\n')
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
    if (stats.ledger) {
      const ledger = stats.ledger
      if (ledger.runs === 0) {
        lines.push(`ledger: no spend recorded in the last ${stats.ledgerDays} days`)
      } else if (ledger.priced === 0) {
        lines.push(`ledger: ${ledger.runs} run(s) in the last ${stats.ledgerDays} days are unpriced — `
          + 'no configured price matches their models, so no total is claimed')
      } else {
        const total = ledger.mixedCurrency
          ? `${formatMoney({ totalMicros: ledger.totalMicros, currency: ledger.currency ?? 'USD' })}`
          : formatMoney({ totalMicros: ledger.totalMicros, currency: ledger.currency })
        lines.push(`ledger: ${total} across ${ledger.priced} priced run(s) in the last ${stats.ledgerDays} days`
          + (ledger.unpricedRuns > 0 ? ` (${ledger.unpricedRuns} run(s) partially unpriced)` : '')
          + (ledger.mixedCurrency ? ' (mixed currencies; figure uses the first)' : ''))
      }
    }
  }
  return lines.join('\n')
}

function toolText(text) {
  return [{ type: 'text', text }]
}

/**
 * Render one audit query as a short report: the window, how the events break
 * down, and the latest rows. The full detail stays one export away, so this
 * never floods the session with a thousand lines it cannot use.
 */
function formatAudit(result, { limit = 8 } = {}) {
  const { events, scanned, invalid, torn, file } = result
  const notes = []
  if (invalid) notes.push(`${invalid} unreadable line(s) skipped`)
  if (torn) notes.push('1 torn trailing line ignored')
  const tail = notes.length > 0 ? `; ${notes.join('; ')}` : ''
  if (events.length === 0) return `audit: no matching events (${scanned} scanned in ${file}${tail})`
  const tally = field => {
    const counts = new Map()
    for (const event of events) {
      const key = event[field] ?? 'none'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} ${count}`)
      .join(', ')
  }
  const lines = [
    `audit: ${events.length} event(s) match (${scanned} scanned in ${file}${tail})`,
    `window: ${events[0].at} .. ${events.at(-1).at}`,
    `decision: ${tally('decision')}`,
    `kind: ${tally('kind')}`,
    `result: ${tally('result')}`,
    'latest:',
  ]
  for (const event of events.slice(-Math.max(1, limit))) {
    lines.push(
      `  ${event.at}  ${String(event.decision ?? '-').padEnd(7)}  ${String(event.kind).padEnd(12)}  `
      + `${String(event.runId ?? '-').padEnd(14)}  ${event.rule ?? '-'}  ${event.target ?? ''}`.trimEnd(),
    )
  }
  return lines.join('\n')
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
  const configuredWorkbenchPort = config?.workbenchPort
  const cfg = resolveConfig(config)
  if (configuredPort !== undefined && configuredPort !== null && cfg.controlPort === null) {
    log(`controlPort ${JSON.stringify(configuredPort)} is not a whole number in 0–65535; the local HTTP control plane stays off`)
  }
  if (configuredWorkbenchPort !== undefined && configuredWorkbenchPort !== null && cfg.workbenchPort === null) {
    log(`workbenchPort ${JSON.stringify(configuredWorkbenchPort)} is not a whole number in 0–65535; the workspace panel stays off`)
  }
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    console.error('[dsh-superagent] host exposes no tools service; plugin disabled')
    return
  }

  const baseStore = createStore(resolveStateRoot(cfg.stateDir), { warn: log })
  const workbenchRoot = cfg.workbenchRoot ? path.resolve(cfg.workbenchRoot) : process.cwd()
  // The panel reads `run.changes` from the durable record. The tracker writes
  // that field through the same store the orchestrator already uses, so the
  // orchestrator itself needs no edit and the panel can stay opt-in.
  const changeTracker = cfg.workbenchPort === null
    ? null
    : createRunChangeTracker({ store: baseStore, root: workbenchRoot, stateRoot: baseStore.root, warn: log })
  const store = changeTracker?.store ?? baseStore
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const readUsage = createUsageReader({ sessionsRoot: path.join(home, 'sessions'), warn: log })
  // The ledger is an append-only history of priced runs. Writing it here, from
  // the read paths, keeps it out of the scheduling loop: a status or list call
  // is already a snapshot of finished work, and a run is recorded exactly once.
  const ledger = createLedger(store.root, { warn: log })
  const LEDGER_WINDOW_DAYS = 30

  /** Append finished runs to the spend ledger; a ledger fault never blocks a tool. */
  async function recordSpend(runs) {
    for (const run of runs) {
      try {
        await ledger.record(run)
      } catch (error) {
        log(`ledger: cannot record run ${run?.id}: ${error?.message ?? error}`)
      }
    }
  }

  // A state directory inside the installed package would put the notebook in a
  // directory that is meant to be shipped byte-for-byte from git. Refuse rather
  // than rely on the `.gitignore` the notebook writes for itself.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const memoryBlocked = isInside(store.root, packageRoot)
  const memory = cfg.memory && !memoryBlocked ? createMemory(store.root, { warn: log }) : null
  if (cfg.memory && memoryBlocked) {
    log(`cross-run memory stays off: stateDir ${store.root} is inside the installed package; point stateDir elsewhere`)
  }
  // Built-ins need no storage; only custom templates touch the state directory,
  // and a state directory inside the package must not receive new files.
  const templates = createTemplateStore(store.root, { warn: log })
  // The trail and its policy live beside the run state, so one directory holds
  // everything a reviewer needs. A policy the user did not name is picked up
  // only when it already exists; without one, runs behave exactly as before.
  const auditDir = cfg.auditDir ? path.resolve(cfg.auditDir) : path.join(store.root, 'audit')
  const implicitPolicy = path.join(store.root, 'policy.json')
  const policyFile = cfg.policyFile
    ? path.resolve(cfg.policyFile)
    : (existsSync(implicitPolicy) ? implicitPolicy : null)
  const auditBlocked = isInside(auditDir, packageRoot)
  const auditor = cfg.audit && !auditBlocked ? createAuditor({ dir: auditDir, policyFile, warn: log }) : null
  if (cfg.audit && auditBlocked) {
    log(`audit trail stays off: ${auditDir} is inside the installed package; point stateDir or auditDir elsewhere`)
  }
  if (auditor) {
    auditor.policyError()
      .then(error => {
        if (error) log(error.message ?? String(error))
      })
      .catch(() => {})
    log(`audit trail ${auditor.file}; policy ${policyFile ?? 'none (permissive)'}`)
  }

  // The guard is mounted on the host's tool pipeline, scoped to children this
  // plugin spawns. `process.cwd()` is only a fallback: every call uses the
  // child session's own workspace when the host exposes one.
  const guard = createGuard({ config: cfg.guard, cwd: process.cwd(), warn: log })
  if (guard.enabled) {
    const enforce = exec => {
      const verdict = guard.checkToolCall(exec)
      if (!verdict.blocked) return undefined
      log(`guard blocked ${exec?.name ?? 'tool'} for ${verdict.label ?? 'a worker'}: ${verdict.rule} — ${verdict.reason}`)
      // A block is evidence, so it belongs in the same trail as every other
      // decision. The guard owns the verdict; the trail only records it.
      if (auditor && typeof auditor.record === 'function') {
        auditor.record({
          kind: 'blocked',
          action: exec?.name ?? 'tool',
          target: verdict.detail ?? null,
          actor: verdict.label ?? null,
          decision: 'deny',
          result: 'blocked',
          rule: verdict.rule ?? null,
          source: 'guard',
          meta: { reason: verdict.reason ?? null },
        }).catch(error => log(`audit: cannot record guard block: ${error?.message ?? error}`))
      }
      return verdict.reasonText
    }
    let hooked = false
    if (typeof ctx.tools.guard === 'function') {
      const release = ctx.tools.guard(enforce)
      hooked = true
      if (typeof release === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => release())
      }
    } else if (typeof ctx.on === 'function') {
      ctx.on('tools/pre-execute', async (exec, next) => {
        const reason = enforce(exec)
        return reason ? { kind: 'deny', reason } : next()
      })
      hooked = true
    }
    if (!hooked) {
      log('guard is enabled but this host exposes neither tools.guard nor tools/pre-execute; child calls are not gated')
    }
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
   * still mount the eleven tools (they then explain what is missing), and reading
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

  /** The agent registry, read lazily for the same reason as `subagents`. */
  function getAgents() {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('agents')
      if (service) return service
    }
    return undefined
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
    const decision = (run.attention?.items ?? []).find(item => !item.answer) ?? null
    const questionId = decision?.id ?? (decision ? 'q1' : null)
    const lines = decision
      ? [`[superagent] needs your decision on run ${run.id} (question ${questionId}): ${decision.question}`]
      : [`[superagent] run ${run.id} finished: ${run.status} (${completed}/${run.subtasks.length} subtasks).`]
    if (decision) {
      if (decision.options?.length) lines.push(`Options: ${decision.options.join(' / ')}.`)
      lines.push(`The run itself ended as ${run.status} (${completed}/${run.subtasks.length} subtasks).`)
      lines.push(`Answer with superagent_answer attention_id="${questionId}".`)
    } else if (run.attention?.issue) {
      // A malformed block asked for a decision too; keeping it quiet would look
      // like an ordinary finished run.
      lines.push(`Attention: ${run.attention.issue}.`)
    }
    if (!decision && run.status !== 'completed') lines.push(triedLine(run))
    if (run.workspace?.conflicts > 0) {
      // A conflict is the one outcome the user must act on even when the run
      // "completed": saying only "finished: completed" would bury it.
      lines.push(
        `${run.workspace.conflicts} worker branch(es) could not be merged into ${run.workspace.base}; `
        + 'both sides were kept, so nothing was lost — superagent_status lists the conflicting files and the branch '
        + 'to merge by hand.',
      )
    } else if (run.workspace?.mode === 'unavailable') {
      lines.push(`Workspace isolation was unavailable (${run.workspace.reason}), so the workers shared one directory.`)
    }
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
    guard,
    audit: auditor,
    notify: notifyParent,
    // Live delivery into a running child. The steerer reads both services at
    // call time; the inspector gives the orchestrator the child's inbox state
    // at the moment its attempt ends, before disposal.
    steerChild: createChildSteerer({ getSubagents, getAgents, log }),
    inspectChild(childId) {
      const agent = getAgents()?.get?.(childId)
      return { live: Boolean(agent), pending: pendingIds(agent) }
    },
    watchChild: createChildWatcher({
      resolveChild: childId => getAgents()?.get?.(childId),
      intervalMs: cfg.injectPollMs,
    }),
    async spawnChild({ label, prompt, parent, signal, model, runId }) {
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
      guard.bindChild(activation.childId, { runId, label })
      return {
        childId: activation.childId,
        result: activation.result,
        dispose: async () => {
          guard.unbindChild(activation.childId)
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
    // Backfill runs that settled while no tool was watching, so the ledger is
    // complete after a restart. Recording is idempotent: a normal mount adds
    // nothing for runs already written.
    try {
      await recordSpend(await orchestrator.list())
    } catch (error) {
      log(`ledger: cannot backfill from runs: ${error?.message ?? error}`)
    }
    // Templates are optional: a failure here must not make every run tool
    // answer with a state error, and the built-ins still work without a file.
    if (!memoryBlocked) {
      try {
        await templates.init()
      } catch (error) {
        log(`cannot create the template directory ${templates.dir}: ${error?.message ?? error}`)
      }
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
      'Start a long-horizon autonomous run: a planner decomposes the goal into subtasks, '
      + 'independent subtasks run in parallel child agents while ones with a declared dependency wait for it, '
      + 'and their reports are merged into one final report. '
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
      approve_policy: {
        type: 'boolean',
        description: 'Release a start that the permission policy holds for confirmation. The approval is '
          + 'recorded in the audit trail. It cannot override a policy that denies the start.',
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
          approvePolicy: args.approve_policy === true,
          overrides: {
            maxSubtasks: args.max_subtasks,
            maxParallel: args.max_parallel,
            deadlineMinutes: args.deadline_minutes,
          },
        })
        const waitSeconds = Number(args.wait_seconds) || 0
        if (waitSeconds > 0) {
          const finished = await orchestrator.status(run.id, waitSeconds)
          await recordSpend([finished])
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
        await recordSpend([run])
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
        await recordSpend(runs)
        const stats = typeof store.stats === 'function' ? await store.stats() : null
        const memoryStats = memory
          ? await memory.stats({ scope: cfg.memoryScope, maxAgeDays: cfg.memoryMaxAgeDays }).catch(() => null)
          : null
        const notifyState = await notifyPolicy.summary().catch(() => null)
        const ledgerStats = await ledger
          .summarize({ since: Date.now() - LEDGER_WINDOW_DAYS * 86400000 })
          .catch(() => null)
        const extra = stats
          ? {
              ...stats,
              root: store.root,
              memory: memoryStats,
              pendingNotifications: notifyState?.pending?.length ?? 0,
              ledger: ledgerStats,
              ledgerDays: LEDGER_WINDOW_DAYS,
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
        await recordSpend([run])
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
      + 'Completed subtasks are kept; pending and failed ones run again. A completed run is reopened only when it '
      + 'holds an answer that never reached a prompt, so its aggregation can apply the decision.',
    properties: {
      run_id: { type: 'string', description: 'Run id to resume.' },
      wait_seconds: { type: 'number', description: 'Block up to this many seconds for a terminal state (default 0).' },
      force: {
        type: 'boolean',
        description: 'Accepted for backward compatibility and ignored: a resume is never refused by maxActiveRuns.',
      },
      approve_policy: {
        type: 'boolean',
        description: 'Release a resume that the permission policy holds for confirmation. The approval is '
          + 'recorded in the audit trail. It cannot override a policy that denies the resume.',
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
          { force: args.force === true, approvePolicy: args.approve_policy === true },
        )
        const waitSeconds = Number(args.wait_seconds) || 0
        const current = waitSeconds > 0 ? await orchestrator.status(run.id, waitSeconds) : run
        await recordSpend([current])
        return formatRun(current)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_followup',
    description:
      'Add an instruction to a run that is already executing, instead of starting a second run. This is not a live '
      + 'channel to the running children: the host has no way to append a message to a child activation, so the '
      + 'instruction is queued on the run and carried by the next prompt built for it — the next worker spawn or the '
      + 'aggregation, whichever comes first. Subtasks that are already running or finished keep their results. The '
      + 'reply states exactly which boundary it will reach.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by superagent_start.' },
      message: { type: 'string', description: 'The instruction or constraint to add.' },
    },
    required: ['run_id', 'message'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        const result = await orchestrator.followup(
          String(args.run_id ?? '').trim(),
          args.message,
          check.agent,
        )
        return [
          `instruction ${result.followup.id} added to run ${result.run.id} — ${result.run.status}`,
          `when it takes effect: ${result.effect.detail} (boundary: ${result.effect.boundary}).`,
          'A child that is already running is not interrupted and does not see it.',
          '',
          formatRun(result.run, { includeReport: false }),
        ].join('\n')
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_inject',
    description:
      'Deliver an instruction into the workers that are running right now, instead of waiting for the next prompt. '
      + 'The host reads steering at a child\'s next step boundary, so the message becomes part of that child\'s next '
      + 'model request: it never interrupts a model call already in flight, and it arrives only after the current step '
      + '(the model response plus its tool batch) finishes. A live child that had already decided to stop runs one more '
      + 'turn to read it. The reply reports the measured delay from acceptance to the child\'s next request; a message '
      + 'the child never claimed is reported as missed, never as delivered. Use superagent_followup when no worker is '
      + 'running or the instruction can wait for the next prompt.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by superagent_start.' },
      message: { type: 'string', description: 'The instruction or constraint the running workers should read next.' },
      subtask_index: {
        type: 'number',
        description: 'Narrow delivery to one running worker, using its index from superagent_status. Omit to reach every running worker.',
      },
      wait_seconds: {
        type: 'number',
        description: 'Block up to this many seconds for the children to claim the message, so the reply can report the measured delay (default 0).',
      },
    },
    required: ['run_id', 'message'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        const result = await orchestrator.inject(
          String(args.run_id ?? '').trim(),
          args.message,
          check.agent,
          { subtaskIndex: args.subtask_index },
        )
        const entry = await orchestrator.waitForInjection(result.run, result.injection, args.wait_seconds)
        return formatInjectionReply(result.run, entry, result.degraded, { pollMs: cfg.injectPollMs })
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'superagent_answer',
    description:
      'Answer a question a run asked — the "needs your decision" item with a qN id — so that run continues with the '
      + 'decision instead of a new run being started. An active run applies it at its next boundary; a finished run '
      + 'is reopened and only its aggregation runs again, now with the answer. The answer is matched to one specific '
      + 'question: an unknown, already answered, or expired question is refused instead of being attached to whatever '
      + 'is open.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by superagent_start.' },
      attention_id: {
        type: 'string',
        description: 'Question id from superagent_status, e.g. q1. Required when the run has more than one open question.',
      },
      answer: { type: 'string', description: 'The decision itself; one of the listed options is enough, free text is allowed.' },
      wait_seconds: { type: 'number', description: 'Block up to this many seconds for the run to settle again (default 0).' },
    },
    required: ['run_id', 'answer'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        const result = await orchestrator.answer(
          String(args.run_id ?? '').trim(),
          args.attention_id,
          args.answer,
          check.agent,
          exec.clientTimeZone,
        )
        let head
        if (result.resumed) {
          head = `answered ${result.attentionId} on run ${result.run.id}; the run was reopened and is ${result.run.status} `
            + `again — it applies the answer at ${result.effect.detail}`
        } else if (result.reason) {
          head = `answered ${result.attentionId} on run ${result.run.id}, but the run was not restarted: ${result.reason}. `
            + 'The answer is saved; call superagent_resume when you want it applied.'
        } else {
          head = `answered ${result.attentionId} on run ${result.run.id}; it takes effect at ${result.effect.detail}`
        }
        const waitSeconds = Number(args.wait_seconds) || 0
        const current = result.resumed && waitSeconds > 0
          ? await orchestrator.status(result.run.id, waitSeconds)
          : result.run
        return `${head}.\n\n${formatRun(current)}`
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
      action: {
        type: 'string',
        enum: ['list', 'search', 'set', 'forget'],
        description: 'List notes, search them by keyword or tag, set (add or correct) one, or forget one.',
      },
      key: { type: 'string', description: 'Short topic key. A new note with the same key replaces the older one.' },
      kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'decision, pitfall, next, dispatch, or note.' },
      text: { type: 'string', description: 'The durable fact to record (set only).' },
      query: {
        type: 'string',
        description: 'Keywords to rank notes by (search only). The goal of the current task works well.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Topic labels to match exactly (search) or to attach to a note (set).',
      },
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
        if (action === 'search') {
          const query = String(args.query ?? '').trim()
          const tags = Array.isArray(args.tags) ? args.tags : []
          if (!query && tags.length === 0) {
            return describeError('search needs a query, tags, or both; call action="list" to read everything')
          }
          const limit = Math.max(1, Math.min(20, Number(args.limit) || 10))
          const result = await memory.recall({
            scope,
            query,
            tags,
            maxEntries: limit,
            maxAgeDays: cfg.memoryMaxAgeDays,
          })
          if (result.matched === 0) {
            return `no note in scope "${scope}" matches ${query ? `“${query}”` : 'those tags'} `
              + `(${result.total} note(s) recorded; action="list" shows them all)`
          }
          // The score and its parts are printed so a ranking can be argued with
          // instead of taken on faith.
          const rows = result.entries.map(entry => {
            const run = entry.source.runId ?? 'manual'
            return `- ${entry.key} [${entry.kind}] score ${entry.score.toFixed(2)} `
              + `(keyword ${entry.keyword.toFixed(2)}, tag ${entry.tag.toFixed(2)}) `
              + `from run ${run}, ${String(entry.source.ts ?? '').slice(0, 10)}: ${entry.text}`
          })
          return `${result.matched} of ${result.total} note(s) in scope "${scope}" match, best first\n\n${rows.join('\n')}`
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
          const result = await memory.set({ scope, key, kind: args.kind, text, tags: args.tags })
          return result.written > 0
            ? `recorded "${key}" in scope "${scope}"; later runs will see it`
            : describeError(result.reason ?? 'cannot record that note')
        }
        return describeError(`unknown action "${args.action}"; use list, search, set, or forget`)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  /**
   * A template failure already names the concrete problem (which parameters
   * are missing, which field is not allowed), so it gets its own hint instead
   * of the generic "this came from the host" text.
   */
  function templateProblem(error) {
    const hints = {
      'missing-parameters': 'pass every declared parameter in params={...}; a template never guesses a default, '
        + 'and action="show" lists each parameter with what it should contain',
      'unknown-parameters': 'remove the parameters the template does not declare, or declare them in a custom '
        + 'template saved with action="save"',
      'builtin-template': 'built-in templates are read-only; save your version under a new id',
      'unknown-template': 'call action="list" to see the available template ids',
    }
    const hint = hints[error.code]
      ?? 'call action="show" on a built-in template to see the accepted fields, then save the corrected definition'
    return [`[error] ${error.message}`, `hint: ${hint}`].join('\n')
  }

  ctx.tools.register(defineTool({
    name: 'superagent_template',
    description:
      'List, show, expand, save, or delete a workflow template: a fixed goal skeleton with required parameters, '
      + 'the situations it fits, and when it is the wrong tool. Expanding returns one normal goal string, which '
      + 'superagent_start plans exactly like a goal typed by the user. A template cannot set limits, budgets, a '
      + 'mode, or an override, so using one never widens what a run may do.',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'show', 'expand', 'save', 'delete'],
        description: 'List templates, show one in full, expand one into a goal, save a custom one, or delete a custom one.',
      },
      id: { type: 'string', description: 'Template id from action="list". Built-in ids are read-only.' },
      params: {
        type: 'object',
        description: 'Values for the placeholders (expand only). Every declared parameter is required; a missing or '
          + 'empty value is refused with its name instead of being given a default.',
        additionalProperties: { type: 'string' },
      },
      template: {
        type: 'object',
        description: 'Complete definition (save only): id, title, whenToUse, whenNotToUse (list of strings), '
          + 'variables (list of {name, description}), and skeleton with {{name}} placeholders. Unknown fields are '
          + 'refused so a template cannot carry limits or overrides.',
      },
      limit: { type: 'number', description: 'Maximum templates to list (default 50).' },
    },
    required: ['action'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        const action = String(args.action ?? '').trim().toLowerCase()
        if (action === 'list') {
          const result = await templates.list()
          return formatTemplateList(result, Math.max(1, Math.min(100, Number(args.limit) || 50)))
        }
        if ((action === 'save' || action === 'delete') && memoryBlocked) {
          return describeError(
            `cannot ${action} a template: stateDir ${store.root} is inside the installed package, so writing there `
            + 'would modify the shipped files; point stateDir elsewhere',
          )
        }
        if (action === 'show' || action === 'expand') {
          const id = String(args.id ?? '').trim()
          if (!id) return describeError(`${action} needs the id of a template; call action="list" first`)
          const template = await templates.get(id)
          if (!template) {
            return describeError(`no workflow template with id "${id}"; call action="list" to see the ids`)
          }
          if (action === 'show') return formatTemplateDetail(template)
          const expanded = expandTemplate(template, args.params)
          return [
            `expanded template "${expanded.templateId}" into one goal of ${expanded.goal.length} characters. `
              + 'Start it with superagent_start goal=<the text below>; the planner sees the same goal it would '
              + 'have seen if you had typed it.',
            '',
            expanded.goal,
          ].join('\n')
        }
        if (action === 'save') {
          if (!args.template || typeof args.template !== 'object') {
            return describeError(
              'save needs template: the full definition (id, title, whenToUse, whenNotToUse, variables, skeleton)',
            )
          }
          const saved = await templates.save(args.template)
          return `saved template "${saved.id}"${saved.replaced ? ' (replaced the earlier version)' : ''} at ${saved.path}`
        }
        if (action === 'delete') {
          const id = String(args.id ?? '').trim()
          if (!id) return describeError('delete needs the id of a custom template; call action="list" first')
          const result = await templates.remove(id)
          return result.removed
            ? `deleted custom template "${result.id}"; built-in templates are unaffected`
            : describeError(`no custom template with id "${result.id}" to delete; built-in templates cannot be deleted`)
        }
        return describeError(`unknown action "${args.action}"; use list, show, expand, save, or delete`)
      } catch (error) {
        if (error instanceof TemplateError) return templateProblem(error)
        return describeError(error)
      }
    },
  }))

  // The embedding surface is opt-in: mounting the plugin must not open a port
  // unasked. When it is on, every request goes through the same orchestrator as
  // the tools, so quota, budgets, ownership, and cancel behave identically.
  if (auditor) {
    ctx.tools.register(defineTool({
      name: 'superagent_audit',
      description:
        'Query the append-only audit trail (tool calls, path writes, commands, blocks, approvals, attention '
        + 'decisions, run lifecycle) for one run or a time window, or export the matching events as a single '
        + 'JSONL or CSV file.',
      properties: {
        run_id: { type: 'string', description: 'Only events for this run id.' },
        subtask_id: { type: 'string', description: 'Only events for one subtask, e.g. "subtask-2" or "aggregator".' },
        kind: { type: 'string', description: 'Event kind, e.g. tool.call, path.write, command.exec, blocked, approved, attention.' },
        decision: { type: 'string', description: 'Only events with this decision: allow, confirm, or deny.' },
        result: { type: 'string', description: 'Only events with this result, e.g. ok, blocked, pending, approved, failed.' },
        target: { type: 'string', description: 'Substring of the path, command, or question the event is about.' },
        since: { type: 'string', description: 'ISO timestamp; events before it are skipped.' },
        until: { type: 'string', description: 'ISO timestamp; events after it are skipped.' },
        limit: { type: 'number', description: 'Maximum events to read or rows to print (default 8 for the summary, all for an export).' },
        order: { type: 'string', description: 'asc (oldest first, default) or desc.' },
        format: { type: 'string', description: 'summary (default), jsonl, or csv. jsonl and csv write a file and return its path.' },
        out_path: { type: 'string', description: 'File to write for jsonl/csv. Defaults to <stateDir>/audit/audit-export-<time>.<ext>.' },
      },
      async execute(args = {}) {
        try {
          await ready
          if (stateError) return describeError(stateError)
          const filter = {
            runId: args.run_id,
            subtaskId: args.subtask_id,
            kind: args.kind,
            decision: args.decision,
            result: args.result,
            target: args.target,
            since: args.since,
            until: args.until,
            limit: args.limit,
            order: String(args.order ?? '').toLowerCase() === 'desc' ? 'desc' : 'asc',
          }
          const format = String(args.format ?? 'summary').toLowerCase()
          if (format === 'jsonl' || format === 'csv') {
            const written = await auditor.export({ ...filter, format, outFile: args.out_path })
            return `exported ${written.count} event(s) to ${written.path} (${written.format}, ${formatBytes(written.bytes)})`
              + (written.invalid ? `; ${written.invalid} unreadable line(s) were skipped` : '')
          }
          if (format !== 'summary') return `unknown format ${JSON.stringify(args.format)}; use summary, jsonl, or csv`
          const result = await auditor.query(filter)
          const policyError = await auditor.policyError().catch(() => null)
          const head = policyError
            ? `policy: ${auditor.policyFile} is invalid, so actions are denied — `
              + `${String(policyError.message ?? policyError).split('\n')[0]}\n`
            : ''
          return `${head}${formatAudit(result, { limit: Math.min(50, Math.max(1, Number(args.limit) || 8)) })}`
        } catch (error) {
          return describeError(error)
        }
      },
    }))
  }

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
            approvePolicy: body.approve_policy === true,
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
            { force: body.force === true || body.override_quota === true, approvePolicy: body.approve_policy === true },
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

  // The workspace panel is opt-in for the same reason: mounting the plugin
  // must not open a socket. It reads and writes files itself, so the only
  // boundary that matters is the configured root, enforced in workbench.js.
  if (cfg.workbenchPort !== null) {
    const workbench = createWorkbench({
      port: cfg.workbenchPort,
      root: workbenchRoot,
      stateRoot: store.root,
      store,
      version: pkg.version,
      log,
    })
    let panelDisposed = false
    const stopWorkbench = () => {
      panelDisposed = true
      return workbench.stop().catch(error => log(`cannot stop the workbench: ${error?.message ?? error}`))
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => stopWorkbench, 'dsh-superagent workbench')
    } else if (typeof ctx.on === 'function') {
      ctx.on('dispose', stopWorkbench)
    }
    ready
      .then(() => {
        if (panelDisposed || stateError) return null
        return workbench.start()
      })
      .catch(error => {
        log(
          `workbench is not listening: ${error?.message ?? error}; `
          + `check that workbenchRoot (${workbenchRoot}) exists, that workbenchPort is free, and that the state `
          + 'directory is writable, or remove workbenchPort to keep the panel off',
        )
      })
  }

  log(
    `registered ${auditor ? 11 : 10} tools; state ${store.root}`
    + `${cfg.controlPort === null ? '' : `; control port ${cfg.controlPort}`}`
    + `${cfg.workbenchPort === null ? '' : `; workbench ${workbenchRoot} on port ${cfg.workbenchPort}`}`,
  )
}
