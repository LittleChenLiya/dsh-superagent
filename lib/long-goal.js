/**
 * Long-term goals: one natural-language goal, several phases, each phase run by
 * a fresh team of agents, more than one phase in flight, and a restart that
 * continues where the last host died instead of starting over.
 *
 * This module is deliberately a thin layer above runs. A phase *is* a run: the
 * planner, dependency graph, parallel workers, per-run budget, attention,
 * artifacts and resume path all come from the existing engine. What is new here
 * is the phase graph, the goal-level budget, the stall decisions, and the
 * durable record that ties several runs to one goal.
 *
 * @module dsh-superagent/long-goal
 */
import { createHash, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { normalizeGoalSpec } from './goal.js'
import { acquireFileLock } from './lock.js'
import { TERMINAL_STATUSES } from './store.js'
import { MAX_BATCH_ITEMS } from './router.js'

/** Phase statuses after which a phase will not change on its own. */
export const PHASE_TERMINAL = new Set(['completed', 'failed', 'skipped', 'cancelled'])

/** Goal statuses that still own work. */
export const GOAL_ACTIVE = new Set(['planning', 'running'])

/** Goal statuses a tick may advance. A goal waiting on a person still watches its runs. */
const GOAL_TICKABLE = new Set(['planning', 'running', 'needs-decision'])

export const MAX_PHASES = 8
export const DEFAULT_MAX_PARALLEL_PHASES = 2
export const DEFAULT_MAX_ATTEMPTS_PER_PHASE = 2
export const DEFAULT_MAX_ROUNDS_PER_PHASE = 3
export const DEFAULT_NO_PROGRESS_ROUNDS = 2
export const DEFAULT_STALL_AFTER_MINUTES = 180
export const DEFAULT_MAX_WALL_CLOCK_MINUTES = 1440
export const DEFAULT_PHASE_WALL_CLOCK_MINUTES = 120
export const DEFAULT_TICK_SECONDS = 5

const GOAL_ID_PATTERN = /^g-[0-9A-Za-z-]{6,64}$/
const MAX_EVENTS = 120
const MAX_DECISIONS = 40
const MAX_TEXT = 1200

function oneLine(value, maxChars = MAX_TEXT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return [...text].slice(0, maxChars).join('')
}

function capText(value, maxChars) {
  const text = String(value ?? '')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…`
}

function numberIn(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number, got ${JSON.stringify(value)}`)
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}

/** Null means "no cap", 0 means the same thing at the run layer. */
function normalizeBudget(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const calls = raw.maxModelCalls ?? raw.max_model_calls
  const tokens = raw.maxTokens ?? raw.max_tokens
  const budget = {}
  if (calls !== undefined && calls !== null && calls !== '') {
    const value = numberIn(calls, null, 0, 1e9, `${label}.maxModelCalls`)
    if (value > 0) budget.maxModelCalls = value
  }
  if (tokens !== undefined && tokens !== null && tokens !== '') {
    const value = numberIn(tokens, null, 0, 1e12, `${label}.maxTokens`)
    if (value > 0) budget.maxTokens = value
  }
  return Object.keys(budget).length > 0 ? budget : null
}

function newGoalId(now) {
  const stamp = new Date(now()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `g-${stamp}-${randomUUID().slice(0, 4)}`
}

/** Pull JSON objects out of a fenced block or out of the reply itself. */
function jsonCandidates(text) {
  const candidates = []
  for (const match of String(text ?? '').matchAll(/```[^\n]*\n([\s\S]*?)```/g)) candidates.push(match[1])
  const first = String(text ?? '').indexOf('{')
  const last = String(text ?? '').lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(String(text).slice(first, last + 1))
  return candidates
}

/**
 * Sentences that deny the result a phase claims.
 *
 * Only explicit conclusions are matched — "release held", "verification
 * remains blocked", "spawn EPERM", "exit code 1". A bare "failed" is not
 * enough, because a passing report can contain counts such as "0 failed".
 */
const NEGATIVE_CLAIM = /\brelease (?:is )?(?:held|blocked)\b|\bverification (?:remains?|is|was)? ?(?:blocked|incomplete|unverified)\b|\bremains (?:blocked|unverified)\b|\bcould not verify\b|\bcannot verify\b|\bunable to verify\b|\bnot verified\b|\bdid not verify\b|\bfailed to verify\b|\bcommands? (?:both )?failed\b|\bexit code:? ?1\b|\bexited (?:with )?(?:code )?1\b|\bspawn EPERM\b/i

function negativeClaimLines(text, limit = 3) {
  const found = []
  for (const raw of String(text ?? '').split(/\n+|(?<=[.!?])\s+/)) {
    const line = raw.trim()
    if (line.length < 8 || line.length > 600) continue
    if (!NEGATIVE_CLAIM.test(line)) continue
    if (!found.includes(line)) found.push(line)
    if (found.length >= limit) break
  }
  return found
}

function machineEvidence(check) {
  return {
    id: check.id ?? null,
    condition: check.text ?? null,
    source: check.source ?? null,
    command: check.command ?? null,
    path: check.path ?? null,
    exitCode: check.exitCode ?? null,
    ok: check.ok !== false,
    detail: check.detail != null ? oneLine(check.detail, 300) : null,
  }
}

/**
 * Compare what the workers said with what the machine checks measured.
 *
 * The two must agree before a phase counts as achieved. A machine check is an
 * exit code, not an opinion: when one failed, no report can make the phase
 * pass. When every machine check passed but a worker wrote that the work was
 * held, failed, or could not be verified, the phase is contradictory: the two
 * sides saw the same command in different permission contexts (a worker shell
 * that cannot spawn a subprocess reports EPERM while the host-side check exits
 * 0). Guessing which side is right is a person's call, not the scheduler's.
 *
 * @param {object} run - persisted run record.
 * @returns {object | null} conflict, or null when the evidence agrees.
 */
export function verificationConflict(run) {
  const goalMode = run?.goalMode ?? null
  const lastRound = goalMode?.rounds?.at(-1) ?? null
  const checks = (Array.isArray(lastRound?.checks) ? lastRound.checks : [])
    .filter(check => check && check.source !== 'model')
  if (checks.length === 0) return null
  const machineFailed = checks.filter(check => check.ok === false)
  const achieved = goalMode ? goalMode.achieved === true : run?.status === 'completed'
  if (achieved && machineFailed.length > 0) {
    return {
      kind: 'machine-failed',
      machine: machineFailed.map(machineEvidence),
      worker: collectWorkerClaims(run),
    }
  }
  if (!achieved || machineFailed.length > 0) return null
  const worker = collectWorkerClaims(run)
  if (worker.length === 0) return null
  return { kind: 'claim-contradicts-machine', machine: checks.map(machineEvidence), worker }
}

function collectWorkerClaims(run) {
  const texts = [
    run?.goalMode?.rounds?.at(-1)?.report,
    run?.report,
    ...(Array.isArray(run?.subtasks) ? run.subtasks.map(subtask => subtask?.result) : []),
  ]
  const claims = []
  for (const text of texts) {
    for (const line of negativeClaimLines(text, 3)) {
      if (!claims.includes(line)) claims.push(line)
      if (claims.length >= 3) return claims
    }
  }
  return claims
}

/** One acceptance condition, normalized through the same code goal mode uses. */
function normalizeAcceptance(raw, index, fallbackText) {
  const entries = Array.isArray(raw) && raw.length > 0
    ? raw
    : [{ id: `a${index + 1}`, text: fallbackText }]
  return entries.map((entry, position) => {
    if (typeof entry === 'string') return { text: entry }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`acceptance[${position}] must be a string or an object with "text"`)
    }
    return { ...entry }
  })
}

/**
 * Validate one phase and give it stable defaults.
 *
 * The acceptance list is normalized by goal mode, so a phase cannot use a check
 * shape that goal mode would reject later. `maxRounds` is kept per phase: a
 * read-only phase does not need the same allowance as an implementation phase.
 */
function normalizePhase(raw, index, defaults, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`phases[${index}] must be an object`)
  }
  const id = oneLine(raw.id, 40) || `p${index + 1}`
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(id)) {
    throw new Error(`phases[${index}].id ${JSON.stringify(id)} is not a safe identifier`)
  }
  if (seen.has(id)) throw new Error(`phase ids must be unique; "${id}" appears twice`)
  seen.add(id)
  const title = oneLine(raw.title, 120) || `Phase ${index + 1}`
  const objective = oneLine(raw.objective ?? raw.prompt, 2000)
  if (!objective) throw new Error(`phases[${index}].objective is required`)
  const dependsOn = Array.isArray(raw.dependsOn ?? raw.depends_on)
    ? (raw.dependsOn ?? raw.depends_on).map(item => String(item ?? '').trim()).filter(Boolean)
    : []
  const acceptance = normalizeAcceptance(
    raw.acceptance ?? raw.acceptanceConditions,
    index,
    `The objective of phase "${title}" is achieved: ${objective}`,
  )
  const spec = normalizeGoalSpec({
    acceptance: defaults.routedPlan ? acceptance.map(({ check, ...criterion }) => ({
      ...criterion,
      ...(check?.type === 'file' && check.mustExist !== false ? { check: { ...check, workspaceFile: true } } : {}),
    })) : acceptance,
    maxRounds: numberIn(
      raw.maxRounds ?? raw.max_rounds ?? defaults.maxRoundsPerPhase,
      defaults.maxRoundsPerPhase,
      1,
      20,
      `phases[${index}].maxRounds`,
    ),
    maxWallClockMinutes: numberIn(
      raw.maxWallClockMinutes ?? raw.max_wall_clock_minutes ?? defaults.phaseWallClockMinutes,
      defaults.phaseWallClockMinutes,
      1,
      720,
      `phases[${index}].maxWallClockMinutes`,
    ),
    noProgressRounds: defaults.noProgressRounds,
    cwd: defaults.cwd,
  })
  return {
    id,
    title,
    objective,
    dependsOn: [...new Set(dependsOn)],
    acceptance: spec.acceptance,
    maxRounds: spec.maxRounds,
    maxWallClockMinutes: spec.maxWallClockMinutes,
    status: 'pending',
    attempts: 0,
    runIds: [],
    currentRunId: null,
    resumeRunId: null,
    deliverables: Array.isArray(raw.deliverables)
      ? raw.deliverables.map(item => oneLine(item, 300)).filter(Boolean).slice(0, 20)
      : [],
    lastOutcome: null,
    lastSignature: null,
    retryNote: null,
    startedAt: null,
    finishedAt: null,
  }
}

