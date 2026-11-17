import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { normalizeGoalSpec, parseVerdict, runChecks } from '../lib/goal.js'
import { apply } from '../lib/index.js'
import { createOrchestrator } from '../lib/orchestrator.js'

const execFileAsync = promisify(execFile)

const BASE_CONFIG = {
  maxSubtasks: 6,
  maxParallel: 3,
  maxActiveRuns: 2,
  attempts: 2,
  deadlineMinutes: 60,
  resultCapBytes: 32 * 1024,
  maxModelCallsPerRun: 0,
  maxTokensPerRun: 0,
}

function memoryStore() {
  const runs = new Map()
  const cancels = new Set()
  const locks = new Map()
  const store = {
    runs,
    cancels,
    locks,
    owner: null,
    async init() {},
    async list() {
      return [...runs.values()].map(run => structuredClone(run))
    },
    async read(id) {
      const run = runs.get(id)
      return run ? structuredClone(run) : null
    },
    async write(run) {
      runs.set(run.id, structuredClone(run))
    },
    async requestCancel(id) {
      cancels.add(id)
      return true
    },
    async hasCancelRequest(id) {
      return cancels.has(id)
    },
    async clearCancel(id) {
      cancels.delete(id)
    },
    async readOwner() {
      return store.owner
    },
    async writeOwner(owner) {
      store.owner = owner
    },
    async acquireLock(id, holder) {
      if (locks.has(id)) return { acquired: false, holder: locks.get(id) }
      locks.set(id, holder)
      return { acquired: true, holder }
    },
    async readLock(id) {
      return locks.get(id) ?? null
    },
    async releaseLock(id) {
      locks.delete(id)
    },
  }
  return store
}

function completed(text) {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

function makeSpawner(handle) {
  let seq = 0
  const calls = []
  const spawnChild = async spec => {
    const childId = `child-${++seq}`
    calls.push({ label: spec.label, prompt: spec.prompt, childId })
    return {
      childId,
      result: Promise.resolve().then(() => handle(spec, childId)),
      dispose: async () => {},
    }
  }
  return { spawnChild, calls }
}

function orchestratorWith({ spawner, config = {} }) {
  const notifications = []
  const store = memoryStore()
  const orchestrator = createOrchestrator({
    store,
    config: { ...BASE_CONFIG, ...config },
    spawnChild: spawner.spawnChild,
    readUsage: async () => ({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      modelCalls: 1,
      models: { 'test/model': { inputTokens: 10, outputTokens: 2, calls: 1 } },
    }),
    memory: null,
    notify: run => notifications.push(run.id),
    log: () => {},
  })
  return { orchestrator, store, notifications }
}

const parent = { id: 'session-parent' }

/** A real git workspace, so the change fingerprint is exercised for real. */
async function makeWorkspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-goal-'))
  await execFileAsync('git', ['init', '-q', dir])
  return dir
}

/** The acceptance command used by the integration tests: pass only on "fixed". */
const CHECK_SCRIPT = `
import { readFileSync } from 'node:fs'
try {
  process.exit(readFileSync('answer.txt', 'utf8') === 'fixed' ? 0 : 1)
} catch {
  process.exit(1)
}
`

function goalSpec(cwd, overrides = {}) {
  return {
    cwd,
    maxRounds: 4,
    maxWallClockMinutes: 30,
    acceptance: [
      {
        id: 'answer',
        text: 'answer.txt contains "fixed"',
        check: { type: 'command', command: 'node check.mjs' },
      },
    ],
    ...overrides,
  }
}

