/**
 * Run orchestration for dsh-longhaul.
 *
 * A run moves through queued -> planning -> running -> aggregating and ends in
 * completed, partial, failed, cancelled, or interrupted. Planning, subtask
 * execution, and aggregation all happen in child agents; this module owns
 * ordering, retries, quotas, cancellation, and durable status.
 *
 * The module has no host imports: `spawnChild`, `readUsage`, `notify`, and
 * `store` are injected, which keeps it testable without a running harness.
 *
 * @module dsh-longhaul/orchestrator
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
  const kept = buffer.subarray(0, maxBytes).toString('utf8')
  return `${kept}\n\n[truncated: ${buffer.length - maxBytes} bytes omitted]`
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
    '- Use the tools you have. Never call a tool whose name starts with "longhaul_".',
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
  const completed = run.subtasks.filter(subtask => subtask.status === 'completed')
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

function sumUsage(entries) {
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
    const price = table[model]
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
  const entries = [
    run.steps?.planner?.usage,
    run.steps?.aggregator?.usage,
    ...(run.subtasks ?? []).map(subtask => subtask.usage),
  ]
  return entries.reduce((total, usage) => total + ((usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.outputTokens ?? 0)), 0)
}

/** Model calls recorded so far for a run, used by the budget guard. */
function spentCalls(run) {
  const entries = [
    run.steps?.planner?.usage,
    run.steps?.aggregator?.usage,
    ...(run.subtasks ?? []).map(subtask => subtask.usage),
  ]
  return entries.reduce((total, usage) => total + (usage?.modelCalls ?? 0), 0)
}