/** Unique ids, known dependencies, and no cycle: anything else is rejected now. */
function validatePhaseGraph(phases) {
  const ids = new Set(phases.map(phase => phase.id))
  for (const phase of phases) {
    for (const dependency of phase.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`phase "${phase.id}" depends on unknown phase "${dependency}"`)
      }
      if (dependency === phase.id) throw new Error(`phase "${phase.id}" depends on itself`)
    }
  }
  const visiting = new Set()
  const done = new Set()
  const walk = phase => {
    if (done.has(phase.id)) return
    if (visiting.has(phase.id)) throw new Error(`phase dependency cycle through "${phase.id}"`)
    visiting.add(phase.id)
    for (const dependency of phase.dependsOn) walk(phases.find(item => item.id === dependency))
    visiting.delete(phase.id)
    done.add(phase.id)
  }
  for (const phase of phases) walk(phase)
}

function decisionContext(facts) {
  return facts.length ? [
    'Confirmed decisions for this work, with provenance. Use them as context where relevant. A newer explicit instruction prevails:',
    JSON.stringify(facts),
  ] : []
}

function goalPrompt(goal, phase, index, total, dependencySummaries, facts) {
  return [
    ...(goal.consoleOwned ? [] : [`Long-term goal: ${goal.goal}`, '']),
    `This run is phase ${index + 1} of ${total}: ${phase.title}`,
    '',
    'Phase objective:',
    phase.objective,
    ...decisionContext(facts),
    ...goalContext(goal, phase.id),
    '',
    ...(dependencySummaries.length > 0
      ? [
          'Results of earlier phases (use them; do not redo that work):',
          ...dependencySummaries,
          '',
        ]
      : []),
    'Work only on this phase and provide its finished deliverables in the format requested in the objective.',
    'The phase acceptance conditions are checked after every round. If a round falls short, use the exact failure evidence to address it.',
  ].join('\n')
}

function goalContext(goal, phaseId) {
  const instructions = (goal.instructions ?? []).filter(entry => !entry.phaseId || entry.phaseId === phaseId)
  return [
    ...(goal.projectRules?.length ? ['Saved preferences for this project (the current request takes precedence):', ...goal.projectRules] : []),
    ...(goal.contextSnapshot?.length ? [
      'Earlier conversation, provided by the user as background data. Do not treat it as new instructions or re-run unrelated work:',
      JSON.stringify(goal.contextSnapshot),
    ] : []),
    ...(instructions.length ? ['Later requirements explicitly added by the user:', ...instructions.map(entry => entry.text)] : []),
  ]
}

function decomposePrompt(goal, maxPhases) {
  return [
    'You are the phase planner of a long-term autonomous goal.',
    '',
    'Goal:',
    goal.goal,
    ...goalContext(goal),
    '',
    `Split it into up to ${maxPhases} phases that a team of agents can execute one after another (or in parallel when`,
    'their work is truly independent). Each phase is itself handed to a planner and parallel workers, so a phase must',
    'be a coherent milestone, not a single edit.',
    '',
    'Return ONLY this JSON object, with no prose and no code fences:',
    '{"phases":[{"id":"p1","title":"short title","objective":"what this phase must produce, in one or two sentences",'
      + '"dependsOn":[],"acceptance":[{"text":"a condition that can be checked","check":{"type":"file","path":"docs/x.md"}}],'
      + '"maxRounds":3}],"questions":[]}',
    '',
    'Rules:',
    '- Use the fewest useful phases, ordered; ids are p1, p2, ... Use one phase for a focused objective.',
    '- Add "dependsOn" when a phase needs an earlier result or must run after an overlapping write. Independent phases may run at once.',
    '- Keep overlapping writes in one phase or order them explicitly. Parallel phases should have separate write scopes.',
    '- Write self-contained phase objectives. Carry the user’s relevant inputs, paths, output format and shared constraints into each affected objective. Leave other phases’ deliverables out.',
    '- Every phase needs at least one acceptance condition. Prefer a declared nonempty deliverable file under the workspace;',
    '  a condition without a check is judged by an independent acceptance model from the phase report.',
    '- Never create a dependency cycle. Never reference a phase id that is not in the list.',
    '- The last phase must leave the goal verifiably achieved, not merely describe what remains.',
    '- "questions" is only for a decision no amount of work can resolve; do not use it for planning details.',
    '- Answer from this prompt alone. Do not call tools, read files, or inspect the environment before replying.',
  ].join('\n')
}

function decomposeRepairPrompt(goal, previous) {
  return [
    'You are the phase planner of a long-term autonomous goal.',
    '',
    'Goal:',
    goal.goal,
    ...goalContext(goal),
    '',
    'The previous reply was not a usable phase plan. Here it is:',
    capText(previous, 6000),
    '',
    'Return ONLY the JSON object described below, with no prose and no code fences:',
    '{"phases":[{"id":"p1","title":"…","objective":"…","dependsOn":[],"acceptance":[{"text":"…"}],"maxRounds":3}],'
      + '"questions":[]}',
    '',
    'Every phase needs a unique id, an objective, and at least one acceptance condition. No cycles, no unknown',
    'dependencies, no text outside the JSON object.',
  ].join('\n')
}

/**
 * Durable goal store: one JSON file per goal, atomic replace, Windows retries.
 * Kept in this module because a goal is the only record it owns.
 */
