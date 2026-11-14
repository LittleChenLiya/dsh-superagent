import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { capText, computeCost, createOrchestrator, extractPlan } from '../lib/orchestrator.js'
import { ACTIVE_STATUSES, createStore } from '../lib/store.js'

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

function memoryStore({ ownerHost = null } = {}) {
  const runs = new Map()
  const cancels = new Set()
  const store = {
    runs,
    cancels,
    owner: ownerHost ? { hostname: ownerHost, createdAt: '2026-01-01T00:00:00.000Z' } : null,
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
  }
  return store
}

function completed(text) {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

function failed(reason = 'error') {
  return { output: [], stopReason: reason, diagnostic: 'child reported an error' }
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

function orchestratorWith({ store = memoryStore(), spawner, config = {}, readUsage = async () => ({ inputTokens: 10, outputTokens: 2, totalTokens: 12, modelCalls: 1, models: { 'test/model': { inputTokens: 10, outputTokens: 2, calls: 1 } } }) }) {
  const notifications = []
  const orchestrator = createOrchestrator({
    store,
    config: { ...BASE_CONFIG, ...config },
    spawnChild: spawner.spawnChild,
    readUsage,
    notify: run => notifications.push(run.id),
    log: () => {},
  })
  return { orchestrator, store, notifications }
}

const parent = { id: 'session-parent' }

test('plan is decomposed and subtasks run in parallel within the limit', async () => {
  let running = 0
  let peak = 0
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { title: 'A', prompt: 'do A' },
          { title: 'B', prompt: 'do B' },
          { title: 'C', prompt: 'do C' },
        ],
      }))
    }
    running++
    peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, 25))
    running--
    return completed(`result for ${spec.label}`)
  })
  const { orchestrator, store } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'ship three things', parentSessionId: parent.id, parent })
  assert.equal(ACTIVE_STATUSES.has(run.status), true)

  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.subtasks.length, 3)
  assert.equal(finished.plan.mode, 'planned')
  assert.ok(peak <= 3 && peak >= 2, `peak concurrency was ${peak}`)
  assert.equal(finished.usage.inputTokens, 50)
  assert.equal(finished.report, 'result for superagent-aggregate')
  assert.equal((await store.read(run.id)).status, 'completed')
})

test('a subtask that keeps failing produces a partial run after retries', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    if (spec.label === 'superagent-2') return failed('refusal')
    return completed('ok from A')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, config: { maxParallel: 2 } })

  const run = await orchestrator.start({ goal: 'half fails', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'partial')
  assert.equal(finished.subtasks[0].status, 'completed')
  assert.equal(finished.subtasks[1].status, 'failed')
  assert.equal(finished.subtasks[1].attempts, 2)
  assert.equal(calls.filter(call => call.label === 'superagent-2').length, 2)
  assert.match(finished.subtasks[1].error ?? '', /error/)
  assert.match(finished.report, /ok from A/)
})

test('an unparsable plan degrades to a single subtask', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed('I would split this into: 1) research 2) write')
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'vague goal', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.plan.mode, 'degraded')
  assert.equal(finished.subtasks.length, 1)
  assert.equal(finished.subtasks[0].prompt, 'vague goal')
})

test('cancel stops the run and keeps partial state on disk', async () => {
  const { spawnChild } = makeSpawner(async (spec, childId) => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    return new Promise((_resolve, reject) => {
      spec.signal.addEventListener('abort', () => reject(new Error(`aborted ${childId}`)), { once: true })
    })
  })
  const { orchestrator, store } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'cancel me', parentSessionId: parent.id, parent })
  await new Promise(resolve => setTimeout(resolve, 50))
  const cancelled = await orchestrator.cancel(run.id)

  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.read(run.id)).status, 'cancelled')
  assert.equal(cancelled.report, null)
})

