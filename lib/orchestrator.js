/**
 * Run orchestration for dsh-superagent.
 *
 * A run moves through queued -> planning -> running -> aggregating and ends in
 * completed, partial, failed, cancelled, or interrupted. Planning, subtask
 * execution, and aggregation all happen in child agents; this module owns
 * ordering, retries, quotas, cancellation, and durable status.
 *
 * A state directory can be shared by more than one host process (two profiles,
 * or a synced folder), so every decision about an active run is made from
 * persisted evidence — heartbeat, owner pid, and the run lock — and never from
 * this process's memory alone.
 *
 * The module has no host imports: `spawnChild`, `readUsage`, `notify`, and
 * `store` are injected, which keeps it testable without a running harness.
 *
 * @module dsh-superagent/orchestrator
 */
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from './store.js'

const STATUS_POLL_MS = 250
/** How often the owning process checks for a cancel marker written elsewhere. */
const CANCEL_POLL_MS = 1000
/** How long a cancel from another process waits for the owner to acknowledge. */
const CANCEL_ACK_MS = 5000
/** How often a live run refreshes its heartbeat in the state file. */
const HEARTBEAT_MS = 30 * 1000
/** A run with no heartbeat for this long is treated as orphaned. */
const ORPHAN_MS = 3 * HEARTBEAT_MS
/** A child that ignores abort must not hold a cancel call open forever. */
const DISPOSE_MS = 1500
/** Waking the owning session must not hold a finished run open forever. */
const NOTIFY_MS = 15 * 1000
/** A run lock older than this belongs to a process that never released it. */
const LOCK_STALE_MS = 10 * 60 * 1000

/**
 * Mint a sortable, filesystem-safe run id.
 * @returns {string} run id such as `20261114T051233-a1b2`.
 */
export function newRunId() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')
  return `${stamp}-${randomBytes(2).toString('hex')}`
}

function clamp(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/** Join the text blocks of a child result. */
export function textOf(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** Truncate a string to a UTF-8 byte budget without splitting a character. */
export function capText(text, maxBytes) {
  if (typeof text !== 'string') return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  // Cutting at an arbitrary byte can land inside a multi-byte character; the
  // decode then ends in U+FFFD. Drop that partial sequence instead of keeping
  // a replacement character in the user's report.
  const kept = buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')
  const omitted = buffer.length - Buffer.byteLength(kept, 'utf8')
  return `${kept}\n\n[truncated: ${omitted} bytes omitted]`
}

/**
 * Extract the first JSON object that carries a usable `subtasks` array.
 *
 * Models often wrap JSON in prose or code fences, so every balanced `{...}`
 * region is tried rather than assuming the reply is bare JSON.
 *
 * @param {string} text - planner reply.
 * @returns {Array<{ title: string, prompt: string }>} zero or more subtasks.
 */
export function extractPlan(text) {
  if (typeof text !== 'string') return []
  const candidates = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1))
          start = index
          break
        }
      }
    }
  }
  for (const candidate of candidates) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const raw = parsed?.subtasks
    if (!Array.isArray(raw)) continue
    const subtasks = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
      if (!prompt) continue
      const title = typeof item.title === 'string' && item.title.trim()
        ? item.title.trim().slice(0, 80)
        : prompt.slice(0, 60)
      subtasks.push({ title, prompt })
    }
    if (subtasks.length > 0) return subtasks
  }
  return []
}

/** Planner prompt for one goal. */
function plannerPrompt(goal, maxSubtasks) {
  return [
    'You are the planner for a long-horizon autonomous run.',
    '',
    'Goal:',
    goal,
    '',
    `Decompose the goal into at most ${maxSubtasks} subtasks that can run in parallel because none of them needs another subtask's output.`,
    'Each subtask is executed by a separate agent that sees only the prompt you write for it.',
    '',
    'Return ONLY a JSON object, with no prose and no code fences, in exactly this shape:',
    '{"subtasks":[{"title":"short title","prompt":"complete self-contained instruction"}]}',
    '',
    'Rules:',
    `- Use 2 to ${maxSubtasks} subtasks; use 1 only when the goal truly cannot be split.`,
    '- Every prompt must restate the context it needs; workers cannot see the goal text or each other.',
    '- Prefer concrete research, construction, or verification work over vague summaries.',
  ].join('\n')
}

/** Worker prompt for one subtask. */
function workerPrompt(run, subtask) {
  return [
    'You are one worker in a long-horizon autonomous run. Do not ask the user questions and do not wait for input.',
    '',
    'Overall goal:',
    run.goal,
    '',
    `Your assigned subtask (${subtask.title}):`,
    subtask.prompt,
    '',
    'Constraints:',
    '- Work only on your subtask; do not attempt the whole goal.',
    '- Use the tools you have. Never call a tool whose name starts with "superagent_".',
    '- Your final message IS the deliverable. Do not save the report to a file and do not reply with a',
    '  summary of what you did; write the findings themselves: concrete facts, numbers, file paths,',
    '  commands, and anything unresolved. Under 1500 words, Markdown only.',
  ].join('\n')
}

/** Aggregator prompt over completed subtask reports. */
function aggregatorPrompt(run, completed) {
  const sections = completed.map(subtask => [
    `### ${subtask.title}`,
    capText(subtask.result ?? '', 8000),
  ].join('\n')).join('\n\n')
  return [
    'You are the aggregator of a long-horizon autonomous run.',
    '',
    'Goal:',
    run.goal,
    '',
    'Subtask reports:',
    sections,
    '',
    'Write the final report for the user in Markdown as your entire reply:',
    '- Lead with the answer or outcome, then supporting detail. If the goal asks for a table, include the table.',
    '- Merge duplicate findings; when reports disagree, say so and state which evidence is stronger.',
    '- Call out what failed, what is unverified, and what the user should do next.',
    '- Do not invent facts that no report contains. Do not say the report is ready — write it. Maximum 1200 words.',
  ].join('\n')
}

/** Deterministic report used when no aggregator model call is available. */
function deterministicJoin(run) {
  const completed = (run.subtasks ?? []).filter(subtask => subtask.status === 'completed')
  if (completed.length === 0) return null
  const parts = [`# ${run.goal}`, '', `_Deterministic merge of ${completed.length} subtask report(s)._`, '']
  for (const subtask of completed) {
    parts.push(`## ${subtask.title}`, '', subtask.result ?? '', '')
  }
  return parts.join('\n').trim()
}

