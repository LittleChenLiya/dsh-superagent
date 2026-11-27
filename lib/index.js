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
 * superagent_answer, superagent_memory, superagent_template, superagent_audit,
 * superagent_schedule, superagent_goal.
 *
 * @module dsh-superagent
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { Script } from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }
import { createAuditor } from './audit.js'
import { actionableAttention, createOrchestrator, followupEffect } from './orchestrator.js'
import { createChildSteerer, createChildWatcher, INJECT_POLL_MS, pendingIds } from './inject.js'
import { createControlPlane } from './control.js'
import { computeCost, formatCurrencyTally, formatMoney } from './cost.js'
import { createGuard } from './guard.js'
import { describeGoal, hasMatchingCheckReceipt } from './goal.js'
import { classifyError, describeError, summarizeError } from './errors.js'
import { createLedger } from './ledger.js'
import { createMemory, isInside, MEMORY_KINDS, normalizeScope } from './memory.js'
import { createUserMemory, USER_MEMORY_CATEGORIES } from './user-memory.js'
import { createNotifyPolicy, createOutbox } from './notify.js'
import { createRuntimeControl } from './runtime-control.js'
import { createRouter, readRouterDecision, ROUTER_PROMPT } from './router.js'
import { createSourceIngress } from './sources/ingress.js'
import { createSourceStore } from './sources/store.js'
import { answeredDecisions } from './work-context.js'
import {
  createScheduler,
  formatSchedule,
  formatScheduleList,
  normalizeScheduleInput,
  rruleForInterval,
  rruleFromCron,
  rruleWithStart,
} from './schedule.js'
import { createLongGoalManager, formatStatus as formatLongGoal, pendingDecision } from './long-goal.js'
import { ACTIVE_STATUSES, createStore, resolveStateRoot, TERMINAL_STATUSES } from './store.js'
import { createTemplateStore, expandTemplate, formatTemplateDetail, formatTemplateList, TemplateError } from './templates.js'
import { createUsageReader } from './usage.js'
import { describeWorkspace } from './workspace.js'
import { createRunChangeTracker, createWorkbench } from './workbench.js'
import { createConsole } from './console.js'
import { createWizard } from './wizard.js'
import { createBoard } from './board.js'
import { createObservability } from './observability.js'
import { createMCPMemoryBridge, DEFAULT_MCP_MEMORY_CONFIG } from './mcp-memory.js'
import { createHostScheduleAdapter } from './host-schedule.js'
import { collectArtifacts, listArtifacts, parseArtifactId } from './artifacts.js'
import { createNotifyPreferences } from './notify-preferences.js'
import { aggregateNotificationCenter, isQuietHours } from './notification-center.js'
import { createBriefScheduler } from './brief-scheduler.js'
import { createCapabilityCenterAdapter } from './capability-center.js'
import { createMemoryCenter } from './memory-center.js'
import { createRuntimeViewController } from './runtime-view.js'
import { createRuntimeStream } from './runtime-stream.js'
import { buildEvidenceCenter } from './evidence-center.js'
import { createCostCenter } from './cost-center.js'
import { createRoutePolicy } from './route-policy.js'
import { createRepoWiki } from './repo-wiki.js'
import { createAgentProfileStore } from './agent-profiles.js'
import { createPlanPreview, approvePlan, createCandidatePlanPreview } from './plan-preview.js'
import { createVoiceService } from './voice.js'
import { createDevicePairingStore } from './device-pairing.js'
import { createAutomationRuleStore, normalizeAutomationRule, previewAutomationRule,
  buildAutomationExecutionInput, completeAutomationExecution, shouldNotifyAutomation } from './automation-rules.js'
import { createRemoteWorkerProvider, createWorkSpec, redactSensitiveText, redactSensitiveValue } from './cloud-worker.js'
import { finalizeCloudArtifacts } from './cloud-artifacts.js'
import { createRemoteJobStore } from './remote-jobs.js'
import { createShareStore } from './share.js'
import { createMarketClient } from './market-client.js'
import { createSkillImporter } from './skill-import.js'
import { createImportedSkillProvider } from './imported-skills.js'
import { createFeishuClient } from './sources/feishu-client.js'
import { createFeishuOutbox, feishuIdempotencyKey, validateFeishuSummary } from './sources/feishu-outbox.js'

export const name = 'dsh-superagent'
// The host menu and sessions are required. `subagents` is read through
// `ctx.get('subagents')`, so a profile without it still mounts the fifteen tools;
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
   * Agent preset used for the planner child only. The bundle inserts the
   * tool-less `planner` preset automatically. Hosts without an `agentPresets`
   * registry keep the planner on the inherited route and report the fallback.
   */
  plannerPreset: 'planner',
  /**
   * Optional model route for the planner child only. Planning is one JSON turn,
   * so a stronger model there is cheap relative to the workers it coordinates;
   * leaving these null keeps the session's route.
   */
  plannerModel: null,
  plannerProvider: null,
  /**
   * Delegation depth granted to child agents. 1 means a worker may not create
   * children of its own; `provider-managed` leaves the cap to the backend.
   */
  maxSubagentDepth: 1,
  /**
   * Sandbox mode granted to a worker whose plan entry declares a shell
   * capability. `inherit` keeps the host's delegation inheritance for every
   * child, which is the pre-existing behaviour.
   */
  commandWorkerPermission: 'inherit',
  /** Upper bound on planned subtasks per run. */
  maxSubtasks: 8,
  /**
   * How long one planner attempt may run before its child is stopped and the
   * next attempt (or the invalid-plan path) takes over. A planner that starts
   * calling tools can otherwise spend the whole run budget before returning.
   */
  plannerTimeoutSeconds: 120,
  /**
   * Model calls the planning phase may spend in total, across attempts. 0
   * disables the cap. A planner that calls tools instead of replying can loop
   * for dozens of calls; once the budget is gone the run is reported as
   * unplannable instead of draining the run budget.
   */
  plannerMaxModelCalls: 20,
  /** Upper bound on subtasks executing at once. */
  maxParallel: 4,
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
  maxTokensPerRun: 0,
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
   * How often a scheduled plan is checked, in seconds. Plans are the only
   * thing that arms the timer, so an install with no plan pays nothing.
   */
  schedulerTickSeconds: 30,
  /**
   * Keep one concurrency slot free for manual starts when a scheduled plan is
   * due. The reservation happens inside the start gate, so a person's start
   * cannot lose a race with the timer.
   */
  schedulerHumanPriority: true,
  /** Consecutive failed runs before a plan pauses and says so once. */
  schedulerMaxConsecutiveFailures: 3,
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
  /** Local repository ontology and knowledge cards. */
  repoWiki: {
    enabled: true,
    autoContext: true,
    maxFiles: 4000,
    maxBytes: 8 * 1024 * 1024,
    maxDepth: 8,
    contextChars: 5000,
  },
  /**
   * User-level profile: facts, preferences and decisions kept across unrelated
   * tasks under `<stateDir>/user-memory`. Off by default because it is a
   * durable record about a person, not just about a task.
   */
  memoryUserProfile: false,
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
   * `auto` uses git worktrees only when the workspace is a Git repository and
   * multiple workers may write concurrently. Otherwise workers run serially in
   * the shared workspace and the decision is logged. `true` and `false` remain
   * explicit operator choices.
   */
  workspaceIsolation: 'auto',
  /** Repository whose worktrees isolate the workers; defaults to the host's cwd. */
  workspaceRoot: null,
  /**
   * Which directory isolation is based on. `session` (default) uses the calling
   * session's cwd — or the repository root git resolves from it — because that
   * is the directory the sandbox boundary and the merge target already agree
   * on. `config` keeps the older behaviour and always uses `workspaceRoot`,
   * which is only correct when it names the same repository as the session.
   */
  workspaceBase: 'session',
  /** `local` keeps the built-in Git manager; `host` opts into the host retained-worktree service. */
  workspaceProvider: 'local',
  /** Independent reviewer child for completed worker output. Off because it adds model calls. */
  reviewerEnabled: false,
  reviewerModel: null,
  reviewerPreset: null,
  /** Optional metadata-only OTel/session-query/token-meter integration. */
  observability: {
    enabled: false,
    serviceName: 'dsh-superagent',
    endpoint: '',
    exportSessionLogs: false,
  },
  /** Optional MCP memory server registered through the host manager; never auto-installed. */
  mcpMemory: { ...DEFAULT_MCP_MEMORY_CONFIG, args: [...DEFAULT_MCP_MEMORY_CONFIG.args] },
  /** `auto` prefers the Host Scheduler when its service is available; `local` keeps the plugin timer. */
  scheduleProvider: 'auto',
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
  /**
   * Loopback HTTP port for the conversation console. `0` (default) asks the OS
   * for a free port so the host sidebar can always open the page; explicit
   * `null` keeps it off. The bound address and its one-time token are written
   * to `<stateDir>/console.json`.
   */
  consolePort: 0,
  /**
   * GitHub / Feishu source ingress. Off by default and only started when
   * `enabled` is true. Credentials are environment references
   * (`secretEnv`, `encryptKeyEnv`, `verificationTokenEnv`), never literals in
   * this file. See "Sources" in the README.
   */
  sources: null,
  /** Optional remote Worker provider used when provider is `remote`. */
  remoteWorker: null,
  /** Read-only Market client configuration; installation always stays host-owned. */
  market: null,
  /** Destination for reviewed local Skill imports. */
  skillImport: { skillsDir: null },
  /**
   * Loopback HTTP port for the task board — one page showing every run as
   * subtask cards, everything waiting for a person, and the built-in templates.
   * `null` (default) keeps it off; `0` asks the OS for a free port. The bound
   * address and its one-time token are written to `<stateDir>/board.json`.
   */
  boardPort: null,
  /**
   * Directory the board conversation joins, and where a template-started run
   * works. Defaults to `consoleRoot`, then `workbenchRoot`, then the host cwd.
   */
  boardRoot: null,
  /**
   * Directory the console conversation joins. Defaults to `workbenchRoot`, then
   * the host process's working directory.
   */
  consoleRoot: null,
  /**
   * Agent preset the console conversation mounts. Null keeps the profile
   * default, which is what the Web app's own sessions use. Tools come from the
   * preset, not from this plugin: pass a preset id (for example one that
   * includes runtime-control) to change the console's tool set.
   */
  consolePreset: null,
  /**
   * Browser and desktop control. Off by default: with `enabled: false` not one
   * of these tools is registered, so an existing profile behaves exactly as
   * before. See "Runtime control" in the README for the gates that apply once
   * it is on.
   */
  runtime: {
    enabled: false,
    /**
     * Chromium driven over CDP. A fresh temporary profile is the default, so the
     * user's daily logins stay out of reach; `attachPort` borrows a browser the
     * user started, and `userDataDir` keeps one dedicated profile across runs.
     */
    browser: {
      enabled: true,
      headless: true,
      executablePath: null,
      attachPort: null,
      userDataDir: null,
      allowedHosts: [],
    },
    /** Windows input and capture. Background delivery is the default. */
    desktop: { enabled: false, allowActivation: false },
    /** Emergency stop file; a present file refuses every runtime action. */
    stopFile: null,
    /** Where screenshots are written; defaults to `<stateDir>/runtime/shots`. */
    shotDir: null,
  },
}

const REPORT_PREVIEW_CHARS = 8000

/**
 * Read the arguments of the tool call an approval is blocking, so the page can
 * name the exact path instead of paraphrasing the asker. Sessions keep the
 * append-only event log; the call preceding the ask is the last matching
 * `tool/call` record. Anything unreadable stays null — the card then falls back
 * to the host's own reason, never to a guess.
 *
 * @param {object|undefined} session - the asking agent's session.
 * @param {string|undefined} callId - the blocked tool call.
 * @returns {string|null} the raw JSON arguments, or null when unavailable.
 */
function blockedCallArguments(session, callId) {
  if (!session || typeof callId !== 'string' || !callId) return null
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null
    if (!Array.isArray(events)) return null
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'tool/call' || event.data?.callId !== callId) continue
      const raw = event.data?.arguments
      return typeof raw === 'string' ? raw : null
    }
  } catch {
    return null
  }
  return null
}

/**
 * Explain an approval without echoing argument values (which may contain
 * credentials). The recommendation is advisory only; the host remains the
 * authority that allows or denies the call.
 */
export function approvalRisk(toolName, callArguments) {
  const name = String(toolName ?? 'tool').toLowerCase()
  let args = callArguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = { command: args } }
  }
  const value = args && typeof args === 'object' ? args : {}
  const command = String(value.command ?? value.cmd ?? '').toLowerCase()
  const target = String(value.path ?? value.file ?? value.filePath ?? value.cwd ?? '')
  const destructive = /(?:\brm\s+-[a-z]*r|\bgit\s+push\b[^\n]*(?:--force|-f)|\bmkfs\b|\bdd\s+|:\s*>\s*\/dev\/sd|\bdel\s+\/[sfq])/i.test(command)
  const network = /\b(curl|wget|invoke-webrequest|irm|git\s+push|npm\s+publish)\b/i.test(command)
    || /\b(fetch|web_search|browser_open)\b/.test(name)
  const write = /\b(write|edit|apply_patch|bash|pwsh|shell|terminal|move|delete|remove)\b/.test(name)
    || /\b(sudo|chmod|chown|rm|mv|cp|git\s+commit|git\s+reset)\b/.test(command)
  const readOnly = /\b(read|glob|grep|list|search|view|status)\b/.test(name) && !write && !network
  const recommendation = destructive ? 'deny' : readOnly ? 'allow' : 'confirm'
  const scope = destructive ? '可能造成不可恢复的系统或仓库破坏'
    : network ? '可能改变外部系统或发送数据'
      : write ? `可能修改${target ? ` ${target}` : '工作区文件'}`
        : '影响范围未明确'
  const reversibility = destructive ? '不可逆或难以回滚' : network ? '外部副作用通常不可逆' : write ? '可能可逆，需保留备份' : '只读操作可逆'
  return {
    riskSummary: `影响范围：${scope}；可逆性：${reversibility}。`,
    recommendation,
  }
}

/** Parse the common scheduling phrases without guessing an unavailable time. */
export function parseAutomationText(text) {
  const source = String(text ?? '').trim()
  if (!source) return null
  let trigger = null
  let timing = ''
  let match = /(?:每|every)\s*(\d+)\s*(分钟|minute(?:s)?|小时|hour(?:s)?|天|day(?:s)?)/i.exec(source)
  if (match) {
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()
    const ms = (unit.startsWith('小时') || unit.startsWith('hour') ? 3600 : unit.startsWith('天') || unit.startsWith('day') ? 86400 : 60) * 1000
    trigger = { type: 'every', everyMs: amount * ms }
    timing = match[0]
  } else {
    match = /(?:每天|每日|daily)(?:\s*(?:在|at)?\s*(\d{1,2})[:：点时](\d{2})?)?/i.exec(source)
    if (match) {
      const hour = Number(match[1] ?? 9)
      const minute = Number(match[2] ?? 0)
      if (hour > 23 || minute > 59) return null
      trigger = { type: 'cron', cron: `${minute} ${hour} * * *`, timeZone: 'UTC' }
      timing = match[0]
    } else {
      match = /(?:每周|every)\s*(?:周|week\s*)?(mon|tue|wed|thu|fri|sat|sun|一|二|三|四|五|六|日)(?:\s*(?:在|at)?\s*(\d{1,2})[:：点时](\d{2})?)?/i.exec(source)
      if (match) {
        const days = { mon: 1, 一: 1, tue: 2, 二: 2, wed: 3, 三: 3, thu: 4, 四: 4, fri: 5, 五: 5, sat: 6, 六: 6, sun: 0, 日: 0 }
        const day = days[match[1].toLowerCase()]
        const hour = Number(match[2] ?? 9)
        const minute = Number(match[3] ?? 0)
        if (day === undefined || hour > 23 || minute > 59) return null
        trigger = { type: 'cron', cron: `${minute} ${hour} * * ${day}`, timeZone: 'UTC' }
        timing = match[0]
      }
    }
  }
  if (!trigger) return null
  const prompt = source.replace(timing, ' ').replace(/^(?:请|帮我|then|and)\s*/i, '').replace(/\s+/g, ' ').trim() || source
  return {
    name: prompt.slice(0, 80),
    description: `从自然语言创建：${source.slice(0, 200)}`,
    trigger,
    action: { type: 'run', prompt },
    output: { relativePath: 'artifacts/automation.md' },
    notify: { events: ['completed', 'failed'] },
    budget: { maxRuns: 100, maxModelCalls: 20, maxTokens: 100_000, maxCost: null },
    enabled: true,
  }
}

/** Deterministic fallback planning; callers never have to supply subtasks. */
export function deterministicSubtasks(goal, constraints = {}) {
  const max = Math.max(1, Math.min(8, Number(constraints.maxSubtasks) || 5))
  const parts = String(goal ?? '').split(/\n+|(?:；|;)\s*|(?:然后|接着|下一步)|(?:^|\s)\d+[.)、]\s*/u)
    .map(item => item.trim()).filter(Boolean).slice(0, max)
  const items = parts.length ? parts : [String(goal).trim()]
  return items.map((objective, index) => ({
    title: objective.slice(0, 100),
    objective,
    acceptance: [{ text: 'The report delivers a concrete result backed by evidence for this item.' }],
    ...(index ? { dependsOn: [] } : {}),
  }))
}

/** Local, evidence-based status explanation; never invents a next action. */
export function statusGuidance(run) {
  const blockers = []
  const nextSteps = []
  const pending = (run.attention?.items ?? []).filter(item => !item.answer)
  for (const item of pending.slice(0, 4)) {
    blockers.push(`${item.id}: ${item.question ?? item.reason ?? '等待决策'}`)
  }
  const failed = (run.subtasks ?? []).find(item => item.status === 'failed' && item.error)
  if (failed) blockers.push(`子任务 ${failed.index}: ${failed.error}`)
  if (run.workspace?.mode === 'unavailable') blockers.push(`工作区隔离不可用：${run.workspace.reason}`)
  if (run.workspace?.conflicts > 0) blockers.push(`${run.workspace.conflicts} 个 worker 分支合并冲突`)
  if (run.error) blockers.push(run.error)
  if (pending.length) nextSteps.push('回答待决策问题后继续；不要重复创建任务。')
  else if (run.status === 'queued') nextSteps.push('等待并发名额；任务会按队列自动开始。')
  else if (['planning', 'running', 'aggregating'].includes(run.status)) nextSteps.push('等待当前阶段完成；可用 superagent_status 查看进展。')
  else if (['failed', 'interrupted', 'partial'].includes(run.status)) nextSteps.push('检查阻塞原因，修复后调用 superagent_resume。')
  else if (run.status === 'paused') nextSteps.push('调用 superagent_resume 继续。')
  else if (run.status === 'completed') nextSteps.push('查看最终报告；如需补充要求，使用 superagent_followup。')
  else if (run.status === 'cancelled') nextSteps.push('任务已取消；如需继续，请创建新任务。')
  return { blockers: [...new Set(blockers)], nextSteps: [...new Set(nextSteps)] }
}

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

function envSecret(block, field, fallback) {
  const name = typeof block?.[field] === 'string' ? block[field].trim() : ''
  if (name) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
    return null
  }
  return fallback ?? null
}

/**
 * Sources stay off unless the profile explicitly enables them. A missing
 * environment variable leaves the credential null, which makes the hook
 * answer 503 instead of silently accepting unsigned traffic.
 */
function resolveSources(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null
  const githubRaw = raw.github && raw.github.enabled === true ? raw.github : null
  const feishuRaw = raw.feishu && raw.feishu.enabled === true ? raw.feishu : null
  const github = githubRaw ? {
    enabled: true,
    instanceId: typeof githubRaw.instanceId === 'string' && githubRaw.instanceId.trim()
      ? githubRaw.instanceId.trim().slice(0, 64) : 'default',
    secret: envSecret(githubRaw, 'secretEnv'),
  } : null
  const outboundRaw = feishuRaw?.outbound && typeof feishuRaw.outbound === 'object' ? feishuRaw.outbound : null
  const outbound = outboundRaw ? {
    appId: envSecret(outboundRaw, 'appIdEnv'),
    appSecret: envSecret(outboundRaw, 'appSecretEnv'),
    fetchImpl: typeof outboundRaw.fetchImpl === 'function' ? outboundRaw.fetchImpl : undefined,
  } : null
  const feishu = feishuRaw ? {
    enabled: true,
    instanceId: typeof feishuRaw.instanceId === 'string' && feishuRaw.instanceId.trim()
      ? feishuRaw.instanceId.trim().slice(0, 64) : 'default',
    encryptKey: envSecret(feishuRaw, 'encryptKeyEnv'),
    verificationToken: envSecret(feishuRaw, 'verificationTokenEnv'),
    outbound,
  } : null
  if (!github && !feishu) return null
  return { github, feishu }
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
  merged.plannerTimeoutSeconds = bounded(merged.plannerTimeoutSeconds, DEFAULTS.plannerTimeoutSeconds, 0, 3600)
  merged.plannerMaxModelCalls = bounded(merged.plannerMaxModelCalls, DEFAULTS.plannerMaxModelCalls, 0, 1000)
  merged.plannerPreset = merged.plannerPreset === null ? null
    : typeof merged.plannerPreset === 'string' && merged.plannerPreset.trim()
      ? merged.plannerPreset.trim()
      : DEFAULTS.plannerPreset
  merged.plannerModel = typeof merged.plannerModel === 'string' && merged.plannerModel.trim()
    ? merged.plannerModel.trim()
    : null
  merged.plannerProvider = typeof merged.plannerProvider === 'string' && merged.plannerProvider.trim()
    ? merged.plannerProvider.trim()
    : null
  merged.maxTokensPerRun = bounded(merged.maxTokensPerRun, DEFAULTS.maxTokensPerRun, 0, 1e12)
  merged.resultCapBytes = bounded(merged.resultCapBytes, DEFAULTS.resultCapBytes, 1024, 1024 * 1024)
  merged.keepRuns = bounded(merged.keepRuns, DEFAULTS.keepRuns, 0, 3650)
  merged.controlPort = controlPortOf(merged.controlPort)
  merged.workbenchPort = controlPortOf(merged.workbenchPort)
  merged.workbenchRoot = typeof merged.workbenchRoot === 'string' && merged.workbenchRoot.trim()
    ? merged.workbenchRoot.trim()
    : null
  merged.consolePort = controlPortOf(merged.consolePort)
  merged.sources = resolveSources(merged.sources)
  merged.remoteWorker = merged.remoteWorker && typeof merged.remoteWorker === 'object'
    ? {
      endpoint: typeof merged.remoteWorker.endpoint === 'string' ? merged.remoteWorker.endpoint.trim() : '',
      tokenEnv: typeof merged.remoteWorker.tokenEnv === 'string' ? merged.remoteWorker.tokenEnv.trim() : '',
      model: typeof merged.remoteWorker.model === 'string' ? merged.remoteWorker.model.trim() : '',
      provider: typeof merged.remoteWorker.provider === 'string' ? merged.remoteWorker.provider.trim() : '',
      fetchImpl: typeof merged.remoteWorker.fetchImpl === 'function' ? merged.remoteWorker.fetchImpl : undefined,
      pollIntervalMs: merged.remoteWorker.pollIntervalMs,
      timeoutMs: merged.remoteWorker.timeoutMs,
    }
    : null
  merged.market = merged.market && typeof merged.market === 'object'
    ? { ...merged.market, fetchImpl: typeof merged.market.fetchImpl === 'function' ? merged.market.fetchImpl : undefined }
    : null
  merged.skillImport = {
    skillsDir: typeof merged.skillImport?.skillsDir === 'string' && merged.skillImport.skillsDir.trim()
      ? merged.skillImport.skillsDir.trim() : null,
  }
  merged.consoleRoot = typeof merged.consoleRoot === 'string' && merged.consoleRoot.trim()
    ? merged.consoleRoot.trim()
    : null
  merged.boardPort = controlPortOf(merged.boardPort)
  merged.boardRoot = typeof merged.boardRoot === 'string' && merged.boardRoot.trim()
    ? merged.boardRoot.trim()
    : null
  merged.consolePreset = typeof merged.consolePreset === 'string' && merged.consolePreset.trim()
    ? merged.consolePreset.trim()
    : null
  merged.maxSubagentDepth = merged.maxSubagentDepth === 'provider-managed'
    ? 'provider-managed'
    : bounded(merged.maxSubagentDepth, DEFAULTS.maxSubagentDepth, 0, 4)
  // Only the two documented values are meaningful; anything else keeps
  // inheritance, because a typo must not silently hand out full access.
  merged.commandWorkerPermission = merged.commandWorkerPermission === 'danger-full-access'
    ? 'danger-full-access'
    : 'inherit'
  // Per-model prices merge, so a user can add one route without restating the
  // built-in table.
  merged.pricing = { ...DEFAULTS.pricing, ...(config?.pricing ?? {}) }
  merged.memory = flag(merged.memory, DEFAULTS.memory)
  merged.memoryUserProfile = flag(merged.memoryUserProfile, DEFAULTS.memoryUserProfile)
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
  merged.repoWiki = {
    enabled: flag(merged.repoWiki?.enabled, DEFAULTS.repoWiki.enabled),
    autoContext: flag(merged.repoWiki?.autoContext, DEFAULTS.repoWiki.autoContext),
    maxFiles: bounded(merged.repoWiki?.maxFiles, DEFAULTS.repoWiki.maxFiles, 100, 20_000),
    maxBytes: bounded(merged.repoWiki?.maxBytes, DEFAULTS.repoWiki.maxBytes, 1024 * 1024, 64 * 1024 * 1024),
    maxDepth: bounded(merged.repoWiki?.maxDepth, DEFAULTS.repoWiki.maxDepth, 1, 16),
    contextChars: bounded(merged.repoWiki?.contextChars, DEFAULTS.repoWiki.contextChars, 500, 20_000),
  }
  merged.autoResumeRounds = bounded(merged.autoResumeRounds, DEFAULTS.autoResumeRounds, 0, 3)
  merged.notifyRetries = bounded(merged.notifyRetries, DEFAULTS.notifyRetries, 0, 5)
  merged.notifyRetryDelayMs = bounded(merged.notifyRetryDelayMs, DEFAULTS.notifyRetryDelayMs, 0, 60000)
  // A one-second floor keeps the timer responsive in a demo without allowing a
  // busy loop; an hour ceiling means a typo cannot stop plans from running.
  merged.schedulerTickSeconds = bounded(merged.schedulerTickSeconds, DEFAULTS.schedulerTickSeconds, 1, 3600)
  merged.schedulerHumanPriority = flag(merged.schedulerHumanPriority, DEFAULTS.schedulerHumanPriority)
  merged.schedulerMaxConsecutiveFailures = bounded(
    merged.schedulerMaxConsecutiveFailures,
    DEFAULTS.schedulerMaxConsecutiveFailures,
    1,
    20,
  )
  merged.injectPollMs = bounded(merged.injectPollMs, DEFAULTS.injectPollMs, 10, 1000)
  merged.maxNotificationsPerHour = bounded(merged.maxNotificationsPerHour, DEFAULTS.maxNotificationsPerHour, 0, 1000)
  merged.childModelFallback = typeof merged.childModelFallback === 'string' && merged.childModelFallback.trim()
    ? merged.childModelFallback.trim()
    : null
  // `auto` is resolved by the orchestrator against each run's selected project.
  // A global probe of the host cwd can enable parallel writers for a session
  // whose plain (non-git) directory cannot provide worktrees.
  merged.workspaceIsolation = merged.workspaceIsolation === 'auto'
    ? 'auto'
    : flag(merged.workspaceIsolation, false)
  // A blank path would resolve to the cwd, which is how isolation would silently
  // point at the wrong repository; blank therefore means "use the default".
  merged.workspaceRoot = typeof merged.workspaceRoot === 'string' && merged.workspaceRoot.trim()
    ? merged.workspaceRoot.trim()
    : null
  // Anything but an explicit `config` keeps the session-following default, so a
  // typo cannot silently point isolation back at a stale profile directory.
  merged.workspaceBase = merged.workspaceBase === 'config' ? 'config' : 'session'
  merged.workspaceProvider = merged.workspaceProvider === 'host' ? 'host' : 'local'
  if (merged.workspaceProvider === 'host' && merged.maxParallel > 1) merged.maxParallel = 1
  merged.scheduleProvider = merged.scheduleProvider === 'local' ? 'local' : 'auto'
  merged.reviewerEnabled = flag(merged.reviewerEnabled, DEFAULTS.reviewerEnabled)
  merged.reviewerModel = typeof merged.reviewerModel === 'string' && merged.reviewerModel.trim()
    ? merged.reviewerModel.trim()
    : null
  merged.reviewerPreset = typeof merged.reviewerPreset === 'string' && merged.reviewerPreset.trim()
    ? merged.reviewerPreset.trim()
    : null
  merged.observability = {
    enabled: flag(merged.observability?.enabled, DEFAULTS.observability.enabled),
    serviceName: typeof merged.observability?.serviceName === 'string' && merged.observability.serviceName.trim()
      ? merged.observability.serviceName.trim()
      : DEFAULTS.observability.serviceName,
    endpoint: typeof merged.observability?.endpoint === 'string' ? merged.observability.endpoint.trim() : '',
    exportSessionLogs: flag(merged.observability?.exportSessionLogs, DEFAULTS.observability.exportSessionLogs),
  }
  merged.mcpMemory = {
    ...DEFAULTS.mcpMemory,
    ...(config?.mcpMemory && typeof config.mcpMemory === 'object' ? config.mcpMemory : {}),
    args: Array.isArray(config?.mcpMemory?.args) ? [...config.mcpMemory.args] : [...DEFAULTS.mcpMemory.args],
  }
  // The guard block merges so a user can set only `allowCommands` without
  // restating the rest of the defaults.
  merged.guard = {
    ...DEFAULTS.guard,
    ...(config?.guard && typeof config.guard === 'object' ? config.guard : {}),
  }
  // Runtime control merges one level deeper: a profile that only sets
  // `browser.allowedHosts` keeps the desktop defaults and vice versa.
  merged.runtime = {
    ...DEFAULTS.runtime,
    ...(config?.runtime && typeof config.runtime === 'object' ? config.runtime : {}),
    browser: {
      ...DEFAULTS.runtime.browser,
      ...(config?.runtime?.browser && typeof config.runtime.browser === 'object' ? config.runtime.browser : {}),
    },
    desktop: {
      ...DEFAULTS.runtime.desktop,
      ...(config?.runtime?.desktop && typeof config.runtime.desktop === 'object' ? config.runtime.desktop : {}),
    },
  }
  merged.runtime.enabled = flag(merged.runtime.enabled, DEFAULTS.runtime.enabled)
  merged.runtime.browser.enabled = flag(merged.runtime.browser.enabled, DEFAULTS.runtime.browser.enabled)
  merged.runtime.browser.headless = flag(merged.runtime.browser.headless, DEFAULTS.runtime.browser.headless)
  merged.runtime.desktop.enabled = flag(merged.runtime.desktop.enabled, DEFAULTS.runtime.desktop.enabled)
  merged.runtime.desktop.allowActivation = flag(merged.runtime.desktop.allowActivation, DEFAULTS.runtime.desktop.allowActivation)
  merged.runtime.browser.allowedHosts = (Array.isArray(merged.runtime.browser.allowedHosts) ? merged.runtime.browser.allowedHosts : [])
    .map(entry => String(entry ?? '').trim())
    .filter(Boolean)
  merged.runtime.browser.attachPort = controlPortOf(merged.runtime.browser.attachPort)
  merged.runtime.browser.userDataDir = typeof merged.runtime.browser.userDataDir === 'string'
    && merged.runtime.browser.userDataDir.trim()
    ? merged.runtime.browser.userDataDir.trim()
    : null
  for (const key of ['stopFile', 'shotDir']) {
    merged.runtime[key] = typeof merged.runtime[key] === 'string' && merged.runtime[key].trim()
      ? merged.runtime[key].trim()
      : null
  }
  return merged
}

/**
 * One user-level record as a tool row. A decision always shows its rationale:
 * a bare "chose X" is exactly what the profile exists to avoid.
 */