test('a third active run is rejected by the quota', async () => {
  const release = []
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    await new Promise(resolve => release.push(resolve))
    return completed('late')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, config: { maxActiveRuns: 1 } })

  const first = await orchestrator.start({ goal: 'first', parentSessionId: parent.id, parent })
  await assert.rejects(
    () => orchestrator.start({ goal: 'second', parentSessionId: parent.id, parent }),
    /quota exceeded/,
  )
  await orchestrator.cancel(first.id)
  release.forEach(resolve => resolve())
  await new Promise(resolve => setTimeout(resolve, 20))
})

test('resume keeps completed subtasks and retries the failed one', async () => {
  let failB = true
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    if (spec.label === 'superagent-2' && failB) return failed()
    return completed(`ok ${spec.label}`)
  })
  const { orchestrator, store } = orchestratorWith({ spawner: { spawnChild }, config: { maxParallel: 2 } })

  const run = await orchestrator.start({ goal: 'resume me', parentSessionId: parent.id, parent })
  const first = await orchestrator.status(run.id, 10)
  assert.equal(first.status, 'partial')

  const attemptsOnA = first.subtasks[0].attempts
  failB = false
  await orchestrator.resume(run.id, parent)
  const second = await orchestrator.status(run.id, 10)

  assert.equal(second.status, 'completed')
  assert.equal(second.subtasks[0].attempts, attemptsOnA)
  assert.equal(second.subtasks[1].status, 'completed')
  assert.ok(second.resumedAt)
  assert.equal((await store.read(run.id)).status, 'completed')
})

test('recovery marks a run left active by a dead host as interrupted', async () => {
  const store = memoryStore()
  await store.write({
    id: '20260101T000000-dead',
    goal: 'orphan',
    status: 'running',
    parentSessionId: parent.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    limits: { maxSubtasks: 2, maxParallel: 1, deadlineMinutes: 10, attempts: 1 },
    plan: { mode: 'planned', subtasks: [{ title: 'A', prompt: 'do A' }] },
    subtasks: [{ index: 1, title: 'A', status: 'running', attempts: 1 }],
    steps: {},
    usage: null,
  })
  const { spawnChild } = makeSpawner(async () => completed('x'))
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild } })

  const recovered = await orchestrator.recover()
  assert.deepEqual(recovered, ['20260101T000000-dead'])

  const run = await store.read('20260101T000000-dead')
  assert.equal(run.status, 'interrupted')
  assert.equal(run.subtasks[0].status, 'pending')
})

test('a finished run notifies the owning session once', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    return completed('done')
  })
  const { orchestrator, notifications } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'notify', parentSessionId: parent.id, parent })
  for (let attempt = 0; attempt < 100; attempt++) {
    const stored = await orchestrator.list()
    if (stored[0] && stored[0].notify) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual(notifications, [run.id])
  const stored = (await orchestrator.list())[0]
  assert.equal(stored.notify.delivered, true)
  assert.equal(stored.notify.reason, null)
})

test('planner JSON extraction tolerates fences and prose', () => {
  const plan = extractPlan('Here you go:\n```json\n{"subtasks":[{"title":"T","prompt":"P"}]}\n```\nDone.')
  assert.deepEqual(plan, [{ title: 'T', prompt: 'P' }])
  assert.deepEqual(extractPlan('no json here'), [])
  assert.deepEqual(extractPlan('{"subtasks":[]}'), [])
})

test('capText trims to a byte budget and says so', () => {
  const capped = capText('a'.repeat(100), 10)
  assert.match(capped, /truncated: 90 bytes omitted/)
  assert.equal(capText('short', 10), 'short')
})

