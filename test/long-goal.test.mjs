import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createLongGoalManager, formatStatus, parsePhasePlan } from '../lib/long-goal.js'

function fakeOrchestrator() {
  let seq = 0
  const runs = new Map()
  const calls = { start: [], resume: [], cancel: [], answer: [] }
  const api = {
    runs,
    calls,
    async start(args) {
      const run = {
        id: `r-${++seq}`,
        goal: args.goal,
        status: 'running',
        parentSessionId: args.parentSessionId,
        mode: args.mode,
        origin: args.origin ?? null,
        goalMode: args.goalMode
          ? { ...args.goalMode, rounds: [], achieved: false, stop: null }
          : null,
        attention: { items: [] },
        usage: { modelCalls: 1, totalTokens: 100 },
        report: '',
        error: null,
        budgetStop: null,
      }
      runs.set(run.id, run)
      calls.start.push(args)
      return run
    },
    async status(runId) {
      const run = runs.get(runId)
      if (!run) throw new Error(`unknown run ${runId}`)
      return run
    },
    async resume(runId) {
      const run = runs.get(runId)
      if (!run) throw new Error(`unknown run ${runId}`)
      if (run.ownerLost) throw new Error('session is not open in this host process')
      run.status = 'running'
      calls.resume.push(runId)
      return run
    },
    async cancel(runId) {
      const run = runs.get(runId)
      if (run) run.status = 'cancelled'
      calls.cancel.push(runId)
      return run
    },
    async answer(runId, attentionId, text) {
      const run = runs.get(runId)
      const item = run?.attention?.items?.find(entry => entry.id === attentionId)
      if (!item) throw new Error(`unknown attention ${attentionId}`)
      item.answer = text
      run.status = 'running'
      calls.answer.push({ runId, attentionId, text })
      return run
    },
  }
  api.complete = (run, report = 'done') => {
    run.status = 'completed'
    run.report = report
    if (run.goalMode) {
      run.goalMode.achieved = true
      run.goalMode.rounds.push({ round: 1, changed: true, failed: [] })
    }
    return run
  }
  api.fail = (run, { error = 'goal mode stopped after 3 round(s)', stop = 'rounds', failed = [], changed = true } = {}) => {
    run.status = 'failed'
    run.error = error
    if (run.goalMode) {
      run.goalMode.achieved = false
      run.goalMode.stop = { reason: stop, detail: error }
      run.goalMode.rounds.push({ round: 1, changed, failed })
    }
    return run
  }
  return api
}

const agent = { id: 'session-1' }

async function tempRoot(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `dsh-long-goal-${label}-`))
}

function phase(id, extra = {}) {
  return {
    id,
    title: `Title ${id}`,
    objective: `Objective ${id}`,
    acceptance: [`${id} is done`],
    ...extra,
  }
}

async function manager(root, orchestrator, overrides = {}) {
  return createLongGoalManager({
    root,
    orchestrator,
    resolveOwner: async () => agent,
    notify: async () => ({ delivered: true }),
    autoTick: false,
    now: overrides.now ?? (() => Date.now()),
    ...overrides,
  })
}

test('parses a fenced phase plan and rejects nonsense', () => {
  const ok = parsePhasePlan('```json\n{"phases":[{"id":"p1","objective":"x"}]}\n```')
  assert.equal(ok.phases.length, 1)
  assert.equal(ok.error, null)
  assert.equal(parsePhasePlan('I cannot help').phases, null)
  assert.match(parsePhasePlan('{"phases":[]}').error, /empty/)
  assert.match(parsePhasePlan('{"phases":"nope"}').error, /no "phases" array/)
})

test('a console phase receives its objective without sibling deliverables', async () => {
  const root = await tempRoot('phase-scope')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  try {
    await goals.create({
      goal: 'Two reports: ALPHA_ONLY and BETA_ONLY', parentSessionId: agent.id, consoleOwned: true,
      phases: [phase('p1', { objective: 'Publish ALPHA_ONLY' }), phase('p2', { objective: 'Summarize BETA_ONLY' })],
    })
    await goals.tick()
    const [first, second] = orchestrator.calls.start.map(call => call.goal)
    assert.match(first, /ALPHA_ONLY/)
    assert.doesNotMatch(first, /BETA_ONLY/)
    assert.match(second, /BETA_ONLY/)
    assert.doesNotMatch(second, /ALPHA_ONLY/)
  } finally {
    goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('rejects an invalid phase graph before creating anything', async () => {
  const root = await tempRoot('invalid')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  await assert.rejects(
    () => goals.create({
      goal: 'g',
      parentSessionId: agent.id,
      phases: [phase('p1', { dependsOn: ['missing'] })],
    }),
    /unknown phase "missing"/,
  )
  await assert.rejects(
    () => goals.create({
      goal: 'g',
      parentSessionId: agent.id,
      phases: [phase('p1', { dependsOn: ['p2'] }), phase('p2', { dependsOn: ['p1'] })],
    }),
    /cycle/,
  )
  assert.deepEqual(await goals.list(), [])
})

test('runs phases in dependency order and completes the goal', async () => {
  const root = await tempRoot('order')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'ship 1.0',
    parentSessionId: agent.id,
    phases: [phase('p1'), phase('p2', { dependsOn: ['p1'] })],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'running')
  assert.equal(state.goal.phases[1].status, 'pending')
  assert.equal(orchestrator.calls.start.length, 1)

  orchestrator.complete(orchestrator.runs.get(state.goal.phases[0].currentRunId), 'p1 report')
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'completed')
  assert.equal(state.goal.phases[1].status, 'running')
  // The second phase prompt carries the first phase's result.
  assert.match(orchestrator.calls.start.at(-1).goal, /p1 report/)

  orchestrator.complete(orchestrator.runs.get(state.goal.phases[1].currentRunId), 'p2 report')
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'completed')
  assert.equal(state.goal.phases[1].status, 'completed')
})