test('goal mode stops on the round whose acceptance command passes', async () => {
  const cwd = await makeWorkspace()
  await fsp.writeFile(path.join(cwd, 'check.mjs'), CHECK_SCRIPT, 'utf8')
  const spawner = makeSpawner(async spec => {
    await fsp.writeFile(path.join(cwd, 'answer.txt'), 'fixed', 'utf8')
    return completed(`wrote ${spec.label}`)
  })
  const { orchestrator, store, notifications } = orchestratorWith({ spawner })

  const run = await orchestrator.start({
    goal: 'write a fixed answer',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
    goalMode: goalSpec(cwd),
  })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.goalMode.achieved, true)
  assert.equal(finished.goalMode.rounds.length, 1)
  assert.equal(finished.goalMode.stop, null)
  const checks = finished.goalMode.rounds[0].checks
  assert.equal(checks[0].id, 'answer')
  assert.equal(checks[0].source, 'command')
  assert.equal(checks[0].ok, true)
  assert.equal(checks[0].exitCode, 0)
  assert.match(finished.report, /# Goal achieved/)
  assert.equal(notifications.length, 1)
})

test('a failed round feeds what is missing into the next round, which then passes', async () => {
  const cwd = await makeWorkspace()
  await fsp.writeFile(path.join(cwd, 'check.mjs'), CHECK_SCRIPT, 'utf8')
  const notificationSnapshots = []
  let rounds = 0
  const spawner = {
    calls: [],
    async spawnChild(spec) {
      rounds++
      notificationSnapshots.push(notifications.length)
      spawner.calls.push(spec)
      if (rounds === 1) {
        await fsp.writeFile(path.join(cwd, 'answer.txt'), 'broken', 'utf8')
        return { childId: `child-${rounds}`, result: Promise.resolve(completed('wrote a broken answer')), dispose: async () => {} }
      }
      // The second round must be told what failed, not given the same task.
      assert.match(spec.prompt, /Previous round \(round 1\) did not meet the acceptance conditions/)
      assert.match(spec.prompt, /\[answer\] answer\.txt contains "fixed"/)
      await fsp.writeFile(path.join(cwd, 'answer.txt'), 'fixed', 'utf8')
      return { childId: `child-${rounds}`, result: Promise.resolve(completed('fixed the answer')), dispose: async () => {} }
    },
  }
  const { orchestrator, store, notifications } = orchestratorWith({ spawner })

  const run = await orchestrator.start({
    goal: 'write a fixed answer',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
    goalMode: goalSpec(cwd, { maxRounds: 3 }),
  })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.goalMode.rounds.length, 2)
  assert.equal(finished.goalMode.rounds[0].achieved, false)
  assert.equal(finished.goalMode.rounds[0].failed[0].id, 'answer')
  assert.equal(finished.goalMode.rounds[1].achieved, true)
  assert.match(finished.report, /Tried:/)
  // No notification before the run settled, not even after the failed round.
  assert.deepEqual(notificationSnapshots, [0, 0])
  assert.equal(notifications.length, 1)
})

test('the goal budget stops the loop instead of starting another round', async () => {
  const cwd = await makeWorkspace()
  await fsp.writeFile(path.join(cwd, 'check.mjs'), 'process.exit(1)\n', 'utf8')
  const spawner = makeSpawner(async () => {
    const name = `attempt-${Date.now()}-${Math.random()}.txt`
    await fsp.writeFile(path.join(cwd, name), 'tried', 'utf8')
    return completed('attempted a fix')
  })
  const { orchestrator, store, notifications } = orchestratorWith({ spawner, config: { maxModelCallsPerRun: 10 } })

  const run = await orchestrator.start({
    goal: 'write a fixed answer',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
    goalMode: goalSpec(cwd, { maxRounds: 5, noProgressRounds: 5, budget: { maxModelCalls: 2 } }),
  })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.goalMode.rounds.length, 2)
  assert.equal(finished.goalMode.stop.reason, 'budget')
  assert.equal(finished.goalMode.achieved, false)
  assert.notEqual(finished.status, 'completed')
  assert.match(finished.report, /stopped: budget reached/)
  assert.equal(notifications.length, 1)
})