/** Run at most `limit` workers over `items` concurrently. */
async function pool(items, limit, worker) {
  if (items.length === 0) return
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

export function sumUsage(entries) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, modelCalls: 0, models: {} }
  for (const usage of entries) {
    if (!usage) continue
    total.inputTokens += usage.inputTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.totalTokens += usage.totalTokens ?? 0
    total.modelCalls += usage.modelCalls ?? 0
    for (const [model, entry] of Object.entries(usage.models ?? {})) {
      const target = total.models[model] ?? (total.models[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 })
      target.inputTokens += entry.inputTokens ?? 0
      target.outputTokens += entry.outputTokens ?? 0
      target.cacheReadTokens += entry.cacheReadTokens ?? 0
      target.calls += entry.calls ?? 0
    }
  }
  return total
}

/** Tokens billed for one usage record. */
function usageTokens(usage) {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.outputTokens ?? 0)
}

/**
 * Price recorded usage with an explicit, per-model table.
 *
 * Prices are per 1M tokens. Cache reads fall back to the input price when the
 * table does not list a separate rate, which makes the estimate an upper bound
 * instead of silently under-reporting. Models missing from the table are
 * listed in `unpriced` and excluded from the total.
 *
 * @param {object | null} usage - summed usage for one run.
 * @param {Record<string, { input: number, output: number, cacheRead?: number, currency?: string }> | undefined} pricing
 * @returns {{ total: number, currency: string, byModel: Record<string, number>, unpriced: string[], complete: boolean } | null}
 */
export function computeCost(usage, pricing) {
  if (!usage || !usage.modelCalls) return null
  const table = pricing && typeof pricing === 'object' ? pricing : {}
  const byModel = {}
  const unpriced = []
  let total = 0
  let currency = null
  for (const [model, entry] of Object.entries(usage.models ?? {})) {
    // The usage log names a route, e.g. `dashscope/qwen-flash`. Accept a bare
    // model id too, so a one-route config does not have to guess the prefix;
    // an exact `provider/model` key always wins.
    const price = table[model] ?? table[model.slice(model.indexOf('/') + 1)]
    if (!price || typeof price.input !== 'number' || typeof price.output !== 'number') {
      unpriced.push(model)
      continue
    }
    const cacheRead = typeof price.cacheRead === 'number' ? price.cacheRead : price.input
    const cost = (
      entry.inputTokens * price.input
      + (entry.cacheReadTokens ?? 0) * cacheRead
      + entry.outputTokens * price.output
    ) / 1e6
    byModel[model] = cost
    total += cost
    currency = currency ?? price.currency ?? 'USD'
  }
  if (Object.keys(byModel).length === 0) return { total: 0, currency: currency ?? 'USD', byModel, unpriced, complete: false }
  return { total, currency, byModel, unpriced, complete: unpriced.length === 0 }
}

/** Total tokens recorded so far for a run, used by the budget guard. */
function spentTokens(run) {
  return usageTokens(run.usage)
}

/**
 * Model calls recorded so far for a run, used by the budget guard.
 *
 * Measured usage is the accurate figure, but it only exists once a child's
 * session log can be read. A spawn is at least one model call, so the spawn
 * count is a floor: when the log layout changes and every read returns null,
 * the call budget still stops the run instead of silently never matching.
 */
function spentCalls(run) {
  return Math.max(run.usage?.modelCalls ?? 0, run.counters?.spawns ?? 0)
}

function ensureCounters(run) {
  run.counters = { spawns: 0, unreadable: {}, ...(run.counters ?? {}) }
  if (!run.counters.unreadable || typeof run.counters.unreadable !== 'object') run.counters.unreadable = {}
  return run.counters
}