test('starts independent phases in parallel under the cap', async () => {
  const root = await tempRoot('parallel')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  await goals.create({
    goal: 'parallel',
    parentSessionId: agent.id,
    maxParallelPhases: 2,
    phases: [phase('p1'), phase('p2'), phase('p3')],
  })
  await goals.tick()
  const started = orchestrator.calls.start.length
  assert.equal(started, 2)
  assert.deepEqual(
    [...orchestrator.runs.values()].map(run => run.goalMode !== null),
    [true, true],
  )
})

test('delivers instructions only to the named phase and retains them across a restart before dispatch', async t => {
  const root = await tempRoot('phase-instructions')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const orchestrator = fakeOrchestrator()
  const delivered = []
  orchestrator.followup = async (runId, text, parent, options) => delivered.push({ runId, text, context: options.context })
  const context = { resolveContext: async (goal, phaseId) => [{ value: `confirmed for ${phaseId}` }] }
  let goals = await manager(root, orchestrator, context)
  const goal = await goals.create({
    goal: 'release review', parentSessionId: agent.id, maxParallelPhases: 2,
    phases: [phase('checks'), phase('compat'), phase('summary', { dependsOn: ['checks', 'compat'] })],
  })
  await goals.tick()
  const [checks, compat] = (await goals.get(goal.id)).phases
  assert.ok(checks.currentRunId && compat.currentRunId)
  await goals.instruct(goal.id, 'compatibility only', 'instruct-compat', 'compat')
  await goals.instruct(goal.id, 'compatibility only', 'instruct-compat', 'compat')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].runId, compat.currentRunId)
  assert.equal(delivered[0].text, 'compatibility only')
  assert.match(delivered[0].context, /confirmed for compat/)
  await assert.rejects(goals.instruct(goal.id, 'unknown', 'instruct-unknown', 'foreign'), /不存在/)
  const pending = await goals.instruct(goal.id, 'summary only', 'instruct-summary', 'summary')
  assert.deepEqual(pending.instructions.at(-1).targets, [])
  await goals.close()

  goals = await manager(root, orchestrator, context)
  orchestrator.complete(orchestrator.runs.get(checks.currentRunId), 'check result')
  orchestrator.complete(orchestrator.runs.get(compat.currentRunId), 'compat result')
  await goals.tick()
  const next = orchestrator.calls.start.at(-1)
  assert.equal(next.origin.phaseId, 'summary')
  assert.match(next.goal, /summary only/)
  assert.match(next.goal, /confirmed for summary/)
  assert.match(next.goal, /check result/)
  assert.doesNotMatch(next.goal, /compatibility only/)
  await assert.rejects(goals.instruct(goal.id, 'too late', 'instruct-late', 'compat'), /已结束/)
  await goals.close()
})

test('a batch bounds live work, persists pause and resumes the remaining items after restart', async t => {
  const root = await tempRoot('batch')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const orchestrator = fakeOrchestrator()
  let goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'batch review', batch: true, parentSessionId: agent.id, maxParallelPhases: 2, maxAttemptsPerPhase: 1,
    contextSnapshot: [{ role: 'user', text: 'Use the earlier checklist as background.' }],
    phases: Array.from({ length: 5000 }, (_, index) => phase(`item${index + 1}`)),
  })
  await goals.tick()
  assert.equal(orchestrator.calls.start.length, 2)
  assert.equal(orchestrator.calls.start[0].mode, 'direct')
  assert.match(orchestrator.calls.start[0].goal, /earlier checklist/)
  orchestrator.complete(orchestrator.runs.get('r-1'))
  orchestrator.fail(orchestrator.runs.get('r-2'))
  await goals.pause(goal.id)
  await goals.close()
  goals = await manager(root, orchestrator)
  await goals.tick()
  assert.equal(orchestrator.calls.start.length, 2)
  assert.equal((await goals.get(goal.id)).status, 'paused')
  await goals.resume(goal.id)
  await goals.tick()
  assert.deepEqual(orchestrator.calls.start.map(call => call.origin.phaseId), ['item1', 'item2', 'item3', 'item4'])
  const resumed = await goals.get(goal.id)
  assert.equal(resumed.phases[0].status, 'completed')
  assert.equal(resumed.phases[1].status, 'skipped')
  assert.equal(resumed.phases.length, 5000)
  await goals.cancel(goal.id)
  assert.equal((await goals.get(goal.id)).phases.at(-1).status, 'cancelled')
  assert.deepEqual(orchestrator.calls.cancel, ['r-3', 'r-4'])
  await goals.close()
})

test('an item waiting for a person lets the rest of its batch advance', async t => {
  const root = await tempRoot('batch-decision')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'check independent items', batch: true, parentSessionId: agent.id,
    maxParallelPhases: 1, phases: [phase('one'), phase('two'), phase('three')],
  })
  await goals.tick()
  const first = orchestrator.fail(orchestrator.runs.get('r-1'), { stop: 'needs-decision' })
  first.attention.items.push({ id: 'which', question: 'Which option?' })
  await goals.tick()
  const waiting = await goals.get(goal.id)
  assert.equal(waiting.status, 'running')
  assert.equal(waiting.phases[0].status, 'needs-decision')
  assert.equal(waiting.phases[1].status, 'running')
  orchestrator.complete(orchestrator.runs.get('r-2'))
  await goals.tick()
  orchestrator.complete(orchestrator.runs.get('r-3'))
  await goals.tick()
  assert.equal((await goals.get(goal.id)).status, 'needs-decision')
  await goals.answer(goal.id, waiting.decisions[0].id, 'answer', { note: 'Use the first option' })
  orchestrator.complete(first)
  await goals.tick()
  assert.equal((await goals.get(goal.id)).status, 'completed')
  await goals.close()
})