test('a cancel from another process stops the owning run through the marker file', async () => {
  const store = memoryStore()
  const owner = orchestratorWith({
    store,
    spawner: makeSpawner(async (spec, childId) => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      }
      return new Promise((_resolve, reject) => {
        spec.signal.addEventListener('abort', () => reject(new Error(`aborted ${childId}`)), { once: true })
      })
    }),
  }).orchestrator
  const other = orchestratorWith({
    store,
    spawner: makeSpawner(async () => completed('never used')),
  }).orchestrator

  const run = await owner.start({ goal: 'cancel across processes', parentSessionId: parent.id, parent })
  await new Promise(resolve => setTimeout(resolve, 50))

  const cancelled = await other.cancel(run.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.read(run.id)).status, 'cancelled')
  for (let attempt = 0; attempt < 50 && store.cancels.has(run.id); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(store.cancels.has(run.id), false, 'the owner should clear the marker once the run is terminal')
})

test('recovery turns a run with a pending cancel into cancelled, not interrupted', async () => {
  const store = memoryStore()
  const id = '20260101T000000-canc'
  await store.write({
    id,
    goal: 'cancel me after a crash',
    status: 'running',
    parentSessionId: parent.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    limits: { maxSubtasks: 1, maxParallel: 1, deadlineMinutes: 10, attempts: 1 },
    plan: { mode: 'planned', subtasks: [{ title: 'A', prompt: 'do A' }] },
    subtasks: [{ index: 1, title: 'A', status: 'running', attempts: 1 }],
    steps: {},
    usage: null,
  })
  await store.requestCancel(id)

  const { spawnChild } = makeSpawner(async () => completed('x'))
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild } })

  assert.deepEqual(await orchestrator.recover(), [id])
  const run = await store.read(id)
  assert.equal(run.status, 'cancelled')
  assert.equal(store.cancels.has(id), false)
})

