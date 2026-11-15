import assert from 'node:assert/strict'
import test from 'node:test'

import { createOrchestrator } from '../lib/orchestrator.js'
import { createChildSteerer, createChildWatcher, pendingIds } from '../lib/inject.js'

const parent = { id: 'session-parent' }

const CONFIG = {
  maxSubtasks: 4,
  maxParallel: 2,
  maxActiveRuns: 1,
  attempts: 1,
  deadlineMinutes: 10,
  resultCapBytes: 4096,
  maxModelCallsPerRun: 0,
  maxTokensPerRun: 0,
}

function completed(text) {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

function memoryStore() {
  const runs = new Map()
  return {
    async init() {},
    async list() { return [...runs.values()].map(run => structuredClone(run)) },
    async read(id) { return runs.has(id) ? structuredClone(runs.get(id)) : null },
    async write(run) { runs.set(run.id, structuredClone(run)) },
    async requestCancel() { return true },
    async hasCancelRequest() { return false },
    async clearCancel() {},
    async readOwner() { return null },
    async readLock() { return null },
    async acquireLock() { return { acquired: true, holder: null } },
    async releaseLock() {},
  }
}

/**
 * One real orchestrator driven by a fake host.
 *
 * The fake host keeps a child registry so the injection watcher reads the same
 * inbox shape (`nextStep` / `nextTurn`) that the real Agent exposes.
 */
async function harness({ steerChild, claimDelayMs = 40 } = {}) {
  const store = memoryStore()
  const children = new Map()
  let release = null
  const worker = new Promise(resolve => { release = resolve })
  const spawned = []

  const spawnChild = async spec => {
    if (spec.label === 'superagent-plan') {
      spawned.push(spec.label)
      return {
        childId: 'child-plan',
        result: Promise.resolve(completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))),
        dispose: async () => {},
      }
    }
    spawned.push(spec.label)
    const childId = `child-${spawned.length}`
    const agent = { id: childId, inbox: { nextStep: [], nextTurn: [] } }
    children.set(childId, agent)
    return {
      childId,
      result: worker,
      dispose: async () => { children.delete(childId) },
    }
  }

  const defaultSteer = async ({ childId, text }) => {
    const agent = children.get(childId)
    const messageId = `m-${childId}`
    agent.inbox.nextStep.push({ id: messageId, role: 'user', content: [{ type: 'text', text }] })
    setTimeout(() => {
      agent.inbox.nextStep = agent.inbox.nextStep.filter(message => message.id !== messageId)
    }, claimDelayMs).unref?.()
    return { messageId, via: 'test.steer' }
  }

  const orchestrator = createOrchestrator({
    store,
    config: CONFIG,
    spawnChild,
    readUsage: async () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1, models: {} }),
    notify: () => {},
    log: () => {},
    steerChild: steerChild ?? defaultSteer,
    inspectChild(childId) {
      const agent = children.get(childId)
      return { live: Boolean(agent), pending: pendingIds(agent) }
    },
    watchChild: createChildWatcher({ resolveChild: childId => children.get(childId), intervalMs: 5 }),
  })
  return { orchestrator, store, children, release, spawned }
}

async function waitFor(fn, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  throw new Error('condition was not met before the test timeout')
}

async function startRunning(orchestrator) {
  const run = await orchestrator.start({ goal: 'inject into me', parentSessionId: parent.id, parent })
  return waitFor(() => {
    const live = orchestrator.liveRun(run.id)
    return live?.subtasks?.some(subtask => subtask.status === 'running' && subtask.childId) ? live : null
  })
}

test('an injected instruction is claimed at the next step and the delay is measured', async () => {
  const { orchestrator, release, children } = await harness({ claimDelayMs: 40 })
  const run = await startRunning(orchestrator)
  const childId = run.subtasks[0].childId

  const result = await orchestrator.inject(run.id, 'prefer the smaller number', parent)
  assert.equal(result.injection.targets.length, 1)
  assert.equal(result.injection.targets[0].childId, childId)
  assert.equal(result.injection.targets[0].via, 'test.steer')
  assert.equal(result.degraded, null)
  // A live injection is not a followup: the next-prompt queue must stay empty.
  assert.equal((run.followups ?? []).length, 0)

  const entry = await orchestrator.waitForInjection(result.run, result.injection, 2)
  assert.equal(entry.targets[0].status, 'applied')
  assert.equal(typeof entry.targets[0].latencyMs, 'number')
  assert.ok(entry.targets[0].latencyMs >= 20, `measured ${entry.targets[0].latencyMs} ms`)
  assert.equal(result.run.injectionStats.applied, 1)
  assert.equal(result.run.injectionStats.worstLatencyMs, entry.targets[0].latencyMs)
  assert.equal(children.get(childId).inbox.nextStep.length, 0)

  release(completed('done'))
  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.status, 'completed')
  // The receipt survives settle and still reads as applied, not "never seen".
  assert.equal(finished.injections[0].targets[0].status, 'applied')
})