test('a restarted host resumes the interrupted phase, not the finished one', async () => {
  const root = await tempRoot('restart')
  const orchestrator = fakeOrchestrator()
  const first = await manager(root, orchestrator)
  const goal = await first.create({
    goal: 'restart',
    parentSessionId: agent.id,
    phases: [phase('p1'), phase('p2')],
  })
  await first.tick()
  let state = await first.status(goal.id)
  const p1RunId = state.goal.phases[0].currentRunId
  orchestrator.complete(orchestrator.runs.get(p1RunId), 'p1 done')
  await first.tick()
  state = await first.status(goal.id)
  const p2RunId = state.goal.phases[1].currentRunId
  assert.ok(p2RunId)
  const p2Attempts = state.goal.phases[1].attempts

  // The host dies mid-phase: recovery marks the run interrupted.
  orchestrator.runs.get(p2RunId).status = 'interrupted'
  const second = await manager(root, orchestrator)
  await second.init()
  state = await second.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'completed')
  assert.equal(state.goal.phases[1].status, 'ready')
  assert.equal(state.goal.phases[1].resumeRunId, p2RunId)

  await second.tick()
  state = await second.status(goal.id)
  assert.equal(state.goal.phases[1].status, 'running')
  assert.deepEqual(orchestrator.calls.resume, [p2RunId])
  assert.equal(state.goal.phases[1].currentRunId, p2RunId)
  // A resume is not a new attempt and does not start phase 1 again.
  assert.equal(state.goal.phases[1].attempts, p2Attempts)
  assert.equal(state.goal.phases[1].runIds.length, p2Attempts)
  assert.equal(orchestrator.calls.start.filter(args => /phase 1 of 2/.test(args.goal)).length, 1)
})

test('a resume that fails after a host restart starts a new attempt instead of asking', async () => {
  const root = await tempRoot('resume-fallback')
  const orchestrator = fakeOrchestrator()
  const first = await manager(root, orchestrator)
  const goal = await first.create({
    goal: 'restart without a resumable run',
    parentSessionId: agent.id,
    maxAttemptsPerPhase: 2,
    phases: [phase('p1')],
  })
  await first.tick()
  let state = await first.status(goal.id)
  const runId = state.goal.phases[0].currentRunId
  // The host died and the run's session is gone: resuming it cannot work.
  orchestrator.runs.get(runId).status = 'interrupted'
  orchestrator.runs.get(runId).ownerLost = true

  const second = await manager(root, orchestrator)
  await second.init()
  await second.tick()
  state = await second.status(goal.id)
  assert.equal(state.goal.decisions.length, 0)
  assert.equal(state.goal.status, 'running')
  assert.equal(state.goal.phases[0].status, 'running')
  assert.equal(state.goal.phases[0].attempts, 2)
  assert.equal(state.goal.phases[0].resumeRunId, null)
  assert.match(orchestrator.calls.start.at(-1).goal, /could not be resumed/)
})

test('retries a failed phase with a new run, then skips it alone after the last attempt', async () => {
  const root = await tempRoot('retry')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'retry',
    parentSessionId: agent.id,
    maxAttemptsPerPhase: 2,
    phases: [phase('p1')],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  const firstRun = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  orchestrator.fail(firstRun, { failed: [{ id: 'a1', text: 'p1 is done', why: 'file missing' }] })
  await goals.tick()
  state = await goals.status(goal.id)
  // The retry starts in the same tick: a ready phase is dispatched right away.
  assert.equal(state.goal.phases[0].status, 'running')
  assert.equal(state.goal.phases[0].attempts, 2)
  assert.match(orchestrator.calls.start.at(-1).goal, /Still failing/)

  const secondRun = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  orchestrator.fail(secondRun, { failed: [{ id: 'a1', text: 'p1 is done', why: 'file missing' }] })
  await goals.tick()
  state = await goals.status(goal.id)
  // Nothing depends on p1, so the goal stops asking and ends without it.
  assert.equal(state.goal.phases[0].status, 'skipped')
  assert.equal(state.goal.phases[0].skippedBy, 'exhausted')
  assert.equal(state.goal.status, 'failed')
  assert.equal(state.goal.decisions.length, 0)

  await goals.retryPhase(goal.id, 'p1')
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'running')
  assert.equal(state.goal.phases[0].status, 'pending')
  assert.equal(state.goal.phases[0].attempts, 0)
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'running')
  assert.match(orchestrator.calls.start.at(-1).goal, /reopened on request/)
})

test('a negative worker claim does not complete a phase whose machine check passed', async () => {
  const root = await tempRoot('conflict-claim')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'verify 1.0',
    parentSessionId: agent.id,
    phases: [phase('p1')],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  const run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  run.status = 'completed'
  run.report = 'Verification remains blocked: both required commands exited 1 (spawn EPERM).'
  run.goalMode.achieved = true
  run.goalMode.rounds.push({
    round: 1,
    changed: true,
    failed: [],
    checks: [{
      id: 'a1',
      text: 'node --test exits 0',
      source: 'command',
      command: 'node --test test/long-goal.test.mjs',
      ok: true,
      exitCode: 0,
      detail: 'exit 0 in 408 ms',
    }],
  })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'needs-decision')
  assert.equal(state.goal.status, 'needs-decision')
  const decision = state.goal.decisions.at(-1)
  assert.equal(decision.kind, 'verification-conflict')
  assert.deepEqual(decision.options, ['accept', 'retry', 'stop'])
  // Both sides are recorded verbatim: the worker's words and the machine command.
  assert.match(decision.source.worker[0], /Verification remains blocked/)
  assert.equal(decision.source.machine[0].command, 'node --test test/long-goal.test.mjs')
  assert.equal(decision.source.machine[0].exitCode, 0)

  await goals.answer(goal.id, decision.id, 'accept', { note: 'the exit code wins here' })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'completed')
  assert.equal(state.goal.phases[0].lastOutcome.acceptedByUser, true)
  assert.equal(state.goal.status, 'completed')
})

