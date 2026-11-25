import assert from 'node:assert/strict'
import test from 'node:test'

import { createOrchestrator, normalizeMode } from '../lib/orchestrator.js'

const BASE_CONFIG = {
  maxSubtasks: 6,
  maxParallel: 3,
  maxActiveRuns: 2,
  maxQueuedRuns: 5,
  queueTimeoutMinutes: 30,
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

/** A promise that resolves when `open()` is called. */
function gate() {
  let open
  const opened = new Promise(resolve => {
    open = resolve
  })
  return { opened, open: () => open() }
}

function makeSpawner(handle) {
  let seq = 0
  const calls = []
  return {
    calls,
    spawnChild: async spec => {
      const childId = `child-${++seq}`
      calls.push({ label: spec.label, prompt: spec.prompt })
      return {
        childId,
        result: Promise.resolve().then(() => handle(spec, childId)),
        dispose: async () => {},
      }
    },
  }
}

test('a long-goal dispatch reuses its completed run if the goal record was not saved', async () => {
  const store = memoryStore()
  const spawner = makeSpawner(() => completed('finished'))
  const { orchestrator } = orchestratorWith({ store, spawner })
  const args = {
    goal: 'Prepare release notes', parentSessionId: 'owner', parent: { id: 'owner' },
    mode: 'direct', allowDuplicate: true,
    origin: { kind: 'long-goal', goalId: 'goal-1', phaseId: 'notes', dispatchId: 'goal-1/phase/notes/1' },
  }
  const first = await orchestrator.start(args)
  assert.equal((await orchestrator.status(first.id, 3)).status, 'completed')
  const restarted = orchestratorWith({ store, spawner }).orchestrator
  const second = await restarted.start(args)
  assert.equal(second.id, first.id)
  assert.equal(second.status, 'completed')
  assert.equal(spawner.calls.length, 1)
})

function orchestratorWith({ store = memoryStore(), spawner, config = {}, setTimer, clearTimer }) {
  const notifications = []
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
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
  })
  return { orchestrator, store, notifications }
}

const parent = { id: 'session-parent' }