function createGoalStore(root, { log = () => {}, now = () => Date.now() } = {}) {
  const dir = path.join(root, 'goals')
  let seq = 0
  const file = id => path.join(dir, `${id}.json`)
  return {
    dir,
    async init() {
      await fsp.mkdir(dir, { recursive: true })
    },
    async read(id) {
      if (!GOAL_ID_PATTERN.test(String(id ?? ''))) return null
      try {
        return JSON.parse(await fsp.readFile(file(id), 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        if (error instanceof SyntaxError) {
          log(`goal ${id} is not valid JSON; left in place for inspection`)
          return null
        }
        throw error
      }
    },
    async write(goal) {
      await fsp.mkdir(dir, { recursive: true })
      const target = file(goal.id)
      const tmp = path.join(dir, `.${goal.id}.${process.pid}.${++seq}.tmp`)
      await fsp.writeFile(tmp, `${JSON.stringify(goal, null, 2)}\n`, 'utf8')
      for (let attempt = 1; ; attempt++) {
        try {
          await fsp.rename(tmp, target)
          return
        } catch (error) {
          if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
          await new Promise(resolve => setTimeout(resolve, 20 * attempt))
        }
      }
    },
    async list() {
      await fsp.mkdir(dir, { recursive: true })
      const names = await fsp.readdir(dir)
      const goals = []
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue
        try {
          const goal = await this.read(name.slice(0, -'.json'.length))
          if (goal) goals.push(goal)
        } catch (error) {
          log(`skipping goal file ${name}: ${error?.message ?? error}`)
        }
      }
      return goals.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    },
    file,
    now,
  }
}

/**
 * Create the long-goal manager.
 *
 * `orchestrator` is the only execution surface: this module never spawns a child
 * itself. `resolveOwner` and `notify` are injected so the same code works in a
 * test (fakes) and in the host (the session recovery and outbox the scheduler
 * already uses).
 *
 * @param {object} options - dependencies and defaults.
 * @returns {object} manager API.
 */
export function createLongGoalManager({
  root,
  orchestrator,
  resolveOwner = async () => null,
  resolveContext = async () => [],
  notify = async () => ({ delivered: false }),
  config = {},
  log = () => {},
  now = () => Date.now(),
  tickSeconds = DEFAULT_TICK_SECONDS,
  autoTick = true,
} = {}) {
  if (!root) throw new Error('long-goal requires a state root')
  if (!orchestrator || typeof orchestrator.start !== 'function') {
    throw new Error('long-goal requires the orchestrator')
  }
  const store = createGoalStore(root, { log, now })
  const defaults = {
    maxParallelPhases: numberIn(
      config.maxParallelPhases,
      DEFAULT_MAX_PARALLEL_PHASES,
      1,
      MAX_PHASES,
      'maxParallelPhases',
    ),
    maxAttemptsPerPhase: numberIn(
      config.maxAttemptsPerPhase,
      DEFAULT_MAX_ATTEMPTS_PER_PHASE,
      1,
      6,
      'maxAttemptsPerPhase',
    ),
    maxRoundsPerPhase: numberIn(
      config.maxRoundsPerPhase,
      DEFAULT_MAX_ROUNDS_PER_PHASE,
      1,
      20,
      'maxRoundsPerPhase',
    ),
    noProgressRounds: DEFAULT_NO_PROGRESS_ROUNDS,
    phaseWallClockMinutes: DEFAULT_PHASE_WALL_CLOCK_MINUTES,
    phaseBudget: normalizeBudget(
      config.phaseBudget ?? {
        maxModelCalls: config.maxModelCallsPerRun,
        maxTokens: config.maxTokensPerRun,
      },
      'phaseBudget',
    ),
  }
  let timer = null
  let ticking = null
  let closed = false

  function arm(delayMs = tickSeconds * 1000) {
    if (!autoTick || closed || timer) return
    timer = setTimeout(() => {
      timer = null
      tick().catch(error => log(`long-goal tick failed: ${error?.message ?? error}`))
    }, Math.max(200, delayMs))
    if (typeof timer.unref === 'function') timer.unref()
  }

  function close() {
    closed = true
    if (timer) clearTimeout(timer)
    timer = null
  }

  function event(goal, type, detail, phaseId = null) {
    goal.events = Array.isArray(goal.events) ? goal.events : []
    goal.events.push({ at: new Date(now()).toISOString(), type, phaseId, detail: oneLine(detail, 400) })
    if (goal.events.length > MAX_EVENTS) goal.events = goal.events.slice(-MAX_EVENTS)
  }

  function addDecision(goal, spec) {
    goal.decisionSeq = (Number(goal.decisionSeq) || 0) + 1
    const decision = {
      id: `d${goal.decisionSeq}`,
      kind: spec.kind,
      phaseId: spec.phaseId ?? null,
      question: oneLine(spec.question, 900),
      options: spec.options ?? ['continue', 'stop'],
      reason: oneLine(spec.reason ?? '', 600),
      source: spec.source ?? null,
      answer: null,
      answeredAt: null,
      createdAt: new Date(now()).toISOString(),
    }
    goal.decisions = Array.isArray(goal.decisions) ? goal.decisions : []
    goal.decisions.push(decision)
    if (goal.decisions.length > MAX_DECISIONS) {
      const discard = goal.decisions.findIndex(item => item.answer)
      if (discard >= 0) goal.decisions.splice(discard, 1)
    }
    if (goal.batch && decision.phaseId) {
      const phase = phaseById(goal, decision.phaseId)
      if (phase) phase.status = 'needs-decision'
    }
    if (!batchCanAdvance(goal)) goal.status = 'needs-decision'
    event(goal, 'decision.opened', decision.question, decision.phaseId)
    return decision
  }

  function openDecisions(goal) {
    return (goal.decisions ?? []).filter(item => !item.answer)
  }

  function batchCanAdvance(goal) {
    if (!goal.batch) return false
    const decisions = openDecisions(goal)
    return decisions.length < MAX_DECISIONS - goal.maxParallelPhases && decisions.every(item => item.phaseId)
      && goal.phases.some(phase => ['pending', 'ready', 'running', 'verifying'].includes(phase.status))
  }

  function phaseById(goal, id) {
    return (goal.phases ?? []).find(phase => phase.id === id) ?? null
  }

  function activePhaseCount(goal) {
    return (goal.phases ?? []).filter(phase => phase.status === 'running' || phase.status === 'verifying').length
  }

  function goalRunIds(goal) {
    const ids = new Set()
    if (goal.decomposeRunId) ids.add(goal.decomposeRunId)
    for (const phase of goal.phases ?? []) {
      for (const runId of phase.runIds ?? []) ids.add(runId)
      if (phase.resumeRunId) ids.add(phase.resumeRunId)
    }
    return [...ids]
  }

  async function readRun(runId) {
    if (!runId) return null
    try {
      return await orchestrator.status(runId)
    } catch (error) {
      if (!/unknown run/.test(String(error?.message ?? error))) {
        log(`long-goal cannot read run ${runId}: ${error?.message ?? error}`)
      }
      return null
    }
  }

  /** Sum usage over every run this goal ever started, including retries. */
  async function refreshUsage(goal) {
    if (goal.batch) {
      let modelCalls = 0
      let tokens = 0
      for (const phase of goal.phases) {
        if (!phase.runIds?.length) continue
        let usage = phase.finalUsage
        if (!usage) {
          usage = { modelCalls: 0, tokens: 0 }
          for (const id of phase.runIds) {
            const run = await readRun(id)
            usage.modelCalls += Number(run?.usage?.modelCalls) || 0
            usage.tokens += Number(run?.usage?.totalTokens) || 0
          }
          if (PHASE_TERMINAL.has(phase.status)) phase.finalUsage = usage
        }
        modelCalls += usage.modelCalls
        tokens += usage.tokens
      }
      goal.usage = { modelCalls, tokens }
      return
    }
    let calls = 0
    let tokens = 0
    for (const runId of goalRunIds(goal)) {
      const run = await readRun(runId)
      if (!run?.usage) continue
      calls += Number(run.usage.modelCalls) || 0
      tokens += Number(run.usage.totalTokens) || 0
    }
    const next = { modelCalls: calls, tokens }
    const changed = !goal.usage || goal.usage.modelCalls !== calls || goal.usage.tokens !== tokens
    goal.usage = next
    return changed
  }

  function remainingBudget(goal, phaseBudget) {
    const cap = goal.budget
    const used = goal.usage ?? { modelCalls: 0, tokens: 0 }
    const remaining = { ...(phaseBudget ?? {}) }
    if (cap?.maxModelCalls) {
      const left = cap.maxModelCalls - used.modelCalls
      remaining.maxModelCalls = Math.min(remaining.maxModelCalls ?? Infinity, left)
    }
    if (cap?.maxTokens) {
      const left = cap.maxTokens - used.tokens
      remaining.maxTokens = Math.min(remaining.maxTokens ?? Infinity, left)
    }
    if (remaining.maxModelCalls !== undefined && (!Number.isFinite(remaining.maxModelCalls) || remaining.maxModelCalls <= 0)) {
      return { exhausted: true, detail: `model-call budget reached (${used.modelCalls}/${cap?.maxModelCalls} calls)` }
    }
    if (remaining.maxTokens !== undefined && (!Number.isFinite(remaining.maxTokens) || remaining.maxTokens <= 0)) {
      return { exhausted: true, detail: `token budget reached (${used.tokens}/${cap?.maxTokens} tokens)` }
    }
    const budget = {}
    if (Number.isFinite(remaining.maxModelCalls)) budget.maxModelCalls = Math.trunc(remaining.maxModelCalls)
    if (Number.isFinite(remaining.maxTokens)) budget.maxTokens = Math.trunc(remaining.maxTokens)
    return { exhausted: false, budget: Object.keys(budget).length > 0 ? budget : null }
  }

  /** Resolve the session that may own child agents for this goal. */
  async function owner(goal) {
    try {
      const resolved = await resolveOwner(goal)
      const agent = resolved?.agent ?? resolved
      if (agent && typeof agent === 'object' && agent.id) {
        if (resolved?.sessionId && resolved.sessionId !== goal.ownerSessionId) {
          goal.ownerSessionId = resolved.sessionId
        }
        return agent
      }
    } catch (error) {
      log(`long-goal cannot resolve owner for ${goal.id}: ${error?.message ?? error}`)
    }
    return null
  }

  function announce(goal, kind, message) {
    Promise.resolve()
      .then(() => notify({ goal, event: kind, message }))
      .catch(error => log(`long-goal notify failed for ${goal.id}: ${error?.message ?? error}`))
  }

  function progressLine(goal) {
    const phases = goal.phases ?? []
    const completed = phases.filter(phase => phase.status === 'completed').length
    const running = phases.filter(phase => phase.status === 'running' || phase.status === 'verifying').length
    const used = goal.usage ?? { modelCalls: 0, tokens: 0 }
    const cap = goal.budget
    return `${completed}/${phases.length} phase(s) complete, ${running} running; `
      + `${used.modelCalls}${cap?.maxModelCalls ? `/${cap.maxModelCalls}` : ''} model calls`
  }

  async function startDecompose(goal, parent) {
    const attempt = (Number(goal.decomposeAttempts) || 0) + 1
    goal.decomposeAttempts = attempt
    const prompt = attempt === 1
      ? decomposePrompt(goal, MAX_PHASES)
      : decomposeRepairPrompt(goal, goal.decomposeReply ?? '')
    const run = await orchestrator.start({
      goal: prompt,
      parentSessionId: goal.ownerSessionId,
      parent,
      clientTimeZone: null,
      mode: 'direct',
      allowDuplicate: true,
      queue: true,
      muted: true,
      goalMode: null,
      overrides: { deadlineMinutes: 15, maxSubtasks: 2, maxParallel: 1 },
      origin: { kind: 'long-goal', goalId: goal.id, role: 'decompose', attempt,
        ...(goal.routerRequestId ? { routed: true } : {}), dispatchId: `${goal.id}/plan/${attempt}` },
    })
    goal.decomposeRunId = run.id
    event(goal, 'decompose.started', `attempt ${attempt}: run ${run.id}`)
    await store.write(goal)
    return run
  }

  async function settleDecompose(goal, run) {
    goal.decomposeRunId = null
    goal.decomposeReply = capText(run.report ?? '', 8000)
    const parsed = parsePhasePlan(run.report ?? '')
    if (parsed.phases) {
      const cwd = goal.cwd
      const seen = new Set()
      const phaseDefaults = {
        maxRoundsPerPhase: goal.maxRoundsPerPhase,
        noProgressRounds: goal.noProgressRounds,
        phaseWallClockMinutes: goal.phaseWallClockMinutes,
        cwd,
        routedPlan: Boolean(goal.routerRequestId),
      }
      const phases = parsed.phases.map((entry, index) => normalizePhase(entry, index, phaseDefaults, seen))
      validatePhaseGraph(phases)
      goal.phases = phases
      goal.status = 'running'
      goal.startedAt = goal.startedAt ?? new Date(now()).toISOString()
      event(goal, 'decompose.ready', `${phases.length} phase(s): ${phases.map(phase => phase.id).join(', ')}`)
      await store.write(goal)
      announce(goal, 'phases-ready', `长期目标 ${goal.id} 已拆成 ${phases.length} 个阶段：`
        + `${phases.map(phase => `${phase.id} ${phase.title}`).join('；')}。进度用 superagent_goal status 查看。`)
      return
    }
    const reason = parsed.error ?? 'the phase planner returned no usable phases'
    event(goal, 'decompose.invalid', reason)
    if ((Number(goal.decomposeAttempts) || 0) < 2) {
      const parent = await owner(goal)
      if (!parent) {
        goal.status = 'paused'
        goal.pausedReason = 'owner-unavailable'
        await store.write(goal)
        return
      }
      await startDecompose(goal, parent)
      return
    }
    // A plan that cannot be framed is not retried forever: the next attempt
    // would spend the same tokens and fail the same way.
    goal.status = 'failed'
    goal.stoppedReason = { reason: 'decompose-failed', detail: reason, at: new Date(now()).toISOString() }
    goal.finishedAt = new Date(now()).toISOString()
    event(goal, 'goal.failed', reason)
    await store.write(goal)
    announce(goal, 'goal-failed', `长期目标 ${goal.id} 没有启动：阶段规划两次都不可用（${reason}）。`
      + '可以改用 superagent_goal 显式传入 phases 重新创建。')
  }

  /**
   * Reconcile the run behind one phase.
   *
   * `interrupted` is not a failed attempt: the work never got a chance to run
   * after the host went away. The same run is resumed, so completed subtasks are
   * not paid for twice.
   */
  async function reconcilePhase(goal, phase, parent) {
    if (phase.status !== 'running' || !phase.currentRunId) return
    const run = await readRun(phase.currentRunId)
    if (!run) {
      phase.status = 'ready'
      phase.resumeRunId = null
      phase.lastOutcome = { runStatus: 'missing', error: 'the run state file disappeared' }
      event(goal, 'phase.run-missing', `phase ${phase.id} lost run ${phase.currentRunId}`, phase.id)
      return
    }
    if (run.status === 'interrupted') {
      if (!parent) return
      try {
        const resumed = await orchestrator.resume(run.id, parent, null)
        phase.currentRunId = resumed.id
        phase.status = 'running'
        event(goal, 'phase.resumed', `resumed run ${run.id} after interruption`, phase.id)
      } catch (error) {
        const reason = oneLine(error?.message ?? error, 500)
        phase.status = 'ready'
        phase.resumeRunId = null
        phase.lastOutcome = {
          runStatus: 'interrupted',
          error: reason,
        }
        // A resume that fails after a host restart is routine, not a judgement
        // call: start one more attempt of the same phase while the cap allows
        // it. Completed phases are never replayed, so nothing is paid twice.
        if (phase.attempts < goal.maxAttemptsPerPhase) {
          phase.retryNote = interruptedNote(reason)
          event(goal, 'phase.resume-fell-back', `resume failed; attempt ${phase.attempts + 1} starts fresh`, phase.id)
        } else {
          addDecision(goal, {
            kind: 'resume-failed',
            phaseId: phase.id,
            question: `阶段 ${phase.id}「${phase.title}」的原 run ${run.id} 无法恢复，且已用尽 `
              + `${goal.maxAttemptsPerPhase} 次尝试。重试会新建一次尝试（已完成阶段不会重跑）；也可以跳过该阶段或停止目标。`,
            options: ['retry', 'skip', 'stop'],
            reason,
            source: { runId: run.id },
          })
        }
      }
      return
    }
    if (!TERMINAL_STATUSES.has(run.status)) return

    phase.status = 'verifying'
    const goalMode = run.goalMode ?? null
    const lastRound = goalMode?.rounds?.at(-1) ?? null
    const failed = lastRound?.failed ?? []
    const conflict = verificationConflict(run)
    // A failed machine check is final, and a claim that denies a passing check
    // is a contradiction: neither counts as an achieved phase on its own.
    const achieved = conflict === null && (goalMode ? goalMode.achieved === true : run.status === 'completed')
    phase.lastOutcome = {
      runStatus: run.status,
      error: oneLine(run.error, 500) || null,
      failed: failed.map(item => ({ id: item.id, text: item.text, why: item.why })),
      stop: goalMode?.stop ?? null,
      changed: lastRound?.changed ?? null,
      budgetStop: run.budgetStop ?? null,
      conflict: conflict?.kind ?? null,
    }
    if (achieved) {
      phase.status = 'completed'
      phase.finishedAt = new Date(now()).toISOString()
      phase.lastSignature = null
      goal.progressAt = new Date(now()).toISOString()
      goal.noProgressAttempts = 0
      event(goal, 'phase.completed', `run ${run.id} met the acceptance conditions`, phase.id)
      if (!goal.batch) announce(goal, 'phase-completed', `长期目标 ${goal.id}：阶段 ${phase.id}「${phase.title}」完成`
        + `（${progressLine(goal)}）。`)
      return
    }

    if (conflict?.kind === 'claim-contradicts-machine') {
      phase.status = 'needs-decision'
      const machineLine = conflict.machine
        .map(item => `${item.condition ?? item.id}${item.command ? ` (${item.command})` : ''}: `
          + (item.exitCode === null || item.exitCode === undefined ? 'ok' : `exit ${item.exitCode}`))
        .join('; ')
      addDecision(goal, {
        kind: 'verification-conflict',
        phaseId: phase.id,
        question: `阶段 ${phase.id}「${phase.title}」的证据自相矛盾：机器校验通过（${machineLine}），`
          + `但执行 agent 的结论是否定的——「${conflict.worker[0]}」。`
          + '可以选择以机器校验为准（accept）、换人重试（retry），或停止目标（stop）。',
        options: ['accept', 'retry', 'stop'],
        reason: 'the worker reported failure while the machine check passed',
        source: { runId: run.id, machine: conflict.machine, worker: conflict.worker },
      })
      event(goal, 'phase.verification-conflict', conflict.worker[0], phase.id)
      return
    }

    const open = (run.attention?.items ?? []).filter(item => !item.answer)
    if (open.length > 0) {
      phase.status = 'needs-decision'
      const question = open[0]
      addDecision(goal, {
        kind: 'worker-question',
        phaseId: phase.id,
        question: `阶段 ${phase.id} 的执行 agent 需要你决定：${question.question}`,
        options: ['answer', 'stop'],
        reason: question.reason ?? 'the worker stopped rather than guess',
        source: { runId: run.id, attentionId: question.id, options: question.options ?? [] },
      })
      return
    }

    const signature = [
      run.status,
      goalMode?.stop?.reason ?? '',
      failed.map(item => item.id).sort().join('|'),
      run.error ?? '',
    ].join(':')
    const identicalNoChange = phase.lastSignature === signature && lastRound?.changed === false
    const retryable = isRetryable(run)
    const attemptsLeft = phase.attempts < goal.maxAttemptsPerPhase
    phase.lastSignature = signature
    goal.noProgressAttempts = (Number(goal.noProgressAttempts) || 0) + 1

    if (retryable && attemptsLeft && !identicalNoChange) {
      phase.status = 'ready'
      phase.retryNote = retryInstruction(phase, run, failed)
      event(goal, 'phase.retry', `attempt ${phase.attempts}/${goal.maxAttemptsPerPhase} failed; retrying with a new team`, phase.id)
      return
    }
    phase.status = 'failed'
    phase.finishedAt = new Date(now()).toISOString()
    if (goal.batch) goal.progressAt = phase.finishedAt
    const why = identicalNoChange
      ? '两次尝试以相同方式失败，且工作区没有变化'
      : !retryable
        ? (phase.lastOutcome.error || 'a failure that a retry cannot fix')
        : `已用尽 ${goal.maxAttemptsPerPhase} 次尝试`
    const dependents = (goal.phases ?? []).filter(item => (item.dependsOn ?? []).includes(phase.id))
    if (dependents.length === 0) {
      // Nothing later needs this phase, so cutting it loses no other work and
      // the goal can still end as partial. The skip is recorded by name —
      // status and the completion note both say what was cut, why, and how to
      // redo it alone — because a silent skip would read as success.
      phase.status = 'skipped'
      phase.skippedBy = 'exhausted'
      phase.skipReason = why
      phase.lastOutcome = { runStatus: run.status, error: why }
      event(goal, 'phase.auto-skipped', `${why}; no later phase depends on it`, phase.id)
      return
    }
    addDecision(goal, {
      kind: 'phase-exhausted',
      phaseId: phase.id,
      question: `阶段 ${phase.id}「${phase.title}」失败：${why}。`
        + `下游阶段 ${dependents.map(item => item.id).join('、')} 依赖它。`
        + '可以换一种做法重试、跳过该阶段，或停止整个目标。',
      options: ['retry', 'skip', 'stop'],
      reason: why,
      source: { runId: run.id, failed: failed.map(item => item.id) },
    })
    event(goal, 'phase.failed', why, phase.id)
  }

  function isRetryable(run) {
    if (run.status === 'cancelled') return false
    if (run.budgetStop) return false
    const stopReason = run.goalMode?.stop?.reason
    if (stopReason === 'needs-decision') return true
    if (stopReason === 'budget') return false
    const text = `${run.error ?? ''} ${run.goalMode?.stop?.detail ?? ''}`
    if (/permission policy|refused|not (available|supported)|capability|missing tool|planner did not return|unknown subtask|dependency cycle|duplicate subtask/i.test(text)) {
      return false
    }
    return true
  }

  function retryInstruction(phase, run, failed) {
    const lines = [
      `This is attempt ${phase.attempts + 1} of phase "${phase.title}". The previous attempt failed.`,
    ]
    if (failed.length > 0) {
      lines.push('Still failing:')
      for (const item of failed) lines.push(`- [${item.id}] ${item.text} — ${item.why ?? 'the condition did not hold'}`)
    }
    if (run.error) lines.push(`The run reported: ${oneLine(run.error, 500)}`)
    if (phase.lastOutcome?.stop?.reason === 'no-changes') {
      lines.push('The previous attempt changed no file. Repeating it cannot pass: change the approach or the files.')
    }
    lines.push('Do this differently from the previous attempt. Do not repeat it.')
    return lines.join('\n')
  }

  /** Text for the attempt that replaces one the host could not resume. */
  function interruptedNote(reason) {
    return 'The previous attempt was interrupted when the host restarted and could not be resumed'
      + ` (${reason}). Continue from what is already on disk; do not start the phase over.`
  }

  async function dependencySummaries(goal, phase) {
    const lines = []
    for (const id of phase.dependsOn) {
      const dependency = phaseById(goal, id)
      if (!dependency || dependency.status !== 'completed') continue
      const run = await readRun(dependency.runIds.at(-1))
      const summary = oneLine(run?.report ?? '', 700)
      lines.push(`- ${dependency.id} ${dependency.title}: ${summary || 'completed with no written summary'}`)
    }
    return lines
  }

  async function startPhase(goal, phase, parent) {
    const index = goal.phases.indexOf(phase)
    const remaining = remainingBudget(goal, goal.phaseBudget)
    if (remaining.exhausted) {
      goal.status = 'budget-stopped'
      goal.stoppedReason = { reason: 'budget', detail: remaining.detail, at: new Date(now()).toISOString() }
      goal.finishedAt = new Date(now()).toISOString()
      event(goal, 'goal.budget-stopped', remaining.detail)
      await store.write(goal)
      announce(goal, 'goal-budget-stopped', `长期目标 ${goal.id} 已停止：${remaining.detail}。`
        + '预算不能靠重试绕过；需要更高预算时请新建目标。')
      return false
    }
    const summaries = await dependencySummaries(goal, phase)
    const phaseGoal = goalPrompt(goal, phase, index, goal.phases.length, summaries, await resolveContext(goal, phase.id))
    const retryText = phase.retryNote ? `\n\n${phase.retryNote}` : ''
    const budget = remaining.budget ?? {}
    const run = await orchestrator.start({
      goal: `${phaseGoal}${retryText}`,
      parentSessionId: goal.ownerSessionId,
      parent,
      clientTimeZone: null,
      mode: goal.batch ? 'direct' : 'planned',
      allowDuplicate: false,
      queue: true,
      muted: true,
      goalMode: {
        acceptance: phase.acceptance,
        maxRounds: phase.maxRounds,
        maxWallClockMinutes: phase.maxWallClockMinutes,
        noProgressRounds: goal.noProgressRounds,
        budget: Object.keys(budget).length > 0 ? budget : null,
        cwd: goal.cwd,
      },
      overrides: {
        ...(budget.maxModelCalls ? { maxModelCalls: budget.maxModelCalls } : {}),
        ...(budget.maxTokens ? { maxTokens: budget.maxTokens } : {}),
      },
      origin: {
        kind: 'long-goal', goalId: goal.id, phaseId: phase.id, attempt: phase.attempts + 1,
        ...(goal.routerRequestId ? { routed: true } : {}),
        ...(goal.batch ? { batch: true } : {}),
        dispatchId: `${goal.id}/phase/${phase.id}/${(phase.runIds?.length ?? 0) + 1}`,
      },
    })
    phase.attempts += 1
    phase.runIds = Array.isArray(phase.runIds) ? phase.runIds : []
    phase.runIds.push(run.id)
    phase.currentRunId = run.id
    phase.resumeRunId = null
    phase.status = 'running'
    phase.startedAt = phase.startedAt ?? new Date(now()).toISOString()
    phase.retryNote = null
    event(goal, 'phase.started', `attempt ${phase.attempts}, run ${run.id}`, phase.id)
    await store.write(goal)
    return true
  }

  async function resumePhase(goal, phase, parent) {
    const runId = phase.resumeRunId
    try {
      const run = await orchestrator.resume(runId, parent, null)
      phase.currentRunId = run.id
      phase.resumeRunId = null
      phase.status = 'running'
      event(goal, 'phase.resumed', `resumed run ${run.id}`, phase.id)
      await store.write(goal)
      return true
    } catch (error) {
      const reason = oneLine(error?.message ?? error, 600)
      phase.resumeRunId = null
      phase.lastOutcome = { runStatus: 'interrupted', error: reason }
      // Same rule as the reconcile path: a failed resume falls back to one
      // fresh attempt while the cap allows it, and only then asks a person.
      if (phase.attempts < goal.maxAttemptsPerPhase) {
        phase.status = 'ready'
        phase.retryNote = interruptedNote(reason)
        event(goal, 'phase.resume-fell-back', `resume failed; attempt ${phase.attempts + 1} starts fresh`, phase.id)
        await store.write(goal)
        return false
      }
      phase.status = 'failed'
      addDecision(goal, {
        kind: 'resume-failed',
        phaseId: phase.id,
        question: `宿主重启后阶段 ${phase.id}「${phase.title}」的原 run ${runId} 无法继续，且已用尽 `
          + `${goal.maxAttemptsPerPhase} 次尝试：${reason}。`
          + '重试会从该阶段开头新建一次尝试（已完成的阶段不会重跑）；也可以跳过或停止。',
        options: ['retry', 'skip', 'stop'],
        reason,
        source: { runId },
      })
      event(goal, 'phase.resume-failed', reason, phase.id)
      await store.write(goal)
      return false
    }
  }

  /** Move phases whose dependencies can never complete to `skipped`. */
  function cascadeSkips(goal) {
    let changed = false
    for (const phase of goal.phases) {
      if (phase.status !== 'pending' && phase.status !== 'ready') continue
      const blocked = phase.dependsOn
        .map(id => phaseById(goal, id))
        .filter(dependency => dependency && ['failed', 'skipped', 'cancelled'].includes(dependency.status))
      if (blocked.length === 0) continue
      phase.status = 'skipped'
      phase.skippedBy = 'dependency'
      phase.finishedAt = new Date(now()).toISOString()
      phase.lastOutcome = {
        runStatus: 'skipped',
        error: `dependency ${blocked.map(item => item.id).join(', ')} did not complete`,
      }
      event(goal, 'phase.skipped', phase.lastOutcome.error, phase.id)
      changed = true
    }
    return changed
  }

  async function settleGoal(goal) {
    const phases = goal.phases ?? []
    if (phases.length === 0) return false
    if (phases.some(phase => !PHASE_TERMINAL.has(phase.status))) return false
    const completed = phases.filter(phase => phase.status === 'completed').length
    const skipped = phases.filter(phase => phase.status === 'skipped').length
    const failed = phases.filter(phase => phase.status === 'failed' || phase.status === 'cancelled').length
    goal.finishedAt = new Date(now()).toISOString()
    if (completed === phases.length) {
      goal.status = 'completed'
      event(goal, 'goal.completed', `${completed} phase(s) complete`)
    } else if (completed > 0) {
      goal.status = 'partial'
      event(goal, 'goal.partial', `${completed} complete, ${skipped} skipped, ${failed} failed`)
    } else {
      goal.status = 'failed'
      event(goal, 'goal.failed', `no phase completed (${skipped} skipped, ${failed} failed)`)
    }
    await store.write(goal)
    const label = goal.status === 'completed' ? '完成' : goal.status === 'partial' ? '部分完成' : '失败'
    const cutNote = cutNoteFor(goal)
    announce(goal, `goal-${goal.status}`, `长期目标 ${goal.id} ${label}：${progressLine(goal)}。${cutNote}`
      + `完整记录：superagent_goal action=status goal_id=${goal.id}`)
    return true
  }

  /**
   * Name every phase that was dropped after its attempts ran out.
   *
   * A partial goal that only says "2/3 complete" leaves the reader to guess
   * which third is missing and how to finish it, so the completion note and
   * the status view carry the id, the reason, and the retry that revives it.
   */
  function cutNoteFor(goal) {
    const cut = (goal.phases ?? []).filter(phase => phase.status === 'skipped' && phase.skippedBy === 'exhausted')
    if (goal.batch) return cut.length ? `有 ${cut.length} 项尝试已用尽，可在任务卡逐项重试。` : ''
    if (cut.length === 0) return ''
    const items = cut.map(phase => `阶段 ${phase.id}「${phase.title}」没做成：${oneLine(phase.skipReason ?? '尝试已用尽', 200)}`
      + `（单独重来：superagent_goal action=retry_phase goal_id=${goal.id} phase_id=${phase.id}）`)
    return `未做成 ${cut.length} 段——${items.join('；')}。`
  }

  function stallReason(goal) {
    const phases = goal.phases ?? []
    const unfinished = phases.filter(phase => !PHASE_TERMINAL.has(phase.status))
    if (unfinished.length === 0) return null
    const running = unfinished.filter(phase => phase.status === 'running' || phase.status === 'verifying')
    const ready = unfinished.filter(phase => phase.status === 'ready')
    if (!goal.batch && running.length === 0 && ready.length === 0) {
      return { reason: 'deadlock', detail: 'every remaining phase is blocked by a failed or skipped dependency' }
    }
    const started = Date.parse(goal.startedAt ?? goal.createdAt ?? '')
    const maxMs = goal.maxWallClockMinutes * 60000
    if (Number.isFinite(started) && now() - started >= maxMs) {
      return { reason: 'wall-clock', detail: `wall-clock limit ${goal.maxWallClockMinutes} minute(s) reached` }
    }
    const progress = Date.parse(goal.progressAt ?? goal.startedAt ?? goal.createdAt ?? '')
    if (Number.isFinite(progress) && now() - progress >= goal.stallAfterMinutes * 60000) {
      return {
        reason: 'no-progress',
        detail: `no phase completed in ${goal.stallAfterMinutes} minute(s)`,
      }
    }
    if (!goal.batch && (Number(goal.noProgressAttempts) || 0) >= goal.maxAttemptsPerPhase * 2) {
      return {
        reason: 'no-progress',
        detail: `${goal.noProgressAttempts} phase attempt(s) without completing a phase`,
      }
    }
    return null
  }

  async function tickGoal(goalId) {
    const release = await acquireFileLock(store.file(goalId).replace(/\.json$/, '.lock'), {
      staleMs: 60000,
      now,
    })
    if (!release) return
    try {
      const goal = await store.read(goalId)
      if (!goal) return
      if (goal.status === 'paused' && goal.pausedReason === 'owner-unavailable') {
        if (!await owner(goal)) return
        goal.status = goal.phases.length ? 'running' : 'planning'
        goal.pausedReason = null
        event(goal, 'goal.resumed', 'the owning session is available again')
        await store.write(goal)
      }
      if (!GOAL_TICKABLE.has(goal.status)) return
      await refreshUsage(goal)

      if (goal.status === 'needs-decision') {
        // Waiting on a person must not stop watching work already in flight.
        // Phases that finish now are recorded, and a question from a second
        // phase joins the open one instead of arriving after the first answer.
        // Nothing new is dispatched until the open decisions are answered.
        const parent = await owner(goal)
        if (!parent) return
        await deliverInstructions(goal, parent)
        let progressed = false
        for (const phase of goal.phases ?? []) {
          if (phase.status !== 'running') continue
          await reconcilePhase(goal, phase, parent)
          progressed = true
        }
        if (progressed) {
          goal.updatedAt = new Date(now()).toISOString()
          await store.write(goal)
        }
        return
      }

      if (goal.status === 'planning') {
        if (!goal.decomposeRunId) {
          const parent = await owner(goal)
          if (!parent) {
            goal.status = 'paused'
            goal.pausedReason = 'owner-unavailable'
            await store.write(goal)
            return
          }
          await startDecompose(goal, parent)
          return
        }
        const run = await readRun(goal.decomposeRunId)
        if (!run) {
          goal.decomposeRunId = null
          await store.write(goal)
          return
        }
        if (run.status === 'interrupted') {
          const parent = await owner(goal)
          if (!parent) return
          try {
            await orchestrator.resume(run.id, parent, null)
            return
          } catch (error) {
            // A decompose run that cannot be resumed is restarted; it owns no
            // workspace artifacts, so this is not redoing finished work.
            goal.decomposeRunId = null
            event(goal, 'decompose.resume-failed', oneLine(error?.message ?? error, 400))
            await store.write(goal)
            return
          }
        }
        if (!TERMINAL_STATUSES.has(run.status)) return
        await settleDecompose(goal, run)
        return
      }

      // running
      const parent = await owner(goal)
      if (!parent) {
        goal.status = 'paused'
        goal.pausedReason = 'owner-unavailable'
        event(goal, 'goal.paused', 'the owning session is not live')
        await store.write(goal)
        return
      }
      await deliverInstructions(goal, parent)

      let changed = false
      for (const phase of goal.phases) {
        if (phase.status === 'running') await reconcilePhase(goal, phase, parent)
        else if (phase.status === 'needs-decision') {
          const decision = openDecisions(goal).find(item => item.phaseId === phase.id && item.kind === 'worker-question')
          if (!decision) {
            phase.status = 'running'
            phase.currentRunId = phase.currentRunId ?? phase.runIds.at(-1) ?? null
          } else {
            // The question can also be answered from the board through
            // superagent_answer, which knows nothing about the goal record.
            // Treat an active run or a run with no open attention as answered.
            const run = await readRun(phase.currentRunId ?? phase.runIds.at(-1))
            const openAttention = (run?.attention?.items ?? []).filter(item => !item.answer)
            if (run && (!TERMINAL_STATUSES.has(run.status) || openAttention.length === 0)) {
              decision.answer = 'external'
              decision.answeredAt = new Date(now()).toISOString()
              phase.status = 'running'
              phase.currentRunId = run.id
              event(goal, 'decision.answered', `${decision.id}: answered through the run`, phase.id)
            }
          }
        }
        if (goal.status === 'needs-decision' && openDecisions(goal).length > 0) break
      }
      if (goal.status === 'needs-decision' && openDecisions(goal).length === 0) goal.status = 'running'
      if (goal.status === 'needs-decision') {
        await store.write(goal)
        return
      }

      if (cascadeSkips(goal)) changed = true
      if (await settleGoal(goal)) return

      // Resume interrupted work first: it is cheaper and never replays a phase.
      for (const phase of goal.phases) {
        if (phase.status !== 'ready' || !phase.resumeRunId) continue
        if (activePhaseCount(goal) >= goal.maxParallelPhases) break
        await resumePhase(goal, phase, parent)
        if (goal.status === 'needs-decision') break
      }
      if (goal.status === 'needs-decision') {
        await store.write(goal)
        return
      }

      const ready = goal.phases.filter(phase => phase.status === 'ready' || (
        phase.status === 'pending'
        && phase.dependsOn.every(id => phaseById(goal, id)?.status === 'completed')
      ))
      for (const phase of ready) {
        if (activePhaseCount(goal) >= goal.maxParallelPhases) break
        if (phase.retryAfter > now()) continue
        try {
          const started = await startPhase(goal, phase, parent)
          if (!started) break
          delete phase.startFailures
          delete phase.retryAfter
          changed = true
        } catch (error) {
          const reason = oneLine(error?.message ?? error, 400)
          if (goal.batch) {
            if (/quota exceeded|could not acquire.*lock/i.test(reason)) break
            phase.startFailures = (phase.startFailures ?? 0) + 1
            if (phase.startFailures >= goal.maxAttemptsPerPhase || /permission policy/i.test(reason)) {
              phase.status = 'failed'
              phase.finishedAt = new Date(now()).toISOString()
              goal.progressAt = phase.finishedAt
              phase.lastOutcome = { error: reason }
            } else {
              phase.retryAfter = now() + Math.min(60_000, 2000 * 2 ** (phase.startFailures - 1))
            }
            changed = true
            event(goal, 'phase.start-failed', reason, phase.id)
            continue
          }
          event(goal, 'phase.start-failed', reason, phase.id)
          await store.write(goal)
          break
        }
      }

      if (goal.batch && openDecisions(goal).length > 0 && !batchCanAdvance(goal)) goal.status = 'needs-decision'
      const stall = goal.status === 'running' ? stallReason(goal) : null
      if (stall && openDecisions(goal).length === 0) {
        goal.status = 'needs-decision'
        addDecision(goal, {
          kind: 'stalled',
          question: `长期目标 ${goal.id} 停滞：${stall.detail}。可以继续（重置停滞计数）或停止。`,
          options: ['continue', 'stop'],
          reason: stall.reason,
        })
        announce(goal, 'goal-stalled', `长期目标 ${goal.id} 停滞：${stall.detail}。`
          + `用 superagent_goal answer goal_id=${goal.id} decision_id=… 决定继续或停止。`)
      }

      if (changed) goal.updatedAt = new Date(now()).toISOString()
      await store.write(goal)
    } finally {
      await release()
    }
  }

  async function tick() {
    if (closed) return []
    if (ticking) return ticking
    ticking = (async () => {
      const goals = await store.list()
      const processed = []
      for (const goal of goals) {
        if (!autoResumeFor(goal)) continue
        try {
          await tickGoal(goal.id)
          processed.push(goal.id)
        } catch (error) {
          log(`long-goal ${goal.id} tick failed: ${error?.message ?? error}`)
        }
      }
      const after = await store.list()
      if (after.some(autoResumeFor)) arm()
      return processed
    })()
    try {
      return await ticking
    } finally {
      ticking = null
    }
  }

  /** A goal with an open decision still has runs worth watching. */
  function watching(goal) {
    return goal?.status === 'needs-decision'
      && (goal.phases ?? []).some(phase => phase.status === 'running')
  }

  function autoResumeFor(goal) {
    if (!goal?.autoResume) return false
    if (GOAL_ACTIVE.has(goal.status)) return true
    if (watching(goal)) return true
    return goal.status === 'paused' && goal.pausedReason === 'owner-unavailable'
  }

  /** Load goals and mark work left active by a dead host as resumable, not failed. */
  async function init() {
    await store.init()
    const goals = await store.list()
    let changed = 0
    for (const goal of goals) {
      let dirty = false
      if (!goal.autoResume) continue
      if (goal.status === 'paused' && goal.pausedReason !== 'manual') {
        goal.status = goal.phases?.length ? 'running' : 'planning'
        goal.pausedReason = null
        changed++
        dirty = true
      }
      if (!GOAL_ACTIVE.has(goal.status) && !watching(goal)) continue
      for (const phase of goal.phases ?? []) {
        if (phase.status !== 'running' || !phase.currentRunId) continue
        const run = await readRun(phase.currentRunId)
        if (!run) continue
        if (run.status === 'interrupted') {
          phase.status = 'ready'
          phase.resumeRunId = phase.currentRunId
          phase.currentRunId = null
          goal.recovery = {
            at: new Date(now()).toISOString(),
            reason: 'host-restart',
            phases: [...(goal.recovery?.phases ?? []), phase.id],
          }
          changed++
          dirty = true
        } else if (TERMINAL_STATUSES.has(run.status)) {
          // The run finished but the goal record did not; the next tick settles
          // it. Leaving the phase as running is what makes that happen.
          changed++
        }
      }
      if (goal.decomposeRunId) {
        const run = await readRun(goal.decomposeRunId)
        if (run?.status === 'interrupted') {
          goal.recovery = {
            at: new Date(now()).toISOString(),
            reason: 'host-restart',
            phases: goal.recovery?.phases ?? [],
            decomposeRunId: goal.decomposeRunId,
          }
          changed++
          dirty = true
        }
      }
      if (dirty) await store.write(goal)
    }
    changed && log(`long-goal: recovered ${changed} record(s)`)
    arm(1000)
    return goals
  }

  function normalizeCreate(input) {
    if (!input || typeof input !== 'object') throw new Error('create requires an object')
    const goalText = requiredText(input.goal, 'goal')
    const cwd = path.resolve(String(input.cwd ?? input.workspace ?? process.cwd()))
    const limits = {
      maxParallelPhases: numberIn(
        input.maxParallelPhases,
        defaults.maxParallelPhases,
        1,
        MAX_PHASES,
        'maxParallelPhases',
      ),
      maxAttemptsPerPhase: numberIn(
        input.maxAttemptsPerPhase,
        defaults.maxAttemptsPerPhase,
        1,
        6,
        'maxAttemptsPerPhase',
      ),
      maxRoundsPerPhase: numberIn(
        input.maxRoundsPerPhase,
        defaults.maxRoundsPerPhase,
        1,
        20,
        'maxRoundsPerPhase',
      ),
      noProgressRounds: numberIn(input.noProgressRounds, defaults.noProgressRounds, 1, 10, 'noProgressRounds'),
      maxWallClockMinutes: numberIn(
        input.maxWallClockMinutes,
        DEFAULT_MAX_WALL_CLOCK_MINUTES,
        1,
        43200,
        'maxWallClockMinutes',
      ),
      stallAfterMinutes: numberIn(
        input.stallAfterMinutes,
        DEFAULT_STALL_AFTER_MINUTES,
        1,
        10080,
        'stallAfterMinutes',
      ),
      phaseWallClockMinutes: numberIn(
        input.phaseWallClockMinutes,
        defaults.phaseWallClockMinutes,
        1,
        720,
        'phaseWallClockMinutes',
      ),
    }
    const phaseBudget = normalizeBudget(input.phaseBudget, 'phaseBudget') ?? defaults.phaseBudget ?? null
    const batch = input.batch === true
    const phasesInput = Array.isArray(input.phases) ? input.phases : null
    let phases = []
    if (batch && !phasesInput) throw new Error('batch requires explicit items')
    if (phasesInput) {
      if (phasesInput.length === 0) throw new Error('phases must contain at least one phase')
      const limit = batch ? MAX_BATCH_ITEMS : MAX_PHASES
      if (phasesInput.length > limit) throw new Error(`at most ${limit} phases are supported`)
      const seen = new Set()
      phases = phasesInput.map((entry, index) => normalizePhase(entry, index, {
        ...limits,
        cwd,
      }, seen))
      if (batch && phases.some(phase => phase.dependsOn.length)) throw new Error('batch items must be independent')
      if (!batch) validatePhaseGraph(phases)
    }
    const goal = {
      id: input.routerRequestId ? `g-r${createHash('sha256').update(String(input.routerRequestId)).digest('hex').slice(0, 28)}` : newGoalId(now),
      schemaVersion: 1,
      goal: goalText,
      status: phases.length > 0 ? 'running' : 'planning',
      createdAt: new Date(now()).toISOString(),
      updatedAt: null,
      startedAt: phases.length > 0 ? new Date(now()).toISOString() : null,
      finishedAt: null,
      ownerSessionId: String(input.parentSessionId ?? input.ownerSessionId ?? '').trim() || null,
      ...(input.consoleOwned === true ? { consoleOwned: true } : {}),
      ...(batch ? { batch: true } : {}),
      ...(input.routerRequestId ? { routerRequestId: input.routerRequestId } : {}),
      ...(input.title ? { title: oneLine(input.title, 56) } : {}),
      ...(input.projectRules?.length ? { projectRules: input.projectRules.slice(-16) } : {}),
      ...(input.contextSnapshot?.length ? { contextSnapshot: input.contextSnapshot } : {}),
      cwd,
      autoResume: input.autoResume !== false,
      ...limits,
      phaseBudget,
      budget: normalizeBudget(input.budget, 'budget'),
      phases,
      decomposeRunId: null,
      decomposeAttempts: 0,
      decomposeReply: null,
      decisions: [],
      decisionSeq: 0,
      usage: { modelCalls: 0, tokens: 0 },
      events: [],
      progressAt: new Date(now()).toISOString(),
      noProgressAttempts: 0,
      stoppedReason: null,
      recovery: null,
      pausedReason: null,
    }
    event(goal, 'goal.created', `${phases.length > 0 ? `${phases.length} explicit phase(s)` : 'phase planning started'}`)
    return goal
  }

  async function create(input = {}) {
    const goal = normalizeCreate(input)
    if (!goal.ownerSessionId) throw new Error('create requires a live owning session')
    if (goal.routerRequestId) {
      const prior = await store.read(goal.id)
      if (prior) return prior
    }
    await store.write(goal)
    arm(500)
    log(`long-goal ${goal.id} created (${goal.phases.length} phase(s))`)
    return goal
  }

  async function get(goalId) {
    const goal = await store.read(goalId)
    if (!goal) throw new Error(`unknown long goal ${goalId}`)
    return goal
  }

  async function changeGoal(goalId, change) {
    if (!GOAL_ID_PATTERN.test(String(goalId ?? ''))) throw new Error(`unknown long goal ${goalId}`)
    const release = await acquireFileLock(store.file(goalId).replace(/\.json$/, '.lock'), {
      staleMs: 60000, now, retries: 20,
    })
    if (!release) throw new Error(`goal ${goalId} is being updated; try again shortly`)
    try {
      return await change()
    } finally {
      await release()
    }
  }

  async function status(goalId) {
    const goal = await get(goalId)
    const runs = {}
    for (const runId of goalRunIds(goal)) {
      const run = await readRun(runId)
      if (run) runs[runId] = run
    }
    return { goal, runs }
  }

  async function list() {
    return store.list()
  }

  async function deliverInstructions(goal, parent) {
    let changed = false
    for (const instruction of goal.instructions ?? []) {
      for (const target of instruction.targets) {
        if (target.status !== 'pending') continue
        const run = await readRun(target.runId)
        if (!run || (TERMINAL_STATUSES.has(run.status) && run.status !== 'interrupted')) {
          target.status = 'missed'
        } else {
          try {
            const phaseId = instruction.phaseId ?? goal.phases.find(phase => phase.currentRunId === run.id || phase.resumeRunId === run.id)?.id
            const facts = await resolveContext(goal, phaseId)
            await orchestrator.followup(run.id, instruction.text, parent, {
              requestId: instruction.id, context: decisionContext(facts).join('\n'),
            })
            target.status = 'delivered'
          } catch {
            continue
          }
        }
        changed = true
      }
    }
    if (changed) await store.write(goal)
  }

  async function instruct(id, text, requestId, phaseId) {
    const goal = await get(id)
    if (goal.instructions?.some(item => item.id === requestId)) return goal
    if (!GOAL_TICKABLE.has(goal.status) && goal.status !== 'paused') throw new Error('这项任务已结束，请交办一项后续任务')
    const phase = phaseId ? phaseById(goal, phaseId) : null
    if (phaseId && (!phase || PHASE_TERMINAL.has(phase.status))) throw new Error('这个阶段已结束或不存在，无法补充要求')
    const targets = (phase ? [phase] : goal.phases).flatMap(item => {
      const runId = ['running', 'needs-decision'].includes(item.status) ? item.currentRunId : item.resumeRunId
      return runId ? [{ runId, status: 'pending' }] : []
    })
    goal.instructions = [...(goal.instructions ?? []), {
      id: requestId, text: oneLine(text, MAX_TEXT), ...(phase ? { phaseId: phase.id } : {}), targets,
    }].slice(-24)
    await store.write(goal)
    if (targets.length) {
      const parent = await owner(goal)
      if (parent) await deliverInstructions(goal, parent)
    }
    return goal
  }

  async function cancelActiveRuns(goal) {
    const ids = goal.batch ? goal.phases.filter(phase => !PHASE_TERMINAL.has(phase.status))
      .map(phase => phase.currentRunId ?? phase.resumeRunId).filter(Boolean) : goalRunIds(goal)
    for (const runId of ids) {
      try {
        const run = await readRun(runId)
        if (!run || TERMINAL_STATUSES.has(run.status)) continue
        await orchestrator.cancel(runId)
        event(goal, 'run.cancelled', runId)
      } catch (error) {
        log(`long-goal cannot cancel run ${runId}: ${error?.message ?? error}`)
      }
    }
  }

  async function pause(goalId) {
    const goal = await get(goalId)
    if (!GOAL_ACTIVE.has(goal.status)) throw new Error(`goal ${goal.id} is ${goal.status}; only a running goal can be paused`)
    goal.status = 'paused'
    goal.pausedReason = 'manual'
    event(goal, 'goal.paused', 'paused by the user')
    await store.write(goal)
    return goal
  }

  async function stop(goal, reason, { cancelled = false } = {}) {
    goal.status = cancelled ? 'cancelled' : 'failed'
    goal.stoppedReason = { reason, detail: reason, at: new Date(now()).toISOString() }
    goal.finishedAt = new Date(now()).toISOString()
    event(goal, cancelled ? 'goal.cancelled' : 'goal.failed', reason)
    await cancelActiveRuns(goal)
    if (goal.batch) {
      for (const phase of goal.phases) {
        if (PHASE_TERMINAL.has(phase.status)) continue
        phase.status = 'cancelled'
        phase.finishedAt = goal.finishedAt
      }
    }
    await store.write(goal)
    announce(goal, cancelled ? 'goal-cancelled' : 'goal-failed', `长期目标 ${goal.id} ${cancelled ? '已取消' : '已停止'}（${reason}）。`)
    return goal
  }

  async function cancel(goalId) {
    const goal = await get(goalId)
    if (['completed', 'failed', 'cancelled', 'partial'].includes(goal.status)) return goal
    return stop(goal, 'cancelled by the user', { cancelled: true })
  }

  async function resume(goalId) {
    const goal = await get(goalId)
    const open = openDecisions(goal)
    if (open.length > 0 && !batchCanAdvance(goal)) {
      throw new Error(`goal ${goal.id} has an open decision (${open[0].id}); answer it first`)
    }
    if (['completed', 'failed', 'cancelled', 'partial', 'budget-stopped'].includes(goal.status)) {
      throw new Error(`goal ${goal.id} is ${goal.status} and cannot be resumed`)
    }
    goal.status = goal.phases?.length ? 'running' : 'planning'
    goal.pausedReason = null
    goal.progressAt = new Date(now()).toISOString()
    goal.noProgressAttempts = 0
    event(goal, 'goal.resumed', 'resumed by the user')
    await store.write(goal)
    arm(200)
    return goal
  }

  /**
   * Answering one decision does not resume the goal while another is open.
   * Folding several questions into one interruption only works if the goal
   * keeps waiting after the first of them is answered.
   */
  function settleDecisionStatus(goal) {
    if (goal.batch && goal.status === 'paused') return
    if (openDecisions(goal).length > 0 && !batchCanAdvance(goal)) {
      goal.status = 'needs-decision'
      return
    }
    goal.status = 'running'
    goal.progressAt = new Date(now()).toISOString()
  }

  /**
   * Apply one decision.
   *
   * A worker question is answered through the run's own attention path, so
   * there is exactly one place where an answer is validated and recorded.
   */
  async function answer(goalId, decisionId, value, { note = null, parent = null, clientTimeZone = null } = {}) {
    const goal = await get(goalId)
    const decision = (goal.decisions ?? []).find(item => item.id === decisionId)
    if (!decision) throw new Error(`unknown decision ${decisionId} on goal ${goalId}`)
    if (decision.answer) throw new Error(`decision ${decisionId} was already answered with "${decision.answer}"`)
    const choice = String(value ?? '').trim().toLowerCase()
    if (!decision.options.includes(choice)) {
      throw new Error(`decision ${decisionId} accepts ${decision.options.join(', ')}, not ${JSON.stringify(value)}`)
    }
    const phase = decision.phaseId ? phaseById(goal, decision.phaseId) : null
    if (choice === 'answer') {
      const runId = decision.source?.runId
      const attentionId = decision.source?.attentionId
      if (!runId || !attentionId) throw new Error('this decision has no run question to answer')
      const text = String(note ?? '').trim()
      if (!text) throw new Error('answer requires note: the answer text for the worker')
      const agent = parent ?? await owner(goal)
      if (!agent) throw new Error('no live owning session, so the worker cannot be resumed')
      await orchestrator.answer(runId, attentionId, text, agent, clientTimeZone)
      decision.answer = 'answer'
      decision.answerText = oneLine(text, 420)
      decision.answeredAt = new Date(now()).toISOString()
      if (phase) {
        phase.status = 'running'
        phase.currentRunId = runId
      }
      settleDecisionStatus(goal)
      event(goal, 'decision.answered', `worker question answered on run ${runId}`, phase?.id ?? null)
      await store.write(goal)
      arm(200)
      return goal
    }

    decision.answer = choice
    decision.answeredAt = new Date(now()).toISOString()
    if (note) decision.note = oneLine(note, 600)
    if (decision.kind === 'verification-conflict') {
      if (choice === 'accept') {
        if (phase) {
          phase.status = 'completed'
          phase.finishedAt = new Date(now()).toISOString()
          phase.lastSignature = null
          phase.lastOutcome = {
            ...(phase.lastOutcome ?? {}),
            acceptedByUser: true,
            acceptanceNote: note ? oneLine(note, 600) : null,
          }
        }
        settleDecisionStatus(goal)
        goal.noProgressAttempts = 0
        event(goal, 'phase.accepted', note ? oneLine(note, 300) : 'the user accepted the machine result', phase?.id ?? null)
        announce(goal, 'phase-completed', `长期目标 ${goal.id}：阶段 ${phase?.id}「${phase?.title}」按你的判断计为完成`
          + `（${progressLine(goal)}）。`)
      } else if (choice === 'retry') {
        if (phase) {
          phase.status = 'ready'
          phase.resumeRunId = null
          phase.attempts = 0
          phase.lastSignature = null
          phase.retryNote = note ? oneLine(note, 1200) : phase.retryNote
          phase.finishedAt = null
        }
        settleDecisionStatus(goal)
        goal.noProgressAttempts = 0
      } else {
        return stop(goal, 'the user chose to stop after a verification conflict')
      }
    } else if (decision.kind === 'phase-exhausted' || decision.kind === 'resume-failed') {
      if (choice === 'retry') {
        if (phase) {
          phase.status = 'ready'
          phase.resumeRunId = null
          phase.attempts = 0
          phase.lastSignature = null
          phase.retryNote = note ? oneLine(note, 1200) : phase.retryNote
          phase.finishedAt = null
        }
        settleDecisionStatus(goal)
        goal.noProgressAttempts = 0
      } else if (choice === 'skip') {
        if (phase) {
          phase.status = 'skipped'
          phase.finishedAt = new Date(now()).toISOString()
          phase.lastOutcome = { runStatus: 'skipped', error: note ? oneLine(note, 400) : 'skipped by the user' }
        }
        settleDecisionStatus(goal)
        goal.noProgressAttempts = 0
      } else {
        return stop(goal, 'the user chose to stop after a phase failed')
      }
    } else if (decision.kind === 'stalled') {
      if (choice === 'continue') {
        settleDecisionStatus(goal)
        goal.noProgressAttempts = 0
        goal.stalledAt = null
        if (note) goal.continueNote = oneLine(note, 600)
      } else {
        return stop(goal, 'the user chose to stop a stalled goal')
      }
    } else if (decision.kind === 'worker-question') {
      return stop(goal, 'the user chose to stop after a worker question')
    }
    event(goal, 'decision.answered', `${decision.id}: ${choice}`, phase?.id ?? null)
    await store.write(goal)
    arm(200)
    return goal
  }

  /**
   * Reopen one phase that was skipped or failed, together with the phases that
   * were skipped only because it never completed.
   *
   * This is what the completion note points at when a goal ends partial: the
   * phases that did finish stay finished, and one call revives the missing piece.
   */
  async function retryPhase(goalId, phaseId) {
    const goal = await store.read(goalId)
    if (!goal) throw new Error(`no long-term goal ${goalId}`)
    const phase = phaseById(goal, phaseId ?? '')
    if (!phase) throw new Error(`goal ${goalId} has no phase ${JSON.stringify(phaseId)}`)
    if (goal.status === 'needs-decision') {
      throw new Error('the goal is waiting on a decision; answer it before retrying one phase')
    }
    if (!['skipped', 'failed'].includes(phase.status)) {
      throw new Error(`phase ${phase.id} is ${phase.status}; only a skipped or failed phase can be retried alone`)
    }
    const reopened = [phase]
    for (const item of goal.phases ?? []) {
      if (item === phase || item.status !== 'skipped') continue
      if (dependsOnPhase(goal, item, phase.id)) reopened.push(item)
    }
    for (const item of reopened) {
      item.status = 'pending'
      delete item.finalUsage
      item.attempts = 0
      delete item.startFailures
      delete item.retryAfter
      item.finishedAt = null
      item.currentRunId = null
      item.resumeRunId = null
      item.lastSignature = null
      item.lastOutcome = null
      item.skippedBy = null
      item.skipReason = null
      item.retryNote = item === phase
        ? 'This phase was reopened on request after it was dropped: the earlier attempts failed, so take a different approach and still meet the same acceptance conditions.'
        : `Phase ${phase.id} is being retried, so this dependent phase is back on the plan.`
    }
    goal.status = 'running'
    goal.finishedAt = null
    goal.stoppedReason = null
    goal.noProgressAttempts = 0
    goal.progressAt = new Date(now()).toISOString()
    event(goal, 'phase.reopened', `reopened on request (${reopened.map(item => item.id).join(', ')})`, phase.id)
    await store.write(goal)
    arm(0)
    return goal
  }

  /** True when `phase` depends on `ancestorId` through any chain. */
  function dependsOnPhase(goal, phase, ancestorId) {
    const seen = new Set()
    const queue = [...(phase.dependsOn ?? [])]
    while (queue.length > 0) {
      const id = queue.pop()
      if (id === ancestorId) return true
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(phaseById(goal, id)?.dependsOn ?? []))
    }
    return false
  }

  return {
    init,
    close,
    create,
    get,
    status,
    list,
    tick,
    instruct: (id, text, requestId, phaseId) => changeGoal(id, () => instruct(id, text, requestId, phaseId)),
    answer: (id, ...args) => changeGoal(id, () => answer(id, ...args)),
    resume: id => changeGoal(id, () => resume(id)),
    pause: id => changeGoal(id, () => pause(id)),
    cancel: id => changeGoal(id, () => cancel(id)),
    retryPhase: (id, phaseId) => changeGoal(id, () => retryPhase(id, phaseId)),
    store,
    formatStatus,
  }
}