test('a success claim does not complete a phase whose machine check failed', async () => {
  const root = await tempRoot('conflict-machine')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'verify 1.0',
    parentSessionId: agent.id,
    maxAttemptsPerPhase: 2,
    phases: [phase('p1')],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  const run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  run.status = 'completed'
  run.report = 'All checks passed: node --test and check-pack both succeeded.'
  // The acceptance model was fooled by the claim; the exit code still says 1.
  run.goalMode.achieved = true
  run.goalMode.rounds.push({
    round: 1,
    changed: true,
    failed: [{ id: 'a1', text: 'node --test exits 0', why: 'exit 1' }],
    checks: [{
      id: 'a1',
      text: 'node --test exits 0',
      source: 'command',
      command: 'node --test test/long-goal.test.mjs',
      ok: false,
      exitCode: 1,
      detail: 'exit 1 in 300 ms',
    }],
  })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.notEqual(state.goal.phases[0].status, 'completed')
  assert.notEqual(state.goal.status, 'completed')
  // The machine failure wins: the phase retries with a new team.
  assert.equal(state.goal.phases[0].status, 'running')
  assert.equal(orchestrator.calls.start.length, 2)
  assert.match(orchestrator.calls.start.at(-1).goal, /Still failing/)
  assert.equal(state.goal.phases[0].lastOutcome.conflict, 'machine-failed')
})

test('a whole-goal budget stops dispatch before the next phase starts', async () => {
  const root = await tempRoot('budget')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator, {
    config: { phaseBudget: { maxModelCalls: 5, maxTokens: 5000 } },
  })
  const goal = await goals.create({
    goal: 'budget',
    parentSessionId: agent.id,
    budget: { maxModelCalls: 1 },
    phases: [phase('p1'), phase('p2', { dependsOn: ['p1'] })],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'running')
  orchestrator.complete(orchestrator.runs.get(state.goal.phases[0].currentRunId))
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'budget-stopped')
  assert.equal(state.goal.phases[1].status, 'pending')
  assert.equal(orchestrator.calls.start.length, 1)
  assert.match(state.goal.stoppedReason.detail, /model-call budget/)
})

test('a worker question is answered through the run attention path', async () => {
  const root = await tempRoot('question')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'question',
    parentSessionId: agent.id,
    phases: [phase('p1')],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  const run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  run.status = 'failed'
  run.attention.items.push({ id: 'q1', question: 'Which directory should the report go in?', answer: null })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'needs-decision')
  assert.equal(state.goal.phases[0].status, 'needs-decision')
  const decision = state.goal.decisions.at(-1)
  assert.equal(decision.kind, 'worker-question')
  assert.deepEqual(decision.options, ['answer', 'stop'])
  assert.match(formatStatus(state.goal, state.runs), /Needs your decision/)

  await goals.answer(goal.id, decision.id, 'answer', { note: 'docs/report.md', parent: agent })
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'running')
  assert.equal(state.goal.phases[0].status, 'running')
  assert.deepEqual(orchestrator.calls.answer, [
    { runId: run.id, attentionId: 'q1', text: 'docs/report.md' },
  ])
})

test('a goal that makes no progress opens a stall decision instead of retrying', async () => {
  let clock = Date.parse('2026-11-16T00:00:00.000Z')
  const root = await tempRoot('stall')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator, { now: () => clock })
  const goal = await goals.create({
    goal: 'stall',
    parentSessionId: agent.id,
    stallAfterMinutes: 1,
    maxWallClockMinutes: 600,
    phases: [phase('p1')],
  })
  await goals.tick()
  clock += 2 * 60 * 1000
  await goals.tick()
  const state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'needs-decision')
  const decision = state.goal.decisions.at(-1)
  assert.equal(decision.kind, 'stalled')
  assert.deepEqual(decision.options, ['continue', 'stop'])
})

test('a second phase that needs a person joins the open decision instead of waiting', async () => {
  const root = await tempRoot('batch')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'two phases, two questions',
    parentSessionId: agent.id,
    maxParallelPhases: 2,
    phases: [phase('p1'), phase('p2')],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  const run1 = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  run1.status = 'failed'
  run1.attention.items.push({ id: 'q1', question: 'Where should the index go?', answer: null })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'needs-decision')
  assert.equal(state.goal.decisions.length, 1)

  // Phase 2 keeps being watched while the first question is open: its own
  // question is collected now, so one interruption shows both.
  const run2 = orchestrator.runs.get(state.goal.phases[1].currentRunId)
  run2.status = 'failed'
  run2.attention.items.push({ id: 'q2', question: 'Which font should the cover use?', answer: null })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'needs-decision')
  assert.deepEqual(state.goal.decisions.map(item => item.source.attentionId), ['q1', 'q2'])
  assert.deepEqual(state.goal.decisions.map(item => item.kind), ['worker-question', 'worker-question'])

  // Answering one of them does not pretend the goal is free to run again.
  await goals.answer(goal.id, state.goal.decisions[0].id, 'answer', { note: 'docs/index.md', parent: agent })
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'needs-decision')
  await goals.answer(goal.id, state.goal.decisions[1].id, 'answer', { note: 'Inter', parent: agent })
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'running')
})

test('a desktop goal starts unrelated work while an actual login blocks only its own dependents', async () => {
  const root = await tempRoot('routed-human-wait')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'log in where required and keep unrelated work moving',
    parentSessionId: agent.id,
    routerRequestId: 'routed-login',
    maxParallelPhases: 1,
    phases: [phase('login'), phase('assignment', { dependsOn: ['login'] }), phase('game')],
  })
  await goals.tick()
  let state = await goals.get(goal.id)
  const login = orchestrator.runs.get(state.phases[0].currentRunId)
  orchestrator.fail(login, { stop: 'needs-decision' })
  login.attention.items.push({ id: 'q1', question: 'Please log in', answer: null })
  await goals.tick()
  state = await goals.get(goal.id)
  assert.deepEqual(state.phases.map(item => item.status), ['needs-decision', 'pending', 'running'])
  assert.equal(state.decisions[0].answer, null)
  assert.equal((await goals.resume(goal.id)).status, 'running')
  login.status = 'running'
  await goals.tick()
  assert.equal((await goals.get(goal.id)).decisions[0].answer, null)
  orchestrator.complete(orchestrator.runs.get(state.phases[2].currentRunId))
  await goals.tick()
  state = await goals.get(goal.id)
  assert.equal(state.status, 'needs-decision')
  assert.deepEqual(state.phases.map(item => item.status), ['needs-decision', 'pending', 'completed'])
  await goals.answer(goal.id, state.decisions[0].id, 'answer', { note: 'Logged in', parent: agent })
  orchestrator.complete(login)
  await goals.tick()
  state = await goals.get(goal.id)
  assert.deepEqual(state.phases.map(item => item.status), ['completed', 'running', 'completed'])
})