/** Poll a predicate without assuming how many microtasks the scheduler needs. */
async function waitFor(predicate, label = 'condition') {
  const endsAt = Date.now() + 3000
  while (Date.now() < endsAt) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

test('a queued run settles as failed when promotion cannot take its lock', async () => {
  const store = memoryStore()
  const acquireLock = store.acquireLock
  let failLocks = false
  store.acquireLock = async (id, holder) => {
    if (failLocks) throw new Error('lock disk unavailable')
    return acquireLock(id, holder)
  }
  const firstWorker = gate()
  let calls = 0
  const spawner = makeSpawner(async () => {
    calls += 1
    if (calls === 1) await firstWorker.opened
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    store,
    spawner,
    config: { maxActiveRuns: 1, queueTimeoutMinutes: 30 },
  })
  const first = await orchestrator.start({
    goal: 'hold the only slot', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => calls === 1, 'the first worker to start')
  const queued = await orchestrator.start({
    goal: 'wait for the slot', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })
  assert.equal(queued.status, 'queued')

  failLocks = true
  firstWorker.open()
  const finished = await orchestrator.status(queued.id, 10)

  assert.equal((await orchestrator.status(first.id, 10)).status, 'completed')
  assert.equal(finished.status, 'failed')
  assert.equal(finished.queue.waiting, false)
  assert.match(finished.error, /could not be claimed.*lock disk unavailable/)
  assert.equal(calls, 1, 'the unclaimed run must never dispatch a child')
})

test('a queued run settles as failed when its promotion save fails once', async () => {
  const store = memoryStore()
  const write = store.write
  let failPromotion = false
  store.write = async run => {
    if (failPromotion && run.status === 'queued' && run.queue?.waiting === false) {
      failPromotion = false
      throw new Error('disk full during promotion')
    }
    return write(run)
  }
  const firstWorker = gate()
  let calls = 0
  const spawner = makeSpawner(async () => {
    calls += 1
    if (calls === 1) await firstWorker.opened
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    store,
    spawner,
    config: { maxActiveRuns: 1, queueTimeoutMinutes: 30 },
  })
  const first = await orchestrator.start({
    goal: 'hold the only slot', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => calls === 1, 'the first worker to start')
  const queued = await orchestrator.start({
    goal: 'wait for the slot', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })

  failPromotion = true
  firstWorker.open()
  const finished = await orchestrator.status(queued.id, 10)

  assert.equal((await orchestrator.status(first.id, 10)).status, 'completed')
  assert.equal(finished.status, 'failed')
  assert.equal(finished.queue.waiting, false)
  assert.match(finished.error, /could not be claimed.*disk full during promotion/)
  assert.equal(calls, 1)
})

test('a queued run stays queued until its failure can be persisted', async () => {
  const store = memoryStore()
  const write = store.write
  let failPersistence = false
  store.write = async run => {
    if (failPersistence && ((run.status === 'queued' && run.queue?.waiting === false)
      || (run.status === 'failed' && run.queue?.failed))) {
      throw new Error('disk still full')
    }
    return write(run)
  }
  const firstWorker = gate()
  let calls = 0
  const spawner = makeSpawner(async () => {
    calls += 1
    if (calls === 1) await firstWorker.opened
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    store,
    spawner,
    config: { maxActiveRuns: 1, queueTimeoutMinutes: 30 },
  })
  const first = await orchestrator.start({
    goal: 'hold the only slot', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => calls === 1, 'the first worker to start')
  const queued = await orchestrator.start({
    goal: 'wait for the slot', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })

  failPersistence = true
  firstWorker.open()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal((await store.read(queued.id)).status, 'queued')
  assert.equal((await store.read(queued.id)).queue.waiting, true)

  failPersistence = false
  const finished = await orchestrator.status(queued.id, 10)
  assert.equal((await orchestrator.status(first.id, 10)).status, 'completed')
  assert.equal(finished.status, 'completed')
  assert.equal(finished.queue.waiting, false)
  assert.equal(calls, 2, 'the retained run starts once persistence recovers')
})

test('cancelling a direct subtask aborts its worker and never retries it', async () => {
  let calls = 0
  let finishFirst
  const spawnChild = async () => {
    calls += 1
    if (calls === 1) {
      return {
        childId: 'direct-first',
        result: new Promise(resolve => { finishFirst = resolve }),
        dispose: async () => finishFirst({ output: [], stopReason: 'cancelled', diagnostic: 'disposed' }),
      }
    }
    return { childId: 'direct-retry', result: new Promise(() => {}), dispose: async () => {} }
  }
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { attempts: 2 },
  })
  const run = await orchestrator.start({
    goal: 'do one direct task', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => calls === 1, 'the direct worker to start')

  const stopped = await orchestrator.cancelSubtask(run.id, '1')
  assert.equal(stopped.subtasks[0].status, 'cancelled')
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'cancelled')
  assert.equal(finished.subtasks[0].status, 'cancelled')
  assert.equal(calls, 1, 'a cancelled direct worker must not be dispatched again')
})

test('direct mode runs one worker and its reply is the report', async () => {
  const { spawnChild, calls } = makeSpawner(async () => completed('the raw answer'))
  const { orchestrator, store } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({
    goal: 'name the capital of France',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
  })
  assert.equal(run.mode, 'direct')

  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.plan.mode, 'direct')
  assert.equal(finished.subtasks.length, 1)
  assert.equal(finished.report, 'the raw answer')

  // The ledger is the same as for a planned run: one child, one model call.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].label, 'superagent-direct')
  assert.match(calls[0].prompt, /name the capital of France/)
  assert.equal(finished.usage.modelCalls, 1)
  assert.equal(finished.usage.inputTokens, 10)
  assert.equal(finished.counters.spawns, 1)
  assert.equal(finished.subtasks[0].usage.inputTokens, 10)
  assert.deepEqual(finished.steps, {})
  assert.equal((await store.read(run.id)).report, 'the raw answer')
})

test('direct mode skips the planner and aggregator the planned mode uses', async () => {
  const planned = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    if (spec.label === 'superagent-aggregate') return completed('aggregated report')
    return completed(`result for ${spec.label}`)
  })
  const plannedRun = orchestratorWith({ spawner: planned })
  const runA = await plannedRun.orchestrator.start({ goal: 'two-part job', parentSessionId: parent.id, parent })
  const finishedA = await plannedRun.orchestrator.status(runA.id, 10)
  assert.equal(finishedA.plan.mode, 'planned')
  assert.equal(finishedA.report, 'aggregated report')
  assert.ok(planned.calls.some(call => call.label === 'superagent-plan'))
  assert.ok(planned.calls.some(call => call.label === 'superagent-aggregate'))

  const direct = makeSpawner(async () => completed('one worker answered'))
  const directRun = orchestratorWith({ spawner: direct })
  const runB = await directRun.orchestrator.start({
    goal: 'two-part job',
    parentSessionId: parent.id,
    parent,
    mode: 'direct',
  })
  const finishedB = await directRun.orchestrator.status(runB.id, 10)
  assert.equal(finishedB.report, 'one worker answered')
  assert.deepEqual(direct.calls.map(call => call.label), ['superagent-direct'])
})