/**
 * Build the orchestrator.
 *
 * @param {object} deps - injected collaborators.
 * @param {object} deps.store - run store from `createStore`.
 * @param {object} deps.config - resolved plugin config.
 * @param {(spec: { label: string, prompt: string, parent: object, signal: AbortSignal }) => Promise<{ childId: string, result: Promise<object>, dispose: () => Promise<void> }>} deps.spawnChild
 * @param {(childId: string) => Promise<object | null>} deps.readUsage
 * @param {(run: object) => void} deps.notify - wake the owning session once.
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
   * Reclaim runs whose owning process is gone, so an orphan cannot hold the
   * active-run quota forever.
   *
   * The pid is only used as proof when the state directory belongs to this
   * machine. On a shared directory a pid may name a process on another host, so
   * the heartbeat alone decides. A live pid vetoes reclamation even when the
   * heartbeat is stale, because a wedged-but-alive process may still resume.
   *
   * @returns {Promise<string[]>} reclaimed run ids, in list order.
   */
  async function sweepOrphans() {
    const stale = (await store.list()).filter(run => ACTIVE_STATUSES.has(run.status) && !runtime.has(run.id))
    if (stale.length === 0) return []
    const owner = await ownerIdentity()
    const cutoff = now() - ORPHAN_MS
    const reclaimed = []
    for (const run of stale) {
      const heartbeat = Date.parse(run.heartbeatAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt)
      if (!Number.isFinite(heartbeat) || heartbeat > cutoff) continue
      const alive = owner.local ? pidAlive(run.ownerPid) : null
      if (alive === true) continue
      const stoppedAt = new Date(heartbeat).toISOString()
      const basis = owner.local
        ? `owner pid ${run.ownerPid ?? 'unknown'} is not running and its heartbeat stopped at ${stoppedAt}`
        : `the state directory is shared with ${owner.ownerHostname}, so a local pid proves nothing; the heartbeat stopped at ${stoppedAt}`
      run.status = 'interrupted'
      run.error = 'reclaimed: the process that owned this run is gone'
      run.reclaimed = {
        at: new Date(now()).toISOString(),
        basis,
        heartbeatAt: stoppedAt,
        ownerPid: run.ownerPid ?? null,
        pidChecked: owner.local,
        sharedWith: owner.local ? null : owner.ownerHostname,
      }
      for (const subtask of run.subtasks ?? []) {
        if (subtask.status === 'running') subtask.status = 'pending'
      }
      await save(run)
      log(`run ${run.id} was active with no live owner; reclaimed its quota (${basis})`)
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

  function buildLimits(overrides = {}) {
    const limits = {
      maxSubtasks: clamp(overrides.maxSubtasks ?? config.maxSubtasks, 1, 16),
      maxParallel: clamp(overrides.maxParallel ?? config.maxParallel, 1, 8),
      deadlineMinutes: clamp(overrides.deadlineMinutes ?? config.deadlineMinutes, 1, 720),
      attempts: clamp(config.attempts, 1, 5),
      maxModelCalls: clamp(overrides.maxModelCalls ?? config.maxModelCallsPerRun, 0, 10000),
      maxTokens: clamp(overrides.maxTokens ?? config.maxTokensPerRun, 0, 1e12),
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
    return spawnChild({ ...spec, signal: rt.controller.signal })
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
        + 'the run is skipped by longhaul_list until you do.',
      )
    }
    throw new Error(`unknown run ${runId}; call longhaul_list to see recorded run ids`)
  }

  /**
   * Mark runs left active by a previous host process as interrupted. Subtasks
   * that were mid-flight become pending so `resume` can retry them.
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
      const requested = await hasCancelRequest(run.id)
      run.status = requested ? 'cancelled' : 'interrupted'
      run.error = requested
        ? 'cancelled by longhaul_cancel while no process was running it'
        : 'host process stopped while the run was active'
      run.finishedAt = new Date(now()).toISOString()
      for (const subtask of run.subtasks ?? []) {
        if (subtask.status === 'running') subtask.status = 'pending'
      }
      await save(run)
      await clearCancel(run.id)
      recovered.push(run.id)
    }
    return recovered
  }

  function trackUsage(run, key, childId) {
    return readUsage(childId).then(usage => {
      if (usage) run.steps[key] = { childId, usage }
      return usage
    }).catch(() => null)
  }

  async function makePlan(run, parent, rt) {
    try {
      const handle = await spawn(run, rt, {
        label: 'longhaul-plan',
        prompt: plannerPrompt(run.goal, run.limits.maxSubtasks),
        parent,
      })
      rt.activations.add(handle)
      run.steps.planner = { childId: handle.childId }
      try {
        const result = await handle.result
        const text = textOf(result.output)
        const subtasks = extractPlan(text).slice(0, run.limits.maxSubtasks)
        await trackUsage(run, 'planner', handle.childId)
        if (subtasks.length > 0) return { mode: 'planned', subtasks }
        log(`planner reply had no parsable plan; running the goal as one subtask`)
      } finally {
        rt.activations.delete(handle)
        await handle.dispose()
      }
    } catch (error) {
      log(`planner failed: ${error?.message ?? error}`)
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
          label: `longhaul-${subtask.index}`,
          prompt: workerPrompt(run, subtask),
          parent,
        })
        rt.activations.add(handle)
        subtask.childId = handle.childId
        await save(run)

        const result = await handle.result
        const text = textOf(result.output)
        subtask.stopReason = result.stopReason
        if (result.stopReason === 'completed' && text) {
          subtask.status = 'completed'
          subtask.result = capText(text, config.resultCapBytes)
          subtask.error = null
          subtask.finishedAt = new Date(now()).toISOString()
          subtask.usage = await readUsage(handle.childId).catch(() => null)
          run.steps.subtasks = run.steps.subtasks ?? {}
          if (subtask.usage) run.steps.subtasks[subtask.index] = subtask.usage
          await save(run)
          return
        }
        subtask.error = result.diagnostic || `child stopped with reason "${result.stopReason}"`
        log(`subtask ${subtask.index} attempt ${attempt} did not complete: ${subtask.error}`)
      } catch (error) {
        subtask.error = error?.message ?? String(error)
        log(`subtask ${subtask.index} attempt ${attempt} threw: ${subtask.error}`)
      } finally {
        if (handle) {
          rt.activations.delete(handle)
          await handle.dispose()
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
      subtask.status = 'failed'
      subtask.finishedAt = new Date(now()).toISOString()
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
        label: 'longhaul-aggregate',
        prompt: aggregatorPrompt(run, completed),
        parent,
      })
      rt.activations.add(handle)
      run.steps.aggregator = { childId: handle.childId }
      try {
        const result = await handle.result
        const text = textOf(result.output)
        await trackUsage(run, 'aggregator', handle.childId)
        if (result.stopReason === 'completed' && text) return text
        log(`aggregator did not complete (${result.stopReason}); using deterministic merge`)
      } finally {
        rt.activations.delete(handle)
        await handle.dispose()
      }
    } catch (error) {
      log(`aggregator failed: ${error?.message ?? error}`)
    }
    return deterministicJoin(run)
  }

  function terminalStatus(run, rt) {
    if (rt.abortCause === 'cancelled') return 'cancelled'
    const completed = run.subtasks.filter(subtask => subtask.status === 'completed').length
    if (completed === 0) return 'failed'
    if (rt.abortCause === 'deadline') {
      return completed === run.subtasks.length ? 'completed' : 'partial'
    }
    return completed === run.subtasks.length ? 'completed' : 'partial'
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
        rt.controller.abort(new Error('cancelled by longhaul_cancel from another process'))
        // Aborting the signal alone does not stop a child that is already
        // running; dispose its activation so it stops spending tokens.
        for (const handle of [...rt.activations]) handle.dispose().catch(() => {})
      }).catch(() => {})
    }, CANCEL_POLL_MS)
    timer.unref?.()
    return timer
  }

  async function execute(run, parent, rt) {
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
      save(run).catch(() => {})
    }, HEARTBEAT_MS)
    beat.unref?.()

    try {
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
      clearInterval(beat)
      const entries = [
        run.steps?.planner?.usage,
        run.steps?.aggregator?.usage,
        ...run.subtasks.map(subtask => subtask.usage),
      ]
      run.usage = sumUsage(entries)
      run.cost = computeCost(run.usage, config.pricing)
      run.finishedAt = new Date(now()).toISOString()
      run.status = terminalStatus(run, rt)
      if (rt.abortCause === 'cancelled') {
        run.error = 'cancelled by longhaul_cancel'
      } else if (run.status === 'failed' && !run.error) {
        run.error = run.subtasks.map(subtask => subtask.error).filter(Boolean).slice(0, 3).join('; ') || 'no subtask completed'
      }
      if (rt.abortCause === 'deadline' && !run.error) run.error = 'deadline exceeded'
      await save(run).catch(error => log(`cannot persist final state for ${run.id}: ${error?.message ?? error}`))
      // The run is terminal, so a leftover marker would only make the next
      // mount rewrite a finished run; drop it now.
      await clearCancel(run.id)
      if (rt.waiters === 0 && TERMINAL_STATUSES.has(run.status)) {
        try {
          const outcome = notify(run) ?? { delivered: true }
          run.notify = {
            at: new Date(now()).toISOString(),
            delivered: outcome.delivered !== false,
            reason: outcome.reason ?? null,
          }
        } catch (error) {
          run.notify = {
            at: new Date(now()).toISOString(),
            delivered: false,
            reason: `notification threw: ${error?.message ?? error}`,
          }
          log(`notification failed for ${run.id}: ${error?.message ?? error}`)
        }
      } else if (TERMINAL_STATUSES.has(run.status)) {
        // A caller is already reading the run, so waking the session would be
        // duplicate noise. Recorded so the boundary is visible in the state.
        run.notify = {
          at: new Date(now()).toISOString(),
          delivered: false,
          reason: 'skipped: a caller was already polling longhaul_status',
        }
      }
      if (run.notify) {
        await save(run).catch(error => log(`cannot persist notify outcome for ${run.id}: ${error?.message ?? error}`))
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
    rt.promise = execute(run, parent, rt).catch(error => {
      log(`run ${run.id} crashed: ${error?.message ?? error}`)
    })
    return rt
  }

  async function start({ goal, parentSessionId, parent, clientTimeZone, overrides = {} }) {
    const trimmed = typeof goal === 'string' ? goal.trim() : ''
    if (!trimmed) throw new Error('goal is required')
    if (!parent || typeof parent !== 'object') throw new Error('longhaul requires a live parent agent')

    const limits = buildLimits(overrides)
    const task = async () => {
      const active = await activeCount()
      if (active >= config.maxActiveRuns) {
        throw new Error(
          `quota exceeded: ${active} active run(s) and maxActiveRuns is ${config.maxActiveRuns}. `
          + 'Let one finish with longhaul_status or cancel it with longhaul_cancel.',
        )
      }
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
        plan: null,
        subtasks: [],
        steps: {},
        report: null,
        error: null,
        usage: null,
        notified: false,
      }
      await store.write(run)
      schedule(run, parent)
      return run
    }
    const result = startGate.then(task, task)
    startGate = result.catch(() => {})
    return result
  }

  async function resume(runId, parent, clientTimeZone) {
    const existing = liveRun(runId)
    if (existing && ACTIVE_STATUSES.has(existing.status)) {
      throw new Error(`run ${runId} is still active (${existing.status}); wait for it or cancel it`)
    }
    const run = await loadRun(runId)
    if (run.status === 'completed') return run
    if (!parent || typeof parent !== 'object') throw new Error('longhaul requires a live parent agent')
    // A resume is an explicit request to keep going, so it wins over an earlier
    // cancel marker (which would otherwise abort the run one second in).
    await clearCancel(runId)

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
    run.resumedAt = new Date(now()).toISOString()
    run.parentSessionId = run.parentSessionId
    run.clientTimeZone = clientTimeZone ?? run.clientTimeZone ?? null
    run.deadlineAt = new Date(now() + run.limits.deadlineMinutes * 60000).toISOString()
    await save(run)
    schedule(run, parent)
    return run
  }

  async function cancel(runId) {
    const rt = runtime.get(runId)
    if (rt && ACTIVE_STATUSES.has(rt.run.status)) {
      rt.abortCause = 'cancelled'
      rt.controller.abort(new Error('cancelled by longhaul_cancel'))
      const activations = [...rt.activations]
      await Promise.all(activations.map(handle => handle.dispose().catch(() => {})))
      await Promise.race([rt.promise ?? Promise.resolve(), sleep(CANCEL_ACK_MS)])
      if (ACTIVE_STATUSES.has(rt.run.status)) rt.run.cancelPending = true
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
    run.cancelPending = true
    return run
  }

  async function status(runId, waitSeconds = 0) {
    const rt = runtime.get(runId)
    const read = async () => liveRun(runId) ?? await store.read(runId)
    let run = await read()
    if (!run) {
      await loadRun(runId)
      throw new Error(`unknown run ${runId}`)
    }
    const limit = clamp(waitSeconds, 0, 3600)
    if (limit <= 0 || TERMINAL_STATUSES.has(run.status)) return run

    if (rt) rt.waiters++
    try {
      const endsAt = now() + limit * 1000
      while (now() < endsAt) {
        await sleep(STATUS_POLL_MS)
        run = await read()
        if (!run || TERMINAL_STATUSES.has(run.status)) break
      }
      return run ?? (await read())
    } finally {
      if (rt) rt.waiters = Math.max(0, rt.waiters - 1)
    }
  }

  async function list() {
    const merged = new Map()
    for (const run of await store.list()) merged.set(run.id, run)
    for (const [runId, rt] of runtime) merged.set(runId, rt.run)
    return [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  return { recover, start, resume, cancel, status, list, activeCount, liveRun }
}