test('the same failing condition twice in a row, with changes in between, is no progress', async () => {
  const cwd = await makeWorkspace()
  await fsp.writeFile(path.join(cwd, 'check.mjs'), 'process.exit(1)\n', 'utf8')
  const spawner = makeSpawner(async () => {
    await fsp.writeFile(path.join(cwd, `attempt-${Date.now()}-${Math.random()}.txt`), 'tried', 'utf8')
    return completed('attempted a fix')
  })
  const { orchestrator, store } = orchestratorWith({ spawner })

  const run = await orchestrator.start({
    goal: 'write a fixed answer',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
    goalMode: goalSpec(cwd, { maxRounds: 5, noProgressRounds: 2 }),
  })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.goalMode.rounds.length, 2)
  assert.equal(finished.goalMode.stop.reason, 'no-progress')
  assert.equal(finished.goalMode.rounds[1].streak, 2)
  assert.equal(finished.goalMode.rounds[0].changed, true)
  assert.match(finished.report, /no progress: the same acceptance condition failed again/)
})

test('a round that changed nothing stalls immediately instead of burning another round', async () => {
  const cwd = await makeWorkspace()
  await fsp.writeFile(path.join(cwd, 'check.mjs'), 'process.exit(1)\n', 'utf8')
  const spawner = makeSpawner(async () => completed('thought about it'))
  const { orchestrator, store } = orchestratorWith({ spawner })

  const run = await orchestrator.start({
    goal: 'write a fixed answer',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
    goalMode: goalSpec(cwd, { maxRounds: 5 }),
  })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.goalMode.rounds.length, 1)
  assert.equal(finished.goalMode.rounds[0].changed, false)
  assert.equal(finished.goalMode.stop.reason, 'no-changes')
  assert.match(finished.report, /no progress: the round changed nothing/)
})

test('max rounds is a hard stop of its own', async () => {
  const cwd = await makeWorkspace()
  await fsp.writeFile(path.join(cwd, 'check.mjs'), 'process.exit(1)\n', 'utf8')
  const spawner = makeSpawner(async () => {
    await fsp.writeFile(path.join(cwd, `attempt-${Date.now()}-${Math.random()}.txt`), 'tried', 'utf8')
    return completed('attempted a fix')
  })
  const { orchestrator, store } = orchestratorWith({ spawner })

  const run = await orchestrator.start({
    goal: 'write a fixed answer',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
    goalMode: goalSpec(cwd, { maxRounds: 2, noProgressRounds: 5 }),
  })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.goalMode.rounds.length, 2)
  assert.equal(finished.goalMode.stop.reason, 'rounds')
})

test('machine checks carry real exit codes; conditions without a check stay model-judged', async () => {
  const cwd = await makeWorkspace()
  await fsp.writeFile(path.join(cwd, 'present.txt'), 'here', 'utf8')
  const spec = normalizeGoalSpec({
    cwd,
    acceptance: [
      { id: 'pass', text: 'the build passes', check: { type: 'command', command: 'node -e "process.exit(0)"' } },
      { id: 'fail', text: 'the tests pass', check: { type: 'command', command: 'node -e "process.exit(3)"' } },
      { id: 'file', text: 'the artifact exists', check: { type: 'file', path: 'present.txt' } },
      { id: 'missing', text: 'the lockfile is gone', check: { type: 'file', path: 'lock.json', mustExist: false } },
      { id: 'judged', text: 'the change is minimal' },
    ],
  })

  const checks = await runChecks(spec)
  const byId = Object.fromEntries(checks.map(check => [check.id, check]))

  assert.equal(byId.pass.ok, true)
  assert.equal(byId.pass.exitCode, 0)
  assert.equal(byId.pass.source, 'command')
  assert.equal(byId.fail.ok, false)
  assert.equal(byId.fail.exitCode, 3)
  assert.match(byId.fail.detail, /exit 3/)
  assert.equal(byId.file.ok, true)
  assert.equal(byId.missing.ok, true)
  assert.equal(byId.judged.source, 'model')
  assert.equal(byId.judged.ok, null)
})