test('the model-call budget stops new children and keeps the work that finished', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { title: 'A', prompt: 'do A' },
          { title: 'B', prompt: 'do B' },
          { title: 'C', prompt: 'do C' },
        ],
      }))
    }
    return completed(`ok ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({
    store: memoryStore(),
    spawner: { spawnChild },
    config: { maxParallel: 1, maxModelCallsPerRun: 2 },
  })

  const run = await orchestrator.start({ goal: 'stay inside the budget', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'partial')
  assert.match(finished.error ?? '', /budget reached/)
  assert.equal(finished.subtasks[0].status, 'completed')
  assert.equal(finished.subtasks[1].status, 'failed')
  assert.equal(calls.filter(call => call.label === 'superagent-2').length, 0)
  assert.equal(calls.filter(call => call.label === 'superagent-3').length, 0)
})

test('a finished run carries a cost estimate from the configured prices', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { pricing: { 'test/model': { input: 1, output: 2, currency: 'USD' } } },
  })

  const run = await orchestrator.start({ goal: 'price me', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.cost.currency, 'USD')
  assert.ok(finished.cost.total > 0)
  assert.deepEqual(finished.cost.unpriced, [])
  assert.equal(finished.cost.complete, true)
})

test('cost leaves unpriced models out of the total instead of guessing', () => {
  const usage = {
    modelCalls: 4,
    models: {
      'qwen-flash': { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 500_000, calls: 3 },
      'haoduo/gpt-6.1-sol': { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 },
    },
  }
  const cost = computeCost(usage, { 'qwen-flash': { input: 0.15, output: 1.5, cacheRead: 0.03, currency: 'CNY' } })

  assert.equal(cost.currency, 'CNY')
  assert.equal(cost.complete, false)
  assert.deepEqual(cost.unpriced, ['haoduo/gpt-6.1-sol'])
  assert.equal(Number(cost.byModel['qwen-flash'].toFixed(6)), 0.465)
  assert.equal(computeCost({ modelCalls: 1, models: { x: { inputTokens: 1, outputTokens: 1, calls: 1 } } }, {}).total, 0)
  assert.equal(computeCost(null, {}), null)
})

test('a corrupt run file is reported with the path it was moved to', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-orch-'))
  const store = createStore(dir)
  await store.init()
  await fsp.writeFile(path.join(store.runsDir, '20260101T000000-bad.json'), '{"goal":', 'utf8')

  const { spawnChild } = makeSpawner(async () => completed('x'))
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild } })

  await assert.rejects(() => orchestrator.status('20260101T000000-bad'), /not valid JSON/)
  const names = await fsp.readdir(store.runsDir)
  assert.ok(names.some(name => name.includes('.corrupt-')), names.join(','))
  await fsp.rm(dir, { recursive: true, force: true })
})

const STALE = () => new Date(Date.now() - 5 * 60 * 1000).toISOString()

function orphan(overrides = {}) {
  return {
    id: '20260101T000000-orph',
    goal: 'orphan',
    status: 'running',
    parentSessionId: parent.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    heartbeatAt: STALE(),
    ownerPid: 2147483647,
    limits: { maxSubtasks: 1, maxParallel: 1, deadlineMinutes: 10, attempts: 1 },
    plan: { mode: 'planned', subtasks: [{ title: 'A', prompt: 'do A' }] },
    subtasks: [{ index: 1, title: 'A', status: 'running', attempts: 1 }],
    steps: {},
    usage: null,
    ...overrides,
  }
}

test('a local orphan with a dead pid is reclaimed and its quota freed', async () => {
  const store = memoryStore()
  await store.write(orphan())

  const { orchestrator } = orchestratorWith({
    store,
    spawner: makeSpawner(async spec => (spec.label === 'superagent-plan'
      ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      : completed('fresh run'))),
    config: { maxActiveRuns: 1 },
  })

  const run = await orchestrator.start({ goal: 'new work', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.status, 'completed')

  const old = await store.read('20260101T000000-orph')
  assert.equal(old.status, 'interrupted')
  assert.equal(old.reclaimed.pidChecked, true)
  assert.match(old.reclaimed.basis, /pid 2147483647 is not running/)
  assert.equal(old.subtasks[0].status, 'pending')
})

test('a local run whose pid is still alive is not reclaimed', async () => {
  const store = memoryStore()
  await store.write(orphan({ ownerPid: process.pid }))

  const { orchestrator } = orchestratorWith({
    store,
    spawner: makeSpawner(async () => completed('x')),
    config: { maxActiveRuns: 1 },
  })

  await assert.rejects(
    () => orchestrator.start({ goal: 'blocked', parentSessionId: parent.id, parent }),
    /quota exceeded/,
  )
  assert.equal((await store.read('20260101T000000-orph')).status, 'running')
})

test('a run with a fresh heartbeat is not reclaimed even when its pid looks dead', async () => {
  const store = memoryStore()
  await store.write(orphan({ heartbeatAt: new Date().toISOString() }))

  const { orchestrator } = orchestratorWith({
    store,
    spawner: makeSpawner(async () => completed('x')),
    config: { maxActiveRuns: 1 },
  })

  await assert.rejects(
    () => orchestrator.start({ goal: 'blocked', parentSessionId: parent.id, parent }),
    /quota exceeded/,
  )
})

test('on a shared state directory the pid is ignored and the heartbeat decides', async () => {
  const store = memoryStore({ ownerHost: 'some-other-machine' })
  await store.write(orphan({ ownerPid: process.pid }))

  const { orchestrator } = orchestratorWith({
    store,
    spawner: makeSpawner(async spec => (spec.label === 'superagent-plan'
      ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      : completed('done'))),
    config: { maxActiveRuns: 1 },
  })

  const run = await orchestrator.start({ goal: 'new work', parentSessionId: parent.id, parent })
  await orchestrator.status(run.id, 10)

  const old = await store.read('20260101T000000-orph')
  assert.equal(old.status, 'interrupted')
  assert.equal(old.reclaimed.pidChecked, false)
  assert.match(old.reclaimed.basis, /shared with some-other-machine/)
  assert.equal(old.reclaimed.sharedWith, 'some-other-machine')
})