test('a message the child never claims is reported as missed, not delivered', async () => {
  const { orchestrator, release } = await harness({
    claimDelayMs: 60_000,
    // The fake inbox never drops the message, so only the settle path can
    // decide the outcome.
  })
  const run = await startRunning(orchestrator)

  const result = await orchestrator.inject(run.id, 'too late to matter', parent)
  assert.equal(result.injection.targets[0].status, 'pending')

  // The worker finishes before any next step boundary.
  release(completed('finished without another step'))
  const finished = await orchestrator.status(run.id, 10)
  const target = finished.injections[0].targets[0]
  assert.equal(target.status, 'missed')
  assert.match(target.missedReason, /step boundary/)
  assert.equal(finished.injectionStats.missed, 1)
  assert.equal(finished.injectionStats.applied, 0)
})

test('a host without a live channel degrades to the next-prompt queue and says so', async () => {
  const unsupported = async () => {
    const error = new Error(
      'this host exposes no live channel into a running child: neither subagents.sendMessage nor Agent.steer exists',
    )
    error.code = 'inject-unsupported'
    throw error
  }
  const { orchestrator, release } = await harness({ steerChild: unsupported })
  const run = await startRunning(orchestrator)

  const result = await orchestrator.inject(run.id, 'apply this at the next prompt', parent)
  assert.ok(result.degraded, 'the reply must carry the degraded path')
  assert.equal(result.injection.status, 'degraded')
  assert.equal(result.injection.followupId, result.degraded.followup.id)
  assert.equal(result.injection.targets[0].status, 'failed')
  assert.match(result.injection.targets[0].error, /no live channel/)
  // The instruction is not lost: it sits on the followup queue, which is the
  // pre-existing next-prompt semantics and is not changed by this feature.
  assert.equal(result.run.followups.length, 1)
  assert.equal(result.run.followups[0].text, 'apply this at the next prompt')
  assert.notEqual(result.degraded.effect.boundary, 'none')

  release(completed('done'))
  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.injections[0].status, 'degraded')
  assert.equal(finished.followups[0].appliedAtStage, 'aggregator')
})

test('the steerer prefers the documented service call and falls back to Agent.steer', async () => {
  const sent = []
  const service = {
    async sendMessage(sender, childId, content, options) {
      sent.push({ sender, childId, text: content[0].text, hasSignal: Boolean(options?.signal) })
      return 'message-from-service'
    },
  }
  const agent = { id: 'child-1', inbox: { nextStep: [], nextTurn: [] } }
  const registry = { get: id => (id === 'child-1' ? agent : undefined) }

  const viaService = createChildSteerer({ getSubagents: () => service, getAgents: () => registry })
  const receipt = await viaService({ parent, childId: 'child-1', text: 'hello' })
  assert.deepEqual(receipt, { messageId: 'message-from-service', via: 'subagents.sendMessage' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].hasSignal, true, 'an absent caller signal still gets a usable AbortSignal')

  const steered = []
  agent.steer = message => steered.push(message)
  const viaAgent = createChildSteerer({ getSubagents: () => ({}), getAgents: () => registry })
  const fallback = await viaAgent({ parent, childId: 'child-1', text: 'fallback' })
  assert.equal(fallback.via, 'agent.steer')
  assert.equal(steered.length, 1)
  assert.equal(steered[0].role, 'user')
  assert.equal(steered[0].content[0].text, 'fallback')

  const nowhere = createChildSteerer({ getSubagents: () => ({}), getAgents: () => ({ get: () => ({ id: 'child-2' }) }) })
  await assert.rejects(
    nowhere({ parent, childId: 'child-2', text: 'nowhere' }),
    error => error.code === 'inject-unsupported',
  )
})

test('a child that is already gone is refused instead of reported as delivered', async () => {
  const { orchestrator } = await harness()
  const run = await startRunning(orchestrator)
  const result = await orchestrator.inject(run.id, 'first', parent)
  assert.equal(result.injection.targets[0].status, 'pending')
  await assert.rejects(
    createChildSteerer({ getSubagents: () => ({}), getAgents: () => ({ get: () => undefined }) })({
      parent,
      childId: 'absent',
      text: 'x',
    }),
    error => error.code === 'inject-child-gone',
  )
})