test('an unknown mode is refused instead of silently running planned', async () => {
  assert.throws(() => normalizeMode('quick'), /unknown mode/)
  const { spawnChild } = makeSpawner(async () => completed('x'))
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })
  await assert.rejects(
    () => orchestrator.start({ goal: 'x', parentSessionId: parent.id, parent, mode: 'quick' }),
    /unknown mode/,
  )
})

test('runs over maxActiveRuns wait in order and start as slots free', async () => {
  const firstWorker = gate()
  let spawned = 0
  let seq = 0
  const calls = []
  const spawnChild = async spec => {
    const childId = `child-${++seq}`
    calls.push({ label: spec.label, prompt: spec.prompt })
    const index = ++spawned
    return {
      childId,
      result: (async () => {
        if (index === 1) await firstWorker.opened
        return completed('done')
      })(),
      dispose: async () => {},
    }
  }
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { maxActiveRuns: 1, queueTimeoutMinutes: 30 },
  })

  const first = await orchestrator.start({
    goal: 'goal a', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => calls.length === 1, 'the first worker to start')

  const second = await orchestrator.start({
    goal: 'goal b', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })
  assert.equal(second.status, 'queued')
  assert.equal(second.queue.waiting, true)
  assert.equal(second.queue.position, 1)
  assert.equal(second.queue.of, 1)

  const third = await orchestrator.start({
    goal: 'goal c', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })
  assert.equal(third.queue.position, 2)
  assert.equal(third.queue.of, 2)

  // Nothing queued has spawned; a start that did not ask to queue still fails.
  assert.equal(calls.length, 1)
  await assert.rejects(
    () => orchestrator.start({ goal: 'goal d', parentSessionId: parent.id, parent, mode: 'direct' }),
    /quota exceeded/,
  )

  firstWorker.open()
  const finishedFirst = await orchestrator.status(first.id, 10)
  const finishedThird = await orchestrator.status(third.id, 10)
  assert.equal(finishedFirst.status, 'completed')
  assert.equal(finishedThird.status, 'completed')

  // FIFO: b was spawned before c, and both stopped being "waiting".
  assert.equal(calls.length, 3)
  assert.match(calls[1].prompt, /goal b/)
  assert.match(calls[2].prompt, /goal c/)
  const storedSecond = await orchestrator.status(second.id, 10)
  assert.equal(storedSecond.status, 'completed')
  assert.equal(storedSecond.queue.waiting, false)
})