test('skips a phase nothing depends on after its attempts run out, and the goal ends partial', async () => {
  const root = await tempRoot('auto-skip')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'two independent deliverables',
    parentSessionId: agent.id,
    maxParallelPhases: 2,
    maxAttemptsPerPhase: 2,
    phases: [phase('p1'), phase('p2')],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  const run1 = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  const run2 = orchestrator.runs.get(state.goal.phases[1].currentRunId)
  orchestrator.complete(run2)
  orchestrator.fail(run1, { error: 'the export tool is missing', stop: 'needs-decision' })
  await goals.tick()
  state = await goals.status(goal.id)
  const retried = orchestrator.runs.get(state.goal.phases[0].currentRunId)
  orchestrator.fail(retried, { error: 'the export tool is missing' })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.decisions.length, 0)
  assert.equal(state.goal.status, 'partial')
  const skipped = state.goal.phases[0]
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.skippedBy, 'exhausted')
  assert.match(skipped.skipReason, /已用尽 2 次尝试/)
  const text = formatStatus(state.goal, state.runs)
  assert.match(text, /Skipped after its attempts ran out/)
  assert.match(text, /p1「Title p1」— 已用尽 2 次尝试/)
  assert.match(text, new RegExp(`action=retry_phase goal_id=${goal.id} phase_id=p1`))
})

test('a phase with a dependent still asks a person instead of skipping', async () => {
  const root = await tempRoot('dependent')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'ordered deliverables',
    parentSessionId: agent.id,
    maxAttemptsPerPhase: 1,
    phases: [phase('p1'), phase('p2', { dependsOn: ['p1'] })],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  orchestrator.fail(orchestrator.runs.get(state.goal.phases[0].currentRunId), { error: 'export still broken' })
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'needs-decision')
  assert.equal(state.goal.decisions[0].kind, 'phase-exhausted')
  assert.match(state.goal.decisions[0].question, /下游阶段 p2 依赖它/)
  assert.equal(state.goal.phases[0].status, 'failed')
})

test('retry_phase revives a skipped phase and the phases skipped with it', async () => {
  const root = await tempRoot('retry-phase')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'one broken phase in the middle of a plan',
    parentSessionId: agent.id,
    maxParallelPhases: 2,
    maxAttemptsPerPhase: 1,
    phases: [phase('p1'), phase('p2', { dependsOn: ['p1'] }), phase('p3')],
  })
  await goals.tick()
  let state = await goals.status(goal.id)
  orchestrator.complete(orchestrator.runs.get(state.goal.phases[2].currentRunId))
  orchestrator.fail(orchestrator.runs.get(state.goal.phases[0].currentRunId), { error: 'export still broken' })
  await goals.tick()
  state = await goals.status(goal.id)
  await goals.answer(goal.id, state.goal.decisions[0].id, 'skip')
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'partial')
  assert.deepEqual(state.goal.phases.map(entry => entry.status), ['skipped', 'skipped', 'completed'])

  await goals.retryPhase(goal.id, 'p1')
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'running')
  assert.deepEqual(state.goal.phases.map(entry => entry.status), ['pending', 'pending', 'completed'])
  assert.equal(state.goal.phases[0].attempts, 0)
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'running')
  assert.equal(state.goal.phases[1].status, 'pending')
  assert.equal(state.goal.decisions.length, 1)
})

test('auto-decomposes a natural-language goal, then starts the first phase', async () => {
  const root = await tempRoot('decompose')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({ goal: 'make a 1.0 roadmap', parentSessionId: agent.id })
  assert.equal(goal.status, 'planning')

  await goals.tick()
  let state = await goals.status(goal.id)
  assert.ok(state.goal.decomposeRunId)
  const plannerRun = orchestrator.runs.get(state.goal.decomposeRunId)
  orchestrator.complete(plannerRun, '```json\n{"phases":[{"id":"p1","title":"scope","objective":"write the scope",'
    + '"acceptance":["scope exists"]},{"id":"p2","title":"ship","objective":"implement it","dependsOn":["p1"],'
    + '"acceptance":["tests pass"]}]}\n```')

  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'running')
  assert.equal(state.goal.phases.length, 2)
  assert.equal(state.goal.phases[0].status, 'pending')

  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.phases[0].status, 'running')
  assert.match(orchestrator.calls.start.at(-1).goal, /phase 1 of 2/)
})

test('an unusable phase plan fails after one repair instead of looping', async () => {
  const root = await tempRoot('decompose-fail')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({ goal: 'unplannable', parentSessionId: agent.id })
  await goals.tick()
  let state = await goals.status(goal.id)
  orchestrator.complete(orchestrator.runs.get(state.goal.decomposeRunId), 'not json at all')
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.decomposeAttempts, 2)
  orchestrator.complete(orchestrator.runs.get(state.goal.decomposeRunId), 'still not json')
  await goals.tick()
  state = await goals.status(goal.id)
  assert.equal(state.goal.status, 'failed')
  assert.equal(state.goal.stoppedReason.reason, 'decompose-failed')
  assert.equal(orchestrator.calls.start.filter(args => args.mode === 'direct').length, 2)
})