test('model-only acceptance is judged by an independent child and labeled', async () => {
  const cwd = await makeWorkspace()
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-accept') {
      assert.match(spec.prompt, /Conditions only you can judge/)
      assert.match(spec.prompt, /\[evidence\] the report cites the file it changed/)
      return completed('{"achieved":true,"failed":[],"next":""}')
    }
    return completed('changed answer.txt and cited it in the report')
  })
  const { orchestrator, store } = orchestratorWith({ spawner })

  const run = await orchestrator.start({
    goal: 'change a file and report it',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
    goalMode: {
      cwd,
      maxRounds: 2,
      acceptance: [{ id: 'evidence', text: 'the report cites the file it changed' }],
    },
  })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.goalMode.achieved, true)
  const check = finished.goalMode.rounds[0].checks[0]
  assert.equal(check.source, 'model')
  assert.equal(check.ok, true)
  assert.equal(spawner.calls.filter(call => call.label === 'superagent-accept').length, 1)
})

test('a single-worker text goal is judged on its output without a copied prompt', async () => {
  let judgedReport
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed('{"subtasks":[{"title":"Write the example","prompt":"Write one plain-text example"}]}')
    }
    if (spec.label === 'superagent-accept') {
      judgedReport = spec.prompt.split('Round 1 report:\n')[1].split('\n\nConditions')[0]
      return completed('{"achieved":true,"failed":[],"next":""}')
    }
    return completed('Ready for customers.')
  })
  const { orchestrator, store } = orchestratorWith({ spawner })
  const run = await orchestrator.start({
    goal: 'Write one line of plain text', parentSessionId: parent.id, parent,
    goalMode: { acceptance: [{ text: 'The result only contains the sentence for customers' }] },
  })
  await orchestrator.idle()
  assert.equal(judgedReport, 'Ready for customers.')
  assert.equal((await store.read(run.id)).status, 'completed')
})

test('goal mode is off by default: one plan, no rounds, no acceptance child', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      assert.doesNotMatch(spec.prompt, /Acceptance conditions/)
      return completed(JSON.stringify({ subtasks: [{ title: 'one', prompt: 'do the thing' }] }))
    }
    return completed(`result for ${spec.label}`)
  })
  const { orchestrator, store, notifications } = orchestratorWith({ spawner })

  const run = await orchestrator.start({ goal: 'do the thing', parentSessionId: parent.id, parent })
  await orchestrator.idle()
  const finished = await store.read(run.id)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.goalMode, null)
  assert.equal(finished.plan.mode, 'planned')
  assert.deepEqual(spawner.calls.map(call => call.label), ['superagent-plan', 'superagent-1'])
  assert.equal(notifications.length, 1)
})

test('parseVerdict accepts a fenced verdict and rejects prose', () => {
  const fenced = parseVerdict('Here is the result:\n```json\n{"achieved":false,"failed":[{"id":"a2","why":"no test output"}],"next":"add the test"}\n```')
  assert.equal(fenced.error, null)
  assert.equal(fenced.verdict.achieved, false)
  assert.deepEqual(fenced.verdict.failed, [{ id: 'a2', why: 'no test output' }])
  assert.equal(fenced.verdict.next, 'add the test')

  const prose = parseVerdict('I think it is probably done.')
  assert.equal(prose.verdict, null)
  assert.match(prose.error, /no JSON/)
})

test('the tool refuses acceptance without goal_mode and maps the goal flags through', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-goal-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-goal-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents: {
      async startActivation(spec) {
        return {
          childId: `child-${spec.label}`,
          result: Promise.resolve({ output: [{ type: 'text', text: 'did the work' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    get: () => undefined,
  }
  try {
    apply(ctx, { stateDir, notifyOnComplete: false })
    const rejected = await tools.get('superagent_start').execute(
      { goal: 'do a thing', acceptance: [{ text: 'done' }] },
      { agent: { id: 'session-1' } },
    )
    assert.match(rejected, /^\[error\] acceptance is only read in goal mode/)

    const started = await tools.get('superagent_start').execute(
      {
        goal: 'do a thing',
        mode: 'direct',
        wait_seconds: 20,
        goal_mode: true,
        max_rounds: 1,
        acceptance: [
          { id: 'always', text: 'the machine says so', check: { type: 'command', command: 'node -e "process.exit(0)"' } },
        ],
      },
      { agent: { id: 'session-1' } },
    )
    assert.doesNotMatch(started, /\[error/)
    assert.match(started, /goal mode: round 1\/1 — achieved/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})