function userRecordLine(entry) {
  const when = String(entry.source?.ts ?? entry.ts ?? '').slice(0, 10)
  const run = entry.source?.runId ?? entry.runId ?? 'manual'
  const score = Number.isFinite(entry.score) ? ` score ${entry.score.toFixed(2)}` : ''
  const body = entry.category === 'decision'
    ? `chose ${entry.choice}; rejected ${entry.rejected || 'nothing recorded'}; `
      + `why ${entry.reason}; rollback ${entry.rollback || 'not recorded'}`
    : entry.text
  return `- ${entry.key} [${entry.category}]${score} (run ${run}, ${when}): ${body}`
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

function elapsed(run) {  const start = Date.parse(run.startedAt)
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

/** Tool arguments are snake_case; a goal spec is camelCase. */
function acceptanceFromToolArgs(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
  if (!entry.check || typeof entry.check !== 'object') return entry
  const { must_exist: mustExist, timeout_seconds: timeoutSeconds, ...check } = entry.check
  return {
    ...entry,
    check: {
      ...check,
      ...(mustExist === undefined ? {} : { mustExist }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    },
  }
}

/**
 * Build the goal spec from the flat tool arguments.
 *
 * `budget` is read only for `superagent_start`; on a schedule, `budget` is the
 * plan's own spending ceiling and is not a goal-mode field.
 */
function goalModeFromToolArgs(args, { budget = true } = {}) {  if (args.goal_mode !== true) {
    if (args.acceptance !== undefined) {
      throw new Error('acceptance is only read in goal mode; pass goal_mode: true to enable it (goal mode is off by default)')
    }
    return null
  }
  const budgetArg = budget ? args.budget : null
  return {
    acceptance: Array.isArray(args.acceptance) ? args.acceptance.map(acceptanceFromToolArgs) : args.acceptance,
    maxRounds: args.max_rounds,
    maxWallClockMinutes: args.max_wall_clock_minutes,
    noProgressRounds: args.no_progress_rounds,
    budget: budgetArg && typeof budgetArg === 'object'
      ? { maxModelCalls: budgetArg.max_model_calls, maxTokens: budgetArg.max_tokens }
      : null,
  }
}

/** The Host Schedule tool a root Agent can call itself, when the host exposes it. */
const HOST_SCHEDULE_TOOL = 'schedule_create'

/**
 * Resolve whether this caller may create a Host scheduled task.
 *
 * The host tool refuses delegated subagents, so they stay on the local timer
 * instead of asking for a handoff that would fail. A missing tools service or
 * a preset without `dsh-tool-schedule` reads as unavailable, never as "try it".
 *
 * @param {object} agent - calling Agent.
 * @returns {string | null} tool name, or null when the plugin must keep the timer.
 */
function hostScheduleToolFor(agent) {
  const header = agent?.session?.header
  if ((header?.delegationDepth ?? 0) > 0) return null
  try {
    const tools = agent?.ctx?.tools
    if (typeof tools?.get !== 'function') return null
    return tools.get(HOST_SCHEDULE_TOOL, agent.ctx) ? HOST_SCHEDULE_TOOL : null
  } catch {
    return null
  }
}

function schedulePayloadFor(plan, sessionId) {
  if (plan.ownerSessionId !== sessionId) return { reason: 'the plan belongs to a different session' }
  const rule = plan.schedule.cron ? rruleFromCron(plan.schedule.cron) : rruleForInterval(plan.schedule.everyMinutes)
  if (!rule) return { reason: 'the recurrence has no lossless RRULE equivalent' }
  if (Object.values(plan.budget ?? {}).some(value => value != null)) {
    return { reason: 'the Host Scheduler cannot enforce the plugin plan budget' }
  }
  if (plan.schedule.missPolicy === 'none' || plan.concurrency?.humanPriority === false) {
    return { reason: 'the Host Scheduler cannot preserve the selected missed-run or priority policy' }
  }
  const mode = plan.goalMode
  if (mode?.budget && Object.values(mode.budget).some(value => value != null)) {
    return { reason: 'the Host Scheduler cannot enforce the plugin plan budget' }
  }
  const args = {
    goal: plan.goal,
    mode: plan.mode,
    allow_duplicate: true,
    ...(mode && {
      goal_mode: true,
      acceptance: mode.acceptance,
      max_rounds: mode.maxRounds,
      max_wall_clock_minutes: mode.maxWallClockMinutes,
      no_progress_rounds: mode.noProgressRounds,
    }),
  }
  return {
    payload: {
      title: plan.name,
      prompt: `[scheduled task ${plan.name}] If superagent_start is not visible, call superagent_help first. `
        + 'Start the scheduled run now by calling superagent_start with these arguments:\n'
        + `${JSON.stringify(args, null, 2)}\n`
        + 'This message is the recurring trigger; do not create or edit the schedule.',
      rrule: rruleWithStart(rule, plan.schedule.timeZone),
      target: 'this_session',
    },
  }
}

/**
 * Tell the model to create the plan through the host instead of returning a
 * plugin timer. The tool result carries the exact arguments so the follow-up
 * call needs no translation.
 */
function scheduleHandoffText({ payload, toolName }) {
  return `handoff: this host exposes ${toolName}, so this plan belongs to the Host Scheduler, not to the plugin.\n\n`
    + 'Call it now with exactly these arguments:\n'
    + `${JSON.stringify(payload, null, 2)}\n\n`
    + 'Do not tell the user the schedule exists until that call succeeds. It will then appear in the host\'s '
    + 'scheduled tasks and deliver the prompt above to this session at each occurrence.\n'
    + 'No timer is armed in this plugin for a host-backed plan. If the call fails, report its error verbatim; '
    + 'do not fall back to a local timer silently.'
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
  lines.push(...describeGoal(run.goalMode))
  if (run.memory?.digest) {
    const profile = run.memory.userNotes > 0 ? `, ${run.memory.userNotes} user-level record(s)` : ''
    lines.push(
      `memory: ${run.memory.notes} note(s)${profile} and ${run.memory.runs} earlier run(s) carried into this run `
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
  const items = (run.attention?.items ?? []).filter(item => item.answer || actionableAttention(run, item))
  if (items.length > 0) {
    const idOf = item => item.id ?? `q${items.indexOf(item) + 1}`
    const open = items.filter(item => actionableAttention(run, item))
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
  if (run.preflight?.status === 'checked' && run.preflight.blocked > 0) {
    lines.push(
      `capability preflight: ${run.preflight.blocked} subtask(s) blocked before start `
      + `(${run.preflight.toolCount} tool(s) available)`,
    )
  } else if (run.preflight?.status === 'unavailable') {
    lines.push(`capability preflight: skipped — ${run.preflight.reason}`)
  }
  if (run.resumedAt) lines.push(`resumed at: ${run.resumedAt}`)
  if (run.reclaimed) lines.push(`reclaimed: ${run.reclaimed.basis}`)
  if (run.budgetStop?.detail) {
    // A budget stop explains why no further worker started; it is not a
    // failure, so it never sits in the error line of a finished run.
    lines.push(`note: stopped starting new workers — ${run.budgetStop.detail}; finished work was kept`)
  }
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
    // Blocked is not skipped: nothing upstream failed, the session lacks a tool
    // this subtask declared it needs, so no worker was ever started.
    const blocked = subtask.status === 'blocked' && subtask.blockedReason
      ? ` — blocked: ${subtask.blockedReason}`
      : ''
    // Unverified is not completed: the worker declared an artifact this
    // session could not check, so the reason must be visible.
    const unverified = subtask.status === 'unverified' && subtask.unverifiedReason
      ? ` — unverified: ${subtask.unverifiedReason}`
      : ''
    const detail = blocked || skipped || unverified
      || (subtask.error ? ` — ${summarizeError(subtask.error)}` : '')
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
  const openQuestion = (run.attention?.items ?? []).find(item => actionableAttention(run, item))
  if (openQuestion) {
    // The user can act on this line directly; the id is what makes the answer
    // land on the question it belongs to.
    lines.push('', `next: superagent_answer run_id="${run.id}" attention_id="${openQuestion.id ?? 'q1'}" answer="..."`)
  }
  const guidance = statusGuidance(run)
  if (guidance.blockers.length) lines.push(`blockers: ${guidance.blockers.join(' | ')}`)
  if (guidance.nextSteps.length) lines.push(`nextSteps: ${guidance.nextSteps.join(' | ')}`)
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
        const total = ledger.byCurrency && Object.keys(ledger.byCurrency).length > 0
          ? formatCurrencyTally(ledger.byCurrency)
          : formatMoney({ totalMicros: ledger.totalMicros, currency: ledger.currency ?? 'USD' })
        lines.push(`ledger: ${total} across ${ledger.priced} priced run(s) in the last ${stats.ledgerDays} days`
          + (ledger.unpricedRuns > 0 ? ` (${ledger.unpricedRuns} run(s) partially unpriced)` : '')
          + (ledger.mixedCurrency ? ' (mixed currencies kept separate)' : ''))
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
  const configuredConsolePort = config?.consolePort
  const configuredBoardPort = config?.boardPort
  const cfg = resolveConfig(config)
  if (configuredConsolePort === undefined && typeof ctx.inject !== 'function') cfg.consolePort = null
  if (config?.workspaceIsolation === 'auto') {
    log('workspaceIsolation=auto: worktree availability and the serial fallback are decided per run from its selected project')
  }
  if (configuredPort !== undefined && configuredPort !== null && cfg.controlPort === null) {
    log(`controlPort ${JSON.stringify(configuredPort)} is not a whole number in 0–65535; the local HTTP control plane stays off`)
  }
  if (configuredWorkbenchPort !== undefined && configuredWorkbenchPort !== null && cfg.workbenchPort === null) {
    log(`workbenchPort ${JSON.stringify(configuredWorkbenchPort)} is not a whole number in 0–65535; the workspace panel stays off`)
  }
  if (configuredConsolePort !== undefined && configuredConsolePort !== null && cfg.consolePort === null) {
    log(`consolePort ${JSON.stringify(configuredConsolePort)} is not a whole number in 0–65535; the conversation console stays off`)
  }
  if (configuredBoardPort !== undefined && configuredBoardPort !== null && cfg.boardPort === null) {
    log(`boardPort ${JSON.stringify(configuredBoardPort)} is not a whole number in 0–65535; the task board stays off`)
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
  const repoWiki = createRepoWiki({
    stateDir: store.root,
    warn: log,
    maxFiles: cfg.repoWiki.maxFiles,
    maxBytes: cfg.repoWiki.maxBytes,
    maxDepth: cfg.repoWiki.maxDepth,
  })
  async function repositoryContext(projectPath, query) {
    if (!cfg.repoWiki.enabled || !cfg.repoWiki.autoContext || !projectPath) return ''
    try {
      await repoWiki.generate(projectPath)
      return await repoWiki.context(projectPath, { query, limit: 3, chars: cfg.repoWiki.contextChars }) ?? ''
    } catch (error) {
      log(`repository ontology context unavailable: ${error?.message ?? error}`)
      return ''
    }
  }
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const readUsage = createUsageReader({ sessionsRoot: path.join(home, 'sessions'), warn: log })
  // The ledger is an append-only history of priced runs. Writing it here, from
  // the read paths, keeps it out of the scheduling loop: a status or list call
  // is already a snapshot of finished work, and a run is recorded exactly once.
  const ledger = createLedger(store.root, { warn: log })
  const LEDGER_WINDOW_DAYS = 30
  const observability = createObservability({
    otel: () => getOptionalService('otel'),
    sessionQuery: () => getOptionalService('sessionQuery'),
    tokenMeter: () => getOptionalService('tokenMeter'),
    config: cfg.observability,
    log: (...parts) => log(parts.filter(Boolean).join(' ')),
  })
  const mcpMemory = createMCPMemoryBridge({
    mcpManager: () => getOptionalService('mcpManager'),
    config: cfg.mcpMemory,
    log,
    ctx,
  })
  const hostSchedule = createHostScheduleAdapter({ schedule: () => getOptionalService('schedule'), log })
  const disposeIntegrations = async () => {
    await Promise.allSettled([mcpMemory.dispose(), observability.dispose()])
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', disposeIntegrations)
  }

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
  // The browser half joins a shared combo script served to every page load, so
  // one syntax error in it can take the whole host UI down with it. Compile it
  // here, before the client-modules service reads it, and fall back to a no-op
  // entry when it does not parse: the worst case is a missing sidebar row.
  try {
    const clientEntry = path.join(packageRoot, 'lib', 'client.js')
    if (existsSync(clientEntry)) {
      const source = readFileSync(clientEntry, 'utf8')
      try {
        new Script(source, { filename: clientEntry })
      } catch (error) {
        writeFileSync(`${clientEntry}.broken`, source, 'utf8')
        writeFileSync(
          clientEntry,
          `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: () => ({ apply() {} }) })\n`,
          'utf8',
        )
        log(
          `the browser half did not compile (${error?.message ?? error}); `
          + `kept it as ${clientEntry}.broken and served a no-op so the host still boots`,
        )
      }
    }
  } catch (error) {
    log(`cannot verify the browser half: ${error?.message ?? error}`)
  }
  const memoryBlocked = isInside(store.root, packageRoot)
  const memory = cfg.memory && !memoryBlocked ? createMemory(store.root, { warn: log }) : null
  // The user-level profile is a deliberate opt-in: it outlives tasks and records
  // things about a person, so it is never created from a default config.
  const userMemory = cfg.memory && cfg.memoryUserProfile && !memoryBlocked
    ? createUserMemory(store.root, { warn: log })
    : null
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
  let guardHooked = false
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
      guardHooked = true
      if (typeof release === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => release())
      }
    } else if (typeof ctx.on === 'function') {
      ctx.on('tools/pre-execute', async (exec, next) => {
        const reason = enforce(exec)
        return reason ? { kind: 'deny', reason } : next()
      })
      hooked = true
      guardHooked = true
    }
    if (!hooked) {
      log('guard is enabled but this host exposes neither tools.guard nor tools/pre-execute; child calls are not gated')
    }
  }

  // Tools alone do not tell a model when to use them. A session that mounts
  // `superagent_start` next to the host's `subagent` tool can hand-orchestrate
  // the work with the latter — three children, three report fragments, and no
  // run, no plan, no merged report, and nothing in the run list to look at.
  // This nudge is the only thing that states the policy, so it is injected once
  // per session, at the first step of a top-level session: repeating it every
  // turn would put another copy in the history each time.
  const GUIDANCE_SOURCE = { kind: 'superagent-guidance', form: 'notice', summary: '多步目标先起 run' }
  const GUIDANCE_TEXT = [
    '多步目标（两个及以上可独立交付物，或含“先 A 后 B”的前置依赖）先用 superagent_start(mode="planned") 起 run，',
    '之后用 superagent_followup 续、superagent_status 读报告；不要用内置 subagent 自己编排，那样没有计划与合并报告。',
    '直接调用，先不要确认工具是否存在；只有返回不存在时才退回 subagent。单一动作直接做，不必起 run。',
    '长期目标、定时、跨 run 记忆、仓库 ontology、模板、审计、实时插话：先调 superagent_help 展开这些工具。',
  ].join('')
  // Session ids that already carry the notice in their history. Bounded so a
  // long-lived host cannot accumulate them without limit.
  const guidedSessions = new Set()
  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || step !== 1) return decision
      const header = agent?.session?.header
      if (!header) return decision
      if ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent') return decision
      if (decision.messages.some(message => message?.source?.kind === GUIDANCE_SOURCE.kind)) return decision
      const sessionId = sessionKey(agent)
      if (sessionId && guidedSessions.has(sessionId)) return decision
      if (sessionId) {
        if (guidedSessions.size >= 2000) guidedSessions.clear()
        guidedSessions.add(sessionId)
      }
      const guidance = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: isPanelSession(agent)
          ? '先区分新委托和对已有任务的补充。用户补充正在进行的任务时，先用 superagent_list 找到本会话的任务，'
            + '再用 superagent_status 核对具体工作线。只有目标明确才用 superagent_inject 给指定工作线发送，'
            + '或在暂无运行中的工作线时用 superagent_followup 给该任务留下一次执行的要求。'
            + '有多个可能的任务时只问一句要改哪一项。不要重开任务，也不要把修改发到无关任务。'
            + '引用旧方案或产物时，用 superagent_list 的 query 搜索工作台历史。'
            + '新委托需要交付时调用 superagent_start，单项用 direct，多项用 planned。可验收时设置 goal_mode 和验收条件。'
            + '多阶段长期目标先用 superagent_help 展开 superagent_goal。单纯问答直接回复。'
          : GUIDANCE_TEXT }],
        source: GUIDANCE_SOURCE,
      }
      return { ...decision, messages: [guidance, ...decision.messages] }
    })
  }

  // Every declaration is paid for on every request, so the capabilities most
  // sessions never touch are registered with a per-session activation
  // condition (see EXTRA_TOOLS): `superagent_help` names them and turns them on.
  const expandedSessions = new Set()
  const sessionKey = agent => {
    const header = agent?.session?.header
    return agent?.id ?? header?.id ?? header?.sessionId
  }
  const isExpanded = agent => Boolean(expandedSessions.has(sessionKey(agent)))
  // The host's contract is `tools.register(definition, { when })`: `when` is
  // evaluated for every step, and false keeps the tool out of that step's
  // declarations and dispatch.
  const EXTRA_TOOLS = { when: context => isExpanded(context?.agent) }

  // Delegated workers must not see the superagent surface at all: a worker that
  // could start another run would nest schedulers and double the token spend.
  const isWorker = agent => {
    const header = agent?.session?.header
    return (header?.delegationDepth ?? 0) > 0 || header?.origin === 'subagent'
  }
  // Sessions opened through the console are the user's own space, so the eight
  // core tools stay visible there. A plain host conversation sees only
  // `superagent_help`, which expands the rest on demand.
  const panelSessions = new Set()
  let searchWorkbenchHistory = null
  let readTaskDecisions = async () => []
  let readTaskImpacts = async () => []
  const isPanelSession = agent => {
    const header = agent?.session?.header
    return panelSessions.has(agent?.id)
      || (header?.id ? panelSessions.has(header.id) : false)
      || (header?.sessionId ? panelSessions.has(header.sessionId) : false)
  }
  const residentGate = definition => {
    const name = typeof definition?.name === 'string' ? definition.name : ''
    if (!name.startsWith('superagent_')) return undefined
    if (name === 'superagent_help') return { when: context => !isWorker(context?.agent) }
    return {
      when: context => !isWorker(context?.agent)
        && (isPanelSession(context?.agent) || isExpanded(context?.agent)),
    }
  }
  const registerTool = (definition, options) => ctx.tools.register(
    definition,
    options ?? residentGate(definition),
  )

  // Runtime control is opt-in. With `runtime.enabled` false nothing below is
  // registered, which is why a profile that never asked for browser or desktop
  // access sees exactly the same tool list as before this layer existed.
  const runtime = createRuntimeControl({
    config: cfg.runtime,
    stateRoot: store.root,
    auditor,
    warn: log,
  })
  const runtimeView = createRuntimeViewController({
    runtimeControl: runtime.enabled ? runtime : null,
    tools: runtime.tools,
    shotDir: runtime.enabled ? runtime.shotDir : null,
    cancel: runtime.enabled ? runId => runId ? orchestrator.cancel(runId) : undefined : null,
    warn: log,
  })
  const runtimeStream = createRuntimeStream({ limit: 200, maxFrameBytes: 512 * 1024 })
  const stopRuntimeStream = runtimeView.subscribe(event => {
    const type = event.type === 'frame' ? 'screenshot' : event.type === 'action' ? 'current-action' : 'state'
    runtimeStream.publish({ ...event, type })
  })
  if (typeof ctx.on === 'function') ctx.on('dispose', () => {
    stopRuntimeStream()
    runtimeStream.dispose()
    runtimeView.dispose()
  })
  if (runtime.tools.length > 0) {
    for (const spec of runtimeView.tools) {
      registerTool(defineTool({
        ...spec,
        execute: (args, exec) => runtime.withActor(exec?.agent?.id, () => spec.execute(args, exec)),
      }))
    }
    log(
      `runtime control: ${runtime.tools.length} tool(s) registered; stop switch ${runtime.stopFile}; `
      + `screenshots ${runtime.shotDir}`,
    )
    if (typeof ctx.effect === 'function') ctx.effect(() => () => runtime.dispose())
  }

  const notifyPolicy = createNotifyPolicy({
    stateFile: path.join(store.root, 'notifications.json'),
    maxPerHour: cfg.maxNotificationsPerHour,
    warn: log,
  })
  const notificationPreferences = createNotifyPreferences({
    file: path.join(store.root, 'notification-preferences.json'),
    warn: log,
  })
  // One wake-up per run, delivered in order per session. A busy session loop
  // can reject a followup, so the same message is retried with backoff instead
  // of being reported as lost on the first refusal.
  const outbox = createOutbox({ retries: cfg.notifyRetries, delayMs: cfg.notifyRetryDelayMs })

  /** Child sessions spawned by this process; a run may not be started from one. */
  const childIds = new Set()

  const remoteJobs = new Map()
  const remoteAttempts = new Map()
  const remoteJobStore = createRemoteJobStore({
    file: path.join(store.root, 'remote-jobs.json'), warn: log,
  })
  let consoleApi = null
  const briefScheduler = createBriefScheduler({
    preferencesStore: notificationPreferences,
    stateFile: path.join(store.root, 'brief-deliveries.json'),
    setTimer: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref?.()
      return timer
    },
    async buildBrief({ date, now, preferences }) {
      const bench = await consoleHost.workbench(null, { limit: Infinity, includeImpact: false, scope: 'global' })
      return aggregateNotificationCenter({
        runs: bench.runs,
        goals: bench.goals,
        approvals: [],
        artifacts: collectArtifacts(bench.runs, bench.sessionProjects),
        preferences,
        now: date,
      }).dailyBrief
    },
    async deliver({ brief }) {
      if (!brief) return { delivered: false, reason: 'daily-brief-disabled' }
      if (!brief.channels?.length) return { delivered: false, reason: 'no-delivery-channel' }
      if (!consoleApi) return { delivered: false, reason: 'console-not-ready' }
      consoleApi.publish({ type: 'notification', notification: brief })
      return { delivered: true, channels: brief.channels }
    },
  })
  let remoteProvider = null
  let remoteProviderError = null
  if (cfg.remoteWorker?.endpoint) {
    try {
      remoteProvider = createRemoteWorkerProvider({
        baseUrl: cfg.remoteWorker.endpoint,
        fetchImpl: cfg.remoteWorker.fetchImpl,
        credentials: cfg.remoteWorker.tokenEnv
          ? async () => {
            const token = process.env[cfg.remoteWorker.tokenEnv]
            if (typeof token !== 'string' || !token.trim()) throw new Error('remote worker token environment variable is missing')
            return token.trim()
          }
          : undefined,
        pollIntervalMs: cfg.remoteWorker.pollIntervalMs,
        timeoutMs: cfg.remoteWorker.timeoutMs,
        logger: log,
      })
    } catch (error) {
      remoteProviderError = error
      log(`remote Worker provider is unavailable: ${error?.message ?? error}`)
    }
  }

  function requireRemoteProvider() {
    if (!remoteProvider || !cfg.remoteWorker?.model || !cfg.remoteWorker?.provider) {
      const error = new Error(remoteProviderError?.message
        ?? 'remote Worker is not configured; set remoteWorker.endpoint/model/provider')
      error.code = 'CLOUD_WORKER_UNAVAILABLE'
      throw error
    }
    return remoteProvider
  }

  async function remoteJob(workerId) {
    const job = await remoteJobStore.get(workerId)
    if (!job) {
      const error = new Error(`unknown remote Worker ${workerId}`)
      error.code = 'unknown-worker'
      throw error
    }
    remoteJobs.set(workerId, job)
    return job
  }

  async function ensureRemoteLease(workerId, options = {}) {
    let job = await remoteJob(workerId)
    const expiresAt = Date.parse(job.lease?.expiresAt ?? '')
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) return job
    const provider = requireRemoteProvider()
    if (typeof provider.reattach !== 'function') {
      const error = new Error('remote Worker lease expired and the provider does not support reattach')
      error.code = 'CLOUD_WORKER_REATTACH_UNAVAILABLE'
      throw error
    }
    const attached = await provider.reattach(workerId, { lease: job.lease, cursor: job.lastCursor ?? 0, signal: options.signal })
    if (Number.isSafeInteger(attached.nextCursor) && attached.nextCursor > (job.lastCursor ?? 0)) {
      const advanced = await remoteJobStore.advanceCursor(workerId, attached.nextCursor, { lease: attached.lease })
      if (advanced?.job) job = advanced.job
    }
    job = await persistRemoteState(workerId, attached.state, attached.lease)
    return job
  }

  async function persistRemoteState(workerId, state, lease = null) {
    const current = await remoteJob(workerId)
    if (REMOTE_TERMINAL.has(state)) {
      const result = await remoteJobStore.markTerminal(workerId, state, {
        lease: lease ?? current.lease,
        error: state === 'succeeded' ? null : `remote-worker-${state}`,
      })
      if (result?.job) remoteJobs.set(workerId, result.job)
      return result?.job ?? current
    }
    if (!['queued', 'running', 'cancelling'].includes(state)) return current
    const result = await remoteJobStore.markState(workerId, state, { lease: lease ?? current.lease })
    if (result?.job) remoteJobs.set(workerId, result.job)
    return result?.job ?? current
  }

  const REMOTE_TERMINAL = new Set(['succeeded', 'failed', 'stopped', 'timed_out'])
  function remoteEventState(event) {
    const raw = event?.state ?? event?.workerState ?? event?.type?.replace(/^worker\./, '')
    const state = { completed: 'succeeded', cancelled: 'stopped', timeout: 'timed_out' }[raw] ?? raw
    return REMOTE_TERMINAL.has(state) ? state : null
  }

  function remoteEventText(event) {
    const value = event?.output ?? event?.text ?? event?.report ?? event?.data?.output ?? event?.data?.text
      ?? event?.result?.output ?? event?.result?.text
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text)
      .filter(item => typeof item === 'string').join('\n')
    return ''
  }

  async function collectRemoteEvents(workerId, options = {}) {
    let job = await ensureRemoteLease(workerId, options)
    const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(1000, options.limit)) : 200
    const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, Math.min(10_000, options.waitMs)) : 1_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), waitMs)
    const events = []
    let cursor = Number.isSafeInteger(options.cursor) ? options.cursor : job.lastCursor ?? 0
    try {
      for await (const event of requireRemoteProvider().events(workerId, {
        lease: job.lease, cursor, signal: controller.signal,
        pollIntervalMs: cfg.remoteWorker?.pollIntervalMs,
      })) {
        events.push(redactSensitiveValue(event))
        if (Number.isSafeInteger(event?.cursor) && event.cursor > cursor) {
          const advanced = await remoteJobStore.advanceCursor(workerId, event.cursor, { lease: event.lease ?? job.lease })
          if (advanced?.job) job = advanced.job
          cursor = event.cursor
        }
        job = await persistRemoteState(workerId, remoteEventState(event) ?? event?.state ?? event?.workerState ?? job.state, event.lease ?? job.lease)
        if (events.length >= limit || remoteEventState(event)) break
      }
    } catch (error) {
      if (!controller.signal.aborted && error?.name !== 'AbortError') throw error
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    return { workerId, events, cursor }
  }

  /**
   * The subagent service is optional, so it is read from the service store at
   * call time rather than declared as an injection: a profile without it must
   * still mount the fifteen tools (they then explain what is missing), and reading
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

  /** Optional host services are read lazily so minimal profiles still mount. */
  function getOptionalService(name) {
    if (typeof ctx.get === 'function') {
      try {
        const service = ctx.get(name)
        if (service) return service
      } catch {
        // Fall through to the direct test-context shape.
      }
    }
    try {
      return ctx[name]
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

  /**
   * The Host Session API, when the host provides one. The console uses it for
   * conversation; the scheduler uses it to bring back the session that owns a
   * plan after a restart, so a scheduled run does not depend on the original
   * process still being alive.
   */
  function getSessionController() {
    if (typeof ctx.get === 'function') {
      const service = ctx.get('sessionController')
      if (service) return service
    }
    // Direct property is topology-sensitive; this is a fallback for hosts
    // that expose the service without the registry.
    try {
      return ctx.sessionController
    } catch {
      return undefined
    }
  }

  /**
   * What this host can do about a plan's owner when its session is not live.
   * `resume` reopens a persisted session, `create` can at least start a fresh
   * one, and `none` means a plan is only as durable as the session that made
   * it — a limit recorded on the plan instead of discovered as a pause.
   */
  function scheduleOwnerRecovery() {
    const agents = getAgents()
    if (agents && typeof agents.resume === 'function') return 'resume'
    if (agents && typeof agents.create === 'function') return 'create'
    const session = getSessionController()
    if (session && typeof session.resolveAgent === 'function') return 'resume'
    if (session && typeof session.create === 'function') return 'create'
    return 'none'
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
    const preferences = await notificationPreferences.read()
    const decision = (run.attention?.items ?? []).find(item => actionableAttention(run, item)) ?? null
    const event = decision ? 'decision' : run.status === 'completed' ? 'completed' : 'failed'
    const mode = preferences.events[event]
    if (mode === 'off') return { delivered: false, reason: `suppressed: ${event} notifications are off` }
    if (!preferences.channels.includes('push') || !['push', 'both'].includes(mode)
      || isQuietHours(run.finishedAt ?? new Date(), preferences.quietHours, event)) {
      run.notified = true
      return { delivered: false, reason: `inbox-only: ${event} push is disabled or quiet hours are active` }
    }
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
    const verdict = await notifyPolicy.reserve(run, { maxPerHour: preferences.maxPushPerHour })
    if (!verdict.allowed) return { delivered: false, reason: verdict.reason }

    const completed = run.subtasks.filter(subtask => subtask.status === 'completed').length
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

  /**
   * Capability tags that mean "this worker will run commands". The planner emits
   * lowercase tags (`capabilityList`), and `shell` is the canonical name; the
   * aliases are here because a plan may spell the tool family instead.
   */
  const COMMAND_CAPABILITIES = new Set([
    'shell', 'bash', 'sh', 'zsh', 'fish', 'terminal', 'pwsh', 'powershell', 'cmd',
    'run.command', 'run_command', 'exec.command', 'exec_command',
  ])

  /** True when one plan entry says its worker needs a command tool. */
  function wantsCommandSandbox(requires) {
    return Array.isArray(requires) && requires.some(tag => COMMAND_CAPABILITIES.has(String(tag).toLowerCase()))
  }

  /** Record one escalation step; callers never await it, so the window stays synchronous. */
  function recordSandboxEscalation(kind, { runId, subtaskId, reason, from, to }) {
    if (!auditor || typeof auditor.record !== 'function') return
    auditor.record({
      kind,
      runId,
      subtaskId,
      actor: 'superagent',
      action: 'sandbox',
      target: to,
      decision: 'allow',
      result: 'allowed',
      source: 'permission',
      meta: { reason, from: from ?? null, to },
    }).catch(error => log(`audit: cannot record ${kind}: ${error?.message ?? error}`))
  }

  /**
   * Raise the parent session's sandbox override for exactly one synchronous
   * call, without awaiting inside that call.
   *
   * The host has no per-subagent permission field. Its one seam is delegation
   * inheritance: `startActivation` reads the parent session's last
   * `sandbox/mode` event synchronously, before its first await, and seeds that
   * mode into the child. So the override is appended, `startActivation` is
   * invoked in the same tick, and the previous mode is appended again in a
   * `finally` before control returns to the event loop. Nothing between those
   * three steps may await, or a concurrent call would observe full access.
   *
   * @param {object} parent - the live parent agent the child is delegated from.
   * @param {{ runId?: string, subtaskId?: string, reason: string }} meta - audit context.
   * @returns {{ restore: () => void } | null} the rollback, or null when this host cannot be used.
   */
  function beginCommandEscalation(parent, { runId, subtaskId, reason }) {
    const session = parent?.session
    const sandboxPolicy = typeof parent?.ctx?.get === 'function' ? parent.ctx.get('sandboxPolicy') : undefined
    if (!session || typeof session.append !== 'function'
      || !sandboxPolicy || typeof sandboxPolicy.overrideOf !== 'function') {
      log(`commandWorkerPermission: the parent session exposes no sandbox override, so this worker inherits (${reason})`)
      return null
    }
    const previous = sandboxPolicy.overrideOf(session) ?? sandboxPolicy.defaultMode
    // Without a readable previous mode the window could not be closed again.
    if (previous === undefined) {
      log(`commandWorkerPermission: the deployment default sandbox mode is unknown, so this worker inherits (${reason})`)
      return null
    }
    // Already unconfined: the child inherits it, so no event is needed.
    if (previous === 'danger-full-access') return null
    recordSandboxEscalation('worker.escalate', {
      runId,
      subtaskId,
      reason,
      from: previous,
      to: 'danger-full-access',
    })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    return {
      restore() {
        session.append('sandbox/mode', { mode: previous })
        recordSandboxEscalation('worker.restore', {
          runId,
          subtaskId,
          reason: `restore the parent sandbox mode after the child captured the delegation (${reason})`,
          from: 'danger-full-access',
          to: previous,
        })
      },
    }
  }

  function remoteContractTools(scope) {
    const names = permission => {
      switch (permission) {
        case 'filesystem.read': return ['read_file', 'list_files', 'search_files']
        case 'filesystem.write': return ['write_file', 'edit_file', 'create_file', 'delete_file', 'move_file', 'copy_file', 'apply_patch']
        case 'shell.execute': return ['bash', 'pwsh', 'terminal', 'run_command']
        case 'network': return ['web_search', 'browser_open', 'browser_click', 'fetch']
        default: return []
      }
    }
    const allow = [...new Set([...(scope?.tools ?? []), ...(scope?.allow ?? [])].flatMap(names))]
    const deny = [...new Set([...(scope?.deny ?? []).flatMap(names)])]
    return { allow, deny }
  }

  const orchestrator = createOrchestrator({
    store,
    config: cfg,
    log,
    // Declared deliverables are resolved against the same directory workers
    // see: an isolated checkout per subtask, or the host project otherwise.
    cwd: cfg.workspaceRoot ? path.resolve(cfg.workspaceRoot) : process.cwd(),
    readUsage,
    memory,
    userMemory,
    guard,
    audit: auditor,
    hostWorktrees: () => getOptionalService('worktrees'),
    hostWorkingDirectory: () => getOptionalService('workingDirectory'),
    observe: event => observability.record(event),
    takeHumanHandoff: runtime.takeHumanHandoff,
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
    // Preflight must inspect the worker's effective tools, not every tool the
    // parent can see. A child preset may hide browser/desktop tools, and the
    // guard denies runtime tools unless the operator explicitly allows them.
    async toolInventory(parent) {
      if (typeof ctx.tools?.definitions !== 'function') return null
      const definitionsOf = scope => ctx.tools.definitions(scope)
      const namesOf = definitions => Array.isArray(definitions)
        ? definitions
          .map(definition => definition?.name)
          .filter(name => typeof name === 'string' && name.length > 0 && !name.startsWith('superagent_'))
        : null
      let parentTools
      try {
        parentTools = namesOf(definitionsOf(parent))
      } catch (error) {
        log(`cannot read the host tool inventory: ${error?.message ?? error}`)
        return null
      }
      if (parentTools === null) return null
      let effective = parentTools
      if (cfg.childPreset) {
        const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
        if (typeof presets?.acquireScope !== 'function') return null
        let lease = null
        try {
          lease = await presets.acquireScope(cfg.childPreset)
          const presetTools = namesOf(definitionsOf(lease?.key))
          if (presetTools === null) return null
          const selected = new Set(presetTools)
          effective = parentTools.filter(name => selected.has(name))
        } catch (error) {
          log(`cannot read the child preset tool inventory: ${error?.message ?? error}`)
          return null
        } finally {
          if (typeof lease?.[Symbol.asyncDispose] === 'function') await lease[Symbol.asyncDispose]()
        }
      }
      const guardEnabled = !(cfg.guard?.enabled === false
        || /^(false|0|off|no)$/i.test(String(cfg.guard?.enabled ?? '')))
      return guardEnabled && cfg.guard?.allowRuntimeTools !== true
        ? effective.filter(name => !/^(browser|desktop)_/.test(name))
        : effective
    },
    async spawnChild({ label, prompt, parent, signal, model, runId, subtaskId, requires, preset, provider: providerOverride, cwd: childCwd, executionContract }) {
      if (cfg.provider === 'remote') {
        const providerApi = requireRemoteProvider()
        if (!cfg.remoteWorker?.model || !cfg.remoteWorker?.provider) {
          const error = new Error('remote Worker requires remoteWorker.model and remoteWorker.provider')
          error.code = 'CLOUD_WORKER_UNAVAILABLE'
          throw error
        }
        if (typeof runId !== 'string' || !runId) throw new Error('remote Worker requires a stable runId')
        const childIdPart = subtaskId ?? label
        const attemptKey = `${runId}:${childIdPart}`
        const attempt = (remoteAttempts.get(attemptKey) ?? 0) + 1
        remoteAttempts.set(attemptKey, attempt)
        if (remoteAttempts.size > 4096) remoteAttempts.delete(remoteAttempts.keys().next().value)
        const cwd = path.resolve(childCwd ?? cfg.workspaceRoot ?? process.cwd())
        const contractToolScope = executionContract?.permissionScope ? remoteContractTools(executionContract.permissionScope) : null
        const workSpec = createWorkSpec({
          run: { id: runId }, subtask: { id: childIdPart }, attempt,
          repoSnapshot: { provider: 'workspace', ref: cwd },
          prompt, model: { provider: cfg.remoteWorker.provider, ref: model ?? cfg.remoteWorker.model },
          toolScope: contractToolScope
            ? { ...contractToolScope, deny: ['superagent_*', ...contractToolScope.deny] }
            : { allow: Array.isArray(requires) ? requires : [], deny: ['superagent_*'] },
          approvalScope: { mode: 'policy', scopes: [] },
          budget: { maxWallSeconds: cfg.deadlineMinutes * 60 },
          deadline: new Date(Date.now() + cfg.deadlineMinutes * 60_000).toISOString(),
          checkpoint: { ref: `dsh:${runId}:${childIdPart}:${attempt}` },
          metadata: { cwd, label, parentSessionId: parent?.id ?? null },
        })
        const submitted = await providerApi.submit(workSpec, { signal,
          idempotencyKey: `dsh:${runId}:${childIdPart}:${attempt}` })
        let job = await remoteJobStore.put(submitted.workerId, {
          workerId: submitted.workerId, lease: submitted.lease, fencingToken: submitted.fencingToken,
          workSpec, state: submitted.state, terminal: REMOTE_TERMINAL.has(submitted.state),
          createdAt: new Date().toISOString(),
        })
        remoteJobs.set(submitted.workerId, job)
        const controller = new AbortController()
        const relayAbort = () => controller.abort(signal.reason)
        if (signal?.aborted) relayAbort()
        else signal?.addEventListener('abort', relayAbort, { once: true })
        const result = (async () => {
          const chunks = []
          let terminal = null
          try {
            for await (const event of providerApi.events(submitted.workerId, {
              lease: job.lease, cursor: job.lastCursor ?? 0, signal: controller.signal, pollIntervalMs: cfg.remoteWorker?.pollIntervalMs,
            })) {
              const text = remoteEventText(event)
              if (text) chunks.push(text)
              terminal = remoteEventState(event)
              if (Number.isSafeInteger(event?.cursor) && event.cursor > (job.lastCursor ?? 0)) {
                const advanced = await remoteJobStore.advanceCursor(submitted.workerId, event.cursor, { lease: event.lease ?? job.lease })
                if (advanced?.job) job = advanced.job
              }
              job = await persistRemoteState(submitted.workerId, terminal ?? event?.state ?? event?.workerState ?? job.state, event.lease ?? job.lease)
              if (terminal) break
            }
            if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
            if (!terminal) {
              const snapshot = await providerApi.snapshot(submitted.workerId, { lease: submitted.lease,
                signal: controller.signal })
              job.state = snapshot.state
              if (chunks.length === 0) {
                const text = remoteEventText(snapshot)
                if (text) chunks.push(text)
              }
              if (REMOTE_TERMINAL.has(snapshot.state)) {
                terminal = snapshot.state
                job = await persistRemoteState(submitted.workerId, terminal, snapshot.lease)
              }
            }
            if (!terminal) throw new Error('remote Worker event stream ended before a terminal state')
            await persistRemoteState(submitted.workerId, terminal)
            return {
              output: [{ type: 'text', text: chunks.join('\n') }],
              stopReason: terminal === 'succeeded' ? 'completed' : 'failed',
              diagnostic: terminal === 'succeeded' ? null : `remote Worker ended as ${terminal}`,
              workerId: submitted.workerId,
            }
          } finally {
            signal?.removeEventListener('abort', relayAbort)
          }
        })()
        result.catch(() => {})
        return {
          childId: submitted.workerId,
          result,
          async dispose() {
            controller.abort(new DOMException('Remote Worker disposed', 'AbortError'))
            if (!job.terminal) await providerApi.cancel(submitted.workerId, { lease: submitted.lease,
              idempotencyKey: `cancel:${submitted.workerId}` }).catch(error =>
                log(`remote Worker cancel failed for ${submitted.workerId}: ${error?.message ?? error}`))
          },
        }
      }
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
      const childProvider = providerOverride ?? cfg.childProvider
      if (childProvider) agentOptions.provider = childProvider
      if (childModel) agentOptions.model = childModel
      const request = {
        parent,
        prompt: [{ type: 'text', text: prompt }],
        // The host resolves relative paths (and shell commands) against this
        // directory. Isolation is only real when the child starts in its own
        // checkout; otherwise `notes/report.md` lands in the parent's checkout
        // while verification looks inside the worktree.
        ...(childCwd ? { cwd: path.resolve(childCwd) } : {}),
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      }
      // A preset is the host's only way to give a child a narrower tool set:
      // the start request has no tool filter. The planner passes its own
      // preset (usually one with no tools); workers fall back to childPreset.
      const requestedPreset = preset ?? cfg.childPreset
      const automaticPlannerPreset = !cfg.childPreset && requestedPreset === 'planner'
        && cfg.plannerPreset === 'planner'
      const presetUnsupported = requestedPreset && automaticPlannerPreset
        && ((typeof ctx.get === 'function' && !ctx.get('agentPresets')) || capabilities?.agentPreset === false)
      if (requestedPreset && !presetUnsupported) {
        if (typeof ctx.get === 'function' && !ctx.get('agentPresets')) {
          throw new Error(
            `agent preset "${requestedPreset}" cannot be applied: this profile does not compose an agentPresets `
            + 'registry, so the child would run with this session\'s tools',
          )
        }
        if (capabilities && !capabilities.agentPreset) {
          throw new Error(
            `agent preset "${requestedPreset}" cannot be applied: subagent provider "${cfg.provider}" does not `
            + 'support independent agent presets, so this child would run with this session\'s tools',
          )
        }
        request.agentPreset = requestedPreset
      } else if (presetUnsupported) {
        log(`planner preset "${requestedPreset}" is unavailable on this host; planner inherits the session route`)
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
      // Escalation and rollback are one synchronous tick: the host captures the
      // parent override inside `startActivation` before its first await, so an
      // await anywhere between append, call, and restore would leak full access
      // to a concurrent child of this session.
      const escalation = cfg.commandWorkerPermission === 'danger-full-access' && wantsCommandSandbox(requires)
        ? beginCommandEscalation(parent, {
          runId,
          subtaskId,
          reason: `the plan declared command capability: ${requires.join(', ')}`,
        })
        : null
      let pending
      try {
        // dsh 0.2.2-rc.1 reads the delegation fields from `request`; 0.2.2-rc.3
        // (the desktop host) reads them from the spec itself. Sending only
        // `request` leaves the newer host's `spec.parent` undefined, and it
        // throws "Cannot read properties of undefined (reading 'id')" before
        // any child exists. Mirror both shapes; each host ignores the keys it
        // does not read.
        pending = subagents.startActivation({
          provider: cfg.provider,
          label,
          request,
          ...request,
          signal,
          delivery: 'caller',
        })
      } finally {
        escalation?.restore()
      }
      const activation = await pending
      rememberChild(activation.childId)
      guard.bindChild(activation.childId, { runId, label,
        ...(executionContract ? { executionContract } : {}) })
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

  /**
   * The scheduler is a caller of the orchestrator, not a second run engine.
   * Its timer starts a run only if the plan is due, the previous run of that
   * plan is over, the plan's budget still has room, and the quota has a slot
   * for it. A plan's failure backoff decides whether the user is woken.
   */
  // A session brought back for scheduled runs is owned by this plugin, so it
  // is disposed with the plugin instead of outliving the host that made it.
  const scheduleOwners = new Set()

  /**
   * Bring back the session that owns a plan, using the narrowest host API that
   * can do it. `agents.resume` is the durable one: it reopens the persisted
   * session in this process, which is exactly the "usable execution context"
   * a scheduled run needs after a restart. The console's Host Session API is a
   * fallback; a fresh session is the last resort.
   *
   * @param {object} plan - plan whose window is firing.
   * @returns {Promise<object | {agent: object, sessionId: string} | null>} agent or agent+id.
   */
  async function recoverScheduleOwner(plan, label = 'schedule', options = {}) {
    const agents = getAgents()
    const session = getSessionController()
    // `agents.resume` reopens the transcript without the Session's agent
    // preset, so the agent it returns runs without the file and shell tools the
    // Session was created with. A long-goal phase hands its owner to child
    // agents, so it needs a fully composed owner: the session controller mounts
    // the recorded preset, which is why the goal path asks it first. Scheduled
    // runs keep the old order so their behaviour does not change.
    if (options.preferResolve && session && typeof session.resolveAgent === 'function') {
      try {
        const resolved = await session.resolveAgent(plan.ownerSessionId)
        if (resolved?.agent) {
          const registered = getAgents()?.get?.(plan.ownerSessionId)
          return registered ?? resolved.agent
        }
        if (resolved?.error) log(`${label} ${plan.id}: cannot open session ${plan.ownerSessionId}: ${resolved.error}`)
      } catch (error) {
        log(`${label} ${plan.id}: cannot open session ${plan.ownerSessionId}: ${error?.message ?? error}`)
      }
    }
    if (agents && typeof agents.resume === 'function') {
      try {
        const handle = await agents.resume({ resumeSessionId: plan.ownerSessionId })
        if (handle?.agent) {
          scheduleOwners.add(handle)
          return handle.agent
        }
      } catch (error) {
        log(`${label} ${plan.id}: cannot resume session ${plan.ownerSessionId}: ${error?.message ?? error}`)
      }
    }
    if (session && typeof session.resolveAgent === 'function') {
      const resolved = await session.resolveAgent(plan.ownerSessionId)
      if (resolved?.agent) {
        const registered = getAgents()?.get?.(plan.ownerSessionId)
        return registered ?? resolved.agent
      }
      if (resolved?.error) log(`${label} ${plan.id}: cannot resume session ${plan.ownerSessionId}: ${resolved.error}`)
    }
    if (agents && typeof agents.create === 'function') {
      const sessionId = randomUUID()
      try {
        const handle = await agents.create({
          sessionId,
          ...(plan.cwd ? { meta: { cwd: plan.cwd } } : {}),
        })
        if (handle?.agent) {
          scheduleOwners.add(handle)
          return { agent: handle.agent, sessionId }
        }
      } catch (error) {
        log(`${label} ${plan.id}: cannot create a replacement session: ${error?.message ?? error}`)
      }
    }
    if (session && typeof session.create === 'function') {
      const created = await session.create({ cwd: plan.cwd || workbenchRoot })
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (sessionId) {
        const registered = getAgents()?.get?.(sessionId)
        if (registered && typeof registered === 'object') return { agent: registered, sessionId }
        if (typeof session.resolveAgent === 'function') {
          const resolved = await session.resolveAgent(sessionId)
          if (resolved?.agent) return { agent: resolved.agent, sessionId }
        }
      }
      log(`${label} ${plan.id}: the host could not create a replacement session`)
    }
    return null
  }

  let activeRouter = null
  const scheduler = createScheduler({
    stateFile: path.join(store.root, 'schedules.json'),
    orchestrator: {
      start: args => orchestrator.start(args),
      status: runId => scheduledStatus(runId),
      activeSnapshot: () => orchestrator.activeSnapshot(),
      list: () => orchestrator.list(),
    },
    async execute(args, { plan, dueAt }) {
      const rule = plan.execution?.ruleId
        ? (await automationStore.list()).find(item => item.id === plan.execution.ruleId) : null
      if (plan.execution?.ruleId && !rule) throw new Error(`automation rule ${plan.execution.ruleId} is missing`)
      if (rule?.budget?.maxCost != null) {
        const summary = await costCenter.aggregate()
        if ((summary.byCurrency?.USD ?? 0) >= rule.budget.maxCost * 1e6) {
          const error = new Error('automation lifetime cost budget is exhausted')
          error.code = 'automation-budget-stopped'
          throw error
        }
      }
      if (plan.execution?.kind !== 'router') return orchestrator.start(args)
      const requestId = `auto-${createHash('sha256').update(`${plan.id}:${dueAt}`).digest('hex').slice(0, 36)}`
      const execution = await submitAutomationRule({ rule, text: args.goal, project: plan.cwd,
        requestId, idempotencyKey: `scheduled:${plan.id}:${dueAt}` })
      return { id: `router:${requestId}`, status: execution.status ?? 'queued', usage: execution.usage ?? null }
    },
    async resolveOwner(plan) {
      const live = getAgents()?.get?.(plan.ownerSessionId)
      if (live && typeof live === 'object') return live
      return recoverScheduleOwner(plan)
    },
    async notify({ plan, event, message }) {
      let agent = getAgents()?.get?.(plan.ownerSessionId)
      if (!agent) {
        const recovered = await recoverScheduleOwner(plan)
        agent = recovered?.agent ?? recovered ?? null
      }
      if (!agent || typeof agent.followup !== 'function') {
        log(`schedule ${plan.id} (${event}) has no live session ${plan.ownerSessionId} to notify`)
        return { delivered: false }
      }
      const preferences = await notificationPreferences.read()
      const notificationEvent = event === 'achieved' ? 'completed'
        : ['needs-decision', 'budget', 'paused', 'blocked'].includes(event) ? 'decision' : 'failed'
      const mode = preferences.events[notificationEvent]
      if (mode === 'off' || !preferences.channels.includes('push') || !['push', 'both'].includes(mode)
        || isQuietHours(new Date(), preferences.quietHours, notificationEvent)) {
        return { delivered: false, reason: 'notification-preferences' }
      }
      const verdict = await notifyPolicy.reserve({ id: `schedule:${plan.id}:${event}`,
        status: notificationEvent === 'completed' ? 'completed' : 'failed' }, { maxPerHour: preferences.maxPushPerHour })
      if (!verdict.allowed) return { delivered: false, reason: verdict.reason }
      try {
        await outbox.enqueue(plan.ownerSessionId, () => agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: message }],
          source: { kind: 'user' },
        }))
        return { delivered: true }
      } catch (error) {
        await notifyPolicy.restore(verdict.batch).catch(() => {})
        throw error
      }
    },
    now: () => Date.now(),
    tickSeconds: cfg.schedulerTickSeconds,
    humanPriority: cfg.schedulerHumanPriority,
    maxConsecutiveFailures: cfg.schedulerMaxConsecutiveFailures,
    maxActiveRuns: cfg.maxActiveRuns,
    warn: log,
  })
  if (typeof ctx.effect === 'function') ctx.effect(() => () => scheduler.stop(), 'dsh-superagent scheduler')
  else if (typeof ctx.on === 'function') ctx.on('dispose', () => scheduler.stop())

  const automationStore = createAutomationRuleStore({ file: path.join(store.root, 'automations.json') })
  const automationCwd = cfg.consoleRoot ? path.resolve(cfg.consoleRoot) : workbenchRoot

  function automationPlanMarker(rule) {
    return `auto:${createHash('sha256').update(rule.id).digest('hex').slice(0, 16)}`
  }

  async function findAutomationPlans(rule) {
    const marker = automationPlanMarker(rule)
    return (await scheduler.list()).filter(plan => plan.name.startsWith(`[${marker}]`))
  }

  async function findAutomationPlan(rule) {
    return (await findAutomationPlans(rule)).at(-1) ?? null
  }

  function assertAutomationSchedule(rule) {
    if (rule.enabled && rule.trigger.type === 'every' && rule.trigger.everyMs % 60_000 !== 0) {
      const error = new Error('the Host Scheduler has one-minute resolution; use an everyMs multiple of 60000')
      error.code = 'automation-schedule-unsupported'
      throw error
    }
  }

  async function syncAutomationSchedule(rule) {
    assertAutomationSchedule(rule)
    const prior = await findAutomationPlan(rule)
    if (rule.trigger.type === 'source' || !rule.enabled) {
      if (prior) await scheduler.pause(prior.id, `automation rule ${rule.id} disabled`)
      return prior?.id ?? null
    }
    const executionInput = buildAutomationExecutionInput({
      rule, now: prior?.createdAt ?? rule.createdAt ?? rule.updatedAt ?? 0, project: automationCwd,
    })
    const input = {
      name: `[${automationPlanMarker(rule)}] ${rule.name}`.slice(0, 80),
      goal: executionInput.prompt,
      mode: rule.action.type === 'run' ? 'direct' : 'planned',
      ...(rule.trigger.type === 'cron'
        ? { cron: rule.trigger.cron, timeZone: rule.trigger.timeZone }
        : { everyMinutes: Math.max(1, Math.ceil(rule.trigger.everyMs / 60_000)) }),
      budget: { maxModelCalls: rule.budget.maxModelCalls, maxTokens: rule.budget.maxTokens,
        maxTotalRuns: rule.budget.maxRuns, maxTotalModelCalls: rule.budget.maxModelCalls,
        maxTotalTokens: rule.budget.maxTokens },
      ownerSessionId: `automation:${rule.id}`,
      ownerRecovery: scheduleOwnerRecovery(),
      execution: { kind: rule.action.type === 'run' ? 'automation-run' : 'router', ruleId: rule.id },
      cwd: automationCwd,
    }
    const unchanged = prior && prior.goal === input.goal && prior.mode === input.mode
      && prior.schedule?.cron === (input.cron ?? null)
      && prior.schedule?.everyMinutes === (input.everyMinutes ?? null)
      && prior.schedule?.timeZone === (input.timeZone ?? 'UTC')
      && prior.budget?.maxModelCalls === (input.budget.maxModelCalls ?? null)
      && prior.budget?.maxTokens === (input.budget.maxTokens ?? null)
      && prior.budget?.maxTotalRuns === (input.budget.maxTotalRuns ?? null)
      && (prior.budget?.maxTotalModelCalls ?? null) === (input.budget.maxTotalModelCalls ?? null)
      && (prior.budget?.maxTotalTokens ?? null) === (input.budget.maxTotalTokens ?? null)
      && (prior.execution?.kind ?? null) === (input.execution?.kind ?? null)
      && (prior.execution?.ruleId ?? null) === (input.execution?.ruleId ?? null)
    if (unchanged) {
      if (!prior.enabled) await scheduler.resume(prior.id)
      return prior.id
    }
    if (prior) await scheduler.pause(prior.id, `automation rule ${rule.id} revised`)
    const plan = await scheduler.create(input)
    return plan.id
  }

  // A long-term goal is a thin layer above runs: each phase is a normal run.
  // The manager only owns the phase graph, the goal budget, and the decisions
  // that a phase cannot make by itself. Keeping it behind the orchestrator API
  // means it inherits every run-side guarantee (locks, persistence, resume).
  const longGoal = createLongGoalManager({
    root: store.root,
    resolveContext: (goal, phaseId) => readTaskDecisions(goal, phaseId),
    orchestrator: {
      start: args => orchestrator.start(args),
      status: runId => orchestrator.status(runId),
      resume: (runId, parent, clientTimeZone) => orchestrator.resume(runId, parent, clientTimeZone),
      cancel: runId => orchestrator.cancel(runId),
      followup: (runId, text, parent, options) => orchestrator.followup(runId, text, parent, options),
      answer: (runId, attentionId, answer, agent, clientTimeZone) =>
        orchestrator.answer(runId, attentionId, answer, agent, clientTimeZone),
    },
    async resolveOwner(goal) {
      const live = getAgents()?.get?.(goal.ownerSessionId)
      if (live && typeof live === 'object') return live
      if (goal.consoleOwned) {
        const resolved = await getSessionController()?.resolveAgent?.(goal.ownerSessionId)
        return resolved?.agent ?? null
      }
      return recoverScheduleOwner(goal, 'long-goal', { preferResolve: true })
    },
    async notify({ goal, message }) {
      if (goal.consoleOwned) return { delivered: false, reason: 'the console displays this goal' }
      let agent = getAgents()?.get?.(goal.ownerSessionId)
      if (!agent) {
        const recovered = await recoverScheduleOwner(goal, 'long-goal', { preferResolve: true })
        agent = recovered?.agent ?? recovered ?? null
      }
      if (!agent || typeof agent.followup !== 'function') {
        log(`long-goal ${goal.id} has no live session ${goal.ownerSessionId} to notify`)
        return { delivered: false }
      }
      if (!cfg.notifyOnComplete) return { delivered: false, reason: 'disabled: notifyOnComplete is false' }
      const preferences = await notificationPreferences.read()
      const notificationEvent = goal.status === 'completed' ? 'completed'
        : ['needs-decision', 'paused'].includes(goal.status) ? 'decision' : 'failed'
      const mode = preferences.events[notificationEvent]
      if (mode === 'off' || !preferences.channels.includes('push') || !['push', 'both'].includes(mode)
        || isQuietHours(goal.finishedAt ?? new Date(), preferences.quietHours, notificationEvent)) {
        return { delivered: false, reason: 'notification-preferences' }
      }
      const verdict = await notifyPolicy.reserve({ id: `long-goal:${goal.id}:${goal.status}`,
        status: notificationEvent === 'completed' ? 'completed' : 'failed' }, { maxPerHour: preferences.maxPushPerHour })
      if (!verdict.allowed) return { delivered: false, reason: verdict.reason }
      try {
        await outbox.enqueue(goal.ownerSessionId, () => agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: message }],
          source: { kind: 'user' },
        }))
        return { delivered: true }
      } catch (error) {
        await notifyPolicy.restore(verdict.batch).catch(() => {})
        throw error
      }
    },
    config: {
      phaseBudget: {
        maxModelCalls: cfg.maxModelCallsPerRun,
        maxTokens: cfg.maxTokensPerRun,
      },
    },
    log,
    now: () => Date.now(),
    tickSeconds: 5,
  })

  // Recovery runs once at mount; tools wait for it so a run left active by a
  // dead host reads as interrupted before the first tool call sees it. A
  // failure to initialize the state directory is kept and reported by every
  // tool: hiding it behind "no runs recorded" is how a broken stateDir looks
  // like an empty one.
  let stateError = null
  let hostDisposed = false
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
    // Schedules are off unless a plan file exists. Loading it here means a
    // restart does not wait for the first tool call, and the timer is armed
    // before the host reports itself ready.
    try {
      const loaded = await scheduler.init()
      if (loaded.plans > 0) {
        log(`scheduled runs: ${loaded.plans} plan(s) loaded; checking every ${cfg.schedulerTickSeconds}s`)
      }
      for (const rule of await automationStore.list()) {
        if (rule.trigger.type !== 'source') await syncAutomationSchedule(rule)
      }
    } catch (error) {
      log(`cannot load scheduled runs from ${scheduler.stateFile}: ${error?.message ?? error}`)
    }
    // Long goals survive the host on their own: init marks the phases that were
    // mid-run as resumable and the manager continues them on its next tick.
    try {
      const goals = await longGoal.init()
      const active = goals.filter(item => ['planning', 'running', 'paused'].includes(item.status)).length
      if (goals.length > 0) log(`long goals: ${goals.length} loaded, ${active} to continue`)
    } catch (error) {
      log(`cannot load long goals: ${error?.message ?? error}`)
    }
    if (hostDisposed) return
    try {
      await remoteJobStore.init()
      for (const job of await remoteJobStore.recover()) remoteJobs.set(job.workerId, job)
    } catch (error) {
      log(`cannot load remote Worker jobs: ${error?.message ?? error}`)
    }
    try {
      await briefScheduler.start()
    } catch (error) {
      log(`cannot start daily brief scheduler: ${error?.message ?? error}`)
    }
    if (!(cfg.keepRuns > 0) || typeof store.prune !== 'function') return
    try {
      const archiveDir = path.join(store.root, 'archives', `prune-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      const supportsArchive = /\barchiveDir\b/.test(Function.prototype.toString.call(store.prune))
      if (!supportsArchive && typeof store.planPrune === 'function' && typeof store.exportRun === 'function') {
        const plan = await store.planPrune({ olderThanDays: cfg.keepRuns })
        for (const candidate of plan.candidates ?? []) {
          await fsp.mkdir(archiveDir, { recursive: true })
          await store.exportRun(candidate.id, path.join(archiveDir, `${candidate.id}.zip`))
        }
      }
      const { removed } = await store.prune({ olderThanDays: cfg.keepRuns,
        ...(supportsArchive ? { archiveDir } : {}) })
      if (removed.length > 0) {
        log(`pruned ${removed.length} terminal run(s) older than ${cfg.keepRuns} day(s): ${removed.join(', ')}`)
      }
    } catch (error) {
      log(`cannot prune old runs: ${error?.message ?? error}`)
    }
  })()

  /**
   * One answer path for both `superagent_answer` and the console's attention
   * card. The page must not grow a second, subtly different way to decide a
   * question; it calls the same orchestrator method with the conversation agent
   * as the owner.
   */
  async function answerAttention({ runId, attentionId, answer }, agent, clientTimeZone) {
    await ready
    if (stateError) throw stateError
    return orchestrator.answer(runId, attentionId, answer, agent, clientTimeZone)
  }

  /** True when the host actually provides a subagent service. */
  function hasSubagents() {
    if (cfg.provider === 'remote') return true
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

  registerTool(defineTool({
    name: 'superagent_start',
    description:
      'Start an autonomous run: a planner splits the goal into subtasks, independent ones run in parallel, and their '
      + 'reports merge into one. Use it instead of the host subagent tool for goals with several deliverables or an '
      + 'ordered prerequisite. Returns a run id; poll with superagent_status or pass wait_seconds. '
      + 'mode "direct" runs one worker with no plan or merge.',
    properties: {
      goal: { type: 'string', description: 'The complete goal; be specific about the expected outcome.' },
      mode: {
        type: 'string',
        enum: ['planned', 'direct'],
        description: 'planned (default): plan, parallel workers, merged report. direct: one worker, reply as-is.',
      },
      requires: {
        type: 'array',
        description: 'direct mode: capabilities this task needs (shell, net.http, browser, gui, desktop, git, gh).',
        items: { type: 'string' },
      },
      queue: {
        type: 'boolean',
        description: 'Wait for a free slot when the concurrency cap is reached, instead of failing.',
      },
      goal_mode: {
        type: 'boolean',
        description: 'Check acceptance conditions and start another round with what is missing until they hold.',
      },
      acceptance: {
        type: 'array',
        description: 'Required with goal_mode: conditions that decide whether the goal is met.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id used in reports.' },
            text: { type: 'string', description: 'What must hold.' },
            check: {
              type: 'object',
              description: 'Machine check; omit to let an independent model judge it.',
              properties: {
                type: { type: 'string', enum: ['command', 'file'] },
                command: { type: 'string', description: 'Shell command; exit code is the verdict.' },
                cwd: { type: 'string', description: 'Working directory, relative to the goal workspace.' },
                timeout_seconds: { type: 'number', description: 'Command timeout (default 120, max 900).' },
                path: { type: 'string', description: 'File path, relative to the goal workspace.' },
                must_exist: { type: 'boolean', description: 'true (default) requires the file, false its absence.' },
              },
              required: ['type'],
            },
          },
          required: ['text'],
        },
      },
      max_rounds: { type: 'number', description: 'Goal mode: rounds before stopping (default 5, max 20).' },
      max_wall_clock_minutes: { type: 'number', description: 'Goal mode: wall-clock budget (default 60).' },
      no_progress_rounds: {
        type: 'number',
        description: 'Goal mode: identical failing rounds before stopping (default 2).',
      },
      budget: {
        type: 'object',
        description: 'Goal mode budget, inside the operator cap.',
        properties: {
          max_model_calls: { type: 'number' },
          max_tokens: { type: 'number' },
        },
      },
      max_subtasks: { type: 'number', description: `Planned subtasks cap (default ${DEFAULTS.maxSubtasks}, max 16).` },
      max_parallel: { type: 'number', description: `Subtasks at once (default ${DEFAULTS.maxParallel}, max 8).` },
      deadline_minutes: { type: 'number', description: `Wall-clock budget in minutes (default ${DEFAULTS.deadlineMinutes}).` },
      allow_duplicate: {
        type: 'boolean',
        description: 'Start a second run for the same goal; default returns the active run id instead.',
      },
      scheduled: {
        type: 'boolean',
        description: 'Scheduled delivery marker.',
      },
      reserve_slot: {
        type: 'boolean',
        description: 'Reserve one slot for manual runs.',
      },
      schedule_id: {
        type: 'string',
        description: 'Schedule identity.',
      },
      approve_policy: {
        type: 'boolean',
        description: 'Release a start the permission policy holds for confirmation; it cannot override a deny.',
      },
      wait_seconds: { type: 'number', description: 'Block up to this long for a terminal status (default 0).' },
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
        // The tool surface is snake_case; the orchestrator and the goal module
        // use camelCase, so the conversion happens once, in goalModeFromToolArgs.
        const goalMode = goalModeFromToolArgs(args)
        const ontologyContext = await repositoryContext(check.agent.session?.cwd ?? workbenchRoot, args.goal)
        const run = await orchestrator.start({
          goal: ontologyContext ? `${args.goal}\n\n${ontologyContext}` : args.goal,
          parentSessionId: check.agent.id,
          parent: check.agent,
          clientTimeZone: exec.clientTimeZone,
          allowDuplicate: args.allow_duplicate === true,
          origin: args.scheduled === true
            ? { kind: 'scheduled', scheduleId: String(args.schedule_id ?? 'host').slice(0, 200) }
            : null,
          reserveSlot: args.reserve_slot === true,
          mode: args.mode,
          requires: args.requires,
          goalMode,
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

  registerTool(defineTool({
    name: 'superagent_goal',
    description:
      'Run a long-term goal as ordered phases: each phase is its own run with planner and parallel workers, and later '
      + 'phases receive earlier reports. A phase that keeps failing opens a decision a person answers with action '
      + '"answer"; a phase nothing later depends on is skipped instead, the goal ends partial, and '
      + 'action="retry_phase" redoes just that phase. Use it over superagent_start when milestones must happen in order '
      + 'over a long horizon.',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'status', 'list', 'answer', 'resume', 'pause', 'cancel', 'retry_phase'],
        description: 'create, read one, list, answer an open decision, retry one skipped/failed phase, resume/pause/cancel.',
      },
      goal_id: { type: 'string', description: 'From action=create; required except for create/list.' },
      goal: {
        type: 'string',
        description: 'create: the complete long-term outcome, concrete about the finished state.',
      },
      phases: {
        type: 'array',
        description: 'create: explicit phases; omit to let the phase planner split the goal.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id, e.g. "p1"; referenced by depends_on.' },
            title: { type: 'string', description: 'Short name shown in the phase table.' },
            objective: { type: 'string', description: 'What this phase must produce.' },
            depends_on: {
              type: 'array',
              items: { type: 'string' },
              description: 'Phase ids that must complete first; omit for independent phases.',
            },
            acceptance: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  check: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['command', 'file'] },
                      command: { type: 'string' },
                      cwd: { type: 'string' },
                      timeout_seconds: { type: 'number' },
                      path: { type: 'string' },
                      must_exist: { type: 'boolean' },
                    },
                    required: ['type'],
                  },
                },
                required: ['text'],
              },
            },
            max_rounds: { type: 'number', description: 'Retries before the phase stops (default 3).' },
            max_wall_clock_minutes: { type: 'number', description: 'Wall-clock cap (default 120).' },
            deliverables: { type: 'array', items: { type: 'string' }, description: 'Paths to report.' },
          },
          required: ['objective'],
        },
      },
      cwd: { type: 'string', description: 'Workspace for every phase and machine check (default cwd).' },
      max_parallel_phases: { type: 'number', description: 'Phases in flight at once (default 2, max 8).' },
      max_attempts_per_phase: {
        type: 'number',
        description: 'Attempts per phase before asking a person (default 2).',
      },
      max_rounds_per_phase: { type: 'number', description: 'Default goal-mode rounds per phase (default 3).' },
      no_progress_rounds: { type: 'number', description: 'Identical failing rounds before a phase stops (default 2).' },
      phase_budget: {
        type: 'object',
        description: 'Per-phase hard cap, inside what remains of the goal budget.',
        properties: {
          max_model_calls: { type: 'number' },
          max_tokens: { type: 'number' },
        },
      },
      budget: {
        type: 'object',
        description: 'Whole-goal hard cap; reaching it stops the goal.',
        properties: {
          max_model_calls: { type: 'number' },
          max_tokens: { type: 'number' },
        },
      },
      max_wall_clock_minutes: { type: 'number', description: 'Whole-goal wall-clock cap (default 1440).' },
      stall_after_minutes: {
        type: 'number',
        description: 'No completed phase for this long opens a stall decision (default 180).',
      },
      auto_resume: {
        type: 'boolean',
        description: 'Continue after a host restart (default true); false leaves it paused.',
      },
      decision_id: { type: 'string', description: 'answer: id shown in action=status.' },
      phase_id: { type: 'string', description: 'retry_phase: phase id shown in action=status.' },
      answer: {
        type: 'string',
        description: 'answer: retry, skip, stop, continue, or answer (worker question, needs note).',
      },
      note: {
        type: 'string',
        description: 'answer: new instruction for retry, or the text for a worker question.',
      },
      limit: { type: 'number', description: 'list: maximum rows (default 20).' },
    },
    required: ['action'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        const action = String(args.action ?? '').trim().toLowerCase()
        if (action === 'create') {
          const phases = Array.isArray(args.phases)
            ? args.phases.map(entry => ({
                id: entry?.id,
                title: entry?.title,
                objective: entry?.objective,
                dependsOn: entry?.depends_on ?? entry?.dependsOn,
                acceptance: Array.isArray(entry?.acceptance)
                  ? entry.acceptance.map(acceptanceFromToolArgs)
                  : entry?.acceptance,
                maxRounds: entry?.max_rounds ?? entry?.maxRounds,
                maxWallClockMinutes: entry?.max_wall_clock_minutes ?? entry?.maxWallClockMinutes,
                deliverables: entry?.deliverables,
              }))
            : undefined
          const goalWorkspace = args.cwd ?? check.agent.session?.cwd
          const ontologyContext = await repositoryContext(goalWorkspace, args.goal)
          const created = await longGoal.create({
            goal: ontologyContext ? `${args.goal}\n\n${ontologyContext}` : args.goal,
            phases,
            cwd: goalWorkspace,
            maxParallelPhases: args.max_parallel_phases,
            maxAttemptsPerPhase: args.max_attempts_per_phase,
            maxRoundsPerPhase: args.max_rounds_per_phase,
            noProgressRounds: args.no_progress_rounds,
            phaseBudget: args.phase_budget
              ? {
                  maxModelCalls: args.phase_budget.max_model_calls,
                  maxTokens: args.phase_budget.max_tokens,
                }
              : undefined,
            budget: args.budget
              ? { maxModelCalls: args.budget.max_model_calls, maxTokens: args.budget.max_tokens }
              : undefined,
            maxWallClockMinutes: args.max_wall_clock_minutes,
            stallAfterMinutes: args.stall_after_minutes,
            autoResume: args.auto_resume,
            parentSessionId: check.agent.id,
          })
          const { goal, runs } = await longGoal.status(created.id)
          return `${formatLongGoal(goal, runs)}\n\nCreated in the background. Poll with `
            + `superagent_goal action=status goal_id=${goal.id}; phase runs continue after this call.`
        }
        if (action === 'list') {
          const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
          const goals = (await longGoal.list()).slice(0, limit)
          if (goals.length === 0) return 'No long-term goals recorded.'
          return goals.map(goal => {
            const phases = goal.phases ?? []
            const done = phases.filter(phase => phase.status === 'completed').length
            return `- ${goal.id} [${goal.status}] ${done}/${phases.length} phases — ${String(goal.goal).slice(0, 120)}`
          }).join('\n')
        }
        const goalId = String(args.goal_id ?? '').trim()
        if (!goalId) return describeError(`action=${action} requires goal_id`)
        if (action === 'status') {
          const { goal, runs } = await longGoal.status(goalId)
          return formatLongGoal(goal, runs)
        }
        if (action === 'answer') {
          const goal = await longGoal.answer(
            goalId,
            String(args.decision_id ?? '').trim(),
            args.answer,
            { note: args.note, parent: check.agent, clientTimeZone: exec.clientTimeZone },
          )
          const { goal: fresh, runs } = await longGoal.status(goal.id)
          return formatLongGoal(fresh, runs)
        }
        if (action === 'retry_phase') {
          const phaseId = String(args.phase_id ?? '').trim()
          if (!phaseId) return describeError('action=retry_phase requires phase_id')
          await longGoal.retryPhase(goalId, phaseId)
        } else if (action === 'resume') {
          await longGoal.resume(goalId)
        } else if (action === 'pause') {
          await longGoal.pause(goalId)
        } else if (action === 'cancel') {
          await longGoal.cancel(goalId)
        } else {
          return describeError(`unknown action ${JSON.stringify(action)}`)
        }
        const { goal, runs } = await longGoal.status(goalId)
        return formatLongGoal(goal, runs)
      } catch (error) {
        return describeError(error)
      }
    },
  }), EXTRA_TOOLS)

  // Files on disk can be newer than the code this host loaded: a package update
  // only takes effect after DSH restarts. Surface the mismatch instead of
  // letting the user wonder why the new version behaves like the old one.
  async function restartNotice() {
    try {
      const onDisk = JSON.parse(await fsp.readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
      if (onDisk.version && onDisk.version !== pkg.version) {
        return `\n\nnote: package files on disk are ${onDisk.version} but this host is still running `
          + `${pkg.version} — restart DSH to load the new version.`
      }
    } catch {
      // Best effort: a status read must not fail because of this check.
    }
    return ''
  }

  registerTool(defineTool({
    name: 'superagent_status',
    description:
      'Read one run: status, subtask outcomes, measured token usage, and the final report. wait_seconds blocks for a '
      + 'terminal state.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by superagent_start.' },
      wait_seconds: { type: 'number', description: 'Block up to this long for a terminal state (default 0).' },
    },
    required: ['run_id'],
    async execute(args = {}) {
      try {
        await ready
        if (stateError) return describeError(stateError)
        const run = await orchestrator.status(String(args.run_id ?? '').trim(), Number(args.wait_seconds) || 0)
        await recordSpend([run])
        return `${formatRun(run)}${await restartNotice()}`
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  registerTool(defineTool({
    name: 'superagent_list',
    description: 'List runs and progress, newest first.',
    properties: {
      limit: { type: 'number', description: 'Maximum rows (default 20).' },
      query: { type: 'string', description: 'Search visible tasks and deliverables.' },
    },
    async execute(args = {}, exec) {
      try {
        await ready
        if (stateError) return describeError(stateError)
        const runs = await orchestrator.list()
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
        if (isPanelSession(exec?.agent)) {
          const query = typeof args.query === 'string' ? args.query.trim().slice(0, 160) : ''
          if (query && searchWorkbenchHistory) return await searchWorkbenchHistory(exec.agent.id, query, Math.min(limit, 8))
          return formatList(runs.filter(run => run.parentSessionId === exec.agent.id && run.origin?.role !== 'decompose'), limit)
        }
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
        return formatList(runs, limit, extra)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  // Every declaration is paid for on every request, so the capabilities most
  // sessions never touch are registered behind a per-session activation
  // condition: `superagent_help` names them and turns them on for that session.
  registerTool(defineTool({
    name: 'superagent_help',
    description:
      'Show the extra superagent tools and when each applies: long-term goals, cron schedules, live steering, '
      + 'cross-run memory, repository ontology, workflow templates, audit export. Call this before using any of them.',
    properties: {},
    async execute(_args, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      const id = sessionKey(check.agent)
      if (id) {
        if (expandedSessions.size >= 2000) expandedSessions.clear()
        expandedSessions.add(id)
      }
      return [
        '已展开，下一步起可用（参数见各自 schema）：',
        '- superagent_goal: 长期目标按阶段推进，多里程碑或必须按序时用；action=create/status/list/answer/retry_phase/resume/pause/cancel',
        '- superagent_schedule: 定时或按间隔自动起 run；action=create/list/migrate/pause/resume/delete/run-now。'
          + '宿主会话能调 schedule_create 时，create 只返回要转交的参数，必须自己调 schedule_create 建到宿主定时任务里；'
          + '插件本地定时只作兜底',
        '- superagent_inject: 给正在跑的 worker 立刻发指令；不着急就用 superagent_followup',
        '- superagent_memory: 跨 run 笔记；action=list/search/set/forget，layer="user" 读写用户级事实',
        '- superagent_repo_wiki: 仓库 ontology 与知识卡；action=generate/status/list/read/query/link/unlink，默认使用当前工作区',
        '- superagent_template: 工作流模板；action=list/show/expand/save/delete，expand 出 goal 再 start',
        '- superagent_audit: 查询或导出审计流水（tool.call、path.write、blocked、审批等）',
        '不确定就先 action=list 或 superagent_status 看现状。',
      ].join('\n')
    },
  }))

  registerTool(defineTool({
    name: 'superagent_repo_wiki',
    description: 'Repository ontology: modules, architecture, stack, conventions, setup, dependencies and sources.',
    properties: {
      action: { type: 'string', enum: ['generate', 'status', 'list', 'read', 'query', 'link', 'unlink'] },
      project_path: { type: 'string' },
      path: { type: 'string' },
      query: { type: 'string' },
      source_path: { type: 'string' },
      target_path: { type: 'string' },
      kind: { type: 'string', enum: ['depends_on', 'related_to'] },
      reason: { type: 'string' },
    },
    required: ['action'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      if (!cfg.repoWiki.enabled) return '仓库知识层未启用。'
      const projectPath = String(args.project_path ?? check.agent.session?.cwd ?? consoleRoot ?? '').trim()
      if (!projectPath) return '请提供 project_path，或先在会话中选择工作区。'
      try {
        const options = { language: args.language === 'en' ? 'en' : 'zh' }
        let result
        if (args.action === 'generate') {
          const snapshot = await repoWiki.generate(projectPath, { force: args.force === true })
          result = { action: 'generate', projectPath: snapshot.projectPath, title: snapshot.title,
            generatedAt: snapshot.generatedAt, stats: snapshot.stats, baseline: snapshot.baseline }
        } else if (args.action === 'status') {
          result = await repoWiki.status(projectPath)
        } else if (args.action === 'list') {
          result = await repoWiki.list(projectPath, { ...options, path: args.path ?? '/' })
        } else if (args.action === 'read') {
          result = await repoWiki.read(projectPath, { ...options, path: args.path })
        } else if (args.action === 'query') {
          result = await repoWiki.query(projectPath, { ...options, query: args.query ?? '', limit: args.limit ?? 8 })
        } else if (args.action === 'link') {
          result = await repoWiki.link(projectPath, { sourcePath: args.source_path, targetPath: args.target_path,
            kind: args.kind, reason: args.reason, explanation: args.explanation })
        } else if (args.action === 'unlink') {
          result = await repoWiki.unlink(projectPath, { sourcePath: args.source_path, targetPath: args.target_path,
            kind: args.kind })
        } else {
          return `不支持的仓库知识操作：${String(args.action)}`
        }
        return JSON.stringify(result, null, 2)
      } catch (error) {
        return describeError(error)
      }
    },
  }))

  registerTool(defineTool({
    name: 'superagent_cancel',
    description:
      'Cancel a run: stops its subtasks and marks it cancelled; the state file stays inspectable.',
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

  registerTool(defineTool({
    name: 'superagent_resume',
    description:
      'Resume an interrupted, timed-out, or failed run: completed subtasks are kept, pending and failed ones run '
      + 'again.',
    properties: {
      run_id: { type: 'string', description: 'Run id to resume.' },
      wait_seconds: { type: 'number', description: 'Block up to this long for a terminal state (default 0).' },
      force: {
        type: 'boolean',
        description: 'Ignored; kept so older callers still validate.',
      },
      approve_policy: {
        type: 'boolean',
        description: 'Release a resume the permission policy holds for confirmation.',
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

  registerTool(defineTool({
    name: 'superagent_followup',
    description:
      'Add an instruction to a run that is already executing instead of starting a second one. It is queued and '
      + 'carried by the next prompt built for the run; children already running are not interrupted.',
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

  registerTool(defineTool({
    name: 'superagent_inject',
    description:
      'Deliver an instruction into the workers running right now: it becomes part of each child\'s next model request, '
      + 'at its next step boundary. Use superagent_followup when no worker is running.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by superagent_start.' },
      message: { type: 'string', description: 'The instruction the running workers should read next.' },
      subtask_index: {
        type: 'number',
        description: 'One worker, by its index from superagent_status; omit to reach every running worker.',
      },
      wait_seconds: {
        type: 'number',
        description: 'Block up to this long for the children to claim it, so the delay can be measured (default 0).',
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

  registerTool(defineTool({
    name: 'superagent_answer',
    description:
      'Answer the question a run asked (the qN item in superagent_status), so that run continues instead of a new one '
      + 'starting. An active run applies it at its next boundary; a finished run is reopened for aggregation.',
    properties: {
      run_id: { type: 'string', description: 'Run id returned by superagent_start.' },
      attention_id: {
        type: 'string',
        description: 'Question id from superagent_status, e.g. q1; required when several are open.',
      },
      answer: { type: 'string', description: 'The decision; a listed option or free text.' },
      wait_seconds: { type: 'number', description: 'Block up to this long for the run to settle (default 0).' },
    },
    required: ['run_id', 'answer'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        const result = await answerAttention({
          runId: String(args.run_id ?? '').trim(),
          attentionId: args.attention_id,
          answer: args.answer,
        }, check.agent, exec.clientTimeZone)
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

  registerTool(defineTool({
    name: 'superagent_memory',
    description:
      'Read or correct the cross-run notebook: short notes earlier runs left for the next one, or (layer="user") '
      + 'durable facts, preferences, and decisions.',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search', 'set', 'forget'],
        description: 'List notes, search by keyword or tag, set one, or forget one.',
      },
      layer: {
        type: 'string',
        enum: ['run', 'user'],
        description: 'run (default): task notebook. user: cross-task profile.',
      },
      category: {
        type: 'string',
        enum: [...USER_MEMORY_CATEGORIES],
        description: 'User layer only: fact, preference, or decision.',
      },
      key: { type: 'string', description: 'Short topic key; a new note with the same key replaces it.' },
      kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'decision, pitfall, next, dispatch, or note.' },
      text: { type: 'string', description: 'The durable fact to record.' },
      choice: { type: 'string', description: 'User decision: what was chosen.' },
      rejected: { type: 'string', description: 'User decision: the alternative given up.' },
      reason: { type: 'string', description: 'User decision: why.' },
      rollback: { type: 'string', description: 'User decision: how to undo it.' },
      query: {
        type: 'string',
        description: 'Search: keywords to rank notes by.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Match exactly (search) or attach (set).',
      },
      scope: {
        type: 'string',
        description: 'Notebook scope: "rules", "profile", or the run scope (default).',
      },
      run_id: {
        type: 'string',
        description: 'User layer forget: delete every record from this run.',
      },
      before: {
        type: 'string',
        description: 'User layer forget: delete records at or before this date.',
      },
      after: {
        type: 'string',
        description: 'User layer forget: delete records at or after this date.',
      },
      limit: { type: 'number', description: 'Maximum notes (default 20).' },
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
        const layer = String(args.layer ?? 'run').trim().toLowerCase()
        if (layer !== 'run' && layer !== 'user') {
          return describeError(`unknown layer "${args.layer}"; use "run" or "user"`)
        }
        if (layer === 'user') {
          if (!userMemory) {
            return describeError(
              'user-level memory is off; set memoryUserProfile: true in the plugin config and restart',
            )
          }
          const category = args.category === undefined || args.category === null || args.category === ''
            ? null
            : String(args.category).trim().toLowerCase()
          if (category && !USER_MEMORY_CATEGORIES.includes(category)) {
            return describeError(`category must be one of ${USER_MEMORY_CATEGORIES.join(', ')}`)
          }
          const limit = Math.max(1, Math.min(30, Number(args.limit) || 20))
          const tags = Array.isArray(args.tags) ? args.tags : []
          if (action === 'list') {
            const rows = []
            let total = 0
            for (const name of category ? [category] : USER_MEMORY_CATEGORIES) {
              const result = await userMemory.list({ category: name, limit })
              total += result.total
              rows.push(...result.entries.map(userRecordLine))
            }
            if (total === 0) return `no user-level record recorded yet (${path.join(store.root, 'user-memory')})`
            return `${total} user-level record(s)\n\n${rows.join('\n')}`
          }
          if (action === 'search') {
            const query = String(args.query ?? '').trim()
            if (!query && tags.length === 0) {
              return describeError('search needs a query, tags, or both; call action="list" to read everything')
            }
            const rows = []
            let matched = 0
            let total = 0
            for (const name of category ? [category] : USER_MEMORY_CATEGORIES) {
              const result = await userMemory.recall({ category: name, query, tags, maxEntries: limit })
              total += result.total
              matched += result.matched
              rows.push(...result.entries.map(userRecordLine))
            }
            if (matched === 0) return `no user-level record matches ${query ? `“${query}”` : 'those tags'} (${total} recorded)`
            return `${matched} of ${total} user-level record(s) match, best first\n\n${rows.join('\n')}`
          }
          if (action === 'forget') {
            const result = await userMemory.forget({
              key: args.key,
              runId: args.run_id,
              before: args.before,
              after: args.after,
              category,
            })
            if (result.reason) return describeError(result.reason)
            if (result.deleted === 0) return 'no user-level record matched those filters'
            return `deleted ${result.deleted} user-level record(s) from ${result.categories.join(', ')}; `
              + 'they are gone from the files, not retracted'
          }
          if (action === 'set') {
            if (!category) return describeError('user set needs category: fact, preference, or decision')
            if (category === 'decision' && (!String(args.choice ?? '').trim() || !String(args.reason ?? '').trim())) {
              return describeError('a user decision needs both choice and reason')
            }
            if (category !== 'decision' && !String(args.text ?? '').trim()) {
              return describeError(`set needs text for a user ${category}`)
            }
            const entry = category === 'decision'
              ? { key: args.key, choice: args.choice, rejected: args.rejected, reason: args.reason, rollback: args.rollback, tags }
              : { key: args.key, text: args.text, tags }
            const result = await userMemory.record({ category, entry })
            return result.written > 0
              ? `recorded user ${category}; later unrelated tasks will see it`
              : describeError(result.reason ?? 'cannot record that user-level entry')
          }
          return describeError(`unknown action "${args.action}"; use list, search, set, or forget`)
        }
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
  }), EXTRA_TOOLS)

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

  registerTool(defineTool({
    name: 'superagent_template',
    description:
      'List, show, expand, save, or delete a workflow template: a fixed goal skeleton with required parameters. '
      + 'expand returns one goal string for superagent_start; a template never sets limits, budgets, or overrides.',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'show', 'expand', 'save', 'delete'],
        description: 'List, show one, expand into a goal, save a custom one, or delete a custom one.',
      },
      id: { type: 'string', description: 'Template id from action="list"; built-in ids are read-only.' },
      params: {
        type: 'object',
        description: 'expand: a value for every declared parameter; missing ones are refused, not defaulted.',
        additionalProperties: { type: 'string' },
      },
      template: {
        type: 'object',
        description: 'save: id, title, whenToUse, whenNotToUse, variables [{name, description}], '
          + 'skeleton with {{name}} placeholders.',
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
  }), EXTRA_TOOLS)

  registerTool(defineTool({
    name: 'superagent_schedule',
    description:
      'Create and manage scheduled runs. Actions: create, list, migrate, pause, resume, delete, run-now. '
      + 'The Host Scheduler is preferred when available; incompatible plans stay local. Cron is 5 fields.',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'migrate', 'pause', 'resume', 'delete', 'run-now'],
        description: 'create, list, migrate local plans to the Host Scheduler, pause/resume, delete, or start one run now.',
      },
      id: { type: 'string', description: 'Schedule id (sch-...); required for pause, resume, delete, run-now.' },
      name: { type: 'string', description: 'create: short name used in list and notifications.' },
      goal: {
        type: 'string',
        description: 'create: the complete goal the scheduled run starts. Give goal or template_id, not both.',
      },
      template_id: {
        type: 'string',
        description: 'create: expand this template into the goal at create time.',
      },
      params: {
        type: 'object',
        description: 'create with template_id: values for the placeholders.',
        additionalProperties: { type: 'string' },
      },
      cron: {
        type: 'string',
        description: 'create: 5-field cron (minute hour day month weekday) in timezone, e.g. "0 9 * * MON-FRI". '
          + 'Give cron or every_minutes, not both.',
      },
      every_minutes: {
        type: 'number',
        description: 'create: fixed interval instead of cron; first run one interval from now.',
      },
      timezone: {
        type: 'string',
        description: 'create: IANA zone the cron is written in (default UTC), e.g. "Asia/Shanghai".',
      },
      miss_policy: {
        type: 'string',
        enum: ['latest', 'none'],
        description: 'create: after downtime, latest (default) runs the newest missed window; none skips them.',
      },
      mode: {
        type: 'string',
        enum: ['planned', 'direct'],
        description: 'create: run mode per execution, as in superagent_start.',
      },
      goal_mode: {
        type: 'boolean',
        description: 'create: run each execution in goal mode with acceptance checking.',
      },
      acceptance: {
        type: 'array',
        description: 'create with goal_mode: conditions, same shape as superagent_start.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            check: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['command', 'file'] },
                command: { type: 'string' },
                cwd: { type: 'string' },
                timeout_seconds: { type: 'number' },
                path: { type: 'string' },
                must_exist: { type: 'boolean' },
              },
              required: ['type'],
            },
          },
          required: ['text'],
        },
      },
      max_rounds: { type: 'number', description: 'create with goal_mode: rounds per execution (default 5, max 20).' },
      max_wall_clock_minutes: { type: 'number', description: 'create with goal_mode: wall-clock budget per execution.' },
      no_progress_rounds: { type: 'number', description: 'create with goal_mode: no-progress rounds before stopping.' },
      budget: {
        type: 'object',
        description: 'create: per-execution caps (max_model_calls, max_tokens) and whole-plan caps '
          + '(max_total_model_calls, max_total_tokens, max_total_runs).',
        properties: {
          max_model_calls: { type: 'number' },
          max_tokens: { type: 'number' },
          max_total_model_calls: { type: 'number' },
          max_total_tokens: { type: 'number' },
          max_total_runs: { type: 'number' },
        },
      },
      human_priority: {
        type: 'boolean',
        description: 'create: when true (default), a scheduled run cannot take the last slot a manual start needs.',
      },
      session_id: {
        type: 'string',
        description: 'create: session that owns the runs and receives notifications (default: this session).',
      },
    },
    required: ['action'],
    async execute(args = {}, exec) {
      const check = requireAgent(exec)
      if (check.error) return check.error
      try {
        await ready
        if (stateError) return describeError(stateError)
        const action = String(args.action ?? '').trim().toLowerCase()
        if (action === 'create') {
          let goal = typeof args.goal === 'string' ? args.goal.trim() : ''
          const templateId = String(args.template_id ?? '').trim()
          if (templateId) {
            if (goal) return describeError('create takes goal or template_id, not both; remove one')
            const template = await templates.get(templateId)
            if (!template) {
              return describeError(`no workflow template with id "${templateId}"; call superagent_template action="list"`)
            }
            goal = expandTemplate(template, args.params).goal
          }
          const budget = args.budget && typeof args.budget === 'object'
            ? {
                maxModelCalls: args.budget.max_model_calls,
                maxTokens: args.budget.max_tokens,
                maxTotalModelCalls: args.budget.max_total_model_calls,
                maxTotalTokens: args.budget.max_total_tokens,
                maxTotalRuns: args.budget.max_total_runs,
              }
            : null
          const recovery = scheduleOwnerRecovery()
          // Validate the timing before choosing an owner for the timer: a bad
          // cron must fail the same way whether the host or the plugin runs it.
          let draft
          try {
            draft = normalizeScheduleInput({
              name: args.name,
              goal,
              mode: args.mode,
              cron: args.cron,
              everyMinutes: args.every_minutes,
              timeZone: args.timezone,
              missPolicy: args.miss_policy,
              goalMode: goalModeFromToolArgs(args, { budget: false }),
              budget,
              humanPriority: args.human_priority,
              ownerSessionId: String(args.session_id ?? check.agent.id).trim(),
              ownerRecovery: recovery,
              cwd: check.agent.session?.cwd ?? workbenchRoot,
            }, { now: () => Date.now() })
          } catch (error) {
            return describeError(error)
          }
          const hostPayload = schedulePayloadFor(draft, check.agent.id)
          if (cfg.scheduleProvider !== 'local' && hostSchedule.available()
            && (check.agent.session?.header?.delegationDepth ?? 0) === 0 && hostPayload.payload) {
            const created = await hostSchedule.createFromPlan(draft, check.agent.id)
            return `created Host Schedule task ${created.id} ("${draft.name}"). It delivers to this session; `
              + 'no plugin-local timer was armed.'
          }
          const hostTool = cfg.scheduleProvider === 'local' ? null : hostScheduleToolFor(check.agent)
          const handoff = hostTool ? schedulePayloadFor(draft, check.agent.id) : null
          if (handoff?.payload) {
            return scheduleHandoffText({ payload: handoff.payload, toolName: hostTool })
          }
          const fallbackReason = handoff
            ? `${handoff.reason}, so the plan stays local`
            : (check.agent.session?.header?.delegationDepth ?? 0) > 0
              ? `a delegated subagent cannot call ${HOST_SCHEDULE_TOOL}, so the plan stays local`
              : `this session cannot call ${HOST_SCHEDULE_TOOL} (the host preset does not mount dsh-tool-schedule), so the plan stays local`
          const plan = await scheduler.create({
            name: args.name,
            goal,
            mode: args.mode,
            cron: args.cron,
            everyMinutes: args.every_minutes,
            timeZone: args.timezone,
            missPolicy: args.miss_policy,
            goalMode: goalModeFromToolArgs(args, { budget: false }),
            budget,
            humanPriority: args.human_priority,
            ownerSessionId: String(args.session_id ?? check.agent.id).trim(),
            ownerRecovery: recovery,
            cwd: check.agent.session?.cwd ?? workbenchRoot,
            fallbackReason,
          })
          const warning = recovery === 'none'
            ? '\n\nwarning: this host has no Host Session API, so it cannot reopen the owning session after a '
              + 'restart. The plan is marked as requiring a resident session; it will not silently pause, but it '
              + 'will not run while that session is closed.'
            : ''
          return `created schedule ${plan.id}. The plugin-local timer is armed from now on; no further tool call is needed.\n\n`
            + formatSchedule(plan) + warning + `\n\nThe timer checks every ${cfg.schedulerTickSeconds}s while the host is running.`
        }
        if (action === 'list') {
          const plans = await scheduler.list()
          const snapshot = await orchestrator.activeSnapshot()
          const quota = `quota: ${snapshot.active}/${snapshot.maxActiveRuns} active `
            + `(${snapshot.manualActive} manual, ${snapshot.scheduledActive} scheduled); `
            + `${snapshot.waiting} waiting (${snapshot.manualWaiting} manual)`
          const hostLines = []
          if (cfg.scheduleProvider !== 'local' && hostSchedule.available()) {
            const hostTasks = await hostSchedule.list()
            hostLines.push('Host Scheduler:')
            hostLines.push(...(hostTasks.length > 0
              ? hostTasks.map(task => `${task.id}  ${String(task.status).padEnd(8)}  ${task.title}  ${task.timing.kind}`)
              : ['no host scheduled tasks']))
          }
          return `${[...hostLines, formatScheduleList(plans)].filter(Boolean).join('\n')}\n${quota}`
        }
        if (action === 'migrate') {
          if (cfg.scheduleProvider !== 'local' && hostSchedule.available()
            && (check.agent.session?.header?.delegationDepth ?? 0) === 0) {
            const plans = await scheduler.list()
            const migrated = []
            const skipped = []
            for (const plan of plans) {
              const compatibility = schedulePayloadFor(plan, check.agent.id)
              if (!compatibility.payload) {
                skipped.push(`${plan.id} ("${plan.name}"): ${compatibility.reason}`)
                continue
              }
              try {
                const wasEnabled = plan.enabled
                if (wasEnabled) await scheduler.pause(plan.id, 'migrating to the Host Scheduler')
                const created = await hostSchedule.createFromPlan(plan, check.agent.id)
                migrated.push({ pluginId: plan.id, hostId: created.id })
              } catch (error) {
                if (plan.enabled) await scheduler.resume(plan.id).catch(resumeError => {
                  skipped.push(`${plan.id} ("${plan.name}"): local rollback also failed: ${resumeError?.message ?? resumeError}`)
                })
                skipped.push(`${plan.id} ("${plan.name}"): ${error?.message ?? error}`)
              }
            }
            return [
              `migration: ${migrated.length} plan(s) now exist in the Host Scheduler and are paused locally.`,
              JSON.stringify(migrated, null, 2),
              ...(skipped.length > 0 ? ['these plans stay local:', ...skipped.map(line => `- ${line}`)] : []),
            ].join('\n')
          }
          if (!hostScheduleToolFor(check.agent)) return 'this session cannot call schedule_create; all plans stay local'
          const plans = await scheduler.list()
          if (plans.length === 0) {
            return 'no plugin-local plans to migrate; every new plan on this host is created through schedule_create already'
          }
          const migrated = []
          const skipped = []
          for (const plan of plans) {
            const { payload, reason } = schedulePayloadFor(plan, check.agent.id)
            if (!payload) {
              skipped.push(`${plan.id} ("${plan.name}"): ${reason}`)
              continue
            }
            if (plan.enabled) await scheduler.pause(plan.id, 'migrating to a Host scheduled task')
            migrated.push({ pluginId: plan.id, arguments: payload })
          }
          const lines = [
            `migration: ${migrated.length} plan(s) are paused and ready to move to the Host Scheduler.`,
            'For each one, call schedule_create with the arguments below, then call superagent_schedule '
              + 'action="delete" with the pluginId once the host task exists. A paused local plan cannot double-fire '
              + 'while the host task is being created; action="resume" undoes the pause if the migration is abandoned.',
            JSON.stringify(migrated, null, 2),
          ]
          if (skipped.length > 0) {
            lines.push('these plans stay local because the Host Scheduler cannot preserve their settings:')
            lines.push(...skipped.map(line => `- ${line}`))
          }
          return lines.join('\n')
        }
        if (action === 'pause') {
          const id = String(args.id ?? '')
          if (cfg.scheduleProvider !== 'local' && hostSchedule.available() && !id.startsWith('sch-')) {
            const task = await hostSchedule.pause(id)
            return `paused Host Schedule task ${task.id}.`
          }
          const plan = await scheduler.pause(id, 'paused by superagent_schedule')
          return `paused ${plan.id} ("${plan.name}"). It will not start again until action="resume".`
        }
        if (action === 'resume') {
          const id = String(args.id ?? '')
          if (cfg.scheduleProvider !== 'local' && hostSchedule.available() && !id.startsWith('sch-')) {
            const task = await hostSchedule.resume(id)
            return `resumed Host Schedule task ${task.id}.`
          }
          const plan = await scheduler.resume(id)
          return `resumed ${plan.id} ("${plan.name}"); next run ${plan.nextRunAt}. Past windows are not replayed.`
        }
        if (action === 'delete') {
          const id = String(args.id ?? '')
          if (cfg.scheduleProvider !== 'local' && hostSchedule.available() && !id.startsWith('sch-')) {
            const task = await hostSchedule.remove(id)
            return `deleted Host Schedule task ${task.id}. Runs it already started keep their records.`
          }
          const removed = await scheduler.remove(id)
          return `deleted ${removed.id} ("${removed.name}"). Runs it already started keep their records.`
        }
        if (action === 'run-now') {
          const id = String(args.id ?? '')
          if (cfg.scheduleProvider !== 'local' && hostSchedule.available() && !id.startsWith('sch-')) {
            const task = await hostSchedule.runNow(id)
            return `asked Host Schedule task ${task.id} to run now; its delivery appears in the target session.`
          }
          const { plan, run } = await scheduler.runNow(id)
          return `started ${run.id} now for schedule ${plan.id} ("${plan.name}"); its next planned window is `
            + `${plan.nextRunAt}. Poll the run with superagent_status.`
        }
        return describeError(`unknown action "${args.action}"; use create, list, migrate, pause, resume, delete, or run-now`)
      } catch (error) {
        if (error instanceof TemplateError) return templateProblem(error)
        return describeError(error)
      }
    },
  }), EXTRA_TOOLS)

  // The embedding surface is opt-in: mounting the plugin must not open a port
  // unasked. When it is on, every request goes through the same orchestrator as
  // the tools, so quota, budgets, ownership, and cancel behave identically.
  if (auditor) {
    registerTool(defineTool({
      name: 'superagent_audit',
      description:
        'Query the append-only audit trail (tool calls, path writes, commands, blocks, approvals, decisions, run '
        + 'lifecycle) for one run or a time window, or export the matching events as JSONL or CSV.',
      properties: {
        run_id: { type: 'string', description: 'Only events for this run id.' },
        subtask_id: { type: 'string', description: 'Only events for one subtask, e.g. "subtask-2" or "aggregator".' },
        kind: { type: 'string', description: 'Event kind, e.g. tool.call, path.write, command.exec, blocked, approved, attention.' },
        decision: { type: 'string', description: 'allow, confirm, or deny.' },
        result: { type: 'string', description: 'e.g. ok, blocked, pending, approved, failed.' },
        target: { type: 'string', description: 'Substring of the path, command, or question.' },
        since: { type: 'string', description: 'ISO timestamp; earlier events are skipped.' },
        until: { type: 'string', description: 'ISO timestamp; later events are skipped.' },
        limit: { type: 'number', description: 'Maximum events read or rows printed (default 8 for summary, all for export).' },
        order: { type: 'string', description: 'asc (oldest first, default) or desc.' },
        format: { type: 'string', description: 'summary, status, jsonl, or csv.' },
        out_path: { type: 'string', description: 'File for jsonl/csv; defaults to <stateDir>/audit/audit-export-<time>.<ext>.' },
      },
      async execute(args = {}, exec) {
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
          if (format === 'status') {
            const status = {
              observability: observability.status(),
              mcpMemory: mcpMemory.status(),
              hostSchedule: hostSchedule.available() ? 'available' : 'unavailable',
              workspaceProvider: cfg.workspaceProvider,
              reviewer: cfg.reviewerEnabled ? 'enabled' : 'disabled',
            }
            const sessionId = exec?.agent?.id
            if (sessionId) status.session = await observability.snapshot(sessionId)
            return JSON.stringify(status, null, 2)
          }
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
    }), EXTRA_TOOLS)
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
          return {
            runs: 'GET /runs',
            extensions: {
              observability: observability.status(),
              mcpMemory: mcpMemory.status(),
              hostSchedule: hostSchedule.available() ? 'available' : 'unavailable',
              workspaceProvider: cfg.workspaceProvider,
              reviewer: cfg.reviewerEnabled ? 'enabled' : 'disabled',
            },
          }
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
            requires: body.requires,
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

  // The conversation console is opt-in as well. Unlike the workbench it does
  // not read files: it creates a real Host Session through `sessionController`,
  // sends prompts, and fans the session's own follow stream to the page. If the
  // host has no session service the page is told so; it is never a mock chat.
  if (cfg.consolePort !== null) {
    const consoleRoot = cfg.consoleRoot ? path.resolve(cfg.consoleRoot) : workbenchRoot
    const workbenchFile = path.join(store.root, 'console-workbench.json')
    const managedConsoleSessions = new Set()
    const workbenchData = ready.then(async () => {
      try {
        const saved = JSON.parse(await fsp.readFile(workbenchFile, 'utf8'))
        for (const id of Object.keys(saved.sessions ?? {})) managedConsoleSessions.add(id)
        return { name: typeof saved.name === 'string' ? saved.name : '', sessions: saved.sessions ?? {},
          projects: saved.projects ?? [], taskOwners: saved.taskOwners ?? {} }
      } catch (error) {
        if (error.code !== 'ENOENT') log(`cannot read console workbench: ${error.message}`)
        return { name: '', sessions: {}, projects: [], taskOwners: {} }
      }
    })
    let workbenchWrites = Promise.resolve()

    function saveWorkbench(update) {
      const writing = workbenchWrites.then(async () => {
        const data = await workbenchData
        const next = { name: data.name, sessions: { ...data.sessions }, projects: [...data.projects], taskOwners: { ...data.taskOwners } }
        update(next)
        const temporary = `${workbenchFile}.${randomUUID()}.tmp`
        await fsp.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
        try {
          await fsp.rename(temporary, workbenchFile)
        } catch (error) {
          await fsp.unlink(temporary).catch(() => {})
          throw error
        }
        Object.assign(data, next)
        return next
      })
      workbenchWrites = writing.catch(() => {})
      return writing
    }

    function consoleOwns(item, workbench) {
      if (!item || item.parentSessionId != null || typeof item.sessionId !== 'string' || typeof item.cwd !== 'string') return false
      const cwd = path.resolve(item.cwd)
      return cwd === consoleRoot || (Object.hasOwn(workbench.sessions, item.sessionId) && workbench.sessions[item.sessionId] === cwd)
    }

    function notificationRevision(preferences) {
      return createHash('sha256').update(JSON.stringify(preferences)).digest('hex').slice(0, 24)
    }

    /** Keep the existing action-card contract while the full feed lives in notificationCenter. */
    function workbenchNotificationInbox(center) {
      return center.inbox.filter(entry => ['decision', 'approval'].includes(entry.event)).map(entry => {
        if (entry.event === 'approval') {
          return { ...entry, kind: 'approval', item: {
            id: entry.approvalId, toolName: entry.title, reason: entry.body,
            ownerSessionId: entry.sessionId, runId: entry.runId, source: entry.title,
          } }
        }
        const item = {
          id: entry.decisionId,
          question: entry.question,
          options: entry.options,
          askedAt: entry.at,
          source: { ...(entry.runId ? { runId: entry.runId } : {}),
            ...(entry.goalId ? { goalId: entry.goalId } : {}), attentionId: entry.decisionId },
        }
        return { ...entry, kind: entry.taskKind === 'goal' ? 'decision' : 'question', item }
      })
    }

    async function projectDirectory(cwd) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('请输入本地项目的绝对路径')
      const directory = await fsp.realpath(cwd)
      if (!(await fsp.stat(directory)).isDirectory()) throw new Error('项目路径须指向一个文件夹')
      return directory
    }

    let directoryPicker = null
    if (typeof ctx.inject === 'function') {
      ctx.inject(['directoryPicker'], scoped => {
        const capability = scoped.directoryPicker.capability()
        if (capability?.kind !== 'native') return
        directoryPicker = capability
        scoped.on?.('dispose', () => { if (directoryPicker === capability) directoryPicker = null })
      })
    }
    const CONSOLE_SPACE_ID = 'superagent-console-space'

    function getSessionController() {
      if (typeof ctx.get === 'function') {
        const service = ctx.get('sessionController')
        if (service) return service
      }
      // Direct property is topology-sensitive; this is a fallback for hosts
      // that expose the service without the registry.
      try {
        return ctx.sessionController
      } catch {
        return undefined
      }
    }

    function consoleCapabilities() {
      const session = getSessionController()
      if (!session) {
        return {
          chat: false,
          reason: '宿主没有挂载 sessionController（Host Session API），因此没有可对话的 session；控制台不会伪造聊天。',
        }
      }
      const missing = ['create', 'prompt', 'follow'].filter(name => typeof session[name] !== 'function')
      if (missing.length > 0) {
        return {
          chat: false,
          reason: `sessionController 已挂载，但缺少 ${missing.join(' / ')}，无法建立可流式回复的对话。`,
        }
      }
      return { chat: true, reason: null }
    }

    function consoleService(name) {
      if (typeof ctx.get === 'function') {
        const service = ctx.get(name)
        if (service) return service
      }
      try {
        return ctx[name]
      } catch {
        return undefined
      }
    }

    // The wizard edits the profile's own patch layer and hands the key to the
    // host credential store. It never writes a secret into the profile file.
    const wizard = createWizard({
      stateRoot: store.root,
      version: pkg.version,
      log,
      pricing: cfg.pricing,
      getProfile: () => consoleService('profileContext') ?? null,
      getCredentials: () => consoleService('credentials'),
      getDefaultModel: () => {
        const service = consoleService('agentDefaultModel')
        if (!service) return null
        if (typeof service.currentSelection === 'function') return service.currentSelection()
        return service.selection ?? null
      },
      getSessionController,
      listTools: sessionId => consoleHost.listTools(sessionId),
      fetchImpl: typeof fetch === 'function' ? fetch : undefined,
    })

    /** The conversation agent is the owner of every run it starts. */
    function conversationAgent(sessionId) {
      const agents = getAgents()
      if (agents && typeof agents.get === 'function') {
        const agent = agents.get(sessionId)
        if (agent) return agent
      }
      return null
    }

    async function resolveConversationAgent(sessionId) {
      const live = conversationAgent(sessionId)
      if (live) return live
      const resolved = await getSessionController()?.resolveAgent?.(sessionId)
      return resolved?.agent ?? null
    }

    /** The loopback console token is the local actor; a mounted permission service may still deny a write. */
    async function requireConsolePermission(action, resource) {
      const permissions = consoleService('permissions')
      if (!permissions) return true
      let verdict = true
      try {
        if (typeof permissions.check === 'function') verdict = await permissions.check({ actor: 'local', action, resource })
        else if (typeof permissions.authorize === 'function') verdict = await permissions.authorize({ actor: 'local', action, resource })
        else if (typeof permissions.allows === 'function') verdict = await permissions.allows('local', action, resource)
        else if (typeof permissions.isAllowed === 'function') verdict = await permissions.isAllowed('local', action, resource)
      } catch {
        throw new Error(`permission service could not authorize ${action}`)
      }
      if (verdict === false || verdict?.allowed === false || verdict?.permitted === false || verdict?.authorized === false
        || verdict?.decision === 'deny' || verdict?.effect === 'deny' || verdict?.verdict === 'deny') {
        await auditConsoleAction(action, resource, { permission: 'denied' }, 'blocked')
        throw new Error(`permission denied for ${action}`)
      }
      return true
    }

    /** Record metadata only: tokens, audio, credentials and memory contents never enter the trail. */
    async function auditConsoleAction(action, target = null, meta = {}, result = 'ok') {
      if (!auditor || typeof auditor.record !== 'function') return
      try {
        await auditor.record({
          kind: 'console-action', action, target, actor: 'local', decision: result === 'ok' ? 'allow' : 'deny',
          result, source: 'console', meta,
        })
      } catch (error) {
        log(`audit: cannot record console action ${action}: ${error?.message ?? error}`)
      }
    }

    async function readLlmJson(stream, label) {
      let output = ''
      for await (const chunk of stream) {
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          throw new Error(`${label}失败：模型请求未完成，请检查当前模型连接后重试。`)
        }
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') throw new Error(`${label}失败：请求已中止。`)
        if (chunk?.type === 'text-delta') output += chunk.text
        if (output.length > 64_000) throw new Error(`${label}失败：模型返回内容过长。`)
      }
      const json = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      try { return JSON.parse(json) } catch { throw new Error(`${label}失败：模型未返回有效 JSON，请重试或改写需求。`) }
    }

    async function llmRoute() {
      const llm = consoleService('llm')
      const defaults = consoleService('agentDefaultModel')?.currentSelection?.() ?? {}
      const assistant = await profileStore.get('global-assistant').catch(() => null)
      const provider = assistant?.model ? assistant.provider ?? defaults.provider : cfg.plannerProvider ?? defaults.provider
      const model = assistant?.model ?? cfg.plannerModel ?? defaults.model
      if (!llm || typeof llm.stream !== 'function' || !provider || !model) {
        throw new Error('当前宿主没有可用的 llm 模型路由，无法自动解析。')
      }
      return { llm, provider, model }
    }

    async function automationFromText(text) {
      const deterministic = parseAutomationText(text)
      if (deterministic) return { rule: deterministic, parser: 'deterministic' }
      const { llm, provider, model } = await llmRoute()
      const parsed = await readLlmJson(llm.stream({
        provider, model, maxTokens: 1800,
        system: 'Convert the user request into one automation rule JSON object with name, trigger, action, output, notify, budget, enabled. '
          + 'Use trigger.type cron/every/source and action.type run with prompt for a new automated task. Never include credentials. '
          + 'Use safe budgets and enabled true only for an explicit automation request.',
        messages: [{ role: 'user', content: [{ type: 'text', text: String(text).slice(0, 8000) }] }],
      }), '自然语言自动化解析')
      const rule = parsed?.rule && typeof parsed.rule === 'object' ? parsed.rule : parsed
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('自然语言自动化解析失败：没有返回规则对象。')
      return { rule, parser: 'llm' }
    }

    function minimalPermissionScope(goal, constraints = {}) {
      if (constraints.permissionScope && typeof constraints.permissionScope === 'object') return constraints.permissionScope
      const write = /写|修改|创建|实现|修复|提交|部署|\b(write|edit|create|implement|fix|commit|deploy)\b/i.test(goal)
      const shell = /运行|命令|测试|shell|command|\btest\b/i.test(goal)
      return { tools: ['read', ...(write ? ['write', 'edit'] : []), ...(shell ? ['bash'] : [])],
        allow: [], deny: [], approvalMode: 'policy' }
    }

    async function autoSubtasks(goal, constraints = {}) {
      const route = await llmRoute().catch(() => null)
      if (route) {
        const { llm, provider, model } = route
        try {
          const parsed = await readLlmJson(llm.stream({
            provider, model, maxTokens: 2400,
            system: 'Split the goal into the smallest useful subtasks. Return JSON {"subtasks":[{"title","objective","acceptance":[{"text"}],"dependsOn":[]}]}. '
              + 'Return at most 5 subtasks. Do not request elevated permissions or runtimes; the host applies least privilege.',
            messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ goal, constraints }).slice(0, 12000) }] }],
          }), '自动计划生成')
          const items = Array.isArray(parsed?.subtasks) ? parsed.subtasks : Array.isArray(parsed) ? parsed : null
          if (!items?.length) throw new Error('自动计划生成失败：模型没有返回 subtasks。')
          const cleaned = items.slice(0, Math.max(1, Math.min(8, Number(constraints.maxSubtasks) || 5))).map((item, index) => ({
            title: String(item.title ?? `子任务 ${index + 1}`).slice(0, 100),
            objective: String(item.objective ?? item.prompt ?? '').trim(),
            acceptance: Array.isArray(item.acceptance) && item.acceptance.length
              ? item.acceptance.slice(0, 5).map(check => ({ text: String(check.text ?? check ?? '').slice(0, 500) }))
              : [{ text: 'The report delivers a concrete result backed by evidence for this item.' }],
          })).filter(item => item.objective)
          if (cleaned.length) return { subtasks: cleaned, parser: 'llm' }
        } catch (error) {
          if (constraints.requireModel === true) throw error
        }
      } else if (constraints.requireModel) {
        throw new Error('自动计划生成失败：当前宿主没有可用的 llm 模型路由。')
      }
      return { subtasks: deterministicSubtasks(goal, constraints), parser: 'deterministic' }
    }

    function goalView(goal) {
      return {
        id: goal.id,
        goal: goal.goal,
        title: goal.title,
        ownerSessionId: goal.ownerSessionId,
        createdAt: goal.createdAt,
        finishedAt: goal.finishedAt,
        routerRequestId: goal.routerRequestId,
        contextCount: goal.contextSnapshot?.length ?? 0,
        ...(goal.batch ? { batch: true } : {}),
        instructions: goal.instructions ?? [],
        status: goal.status,
        reason: goal.pausedReason ?? goal.stoppedReason?.detail ?? null,
        blockers: [
          ...(goal.pausedReason ? [goal.pausedReason] : []),
          ...(goal.stoppedReason?.detail ? [goal.stoppedReason.detail] : []),
          ...((goal.decisions ?? []).filter(pendingDecision).map(item => item.question ?? item.reason ?? '等待决策')),
        ],
        nextSteps: ['completed', 'failed', 'cancelled', 'partial'].includes(goal.status)
          ? ['查看任务详情与交付结果。']
          : (goal.decisions ?? []).some(pendingDecision) ? ['回答待决策问题后继续。'] : ['等待当前阶段完成。'],
        decisions: ['completed', 'failed', 'cancelled', 'partial'].includes(goal.status) ? []
          : (goal.decisions ?? []).filter(pendingDecision),
        confirmedDecisions: answeredDecisions(goal),
        phases: (goal.phases ?? []).map(phase => ({
          id: phase.id,
          title: phase.title,
          status: phase.status,
          dependsOn: phase.dependsOn ?? [],
          ...(phase.lastOutcome?.error || phase.skipReason
            ? { outcome: phase.lastOutcome?.error ?? phase.skipReason }
            : {}),
          runId: phase.currentRunId ?? phase.runIds?.at(-1) ?? null,
          ...(phase.finishedAt ? { finishedAt: phase.finishedAt } : {}),
          ...(phase.summary ? { summary: phase.summary } : {}),
        })),
      }
    }

    /**
     * The tool a running worker is spending its time on, read from that worker's
     * own event log: the last unanswered `tool/call`, or the most recent one
     * when every call already came back (a worker between calls). Null when the
     * log cannot be read; the page then shows no tool rather than a guess.
     */
    function runningToolName(childId) {
      if (typeof childId !== 'string' || !childId) return null
      const holder = (() => {
        const sessions = consoleService('sessions')
        if (sessions && typeof sessions.get === 'function') {
          const session = sessions.get(childId)
          if (session) return session
        }
        const agents = getAgents()
        if (agents && typeof agents.get === 'function') {
          const agent = agents.get(childId)
          return agent?.session ?? agent ?? null
        }
        return null
      })()
      if (!holder || typeof holder.snapshotEvents !== 'function') return null
      let events
      try {
        events = holder.snapshotEvents()
      } catch {
        return null
      }
      if (!Array.isArray(events)) return null
      const answered = new Set()
      // The newest unanswered call is what the lane is running now. When every
      // call already came back, the most recent one still tells the user what
      // that lane is spending its time on.
      let latest = null
      for (let index = events.length - 1, scanned = 0; index >= 0 && scanned < 80; index -= 1, scanned += 1) {
        const event = events[index]
        const data = event?.data
        if (!data || typeof data !== 'object') continue
        const callId = data.callId || data.message?.toolCallId || data.message?.source?.callId
        if (event.type === 'tool/result') {
          if (callId) answered.add(callId)
          continue
        }
        if (event.type !== 'tool/call' || !callId) continue
        const name = typeof data.name === 'string' && data.name ? data.name : null
        if (answered.has(callId)) {
          if (!latest) latest = name
          continue
        }
        return name
      }
      return latest
    }

    function runView(run, { detail = false } = {}) {
      const usage = run.usage && typeof run.usage === 'object' ? run.usage : null
      const cost = usage ? computeCost(usage, cfg.pricing) : null
      const openAttention = Array.isArray(run.attention?.items)
        ? run.attention.items.filter(item => actionableAttention(run, item)).map(item => ({
          id: item.id,
          source: item.source ?? null,
          question: item.question,
          options: Array.isArray(item.options) ? item.options : [],
          reason: item.reason ?? null,
          ...(item.handoff ? { kind: 'human', handoff: item.handoff, url: item.url ?? null } : {}),
          askedAt: run.attention?.at ?? null,
        }))
        : []
      const subtasks = Array.isArray(run.subtasks)
        ? run.subtasks.map(subtask => ({
          index: subtask.index ?? null,
          key: subtask.key ?? null,
          title: subtask.title ?? null,
          status: subtask.status ?? null,
          childId: subtask.childId ?? null,
          // Timing is what lets the page show which line is slow; without it
          // every lane looks equally busy.
          startedAt: subtask.startedAt ?? null,
          finishedAt: subtask.finishedAt ?? null,
          // The scheduler already records why a step has not started. Passing
          // those edges through lets the page draw the same order, instead of
          // guessing a queue of its own.
          dependsOn: Array.isArray(subtask.dependsOn) ? subtask.dependsOn.slice(0, 12) : [],
          waitingOn: Array.isArray(subtask.waitingOn) ? subtask.waitingOn.slice(0, 12) : [],
          tool: subtask.status === 'running' ? runningToolName(subtask.childId) : null,
        }))
        : []
      const report = typeof run.report === 'string' ? run.report : null
      const round = run.goalMode?.rounds?.at(-1)
      const checks = (detail || run.origin?.batch ? round?.checks ?? [] : []).map(check => ({
        ...check,
        integrity: check.receipt ? hasMatchingCheckReceipt(run.id, round.round, check) : null,
      }))
      const checkedFiles = run.origin?.batch ? checks.filter(check =>
        check.source === 'file' && check.ok === true && check.integrity).map(check => ({
        name: path.basename(check.path), href: check.path,
      })) : []
      // Keep the durable declarations as well as the older name/href projection.
      // In particular, the final report is stored as {kind:'report', path}, and
      // dropping it here made the global artifact list and preview disagree.
      const declaredArtifacts = (Array.isArray(run.artifacts) ? run.artifacts : [])
        .filter(item => item && typeof item === 'object' && (typeof item.path === 'string' || typeof item.href === 'string'))
        .map(item => {
          const href = item.href ?? item.path
          return { ...item, name: item.name ?? href.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? href, href }
        })
      return {
        id: run.id,
        goal: run.goal,
        status: run.status,
        createdAt: run.createdAt ?? null,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        parentSessionId: run.parentSessionId ?? run.ownerSessionId ?? null,
        ownerSessionId: run.ownerSessionId ?? run.parentSessionId ?? null,
        origin: run.origin ?? null,
        goalId: run.origin?.kind === 'long-goal' ? run.origin.goalId : null,
        instructions: (run.injections ?? []).slice(-5).map(entry => ({
          id: entry.id,
          text: entry.text,
          targets: (entry.targets ?? []).map(({ subtaskIndex, status }) => ({ subtaskIndex, status })),
        })),
        followups: (run.followups ?? []).filter(entry => entry.kind === 'followup').slice(-5).map(entry => ({
          id: entry.id,
          text: entry.text,
          status: entry.appliedAt ? 'applied' : entry.missedAt ? 'missed' : 'pending',
        })),
        // The cap the scheduler really used, and the line it is holding in the
        // queue, are read from the run record rather than re-derived here.
        limits: run.limits
          ? { maxParallel: run.limits.maxParallel ?? null, maxSubtasks: run.limits.maxSubtasks ?? null }
          : null,
        queue: run.queue
          ? {
            waiting: run.queue.waiting === true,
            position: run.queue.position ?? null,
            of: run.queue.of ?? null,
            enqueuedAt: run.queue.enqueuedAt ?? null,
          }
          : null,
        cost: cost
          ? {
            totalMicros: cost.totalMicros,
            currency: cost.currency,
            mixedCurrency: cost.mixedCurrency === true,
            byCurrency: cost.byCurrency,
            text: formatMoney(cost),
            complete: cost.complete === true,
            unpriced: Array.isArray(cost.unpriced) ? cost.unpriced : [],
          }
          : null,
        usage: usage
          ? {
            inputTokens: usage.inputTokens ?? null,
            outputTokens: usage.outputTokens ?? null,
            totalTokens: usage.totalTokens ?? null,
            modelCalls: usage.modelCalls ?? null,
          }
          : null,
        subtasks,
        artifacts: [...declaredArtifacts, ...checkedFiles, ...(run.subtasks ?? []).flatMap(task => task.status === 'completed'
          ? (task.deliverables ?? []).filter(item => item.status === 'verified').map(item => {
            const root = task.workspace?.dir ?? run.workspace?.base ?? run.goalMode?.cwd
            return { name: path.basename(item.path), href: root ? path.resolve(root, item.path) : item.path }
          }) : [])].slice(0, 30),
        ...(detail && checks.length ? { acceptance: { round: round.round, checks } } : {}),
        attention: openAttention,
        ...statusGuidance(run),
        output: run.goalMode?.achieved ? run.goalMode.rounds?.at(-1)?.report ?? null : null,
        report: report ? report.slice(0, detail ? 40_000 : 4_000) : null,
        reportTruncated: Boolean(report && report.length > (detail ? 40_000 : 4_000)),
      }
    }

    /**
     * Count the files and pages a run report names, using the same rule the page
     * uses for artifact chips. The history row only needs the number.
     */
    function countReportArtifacts(report) {
      const text = typeof report === 'string' ? report : ''
      if (!text) return 0
      const seen = new Set()
      const push = value => {
        const href = value.replace(/[.,;:，。；：]+$/, '')
        if (href) seen.add(href)
      }
      for (const match of text.matchAll(/https?:\/\/[^\s"'`<>)\]}|]+/g)) push(match[0])
      for (const match of text.matchAll(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])[^\s"'`<>|]+?\.(?:html?|md|pdf|docx?|xlsx?|csv|tsv|json|ya?ml|txt|log|png|jpe?g|gif|webp|svg|zip|pptx?|py|js|mjs|css)\b/gi)) {
        push(match[0])
      }
      return Math.min(seen.size, 12)
    }

    const firstTextCache = new Map()

    /**
     * Session records as the page consumes them (`{type:'event', event}`).
     * Pages back from the newest until the first turn is reached, bounded so a
     * very long conversation cannot stall the drawer. Null when unreadable.
     */
    async function readSessionRecords(sessionId) {
      const controller = getSessionController()
      if (!controller || typeof controller.events !== 'function') return null
      const address = { kind: 'session', sessionId }
      const { signal } = new AbortController()
      try {
        const newest = await controller.events({ address, maxMessages: 200 }, signal)
        if (!newest || !Array.isArray(newest.records)) return null
        let records = newest.records.slice()
        let page = newest
        for (let guard = 0; page.hasMore === true && guard < 8; guard += 1) {
          const oldest = records[0]?.event?.seq
          if (!Number.isSafeInteger(oldest) || oldest <= 0) break
          const older = await controller.events({ address, maxMessages: 200, beforeSeq: oldest }, signal)
          const batch = Array.isArray(older?.records) ? older.records : []
          if (batch.length === 0) break
          records = [...batch, ...records]
          page = older
        }
        return records
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const frame = error instanceof Error && error.stack ? String(error.stack).split('\n')[1]?.trim() ?? '' : ''
        log(`session read error: ${message}`)
        log(`session read at: ${frame.slice(0, 100)}`)
        return null
      }
    }

    /**
     * The first thing the user said in a conversation, read from that session's
     * own log. Cached per `updatedAt` so opening the drawer does not re-read
     * every transcript, and null when the log cannot be read.
     */
    async function firstUserText(sessionId, marker) {
      const key = `${sessionId}:${marker ?? ''}`
      if (firstTextCache.has(key)) return firstTextCache.get(key)
      const records = await readSessionRecords(sessionId)
      let text = null
      for (const record of records ?? []) {
        const event = record?.event
        if (event?.type !== 'user/message') continue
        if (event.data?.source?.kind !== 'user') continue
        const parts = Array.isArray(event.data?.content) ? event.data.content : []
        const joined = parts
          .filter(part => part?.type === 'text' && typeof part.text === 'string')
          .map(part => part.text)
          .join(' ')
          .trim()
        if (joined) {
          text = joined.slice(0, 140)
          break
        }
      }
      if (text === null && records === null) log(`[superagent-console] first text unavailable for ${sessionId}`)
      firstTextCache.set(key, text)
      return text
    }

    const consoleHost = {
      capabilities(action, payload = {}) {
        if (action === undefined) return consoleCapabilities()
        if (action === 'snapshot') {
          return (async () => {
            const snapshot = await capabilityCenter.snapshot()
            const imported = await skillImporter.list()
            const items = new Map((Array.isArray(snapshot.skills.items) ? snapshot.skills.items : []).map(item => [item.name, item]))
            for (const record of imported) {
              const hosted = items.get(record.name)
              items.set(record.name, hosted && record.enabled
                ? { ...hosted, enabled: true, imported: true, provider: hosted.provider ?? 'dsh-superagent-imported' }
                : { name: record.name, description: record.description, enabled: record.enabled,
                  status: record.enabled ? 'imported' : 'disabled', provider: 'dsh-superagent-imported',
                  source: 'custom', path: record.directory, imported: true })
            }
            return { ...snapshot, skills: { ...snapshot.skills, items: [...items.values()] },
              importedSkills: importedSkills.status?.() ?? { supported: false } }
          })()
        }
        if (action === 'setSkillEnabled') {
          return (async () => {
            await requireConsolePermission('capabilities.manage', 'capabilities')
            const result = await skillImporter.setEnabled(payload.name, payload.enabled)
            importedSkills.invalidate?.()
            await auditConsoleAction('capabilities.skill.setEnabled', result.name, { enabled: result.enabled })
            return { ok: true, name: result.name, enabled: result.enabled, hostRegistration: importedSkills.supported ? 'registered' : 'unsupported' }
          })()
        }
        if (action === 'loadSkill') {
          return (async () => {
            const skills = getOptionalService('skills')
            if (!skills || typeof skills.get !== 'function') {
              const error = new Error('host skill loading is unavailable')
              error.status = 501
              throw error
            }
            const result = await skills.get(payload.name, { cwd: payload.cwd })
            if (!result) {
              const error = new Error(`skill ${payload.name} was not found`)
              error.status = 404
              throw error
            }
            return result
          })()
        }
        if (['probe', 'restart', 'add', 'setEnabled', 'execute'].includes(action)) return capabilityCenter[action === 'add' ? 'addServer' : action](payload)
        throw new Error(`unsupported capability action: ${String(action)}`)
      },

      async authorizeConsoleAction(action, resource) {
        return requireConsolePermission(action, resource)
      },

      async notificationPreferences(action = 'get', patch = {}) {
        if (action === 'get') {
          const preferences = await notificationPreferences.read()
          return { preferences, revision: notificationRevision(preferences) }
        }
        if (action !== 'update') throw new Error(`unsupported notification preference action: ${String(action)}`)
        await requireConsolePermission('console.notifications.write', 'notifications.preferences')
        const preferences = await notificationPreferences.update(patch)
        await auditConsoleAction('notifications.preferences.update', null, { fields: Object.keys(patch ?? {}).sort() })
        return { preferences, revision: notificationRevision(preferences) }
      },

      async notificationCenter({ readIds = [], ...options } = {}) {
        const bench = await this.workbench(null, { limit: Infinity, includeImpact: false, scope: 'global' })
        const snapshot = aggregateNotificationCenter({
          runs: bench.runs,
          goals: bench.goals,
          approvals: [],
          artifacts: collectArtifacts(bench.runs, bench.sessionProjects),
          readIds,
          preferences: bench.preferences,
          ...options,
        })
        return {
          ...snapshot,
          inbox: snapshot.inbox,
          brief: snapshot.dailyBrief,
          preferences: bench.preferences,
          revision: bench.revision,
        }
      },

      async memory(action = 'snapshot', payload = {}) {
        if (['snapshot', 'query', 'status'].includes(action)) {
          return action === 'status' ? memoryCenter.status() : memoryCenter.snapshot(payload)
        }
        if (!['update', 'forget'].includes(action)) throw new Error(`unsupported memory action: ${String(action)}`)
        await requireConsolePermission('memory.write', 'memory')
        const result = action === 'update'
          ? await memoryCenter.update(payload)
          : await memoryCenter.forget(payload)
        await auditConsoleAction(`memory.${action}`, typeof payload?.id === 'string' ? payload.id : null)
        return result
      },

      async repoWiki(action = 'status', payload = {}) {
        if (!cfg.repoWiki.enabled) throw new Error('仓库知识层未启用。')
        const projectPath = String(payload.projectPath ?? payload.project_path ?? '').trim()
        if (!projectPath) throw new Error('仓库知识需要 projectPath。')
        const options = { language: payload.language === 'en' ? 'en' : 'zh' }
        if (['status', 'list', 'read', 'query'].includes(action)) {
          if (action === 'status') return repoWiki.status(projectPath)
          if (action === 'list') return repoWiki.list(projectPath, { ...options, path: payload.path ?? '/' })
          if (action === 'read') return repoWiki.read(projectPath, { ...options, path: payload.path })
          return repoWiki.query(projectPath, { ...options, query: payload.query ?? '', limit: payload.limit ?? 8 })
        }
        if (!['generate', 'link', 'unlink'].includes(action)) throw new Error(`unsupported repo wiki action: ${String(action)}`)
        await requireConsolePermission('memory.write', 'repo-wiki')
        const result = action === 'generate'
          ? await repoWiki.generate(projectPath, { force: payload.force === true })
          : action === 'link'
            ? await repoWiki.link(projectPath, { sourcePath: payload.sourcePath ?? payload.source_path,
              targetPath: payload.targetPath ?? payload.target_path, kind: payload.kind,
              reason: payload.reason, explanation: payload.explanation })
            : await repoWiki.unlink(projectPath, { sourcePath: payload.sourcePath ?? payload.source_path,
              targetPath: payload.targetPath ?? payload.target_path, kind: payload.kind })
        await auditConsoleAction(`repo-wiki.${action}`, projectPath)
        return result
      },

      async runtimeView(action = 'snapshot', payload = {}) {
        if (action === 'snapshot') return runtimeView.snapshot()
        if (action === 'currentAction') return runtimeView.currentAction()
        if (!['capture', 'takeover', 'release', 'stop'].includes(action)) {
          throw new Error(`unsupported runtime view action: ${String(action)}`)
        }
        await requireConsolePermission('runtime.control', 'runtime-view')
        const result = await runtimeView[action](payload)
        await auditConsoleAction(`runtime-view.${action}`, typeof payload?.runId === 'string' ? payload.runId : null)
        return result
      },

      runtimeViewSubscribe(listener) {
        return runtimeStream.subscribe(listener)
      },

      runtimeViewRead(options = {}) {
        return runtimeStream.read(options)
      },

      async runtimeViewImage(file) {
        const root = path.resolve(runtime.shotDir)
        const target = path.resolve(String(file ?? ''))
        const relative = path.relative(root, target)
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          || path.extname(target).toLowerCase() !== '.png') {
          const error = new Error('runtime frame is outside the screenshot directory')
          error.status = 403
          throw error
        }
        let real
        try { real = await fsp.realpath(target) } catch {
          const error = new Error('runtime frame is missing')
          error.status = 404
          throw error
        }
        const realRelative = path.relative(root, real)
        if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
          const error = new Error('runtime frame resolved outside the screenshot directory')
          error.status = 403
          throw error
        }
        const stat = await fsp.stat(real)
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) {
          const error = new Error('runtime frame is not a supported PNG')
          error.status = 415
          throw error
        }
        return { body: await fsp.readFile(real), contentType: 'image/png' }
      },

      async evidence(runId, options = {}) {
        await ready
        if (stateError) throw stateError
        const run = await store.read(runId)
        if (!run || run.origin?.role === 'decompose') return null
        const sessions = await this.listSessions({ limit: Infinity, includeHistory: false })
        const owner = sessions.find(session => session.sessionId === (run.parentSessionId ?? run.ownerSessionId))
        if (!owner) return null
        const projects = { [owner.sessionId]: owner.cwd === consoleRoot ? null : { cwd: owner.cwd } }
        const audit = auditor ? await auditor.query({ runId, limit: 500 }) : { events: [] }
        return {
          ...buildEvidenceCenter({
            run,
            auditEvents: audit.events ?? [],
            artifacts: collectArtifacts([run], projects),
            workspace: owner.cwd,
          }, { ...options, runId }),
          runId,
        }
      },

      async cost(action = 'summary', payload = {}) {
        if (action === 'summary') return costCenter.aggregate()
        if (action === 'route') return routePolicy.route(payload)
        if (action === 'budget') {
          await requireConsolePermission('cost.budget', 'cost')
          const result = payload && Object.hasOwn(payload, 'budgets')
            ? await costCenter.setBudgets(payload.budgets)
            : await costCenter.check(payload)
          await auditConsoleAction('cost.budget', typeof payload?.currency === 'string' ? payload.currency : null)
          return result
        }
        throw new Error(`unsupported cost action: ${String(action)}`)
      },

      async profiles(action = 'list', payload = {}) {
        const options = { actor: 'local' }
        if (action === 'list') return profileStore.list(payload, options)
        if (action === 'get') {
          if (typeof payload.id !== 'string' || !payload.id) throw new Error('profile id is required')
          return profileStore.get(payload.id, options)
        }
        if (!['create', 'update', 'remove', 'toggle'].includes(action)) {
          throw new Error(`unsupported profile action: ${String(action)}`)
        }
        await requireConsolePermission('profiles.manage', 'profiles')
        let result
        if (action === 'create') result = await profileStore.create(payload.profile ?? payload, options)
        else if (action === 'remove') result = await profileStore.remove(payload.id, options)
        else if (action === 'toggle') {
          if (typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean')
          result = await profileStore.setEnabled(payload.id, payload.enabled, options)
        } else result = await profileStore.update(payload.id, payload.patch ?? {}, {
          ...options,
          ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
        })
        await auditConsoleAction(`profiles.${action}`, typeof payload.id === 'string' ? payload.id : result?.id ?? null)
        return result
      },

      async planPreview(action = 'preview', payload = {}) {
        if (action === 'auto') {
          const goal = typeof payload.goal === 'string' ? payload.goal.trim() : ''
          if (!goal) throw new Error('auto plan preview requires goal')
          const project = payload.project ?? consoleRoot
          if (typeof project !== 'string' || !path.isAbsolute(project)) throw new Error('auto plan preview project must be an absolute path')
          const constraints = payload.constraints && typeof payload.constraints === 'object' ? payload.constraints : {}
          const generated = await autoSubtasks(goal, constraints)
          const assistant = await profileStore.get('global-assistant').catch(() => null)
          const model = payload.model ?? (assistant?.model ? { name: assistant.model, provider: assistant.provider } : null)
          const modelName = typeof model === 'string' ? model : model?.name
          const permissionScope = minimalPermissionScope(goal, constraints)
          const tools = permissionScope.tools ?? []
          const capabilities = [...new Set(['analysis', 'filesystem.read',
            ...(tools.some(tool => ['write', 'edit'].includes(tool)) ? ['filesystem.write'] : []),
            ...(modelName ? [`model.${modelName}`] : [])])]
          const preview = createCandidatePlanPreview({
            goal,
            subtasks: generated.subtasks,
            project,
            model,
            capabilities,
            permissionScope,
            runtime: { cwd: project, provider: cfg.provider, isolation: cfg.workspaceIsolation ? 'worktree' : 'workspace' },
            budget: constraints.budget ?? { maxModelCalls: 40, maxTokens: 200_000 },
            pricing: payload.pricing ?? cfg.pricing,
          })
          return { ...preview, generation: { parser: generated.parser, userSuppliedSubtasks: false } }
        }
        if (action === 'candidate') {
          const assistant = await profileStore.get('global-assistant').catch(() => null)
          const model = payload.model ?? (assistant?.model ? { name: assistant.model, provider: assistant.provider } : null)
          const modelName = typeof model === 'string' ? model : model?.name
          const project = payload.project ?? consoleRoot
          const capabilities = [...new Set([...(Array.isArray(payload.capabilities) ? payload.capabilities : []),
            'analysis', ...(guardHooked ? ['filesystem.read', 'filesystem.write'] : []),
            ...(modelName ? [`model.${modelName}`] : [])])]
          return createCandidatePlanPreview({ ...payload, project, model, capabilities,
            runtime: { ...payload.runtime, cwd: payload.runtime?.cwd ?? project, provider: cfg.provider,
              isolation: cfg.workspaceIsolation ? 'worktree' : 'workspace' },
            pricing: payload.pricing ?? cfg.pricing })
        }
        if (action === 'preview') {
          return createPlanPreview({ ...payload, workspace: payload.workspace ?? consoleRoot, pricing: payload.pricing ?? cfg.pricing })
        }
        if (action !== 'approve') throw new Error(`unsupported plan preview action: ${String(action)}`)
        await requireConsolePermission('plan.approve', 'plan-preview')
        const result = approvePlan(payload.preview, {
          planDigest: payload.planDigest,
          confirmations: payload.confirmations,
          approvedBy: 'local',
        })
        await auditConsoleAction('plan.approve', result.planDigest)
        return result
      },

      async voice(action = 'catalog', payload = {}) {
        if (action === 'catalog') return voiceService.catalog(payload)
        if (action !== 'transcribe') throw new Error(`unsupported voice action: ${String(action)}`)
        if (typeof payload.audio !== 'string' || !payload.audio) throw new Error('audio is required')
        if (payload.audio.length > 14 * 1024 * 1024 || payload.audio.length % 4 !== 0
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.audio)) {
          throw new Error('audio must be a valid base64-encoded WAV within the size limit')
        }
        const audio = Buffer.from(payload.audio, 'base64')
        if (!audio.length || audio.toString('base64') !== payload.audio) throw new Error('audio is not valid base64')
        const text = await voiceService.transcribe(audio, payload.options ?? {})
        await auditConsoleAction('voice.transcribe')
        return { text }
      },

      async devicePairing(action = 'status', payload = {}) {
        if (action === 'pair') {
          await requireConsolePermission('devices.pair', 'devices')
          const device = await devicePairing.pair({
            name: payload.name,
            scopes: payload.scopes,
            expiresInSeconds: payload.expiresInSeconds,
          })
          await auditConsoleAction('devices.pair', device.id, { scopes: device.scopes })
          return device
        }
        if (action === 'verify') {
          const device = await devicePairing.verify(payload.token)
          if (device) await auditConsoleAction('devices.authorize', device.id, { scopes: device.scopes })
          return device
        }
        if (action === 'status') return devicePairing.status(payload.id)
        if (action === 'revoke') {
          await requireConsolePermission('devices.revoke', 'devices')
          const device = await devicePairing.revoke(payload.id)
          await auditConsoleAction('devices.revoke', device.id)
          return device
        }
        throw new Error(`unsupported device pairing action: ${String(action)}`)
      },

      async automations(action = 'list', payload = {}) {
        if (action === 'list') return automationStore.list()
        if (action === 'get') return automationStore.get(payload.id)
        if (action === 'executions') return automationStore.listExecutions({
          ruleId: payload.ruleId ?? payload.id, limit: payload.limit,
        })
        if (action === 'preview') {
          return { ...previewAutomationRule(payload.rule, { now: payload.now, sources: payload.sources ?? [] }),
            sideEffects: 'none', executionStarted: false }
        }
        if (action === 'from-text') {
          await requireConsolePermission('automations.manage', 'automations')
          const text = typeof payload.text === 'string' ? payload.text.trim() : ''
          if (!text) throw new Error('from-text requires text')
          const generated = await automationFromText(text)
          const normalized = normalizeAutomationRule(generated.rule)
          assertAutomationSchedule(normalized)
          const rule = await automationStore.create(normalized)
          const scheduleId = await syncAutomationSchedule(rule)
          const preview = { ...previewAutomationRule(rule, { sources: payload.sources ?? [] }),
            sideEffects: 'none', executionStarted: false }
          await auditConsoleAction('automations.from-text', rule.id, { revision: rule.revision, scheduleId, parser: generated.parser })
          return { rule: { ...rule, scheduleId }, preview, parser: generated.parser }
        }
        if (action === 'create') {
          await requireConsolePermission('automations.manage', 'automations')
          assertAutomationSchedule(normalizeAutomationRule(payload.rule))
          const rule = await automationStore.create(payload.rule)
          const scheduleId = await syncAutomationSchedule(rule)
          await auditConsoleAction('automations.create', rule.id, { revision: rule.revision, scheduleId })
          return { ...rule, scheduleId }
        }
        if (!['update', 'remove', 'toggle', 'run-now'].includes(action)) {
          throw new Error(`unsupported automation action: ${String(action)}`)
        }
        const rule = await automationStore.get(payload.id)
        if (!rule) {
          const error = new Error(`automation rule ${payload.id} does not exist`)
          error.code = 'rule-not-found'
          throw error
        }
        if (action === 'run-now') {
          await requireConsolePermission('automations.run', 'automations')
          const idempotencyKey = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey
            ? payload.idempotencyKey.slice(0, 512) : `manual:${rule.id}:${Date.now()}:${randomUUID()}`
          const requestId = `auto-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40)}`
          const result = await submitAutomationRule({ rule, text: rule.action.prompt || rule.name,
            project: typeof payload.project === 'string' ? payload.project : null,
            requestId, idempotencyKey })
          await auditConsoleAction('automations.run-now', rule.id, { executionId: result.id,
            replayed: result.replayed === true })
          return result
        }
        await requireConsolePermission('automations.manage', 'automations')
        const revision = payload.expectedRevision ?? payload.revision
        let result
        let scheduleId = null
        if (action === 'update') {
          assertAutomationSchedule(normalizeAutomationRule({ ...rule, ...(payload.patch ?? {}) }))
          result = await automationStore.update(rule.id, payload.patch ?? {}, { revision })
          scheduleId = await syncAutomationSchedule(result)
        } else if (action === 'toggle') {
          assertAutomationSchedule(normalizeAutomationRule({ ...rule, enabled: payload.enabled }))
          result = await automationStore.toggle(rule.id, { enabled: payload.enabled, revision })
          scheduleId = await syncAutomationSchedule(result)
        } else {
          const priorPlan = await findAutomationPlan(rule)
          result = await automationStore.remove(rule.id, { revision })
          if (priorPlan) await scheduler.remove(priorPlan.id)
          scheduleId = null
        }
        await auditConsoleAction(`automations.${action}`, rule.id, { revision: result.revision, scheduleId })
        return { ...result, scheduleId }
      },

      async cloudWorker(action = 'status', payload = {}) {
        const providerApi = requireRemoteProvider()
        if (action === 'status') {
          const jobs = await remoteJobStore.list()
          return { available: true, endpoint: cfg.remoteWorker.endpoint,
            model: cfg.remoteWorker.model, provider: cfg.remoteWorker.provider,
            capabilities: providerApi.capabilities, active: jobs.filter(job => !job.terminal).length,
            jobs: jobs.map(job => ({ workerId: job.workerId, state: job.state, terminal: job.terminal,
              runId: job.runId, subtaskId: job.subtaskId, attempt: job.attempt,
              createdAt: job.createdAt, updatedAt: job.updatedAt, revision: job.revision })) }
        }
        if (action === 'submit') {
          await requireConsolePermission('cloud-worker.control', 'cloud-worker')
          const spec = createWorkSpec(payload.workSpec)
          const submitted = await providerApi.submit(spec, { idempotencyKey: payload.idempotencyKey,
            signal: payload.signal })
          const saved = await remoteJobStore.put(submitted.workerId, {
            workerId: submitted.workerId, lease: submitted.lease, fencingToken: submitted.fencingToken,
            workSpec: spec, state: submitted.state, terminal: REMOTE_TERMINAL.has(submitted.state),
            createdAt: new Date().toISOString(),
          })
          remoteJobs.set(submitted.workerId, saved)
          await auditConsoleAction('cloud-worker.submit', submitted.workerId, {
            runId: spec.run.id, subtaskId: spec.subtask.id, attempt: spec.attempt,
          })
          return { workerId: submitted.workerId, state: submitted.state, status: 'submitted' }
        }
        const job = await ensureRemoteLease(payload.workerId, payload)
        if (action === 'snapshot') {
          const snapshot = await providerApi.snapshot(job.workerId, { lease: job.lease, signal: payload.signal })
          await persistRemoteState(job.workerId, snapshot.state, snapshot.lease)
          return redactSensitiveValue(snapshot)
        }
        if (action === 'events') return collectRemoteEvents(job.workerId, payload)
        if (action === 'cancel') {
          await requireConsolePermission('cloud-worker.control', 'cloud-worker')
          const result = await providerApi.cancel(job.workerId, { lease: job.lease,
            idempotencyKey: payload.idempotencyKey ?? `cancel:${job.workerId}`, signal: payload.signal })
          await persistRemoteState(job.workerId, result.state ?? 'cancelling')
          await auditConsoleAction('cloud-worker.cancel', job.workerId)
          return result
        }
        if (action === 'finalize') {
          await requireConsolePermission('cloud-worker.control', 'cloud-worker')
          const runId = job.workSpec.run.id
          const run = await store.read(runId)
          if (!run) {
            const error = new Error(`cannot finalize artifacts: run ${runId} does not exist`)
            error.status = 404
            throw error
          }
          const workspace = path.isAbsolute(job.workSpec.repoSnapshot?.ref ?? '')
            ? job.workSpec.repoSnapshot.ref : run.workspace?.base ?? run.goalMode?.cwd
          if (!workspace || !path.isAbsolute(workspace)) {
            const error = new Error('cannot finalize artifacts without an absolute workspace')
            error.status = 400
            throw error
          }
          const result = await providerApi.finalizeArtifacts(job.workerId, { lease: job.lease,
            idempotencyKey: payload.idempotencyKey ?? `finalize:${job.workerId}`, signal: payload.signal })
          const saved = await finalizeCloudArtifacts({ result, workspace, runId })
          await store.updateArtifacts(runId, saved.artifacts)
          await auditConsoleAction('cloud-worker.finalize', job.workerId, { artifactId: result.artifactId,
            runId, artifactCount: saved.artifacts.length })
          return { ...result, manifest: { ...result.manifest,
            entries: result.manifest.entries.map(({ content, ...entry }) => entry) },
            registration: { runId, workspace: saved.workspace, artifacts: saved.artifacts, totalBytes: saved.totalBytes } }
        }
        throw new Error(`unsupported cloud Worker action: ${String(action)}`)
      },

      async shares(action = 'list', payload = {}) {
        if (action === 'list') return shareStore.listShares(payload)
        if (action === 'get') {
          const share = (await shareStore.listShares({ includeRevoked: true, limit: 100000 }))
            .find(item => item.id === payload.id)
          if (!share) {
            const error = new Error('share was not found')
            error.code = 'share-not-found'
            throw error
          }
          return share
        }
        if (action === 'read') {
          const options = {}
          if (payload.artifactId !== undefined) options.artifactId = payload.artifactId
          if (payload.artifactIds !== undefined) options.artifactIds = payload.artifactIds
          return shareStore.readShare(payload.token, options)
        }
        if (action === 'comments') {
          const options = {}
          if (payload.artifactId !== undefined) options.artifactId = payload.artifactId
          if (payload.artifactIds !== undefined) options.artifactIds = payload.artifactIds
          if (payload.limit !== undefined) options.limit = payload.limit
          return shareStore.listComments(payload.token, options)
        }
        if (action === 'create') {
          await requireConsolePermission('shares.write', 'shares')
          const result = await shareStore.createShare(payload.share)
          await auditConsoleAction('shares.create', result.share.id, { role: result.share.role,
            artifactCount: result.share.artifactIds.length })
          return result
        }
        if (action === 'comment') {
          await requireConsolePermission('shares.write', 'shares')
          const result = await shareStore.createComment(payload.token, payload.comment ?? payload)
          await auditConsoleAction('shares.comment', result.shareId, { artifactId: result.artifactId })
          return result
        }
        if (action === 'remove') {
          await requireConsolePermission('shares.write', 'shares')
          const result = await shareStore.revokeShare(payload.id)
          await auditConsoleAction('shares.remove', result.id)
          return result
        }
        if (action === 'readContent') {
          const share = await shareStore.readShare(payload.token, { artifactId: payload.artifactId })
          const parsedId = parseArtifactId(payload.artifactId)
          if (!parsedId) {
            const error = new Error('artifact id is invalid')
            error.status = 400
            throw error
          }
          const run = await store.read(parsedId.runId)
          if (!run) {
            const error = new Error('shared artifact run is missing')
            error.status = 404
            throw error
          }
          const root = path.resolve(run.workspace?.base ?? run.goalMode?.cwd ?? consoleRoot)
          const owner = run.parentSessionId ?? run.ownerSessionId ?? 'shared'
          const descriptor = collectArtifacts([run], { [owner]: { name: path.basename(root), cwd: root } })
            .find(item => item.id === payload.artifactId)
          if (!descriptor?.path) {
            const error = new Error('shared artifact is not available')
            error.status = 404
            throw error
          }
          const target = path.resolve(descriptor.path)
          const roots = [root, path.join(store.root, 'reports')]
          const within = (base, value) => {
            const relative = path.relative(base, value)
            return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
          }
          if (!roots.some(base => within(base, target))) {
            const error = new Error('shared artifact is outside its workspace')
            error.status = 403
            throw error
          }
          let real
          try { real = await fsp.realpath(target) } catch {
            const error = new Error('shared artifact is missing')
            error.status = 404
            throw error
          }
          const realRoots = (await Promise.all(roots.map(base => fsp.realpath(base).catch(() => null)))).filter(Boolean)
          if (!realRoots.some(base => within(base, real))) {
            const error = new Error('shared artifact resolves outside its workspace')
            error.status = 403
            throw error
          }
          const stat = await fsp.stat(real)
          if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
            const error = new Error('shared artifact is not a supported file')
            error.status = 415
            throw error
          }
          return { share, artifact: { id: descriptor.id, name: descriptor.name, kind: descriptor.kind,
            href: descriptor.href, bytes: stat.size }, body: await fsp.readFile(real) }
        }
        throw new Error(`unsupported share action: ${String(action)}`)
      },

      async market(action = 'search', payload = {}) {
        if (action === 'import') {
          await requireConsolePermission('market.import', 'market')
          const result = await skillImporter.import(payload.sourceDirectory, { enabled: payload.enabled === true })
          importedSkills.invalidate?.()
          await auditConsoleAction('market.import', result.name, { enabled: result.enabled })
          return { ...result, hostRegistration: importedSkills.supported ? 'registered' : 'unsupported' }
        }
        const client = requireMarketClient()
        if (action === 'search') return client.search({ query: payload.query ?? payload.q ?? '',
          signal: payload.signal })
        if (action === 'detail') {
          const result = await client.search({ query: payload.name, signal: payload.signal })
          const item = result.items.find(entry => entry.name === payload.name
            && (!payload.kind || entry.kind === payload.kind)
            && (!payload.version || entry.version === payload.version))
          if (!item) {
            const error = new Error(`market item ${payload.name} was not found`)
            error.code = 'NOT_FOUND'
            throw error
          }
          return item
        }
        if (action === 'install-handoff') {
          await requireConsolePermission('market.import', 'market')
          const requested = payload.item
          if (!requested || typeof requested.name !== 'string') throw new Error('install-handoff requires a market item')
          const found = await client.search({ query: requested.name, signal: payload.signal })
          const item = found.items.find(entry => entry.name === requested.name
            && (!requested.kind || entry.kind === requested.kind)
            && (!requested.version || entry.version === requested.version))
          if (!item) {
            const error = new Error(`market item ${requested.name} was not found`)
            error.code = 'NOT_FOUND'
            throw error
          }
          const result = await client.install(item, { enabled: payload.enabled === true, hostInstallApi: null })
          await auditConsoleAction('market.install-handoff', item.name, { status: result.status })
          return result
        }
        throw new Error(`unsupported market action: ${String(action)}`)
      },

      async wizardStatus(options = {}) {
        return wizard.status(options)
      },

      async wizardPreview(body = {}) {
        return wizard.preview(body)
      },

      async wizardSave(body = {}) {
        return wizard.save(body)
      },

      async wizardRollback(id) {
        return wizard.rollback(id)
      },

      async wizardTrial() {
        return wizard.trial()
      },

      /**
       * Remember that a session is driven from the superagent panel, so the
       * eight core tools stay in its tool list. A plain host conversation is
       * not marked and keeps only `superagent_help`.
       */
      markPanelSession(sessionId) {
        if (typeof sessionId === 'string' && sessionId) panelSessions.add(sessionId)
      },

      async createSession({ cwd, taskKey, title } = {}) {
        const caps = consoleCapabilities()
        if (!caps.chat) throw new Error(caps.reason)
        const session = getSessionController()
        const directory = cwd ? await projectDirectory(cwd) : consoleRoot
        const sessionTitle = typeof title === 'string' && title.trim()
          ? title.trim().slice(0, 56)
          : '超级智能体对话'
        let workspaceId = null
        const workspaceController = getOptionalService('workspaceController')
        if (typeof workspaceController?.create === 'function') {
          try {
            const createdWorkspace = await workspaceController.create({ path: directory })
            const workspace = createdWorkspace?.workspace ?? createdWorkspace
            workspaceId = workspace?.workspaceId ?? workspace?.id ?? null
          } catch (error) {
            log(`cannot create workspace metadata for ${directory}: ${error?.message ?? error}`)
          }
        }
        const base = {
          ...(workspaceId ? { workspaceId } : { cwd: directory }),
          ...(cfg.consolePreset ? { agentPreset: cfg.consolePreset } : {}),
        }
        // A fixed identity makes the console its own space: the same
        // conversation is reused on the next host start instead of a new chat,
        // and it stays separate from the sessions the user starts themselves.
        let created
        if (taskKey) {
          const data = await workbenchData
          const stableId = `session-superagent-${createHash('sha256').update(taskKey).digest('hex').slice(0, 32)}`
          const existingId = data.taskOwners[taskKey] ?? stableId
          const listing = await session.list()
          const items = Array.isArray(listing) ? listing : listing?.items ?? []
          const existing = items.find(item => item.sessionId === existingId && item.cwd
            && path.resolve(item.cwd) === path.resolve(directory) && item.parentSessionId == null)
          created = existing ? { sessionId: existing.sessionId } : await session.create({ ...base, sessionId: stableId })
        } else if (directory === consoleRoot) {
          try {
            created = await session.create({ ...base, sessionId: CONSOLE_SPACE_ID })
          } catch {
            created = await session.create(base)
          }
        } else created = await session.create(base)
        if (!created || typeof created.sessionId !== 'string' || !created.sessionId) {
          throw new Error('sessionController.create returned no sessionId')
        }
        if (typeof session.rename === 'function') {
          try {
            await session.rename({ sessionId: created.sessionId, title: sessionTitle })
          } catch (error) {
            log(`cannot rename session ${created.sessionId}: ${error?.message ?? error}`)
          }
        }
        if (taskKey || directory !== consoleRoot) await saveWorkbench(data => {
          data.sessions[created.sessionId] = directory
          if (taskKey) data.taskOwners[taskKey] = created.sessionId
        })
        panelSessions.add(created.sessionId)
        if (taskKey || directory !== consoleRoot) managedConsoleSessions.add(created.sessionId)
        return { sessionId: created.sessionId, preset: created.preset ?? cfg.consolePreset ?? null }
      },

      /**
       * The directory a conversation writes into. A dropped file is stored
       * under it, so the answer comes from the session record, never from the
       * page: a page that could name its own directory could name any one.
       */
      async sessionWorkspace(sessionId) {
        const controller = getSessionController()
        if (!controller || typeof controller.list !== 'function') return consoleRoot
        try {
          const listed = await controller.list()
          const items = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
          const hit = items.find(item => item
            && item.sessionId === sessionId
            && item.parentSessionId === undefined
            && typeof item.cwd === 'string'
            && item.cwd)
          return hit ? path.resolve(hit.cwd) : consoleRoot
        } catch {
          return consoleRoot
        }
      },

      /**
       * The tools this conversation actually has, read from the live agent's
       * scope rather than a list kept here. Resolving a blank session starts
       * its agent, which is the same work the first prompt would do.
       */
      async listTools(sessionId) {
        const session = getSessionController()
        let agent = conversationAgent(sessionId)
        if (!agent && session && typeof session.resolveAgent === 'function') {
          const resolved = await session.resolveAgent(sessionId)
          agent = resolved?.agent ?? null
        }
        if (!agent) return null
        if (typeof ctx.tools?.definitions !== 'function') return null
        return ctx.tools.definitions(agent)
          .map(definition => ({
            name: definition.name,
            description: typeof definition.description === 'string'
              ? definition.description.slice(0, 240)
              : null,
          }))
          .sort((left, right) => left.name.localeCompare(right.name))
      },

      async prompt({ sessionId, text, mode }) {
        const session = getSessionController()
        if (!session) throw new Error('sessionController is not mounted')
        const timeZone = (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone
          } catch {
            return undefined
          }
        })()
        await session.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: mode === 'steer' ? 'steer' : 'queue',
          content: [{ type: 'text', text }],
          ...(timeZone ? { clientTimeZone: timeZone } : {}),
        }, new AbortController().signal)
        return { accepted: true }
      },

      /**
       * Stop the turn this conversation is currently running. The session
       * controller owns admission, so an idle conversation simply acknowledges
       * that there was nothing left to cancel.
       */
      async cancelTurn(sessionId) {
        await ready
        const session = getSessionController()
        if (!session) throw new Error('sessionController is not mounted')
        if (typeof session.cancel !== 'function') throw new Error('this session controller cannot stop a turn')
        const value = await session.cancel({ sessionId })
        return { accepted: value?.accepted !== false }
      },

      async listRuns(sessionId) {
        await ready
        if (stateError) throw stateError
        const runs = await store.list()
        return runs
          .filter(run => run && (run.parentSessionId ?? run.ownerSessionId) === sessionId && run.origin?.role !== 'decompose')
          .slice(0, 20)
          .map(run => runView(run))
      },

      async listGoals(sessionId) {
        await ready
        if (stateError) throw stateError
        return (await longGoal.list()).filter(goal => goal.ownerSessionId === sessionId).slice(0, 20).map(goalView)
      },

      async createGoal(sessionId, text, options = {}) {
        await ready
        if (stateError) throw stateError
        const agent = await resolveConversationAgent(sessionId)
        if (!agent) throw new Error('cannot start a goal without its conversation agent')
        if (!hasSubagents()) throw new Error('cannot start a goal without the host subagents service')
        const goal = await longGoal.create({
          goal: text,
          parentSessionId: sessionId,
          cwd: agent.session?.cwd ?? await consoleHost.sessionWorkspace(sessionId),
          consoleOwned: true,
          ...options,
        })
        return goalView(goal)
      },

      async actOnGoal(sessionId, id, action, body) {
        await ready
        if (stateError) throw stateError
        const goal = await longGoal.store.read(id)
        if (!goal || goal.ownerSessionId !== sessionId) return null
        if (action === 'answer') {
          const parent = await resolveConversationAgent(sessionId)
          return goalView(await longGoal.answer(id, body.decisionId, body.answer, { parent, note: body.note }))
        }
        if (action === 'retry_phase') await longGoal.retryPhase(id, body.phaseId)
        else await longGoal[action](id)
        return goalView(await longGoal.get(id))
      },

      async instructRun(sessionId, id, { text, subtaskIndex, mode, requestId }) {
        await ready
        if (stateError) throw stateError
        const run = await store.read(id)
        if (!run || (run.parentSessionId ?? run.ownerSessionId) !== sessionId) return null
        const agent = await resolveConversationAgent(sessionId)
        if (!agent) throw new Error('cannot send an instruction without its conversation agent')
        if (mode === 'followup') {
          const result = await orchestrator.followup(id, text, agent, { requestId })
          return { id: result.followup.id, detail: result.effect.detail }
        }
        const result = await orchestrator.inject(id, text, agent, { subtaskIndex, fallbackToFollowup: false })
        return { id: result.injection.id, targets: result.injection.targets.map(({ subtaskIndex, status }) => ({ subtaskIndex, status })) }
      },

      async readRun(sessionId, runId) {
        await ready
        if (stateError) throw stateError
        const run = await store.read(runId)
        if (!run || (run.parentSessionId ?? run.ownerSessionId) !== sessionId) return null
        return runView(run, { detail: true })
      },

      /**
       * All artifacts owned by conversations the console can actually show.
       * `sessionId` identifies the caller's current conversation, not a narrower
       * scope: this is the global assistant's cross-workspace artifact centre.
       */
      async artifacts(sessionId, options = {}) {
        await ready
        if (stateError) throw stateError
        const sessions = await this.listSessions({ limit: Infinity, includeHistory: false })
        const bySession = new Map(sessions.map(session => [session.sessionId, session]))
        const sessionProjects = Object.fromEntries(sessions.map(session => [session.sessionId,
          session.cwd === consoleRoot ? null : { cwd: session.cwd, name: path.basename(session.cwd) || session.cwd }]))
        const runs = (await store.list()).filter(run => bySession.has(run.parentSessionId ?? run.ownerSessionId) && run.origin?.role !== 'decompose')
        return listArtifacts(runs, sessionProjects, options)
      },

      /** Re-read the durable run named by an opaque, stable artifact id. */
      async readArtifact(id) {
        const parsed = parseArtifactId(id)
        if (!parsed) return null
        await ready
        if (stateError) throw stateError
        const run = await store.read(parsed.runId)
        if (!run || run.origin?.role === 'decompose') return null
        const sessions = await this.listSessions({ limit: Infinity, includeHistory: false })
        const owner = sessions.find(session => session.sessionId === (run.parentSessionId ?? run.ownerSessionId))
        if (!owner) return null
        const sessionProjects = {
          [owner.sessionId]: owner.cwd === consoleRoot ? null : { cwd: owner.cwd, name: path.basename(owner.cwd) || owner.cwd },
        }
        const artifact = collectArtifacts([run], sessionProjects).find(item => item.id === id)
        if (!artifact) return null
        return { artifact, run: runView(run, { detail: true }) }
      },

      async readWorkerSession(sessionId, runId, childId) {
        const run = await this.readRun(sessionId, runId)
        const subtask = run?.subtasks.find(item => item.childId === childId)
        if (!subtask) return null
        const records = await this.readSessionEvents(childId)
        return { title: subtask.title, records: (records ?? []).slice(-150) }
      },

      /**
       * Stop one run through the same cancel path the `superagent_cancel` tool
       * uses. Ownership is checked against the conversation first, so a page
       * can only stop runs it is showing.
       */
      async cancelRun(sessionId, runId) {
        await ready
        if (stateError) throw stateError
        const id = typeof runId === 'string' ? runId.trim() : ''
        if (!id) return null
        const run = await store.read(id)
        if (!run || (run.parentSessionId ?? run.ownerSessionId) !== sessionId) return null
        const cancelled = await orchestrator.cancel(id)
        return {
          runId: id,
          status: cancelled?.status ?? null,
          cancelPending: cancelled?.cancelPending === true,
        }
      },

      /** The console's own conversations, newest first, with what they produced. */
      async listSessions({ limit = 12, includeHistory = true } = {}) {
        const controller = getSessionController()
        if (!controller || typeof controller.list !== 'function') return []
        await ready
        if (stateError) throw stateError
        // The registered controller answers `{ items }`; older shapes are a bare array.
        const listed = await controller.list()
        const items = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
        const workbench = await workbenchData
        const runs = includeHistory ? await store.list().catch(() => []) : []
        const counts = new Map()
        for (const run of runs) {
          if (!run) continue
          const owner = run.parentSessionId ?? run.ownerSessionId
          if (typeof owner !== 'string') continue
          const entry = counts.get(owner) ?? { runs: 0, artifacts: 0 }
          entry.runs += 1
          entry.artifacts += countReportArtifacts(run.report)
          counts.set(owner, entry)
        }
        const own = items
          .filter(item => consoleOwns(item, workbench))
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
          .slice(0, limit)
        return Promise.all(own.map(async item => ({
          sessionId: item.sessionId,
          updatedAt: item.updatedAt ?? null,
          running: item.running === true,
          blank: item.blank === true,
          cwd: path.resolve(item.cwd),
          runs: counts.get(item.sessionId)?.runs ?? 0,
          artifacts: counts.get(item.sessionId)?.artifacts ?? 0,
          first: item.blank || !includeHistory ? null : await firstUserText(item.sessionId, item.updatedAt),
          title: item.projections?.values?.sessionTitle ?? item.projections?.values?.title ?? null,
        })))
      },

      async workbench(sessionId, { query = '', limit = 20, includeImpact = true, scope = 'project' } = {}) {
        await ready
        if (stateError) throw stateError
        const { name, sessions: tracked, projects: registered } = await workbenchData
        const sessions = await this.listSessions({ limit: Infinity, includeHistory: false })
        const bySession = new Map(sessions.map(session => [session.sessionId, session]))
        const projects = [...new Set([...registered, ...Object.values(tracked)])].filter(cwd => cwd !== consoleRoot).map(cwd => ({
          cwd, name: path.basename(cwd) || cwd,
          sessionId: sessions.find(session => session.cwd === cwd)?.sessionId ?? null,
        }))
        const cwd = bySession.get(sessionId)?.cwd ?? consoleRoot
        const project = projects.find(entry => entry.cwd === cwd) ?? null
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
        const ownedRuns = (await store.list()).filter(run => bySession.has(run.parentSessionId ?? run.ownerSessionId) && run.origin?.role !== 'decompose')
        const ownedGoals = (await longGoal.list()).filter(goal => bySession.has(goal.ownerSessionId)).map(goalView)
        const matches = text => terms.every(term => text.toLowerCase().includes(term))
        const globalScope = scope === 'global'
        const scopedRuns = globalScope ? ownedRuns : ownedRuns.filter(run => !project || bySession.get(run.parentSessionId ?? run.ownerSessionId).cwd === project.cwd)
        const matchingRuns = scopedRuns.filter(run => matches(`${run.id} ${run.goal} ${run.report ?? ''}
          ${(run.subtasks ?? []).flatMap(task => (task.deliverables ?? []).filter(file => file.status === 'verified')
            .map(file => file.path ?? file.name ?? '')).join(' ')}`))
        const matchingRunIds = new Set(matchingRuns.map(run => run.id))
        const matchingGoals = new Set(matchingRuns.filter(run => run.origin?.kind === 'long-goal').map(run => run.origin.goalId))
        const goals = ownedGoals
          .filter(goal => globalScope || !project || bySession.get(goal.ownerSessionId).cwd === project.cwd)
          .filter(goal => matches(`${goal.id} ${goal.title ?? ''} ${goal.goal}`) || matchingGoals.has(goal.id))
          .filter((goal, index) => index < limit || (!query && ['running', 'planning', 'needs-decision', 'paused'].includes(goal.status)))
        const impacts = includeImpact && goals.length ? await readTaskImpacts(goals.map(goal => {
          const ownerCwd = bySession.get(goal.ownerSessionId).cwd
          return { ...goal, project: ownerCwd === consoleRoot ? null : ownerCwd }
        })) : []
        for (const [index, impact] of impacts.entries()) {
          if (impact) goals[index].impact = impact
        }
        const phaseIds = new Set(goals.filter(goal => !goal.batch).flatMap(goal => goal.phases.map(phase => phase.runId)))
        const runs = scopedRuns.filter(run => matchingRunIds.has(run.id) || phaseIds.has(run.id))
          .filter((run, index) => index < limit || phaseIds.has(run.id) || (!query && ACTIVE_STATUSES.has(run.status)))
          .map(run => runView(run))
        const projectsByPath = new Map(projects.map(entry => [entry.cwd, entry]))
        const sessionProjects = Object.fromEntries(sessions.map(session => [session.sessionId, projectsByPath.get(session.cwd) ?? null]))
        const goalIds = new Set(ownedGoals.map(goal => goal.id))
        const summaryTasks = [...ownedGoals, ...ownedRuns.filter(run =>
          !goalIds.has(run.goalId)
          && !(run.origin?.kind === 'long-goal' && goalIds.has(run.origin.goalId)))]
        const now = new Date()
        const sameDay = value => {
          const time = Date.parse(value)
          if (!Number.isFinite(time)) return false
          const date = new Date(time)
          return date.getFullYear() === now.getFullYear()
            && date.getMonth() === now.getMonth()
            && date.getDate() === now.getDate()
        }
        const finishedToday = task => sameDay(task.finishedAt) || (!task.finishedAt && sameDay(task.createdAt))
        const summary = globalScope ? {
          added: summaryTasks.filter(task => sameDay(task.createdAt)).length,
          active: summaryTasks.filter(task => ACTIVE_STATUSES.has(task.status) || task.status === 'verifying').length,
          completed: summaryTasks.filter(task => ['completed', 'partial'].includes(task.status) && finishedToday(task)).length,
          failed: summaryTasks.filter(task => ['failed', 'cancelled', 'stopped', 'interrupted'].includes(task.status) && finishedToday(task)).length,
          decisions: summaryTasks.filter(task => task.status === 'needs-decision' || task.attention?.length).length,
          artifacts: collectArtifacts(ownedRuns, sessionProjects).filter(item => sameDay(item.at)).length,
        } : null
        const preferences = await notificationPreferences.read()
        const notificationCenter = aggregateNotificationCenter({
          runs: ownedRuns,
          goals: ownedGoals,
          approvals: [],
          artifacts: collectArtifacts(ownedRuns, sessionProjects),
          preferences,
        })
        const revision = notificationRevision(preferences)
        const assistant = await profileStore.get('global-assistant').catch(() => null)
        return { name, project, projects, runs, goals, inbox: workbenchNotificationInbox(notificationCenter),
          brief: notificationCenter.dailyBrief, preferences, revision, notificationCenter,
          assistantStatus: {
            name: assistant?.name ?? '全局助理', avatar: assistant?.avatar ?? null,
            model: assistant?.model ? `${assistant.provider ? `${assistant.provider}/` : ''}${assistant.model}`
              : cfg.provider === 'remote' ? cfg.remoteWorker?.model ?? '远程模型' : '跟随宿主',
            permissions: assistant?.permissions?.length ? assistant.permissions.join('、') : '宿主审批策略',
            im: cfg.sources?.feishu?.outbound?.appId && cfg.sources?.feishu?.outbound?.appSecret ? '飞书已配置' : '飞书未配置',
          },
          sessionProjects, summary, canPickProject: Boolean(directoryPicker), globalSessionId: sessions.find(session => session.cwd === consoleRoot)?.sessionId ?? null }
      },

      async pickProject(signal) {
        if (!directoryPicker) throw new Error('此宿主未挂载本地文件夹选择器')
        return directoryPicker.pick(signal)
      },

      async registerProject(cwd) {
        const directory = await projectDirectory(cwd)
        if (directory !== consoleRoot) await saveWorkbench(data => {
          if (!data.projects.includes(directory)) data.projects.push(directory)
        })
        return directory === consoleRoot ? null : { cwd: directory, name: path.basename(directory) || directory }
      },

      async nameWorkbench(name) {
        const next = await saveWorkbench(data => { data.name = name })
        return { name: next.name }
      },

      /**
       * Session list plus the run rows the sidebar needs. The rows are the same
       * runView the message stream uses; the sidebar only groups them per
       * session, it does not keep a queue of its own.
       */
      async listSchedules() {
        const sessions = await this.listSessions({ limit: Infinity, includeHistory: false })
        const all = await store.list().catch(() => [])
        const bySession = new Map()
        for (const run of all) {
          if (!run || run.origin?.kind !== 'scheduled') continue
          const owner = run.parentSessionId ?? run.ownerSessionId
          if (typeof owner !== 'string') continue
          const list = bySession.get(owner) ?? []
          list.push(run)
          bySession.set(owner, list)
        }
        return sessions.map(session => ({
          ...session,
          rows: (bySession.get(session.sessionId) ?? []).slice(-30).map(run => runView(run)),
        }))
      },

      /**
       * One conversation's log, newest page first and then walked back to the
       * first turn. The controller reads cold sessions too, so a conversation
       * the console has never shown can still be reopened.
       */
      async readSessionEvents(sessionId) {
        const records = await readSessionRecords(sessionId)
        return records === null ? null : records.slice(-600)
      },

      /**
       * Resolve a conversation this console may show. Only sessions created in
       * the console space qualify, so the page cannot wander into the user's own
       * sessions by guessing an id.
       */
      async openSession(sessionId) {
        const id = typeof sessionId === 'string' ? sessionId.trim() : ''
        if (!id) return null
        const controller = getSessionController()
        if (!controller || typeof controller.list !== 'function') return null
        const listed = await controller.list()
        const items = Array.isArray(listed) ? listed : Array.isArray(listed?.items) ? listed.items : []
        const workbench = await workbenchData
        const hit = items.find(item => item?.sessionId === id && consoleOwns(item, workbench))
        return hit ? { sessionId: id, updatedAt: hit.updatedAt ?? null } : null
      },

      async answer({ sessionId, runId, attentionId, answer }) {
        await ready
        const run = await store.read(runId)
        if (!run || (run.parentSessionId ?? run.ownerSessionId) !== sessionId) throw new Error('找不到会话中的对应问题')
        let agent = conversationAgent(sessionId)
        if (!agent) {
          const session = getSessionController()
          if (session && typeof session.resolveAgent === 'function') {
            const resolved = await session.resolveAgent(sessionId)
            agent = resolved?.agent ?? null
          }
        }
        if (!agent) {
          throw new Error('the conversation agent is no longer live; reopen the conversation before answering')
        }
        const timeZone = (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone
          } catch {
            return undefined
          }
        })()
        const result = await answerAttention({ runId, attentionId, answer }, agent, timeZone)
        return {
          runId: result?.run?.id ?? runId,
          attentionId: result?.attentionId ?? attentionId,
          status: result?.run?.status ?? null,
          resumed: result?.resumed === true,
          effect: result?.effect?.detail ?? null,
        }
      },

      subscribe(sessionId, listener) {
        const session = getSessionController()
        if (!session || typeof session.follow !== 'function') {
          throw new Error('sessionController.follow is not available')
        }
        const controller = new AbortController()
        let closed = false
        const emit = frame => {
          if (!closed) listener(frame)
        }
        ;(async () => {
          for await (const frame of session.follow({
            address: { kind: 'session', sessionId },
            assistantStream: true,
          }, controller.signal)) {
            if (closed) break
            if (frame?.type === 'snapshot') {
              emit({
                type: 'stream.snapshot',
                header: frame.header,
                cursor: frame.cursor,
                records: Array.isArray(frame.records) ? frame.records.slice(-200) : [],
                hasMore: frame.hasMore === true,
              })
            } else if (frame?.type === 'event') {
              emit({ type: 'session.event', event: frame.event })
            } else if (frame?.type === 'assistant-stream') {
              emit({ type: 'assistant.frame', frame: frame.frame })
            }
          }
        })().catch(error => {
          if (!closed) {
            emit({ type: 'error', code: 'follow-failed', message: error?.message ?? String(error) })
          }
        })
        if (typeof session.observeState === 'function') {
          ;(async () => {
            for await (const state of session.observeState({ sessionId }, controller.signal)) {
              if (closed) break
              emit({ type: 'session.state', state })
            }
          })().catch(error => {
            if (!closed) {
              emit({ type: 'error', code: 'state-failed', message: error?.message ?? String(error) })
            }
          })
        }
        return () => {
          closed = true
          controller.abort()
        }
      },
    }

    searchWorkbenchHistory = async (sessionId, query, limit) => {
      const { runs } = await consoleHost.workbench(sessionId, { query, limit })
      return runs.length ? runs.map(run => `- ${run.id} [${run.status}] ${run.goal.slice(0, 180)}\n  ${(run.output ?? run.report ?? '').slice(0, 500)}`).join('\n')
        : 'No matching tasks or deliverables in the visible workbench history.'
    }

    function taskProgress(goal) {
      const phases = goal.phases ?? []
      const current = phases.filter(phase => phase.status === 'running').map(phase => phase.title).join('、')
      return phases.length ? `${phases.filter(phase => phase.status === 'completed').length}/${phases.length} 阶段完成${current ? `，正在处理 ${current}` : ''}` : ''
    }

    async function routerCatalog() {
      const bench = await consoleHost.workbench(null, { limit: Infinity, includeImpact: false })
      const project = id => bench.sessionProjects[id]?.cwd ?? null
      const goals = new Set(bench.goals.map(goal => goal.id))
      return {
        projects: bench.projects.some(item => item.cwd === consoleRoot)
          ? bench.projects : [{ name: path.basename(consoleRoot) || consoleRoot, cwd: consoleRoot }, ...bench.projects],
        tasks: [
          ...bench.goals.map(goal => ({
            ...goal, kind: 'goal', project: project(goal.ownerSessionId), routed: Boolean(goal.routerRequestId), progress: taskProgress(goal),
          })),
          ...bench.runs.map(run => ({
            ...run, kind: 'run', project: project(run.parentSessionId), phase: goals.has(run.goalId),
          })),
        ],
      }
    }

    const routerStatus = {
      planning: '规划中', queued: '排队中', running: '进行中', aggregating: '汇总中',
      'needs-decision': '等你决定', completed: '已完成', partial: '部分完成',
      paused: '已暂停', interrupted: '已中断', failed: '失败', cancelled: '已取消', 'budget-stopped': '已达到预算上限',
    }
    const taskLine = task => `「${(task.title || task.goal).slice(0, 64)}」${routerStatus[task.status] ?? task.status}${task.progress ? ` · ${task.progress}` : ''}`

    async function executeRoute(decision, catalog) {
      const { action, target, phaseId, project, text, requestId, preferences, title, snapshot, batch,
        deliveredReply, phases: approvedPhases, budget: approvedBudget, model: approvedModel,
        permissionScope: approvedPermissions, runtime: approvedRuntime, planDigest, execution,
        schedule, decisionId, answer, note } = decision
      const task = target ? catalog.tasks.find(item => item.id === target && item.project === project) : null
      if (target && !task) throw new Error('这项任务已无法定位，请从任务列表选择。')
      const selected = catalog.tasks.filter(item => !item.phase && (!project || item.project === project))
      if (action === 'answer-decision') {
        if (!task || task.kind !== 'goal') throw new Error('请指定需要回答决策的长期任务。')
        if (typeof decisionId !== 'string' || !decisionId || answer === undefined) {
          throw new Error('answer-decision requires decisionId and answer')
        }
        const sessionId = conversationConsole.sessionId
        const parent = sessionId ? await resolveConversationAgent(sessionId) : null
        if (!parent) throw new Error('当前对话没有可用的宿主 session，无法恢复任务执行。')
        const goal = await longGoal.answer(task.id, decisionId, answer, { note, parent })
        return { text: `已记录决策，任务继续推进。`, taskId: task.id, receipt: 'answered', status: goal.status }
      }
      if (action === 'schedule') {
        const spec = schedule && typeof schedule === 'object' ? schedule : decision
        const trigger = spec.triggerType === 'every'
          ? { type: 'every', everyMs: Number(spec.everyMs) || 3_600_000 }
          : spec.triggerType === 'source'
            ? { type: 'source', source: spec.source ?? 'github', eventTypes: Array.isArray(spec.eventTypes) ? spec.eventTypes : [] }
            : { type: 'cron', cron: spec.cron ?? '0 9 * * *', timeZone: spec.timeZone ?? 'Asia/Shanghai' }
        const rule = normalizeAutomationRule({
          name: String(spec.name ?? title ?? '自动定时任务').slice(0, 80),
          description: `从对话创建：${String(text ?? '').slice(0, 200)}`,
          trigger,
          action: { type: 'run', prompt: String(spec.prompt ?? text ?? '').trim() },
          output: { relativePath: spec.relativePath ?? 'artifacts/automation.md' },
          notify: { events: ['completed', 'failed'] },
          budget: { maxRuns: 100, maxModelCalls: 20, maxTokens: 100_000, maxCost: spec.budget?.maxCost ?? 1 },
          enabled: true,
        })
        assertAutomationSchedule(rule)
        const saved = await automationStore.create(rule)
        const scheduleId = await syncAutomationSchedule(saved)
        return { text: `已创建自动化 ${saved.id}：${saved.name}`, taskId: saved.id, receipt: 'scheduled', schedule: { ...saved, scheduleId } }
      }
      if (action === 'batch' && (!Array.isArray(batch) || batch.length === 0)) throw new Error('batch requires a nonempty items array')
      if (action === 'task' || action === 'batch') {
        const prior = catalog.tasks.find(item => item.routerRequestId === requestId)
        if (approvedRuntime?.cwd && project && path.resolve(approvedRuntime.cwd) !== path.resolve(project)) {
          throw new Error('批准计划的运行目录与项目不一致')
        }
        if (Number.isSafeInteger(approvedBudget?.maxTasks) && approvedPhases?.length > approvedBudget.maxTasks) {
          throw new Error('批准计划的子任务数超过预算上限')
        }
        const direct = action === 'task' && execution !== 'planned' && !approvedPhases && !batch
        const workspace = project ?? consoleRoot
        const context = snapshot ? {
          messages: snapshot.messages ?? [], facts: snapshot.facts ?? [], artifacts: snapshot.artifacts ?? [],
        } : null
        const ontologyContext = await repositoryContext(workspace, text)
        const goalText = [text,
          context ? `Context from recent conversation and task facts:\n${JSON.stringify(context)}` : '',
          ontologyContext].filter(Boolean).join('\n\n')
        if (direct) {
          if (prior) return { text: '这项任务已登记，正在直接执行。', taskId: prior.id, receipt: 'registered' }
          const session = await consoleHost.createSession({ cwd: project ?? undefined, taskKey: requestId, title: title ?? text })
          const parent = await resolveConversationAgent(session.sessionId)
          if (!parent) throw new Error('当前对话没有可用的宿主 session，无法直接执行任务。')
          const run = await orchestrator.start({
            goal: goalText,
            parentSessionId: session.sessionId,
            parent,
            mode: 'direct',
            origin: { kind: 'router', routed: true, requestId },
            ...(approvedBudget ? { overrides: {
              ...(Number.isSafeInteger(approvedBudget.maxModelCalls) && approvedBudget.maxModelCalls > 0 ? { maxModelCalls: approvedBudget.maxModelCalls } : {}),
              ...(Number.isSafeInteger(approvedBudget.maxTokens) && approvedBudget.maxTokens > 0 ? { maxTokens: approvedBudget.maxTokens } : {}),
            } } : {}),
            ...(approvedModel ? { model: approvedModel } : {}),
            ...(approvedPermissions ? { permissionScope: approvedPermissions } : {}),
            ...(approvedRuntime ? { runtime: approvedRuntime } : {}),
            ...(planDigest ? { planDigest } : {}),
          })
          return { text: '已接下这项任务，正在直接执行。', taskId: run.id, receipt: 'registered' }
        }
        const phases = approvedPhases ?? batch?.map(item => ({
          title: item.objective.slice(0, 100),
          objective: item.file ? `${item.objective}\nDeliver a nonempty file at ${JSON.stringify(item.file)} in the workspace.` : item.objective,
          acceptance: item.file ? [{ text: `交付非空文件 ${item.file}`,
            check: { type: 'file', path: item.file, workspaceFile: true } }]
            : [{ text: 'The report delivers a concrete result backed by evidence for this item.' }],
        }))
        const taskId = prior?.id ?? (await consoleHost.createGoal(
          (await consoleHost.createSession({ cwd: project ?? undefined, taskKey: requestId, title: title ?? text })).sessionId,
          goalText, { routerRequestId: requestId, title, contextSnapshot: snapshot, projectRules: (preferences ?? []).map(entry => entry.text),
            ...(deliveredReply ? { deliveredReply } : {}),
            ...(phases ? { batch: !approvedPhases, phases } : {}),
            ...(approvedBudget ? { budget: {
              ...(Number.isSafeInteger(approvedBudget.maxModelCalls) && approvedBudget.maxModelCalls > 0 ? { maxModelCalls: approvedBudget.maxModelCalls } : {}),
              ...(Number.isSafeInteger(approvedBudget.maxTokens) && approvedBudget.maxTokens > 0 ? { maxTokens: approvedBudget.maxTokens } : {}),
            } } : {}),
            ...(approvedModel ? { model: approvedModel } : {}),
            ...(approvedPermissions ? { permissionScope: approvedPermissions } : {}),
            ...(approvedRuntime ? { runtime: approvedRuntime } : {}),
            ...(planDigest ? { planDigest } : {}) },
        )).id
        return { text: batch ? `已登记「${title}」的 ${batch.length} 项工作，后台将按可用并发逐项推进。`
          : '已接下这项任务。我会在后台推进。', taskId, receipt: 'registered' }
      }
      if (action === 'search' || action === 'status') {
        const terms = text.toLowerCase().split(/\s+/).filter(Boolean)
        const phaseMatches = new Set(catalog.tasks.filter(item => item.phase && terms.every(term =>
          `${item.goal} ${item.report ?? ''} ${(item.artifacts ?? []).map(file => file.name ?? file.href).join(' ')}`.toLowerCase().includes(term)
        )).map(item => item.goalId))
        const matches = task ? [task] : action === 'status' ? selected.filter(item =>
          ['planning', 'queued', 'running', 'aggregating', 'needs-decision', 'paused', 'interrupted'].includes(item.status))
          : selected.filter(item => phaseMatches.has(item.id) || terms.every(term =>
            `${item.goal} ${item.report ?? ''} ${(item.artifacts ?? []).map(file => file.name ?? file.href).join(' ')}`.toLowerCase().includes(term)))
        const shown = matches.slice(0, 8)
        return { text: shown.length ? shown.map(taskLine).join('\n') : action === 'status' ? '当前没有进行中或待处理的任务。' : '没有找到匹配的任务或交付。', taskIds: shown.map(item => item.id) }
      }
      if (!task) throw new Error('请告诉我要操作哪项任务。')
      if (action === 'followup') {
        if (task.kind === 'goal') {
          const goal = await longGoal.instruct(task.id, text, requestId, phaseId, { fromSource: decision.origin === 'source' })
          const instruction = goal.instructions?.find(item => item.id === requestId)
          const targets = instruction?.targets ?? []
          const scope = phaseId ? goal.phases.find(phase => phase.id === phaseId)?.title : goal.title
          const where = scope ? `「${scope}」` : '这项任务'
          const receipt = instruction?.reopened?.length
            ? `已记下补充要求，并重新安排${where}中停在技术细节上的阶段。`
            : targets.some(item => item.status === 'delivered')
            ? `已把补充要求写入${where}的执行记录。可在任务详情查看何时生效。`
            : `已将补充要求记入${where}，可在任务详情查看登记与送达状态。`
          return { text: receipt, taskId: task.id, receipt: targets.some(item => item.status === 'delivered') ? 'delivered' : 'registered' }
        }
        await consoleHost.instructRun(task.parentSessionId, task.id, { mode: 'followup', text, requestId })
        return { text: '这条要求已送到指定任务，执行方会在下一次运行或汇总时读取。', taskId: task.id, receipt: 'delivered' }
      }
      if (task.kind === 'goal') {
        const actionName = action === 'stop' ? 'cancel' : action
        if (actionName === 'cancel' || (actionName === 'pause' && task.status !== 'paused')
          || (actionName === 'resume' && task.status === 'paused')) {
          await consoleHost.actOnGoal(task.ownerSessionId, task.id, actionName, {})
        }
      } else if (action === 'stop') {
        const result = await consoleHost.cancelRun(task.parentSessionId, task.id)
        if (result?.cancelPending) return { text: '已发出停止请求，正在等待执行方确认。', taskId: task.id }
      } else {
        throw new Error('这条执行记录支持停止。暂停和继续请从所属任务操作。')
      }
      return { text: action === 'stop' ? '已处理这项任务的停止请求。'
        : action === 'pause' ? '已暂停这项任务的新阶段。' : '这项任务可以继续推进。', taskId: task.id }
    }

    const sourceStore = createSourceStore({ root: path.join(store.root, 'sources'), log })
    const shareStore = createShareStore({ dir: path.join(store.root, 'shares'), actor: 'local' })
    const skillImporter = createSkillImporter({
      skillsDir: cfg.skillImport.skillsDir ?? path.join(store.root, 'skills'),
    })
    const importedSkills = createImportedSkillProvider({
      skills: getOptionalService('skills'), importer: skillImporter,
    })
    let marketClient = null
    let marketClientError = null
    if (cfg.market) {
      try {
        marketClient = createMarketClient({ ...cfg.market, host: null })
      } catch (error) {
        marketClientError = error
        log(`market client is unavailable: ${error?.message ?? error}`)
      }
    }

    const outbound = cfg.sources?.feishu?.outbound
    const feishuClient = outbound?.appId && outbound?.appSecret
      ? createFeishuClient({ credentials: { appId: outbound.appId, appSecret: outbound.appSecret },
        fetchImpl: outbound.fetchImpl, log })
      : null
    const feishuOutbox = feishuClient ? createFeishuOutbox({
      stateFile: path.join(store.root, 'feishu-outbox.json'), client: feishuClient,
      bindingStore: sourceStore, log,
    }) : null
    if (feishuOutbox) {
      feishuOutbox.recover({ force: true }).then(() => feishuOutbox.flush({ limit: 50 })).catch(error =>
        log(`Feishu outbox recovery failed: ${error?.message ?? error}`))
    }
    const feishuTopics = new Map()

    function requireMarketClient() {
      if (!marketClient) {
        const error = new Error(marketClientError?.message ?? 'market is not configured with caller-pinned trusted public keys')
        error.code = 'MARKET_UNAVAILABLE'
        throw error
      }
      return marketClient
    }

    function safeFeishuSummary(summary, fallback) {
      const safe = redactSensitiveText(summary)
        .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)(?:[^\s"'<>()[\]]+[\\/])*[^\s"'<>()[\]]+/g, '[path]')
        .replace(/```/g, '')
        .replace(/(?:完整报告|完整输出|完整正文|原始报告|附件报告|full\s+report)/gi, '结果摘要')
        .replace(/(?:stack\s*trace|traceback|堆栈|调用栈)/gi, '错误摘要')
        .slice(0, 800)
      const checked = validateFeishuSummary(safe)
      return checked.ok ? checked.text : fallback
    }

    async function enqueueFeishu(source, { kind, summary, taskId = null }) {
      if (!feishuOutbox || source?.source !== 'feishu' || !source.messageId || !source.objectId) return null
      const binding = await sourceStore.findBinding({ source: 'feishu', instanceId: source.instanceId,
        objectId: source.objectId })
      if (!binding || (source.bindingId && binding.id !== source.bindingId)) return null
      const checked = validateFeishuSummary(safeFeishuSummary(summary, '消息已收到，请查看任务详情。'))
      const record = await feishuOutbox.enqueue({
        source: 'feishu', instanceId: source.instanceId, objectId: source.objectId,
        bindingId: binding.id, messageId: source.messageId, kind, summary: checked.text,
        idempotencyKey: feishuIdempotencyKey({ source: 'feishu', instanceId: source.instanceId,
          objectId: source.objectId, messageId: source.messageId, kind }),
      })
      await auditConsoleAction(`feishu.${kind}.enqueue`, taskId ?? binding.taskId, { bindingId: binding.id })
      await feishuOutbox.flush({ limit: 20 }).catch(error =>
        log(`Feishu outbox flush failed: ${error?.message ?? error}`))
      return record
    }

    async function reconcileFeishuTerminals() {
      if (!feishuOutbox || feishuTopics.size === 0) return
      for (const [taskId, source] of [...feishuTopics]) {
        const goal = await longGoal.get(taskId).catch(() => null)
        if (!goal || !['completed', 'failed', 'cancelled', 'partial', 'budget-stopped'].includes(goal.status)) continue
        const detail = goal.phases?.at(-1)?.summary ?? goal.stoppedReason?.detail ?? ''
        const summary = `任务 ${taskId} 已结束（${goal.status}）。${detail}`.slice(0, 800)
        await enqueueFeishu(source, { kind: 'terminal', summary, taskId })
        feishuTopics.delete(taskId)
      }
    }

    const feishuTerminalTimer = feishuOutbox
      ? setInterval(() => { reconcileFeishuTerminals().catch(error => log(`Feishu terminal reconcile failed: ${error?.message ?? error}`)) }, 1000)
      : null
    feishuTerminalTimer?.unref?.()
    if (feishuTerminalTimer && typeof ctx.effect === 'function') {
      ctx.effect(() => () => clearInterval(feishuTerminalTimer), 'dsh-superagent feishu terminal reconciler')
    }

    async function scheduledStatus(runId) {
      if (!String(runId).startsWith('router:')) return orchestrator.status(runId)
      const requestId = String(runId).slice('router:'.length)
      if (!activeRouter) return { id: runId, status: 'queued', usage: null }
      const command = await activeRouter.getCommand(requestId)
      const executions = await automationStore.listExecutions({ limit: 10000 })
      const execution = executions.find(item => item.result?.requestId === requestId)
      if (execution && ['completed', 'failed', 'cancelled', 'budget-stopped'].includes(execution.status)) {
        return { id: runId, status: execution.status, usage: { modelCalls: execution.usage?.modelCalls ?? 0,
          totalTokens: execution.usage?.tokens ?? 0 }, finishedAt: execution.finishedAt }
      }
      if (!command || !command.done) return { id: runId, status: command ? 'running' : 'queued', usage: null }
      const taskId = command.focusTaskId ?? command.sourceTaskId ?? command.target ?? command.decision?.target ?? null
      const catalog = await routerCatalog()
      const task = (catalog.tasks ?? []).find(item => item.id === taskId)
      if (!task) return { id: runId, status: 'failed', usage: null }
      const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'stopped', 'interrupted', 'budget-stopped'])
      return { id: runId, status: terminal.has(task.status) ? task.status : 'running',
        usage: { modelCalls: task.usage?.modelCalls ?? 0, totalTokens: task.usage?.totalTokens ?? task.usage?.tokens ?? 0 },
        finishedAt: terminal.has(task.status) ? task.finishedAt ?? null : null }
    }

    async function submitAutomationRule({ rule, text, project = null, requestId, idempotencyKey,
      source = null, record = true }) {
      if (!rule.enabled) {
        const error = new Error(`automation rule "${rule.id}" is disabled`)
        error.code = 'rule-disabled'
        throw error
      }
      if (record) {
        const prior = (await automationStore.listExecutions({ ruleId: rule.id, limit: 10000 }))
          .find(item => item.idempotencyKey === idempotencyKey)
        if (prior) return { ...prior, replayed: true }
      }
      const executionInput = buildAutomationExecutionInput({ rule, now: Date.now(), project })
      const accepted = await router.submit({
        id: requestId, text: executionInput.prompt, project,
        ...(rule.action.type === 'followup' ? {
          target: rule.action.taskId, intent: 'followup',
          ...(rule.action.phaseId ? { phaseId: rule.action.phaseId } : {}),
        } : { intent: 'task' }),
        ...(source ? { origin: 'source', source } : {}),
      })
      if (!record) return accepted
      const execution = await automationStore.recordExecution(rule.id, {
        idempotencyKey, status: 'queued', startedAt: new Date().toISOString(),
        result: { requestId: accepted.id, output: executionInput.output, notify: executionInput.notify },
      })
      publishAutomationExecution(rule, { ...execution, status: 'started' })
      return { ...execution, replayed: false }
    }

    const router = createRouter({
      root: store.root,
      catalog: routerCatalog,
      execute: executeRoute,
      log,
      async observe(observation) {
        if (!feishuOutbox) return
        if (observation.type === 'command.completed' && observation.source?.source === 'feishu') {
          const source = observation.source
          const receipt = observation.error ? '消息已收到，但处理未完成。请查看任务详情。'
            : observation.action === 'task' ? `已接新任务${observation.taskId ? ` ${observation.taskId}` : ''}，正在后台推进。`
              : observation.action === 'followup' ? `补充要求已送达${observation.taskId ? `任务 ${observation.taskId}` : '原任务'}。`
                : observation.action === 'status' ? `已查询任务状态${observation.taskIds?.length ? `，共 ${observation.taskIds.length} 项` : ''}。`
                  : null
          if (receipt) await enqueueFeishu(source, { kind: `receipt:${observation.action}`, summary: receipt,
            taskId: observation.taskId })
          if (observation.taskId) feishuTopics.set(observation.taskId, source)
          await reconcileFeishuTerminals()
        } else if (observation.type === 'task.terminal') {
          const source = feishuTopics.get(observation.taskId)
          if (!source) return
          const status = String(observation.status ?? 'ended')
          const summary = `任务 ${observation.taskId} 已结束（${status}）。${observation.summary ?? ''}`.slice(0, 800)
          await enqueueFeishu(source, { kind: 'terminal', summary, taskId: observation.taskId })
          feishuTopics.delete(observation.taskId)
        }
      },
      async classify(input, signal) {
        const llm = consoleService('llm')
        const defaults = consoleService('agentDefaultModel')?.currentSelection?.() ?? {}
        const assistant = await profileStore.get('global-assistant').catch(() => null)
        if (assistant?.enabled === false) throw new Error('全局助理档案已停用')
        const provider = assistant?.model ? assistant.provider ?? defaults.provider : cfg.plannerProvider ?? defaults.provider
        const model = assistant?.model ?? cfg.plannerModel ?? defaults.model
        if (!provider || !model || typeof llm?.stream !== 'function') throw new Error('请先在 DSH 中选好可用模型。')
        return readRouterDecision(llm.stream({
          provider, model, system: ROUTER_PROMPT, maxTokens: 1800, signal,
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }],
        }), { provider, model })
      },
    })
    activeRouter = router

    const executeSourceAutomation = async input => {
      const result = await submitAutomationRule(input)
      await auditConsoleAction('automations.source-run', input.rule.id, { eventKey: input.eventKey,
        executionKey: input.idempotencyKey })
      return result
    }

    const automationTerminalStatuses = new Set(['completed', 'partial', 'failed', 'cancelled', 'stopped', 'interrupted', 'budget-stopped'])
    function publishAutomationExecution(rule, execution) {
      if (!execution || !shouldNotifyAutomation(rule, execution.status)) return
      consoleApi?.publish({ type: 'notification', notification: {
        id: `automation:${execution.id}:${execution.status}`,
        event: execution.status === 'budget-stopped' ? 'budget' : execution.status,
        title: `自动化 · ${rule.name}`, body: execution.error?.message ?? execution.result?.summary ?? execution.status,
        at: execution.finishedAt ?? execution.startedAt ?? execution.scheduledAt, runId: execution.runId, read: false,
      } })
    }
    async function finishAutomationExecution(rule, execution, run, error = null) {
      const completed = completeAutomationExecution({ execution, run, error })
      if (!completed) return null
      const saved = await automationStore.completeExecution(rule.id, execution.id, {
        status: completed.status, finishedAt: completed.finishedAt, runId: completed.runId,
        usage: completed.usage, result: completed.result, error: completed.error,
      })
      if (saved) publishAutomationExecution(rule, saved)
      return saved
    }

    async function reconcileAutomationExecutions() {
      if (hostDisposed) return
      const [rules, executions, runs, catalog] = await Promise.all([
        automationStore.list(), automationStore.listExecutions({ limit: 10000 }), store.list(), routerCatalog(),
      ])
      const known = new Set(executions.map(item => item.idempotencyKey))
      for (const rule of rules) {
        if (!rule.enabled) continue
        const plans = await findAutomationPlans(rule)
        const planIds = new Set(plans.map(plan => plan.id))
        for (const run of runs.filter(item => item.origin?.kind === 'scheduled' && planIds.has(item.origin.scheduleId))) {
          const key = `scheduled:${run.origin.scheduleId}:${run.id}`
          if (known.has(key)) continue
          try {
            const execution = await automationStore.recordExecution(rule.id, {
              idempotencyKey: key, status: automationTerminalStatuses.has(run.status) ? 'running' : 'queued',
              scheduledAt: run.createdAt, startedAt: run.startedAt ?? run.createdAt, runId: run.id,
              result: { requestId: null, output: rule.output, notify: rule.notify },
            })
            known.add(key)
            if (!automationTerminalStatuses.has(run.status)) publishAutomationExecution(rule, { ...execution, status: 'started' })
            await finishAutomationExecution(rule, execution, run)
          } catch (error) {
            log(`automation ${rule.id} cannot record scheduled run ${run.id}: ${error?.message ?? error}`)
          }
        }
      }
      const tasks = new Map((catalog.tasks ?? []).map(task => [task.id, task]))
      for (const execution of executions.filter(item => ['queued', 'running'].includes(item.status))) {
        const rule = rules.find(item => item.id === execution.ruleId)
        const requestId = execution.result?.requestId
        if (!rule || !requestId) continue
        const command = await router.getCommand(requestId)
        if (!command?.done) continue
        const taskId = command.focusTaskId ?? command.sourceTaskId ?? command.target ?? command.decision?.target ?? null
        if (command.decision?.action === 'clarify') {
          await finishAutomationExecution(rule, execution, { status: 'failed', subtasks: [] }, { message: 'Router 需要澄清，自动化未执行' })
          continue
        }
        if (!taskId) {
          await finishAutomationExecution(rule, execution, { status: 'failed', subtasks: [] }, { message: 'Router 未创建可跟踪任务' })
          continue
        }
        if (command.decision?.action === 'followup') {
          const snapshot = await router.snapshot()
          const receipt = snapshot.messages.find(message => message.id === `reply-${requestId}`)?.receipt
          if (receipt === 'delivered') {
            await finishAutomationExecution(rule, execution, { id: taskId, status: 'completed', subtasks: [] })
            continue
          }
          const goal = await longGoal.get(taskId).catch(() => null)
          const instruction = goal?.instructions?.find(item => item.id === requestId)
          if (!instruction || instruction.targets.length === 0) {
            await finishAutomationExecution(rule, execution, { id: taskId, status: 'completed', subtasks: [] })
          } else if (instruction.targets.some(target => target.status === 'missed')) {
            await finishAutomationExecution(rule, execution, { id: taskId, status: 'failed', subtasks: [] },
              { message: '补充要求未能送达执行阶段' })
          } else if (instruction.targets.every(target => target.status === 'delivered')) {
            await finishAutomationExecution(rule, execution, { id: taskId, status: 'completed', subtasks: [] })
          }
          continue
        }
        const task = tasks.get(taskId)
        if (!task) continue
        if (!automationTerminalStatuses.has(task.status)) continue
        await finishAutomationExecution(rule, execution, { id: task.id, status: task.status,
          subtasks: task.phases ?? [], usage: task.usage, cost: task.cost })
      }
    }

    const automationTerminalTimer = setInterval(() => {
      reconcileAutomationExecutions().catch(error => log(`automation reconciliation failed: ${error?.message ?? error}`))
    }, 1000)
    automationTerminalTimer.unref?.()
    if (typeof ctx.on === 'function') ctx.on('dispose', () => clearInterval(automationTerminalTimer))
    if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(automationTerminalTimer), 'dsh-superagent automation reconciler')

    // First-batch host integrations. Every adapter is bound to the real store or
    // a lazily resolved host service; none manufactures a successful result when
    // that service is absent.
    const capabilityCenter = createCapabilityCenterAdapter({
      ctx,
      log,
      skills: () => getOptionalService('skills'),
      mcpManager: () => getOptionalService('mcpManager'),
      settings: () => getOptionalService('settings'),
      credentials: () => getOptionalService('credentials') ?? getOptionalService('credentials/authorization'),
      authorization: () => getOptionalService('authorization'),
      permissionPresets: () => getOptionalService('permissionPresets'),
      permissions: () => getOptionalService('permissions'),
    })
    const memoryCenter = createMemoryCenter({ memory, userMemory, router, longGoal })
    const costCenter = createCostCenter(store.root, { pricing: cfg.pricing, warn: log })
    const routePolicy = createRoutePolicy({ pricing: cfg.pricing, costCenter })
    const profileStore = createAgentProfileStore({ file: path.join(store.root, 'agent-profiles.json'), warn: log })
    const voiceService = createVoiceService({
      remote: {
        get speech() { return getOptionalService('remote')?.speech ?? null },
      },
    })
    const devicePairing = createDevicePairingStore({ file: path.join(store.root, 'devices.json'), warn: log })
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', async () => {
        await Promise.allSettled([capabilityCenter.dispose(), devicePairing.dispose(), importedSkills.dispose?.(), repoWiki.dispose?.()])
      })
    }

    const sources = cfg.sources ? createSourceIngress({
      store: sourceStore,
      router,
      config: cfg.sources,
      catalog: routerCatalog,
      automationStore,
      executeAutomation: executeSourceAutomation,
      log,
    }) : null

    const restoreFeishuTopics = async () => {
      if (!feishuOutbox) return
      const snapshot = await router.snapshot()
      for (const topic of snapshot.sourceTopics ?? []) feishuTopics.set(topic.taskId, topic.source)
    }

    readTaskDecisions = async (goal, phaseId) => {
      if (!goal.routerRequestId) return []
      const confirmed = await router.taskFacts({ ...goal, project: goal.cwd === consoleRoot ? null : goal.cwd }, phaseId)
      return confirmed.filter(item => !item.phaseId || item.phaseId === phaseId)
    }
    readTaskImpacts = router.taskImpacts

    const conversationConsole = createConsole({
      port: cfg.consolePort,
      stateRoot: store.root,
      host: consoleHost,
      router,
      sources,
      feishuOutbox,
      version: pkg.version,
      log,
    })
    consoleApi = conversationConsole
    if (sources && cfg.consolePort === null) {
      log('sources are enabled but consolePort is off; webhook hooks are not mounted')
    }
    let consoleDisposed = false
    const stopConsole = () => {
      if (consoleDisposed) return Promise.resolve()
      consoleDisposed = true
      hostDisposed = true
      if (consoleApi === conversationConsole) consoleApi = null
      briefScheduler.stop()
      return conversationConsole.stop().catch(error => log(`cannot stop the console: ${error?.message ?? error}`))
    }
    if (typeof ctx.on === 'function') ctx.on('dispose', stopConsole)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => stopConsole, 'dsh-superagent console')
    }
    ready
      .then(async () => {
        if (consoleDisposed || stateError) return null
        await restoreFeishuTopics().catch(error => log(`cannot restore Feishu topics: ${error?.message ?? error}`))
        return conversationConsole.start()
      })
      .then(result => {
        if (!result) return
        log(`console is listening on ${result.url}; the one-time token is in ${conversationConsole.discoveryPath}`)
        if (sources) {
          const enabled = ['github', 'feishu'].filter(source => cfg.sources?.[source]?.enabled)
          log(`source hooks ready: ${enabled.map(source => `${result.url}/hooks/${source}`).join(', ')}`)
        }
      })
      .catch(error => {
        log(
          `console is not listening: ${error?.message ?? error}; `
          + `check that consoleRoot (${consoleRoot}) exists, that consolePort is free, and that the state directory `
          + 'is writable, or remove consolePort to keep the console off',
        )
      })

    // Approvals asked inside this console's own conversation tree are put to the
    // person in the page; everything else keeps the host's normal answerer chain.
    // The bridge only relays the question — it never decides, and it fails closed
    // when no page is open, so nothing here widens what a tool may do.
    //
    // Registration is prepended and lives on the root event bus: the Web
    // assembly forwards `approval/request` to connected clients through its own
    // waterfall listener, and a listener that never calls `next()` would win by
    // order alone. Answering our own sessions first is what routes this tree's
    // ask to this page; every other session still falls through untouched.
    // Cordis exposes the root context under a well-known symbol, not a `root`
    // property; reading `ctx.root` makes the service resolver throw before the
    // bridge is even registered. Fall back to this plugin's own context so a
    // host that hides the symbol still keeps its normal answerer chain.
    const rootContext = (() => {
      try {
        const candidate = ctx[Symbol.for('cordis.root')]
        return candidate && typeof candidate.on === 'function' ? candidate : ctx
      } catch {
        return ctx
      }
    })()
    const approvalCtx = rootContext
    const bridgeApproval = (request, next) => {
      try {
        const session = request?.agent?.session
        // The console owns whichever session it created this run (the fixed space
        // id, or a fresh id when the host refuses that one), so the live id is read
        // back from the console instead of assumed.
        const consoleSessionId = conversationConsole.sessionId
        const belongs = id => typeof id === 'string'
          && (id === CONSOLE_SPACE_ID || id === consoleSessionId || panelSessions.has(id) || managedConsoleSessions.has(id))
        const parent = (() => {
          const raw = session?.parentSession
          return typeof raw === 'string' ? raw : raw?.id
        })()
        const ownerSessionId = belongs(session?.id) ? session.id : belongs(parent) ? parent : null
        if (!ownerSessionId) return next()
        if (typeof conversationConsole.askApproval !== 'function') return next()
        const callArguments = blockedCallArguments(session, request?.callId)
        const risk = approvalRisk(request?.toolName, callArguments)
        return conversationConsole.askApproval({
          toolName: request?.toolName,
          callId: request?.callId ?? null,
          reason: request?.reason ?? null,
          displayReason: request?.displayReason ?? null,
          agentId: request?.agent?.id ?? null,
          ownerSessionId,
          callArguments,
          riskSummary: risk.riskSummary,
          recommendation: risk.recommendation,
          source: belongs(session?.id) ? '主对话' : '子任务线',
        })
      } catch (error) {
        // A bridge that cannot even read the ask must not decide it: falling
        // through leaves the host's own answerers in charge (fail closed).
        log(`approval bridge skipped one ask: ${error?.message ?? error}`)
        return next()
      }
    }
    if (typeof approvalCtx.on === 'function') {
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => approvalCtx.on('approval/request', bridgeApproval, { prepend: true }), 'dsh-superagent approval bridge')
        } else {
          const off = approvalCtx.on('approval/request', bridgeApproval, { prepend: true })
          if (typeof off === 'function' && typeof ctx.on === 'function') {
            ctx.on('dispose', () => {
              try {
                off()
              } catch {
                // the bus is already gone; nothing left to release
              }
            })
          }
        }
      } catch (error) {
        log(`cannot listen for approvals: ${error?.message ?? error}`)
      }
    }

    // The browser half seats this console in the host's main panel. That frame
    // cannot read the discovery file, so one loopback route on the host's own
    // origin hands out the address and the one-time token. The path stays
    // outside `/api`: that prefix belongs to the connection gate, which answers
    // every unrouted request before plugin routes can see it. Registering this
    // is best-effort — a profile without a web server keeps every tool working
    // and the panel simply reports the console as unavailable.
    // `webServer` may mount after this plugin, so the route waits for it
    // through the loader's inject rather than reading it once at apply time.
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], webCtx => {
        try {
          webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: '/superagent/console-address',
            handler: (req, res) => {
              if ((req.method ?? 'GET') !== 'GET') {
                res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, message: 'only GET is allowed here' }))
                return
              }
              const address = conversationConsole.url
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(JSON.stringify({
                ok: true,
                data: {
                  ready: Boolean(address),
                  url: address,
                  token: conversationConsole.token,
                  reason: address ? null : 'the console is not listening yet; check consolePort and the state directory',
                },
              }))
            },
          }), 'dsh-superagent console address')
          // The main panel renders natively on the host origin, so it reaches
          // the loopback console through this prefix relay instead of a
          // cross-origin CDN-less fetch. The token stays server-side.
          webCtx.effect(() => webCtx.webServer.register({
            kind: 'prefix',
            path: '/superagent/api',
            handler: (req, res) => conversationConsole.proxy(req, res),
          }), 'dsh-superagent console proxy')
        } catch (error) {
          log(`cannot publish the console address route: ${error?.message ?? error}`)
        }
      })
    } else {
      log('this host has no inject(); the sidebar entry reports the console as unavailable')
    }
  }

  // The task board is the third loopback surface, and the first one written for
  // a person who does not read JSON. It never owns a run: every action resolves
  // the run's owning session and calls the same orchestrator method a tool call
  // would. On a host without a session service it still shows every run and
  // says, in Chinese, why its buttons are unavailable.
  if (cfg.boardPort !== null) {
    const boardRoot = cfg.boardRoot
      ? path.resolve(cfg.boardRoot)
      : cfg.consoleRoot
        ? path.resolve(cfg.consoleRoot)
        : workbenchRoot
    const boardSessionFile = path.join(store.root, 'board-session.json')

    const timeZoneOf = () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch {
        return undefined
      }
    }

    function boardCapabilities() {
      const session = getSessionController()
      if (!session) {
        return {
          start: false,
          answer: false,
          reason: '宿主没有挂载 sessionController，看板只能查看运行，不能替你回答或继续。',
        }
      }
      const missing = ['create', 'resolveAgent'].filter(name => typeof session[name] !== 'function')
      if (missing.length > 0) {
        return {
          start: false,
          answer: false,
          reason: `sessionController 缺少 ${missing.join(' / ')}，看板只能查看运行。`,
        }
      }
      if (!hasSubagents()) {
        return {
          start: false,
          answer: false,
          reason: '宿主没有 subagents 服务，无法从看板发起运行；查看和取消仍然可用。',
        }
      }
      return { start: true, answer: true, reason: null }
    }

    /** Prefer the live agent; reopen the session only when it is not loaded. */
    async function resolveAgentById(sessionId) {
      if (!sessionId) return null
      const live = getAgents()?.get?.(sessionId)
      if (live) return live
      const session = getSessionController()
      if (!session || typeof session.resolveAgent !== 'function') return null
      try {
        return (await session.resolveAgent(sessionId))?.agent ?? null
      } catch {
        return null
      }
    }

    /**
     * The board's own session, persisted so a host restart does not orphan
     * runs it started. A run's owner must stay the same session; that is why
     * this is a real session and not a synthetic agent.
     */
    async function boardSessionAgent() {
      const caps = boardCapabilities()
      if (!caps.start) throw new Error(caps.reason)
      let saved = null
      try {
        saved = JSON.parse(await fsp.readFile(boardSessionFile, 'utf8'))?.sessionId ?? null
      } catch {
        // First use, or a state directory that was cleaned.
      }
      let agent = await resolveAgentById(saved)
      if (agent) return agent
      const created = await getSessionController().create({
        cwd: boardRoot,
        ...(cfg.consolePreset ? { agentPreset: cfg.consolePreset } : {}),
      })
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (!sessionId) throw new Error('sessionController.create 没有返回 sessionId，无法从看板发起运行')
      await fsp.mkdir(path.dirname(boardSessionFile), { recursive: true })
      await fsp.writeFile(
        boardSessionFile,
        `${JSON.stringify({ sessionId, createdAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      )
      agent = await resolveAgentById(sessionId)
      if (!agent) {
        throw new Error('看板会话已经创建，但宿主没有把它变成可用 agent；请先在宿主里打开一次这个会话，再回来启动')
      }
      return agent
    }

    async function runOwnerAgent(run) {
      const agent = await resolveAgentById(run?.parentSessionId)
      if (!agent) {
        throw new Error(
          '这次运行的发起会话已经关闭，看板不能替你继续；请在宿主里重新打开那个会话，'
          + '或用 superagent_resume 从新会话恢复。',
        )
      }
      return agent
    }

    /**
     * Items that are not on a run record: a policy that held an operation for
     * confirmation, and a browser that stopped on a check only a person can do.
     */
    async function boardExtraInbox() {
      if (!auditor) return []
      let events = []
      try {
        events = (await auditor.query({ limit: 600, order: 'desc' })).events ?? []
      } catch (error) {
        log(`board: cannot read the audit trail: ${error?.message ?? error}`)
        return []
      }
      let runs = []
      try {
        runs = await store.list()
      } catch {
        // The run cards already cover this; the extras can stand without a goal.
      }
      const byId = new Map(runs.map(run => [run.id, run]))
      const approved = new Set(events
        .filter(event => event.kind === 'approved')
        .map(event => event.meta?.approves)
        .filter(Boolean))
      const items = []
      const seen = new Set()
      for (const event of events) {
        if (items.length >= 8) break
        if (event.decision === 'confirm' && event.result === 'pending' && !approved.has(event.id)) {
          const id = `permission:${event.id}`
          if (seen.has(id)) continue
          seen.add(id)
          items.push({
            id,
            kind: 'permission',
            kindLabel: '需要你授权',
            runId: event.runId ?? null,
            runGoal: event.runId ? byId.get(event.runId)?.goal ?? null : null,
            title: '有一个操作被权限策略拦下，等你点头',
            what: `被拦下的操作：${event.kind ?? '操作'} / ${event.action ?? ''}`
              + `${event.target ? ` → ${String(event.target).slice(0, 200)}` : ''}`,
            why: '策略要求人来确认这一次。它不是故障；拒绝也不会影响其他运行。',
            options: ['允许这次操作', '不允许'],
            impact: '允许后这一次操作会被放行，并记录是谁在什么时候批准的；不允许则保持拦截。',
            input: 'choice',
            canAnswer: true,
          })
          continue
        }
        if (event.kind !== 'attention' || event.result !== 'needs-human') continue
        const cleared = events.some(other => other.runId === event.runId
          && String(other.at ?? '') > String(event.at ?? '')
          && /await_human/i.test(String(other.action ?? '')))
        if (cleared) continue
        const id = `human:${event.runId}:${event.id}`
        if (seen.has(id) || !event.runId) continue
        seen.add(id)
        const goal = byId.get(event.runId)?.goal ?? null
        items.push({
          id,
          kind: 'human',
          kindLabel: '需要你亲自操作',
          runId: event.runId,
          runGoal: goal,
          title: '浏览器停在一个需要人完成的检查上',
          what: `运行${goal ? `「${String(goal).slice(0, 100)}」` : ''}停住了：${String(event.target ?? '页面检查').slice(0, 200)}。`
            + '验证码、扫码或登录只能由人完成，自动化到这一步就停下，不会替你点。',
          why: '让自动化硬闯检查既不可靠也不安全；停在这里是设计好的行为，不算失败。',
          options: ['我已经处理完成，继续'],
          impact: '告诉运行继续；它会重新检查页面，检查通过后接着做未完成的部分。',
          input: 'choice',
          canAnswer: true,
        })
      }
      return items
    }

    async function boardAnswerInbox({ id, answer }) {
      const [kind, runId, rest] = String(id ?? '').split(':')
      if (kind === 'permission') {
        if (!auditor) throw new Error('审计没有启用，无法记录这次授权')
        if (/不允许|拒绝|deny|reject/i.test(answer)) {
          return { message: '已记录你的拒绝，这次操作不会执行。' }
        }
        await auditor.approve(rest, {
          actor: 'board',
          note: 'approved from the task board',
          runId: runId || null,
          kind: 'board',
        })
        return { message: '已批准这次操作，回到刚才的步骤重试即可。' }
      }
      if (kind === 'human') {
        const run = await store.read(runId)
        if (!run) throw new Error('找不到这次运行，可能已经被清理')
        const agent = await runOwnerAgent(run)
        await orchestrator.followup(runId, '人工检查已完成，请继续。', agent)
        return { runId, message: '已通知运行继续，它会重新检查页面。' }
      }
      throw new Error('这条待办已经失效，请刷新页面')
    }

    const boardHost = {
      capabilities: boardCapabilities,

      async listRuns() {
        await ready
        if (stateError) throw stateError
        return (await store.list()).filter(run => run && typeof run === 'object' && run.id)
      },

      async readRun(runId) {
        await ready
        if (stateError) throw stateError
        return store.read(runId)
      },

      async answer({ runId, attentionId, answer }) {
        await ready
        if (stateError) throw stateError
        const run = await store.read(runId)
        if (!run) throw new Error('找不到这次运行，可能已经被清理')
        const agent = await runOwnerAgent(run)
        const result = await answerAttention({ runId, attentionId, answer }, agent, timeZoneOf())
        // A question answered from the board must leave the same evidence a
        // tool answer would: who answered, when, and the words they used.
        if (auditor && typeof auditor.record === 'function') {
          const text = String(answer ?? '').trim().slice(0, 1000)
          await auditor.record({
            runId: result?.run?.id ?? runId,
            subtaskId: attentionId ? String(attentionId) : 'planner',
            actor: agent?.id ? `session:${agent.id}` : 'board',
            kind: 'attention',
            action: 'attention.answer',
            target: text,
            result: result?.resumed === true ? 'resumed' : 'recorded',
            source: 'board',
            meta: {
              attentionId: attentionId ?? null,
              answer: text,
              effect: result?.effect?.detail ?? null,
            },
          }).catch(error => log(`audit: cannot record the board answer: ${error?.message ?? error}`))
        }
        return {
          runId: result?.run?.id ?? runId,
          attentionId: result?.attentionId ?? attentionId,
          status: result?.run?.status ?? null,
          resumed: result?.resumed === true,
          effect: result?.effect?.detail ?? null,
        }
      },

      async cancelSubtask({ runId, subtask }) {
        await ready
        if (stateError) throw stateError
        return orchestrator.cancelSubtask(runId, subtask)
      },

      async rerunSubtask({ runId, subtask }) {
        await ready
        if (stateError) throw stateError
        const run = await store.read(runId)
        if (!run) throw new Error('找不到这次运行，可能已经被清理')
        const agent = await runOwnerAgent(run)
        return orchestrator.rerunSubtask(runId, subtask, agent, timeZoneOf())
      },

      async reviewSubtask({ runId, subtask, verdict, note }) {
        await ready
        if (stateError) throw stateError
        const run = await store.read(runId)
        if (!run) throw new Error('找不到这次运行，可能已经被清理')
        const agent = await runOwnerAgent(run)
        return orchestrator.reviewSubtask(runId, subtask, verdict, agent, timeZoneOf(), note)
      },

      async resumeRun({ runId }) {
        await ready
        if (stateError) throw stateError
        const run = await store.read(runId)
        if (!run) throw new Error('找不到这次运行，可能已经被清理')
        const agent = await runOwnerAgent(run)
        return orchestrator.resume(runId, agent, timeZoneOf(), { reopen: true })
      },

      async startTemplate({ templateId, values }) {
        await ready
        if (stateError) throw stateError
        const caps = boardCapabilities()
        if (!caps.start) throw new Error(caps.reason)
        const template = await templates.get(templateId)
        if (!template) throw new Error(`没有 id 为「${templateId}」的模板，请刷新页面`)
        let expanded
        try {
          expanded = expandTemplate(template, values)
        } catch (error) {
          throw new Error(`模板参数不完整：${error?.message ?? error}`)
        }
        const agent = await boardSessionAgent()
        return orchestrator.start({
          goal: expanded.goal,
          parentSessionId: agent.id,
          parent: agent,
          clientTimeZone: timeZoneOf(),
        })
      },

      async templates() {
        const result = await templates.list()
        return result.templates ?? []
      },

      async auditFor({ runId, limit }) {
        if (!auditor) return []
        const result = await auditor.query({ runId, limit: limit ?? 200, order: 'asc' })
        return result.events ?? []
      },

      extraInbox: boardExtraInbox,
      answerInbox: boardAnswerInbox,
    }

    const taskBoard = createBoard({
      port: cfg.boardPort,
      stateRoot: store.root,
      host: boardHost,
      version: pkg.version,
      log,
    })
    let boardDisposed = false
    const stopBoard = () => {
      if (boardDisposed) return Promise.resolve()
      boardDisposed = true
      return taskBoard.stop().catch(error => log(`cannot stop the board: ${error?.message ?? error}`))
    }
    if (typeof ctx.on === 'function') ctx.on('dispose', stopBoard)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => stopBoard, 'dsh-superagent board')
    }
    ready
      .then(() => {
        if (boardDisposed || stateError) return null
        return taskBoard.start()
      })
      .then(result => {
        if (!result) return
        log(
          `task board is listening on ${result.url}; open ${result.url}/?token=`
          + `${taskBoard.token} (the same token is in ${taskBoard.discoveryPath})`,
        )
      })
      .catch(error => {
        log(
          `task board is not listening: ${error?.message ?? error}; `
          + `check that boardRoot (${boardRoot}) exists, that boardPort is free, and that the state directory `
          + 'is writable, or remove boardPort to keep the board off',
        )
      })
  }

  // A mounted plugin owns one timer; unmounting must not leave it firing into
  // a disposed orchestrator. The timer is unref'd, so it never keeps the host
  // alive on its own. Cleanup uses the dispose event rather than a second
  // effect: a host that exposes a single effect slot (as the plugin tests do)
  // must keep that slot for the control plane.
  const stopScheduler = () => {
    scheduler.stop()
    for (const handle of scheduleOwners) {
      handle.dispose().catch(error => log(`cannot dispose a scheduled-run session: ${error?.message ?? error}`))
    }
    scheduleOwners.clear()
  }
  if (typeof ctx.on === 'function') ctx.on('dispose', stopScheduler)
  if (typeof ctx.on === 'function') ctx.on('dispose', () => longGoal.close())

  log(
    `registered ${auditor ? 15 : 14} tools; state ${store.root}`
    + `${cfg.controlPort === null ? '' : `; control port ${cfg.controlPort}`}`
    + `${cfg.workbenchPort === null ? '' : `; workbench ${workbenchRoot} on port ${cfg.workbenchPort}`}`
    + `${cfg.consolePort === null ? '' : cfg.consolePort === 0 ? '; console on an ephemeral port' : `; console on port ${cfg.consolePort}`}`
    + `${cfg.boardPort === null ? '' : `; task board on port ${cfg.boardPort}`}`,
  )
}