/**
 * Build the orchestrator.
 *
 * @param {object} deps - injected collaborators.
 * @param {object} deps.store - run store from `createStore`.
 * @param {object} deps.config - resolved plugin config.
 * @param {(spec: { label: string, prompt: string, parent: object, signal: AbortSignal }) => Promise<{ childId: string, result: Promise<object>, dispose: () => Promise<void> }>} deps.spawnChild
 * @param {(childId: string) => Promise<object | null>} deps.readUsage
 * @param {(run: object) => object | void | Promise<object | void>} deps.notify - wake the owning session once.
 * @param {(message: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
export function createOrchestrator(deps) {
  const {
    store,
    config,
    spawnChild,
    readUsage,
    notify,
    log = () => {},
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = deps

  /** @type {Map<string, { controller: AbortController, activations: Set<object>, waiters: number, run: object, promise: Promise<void> | null, abortCause: string | null }>} */
  const runtime = new Map()
  /** Per-run write chain so two subtasks finishing together cannot interleave renames. */
  const saveChains = new Map()
  let startGate = Promise.resolve()

  // Cancel markers are optional in the store contract so tests can inject a
  // memory store without them.
  const hasCancelRequest = runId => (typeof store.hasCancelRequest === 'function'
    ? store.hasCancelRequest(runId)
    : Promise.resolve(false))
  const clearCancel = runId => (typeof store.clearCancel === 'function'
    ? store.clearCancel(runId)
    : Promise.resolve())
  const requestCancel = runId => (typeof store.requestCancel === 'function'
    ? store.requestCancel(runId)
    : Promise.resolve(false))

  function maxActiveRuns() {
    return clamp(config.maxActiveRuns ?? 2, 1, 8)
  }

  function save(run) {
    run.updatedAt = new Date(now()).toISOString()
    const previous = saveChains.get(run.id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => store.write(run))
    saveChains.set(run.id, next)
    return next
  }

  function liveRun(runId) {
    return runtime.get(runId)?.run ?? null
  }

  /** Cached machine identity of the state directory. */
  let ownerRef = null
  async function ownerIdentity() {
    if (ownerRef) return ownerRef
    const host = os.hostname()
    const existing = typeof store.readOwner === 'function' ? await store.readOwner() : null
    if (existing && typeof existing.hostname === 'string') {
      ownerRef = { hostname: host, local: existing.hostname === host, ownerHostname: existing.hostname }
      return ownerRef
    }
    if (typeof store.writeOwner === 'function') {
      await store.writeOwner({ hostname: host, createdAt: new Date(now()).toISOString() })
    }
    ownerRef = { hostname: host, local: true, ownerHostname: host }
    return ownerRef
  }

  /**
   * @param {unknown} pid - pid recorded by the process that owned the run.
   * @returns {boolean | null} true when alive, false when gone, null when unknown.
   */
  function pidAlive(pid) {
    const number = Number(pid)
    if (!Number.isInteger(number) || number <= 0) return null
    try {
      process.kill(number, 0)
      return true
    } catch (error) {
      // EPERM means the process exists but belongs to another user.
      return error?.code === 'EPERM'
    }
  }

  /**
   * Decide whether an active run still has a live owner.
   *
   * Used by recovery, orphan sweeping, and resume, so all three agree: a run
   * that somebody can still be working on is never rewritten. The heartbeat
   * alone proves ownership on a shared directory; a pid is only evidence when
   * the state directory belongs to this machine. A live run lock counts as
   * ownership because the holder is the process that may be spending.
   *
   * @param {object} run - persisted run record.
   * @returns {Promise<{ live: boolean, basis: string, heartbeatAt: number, owner: object, pidChecked: boolean }>}
   */
  async function ownership(run) {
    const owner = await ownerIdentity()
    const heartbeat = Date.parse(run.heartbeatAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt)
    const heartbeatIso = Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : 'unknown'
    const fresh = Number.isFinite(heartbeat) && heartbeat > now() - ORPHAN_MS
    // A pid only means something when the run was written on this machine. On
    // a shared directory the run may belong to a host whose pids are unrelated
    // to ours, so the heartbeat is the only evidence there.
    const localWriter = run.ownerHost ? run.ownerHost === os.hostname() : owner.local
    const alive = localWriter ? pidAlive(run.ownerPid) : null

    if (alive === true) {
      return { live: true, basis: `owner pid ${run.ownerPid} is still running`, heartbeatAt: heartbeat, owner, pidChecked: true }
    }
    if (typeof store.readLock === 'function') {
      const holder = await store.readLock(run.id).catch(() => null)
      if (holder && holder.hostname === os.hostname() && pidAlive(holder.pid) === true) {
        return { live: true, basis: `pid ${holder.pid} holds the run lock`, heartbeatAt: heartbeat, owner, pidChecked: true }
      }
    }
    // A heartbeat can be a few seconds old when the host is killed, and waiting
    // 90 s for it to expire would strand a run that this machine can prove is
    // dead. On the same machine, a missing pid outranks a fresh timestamp.
    if (alive === false) {
      return {
        live: false,
        basis: `owner pid ${run.ownerPid} is not running and this state directory is local`,
        heartbeatAt: heartbeat,
        owner,
        pidChecked: true,
      }
    }
    if (fresh) {
      return { live: true, basis: `its heartbeat was refreshed at ${heartbeatIso}`, heartbeatAt: heartbeat, owner, pidChecked: false }
    }
    const basis = owner.local
      ? `owner pid ${run.ownerPid ?? 'unknown'} is not running and its heartbeat stopped at ${heartbeatIso}`
      : `the state directory is shared with ${owner.ownerHostname}, so a local pid proves nothing; the heartbeat stopped at ${heartbeatIso}`
    return { live: false, basis, heartbeatAt: heartbeat, owner, pidChecked: owner.local }
  }

  /**
   * Rewrite a run whose owner is gone. Never silent: the exact evidence is
   * stored on the run and printed by status.
   */
  function reclaim(run, verdict, cancelled = false) {
    run.status = cancelled ? 'cancelled' : 'interrupted'
    run.error = cancelled
      ? 'cancelled by superagent_cancel while no process was running it'
      : 'host process stopped while the run was active'
    run.finishedAt = new Date(now()).toISOString()
    run.reclaimed = {
      at: new Date(now()).toISOString(),
      basis: verdict.basis,
      heartbeatAt: Number.isFinite(verdict.heartbeatAt) ? new Date(verdict.heartbeatAt).toISOString() : null,
      ownerPid: run.ownerPid ?? null,
      pidChecked: verdict.pidChecked,
      sharedWith: verdict.owner.local ? null : verdict.owner.ownerHostname,
    }
    for (const subtask of run.subtasks ?? []) {
      if (subtask.status === 'running') subtask.status = 'pending'
    }
    // The owner died before it could settle, so publish what is already known
    // about the spend: a reclaimed run must not claim its cost is unknown when
    // its child logs were readable.
    const entries = Object.values(run.usageByChild ?? {})
    if (entries.length > 0) run.usage = sumUsage(entries)
    run.cost = computeCost(run.usage, config.pricing)
    for (const subtask of run.subtasks ?? []) {
      if (subtask.childId && run.usageByChild?.[subtask.childId]) {
        subtask.usage = run.usageByChild[subtask.childId]
      }
    }
  }

  async function releaseRunLock(runId) {
    if (typeof store.releaseLock !== 'function') return
    try {
      await store.releaseLock(runId)
    } catch (error) {
      log(`cannot release the lock for run ${runId}: ${error?.message ?? error}`)
    }
  }

  /**
   * Claim the exclusive right to schedule a run.
   *
   * Two profiles can point at one state directory, so a resume must not be
   * decided from a read alone: both processes would see a terminal run and both
   * would schedule it. The lock makes one of them lose.
   */
  async function takeRunLock(runId) {
    if (typeof store.acquireLock !== 'function') return
    const holder = { pid: process.pid, hostname: os.hostname(), at: new Date(now()).toISOString() }
    let attempt = await store.acquireLock(runId, holder)
    if (!attempt.acquired) {
      const current = attempt.holder
      // A lock left by a process on this machine that no longer exists is
      // evidence of a crash, not of a live owner. A lock on another machine has
      // no checkable pid, so its age is the only evidence: past LOCK_STALE_MS
      // the process that took it is no longer plausibly still scheduling.
      const deadHere = current && current.hostname === os.hostname() && pidAlive(current.pid) === false
      const aliveHere = current && current.hostname === os.hostname() && pidAlive(current.pid) === true
      const age = now() - Date.parse(current?.at ?? '')
      const stale = !Number.isFinite(age) || age > LOCK_STALE_MS
      // Age is only evidence when the holder cannot be checked: a live process
      // on this machine may legitimately schedule a long run for hours.
      if (deadHere || (stale && !aliveHere)) {
        await releaseRunLock(runId)
        attempt = await store.acquireLock(runId, holder)
      }
      if (!attempt.acquired) {
        const held = attempt.holder
        const who = held
          ? `pid ${held.pid ?? 'unknown'} on ${held.hostname ?? 'an unknown host'}`
          : 'another process'
        throw new Error(`run ${runId} is already being started by ${who}; wait for it to finish or cancel it`)
      }
    }
  }

  /**
   * Reclaim runs whose owning process is gone, so an orphan cannot hold the
   * active-run quota forever.
   *
   * @returns {Promise<string[]>} reclaimed run ids, in list order.
   */
  async function sweepOrphans() {
    const stale = (await store.list()).filter(run => ACTIVE_STATUSES.has(run.status) && !runtime.has(run.id))
    if (stale.length === 0) return []
    const reclaimed = []
    for (const run of stale) {
      const verdict = await ownership(run)
      if (verdict.live) continue
      reclaim(run, verdict)
      await save(run)
      await releaseRunLock(run.id)
      log(`run ${run.id} was active with no live owner; reclaimed its quota (${verdict.basis})`)
      reclaimed.push(run.id)
    }
    return reclaimed
  }

  async function activeCount() {
    try {
      await sweepOrphans()
    } catch (error) {
      log(`cannot check for orphaned runs: ${error?.message ?? error}`)
    }
    let count = 0
    for (const rt of runtime.values()) {
      if (rt.run && ACTIVE_STATUSES.has(rt.run.status)) count++
    }
    for (const run of await store.list()) {
      if (runtime.has(run.id)) continue
      if (ACTIVE_STATUSES.has(run.status)) count++
    }
    return count
  }

  function quotaMessage(active) {
    return `quota exceeded: ${active} active run(s) and maxActiveRuns is ${maxActiveRuns()}. `
      + 'Let one finish with superagent_status or cancel it with superagent_cancel.'
  }

  function buildLimits(overrides = {}) {
    // A caller may narrow a limit but never widen the operator's cap: the
    // config is the spending and blast-radius control, and a model-written tool
    // argument must not be able to raise it.
    const narrowed = (override, cap) => (
      override === undefined || override === null ? cap : Math.min(Number(override), cap)
    )
    const limits = {
      maxSubtasks: clamp(narrowed(overrides.maxSubtasks, config.maxSubtasks), 1, 16),
      maxParallel: clamp(narrowed(overrides.maxParallel, config.maxParallel), 1, 8),
      deadlineMinutes: clamp(narrowed(overrides.deadlineMinutes, config.deadlineMinutes), 1, 720),
      attempts: clamp(config.attempts, 1, 5),
      maxModelCalls: clamp(narrowed(overrides.maxModelCalls, config.maxModelCallsPerRun), 0, 10000),
      maxTokens: clamp(narrowed(overrides.maxTokens, config.maxTokensPerRun), 0, 1e12),
    }
    limits.maxParallel = Math.min(limits.maxParallel, limits.maxSubtasks)
    return limits
  }

  /**
   * Report why a run may not start another child, or null when it still can.
   * Both budgets are hard stops: they exist so a pathological goal cannot spend
   * quietly, so they are checked before a spawn rather than after.
   */
  function budgetStop(run) {
    const calls = spentCalls(run)
    const tokens = spentTokens(run)
    if (run.limits.maxModelCalls > 0 && calls >= run.limits.maxModelCalls) {
      return `model-call budget reached (${calls}/${run.limits.maxModelCalls} calls)`
    }
    if (run.limits.maxTokens > 0 && tokens >= run.limits.maxTokens) {
      return `token budget reached (${tokens}/${run.limits.maxTokens} tokens)`
    }
    return null
  }

  /**
   * Spawn one child under the run's abort signal and budget.
   * @param {object} run - live run record.
   * @param {object} rt - runtime entry.
   * @param {{ label: string, prompt: string, parent: object }} spec - child request.
   */
  async function spawn(run, rt, spec) {
    const blocked = budgetStop(run)
    if (blocked) {
      if (!rt.abortCause) rt.abortCause = 'budget'
      if (!run.error) run.error = blocked
      if (!rt.controller.signal.aborted) rt.controller.abort(new Error(blocked))
      throw new Error(`budget exceeded: ${blocked}; raise maxModelCallsPerRun or maxTokensPerRun if this was intended`)
    }
    // Counted before the child exists and persisted before it can spend, so a
    // crash cannot lose the only evidence of a model call.
    ensureCounters(run).spawns += 1
    await save(run)
    return spawnAbortable(spec, rt.controller.signal)
  }

  /**
   * Create one child, but stop waiting for it as soon as the run is aborted.
   *
   * A provider that queues activations can leave `startActivation` pending long
   * after the run was cancelled or ran out of time. Without this the run would
   * hang in planning/running while its heartbeat kept it looking alive, so no
   * recovery path could ever reclaim it. A child that appears after the abort is
   * disposed immediately instead of being left to spend.
   */
  function spawnAbortable(spec, signal) {
    const pending = spawnChild({ ...spec, signal })
    if (!signal) return pending
    if (signal.aborted) {
      pending.then(handle => disposeQuietly(handle), () => {})
      return Promise.reject(new Error('aborted'))
    }
    return new Promise((resolve, reject) => {
      let done = false
      const onAbort = () => {
        if (done) return
        done = true
        // The `pending` handler registered below disposes the handle if it
        // arrives late, so the child is not left spending in the background.
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(
        handle => {
          if (done) {
            disposeQuietly(handle)
            return
          }
          done = true
          signal.removeEventListener('abort', onAbort)
          resolve(handle)
        },
        error => {
          if (done) return
          done = true
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /**
   * Read one run for a tool call, turning the two failure modes a user can hit
   * into sentences instead of a null.
   * @param {string} runId - run identity.
   */
  async function loadRun(runId) {
    const run = await store.read(runId)
    if (run) return run
    const quarantined = store.corrupt?.get?.(runId)
    if (quarantined) {
      throw new Error(
        `state file for run ${runId} is not valid JSON, so the run cannot be read. `
        + `The original file was kept at ${quarantined}. Inspect it, then delete it; `
        + 'the run is skipped by superagent_list until you do.',
      )
    }
    throw new Error(`unknown run ${runId}; call superagent_list to see recorded run ids`)
  }

  /**
   * Mark runs left active by a previous host process as interrupted.
   *
   * A run that another live process owns is left completely alone: rewriting it
   * here would make two processes fight over the same file while the first one
   * keeps spending, and a later resume would then run everything twice.
   */
  async function recover() {
    await store.init()
    const recovered = []
    for (const run of await store.list()) {
      if (!ACTIVE_STATUSES.has(run.status)) {
        if (await hasCancelRequest(run.id)) await clearCancel(run.id)
        continue
      }
      if (runtime.has(run.id)) continue
      const verdict = await ownership(run)
      if (verdict.live) {
        log(`run ${run.id} is still owned (${verdict.basis}); leaving it running`)
        continue
      }
      reclaim(run, verdict, await hasCancelRequest(run.id))
      await save(run)
      await clearCancel(run.id)
      await releaseRunLock(run.id)
      recovered.push(run.id)
    }
    return recovered
  }

  /**
   * Fold one child's usage snapshot into the run. The snapshot is cumulative,
   * so the last read for a child replaces the earlier one instead of adding.
   * Called at start, on every heartbeat, and on success or failure, which is
   * why an unreadable log degrades to the spawn floor instead of to zero.
   */
  async function recordUsage(run, childId) {
    let usage = null
    try {
      usage = await readUsage(childId)
    } catch (error) {
      log(`cannot read usage for child ${childId}: ${error?.message ?? error}`)
    }
    if (!usage) {
      ensureCounters(run).unreadable[childId] = true
      return null
    }
    run.usageByChild = run.usageByChild ?? {}
    run.usageByChild[childId] = usage
    run.usage = sumUsage(Object.values(run.usageByChild))
    return usage
  }

  /** Refresh usage for children that are still running, from the heartbeat. */
  async function refreshUsage(run, rt) {
    const handles = [...rt.activations]
    for (const handle of handles) await recordUsage(run, handle.childId)
  }

  /**
   * Wait for a child result, but stop waiting when the run is aborted. Without
   * this a child that ignores its abort signal keeps the whole run open.
   */
  function abortable(promise, signal) {
    if (!signal) return promise
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        promise.catch(() => {})
        reject(new Error('aborted'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        value => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        error => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  /** Dispose one child activation without letting it block the caller. */
  async function disposeQuietly(handle) {
    if (!handle || typeof handle.dispose !== 'function') return
    try {
      await Promise.race([
        Promise.resolve().then(() => handle.dispose()),
        sleep(DISPOSE_MS),
      ])
    } catch (error) {
      log(`child dispose failed: ${error?.message ?? error}`)
    }
  }

  /**
   * The host's subagent service disappeared while this run was active, which
   * in practice means the host is shutting down. That is not a subtask
   * failure: the work never got a chance to run. Remember the cause so the run
   * settles as `interrupted` (resumable) instead of `failed`, and abort the
   * remaining children.
   */
  function markHostGone(rt, error) {
    if (rt.abortCause) return
    rt.abortCause = 'host-gone'
    if (!rt.controller.signal.aborted) {
      rt.controller.abort(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async function makePlan(run, parent, rt) {
    try {
      const handle = await spawn(run, rt, {
        label: 'superagent-plan',
        prompt: plannerPrompt(run.goal, run.limits.maxSubtasks),
        parent,
      })
      rt.activations.add(handle)
      run.steps.planner = { childId: handle.childId }
      try {
        const result = await abortable(handle.result, rt.controller.signal)
        const text = textOf(result.output)
        const subtasks = extractPlan(text).slice(0, run.limits.maxSubtasks)
        if (subtasks.length > 0) return { mode: 'planned', subtasks }
        log(`planner reply had no parsable plan; running the goal as one subtask`)
      } finally {
        await recordUsage(run, handle.childId)
        rt.activations.delete(handle)
        await disposeQuietly(handle)
      }
    } catch (error) {
      log(`planner failed: ${error?.message ?? error}`)
      if (error?.code === 'subagent-unavailable') markHostGone(rt, error)
    }
    return { mode: 'degraded', subtasks: [{ title: 'Complete the goal', prompt: run.goal }] }
  }

  async function runSubtask(run, subtask, parent, rt) {
    const signal = rt.controller.signal
    for (let attempt = subtask.attempts + 1; attempt <= run.limits.attempts; attempt++) {
      if (signal.aborted) break
      subtask.status = 'running'
      subtask.attempts = attempt
      subtask.startedAt = subtask.startedAt ?? new Date(now()).toISOString()
      await save(run)

      let handle = null
      try {
        handle = await spawn(run, rt, {
          label: `superagent-${subtask.index}`,
          prompt: workerPrompt(run, subtask),
          parent,
        })
        rt.activations.add(handle)
        subtask.childId = handle.childId
        await save(run)

        const result = await abortable(handle.result, signal)
        const text = textOf(result.output)
        subtask.stopReason = result.stopReason
        if (result.stopReason === 'completed' && text) {
          subtask.status = 'completed'
          subtask.result = capText(text, config.resultCapBytes)
          subtask.error = null
          subtask.finishedAt = new Date(now()).toISOString()
          await recordUsage(run, handle.childId)
          await save(run)
          return
        }
        subtask.error = result.diagnostic || `child stopped with reason "${result.stopReason}"`
        log(`subtask ${subtask.index} attempt ${attempt} did not complete: ${subtask.error}`)
      } catch (error) {
        subtask.error = error?.message ?? String(error)
        log(`subtask ${subtask.index} attempt ${attempt} threw: ${subtask.error}`)
        if (error?.code === 'subagent-unavailable') {
          // The host is going away; leave the subtask as work to do rather
          // than burning the remaining attempts on a service that is gone.
          subtask.error = null
          subtask.stopReason = null
          markHostGone(rt, error)
        }
      } finally {
        if (handle) {
          // A failed attempt still spent tokens, so read it before disposing.
          await recordUsage(run, handle.childId)
          rt.activations.delete(handle)
          await disposeQuietly(handle)
        }
      }

      if (signal.aborted) break
      if (attempt < run.limits.attempts) {
        subtask.status = 'pending'
        await save(run)
        await sleep(1000 * attempt)
      }
    }

    if (subtask.status !== 'completed') {
      if (signal.aborted) {
        // Cancelled or out of time: the subtask did not fail on its own terms,
        // so leave it resumable instead of recording a failure.
        subtask.status = 'pending'
        subtask.error = null
        subtask.stopReason = null
      } else {
        subtask.status = 'failed'
        subtask.finishedAt = new Date(now()).toISOString()
      }
      await save(run)
    }
  }

  async function aggregate(run, parent, rt) {
    const completed = run.subtasks.filter(subtask => subtask.status === 'completed')
    if (completed.length === 0) return null
    if (rt.controller.signal.aborted) return deterministicJoin(run)
    if (completed.length === 1) return `# ${run.goal}\n\n${completed[0].result ?? ''}`.trim()

    try {
      const handle = await spawn(run, rt, {
        label: 'superagent-aggregate',
        prompt: aggregatorPrompt(run, completed),
        parent,
      })
      rt.activations.add(handle)
      run.steps.aggregator = { childId: handle.childId }
      try {
        const result = await abortable(handle.result, rt.controller.signal)
        const text = textOf(result.output)
        if (result.stopReason === 'completed' && text) return text
        log(`aggregator did not complete (${result.stopReason}); using deterministic merge`)
      } finally {
        await recordUsage(run, handle.childId)
        rt.activations.delete(handle)
        await disposeQuietly(handle)
      }
    } catch (error) {
      log(`aggregator failed: ${error?.message ?? error}`)
      if (error?.code === 'subagent-unavailable') markHostGone(rt, error)
    }
    return deterministicJoin(run)
  }

  function terminalStatus(run, rt) {
    if (rt.abortCause === 'cancelled') return 'cancelled'
    // The host went away mid-run. Nothing failed on its own terms, so the run
    // must stay resumable instead of being buried as `failed`.
    if (rt.abortCause === 'host-gone') return 'interrupted'
    const subtasks = run.subtasks ?? []
    const completed = subtasks.filter(subtask => subtask.status === 'completed').length
    if (completed === 0) return 'failed'
    if (rt.abortCause === 'deadline') {
      return completed === subtasks.length ? 'completed' : 'partial'
    }
    return completed === subtasks.length ? 'completed' : 'partial'
  }

  /**
   * Watch for a cancel written by another process. The marker is checked from
   * inside the owning process, which is the only place that can abort children;
   * that is why cancel is a file and not a state-file rewrite.
   */
  function watchCancel(run, rt) {
    const timer = setInterval(() => {
      hasCancelRequest(run.id).then(requested => {
        if (!requested || rt.controller.signal.aborted) return
        rt.abortCause = 'cancelled'
        rt.controller.abort(new Error('cancelled by superagent_cancel from another process'))
        // Aborting the signal alone does not stop a child that is already
        // running; dispose its activation so it stops spending tokens.
        for (const handle of [...rt.activations]) disposeQuietly(handle)
      }).catch(() => {})
    }, CANCEL_POLL_MS)
    timer.unref?.()
    return timer
  }

  /**
   * A caller waiting inside this process will read the terminal result itself,
   * so waking the session would be duplicate noise. A caller in *another*
   * process is deliberately not treated this way: it can time out just before
   * the run settles, in which case suppressing the wake-up would lose the only
   * notification the user gets.
   */
  function watchedHere(rt) {
    return rt.waiters > 0
  }

  /**
   * Compute the terminal state, decide about notifying, and write it exactly
   * once. Writing the terminal status first and the notify outcome second left
   * a window where readers saw a finished run with no notify line at all.
   */
  async function settle(run, rt) {
    // Usage is stored per child so repeated reads replace rather than add. A
    // run written before that field existed keeps whatever total it had.
    const entries = Object.values(run.usageByChild ?? {})
    if (entries.length > 0) run.usage = sumUsage(entries)
    // The per-subtask figure is read when the child finishes, which can race a
    // log flush; the settle pass has the final snapshot, so publish it here.
    for (const subtask of run.subtasks ?? []) {
      if (subtask.childId && run.usageByChild?.[subtask.childId]) {
        subtask.usage = run.usageByChild[subtask.childId]
      }
    }
    run.cost = computeCost(run.usage, config.pricing)
    const nextStatus = terminalStatus(run, rt)
    const finishedAt = new Date(now()).toISOString()
    let error = run.error
    if (rt.abortCause === 'cancelled') {
      error = 'cancelled by superagent_cancel'
    } else if (rt.abortCause === 'host-gone') {
      error = 'the host shut down while this run was active; run superagent_resume in a new host to finish it'
    } else if (nextStatus === 'failed' && !error) {
      error = run.subtasks.map(subtask => subtask.error).filter(Boolean).slice(0, 3).join('; ') || 'no subtask completed'
    }
    if (rt.abortCause === 'deadline' && !error) error = 'deadline exceeded'

    let outcome = null
    if (TERMINAL_STATUSES.has(nextStatus)) {
      if (watchedHere(rt)) {
        outcome = { delivered: false, reason: 'skipped: a caller in this process is reading the run' }
      } else {
        try {
          // `notify` may wait on the host's session loop; cap it so a finished
          // run cannot stay active on disk (and be reclaimed by another process)
          // just because a wake-up is slow.
          outcome = await withTimeout(
            Promise.resolve().then(() => notify({ ...run, status: nextStatus, finishedAt, error })),
            NOTIFY_MS,
            () => ({
              delivered: false,
              reason: `the owning session did not accept the wake-up within ${NOTIFY_MS / 1000}s`,
            }),
          )
          outcome = outcome ?? { delivered: true }
        } catch (notifyError) {
          outcome = { delivered: false, reason: `notification threw: ${notifyError?.message ?? notifyError}` }
          log(`notification failed for ${run.id}: ${notifyError?.message ?? notifyError}`)
        }
      }
    }

    // The terminal status and its notify row land in the same write, so a
    // reader never sees a finished run that still claims to be active and never
    // sees a finished run whose notify row is missing.
    run.status = nextStatus
    run.finishedAt = finishedAt
    run.activeMs = (Number.isFinite(run.activeMs) ? run.activeMs : 0) + Math.max(0, now() - rt.activeStart)
    run.error = error
    run.cancelPending = false
    if (outcome) {
      run.notify = {
        at: new Date(now()).toISOString(),
        delivered: outcome.delivered !== false,
        reason: outcome.reason ?? null,
      }
      if (outcome.delivered !== false) run.notified = true
    }
    await save(run)
    // The run is terminal, so a leftover marker would only make the next mount
    // rewrite a finished run; drop it now.
    await clearCancel(run.id)
    await releaseRunLock(run.id)
  }

  /**
   * Resolve with `promise`, or with `onTimeout()` after `ms`.
   *
   * The timer is cleared when the promise wins: a stray 15s timer would keep a
   * finished host process (and a test runner) alive for no reason.
   */
  function withTimeout(promise, ms, onTimeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(onTimeout()), ms)
      timer.unref?.()
      promise.then(
        value => {
          clearTimeout(timer)
          resolve(value)
        },
        error => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  async function execute(run, parent, rt) {
    rt.activeStart = now()
    const remaining = Math.max(0, Date.parse(run.deadlineAt) - now())
    const timer = setTimeout(() => {
      rt.abortCause = 'deadline'
      rt.controller.abort(new Error(`deadline exceeded after ${run.limits.deadlineMinutes} minutes`))
    }, remaining)
    timer.unref?.()
    const cancelTimer = watchCancel(run, rt)
    // The heartbeat is what makes an orphan detectable after a crash on a
    // machine whose pids this process cannot check (shared state directory).
    const beat = setInterval(() => {
      run.heartbeatAt = new Date(now()).toISOString()
      run.ownerPid = process.pid
      refreshUsage(run, rt).then(() => save(run)).catch(() => {})
    }, HEARTBEAT_MS)
    beat.unref?.()

    try {
      ensureCounters(run)
      if (!Array.isArray(run.subtasks) || run.subtasks.length === 0) {
        run.status = 'planning'
        await save(run)
        const plan = await makePlan(run, parent, rt)
        run.plan = { mode: plan.mode, subtasks: plan.subtasks }
        run.subtasks = plan.subtasks.map((entry, index) => ({
          index: index + 1,
          title: entry.title,
          prompt: entry.prompt,
          status: 'pending',
          attempts: 0,
          childId: null,
          stopReason: null,
          error: null,
          result: null,
          usage: null,
          startedAt: null,
          finishedAt: null,
        }))
        await save(run)
      }

      const open = run.subtasks.filter(subtask => subtask.status !== 'completed')
      if (open.length > 0) {
        run.status = 'running'
        await save(run)
        await pool(open, run.limits.maxParallel, subtask => runSubtask(run, subtask, parent, rt))
      }

      if (run.subtasks.some(subtask => subtask.status === 'completed') && !rt.controller.signal.aborted) {
        run.status = 'aggregating'
        await save(run)
        run.report = await aggregate(run, parent, rt)
      } else if (!run.report) {
        run.report = deterministicJoin(run)
      }
    } catch (error) {
      run.error = error?.message ?? String(error)
      log(`run ${run.id} failed: ${run.error}`)
      // Stop any child still running; without this the run would end while its
      // subtasks keep burning tokens.
      rt.controller.abort(error instanceof Error ? error : new Error(String(error)))
    } finally {
      clearTimeout(timer)
      clearInterval(cancelTimer)
      // The heartbeat keeps running until the terminal write lands: waking the
      // session can take a few seconds, and a frozen heartbeat during that
      // window would let another process treat a live run as orphaned.
      try {
        await settle(run, rt)
      } catch (error) {
        // Never leave a run active because finalizing it threw.
        log(`cannot finalize run ${run.id}: ${error?.message ?? error}`)
        if (ACTIVE_STATUSES.has(run.status)) {
          run.status = 'failed'
          run.finishedAt = run.finishedAt ?? new Date(now()).toISOString()
          run.error = run.error ?? `finalizing the run failed: ${error?.message ?? error}`
        }
        try {
          await store.write(run)
        } catch (writeError) {
          log(`cannot persist the terminal state of run ${run.id}: ${writeError?.message ?? writeError}`)
        }
        await releaseRunLock(run.id)
      } finally {
        clearInterval(beat)
      }
    }
  }

  function schedule(run, parent) {
    run.ownerPid = process.pid
    run.ownerHost = os.hostname()
    run.heartbeatAt = new Date(now()).toISOString()
    const rt = {
      controller: new AbortController(),
      activations: new Set(),
      waiters: 0,
      run,
      promise: null,
      abortCause: null,
    }
    runtime.set(run.id, rt)
    rt.promise = execute(run, parent, rt)
      .catch(async error => {
        log(`run ${run.id} crashed: ${error?.message ?? error}`)
        if (!ACTIVE_STATUSES.has(run.status)) return
        run.status = 'failed'
        run.finishedAt = new Date(now()).toISOString()
        run.error = error?.message ?? String(error)
        try {
          await store.write(run)
        } catch (writeError) {
          log(`cannot persist the crash state of run ${run.id}: ${writeError?.message ?? writeError}`)
        }
        await releaseRunLock(run.id)
      })
      .then(() => {
        // Finished runs are read from disk from now on; keeping them here would
        // grow these maps for the lifetime of the host.
        runtime.delete(run.id)
        saveChains.delete(run.id)
      })
    return rt
  }

  /** Serialize starts and resumes so a quota check cannot interleave. */
  function serialize(task) {
    const result = startGate.then(task, task)
    startGate = result.catch(() => {})
    return result
  }

  async function start({ goal, parentSessionId, parent, clientTimeZone, overrides = {} }) {
    const trimmed = typeof goal === 'string' ? goal.trim() : ''
    if (!trimmed) throw new Error('goal is required')
    if (!parent || typeof parent !== 'object') throw new Error('superagent requires a live parent agent')

    const limits = buildLimits(overrides)
    // Kept so a resume can rebuild the limits from the *current* config
    // instead of freezing whatever was set when the run first started.
    const keptOverrides = {}
    for (const key of ['maxSubtasks', 'maxParallel', 'deadlineMinutes']) {
      if (overrides[key] !== undefined && overrides[key] !== null) keptOverrides[key] = overrides[key]
    }
    return serialize(async () => {
      const active = await activeCount()
      if (active >= maxActiveRuns()) throw new Error(quotaMessage(active))
      const run = {
        id: newRunId(),
        schemaVersion: 1,
        goal: trimmed,
        status: 'queued',
        mode: 'planned',
        parentSessionId,
        clientTimeZone: clientTimeZone ?? null,
        createdAt: new Date(now()).toISOString(),
        updatedAt: null,
        startedAt: new Date(now()).toISOString(),
        deadlineAt: new Date(now() + limits.deadlineMinutes * 60000).toISOString(),
        finishedAt: null,
        resumedAt: null,
        limits,
        overrides: keptOverrides,
        plan: null,
        subtasks: [],
        steps: {},
        report: null,
        error: null,
        usage: null,
        notified: false,
        counters: { spawns: 0, unreadable: {} },
        usageByChild: {},
      }
      await takeRunLock(run.id)
      try {
        await store.write(run)
      } catch (error) {
        await releaseRunLock(run.id)
        throw error
      }
      schedule(run, parent)
      return run
    })
  }

  async function resume(runId, parent, clientTimeZone) {
    const id = String(runId ?? '').trim()
    if (!parent || typeof parent !== 'object') throw new Error('superagent requires a live parent agent')
    return serialize(async () => {
      if (runtime.has(id)) {
        throw new Error(`run ${id} is still active in this process; wait for it with superagent_status or cancel it`)
      }
      let run = await loadRun(id)
      if (run.status === 'completed') return run
      if (ACTIVE_STATUSES.has(run.status)) {
        const verdict = await ownership(run)
        if (verdict.live) {
          throw new Error(
            `run ${id} is still owned by a live process (${verdict.basis}); resuming it here would run the same `
            + 'subtasks twice and double the spend. Cancel it with superagent_cancel first, or wait for it to finish.',
          )
        }
      }

      await takeRunLock(id)
      let scheduled = false
      try {
        // Re-read under the lock: another process may have started the run
        // between the check above and the claim.
        run = await loadRun(id)
        if (run.status === 'completed') return run
        if (ACTIVE_STATUSES.has(run.status)) {
          const verdict = await ownership(run)
          if (verdict.live) {
            throw new Error(`run ${id} is still owned by a live process (${verdict.basis}); not resuming it here`)
          }
          reclaim(run, verdict, await hasCancelRequest(id))
          await save(run)
          await clearCancel(id)
        }

        const active = await activeCount()
        if (active >= maxActiveRuns()) throw new Error(quotaMessage(active))

        for (const subtask of run.subtasks ?? []) {
          if (subtask.status === 'completed') continue
          subtask.status = 'pending'
          subtask.attempts = 0
          subtask.error = null
          subtask.stopReason = null
          subtask.finishedAt = null
        }
        run.status = 'queued'
        run.report = run.plan ? run.report : null
        run.error = null
        run.finishedAt = null
        run.reclaimed = null
        run.cancelPending = false
        // A resumed run completes a second time, so it must be able to wake the
        // session again; keeping the old outcome would silence it forever.
        run.notified = false
        run.notify = null
        run.resumedAt = new Date(now()).toISOString()
        run.clientTimeZone = clientTimeZone ?? run.clientTimeZone ?? null
        // The limits are rebuilt from the config that is active now, keeping
        // everything already spent: that is what makes "raise the cap, then
        // resume" work. Without this the old caps stayed in force forever.
        run.limits = buildLimits(run.overrides ?? {})
        run.deadlineAt = new Date(now() + run.limits.deadlineMinutes * 60000).toISOString()
        ensureCounters(run)
        await save(run)
        schedule(run, parent)
        scheduled = true
        return run
      } finally {
        if (!scheduled) await releaseRunLock(id)
      }
    })
  }

  async function cancel(runId) {
    const rt = runtime.get(runId)
    if (rt && ACTIVE_STATUSES.has(rt.run.status)) {
      rt.abortCause = 'cancelled'
      rt.controller.abort(new Error('cancelled by superagent_cancel'))
      const activations = [...rt.activations]
      // A child that ignores its abort must not hold this call open; the
      // timeout is per child and they are disposed in parallel.
      await Promise.all(activations.map(handle => disposeQuietly(handle)))
      await Promise.race([rt.promise ?? Promise.resolve(), sleep(CANCEL_ACK_MS)])
      if (ACTIVE_STATUSES.has(rt.run.status)) {
        rt.run.cancelPending = true
        await save(rt.run).catch(() => {})
      }
      return rt.run
    }

    const run = await loadRun(runId)
    if (!ACTIVE_STATUSES.has(run.status)) return run

    // This process does not own the run, so it cannot abort the children. Ask
    // the owner through the marker file and wait for it to rewrite the state.
    // Writing `cancelled` here would be a lie: the owner would overwrite it on
    // its next save and keep spending.
    await requestCancel(runId)
    const endsAt = now() + CANCEL_ACK_MS
    while (now() < endsAt) {
      await sleep(STATUS_POLL_MS)
      const current = await store.read(runId)
      if (!current) return run
      if (!ACTIVE_STATUSES.has(current.status)) return current
    }
    // The owner did not confirm in time. Do not rewrite the state file from
    // here: the owner would overwrite it on its next save. The request marker
    // stays on disk, and `status` reports it as a pending cancel.
    return { ...run, cancelPending: true }
  }

  async function status(runId, waitSeconds = 0) {
    const read = async () => liveRun(runId) ?? await store.read(runId)
    let run = await read()
    if (!run) {
      await loadRun(runId)
      throw new Error(`unknown run ${runId}`)
    }
    // A terminal status is only published after the run's final write, so a
    // caller that sees one gets the notify row and usage totals with it.
    const owner = runtime.get(runId)
    if (owner && TERMINAL_STATUSES.has(run.status)) {
      await withTimeout(Promise.resolve(owner.promise).catch(() => undefined), NOTIFY_MS + 5000, () => undefined)
      run = (await read()) ?? run
    }
    const limit = clamp(waitSeconds, 0, 3600)
    if (ACTIVE_STATUSES.has(run.status) && !run.cancelPending && await hasCancelRequest(runId)) {
      // The owning process may live elsewhere; the marker is the only evidence
      // that a cancel was asked for and not yet acknowledged.
      run = { ...run, cancelPending: true }
    }
    if (limit <= 0 || TERMINAL_STATUSES.has(run.status)) return run

    const rt = runtime.get(runId)
    if (rt) rt.waiters++
    try {
      const endsAt = now() + limit * 1000
      while (now() < endsAt) {
        await sleep(STATUS_POLL_MS)
        run = await read()
        if (!run || TERMINAL_STATUSES.has(run.status)) break
      }
    } finally {
      if (rt) rt.waiters = Math.max(0, rt.waiters - 1)
    }

    if (!run) throw new Error(`run ${runId} disappeared from the state directory while waiting for it`)
    const live = runtime.get(runId)
    // Wait for this process's own final write, so a caller that sees a terminal
    // status can immediately trust what is on disk. Bounded, because finalizing
    // includes waking the session and must not turn a status call into a hang.
    if (live && TERMINAL_STATUSES.has(live.run.status)) {
      await withTimeout(Promise.resolve(live.promise).catch(() => undefined), NOTIFY_MS + 5000, () => undefined)
    }
    return liveRun(runId) ?? run
  }

  async function list() {
    const merged = new Map()
    const fromDisk = await store.list()
    for (const run of fromDisk) merged.set(run.id, run)
    log(`[diag] list disk=${fromDisk.map(run => `${run.id}:${run.status}`).join(',') || 'none'} runtime=${runtime.size}`)
    for (const [runId, rt] of runtime) {
      log(`[diag] list runtime ${runId}:${rt.run.status}:${JSON.stringify(rt.run.notify ?? null)}`)
      merged.set(runId, rt.run)
    }
    return [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  /**
   * Resolve once every run started by this process has finished. Used by tests
   * instead of sleeping, and by embedders that need a quiescent state.
   */
  async function idle() {
    await Promise.all([...runtime.values()].map(rt => rt.promise?.catch(() => {})))
  }

  return { recover, start, resume, cancel, status, list, idle, activeCount, liveRun }
}