test('cancel stops the goal and its active phase runs', async () => {
  const root = await tempRoot('cancel')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const goal = await goals.create({
    goal: 'cancel me',
    parentSessionId: agent.id,
    phases: [phase('p1')],
  })
  await goals.tick()
  const state = await goals.status(goal.id)
  const runId = state.goal.phases[0].currentRunId
  await goals.cancel(goal.id)
  const after = await goals.status(goal.id)
  assert.equal(after.goal.status, 'cancelled')
  assert.deepEqual(orchestrator.calls.cancel, [runId])
})

test('a summary session reuses the answer of the decision the execution session already settled', async () => {
  const root = await tempRoot('decision-reuse')
  const orchestrator = fakeOrchestrator()
  let goals = await manager(root, orchestrator)
  const attention = (id, question, key) => ({ id, source: 'subtask-1', question,
    options: ['周六下午', '周日晚上'], ...(key ? { key } : {}) })
  try {
    const goal = await goals.create({
      goal: 'playtest and camera', parentSessionId: agent.id,
      phases: [phase('p1'), phase('p2', { dependsOn: ['p1'] })],
    })
    await goals.tick()
    let state = await goals.status(goal.id)
    const p1run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
    p1run.attention.items.push(attention('q1', '你能参加哪一个试玩时间？', 'playtest-time'))
    p1run.status = 'completed'
    p1run.goalMode.achieved = false
    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.phases[0].status, 'needs-decision')
    assert.equal(state.goal.decisions.length, 1)
    await goals.answer(goal.id, state.goal.decisions[0].id, 'answer', { note: '周六下午可以' })
    orchestrator.complete(p1run, '镜头改法和复验清单')

    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.phases[0].status, 'completed')
    assert.equal(state.goal.phases[1].status, 'running')
    const p2run = orchestrator.runs.get(state.goal.phases[1].currentRunId)
    p2run.attention.items.push(attention('q1', '试玩安排选哪个时间？', 'playtest-time'))
    p2run.status = 'completed'
    p2run.goalMode.achieved = false

    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.length, 1, 'the later session must not open a second card')
    assert.equal(state.goal.phases[1].status, 'running')
    assert.ok(orchestrator.calls.answer.some(call => call.runId === p2run.id && call.attentionId === 'q1'
      && call.text === '周六下午可以'), 'the settled answer must reach the summary run')
    await goals.close()

    goals = await manager(root, orchestrator)
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.length, 1, 'the one card and its answer survive a restart')
    assert.equal(state.goal.decisions[0].answerText, '周六下午可以')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a completed phase keeps its concrete conclusion for the chat receipt across a restart', async () => {
  const root = await tempRoot('phase-summary')
  const orchestrator = fakeOrchestrator()
  let goals = await manager(root, orchestrator)
  try {
    const goal = await goals.create({ goal: 'tower defense', parentSessionId: agent.id, phases: [phase('p1')] })
    await goals.tick()
    let state = await goals.status(goal.id)
    const run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
    orchestrator.complete(run, [
      '把镜头切到敌人来的一侧，并在门口留 1.5 秒空镜。',
      '',
      '复验清单：',
      '- 门口视角能看清来袭方向',
      '- 空格镜头不再贴脸',
    ].join('\n'))
    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.phases[0].status, 'completed')
    assert.match(state.goal.phases[0].summary, /门口留 1\.5 秒空镜/)
    assert.match(state.goal.phases[0].summary, /复验清单/)
    assert.doesNotMatch(state.goal.phases[0].summary, /```/)
    await goals.close()

    goals = await manager(root, orchestrator)
    state = await goals.status(goal.id)
    assert.match(state.goal.phases[0].summary, /复验清单/, 'the conclusion must survive a restart')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('the planner is told what the conversation already answered, so it is not planned again', async () => {
  const root = await tempRoot('delivered-reply')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const dinner = '今晚三个人可以点清蒸鲈鱼、番茄炒蛋、蒜蓉西兰花，再加一个冬瓜排骨汤，人均大约八十。'
  try {
    const goal = await goals.create({
      goal: '把塔防门口镜头改清楚，晚饭也帮我配一下', parentSessionId: agent.id, deliveredReply: dinner,
    })
    await goals.tick()
    const planning = orchestrator.calls.start[0]
    assert.ok(planning, 'planning must start')
    assert.match(planning.goal, /清蒸鲈鱼/, 'the delivered answer must reach the planner')
    assert.match(planning.goal, /Already answered directly/)
    // The planner drops the dinner phase only because it was told the dinner
    // answer already reached the conversation.
    const plan = planning.goal.includes('清蒸鲈鱼')
      ? [{ id: 'p1', title: '镜头方案', objective: '改镜头', acceptance: ['镜头通过'] }]
      : [{ id: 'p1', title: '镜头方案', objective: '改镜头', acceptance: ['镜头通过'] },
          { id: 'p2', title: '晚饭搭配', objective: '配菜', acceptance: ['配好'] }]
    orchestrator.complete([...orchestrator.runs.values()].at(-1), JSON.stringify({ phases: plan }))
    await goals.tick()
    const state = await goals.status(goal.id)
    assert.deepEqual(state.goal.phases.map(item => item.id), ['p1'], 'the delivered dinner must not become a phase')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('two parallel sessions asking different decisions with equal options keep two cards', async () => {
  const root = await tempRoot('decision-separation')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const attention = (id, question) => ({ id, source: 'worker', question, options: ['是', '否'] })
  try {
    const goal = await goals.create({ goal: 'date and audience', parentSessionId: agent.id,
      phases: [phase('p1'), phase('p2')] })
    await goals.tick()
    let state = await goals.status(goal.id)
    const p1run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
    const p2run = orchestrator.runs.get(state.goal.phases[1].currentRunId)
    p1run.attention.items.push(attention('q1', '试玩日期要不要定在周六？'))
    p2run.attention.items.push(attention('q1', '发布说明要不要只给团队看？'))
    for (const run of [p1run, p2run]) {
      run.status = 'completed'
      run.goalMode.achieved = false
    }

    // The first tick parks the goal on p1's question; the next one still
    // watches the other in-flight phase.
    await goals.tick()
    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.length, 2, 'a shared 是/否 option set is not one decision')
    const first = state.goal.decisions[0]
    const second = state.goal.decisions[1]
    await goals.answer(goal.id, first.id, 'answer', { note: '定在周六' })

    assert.ok(orchestrator.calls.answer.some(call => call.runId === p1run.id && call.attentionId === 'q1'))
    assert.ok(!orchestrator.calls.answer.some(call => call.runId === p2run.id),
      'the other decision must not receive this answer')
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.find(item => item.id === second.id).answer, null)
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a stale binding never hands the old answer to a new question', async () => {
  const root = await tempRoot('decision-stale-link')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  try {
    const goal = await goals.create({ goal: 'one playtime question', parentSessionId: agent.id, phases: [phase('p1')] })
    await goals.tick()
    let state = await goals.status(goal.id)
    const p1run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
    p1run.attention.items.push({
      id: 'q1', source: 'worker', question: '你能参加哪一个试玩时间？', options: ['是', '否'],
      key: `${p1run.id.toLowerCase()}:q1`,
    })
    p1run.status = 'completed'
    p1run.goalMode.achieved = false
    await goals.tick()
    state = await goals.status(goal.id)
    const decision = state.goal.decisions[0]

    // That session restarted and now waits on a different question. The card is
    // bound to q1, so its answer must not land on the new one.
    p1run.attention.items = [{
      id: 'q9', source: 'worker', question: '发布说明用哪种口吻？', options: ['是', '否'],
      key: `${p1run.id.toLowerCase()}:q9`,
    }]
    await assert.rejects(goals.answer(goal.id, decision.id, 'answer', { note: '周六下午可以' }),
      /no longer waiting/)
    assert.ok(!orchestrator.calls.answer.some(call => call.attentionId === 'q9'),
      'a stale binding must not answer the new question')
    state = await goals.status(goal.id)
    assert.equal(state.goal.phases[0].status, 'needs-decision')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('an out-of-scope citation keeps its own card and never receives the answer', async () => {
  const root = await tempRoot('runtime-key-scope')
  const orchestrator = fakeOrchestrator()
  let goals = await manager(root, orchestrator)
  const runtimeKey = (runId, id = 'q1') => `${runId.toLowerCase()}:${id}`
  try {
    const goal = await goals.create({
      goal: 'playtest, briefing and release', parentSessionId: agent.id, maxParallelPhases: 3,
      phases: [phase('p1'), phase('p2'), phase('p3')],
    })
    await goals.tick()
    let state = await goals.status(goal.id)
    const p1run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
    const p2run = orchestrator.runs.get(state.goal.phases[1].currentRunId)
    const p3run = orchestrator.runs.get(state.goal.phases[2].currentRunId)
    // The execution session asks naturally; the orchestrator registers the key.
    p1run.attention.items.push({
      id: 'q1', source: 'subtask-1', question: '试玩定在周六还是周日？', options: ['周六', '周日'], key: runtimeKey(p1run.id),
    })
    p1run.status = 'completed'
    p1run.goalMode.achieved = false
    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.length, 1)
    const privateKey = state.goal.decisions[0].key
    assert.equal(privateKey, runtimeKey(p1run.id), 'the runtime key is persisted with the card')

    // The host restarts before the other sessions ask anything.
    await goals.close()
    goals = await manager(root, orchestrator)

    // p2 and p3 do not depend on p1. Even a well-formed citation of p1's
    // registered key (or an unknown one) must stay independent and must never
    // receive p1's private answer.
    p2run.attention.items.push({
      id: 'q1', source: 'subtask-2', question: '试玩安排选哪个时间？', options: ['周六', '周日'],
      key: runtimeKey(p2run.id), refKey: privateKey,
    })
    p3run.attention.items.push({
      id: 'q1', source: 'subtask-3', question: '发布说明要不要只给团队看？', options: ['是', '否'],
      key: runtimeKey(p3run.id), refKey: 'missing-key',
    })
    for (const run of [p2run, p3run]) {
      run.status = 'completed'
      run.goalMode.achieved = false
    }
    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.length, 3, 'out-of-scope and unknown citations stay independent')
    const privateCard = state.goal.decisions.find(item => item.key === privateKey)
    assert.equal(privateCard.linked, undefined, 'no unrelated session is bound to the private card')
    assert.equal(state.goal.decisions.find(item => item.phaseId === 'p2').key, runtimeKey(p2run.id),
      'an out-of-scope citation is not trusted as identity')
    assert.equal(state.goal.decisions.find(item => item.phaseId === 'p3').key, runtimeKey(p3run.id))

    await goals.answer(goal.id, privateCard.id, 'answer', { note: '定在周六' })
    assert.ok(orchestrator.calls.answer.some(call => call.runId === p1run.id && call.attentionId === 'q1'))
    assert.ok(!orchestrator.calls.answer.some(call => call.runId === p2run.id),
      'the out-of-scope session must not receive this answer')
    assert.ok(!orchestrator.calls.answer.some(call => call.runId === p3run.id),
      'the unknown citation must not receive this answer')

    await goals.close()
    goals = await manager(root, orchestrator)
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.length, 3, 'the isolation survives a restart')
    assert.equal(state.goal.decisions.find(item => item.key === privateKey).answerText, '定在周六')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a private answer never reaches a phase outside its dependency chain', async () => {
  const root = await tempRoot('decision-phase-scope')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  const runtimeKey = (runId, id = 'q1') => `${runId.toLowerCase()}:${id}`
  try {
    // p3 waits on p2 only; p1 is not its prerequisite.
    const goal = await goals.create({
      goal: 'playtest and release notes', parentSessionId: agent.id, maxParallelPhases: 2,
      phases: [phase('p1'), phase('p2'), phase('p3', { dependsOn: ['p2'] })],
    })
    await goals.tick()
    let state = await goals.status(goal.id)
    const p1run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
    const p2run = orchestrator.runs.get(state.goal.phases[1].currentRunId)
    p1run.attention.items.push({
      id: 'q1', source: 'worker', question: '试玩定在哪个时间？', options: ['周六', '周日'], key: runtimeKey(p1run.id),
    })
    p1run.status = 'failed'
    p1run.goalMode.achieved = false
    p1run.goalMode.stop = { reason: 'needs-decision' }
    orchestrator.complete(p2run, 'notes drafted')
    await goals.tick()
    state = await goals.status(goal.id)
    const decision = state.goal.decisions.find(item => item.phaseId === 'p1')
    await goals.answer(goal.id, decision.id, 'answer', { note: 'SCOPE-PLAYTEST-ONLY 周六' })
    orchestrator.complete(p1run, 'playtest arranged')
    await goals.tick()

    state = await goals.status(goal.id)
    assert.equal(state.goal.phases[2].status, 'running')
    const p3start = orchestrator.calls.start.at(-1)
    assert.ok(!p3start.goal.includes('SCOPE-PLAYTEST-ONLY'), 'p3 must not read p1 private answer')
    assert.ok(!p3start.goal.includes(decision.key), 'p3 is not even offered the out-of-scope key')

    const p3run = orchestrator.runs.get(state.goal.phases[2].currentRunId)
    p3run.attention.items.push({
      id: 'q1', source: 'worker', question: '发布说明面向内部团队吗？', options: ['是', '否'],
      key: runtimeKey(p3run.id), refKey: decision.key,
    })
    p3run.status = 'completed'
    p3run.goalMode.achieved = false
    await goals.tick()
    state = await goals.status(goal.id)
    const card = state.goal.decisions.find(item => item.phaseId === 'p3')
    assert.equal(card.key, runtimeKey(p3run.id), 'an out-of-scope citation opens its own card')
    assert.ok(!orchestrator.calls.answer.some(call => call.runId === p3run.id),
      'the private answer must not be delivered to an unrelated phase')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a settled runtime key is offered to the next phase and reused instead of re-asked', async () => {
  const root = await tempRoot('runtime-key-reuse')
  const orchestrator = fakeOrchestrator()
  let goals = await manager(root, orchestrator)
  try {
    const goal = await goals.create({
      goal: 'playtest and recap', parentSessionId: agent.id,
      phases: [phase('p1'), phase('p2', { dependsOn: ['p1'] })],
    })
    await goals.tick()
    let state = await goals.status(goal.id)
    const p1run = orchestrator.runs.get(state.goal.phases[0].currentRunId)
    p1run.attention.items.push({
      id: 'q1', source: 'subtask-1', question: '试玩定在周六还是周日？', options: ['周六', '周日'],
      key: `${p1run.id.toLowerCase()}:q1`,
    })
    p1run.status = 'completed'
    p1run.goalMode.achieved = false
    await goals.tick()
    state = await goals.status(goal.id)
    const decision = state.goal.decisions[0]
    assert.equal(decision.key, `${p1run.id.toLowerCase()}:q1`)
    await goals.answer(goal.id, decision.id, 'answer', { note: '定在周六' })
    orchestrator.complete(p1run, '时间已定')
    await goals.tick()

    state = await goals.status(goal.id)
    assert.equal(state.goal.phases[1].status, 'running')
    const p2start = orchestrator.calls.start.at(-1)
    assert.match(p2start.goal, new RegExp(`key "${decision.key}"`), 'the next session is given the registered key')
    assert.match(p2start.goal, /定在周六/, 'and the confirmed answer')

    await goals.close()
    goals = await manager(root, orchestrator)
    const p2run = orchestrator.runs.get(state.goal.phases[1].currentRunId)
    p2run.attention.items.push({
      id: 'q1', source: 'worker', question: '试玩安排选哪个时间？', options: ['周六', '周日'],
      key: `${p2run.id.toLowerCase()}:q1`, refKey: decision.key,
    })
    p2run.status = 'completed'
    p2run.goalMode.achieved = false
    await goals.tick()
    state = await goals.status(goal.id)
    assert.equal(state.goal.decisions.length, 1, 'the cited key reuses the settled card after a restart')
    assert.ok(orchestrator.calls.answer.some(call => call.runId === p2run.id && call.attentionId === 'q1'
      && call.text === '定在周六'), 'the confirmed answer reaches the exact later question')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a key registered by another goal never joins this goal card', async () => {
  const root = await tempRoot('cross-goal-key')
  const orchestrator = fakeOrchestrator()
  const goals = await manager(root, orchestrator)
  try {
    const goalA = await goals.create({ goal: 'playtest dates', parentSessionId: agent.id, phases: [phase('p1')] })
    const goalB = await goals.create({ goal: 'release audience', parentSessionId: agent.id, phases: [phase('p1')] })
    await goals.tick()
    const a = await goals.status(goalA.id)
    const b = await goals.status(goalB.id)
    const runA = orchestrator.runs.get(a.goal.phases[0].currentRunId)
    const runB = orchestrator.runs.get(b.goal.phases[0].currentRunId)
    runA.attention.items.push({
      id: 'q1', source: 'worker', question: '试玩定在哪天？', options: ['周六', '周日'], key: `${runA.id.toLowerCase()}:q1`,
    })
    runB.attention.items.push({
      id: 'q1', source: 'worker', question: '试玩安排选哪个时间？', options: ['周六', '周日'],
      key: `${runB.id.toLowerCase()}:q1`, refKey: `${runA.id.toLowerCase()}:q1`,
    })
    for (const run of [runA, runB]) {
      run.status = 'completed'
      run.goalMode.achieved = false
    }
    await goals.tick()

    const afterA = await goals.status(goalA.id)
    const afterB = await goals.status(goalB.id)
    assert.equal(afterA.goal.decisions.length, 1)
    assert.equal(afterB.goal.decisions.length, 1)
    assert.equal(afterB.goal.decisions[0].key, `${runB.id.toLowerCase()}:q1`,
      'a key from another goal is not accepted as identity here')
  } finally {
    await goals.close()
    await fsp.rm(root, { recursive: true, force: true })
  }
})