test('a queued run fails when no slot frees before queueTimeoutMinutes', async () => {
  const timers = []
  const never = new Promise(() => {})
  const { spawnChild, calls } = makeSpawner(() => new Promise(() => never))
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { maxActiveRuns: 1, queueTimeoutMinutes: 30 },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => {
      if (timer) timer.cleared = true
    },
  })

  const first = await orchestrator.start({
    goal: 'holds the slot', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => calls.length === 1, 'the first worker to start')

  const queued = await orchestrator.start({
    goal: 'waits too long', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })
  assert.equal(queued.queue.waiting, true)
  assert.equal(timers.length, 1)
  // The timer is armed for the time left on the deadline, so a few milliseconds
  // may already have elapsed between writing the run and scheduling it.
  assert.ok(timers[0].ms <= 30 * 60000 && timers[0].ms > 30 * 60000 - 1000, `timeout was ${timers[0].ms}ms`)

  timers[0].fn()
  const expired = await orchestrator.status(queued.id, 10)
  assert.equal(expired.status, 'failed')
  assert.equal(expired.queue.expired, true)
  assert.match(expired.error, /queued for 30 minute\(s\) without a free slot/)
  assert.match(expired.error, /nothing was spent/)
  // The queued run never spawned a child.
  assert.equal(calls.length, 1)

  await orchestrator.cancel(first.id)
})

test('a timed-out queued run retries its terminal write until persistence recovers', async () => {
  const timers = []
  const store = memoryStore()
  const write = store.write
  let failTerminal = false
  store.write = async run => {
    if (failTerminal && run.status === 'failed' && run.queue?.expired) throw new Error('disk full at timeout')
    return write(run)
  }
  const { spawnChild, calls } = makeSpawner(() => new Promise(() => {}))
  const { orchestrator } = orchestratorWith({
    store,
    spawner: { spawnChild },
    config: { maxActiveRuns: 1, queueTimeoutMinutes: 30 },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => { if (timer) timer.cleared = true },
  })
  const first = await orchestrator.start({
    goal: 'holds the slot', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => calls.length === 1, 'the first worker to start')
  const queued = await orchestrator.start({
    goal: 'times out while disk is full', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })

  failTerminal = true
  timers[0].fn()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await store.read(queued.id)).status, 'queued')
  assert.equal((await store.read(queued.id)).queue.waiting, true)

  failTerminal = false
  const retry = timers.find(timer => timer.ms === 1000 && !timer.cleared)
  assert.ok(retry, 'a terminal retry must remain scheduled')
  await retry.fn()
  const expired = await orchestrator.status(queued.id, 10)
  assert.equal(expired.status, 'failed')
  assert.equal(expired.queue.expired, true)
  assert.equal(calls.length, 1)
  await orchestrator.cancel(first.id)
})

test('cancelling a queued run removes it and renumbers the runs behind it', async () => {
  const timers = []
  const firstWorker = gate()
  let spawned = 0
  let seq = 0
  const prompts = []
  const spawnChild = async spec => {
    const childId = `child-${++seq}`
    prompts.push(spec.prompt)
    const index = ++spawned
    return {
      childId,
      result: (async () => {
        if (index === 1) await firstWorker.opened
        return completed('done')
      })(),
      dispose: async () => {},
    }
  }
  const { orchestrator, store } = orchestratorWith({
    spawner: { spawnChild },
    config: { maxActiveRuns: 1, queueTimeoutMinutes: 30 },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer: timer => {
      if (timer) timer.cleared = true
    },
  })

  const first = await orchestrator.start({
    goal: 'goal a', parentSessionId: parent.id, parent, mode: 'direct',
  })
  await waitFor(() => prompts.length === 1, 'the first worker to start')

  const second = await orchestrator.start({
    goal: 'goal b', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })
  const third = await orchestrator.start({
    goal: 'goal c', parentSessionId: parent.id, parent, mode: 'direct', queue: true,
  })
  assert.equal(second.queue.position, 1)
  assert.equal(third.queue.position, 2)

  const cancelled = await orchestrator.cancel(second.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.match(cancelled.error, /cancelled before a free slot was available/)
  assert.equal(timers[0].cleared, true)
  assert.equal((await store.read(second.id)).status, 'cancelled')

  const shifted = await store.read(third.id)
  assert.equal(shifted.queue.position, 1)
  assert.equal(shifted.queue.of, 1)

  firstWorker.open()
  await orchestrator.status(first.id, 10)
  const finishedThird = await orchestrator.status(third.id, 10)
  assert.equal(finishedThird.status, 'completed')
  // The cancelled run never spawned; only a and c did.
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /goal c/)
})