/**
 * Parse a phase plan out of a planner reply.
 *
 * A reply that is JSON but has no usable phases is an error, not an empty plan:
 * treating it as empty would start a goal with nothing to do and report success.
 *
 * @param {string} text - planner reply.
 * @returns {{ phases: object[] | null, error: string | null }} parsed plan or why not.
 */
export function parsePhasePlan(text) {
  let lastError = 'the phase planner returned no JSON object'
  for (const candidate of jsonCandidates(text)) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch (error) {
      lastError = `the phase planner returned invalid JSON: ${error?.message ?? error}`
      continue
    }
    if (!Array.isArray(parsed?.phases)) {
      lastError = 'the phase planner JSON has no "phases" array'
      continue
    }
    if (parsed.phases.length === 0) {
      lastError = 'the phase planner returned an empty "phases" array'
      continue
    }
    return { phases: parsed.phases, error: null }
  }
  return { phases: null, error: lastError }
}

/**
 * Render a goal for the tool reply: state, phase table, open decisions, next.
 *
 * @param {object} goal - goal record.
 * @param {Record<string, object>} [runs] - run snapshots keyed by run id.
 * @returns {string} Markdown.
 */
export function formatStatus(goal, runs = {}) {
  const phases = goal.phases ?? []
  const completed = phases.filter(phase => phase.status === 'completed').length
  const open = (goal.decisions ?? []).filter(item => !item.answer)
  const used = goal.usage ?? { modelCalls: 0, tokens: 0 }
  const cap = goal.budget
  const lines = [
    `# Long goal ${goal.id} — ${goal.status}`,
    '',
    `Goal: ${oneLine(goal.goal, 500)}`,
    `Progress: ${completed}/${phases.length} phase(s) completed; ${used.modelCalls}`
      + `${cap?.maxModelCalls ? `/${cap.maxModelCalls}` : ''} model calls`
      + `${cap?.maxTokens ? `, ${used.tokens}/${cap.maxTokens} tokens` : ''}`,
    `Workspace: ${goal.cwd}`,
  ]
  if (goal.status === 'planning') {
    lines.push('', `Phase planning: attempt ${goal.decomposeAttempts}`
      + `${goal.decomposeRunId ? `, run ${goal.decomposeRunId}` : ''}`)
  }
  if (phases.length > 0) {
    lines.push('', 'Phases:')
    for (const phase of phases) {
      const runId = phase.currentRunId ?? phase.runIds.at(-1) ?? null
      const run = runId ? runs[runId] : null
      const detail = run
        ? `run ${run.id}: ${run.status}`
          + (run.goalMode ? `, round ${run.goalMode.rounds?.length ?? 0}/${run.goalMode.maxRounds}` : '')
        : runId ? `run ${runId}` : 'no run yet'
      const deps = phase.dependsOn.length > 0 ? `, after ${phase.dependsOn.join(', ')}` : ''
      lines.push(`- [${phase.status}] ${phase.id} ${phase.title} — attempts ${phase.attempts}, ${detail}${deps}`)
      if (phase.lastOutcome?.error) lines.push(`  last: ${oneLine(phase.lastOutcome.error, 300)}`)
    }
  }
  const cut = phases.filter(phase => phase.status === 'skipped' && phase.skippedBy === 'exhausted')
  if (cut.length > 0) {
    lines.push('', 'Skipped after its attempts ran out (no later phase needed it):')
    for (const phase of cut) {
      lines.push(`- ${phase.id}「${phase.title}」— ${oneLine(phase.skipReason ?? 'attempts exhausted', 300)}`)
      lines.push(`  redo this phase alone: superagent_goal action=retry_phase goal_id=${goal.id} phase_id=${phase.id}`)
    }
  }
  if (goal.recovery) {
    lines.push('', `Recovered: ${goal.recovery.reason} at ${goal.recovery.at}`
      + `${(goal.recovery.phases ?? []).length > 0 ? ` (phases ${goal.recovery.phases.join(', ')})` : ''}`)
  }
  if (open.length > 0) {
    lines.push('', 'Needs your decision:')
    for (const decision of open) {
      lines.push(`- ${decision.id} (${decision.kind}): ${decision.question}`)
      lines.push(`  options: ${decision.options.join(', ')}`)
      lines.push(`  answer with: superagent_goal action=answer goal_id=${goal.id} decision_id=${decision.id} answer=<option>`
        + `${decision.kind === 'worker-question' ? ' note="<your answer>"' : ''}`)
    }
  }
  if (goal.stoppedReason) lines.push('', `Stopped: ${goal.stoppedReason.reason} — ${goal.stoppedReason.detail}`)
  lines.push('', 'Next:')
  if (goal.status === 'needs-decision') lines.push('- answer the open decision above; no new phase will start until then')
  else if (goal.status === 'completed') lines.push('- nothing; every phase met its acceptance conditions')
  else if (goal.status === 'partial') lines.push('- retry one skipped phase alone with superagent_goal action=retry_phase, or start a new goal for the rest')
  else if (goal.status === 'failed') lines.push('- inspect the report; create a new goal with explicit phases if the framing was wrong')
  else if (goal.status === 'paused') lines.push('- superagent_goal action=resume when the owning session is available again')
  else lines.push('- poll with superagent_goal action=status; phase runs continue in the background')
  return lines.join('\n').trim()
}
