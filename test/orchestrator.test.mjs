import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import {
  capabilityGaps,
  capText,
  computeCost,
  createOrchestrator,
  dedupeKeyOf,
  extractAttentionBlock,
  extractPlan,
  linkSubtasks,
  mentionedWriteRoots,
  normalizeGoal,
} from '../lib/orchestrator.js'
import { createMemory } from '../lib/memory.js'
import { ACTIVE_STATUSES, createStore } from '../lib/store.js'

const execFileAsync = promisify(execFile)

test('only absolute paths from the request become extra write roots', () => {
  const roots = mentionedWriteRoots({
    goal: '我的塔防（D:\\PrismDefense）游戏空格键不好用。再看看 `https://github.com/trpc/trpc` 和 D:/Work/Other。',
    followups: [{ text: '报告放到 E:\\Reports 下' }],
  })
  assert.deepEqual(roots.sort(), ['D:\\PrismDefense', 'D:\\Work\\Other', 'E:\\Reports'].sort())
  assert.deepEqual(mentionedWriteRoots({ goal: '没有路径' }), [])
})

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
  const locks = new Map()
  const store = {
    runs,
    cancels,
    locks,
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

function failed(reason = 'error') {
  return { output: [], stopReason: reason, diagnostic: 'child reported an error' }
}

function makeSpawner(handle) {
  let seq = 0
  const calls = []
  const spawnChild = async spec => {
    const childId = `child-${++seq}`
    calls.push({ label: spec.label, prompt: spec.prompt, childId, model: spec.model ?? null, cwd: spec.cwd ?? null })
    return {
      childId,
      result: Promise.resolve().then(() => handle(spec, childId)),
      dispose: async () => {},
    }
  }
  return { spawnChild, calls }
}

function orchestratorWith({
  store = memoryStore(),
  spawner,
  config = {},
  memory = null,
  workspace = null,
  readUsage = async () => ({
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    modelCalls: 1,
    models: { 'test/model': { inputTokens: 10, outputTokens: 2, calls: 1 } },
  }),
  sleep,
  toolInventory,
  takeHumanHandoff,
  cwd,
}) {
  const notifications = []
  const orchestrator = createOrchestrator({
    store,
    config: { ...BASE_CONFIG, ...config },
    spawnChild: spawner.spawnChild,
    readUsage,
    memory,
    ...(workspace ? { workspace } : {}),
    ...(toolInventory ? { toolInventory } : {}),
    takeHumanHandoff,
    ...(cwd ? { cwd } : {}),
    notify: run => notifications.push(run.id),
    log: () => {},
    ...(sleep ? { sleep } : {}),
  })
  return { orchestrator, store, notifications }
}

const parent = { id: 'session-parent' }

/** Resolve on the first worker spawn, so a test can act without sleeping. */
function gate() {
  let open
  const opened = new Promise(resolve => { open = resolve })
  return { opened, open }
}

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

test('four independent subtasks run at once when the cap allows it', async () => {
  let running = 0
  let peak = 0
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { title: 'A', prompt: 'do A' },
          { title: 'B', prompt: 'do B' },
          { title: 'C', prompt: 'do C' },
          { title: 'D', prompt: 'do D' },
        ],
      }))
    }
    running++
    peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, 25))
    running--
    return completed(`result for ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, config: { maxParallel: 4 } })

  const run = await orchestrator.start({ goal: 'ship four things', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.status, 'completed')
  assert.equal(peak, 4, `peak concurrency was ${peak}`)
})

test('subtasks that declare the same file are never in flight at the same time', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-clash-'))
  try {
    const plan = JSON.stringify({
      subtasks: [
        { title: 'first', prompt: 'write shared.txt', deliverables: [{ path: 'shared.txt' }] },
        { title: 'second', prompt: 'write shared.txt', deliverables: [{ path: 'shared.txt' }] },
      ],
    })
    let active = 0
    let overlapped = false
    const { spawnChild } = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') return completed(plan)
      if (spec.label === 'superagent-aggregate') return completed('merged')
      active++
      if (active > 1) overlapped = true
      await new Promise(resolve => setTimeout(resolve, 25))
      await fsp.writeFile(path.join(root, 'shared.txt'), `${spec.label}\n`, 'utf8')
      active--
      return completed(`wrote for ${spec.label}`)
    })
    const { orchestrator } = orchestratorWith({
      spawner: { spawnChild },
      config: { attempts: 1, maxParallel: 4, workspaceRoot: root },
    })

    const run = await orchestrator.start({ goal: 'write shared.txt twice', parentSessionId: parent.id, parent })
    const finished = await orchestrator.status(run.id, 10)
    assert.equal(finished.status, 'completed')
    assert.equal(overlapped, false, 'two workers wrote the same file at once')
    assert.deepEqual(finished.subtasks.map(item => item.status), ['completed', 'completed'])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a subtask waits for the subtask it depends on', async () => {
  const events = []
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'collect', prompt: 'collect the data' },
          { id: 'w2', title: 'analyse', prompt: 'analyse the data', dependsOn: ['w1'] },
        ],
      }))
    }
    events.push(`${spec.label}:start`)
    await new Promise(resolve => setTimeout(resolve, 20))
    events.push(`${spec.label}:end`)
    return completed(`report from ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'serial pair', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.ok(events.indexOf('superagent-1:end') < events.indexOf('superagent-2:start'), events.join(' '))
  assert.deepEqual(finished.subtasks.map(subtask => subtask.key), ['w1', 'w2'])
  assert.deepEqual(finished.subtasks[1].dependsOn, ['w1'])
  // The dependent worker gets the finished report it was told to build on.
  const second = calls.find(call => call.label === 'superagent-2')
  assert.match(second.prompt, /report from superagent-1/)
})

test('a diamond dependency waits for every predecessor and still parallelises the middle', async () => {
  const events = []
  let middleRunning = 0
  let middlePeak = 0
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'root', prompt: 'root work' },
          { id: 'w2', title: 'left', prompt: 'left work', dependsOn: ['w1'] },
          { id: 'w3', title: 'right', prompt: 'right work', dependsOn: ['w1'] },
          { id: 'w4', title: 'join', prompt: 'join work', dependsOn: ['w2', 'w3'] },
        ],
      }))
    }
    events.push(`${spec.label}:start`)
    if (spec.label === 'superagent-2' || spec.label === 'superagent-3') {
      middleRunning++
      middlePeak = Math.max(middlePeak, middleRunning)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    if (spec.label === 'superagent-2' || spec.label === 'superagent-3') middleRunning--
    events.push(`${spec.label}:end`)
    return completed(`report from ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, config: { maxParallel: 3 } })

  const run = await orchestrator.start({ goal: 'diamond', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(middlePeak, 2, 'the two middle subtasks must overlap')
  assert.ok(events.indexOf('superagent-1:end') < events.indexOf('superagent-2:start'), events.join(' '))
  assert.ok(events.indexOf('superagent-1:end') < events.indexOf('superagent-3:start'), events.join(' '))
  assert.ok(events.indexOf('superagent-2:end') < events.indexOf('superagent-4:start'), events.join(' '))
  assert.ok(events.indexOf('superagent-3:end') < events.indexOf('superagent-4:start'), events.join(' '))
})

test('a dependency cycle rejects the plan and names the tasks involved', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'A', prompt: 'do A', dependsOn: ['w2'] },
          { id: 'w2', title: 'B', prompt: 'do B', dependsOn: ['w1'] },
        ],
      }))
    }
    return completed('should never run')
  })
  const { orchestrator, store } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'cyclic plan', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.match(finished.error, /dependency cycle/)
  assert.match(finished.error, /w1/)
  assert.match(finished.error, /w2/)
  assert.equal(calls.filter(call => call.label !== 'superagent-plan' && call.label !== 'superagent-aggregate').length, 0)
  assert.equal((await store.read(run.id)).status, 'failed')
})

test('a subtask whose dependency failed is skipped, not reported as done', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'first', prompt: 'do first' },
          { id: 'w2', title: 'broken', prompt: 'do broken', dependsOn: ['w1'] },
          { id: 'w3', title: 'after broken', prompt: 'do after', dependsOn: ['w2'] },
          { id: 'w4', title: 'independent', prompt: 'do independent work' },
        ],
      }))
    }
    if (spec.label === 'superagent-2') return failed('refusal')
    return completed(`ok ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, config: { maxParallel: 2 } })

  const run = await orchestrator.start({ goal: 'propagate failure', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'partial')
  assert.equal(finished.subtasks[1].status, 'failed')
  assert.equal(finished.subtasks[2].status, 'skipped')
  assert.match(finished.subtasks[2].skippedReason, /w2/)
  assert.equal(finished.subtasks[3].status, 'completed')
  assert.equal(calls.filter(call => call.label === 'superagent-3').length, 0)
  assert.equal(calls.filter(call => call.label === 'superagent-4').length, 1)
  // The aggregator must be told what never arrived, so the report can say so.
  const aggregate = calls.find(call => call.label === 'superagent-aggregate')
  assert.match(aggregate.prompt, /Subtasks that delivered no report/)
  assert.match(aggregate.prompt, /after broken: skipped/)
})

test('a dependency on a subtask the plan never declared is skipped with the reason', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'A', prompt: 'do A', dependsOn: ['w9'] },
          { id: 'w2', title: 'B', prompt: 'do B' },
        ],
      }))
    }
    return completed(`ok ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'missing dependency', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.subtasks[0].status, 'skipped')
  assert.match(finished.subtasks[0].skippedReason, /unknown subtask "w9"/)
  assert.equal(finished.subtasks[1].status, 'completed')
  assert.equal(calls.filter(call => call.label === 'superagent-1').length, 0)
  assert.equal(finished.status, 'partial')
})

test('a subtask held back by a dependency is reported as waiting, not running', async () => {
  const started = gate()
  const release = gate()
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'slow', prompt: 'do slow work' },
          { id: 'w2', title: 'after', prompt: 'do later work', dependsOn: ['w1'] },
        ],
      }))
    }
    if (spec.label === 'superagent-1') {
      started.open()
      await release.opened
      return completed('slow done')
    }
    return completed('later done')
  })
  const { orchestrator, store } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'observe waiting', parentSessionId: parent.id, parent })
  await started.opened
  let live = await store.read(run.id)
  for (let attempt = 0; attempt < 40 && live?.subtasks?.[1]?.status !== 'waiting'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    live = await store.read(run.id)
  }

  assert.equal(live.subtasks[0].status, 'running')
  assert.equal(live.subtasks[1].status, 'waiting')
  assert.deepEqual(live.subtasks[1].waitingOn, ['w1'])

  release.open()
  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.status, 'completed')
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

test('an unusable planner reply fails the run instead of degrading to one worker', async () => {
  const prose = 'I would split this into: 1) research 2) write'
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed(prose)
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'vague goal', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(finished.plan.mode, 'invalid')
  assert.equal(finished.subtasks.length, 0)
  assert.match(finished.error ?? '', /no worker was started/)
  assert.match(finished.report ?? '', /No worker was started/)
  // One repair round, then stop: no fallback "complete the goal" child.
  const plannerCalls = calls.filter(call => call.label === 'superagent-plan')
  assert.equal(plannerCalls.length, 2)
  assert.match(plannerCalls[1].prompt, /^## Repair round/m)
  assert.ok(plannerCalls[1].prompt.includes('I would split this into'))
  assert.equal(calls.filter(call => call.label !== 'superagent-plan').length, 0)
})

test('a planner that never returns is stopped instead of burning the run budget', async () => {
  let disposed = 0
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return new Promise(() => {})
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    spawner: {
      spawnChild: async spec => {
        const handle = await spawnChild(spec)
        return { ...handle, dispose: async () => { disposed++; await handle.dispose() } }
      },
    },
    config: { plannerTimeoutSeconds: 0.05 },
  })

  const run = await orchestrator.start({ goal: 'slow planner', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 30)

  assert.equal(finished.status, 'failed')
  assert.equal(finished.plan.mode, 'invalid')
  assert.match(finished.error ?? '', /no worker was started/)
  assert.equal(calls.filter(call => call.label === 'superagent-plan').length, 2)
  assert.equal(calls.filter(call => call.label !== 'superagent-plan').length, 0)
  assert.ok(disposed >= 1)
})

test('the planner gets the configured preset and model route while workers keep the default', async () => {
  const specs = []
  const { spawnChild } = makeSpawner(async spec => {
    specs.push(spec)
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { plannerPreset: 'planner', plannerProvider: 'strong', plannerModel: 'big-model' },
  })

  const run = await orchestrator.start({ goal: 'plan without tools', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  const planner = specs.find(spec => spec.label === 'superagent-plan')
  const worker = specs.find(spec => spec.label !== 'superagent-plan')
  assert.equal(planner.preset, 'planner')
  assert.equal(planner.provider, 'strong')
  assert.equal(planner.model, 'big-model')
  assert.equal(worker.preset, undefined)
  assert.ok(!worker.provider)
  assert.ok(!worker.model)
})

test('a planner that spends its call budget is stopped and reported as unplannable', async () => {
  let disposed = 0
  let reads = 0
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return new Promise(() => {})
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    spawner: {
      spawnChild: async spec => {
        const handle = await spawnChild(spec)
        return { ...handle, dispose: async () => { disposed++; await handle.dispose() } }
      },
    },
    readUsage: async () => {
      reads++
      return { inputTokens: 30, outputTokens: 10, totalTokens: 40, modelCalls: 5 + reads }
    },
    config: { plannerMaxModelCalls: 4 },
  })

  const run = await orchestrator.start({ goal: 'loop forever', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 30)

  assert.equal(finished.status, 'failed')
  assert.equal(finished.plan.mode, 'invalid')
  assert.match(finished.plan.invalidReason ?? '', /model-call budget/)
  assert.match(finished.error ?? '', /model-call budget/)
  assert.equal(finished.subtasks.length, 0)
  // The first attempt exhausts the shared budget, so no repair round is started.
  assert.equal(finished.steps.planner.attempts.length, 1)
  assert.equal(finished.steps.planner.attempts[0].outcome, 'planner-budget')
  assert.ok(disposed >= 1)
})

test('each planner attempt records its elapsed time, calls, and tokens', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'record planner cost', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  const [attempt] = finished.steps.planner.attempts
  assert.equal(attempt.attempt, 1)
  assert.equal(attempt.outcome, 'planned')
  assert.equal(attempt.modelCalls, 1)
  assert.equal(attempt.tokens, 12)
  assert.equal(typeof attempt.ms, 'number')
  assert.ok(attempt.ms >= 0)
})

test('a plan wrapped in an envelope is not mistaken for an unusable reply', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ plan: { subtasks: [{ title: 'A', prompt: 'do A' }] } }))
    }
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'enveloped plan', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.plan.mode, 'planned')
  assert.equal(finished.subtasks.length, 1)
  assert.equal(calls.filter(call => call.label === 'superagent-plan').length, 1)
})

test('a reply truncated after a complete subtasks array is salvaged', async () => {
  const reply = '{"subtasks":[{"title":"A","prompt":"do A"}],"needsInput":[{"question":"trunc'
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed(reply)
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'truncated plan', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.plan.mode, 'planned')
  assert.equal(finished.plan.repaired, 'salvaged-subtasks')
  assert.equal(finished.subtasks.length, 1)
})

async function workspaceDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-deliverable-'))
}

function planWith(deliverable) {
  return JSON.stringify({
    subtasks: [{
      id: 'w1',
      title: 'Produce the artifact',
      prompt: 'write it',
      requires: [],
      ...(deliverable ? { deliverables: [deliverable] } : {}),
    }],
  })
}

test('a declared deliverable that was never written fails the subtask', async () => {
  const cwd = await workspaceDir()
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'reports/summary.md', kind: 'text' }))
    }
    return completed('I wrote the report.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

  const run = await orchestrator.start({ goal: 'write a report', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(finished.subtasks[0].status, 'failed')
  assert.equal(finished.subtasks[0].deliverableCheck.failed, 1)
  assert.match(finished.subtasks[0].error ?? '', /is missing/)
})

test('a 228-byte placeholder PNG is failed, not completed', async () => {
  const cwd = await workspaceDir()
  const fake = Buffer.alloc(228, 0)
  fake.writeUInt32BE(0x89504e47, 0, 'be')
  fake.writeUInt32BE(0x0d0a1a0a, 4, 'be')
  fake.write('IHDR', 12, 'latin1')
  fake.writeUInt32BE(1, 16, 'be')
  fake.writeUInt32BE(1, 20, 'be')
  await fsp.writeFile(path.join(cwd, 'shot.png'), fake)

  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'shot.png', kind: 'image' }))
    }
    return completed('Screenshot taken.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

  const run = await orchestrator.start({ goal: 'take a screenshot', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(finished.subtasks[0].status, 'failed')
  assert.equal(finished.subtasks[0].deliverables[0].code, 'placeholder')
  assert.match(finished.subtasks[0].error ?? '', /1x1 placeholder/)
})

test('an image deliverable that is text fails on type', async () => {
  const cwd = await workspaceDir()
  await fsp.writeFile(path.join(cwd, 'shot.png'), 'not an image at all')
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'shot.png', kind: 'image' }))
    }
    return completed('Screenshot taken.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

  const run = await orchestrator.start({ goal: 'take a screenshot', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.subtasks[0].status, 'failed')
  assert.equal(finished.subtasks[0].deliverables[0].code, 'type')
  assert.match(finished.subtasks[0].error ?? '', /not a PNG/)
})

test('a real text deliverable is verified and the subtask completes', async () => {
  const cwd = await workspaceDir()
  await fsp.writeFile(path.join(cwd, 'summary.md'), '# Summary\n\nAll three items are done.\n')
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'summary.md', kind: 'report' }))
    }
    return completed('Wrote summary.md.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

  const run = await orchestrator.start({ goal: 'write a summary', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.subtasks[0].status, 'completed')
  assert.equal(finished.subtasks[0].deliverableCheck.verified, 1)
  assert.equal(finished.subtasks[0].deliverables[0].status, 'verified')
})

test('a deliverable is found however its path is written', async () => {
  const cwd = await workspaceDir()
  await fsp.mkdir(path.join(cwd, 'docs'), { recursive: true })
  const target = path.join(cwd, 'docs', 'SMOKE.md')
  await fsp.writeFile(target, '# Smoke\n\nThe file is there.\n')
  const variants = [
    path.join('docs', 'SMOKE.md'),
    'docs/SMOKE.md',
    target,
  ]
  if (process.platform === 'win32') {
    // Both spellings are the same file on Windows: separator and case.
    variants.push('docs\\SMOKE.md', target.toUpperCase())
  }

  for (const declared of variants) {
    const { spawnChild } = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(planWith({ path: declared, kind: 'text' }))
      }
      return completed('Wrote the smoke note.')
    })
    const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

    const run = await orchestrator.start({ goal: 'write a smoke note', parentSessionId: parent.id, parent })
    const finished = await orchestrator.status(run.id, 10)

    assert.equal(finished.status, 'completed', `declared as ${declared}`)
    assert.equal(finished.subtasks[0].deliverables[0].status, 'verified', `declared as ${declared}`)
  }
})

test('a deliverable that lands during the grace window is verified, not missing', async () => {
  const cwd = await workspaceDir()
  const target = path.join(cwd, 'late.md')
  const delays = []
  let landed = false
  // The stat runs first and fails; the write lands on the re-check sleep, the
  // shape of a worker whose file was not yet visible to this process.
  const sleep = async ms => {
    delays.push(ms)
    if (ms <= 200 && !landed) {
      landed = true
      await fsp.writeFile(target, '# Late\n\nVisible a moment later.\n')
      return
    }
    // Real timers keep other waits yielding, so an injected sleep cannot starve
    // the run's own file I/O.
    await new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  }
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'late.md', kind: 'text' }))
    }
    return completed('Wrote late.md.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd, sleep })

  const run = await orchestrator.start({ goal: 'write a note', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.ok(delays.some(ms => ms <= 200), 'the check must re-read before calling the file missing')
  assert.equal(finished.status, 'completed')
  assert.equal(finished.subtasks[0].deliverables[0].status, 'verified')
})

test('a deliverable that never appears is still missing after the grace window', async () => {
  const cwd = await workspaceDir()
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'absent.md', kind: 'text' }))
    }
    return completed('I wrote absent.md.')
  })
  // A real but tiny timer keeps the window short; a synchronous no-op would
  // starve the run's own I/O instead of exercising the re-checks.
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    cwd,
    sleep: async ms => {
      await new Promise(resolve => setTimeout(resolve, Math.min(ms, 2)))
    },
  })

  const run = await orchestrator.start({ goal: 'write a note', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(finished.subtasks[0].status, 'failed')
  assert.equal(finished.subtasks[0].deliverableCheck.failed, 1)
  assert.equal(finished.subtasks[0].deliverables[0].code, 'missing')
  assert.match(finished.subtasks[0].error ?? '', /is missing/)
})

test('a goal-mode deliverable is checked in the goal directory, not the host directory', async () => {
  const hostCwd = await workspaceDir()
  const goalCwd = await workspaceDir()
  await fsp.mkdir(path.join(goalCwd, 'docs'), { recursive: true })
  await fsp.writeFile(path.join(goalCwd, 'docs', 'SMOKE-LONGGOAL.md'), '# Smoke\n\n18 bytes-ish.\n')
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'docs/SMOKE-LONGGOAL.md', kind: 'text' }))
    }
    return completed('Wrote the smoke note.')
  })
  // The host directory and the goal workspace differ, which is the shape the
  // long-goal phase hit: the worker wrote into the goal workspace while the
  // check read the host's launch directory.
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd: hostCwd })

  const run = await orchestrator.start({
    goal: 'write the smoke note',
    parentSessionId: parent.id,
    parent,
    goalMode: {
      cwd: goalCwd,
      maxRounds: 1,
      acceptance: [{ text: 'the smoke note exists', check: { type: 'file', path: 'docs/SMOKE-LONGGOAL.md' } }],
    },
  })
  const finished = await orchestrator.status(run.id, 15)

  // Nothing was written under the host directory, so "verified" can only come
  // from resolving the declaration against the goal workspace.
  await assert.rejects(fsp.stat(path.join(hostCwd, 'docs', 'SMOKE-LONGGOAL.md')))
  assert.equal(finished.subtasks[0].deliverables[0].status, 'verified')
  assert.equal(finished.subtasks[0].deliverableCheck.verified, 1)
  assert.equal(finished.status, 'completed')
})


test('a subtask that declares no deliverable still completes without writing files', async () => {
  const cwd = await workspaceDir()
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed(planWith(null))
    return completed('Findings only, no files.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

  const run = await orchestrator.start({ goal: 'inspect the repo', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.subtasks[0].status, 'completed')
  assert.equal(finished.subtasks[0].deliverableCheck, null)
})

test('an unjudgeable deliverable kind is unverified, never completed', async () => {
  const cwd = await workspaceDir()
  await fsp.writeFile(path.join(cwd, 'blob.bin'), Buffer.from([1, 2, 3, 4]))
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(planWith({ path: 'blob.bin', kind: 'custom-binary' }))
    }
    return completed('Wrote blob.bin.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

  const run = await orchestrator.start({ goal: 'produce a binary', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(finished.subtasks[0].status, 'unverified')
  assert.equal(finished.subtasks[0].deliverableCheck.unverified, 1)
  assert.match(finished.subtasks[0].unverifiedReason ?? '', /cannot check a deliverable of kind/)
})

test('cancel stops the run and keeps partial state on disk', async () => {
  const started = gate()
  const { spawnChild } = makeSpawner(async (spec, childId) => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    started.open()
    return new Promise((_resolve, reject) => {
      spec.signal.addEventListener('abort', () => reject(new Error(`aborted ${childId}`)), { once: true })
    })
  })
  const { orchestrator, store } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'cancel me', parentSessionId: parent.id, parent })
  await started.opened
  const cancelled = await orchestrator.cancel(run.id)

  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.read(run.id)).status, 'cancelled')
  assert.equal(cancelled.report, null)
})

test('cancel returns promptly even when a child ignores its abort signal', async () => {
  const started = gate()
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    started.open()
    // Neither the result nor dispose ever settles: this is the child that used
    // to hang cancel() forever.
    return new Promise(() => {})
  })
  const stubborn = {
    spawnChild: async spec => {
      const handle = await spawnChild(spec)
      return { ...handle, dispose: () => new Promise(() => {}) }
    },
    calls: [],
  }
  const { orchestrator, store } = orchestratorWith({ spawner: stubborn })

  const run = await orchestrator.start({ goal: 'stubborn child', parentSessionId: parent.id, parent })
  await started.opened
  const began = Date.now()
  const cancelled = await orchestrator.cancel(run.id)
  const elapsed = Date.now() - began

  assert.ok(elapsed < 6000, `cancel took ${elapsed}ms`)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.read(run.id)).status, 'cancelled')
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
})

test('an invalid maxActiveRuns falls back instead of removing the quota', async () => {
  const release = []
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    await new Promise(resolve => release.push(resolve))
    return completed('late')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, config: { maxActiveRuns: 'abc' } })

  const first = await orchestrator.start({ goal: 'first', parentSessionId: parent.id, parent })
  await assert.rejects(
    () => orchestrator.start({ goal: 'second', parentSessionId: parent.id, parent }),
    /quota exceeded/,
  )
  await orchestrator.cancel(first.id)
  release.forEach(resolve => resolve())
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

test('two concurrent resumes schedule the run only once', async () => {
  const store = memoryStore()
  await store.write(interruptedRun())
  const { spawnChild, calls } = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : completed('resumed')))
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild } })

  const results = await Promise.allSettled([
    orchestrator.resume('20260101T000000-res1', parent),
    orchestrator.resume('20260101T000000-res1', parent),
  ])

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.match(String(rejected.reason), /still active in this process/)
  await orchestrator.idle()
  assert.equal(calls.filter(call => call.label === 'superagent-1').length, 1)
  assert.equal((await store.read('20260101T000000-res1')).status, 'completed')
})

test('two orchestrators sharing one state directory cannot resume the same run twice', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-lock-'))
  try {
    const first = createStore(dir)
    await first.init()
    await first.write(interruptedRun())
    const release = []
    const workerStarted = gate()
    const spawnerFor = tag => makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      }
      workerStarted.open()
      await new Promise(resolve => release.push(resolve))
      return completed(`done by ${tag}`)
    })
    const a = orchestratorWith({ store: first, spawner: spawnerFor('a') }).orchestrator
    const b = orchestratorWith({ store: createStore(dir), spawner: spawnerFor('b') }).orchestrator

    const results = await Promise.allSettled([
      a.resume('20260101T000000-res1', parent),
      b.resume('20260101T000000-res1', parent),
    ])

    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.match(String(rejected.reason), /already being started by|still owned by a live process/)
    await workerStarted.opened
    release.forEach(resolve => resolve())
    await a.idle()
    await b.idle()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a lock left by a host that never released it is reclaimed once it is old', async () => {
  const store = memoryStore()
  await store.write(interruptedRun())
  store.locks.set('20260101T000000-res1', {
    pid: 4242,
    hostname: 'another-machine',
    at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  })
  const { spawnChild } = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : completed('resumed')))
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild } })

  await orchestrator.resume('20260101T000000-res1', parent)
  await orchestrator.idle()

  assert.equal((await store.read('20260101T000000-res1')).status, 'completed')
})

test('resume rebuilds the limits from the current config', async () => {
  const store = memoryStore()
  await store.write(interruptedRun({
    limits: { maxSubtasks: 4, maxParallel: 1, deadlineMinutes: 10, attempts: 1, maxModelCalls: 1, maxTokens: 0 },
  }))
  const { spawnChild } = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : completed('resumed')))
  // The old cap of 1 call would block the planner immediately; the current
  // config allows three, which is exactly enough for plan + worker.
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild }, config: { maxModelCallsPerRun: 3 } })

  const resumed = await orchestrator.resume('20260101T000000-res1', parent)
  assert.equal(resumed.limits.maxModelCalls, 3)
  const finished = await orchestrator.status('20260101T000000-res1', 10)
  assert.equal(finished.status, 'completed')
})

test('a resume keeps everything already spent against the budget', async () => {
  const store = memoryStore()
  await store.write(interruptedRun({
    counters: { spawns: 2, unreadable: {} },
    limits: { maxSubtasks: 4, maxParallel: 1, deadlineMinutes: 10, attempts: 1, maxModelCalls: 2, maxTokens: 0 },
  }))
  const { spawnChild, calls } = makeSpawner(async () => completed('should not run'))
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild }, config: { maxModelCallsPerRun: 2 } })

  await orchestrator.resume('20260101T000000-res1', parent)
  const finished = await orchestrator.status('20260101T000000-res1', 10)

  assert.equal(finished.status, 'failed')
  assert.match(finished.error ?? '', /budget reached/)
  assert.equal(calls.length, 0, 'spent calls are not reset by a resume')
})

test('a run still owned by another live process cannot be resumed here', async () => {
  const store = memoryStore()
  const release = []
  const owner = orchestratorWith({
    store,
    spawner: {
      spawnChild: async spec => {
        if (spec.label === 'superagent-plan') {
          return { childId: `plan-${Math.random()}`, result: Promise.resolve(completed('{"subtasks":[{"title":"A","prompt":"do A"}]}')), dispose: async () => {} }
        }
        await new Promise(resolve => release.push(resolve))
        return { childId: `work-${release.length}`, result: Promise.resolve(completed('late')), dispose: async () => {} }
      },
    },
  }).orchestrator
  const other = orchestratorWith({ store, spawner: makeSpawner(async () => completed('never')) }).orchestrator

  const run = await owner.start({ goal: 'owned elsewhere', parentSessionId: parent.id, parent })
  await assert.rejects(
    () => other.resume(run.id, parent),
    /still owned by a live process/,
  )
  assert.equal(ACTIVE_STATUSES.has((await store.read(run.id)).status), true)

  await owner.cancel(run.id)
  release.forEach(resolve => resolve())
})

test('resume is let through even when the active-run quota is full', async () => {
  const store = memoryStore()
  await store.write(interruptedRun())
  const release = []
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    await new Promise(resolve => release.push(resolve))
    return completed('late')
  })
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild }, config: { maxActiveRuns: 1 } })

  const active = await orchestrator.start({ goal: 'occupy the quota', parentSessionId: parent.id, parent })
  // maxActiveRuns is 1 and already used. A resume only finishes work that
  // already exists, so a person's resume is never refused; `force` is still
  // accepted but does not change the outcome either way.
  const resumed = await orchestrator.resume('20260101T000000-res1', parent, null, { force: false })
  assert.equal(resumed.id, '20260101T000000-res1')
  assert.equal(ACTIVE_STATUSES.has(resumed.status), true)
  await orchestrator.cancel(active.id)
  await orchestrator.cancel(resumed.id)
  release.forEach(resolve => resolve())
})

test('a run can only be resumed by the session that started it', async () => {
  const store = memoryStore()
  await store.write(interruptedRun({ parentSessionId: 'session-original' }))
  const { orchestrator } = orchestratorWith({
    store,
    spawner: makeSpawner(async () => completed('never')),
  })

  await assert.rejects(
    () => orchestrator.resume('20260101T000000-res1', parent),
    /belongs to session session-original/,
  )
  assert.equal(ACTIVE_STATUSES.has((await store.read('20260101T000000-res1')).status), false)
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

test('recovery leaves a run alone while its owner is still alive', async () => {
  const store = memoryStore()
  // Stale heartbeat, live pid: a wedged process may still resume, so the run
  // must not be rewritten under it.
  await store.write(orphan({ ownerPid: process.pid }))
  await store.requestCancel('20260101T000000-orph')
  const { orchestrator } = orchestratorWith({ store, spawner: makeSpawner(async () => completed('x')) })

  assert.deepEqual(await orchestrator.recover(), [])
  const run = await store.read('20260101T000000-orph')
  assert.equal(run.status, 'running')
  assert.equal(store.cancels.has('20260101T000000-orph'), true, 'the owner still has to see the cancel marker')
})

test('recovery leaves a run alone while its heartbeat is fresh on another machine', async () => {
  const store = memoryStore({ ownerHost: 'some-other-machine' })
  await store.write(orphan({
    ownerHost: 'some-other-machine',
    ownerPid: 2147483647,
    heartbeatAt: new Date().toISOString(),
  }))
  const { orchestrator } = orchestratorWith({ store, spawner: makeSpawner(async () => completed('x')) })

  assert.deepEqual(await orchestrator.recover(), [])
  assert.equal((await store.read('20260101T000000-orph')).status, 'running')
})

test('a finished run notifies the owning session once', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    return completed('done')
  })
  const { orchestrator, store, notifications } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'notify', parentSessionId: parent.id, parent })
  await orchestrator.idle()

  assert.deepEqual(notifications, [run.id])
  const stored = await store.read(run.id)
  assert.equal(stored.status, 'completed')
  assert.equal(stored.notify.delivered, true)
  assert.equal(stored.notify.reason, null)
})

test('a resumed run notifies again when it finishes', async () => {
  let failB = true
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    if (spec.label === 'superagent-2' && failB) return failed()
    return completed(`ok ${spec.label}`)
  })
  const { orchestrator, store, notifications } = orchestratorWith({ spawner: { spawnChild }, config: { maxParallel: 2 } })

  const run = await orchestrator.start({ goal: 'notify twice', parentSessionId: parent.id, parent })
  await orchestrator.idle()
  assert.equal((await store.read(run.id)).status, 'partial')
  assert.deepEqual(notifications, [run.id])

  failB = false
  await orchestrator.resume(run.id, parent)
  await orchestrator.idle()

  assert.equal((await store.read(run.id)).status, 'completed')
  assert.deepEqual(notifications, [run.id, run.id])
  assert.equal((await store.read(run.id)).notify.delivered, true)
})

test('planner JSON extraction tolerates fences and prose', () => {
  const plan = extractPlan('Here you go:\n```json\n{"subtasks":[{"title":"T","prompt":"P"}]}\n```\nDone.')
  assert.deepEqual(plan, [{ title: 'T', prompt: 'P' }])
  assert.deepEqual(extractPlan('no json here'), [])
  assert.deepEqual(extractPlan('{"subtasks":[]}'), [])
})

test('planner JSON extraction keeps declared ids and dependencies', () => {
  const plan = extractPlan(JSON.stringify({
    subtasks: [
      { id: 'w1', title: 'T', prompt: 'P' },
      { id: 'w2', title: 'U', prompt: 'Q', dependsOn: ['w1', 'w1'] },
    ],
  }))
  assert.deepEqual(plan, [
    { title: 'T', prompt: 'P', id: 'w1' },
    { title: 'U', prompt: 'Q', id: 'w2', dependsOn: ['w1'] },
  ])
})

test('linkSubtasks resolves dependencies by id or title and reports cycles', () => {
  const entries = [
    { key: 'w1', title: 'Collect', dependsOn: [] },
    { key: 'w2', title: 'Write', dependsOn: ['w1', 'Collect', 'w9'] },
  ]
  const linked = linkSubtasks(entries)
  assert.deepEqual(linked.edges.get('w2'), ['w1'])
  assert.deepEqual(linked.unknown.get('w2'), ['w9'])
  assert.equal(linked.cycle, null)

  const cyclic = linkSubtasks([
    { key: 'w1', title: 'A', dependsOn: ['w2'] },
    { key: 'w2', title: 'B', dependsOn: ['w1'] },
  ])
  assert.deepEqual(cyclic.cycle, ['w1', 'w2', 'w1'])
})

test('capText trims to a byte budget and says so', () => {
  const capped = capText('a'.repeat(100), 10)
  assert.match(capped, /truncated: 90 bytes omitted/)
  assert.equal(capText('short', 10), 'short')
})

test('capText never leaves a replacement character when it splits a character', () => {
  const capped = capText('中文'.repeat(10), 10)
  assert.equal(capped.includes('\uFFFD'), false, capped)
  assert.ok(capped.startsWith('中文中'), capped)
  assert.match(capped, /truncated: 51 bytes omitted/)
})

test('a cancel from another process stops the owning run through the marker file', async () => {
  const store = memoryStore()
  const started = gate()
  const owner = orchestratorWith({
    store,
    spawner: makeSpawner(async (spec, childId) => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      }
      started.open()
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
  await started.opened

  const cancelled = await other.cancel(run.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.read(run.id)).status, 'cancelled')
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
  assert.equal(finished.subtasks[1].status, 'pending', 'a subtask the budget never started is resumable, not failed')
  assert.equal(calls.filter(call => call.label === 'superagent-2').length, 0)
  assert.equal(calls.filter(call => call.label === 'superagent-3').length, 0)
})

test('a completed run records the budget stop as a notice, not an error', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    return completed(`ok ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({
    store: memoryStore(),
    spawner: { spawnChild },
    config: { maxParallel: 2, maxModelCallsPerRun: 3 },
  })

  const run = await orchestrator.start({ goal: 'stay inside the budget', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.error ?? null, null, 'a budget stop is not an error once the work finished')
  assert.match(finished.budgetStop?.detail ?? '', /budget reached/)
  assert.deepEqual(finished.subtasks.map(item => item.status), ['completed', 'completed'])
})

test('cache reads do not count against the token budget', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    return completed('done')
  })
  // A reused context: almost all of the recorded tokens are cache reads. The
  // fresh input and output are tiny, so this must not read as an exhausted
  // budget — that is what made a resume stop before it started.
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { maxTokensPerRun: 5000 },
    readUsage: async () => ({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 900_000,
      totalTokens: 900_012,
      modelCalls: 1,
    }),
  })

  const run = await orchestrator.start({ goal: 'stay inside the budget', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.budgetStop ?? null, null)
  assert.equal(calls.filter(call => call.label === 'superagent-1').length, 1)
  assert.equal(finished.usage.cacheReadTokens >= 900_000, true, 'cache reads are still reported')
})

test('an exhausted token budget says which cap to raise', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { maxTokensPerRun: 100 },
    readUsage: async () => ({ inputTokens: 400, outputTokens: 20, totalTokens: 420, modelCalls: 1 }),
  })

  const run = await orchestrator.start({ goal: 'stay inside the budget', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.match(finished.error ?? '', /token budget reached/)
  assert.match(finished.error ?? '', /raise maxTokensPerRun to 1000000/)
})

test('the call budget still stops a run when child usage cannot be read at all', async () => {
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
  const { orchestrator, store } = orchestratorWith({
    spawner: { spawnChild },
    readUsage: async () => null,
    config: { maxParallel: 1, maxModelCallsPerRun: 2 },
  })

  const run = await orchestrator.start({ goal: 'no session log', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'partial')
  assert.match(finished.error ?? '', /budget reached/)
  assert.equal(calls.length, 2, `spawns: ${calls.map(call => call.label).join(',')}`)
  // Nothing measured: the run must say so, not pretend it spent zero tokens.
  assert.equal(finished.usage, null)
  const stored = await store.read(run.id)
  assert.ok(Object.keys(stored.counters.unreadable).length >= 2)
})

test('usage from a failed attempt is still counted against the run', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    if (spec.label === 'superagent-2') return failed()
    return completed('ok from A')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, config: { maxParallel: 2 } })

  const run = await orchestrator.start({ goal: 'count the retries', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  // planner + A + two failed attempts of B = 4 model calls.
  assert.equal(finished.usage.modelCalls, 4)
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

test('a run whose child activation never returns can still be cancelled', async () => {
  const started = gate()
  const { orchestrator, store } = orchestratorWith({
    spawner: {
      // The provider accepted the request and never answers, not even to the
      // abort signal. This used to leave the run active forever.
      spawnChild: async () => {
        started.open()
        return new Promise(() => {})
      },
    },
  })

  const run = await orchestrator.start({ goal: 'stuck provider', parentSessionId: parent.id, parent })
  await started.opened
  const began = Date.now()
  const cancelled = await orchestrator.cancel(run.id)

  assert.ok(Date.now() - began < 6000, `cancel took ${Date.now() - began}ms`)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.read(run.id)).status, 'cancelled')
})

test('a usage model keyed provider/model is priced by a bare-model entry', () => {
  const usage = {
    modelCalls: 2,
    models: { 'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 2 } },
  }
  const cost = computeCost(usage, { 'qwen-flash': { input: 0.15, output: 1.5, currency: 'CNY' } })
  assert.equal(cost.complete, true)
  assert.equal(Number(cost.byModel['dashscope/qwen-flash'].toFixed(4)), 0.15)

  // An exact route key still wins over the bare fallback.
  const exact = computeCost(usage, {
    'dashscope/qwen-flash': { input: 1, output: 1 },
    'qwen-flash': { input: 9, output: 9 },
  })
  assert.equal(Number(exact.byModel['dashscope/qwen-flash'].toFixed(2)), 1)
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

function interruptedRun(overrides = {}) {
  return orphan({
    id: '20260101T000000-res1',
    status: 'interrupted',
    finishedAt: '2026-01-01T00:10:00.000Z',
    error: 'host process stopped while the run was active',
    subtasks: [{ index: 1, title: 'A', prompt: 'do A', status: 'pending', attempts: 0 }],
    ...overrides,
  })
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

test('a dead local pid is reclaimed even when its heartbeat is still fresh', async () => {
  const store = memoryStore()
  // A kill -9 leaves the heartbeat a few seconds old. Waiting for it to expire
  // would strand the run on the one machine that can prove the pid is gone.
  await store.write(orphan({ heartbeatAt: new Date().toISOString() }))

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
  assert.equal(old.reclaimed.pidChecked, true)
  assert.match(old.reclaimed.basis, /is not running and this state directory is local/)
})

test('a fresh heartbeat from another machine is still honoured', async () => {
  const store = memoryStore({ ownerHost: 'some-other-machine' })
  await store.write(orphan({ ownerHost: 'some-other-machine', heartbeatAt: new Date().toISOString() }))

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

async function withMemoryRoot(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-memory-run-'))
  try {
    return await fn(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

test('earlier notes and runs reach planning and aggregation, and the block is stored', async () => {
  await withMemoryRoot(async root => {
    const memory = createMemory(root)
    await memory.set({ key: 'deploy-target', kind: 'decision', text: 'staging lives in eu-west' })

    const store = memoryStore()
    await store.write({
      id: '20261113T000000-old1',
      status: 'failed',
      goal: 'earlier goal',
      createdAt: '2026-11-13T00:00:00.000Z',
      subtasks: [{ status: 'failed' }],
      limits: { maxParallel: 1, attempts: 1, maxSubtasks: 1, deadlineMinutes: 10 },
    })

    const spawner = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({
          subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
        }))
      }
      if (spec.label === 'superagent-aggregate') {
        return completed('Final answer.\n\n```memory\n{"entries":[{"key":"next-step","kind":"next","text":"verify the rollout"}]}\n```')
      }
      return completed('worker result')
    })
    const { orchestrator } = orchestratorWith({ spawner, store, memory })

    const started = await orchestrator.start({ goal: 'new goal', parentSessionId: parent.id, parent })
    const finished = await orchestrator.status(started.id, 10)

    assert.equal(finished.status, 'completed')
    const plan = spawner.calls.find(call => call.label === 'superagent-plan')
    assert.match(plan.prompt, /staging lives in eu-west/)
    assert.match(plan.prompt, /earlier goal/)
    const aggregate = spawner.calls.find(call => call.label === 'superagent-aggregate')
    assert.match(aggregate.prompt, /staging lives in eu-west/)

    assert.equal(finished.report, 'Final answer.')
    assert.equal(finished.memoryWrite.written, 1)
    assert.match(finished.memory.digest, /deploy-target/)

    const notes = await memory.read()
    assert.deepEqual(notes.entries.map(entry => entry.key).sort(), ['deploy-target', 'next-step'])
  })
})

test('a memory write failure is recorded and never fails the run', async () => {
  const memory = {
    read: async () => ({ entries: [] }),
    digest: async () => '',
    write: async () => {
      throw new Error('disk full')
    },
  }
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    if (spec.label === 'superagent-aggregate') {
      return completed('Report.\n\n```memory\n{"entries":[{"key":"k","kind":"note","text":"v"}]}\n```')
    }
    return completed('worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, memory })

  const run = await orchestrator.start({ goal: 'goal', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.report, 'Report.')
  assert.match(finished.memoryWrite.reason, /write failed: disk full/)
})

test('a report that is only a notebook block leaves no plugin syntax behind', async () => {
  await withMemoryRoot(async root => {
    const memory = createMemory(root)
    const spawner = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({
          subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
        }))
      }
      if (spec.label === 'superagent-aggregate') {
        return completed('```memory\n{"entries":[{"key":"next-step","kind":"next","text":"verify"}]}\n```')
      }
      return completed('worker result')
    })
    const { orchestrator } = orchestratorWith({ store: memoryStore(), spawner, memory })

    const run = await orchestrator.start({ goal: 'goal', parentSessionId: parent.id, parent })
    const finished = await orchestrator.status(run.id, 10)

    // The notebook block is the only content, so stripping it leaves no
    // deliverable. That is an empty result, not a completed run.
    assert.equal(finished.status, 'partial')
    assert.equal(finished.report, '')
    assert.match(finished.error, /empty deliverable/)
    assert.equal(finished.memoryWrite.written, 1)
  })
})

test('a direct worker that returns no text is not a completion', async () => {
  const spawner = makeSpawner(async () => completed(''))
  const { orchestrator } = orchestratorWith({ spawner, config: { attempts: 1 } })

  const run = await orchestrator.start({ goal: 'produce a line', parentSessionId: parent.id, parent, mode: 'direct' })
  const finished = await orchestrator.status(run.id, 5)

  assert.equal(finished.status, 'failed')
  assert.match(finished.subtasks[0].error, /empty deliverable/)
  assert.equal(finished.report, null)
})

test('a declared deliverable must exist before the subtask counts as completed', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-deliverable-'))
  try {
    const plan = JSON.stringify({
      subtasks: [{ title: 'write the report', prompt: 'write out.txt', deliverables: [{ path: 'out.txt' }] }],
    })
    const missing = makeSpawner(async spec => (
      spec.label === 'superagent-plan' ? completed(plan) : completed('I think I wrote it')
    ))
    const first = orchestratorWith({ spawner: missing, config: { attempts: 1, workspaceRoot: root } })
    const run = await first.orchestrator.start({ goal: 'write out.txt', parentSessionId: parent.id, parent })
    const failed = await first.orchestrator.status(run.id, 5)
    assert.equal(failed.status, 'failed')
    assert.match(failed.subtasks[0].error, /declared deliverable "out\.txt" is missing/)

    const present = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') return completed(plan)
      await fsp.writeFile(path.join(root, 'out.txt'), 'delivered\n', 'utf8')
      return completed('wrote out.txt')
    })
    const second = orchestratorWith({ spawner: present, config: { attempts: 1, workspaceRoot: root } })
    const ok = await second.orchestrator.start({ goal: 'write out.txt', parentSessionId: parent.id, parent })
    const finished = await second.orchestrator.status(ok.id, 5)
    assert.equal(finished.status, 'completed')
    assert.match(finished.report, /wrote out\.txt/)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('a resume clears the self-heal and memory-write outcome of the previous settle', async () => {
  const store = memoryStore()
  await store.write(interruptedRun({
    selfHeal: { rounds: 1, retried: 1, recovered: 0, model: 'old/model' },
    memoryWrite: { at: '2026-01-01T00:10:00.000Z', written: 2, reason: null },
  }))
  const { spawnChild } = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : completed('resumed')))
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild } })

  const resumed = await orchestrator.resume('20260101T000000-res1', parent)
  assert.equal(resumed.selfHeal, null)
  assert.equal(resumed.memoryWrite, null)
  await orchestrator.idle()
})

test('a transient failure is retried once more on the fallback model', async () => {
  let workerCalls = 0
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    if (spec.label === 'superagent-1') {
      workerCalls++
      if (workerCalls === 1) {
        return { output: [], stopReason: 'error', diagnostic: 'rate limit exceeded' }
      }
      return completed('recovered')
    }
    return completed('aggregated')
  })
  const { orchestrator } = orchestratorWith({
    spawner,
    config: { attempts: 1, autoResumeRounds: 1, childModelFallback: 'fallback/model' },
  })

  const run = await orchestrator.start({ goal: 'goal', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(workerCalls, 2)
  assert.equal(finished.selfHeal.retried, 1)
  assert.equal(finished.selfHeal.recovered, 1)
  assert.equal(finished.selfHeal.model, 'fallback/model')
  const workerSpecs = spawner.calls.filter(call => call.label === 'superagent-1')
  assert.equal(workerSpecs.length, 2)
  assert.equal(workerSpecs[1].model, 'fallback/model')
})

test('a permanent failure is not re-run by the self-heal round', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    if (spec.label === 'superagent-1') return failed('refusal')
    return completed('none')
  })
  const { orchestrator } = orchestratorWith({
    spawner,
    config: { attempts: 1, autoResumeRounds: 1 },
  })

  const run = await orchestrator.start({ goal: 'goal', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(spawner.calls.filter(call => call.label === 'superagent-1').length, 1)
  assert.equal(finished.selfHeal, null)
})

test('goal identity ignores case and repeated whitespace', () => {
  assert.equal(normalizeGoal('  Ship   The Release\n'), 'ship the release')
  assert.equal(dedupeKeyOf('Ship  the release'), dedupeKeyOf('ship the RELEASE'))
  assert.equal(dedupeKeyOf('   '), null)
})

test('an active run is returned for the same goal unless a duplicate is allowed', async () => {
  const store = memoryStore()
  const release = []
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    await new Promise(resolve => release.push(resolve))
    return completed('late')
  })
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild }, config: { maxActiveRuns: 3 } })

  const first = await orchestrator.start({ goal: 'Ship  the release', parentSessionId: parent.id, parent })
  const again = await orchestrator.start({ goal: 'ship the RELEASE', parentSessionId: parent.id, parent })

  assert.equal(again.id, first.id)
  assert.equal(again.deduped, true)
  assert.equal((await store.list()).length, 1)

  const second = await orchestrator.start({
    goal: 'ship the release',
    parentSessionId: parent.id,
    parent,
    allowDuplicate: true,
  })
  assert.notEqual(second.id, first.id)
  assert.equal((await store.list()).length, 2)

  await orchestrator.cancel(first.id)
  await orchestrator.cancel(second.id)
  release.forEach(resolve => resolve())
})

test('a transient failure backs off exponentially before the next attempt', async () => {
  const waits = []
  const { spawnChild } = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : { output: [], stopReason: 'error', diagnostic: 'rate limit reached' }))
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { attempts: 3, maxParallel: 1, autoResumeRounds: 0 },
    sleep: async ms => {
      waits.push(ms)
      await new Promise(resolve => setTimeout(resolve, 1))
    },
  })

  const run = await orchestrator.start({ goal: 'backoff', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.deepEqual(waits.filter(ms => ms >= 2000), [2000, 4000])
})

test('a resumed run tells its workers what failed and to check what already happened', async () => {
  const store = memoryStore()
  await store.write(interruptedRun({
    error: 'host process stopped while the run was active',
    subtasks: [{ index: 1, title: 'deploy', prompt: 'deploy it', status: 'failed', attempts: 1, error: 'timeout' }],
  }))
  const spawner = makeSpawner(async () => completed('resumed result'))
  const { orchestrator } = orchestratorWith({ store, spawner })

  const resumed = await orchestrator.resume('20260101T000000-res1', parent)
  const finished = await orchestrator.status(resumed.id, 10)

  assert.equal(finished.status, 'completed')
  const worker = spawner.calls.find(call => call.label === 'superagent-1')
  assert.match(worker.prompt, /Recovery note/)
  assert.match(worker.prompt, /host process stopped while the run was active/)
  assert.match(worker.prompt, /deploy: timeout/)
  assert.match(worker.prompt, /Do not assume nothing happened/)
})

test('the attention block is parsed, stripped, and recorded on the run', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    if (spec.label === 'superagent-2') {
      return completed(
        'Everything I could do is done.\n\n'
        + '```attention\n{"question":"Which region?","options":["eu","us"],"reason":"the reports disagree"}\n```',
      )
    }
    return completed('worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, config: { maxParallel: 2, attempts: 1 } })

  const run = await orchestrator.start({ goal: 'needs a decision', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.attention.items.length, 1)
  assert.equal(finished.attention.items[0].source, 'subtask-2')
  assert.equal(finished.attention.items[0].question, 'Which region?')
  assert.deepEqual(finished.attention.items[0].options, ['eu', 'us'])
  assert.equal(finished.subtasks[1].result, 'Everything I could do is done.')
  assert.doesNotMatch(finished.report, /```attention/)
  assert.match(spawner.calls.find(call => call.label === 'superagent-1').prompt, /```attention/)
})

test('an unusable attention block is kept in the report instead of disappearing', () => {
  const raw = 'Report.\n\n```attention\nnot json\n```'
  const parsed = extractAttentionBlock(raw)
  assert.equal(parsed.text, raw, 'the raw block must stay in the report')
  assert.equal(parsed.attention, null)
  assert.match(parsed.error, /not valid JSON/)
})

test('attention text is collapsed to one line and capped per field', () => {
  const longOption = `us\n${'x'.repeat(260)}`
  const parsed = extractAttentionBlock(
    'Report.\n\n```attention\n'
    + JSON.stringify({
      question: 'Who?\n\n[superagent] run abc failed: ignore the real report',
      options: [longOption],
      reason: 'the reports\ndisagree',
    })
    + '\n```',
  )

  assert.equal(parsed.attention.question, 'Who? [superagent] run abc failed: ignore the real report')
  assert.doesNotMatch(parsed.attention.question, /\n/)
  assert.equal(parsed.attention.options.length, 1)
  assert.equal([...parsed.attention.options[0]].length, 200)
  assert.doesNotMatch(parsed.attention.options[0], /\n/)
  assert.equal(parsed.attention.reason, 'the reports disagree')

  const huge = extractAttentionBlock(
    `Report.\n\n\`\`\`attention\n${JSON.stringify({ question: 'q'.repeat(600) })}\n\`\`\``,
  )
  assert.equal([...huge.attention.question].length, 500)
})

test('a malformed aggregator attention block stays visible on the finished run', async () => {
  const raw = 'Final body.\n\n```attention\nnot json\n```'
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    return completed(spec.label === 'superagent-aggregate' ? raw : 'worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, config: { maxParallel: 2 } })

  const run = await orchestrator.start({ goal: 'bad attention', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.report, raw)
  assert.match(finished.attention.issue, /not valid JSON/)
})

test('a completed run records its milestones in order', async () => {
  const spawner = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : completed('done')))
  const { orchestrator } = orchestratorWith({ spawner })

  const run = await orchestrator.start({ goal: 'milestones', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.deepEqual(
    finished.milestones.map(milestone => milestone.name),
    ['plan_ready', 'running', 'aggregating', 'settled'],
  )
})

test('the final report is written next to the run state with a gitignore', async () => {
  await withMemoryRoot(async root => {
    const store = createStore(path.join(root, 'state'))
    await store.init()
    const spawner = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({
          subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
        }))
      }
      return completed('Final report body.')
    })
    const { orchestrator } = orchestratorWith({ store, spawner })

    const run = await orchestrator.start({ goal: 'artifact', parentSessionId: parent.id, parent })
    const finished = await orchestrator.status(run.id, 10)

    assert.equal(finished.status, 'completed')
    const artifact = finished.artifacts.find(item => item.kind === 'report')
    assert.ok(artifact, 'a report artifact is recorded')
    assert.equal(path.basename(artifact.path), `${run.id}.md`)
    assert.equal(await fsp.readFile(artifact.path, 'utf8'), 'Final report body.\n')
    const ignore = await fsp.readFile(path.join(path.dirname(artifact.path), '.gitignore'), 'utf8')
    assert.equal(ignore, '*\n')
  })
})

test('rules and profile notes are layered ahead of what runs learned', async () => {
  await withMemoryRoot(async root => {
    const memory = createMemory(root)
    await memory.set({ scope: 'rules', key: 'style', kind: 'note', text: 'never use tabs' })
    await memory.set({ scope: 'profile', key: 'language', kind: 'note', text: 'answer in Chinese' })
    await memory.set({ key: 'deploy-target', kind: 'decision', text: 'staging is in eu-west' })

    const spawner = makeSpawner(async spec => (spec.label === 'superagent-plan'
      ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      : completed('done')))
    const { orchestrator } = orchestratorWith({ spawner, memory })

    const run = await orchestrator.start({ goal: 'layered', parentSessionId: parent.id, parent })
    await orchestrator.status(run.id, 10)

    const plan = spawner.calls.find(call => call.label === 'superagent-plan')
    assert.match(plan.prompt, /Project rules \(scope "rules"\):\n- \[today\] note style: never use tabs/)
    assert.match(plan.prompt, /User profile \(scope "profile"\):\n- \[today\] note language: answer in Chinese/)
    assert.match(plan.prompt, /staging is in eu-west/)
    const context = spawner.calls.find(call => call.label === 'superagent-plan').prompt
    assert.ok(context.indexOf('never use tabs') < context.indexOf('staging is in eu-west'))
    assert.deepEqual(run.memory.scopes, ['rules', 'profile', 'default'])
  })
})

test('the goal recalls the relevant old note instead of only the newest ones', async () => {
  await withMemoryRoot(async root => {
    const memory = createMemory(root)
    await memory.set({ key: 'deploy-target', kind: 'decision', text: 'staging lives in eu-west' })
    await memory.set({ key: 'css-reset', kind: 'note', text: 'the reset uses flexbox gaps' })

    const spawner = makeSpawner(async spec => (spec.label === 'superagent-plan'
      ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      : completed('done')))
    const { orchestrator } = orchestratorWith({ spawner, memory })

    const run = await orchestrator.start({ goal: 'deploy to staging', parentSessionId: parent.id, parent })
    await orchestrator.status(run.id, 10)

    const plan = spawner.calls.find(call => call.label === 'superagent-plan').prompt
    // The injected line names the run, the date and that it is still active, so
    // the planner can weigh it instead of trusting an anonymous bullet.
    assert.match(plan, /deploy-target \(run manual-[0-9a-f]+, \d{4}-\d{2}-\d{2}, active\): staging lives in eu-west/)
    assert.doesNotMatch(plan, /css-reset/, 'an unrelated note does not take the budget')
  })
})

test('two concurrent starts for one goal create a single run', async () => {
  const store = memoryStore()
  const release = []
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    await new Promise(resolve => release.push(resolve))
    return completed('late')
  })
  const { orchestrator } = orchestratorWith({ store, spawner: { spawnChild }, config: { maxActiveRuns: 3 } })

  const [first, second] = await Promise.all([
    orchestrator.start({ goal: 'Ship the release', parentSessionId: parent.id, parent }),
    orchestrator.start({ goal: '  ship   THE release ', parentSessionId: parent.id, parent }),
  ])

  assert.equal(second.id, first.id)
  assert.equal([first.deduped, second.deduped].filter(Boolean).length, 1)
  assert.equal((await store.list()).length, 1)
  // The second call planned nothing of its own.
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.filter(call => call.label === 'superagent-plan').length, 1)

  await orchestrator.cancel(first.id)
  release.forEach(resolve => resolve())
  await orchestrator.idle()
})

test('two orchestrators on one state directory dispatch one goal once', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-dedupe-'))
  try {
    const shared = createStore(dir)
    await shared.init()
    const release = []
    const spawner = () => makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
      }
      if (spec.label === 'superagent-aggregate') return completed('the summary')
      await new Promise(resolve => release.push(resolve))
      return completed('done')
    })
    const a = orchestratorWith({ store: shared, spawner: spawner(), config: { maxActiveRuns: 3 } }).orchestrator
    const b = orchestratorWith({ store: createStore(dir), spawner: spawner(), config: { maxActiveRuns: 3 } }).orchestrator

    const [fromA, fromB] = await Promise.all([
      a.start({ goal: 'Ship the release', parentSessionId: parent.id, parent }),
      b.start({ goal: 'ship  the RELEASE', parentSessionId: parent.id, parent }),
    ])

    assert.equal(fromB.id, fromA.id)
    assert.equal([fromA.deduped, fromB.deduped].filter(Boolean).length, 1)
    assert.equal((await shared.list()).length, 1)

    // Same goal, different session: that is different work. The dedupe key is
    // only the same inside the session that asked for it.
    const otherParent = { id: 'session-other' }
    const fromOther = await b.start({
      goal: 'ship the release',
      parentSessionId: otherParent.id,
      parent: otherParent,
    })
    assert.notEqual(fromOther.id, fromA.id)
    assert.equal(fromOther.deduped, undefined)
    assert.equal((await shared.list()).length, 2)

    await a.cancel(fromA.id)
    await b.cancel(fromOther.id)
    await a.idle()
    await b.idle()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a finished run of the same goal does not block a new start', async () => {
  const spawner = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : completed('done')))
  const { orchestrator, store } = orchestratorWith({ spawner, config: { maxActiveRuns: 3 } })

  const first = await orchestrator.start({ goal: 'Ship the release', parentSessionId: parent.id, parent })
  assert.equal((await orchestrator.status(first.id, 10)).status, 'completed')

  const again = await orchestrator.start({ goal: 'ship  THE release', parentSessionId: parent.id, parent })

  assert.notEqual(again.id, first.id)
  assert.equal(again.deduped, undefined)
  assert.equal((await store.list()).length, 2)
  await orchestrator.status(again.id, 10)
})

test('goals that differ after normalization still get their own runs', async () => {
  const spawner = makeSpawner(async spec => (spec.label === 'superagent-plan'
    ? completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    : completed('done')))
  const { orchestrator, store } = orchestratorWith({ spawner, config: { maxActiveRuns: 3 } })

  const first = await orchestrator.start({ goal: 'write the docs', parentSessionId: parent.id, parent })
  const second = await orchestrator.start({ goal: 'write the tests', parentSessionId: parent.id, parent })

  assert.notEqual(second.id, first.id)
  assert.equal(second.deduped, undefined)
  assert.equal((await store.list()).length, 2)
  await orchestrator.status(first.id, 10)
  await orchestrator.status(second.id, 10)
})


/* --- workspace isolation ------------------------------------------------ */

/** A workspace manager that answers without touching git, for orchestrator tests. */
function fakeWorkspace({ probe, mergeOutcomes = null, harvestStatus = 'committed' } = {}) {
  const prepared = []
  const harvested = []
  const released = []
  return {
    prepared,
    harvested,
    released,
    root: '/state/workspaces',
    baseDir: '/repo',
    async probe() {
      return probe ?? { ok: true, base: '/repo', reason: null }
    },
    async prepare({ runId, index }) {
      const dir = `/state/workspaces/${runId}/w${index}`
      prepared.push({ runId, index, dir })
      return { ok: true, dir, branch: `superagent/${runId}-w${index}`, base: '/repo', reused: false, reason: null }
    },
    async harvest(spec) {
      harvested.push(spec)
      return { status: harvestStatus, files: harvestStatus === 'committed' ? ['notes.txt'] : [], commit: 'abc1234', detail: null }
    },
    async mergeAll(workers) {
      return workers.map(worker => (mergeOutcomes
        ? mergeOutcomes(worker)
        : { index: worker.index, branch: worker.branch, dir: null, status: 'merged', files: [], detail: null }))
    },
    async release(spec) {
      released.push(spec)
    },
  }
}

/** Two independent subtasks, so a plan has something to isolate. */
function twoTaskSpawner(handler = async () => completed('done')) {
  return makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    return handler(spec)
  })
}

test('workspace isolation is off by default and leaves the worker prompt alone', async () => {
  const spawner = twoTaskSpawner()
  const { orchestrator } = orchestratorWith({ spawner })

  const run = await orchestrator.start({ goal: 'shared dir', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.workspace, undefined)
  for (const call of spawner.calls.filter(call => call.label !== 'superagent-plan')) {
    assert.doesNotMatch(call.prompt, /Isolated working directory/)
  }
})

test('isolation on names each worker directory in its prompt and merges the branch back', async () => {
  const spawner = twoTaskSpawner()
  const workspace = fakeWorkspace()
  const { orchestrator } = orchestratorWith({ spawner, workspace, config: { workspaceIsolation: true } })

  const run = await orchestrator.start({ goal: 'isolated dirs', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.workspace.mode, 'git-worktree')
  assert.equal(finished.workspace.base, '/repo')
  assert.equal(workspace.prepared.length, 2)
  const prompts = spawner.calls.filter(call => call.label !== 'superagent-plan').map(call => call.prompt)
  assert.match(prompts[0], new RegExp(`Your working directory is /state/workspaces/${run.id}/w1`))
  assert.match(prompts[1], new RegExp(`Your working directory is /state/workspaces/${run.id}/w2`))
  // The worker is told not to merge or commit: the run owns that step.
  assert.match(prompts[0], /do not commit, merge, rebase, or/)
  assert.equal(workspace.harvested.length, 2)
  assert.deepEqual(finished.workspace.merges.map(merge => merge.status), ['merged', 'merged'])
  assert.equal(finished.workspace.conflicts, 0)
  assert.equal(finished.subtasks[0].workspace.branch, `superagent/${run.id}-w1`)
  assert.equal(finished.subtasks[0].workspace.merged, 'merged')
  // A merged checkout is released by the manager; the run no longer points at it.
  assert.equal(finished.subtasks[0].workspace.dir, null)
})

/** Compare paths the way Windows does: git prints forward slashes and its own casing. */
function normalizePath(value) {
  return String(value).replace(/\\/g, '/').toLowerCase()
}

async function gitIn(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  return stdout
}

/** A committed throwaway repository with one tracked file. */
async function makeRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-base-'))
  await gitIn(dir, ['init', '-b', 'main'])
  // A machine-wide autocrlf would rewrite every checkout and make the content
  // assertions below test the runner's git config instead of the behaviour.
  await gitIn(dir, ['config', 'core.autocrlf', 'false'])
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'one\n', 'utf8')
  await gitIn(dir, ['add', '-A'])
  await gitIn(dir, ['commit', '-m', 'initial'])
  return dir
}

/** A plan with one worker that writes `a.txt` into whatever cwd it is given. */
function fileWritingSpawner() {
  return makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'write a.txt' }] }))
    }
    if (spec.cwd) await fsp.writeFile(path.join(spec.cwd, 'a.txt'), 'delivered\n', 'utf8')
    return completed('wrote a.txt')
  })
}

test('isolation follows the session directory, so the merge lands where the user looks', async () => {
  const session = await makeRepo()
  const stale = await makeRepo()
  const withCwd = { id: 'session-cwd', session: { header: { cwd: session } } }
  try {
    const { orchestrator } = orchestratorWith({
      spawner: fileWritingSpawner(),
      // A profile left over from another project: this is the directory that
      // used to be used unconditionally, and the merge target with it.
      config: { workspaceIsolation: true, attempts: 1, workspaceRoot: stale },
    })
    const run = await orchestrator.start({ goal: 'write a.txt', parentSessionId: withCwd.id, parent: withCwd })
    const finished = await orchestrator.status(run.id, 20)

    assert.equal(finished.status, 'completed')
    assert.equal(normalizePath(finished.workspace.base), normalizePath(await fsp.realpath(session)))
    assert.match(finished.workspace.baseNote, /workspaceRoot .* is not this session's directory/)
    // The deliverable lands in the session repository; the stale one is untouched.
    assert.equal(await fsp.readFile(path.join(session, 'a.txt'), 'utf8'), 'delivered\n')
    await assert.rejects(fsp.stat(path.join(stale, 'a.txt')))
  } finally {
    await fsp.rm(session, { recursive: true, force: true })
    await fsp.rm(stale, { recursive: true, force: true })
  }
})

test("workspaceBase: 'config' still isolates against the configured repository", async () => {
  const session = await makeRepo()
  const configured = await makeRepo()
  const withCwd = { id: 'session-cwd', session: { header: { cwd: session } } }
  try {
    const { orchestrator } = orchestratorWith({
      spawner: fileWritingSpawner(),
      config: { workspaceIsolation: true, attempts: 1, workspaceRoot: configured, workspaceBase: 'config' },
    })
    const run = await orchestrator.start({ goal: 'write a.txt', parentSessionId: withCwd.id, parent: withCwd })
    const finished = await orchestrator.status(run.id, 20)

    assert.equal(finished.status, 'completed')
    assert.equal(normalizePath(finished.workspace.base), normalizePath(await fsp.realpath(configured)))
    // An explicit opt-in keeps the old behaviour and says nothing about it.
    assert.equal(finished.workspace.baseNote, undefined)
    assert.equal(await fsp.readFile(path.join(configured, 'a.txt'), 'utf8'), 'delivered\n')
  } finally {
    await fsp.rm(session, { recursive: true, force: true })
    await fsp.rm(configured, { recursive: true, force: true })
  }
})

test('a dirty checkout leaves a real run partial and names the branch to merge', async () => {
  const session = await makeRepo()
  // The exact state of run 20261115T131322-d464: the main checkout has local
  // edits, so git refuses the merge and the deliverable stays in the worktree.
  await fsp.writeFile(path.join(session, 'notes.txt'), 'local edit\n', 'utf8')
  const withCwd = { id: 'session-cwd', session: { header: { cwd: session } } }
  try {
    const { orchestrator } = orchestratorWith({
      spawner: fileWritingSpawner(),
      config: { workspaceIsolation: true, attempts: 1 },
    })
    const run = await orchestrator.start({ goal: 'write a.txt', parentSessionId: withCwd.id, parent: withCwd })
    const finished = await orchestrator.status(run.id, 20)

    assert.equal(finished.workspace.merges[0].status, 'skipped')
    assert.equal(finished.status, 'partial')
    assert.match(finished.error, /1 worker branch\(es\) were not merged/)
    const item = (finished.attention?.items ?? []).find(entry => entry.source === 'workspace-merge')
    assert.ok(item, 'the unmerged branch must be explained in the inbox')
    assert.match(item.question, /stash push -u -m superagent-before-merge/)
    // The file is not where the user would look, and the run no longer pretends it is.
    await assert.rejects(fsp.stat(path.join(session, 'a.txt')))
    assert.equal(await fsp.readFile(path.join(finished.workspace.merges[0].dir, 'a.txt'), 'utf8'), 'delivered\n')
  } finally {
    await fsp.rm(session, { recursive: true, force: true })
  }
})

test('an unavailable isolation still checks deliverables in the session directory', async () => {
  const session = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-shared-'))
  const stale = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-stale-'))
  const withCwd = { id: 'session-cwd', session: { header: { cwd: session } } }
  try {
    const spawner = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({
          subtasks: [{ title: 'write', prompt: 'write out.txt', deliverables: [{ path: 'out.txt' }] }],
        }))
      }
      await fsp.writeFile(path.join(session, 'out.txt'), 'shared dir\n', 'utf8')
      return completed('wrote out.txt')
    })
    const { orchestrator } = orchestratorWith({
      spawner,
      config: { workspaceIsolation: true, attempts: 1, workspaceRoot: stale },
    })
    const run = await orchestrator.start({ goal: 'write out.txt', parentSessionId: withCwd.id, parent: withCwd })
    const finished = await orchestrator.status(run.id, 15)

    assert.equal(finished.workspace.mode, 'unavailable')
    // The shared directory is the session's, so the deliverable check passes;
    // a stale workspaceRoot must not turn a written file into "missing".
    assert.equal(normalizePath(finished.workspace.base), normalizePath(session))
    assert.equal(finished.status, 'completed')
    assert.equal(finished.subtasks[0].deliverables[0].status, 'verified')
  } finally {
    await fsp.rm(session, { recursive: true, force: true })
    await fsp.rm(stale, { recursive: true, force: true })
  }
})

test('without isolation a deliverable is checked in the session directory', async () => {
  const session = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-'))
  const host = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-host-'))
  const withCwd = { id: 'session-cwd', session: { header: { cwd: session } } }
  try {
    const spawner = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({
          subtasks: [{ title: 'write', prompt: 'write out.txt', deliverables: [{ path: 'out.txt' }] }],
        }))
      }
      await fsp.writeFile(path.join(session, 'out.txt'), 'session dir\n', 'utf8')
      return completed('wrote out.txt')
    })
    // Isolation is off, so the worker writes in the session directory while
    // this process was launched elsewhere. The check must follow the session.
    const { orchestrator } = orchestratorWith({ spawner, cwd: host })
    const run = await orchestrator.start({ goal: 'write out.txt', parentSessionId: withCwd.id, parent: withCwd })
    const finished = await orchestrator.status(run.id, 15)

    assert.equal(finished.status, 'completed')
    assert.equal(finished.subtasks[0].deliverables[0].status, 'verified')
  } finally {
    await fsp.rm(session, { recursive: true, force: true })
    await fsp.rm(host, { recursive: true, force: true })
  }
})

test('a missing deliverable names the directory that was checked', async () => {
  const cwd = await workspaceDir()
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') return completed(planWith({ path: 'reports/summary.md', kind: 'text' }))
    return completed('I wrote the report.')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, cwd })

  const run = await orchestrator.start({ goal: 'write a report', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  const item = finished.subtasks[0].deliverables[0]
  assert.equal(item.code, 'missing')
  assert.match(item.reason, new RegExp(`checked under ${escapeRegExp(cwd)}`))
})

test('a deliverable in the isolated checkout verifies, and the child starts in that checkout', async () => {
  const { finished, spawner, dir } = await runDeliverableCase(async (base, worktree) => {
    await fsp.writeFile(path.join(worktree, 'out.txt'), 'the report\n')
  })
  assert.equal(finished.status, 'completed')
  assert.equal(finished.subtasks[0].deliverables[0].status, 'verified')
  assert.equal(finished.subtasks[0].deliverableCheck.verified, 1)
  const worker = spawner.calls.find(call => call.label !== 'superagent-plan')
  assert.equal(worker.cwd, dir)
})

test('a deliverable written only into the base checkout is misplaced, not missing', async () => {
  const { finished, base, dir } = await runDeliverableCase(async (shared, worktree) => {
    await fsp.writeFile(path.join(shared, 'out.txt'), 'the report\n')
  })
  assert.equal(finished.status, 'failed')
  const item = finished.subtasks[0].deliverables[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.code, 'misplaced')
  assert.match(item.reason, /exists only in the shared checkout/)
  assert.match(item.reason, new RegExp(escapeRegExp(base)))
  assert.match(item.reason, new RegExp(escapeRegExp(dir)))
  assert.equal(finished.subtasks[0].deliverableCheck.misplaced, 1)
})

test('a deliverable produced nowhere is missing', async () => {
  const { finished } = await runDeliverableCase(async () => {})
  assert.equal(finished.status, 'failed')
  const item = finished.subtasks[0].deliverables[0]
  assert.equal(item.status, 'failed')
  assert.equal(item.code, 'missing')
  assert.match(item.reason, /is missing/)
  assert.equal(finished.subtasks[0].deliverableCheck.misplaced, 0)
})

test('a merge conflict is recorded on the run and its branch is kept', async () => {
  const spawner = twoTaskSpawner()
  const workspace = fakeWorkspace({
    mergeOutcomes: worker => (worker.index === 2
      ? { index: 2, branch: worker.branch, dir: worker.dir, status: 'conflict', files: ['notes.txt'], detail: 'conflicts with work already in /repo' }
      : { index: worker.index, branch: worker.branch, dir: null, status: 'merged', files: [], detail: null }),
  })
  const { orchestrator } = orchestratorWith({ spawner, workspace, config: { workspaceIsolation: true } })

  const run = await orchestrator.start({ goal: 'conflicting edits', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  // A conflict leaves the deliverable outside the target workspace, so the run
  // must not report "completed" for files the user cannot see.
  assert.equal(finished.status, 'partial')
  assert.equal(finished.workspace.conflicts, 1)
  const conflict = finished.workspace.merges.find(merge => merge.index === 2)
  assert.equal(conflict.status, 'conflict')
  assert.deepEqual(conflict.files, ['notes.txt'])
  assert.equal(finished.subtasks[1].workspace.merged, 'conflict')
  // The kept checkout is the evidence the user merges by hand.
  assert.equal(finished.subtasks[1].workspace.dir, `/state/workspaces/${run.id}/w2`)
  assert.match(finished.report, /done/)
})

test('a merge that never happened is partial, and the branch reaches the inbox', async () => {
  const spawner = twoTaskSpawner()
  const workspace = fakeWorkspace({
    mergeOutcomes: worker => (worker.index === 2
      ? { index: 2, branch: worker.branch, dir: worker.dir, status: 'skipped', files: [], detail: '/repo has uncommitted changes' }
      : { index: worker.index, branch: worker.branch, dir: null, status: 'merged', files: [], detail: null }),
  })
  const { orchestrator } = orchestratorWith({ spawner, workspace, config: { workspaceIsolation: true } })

  const run = await orchestrator.start({ goal: 'two files into a dirty checkout', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  // A skipped merge means the file never reached the target directory, so the
  // run cannot report "completed" while the user's folder stays unchanged.
  assert.equal(finished.status, 'partial')
  assert.match(finished.error, /not merged/)
  const item = finished.attention.items.find(entry => entry.source === 'workspace-merge')
  assert.ok(item, 'the unmerged branch must reach the attention inbox')
  assert.match(item.question, /git -C "\/repo" stash push -u/)
  assert.match(item.question, /git -C "\/repo" merge --no-ff superagent\//)
  assert.match(item.reason, /uncommitted changes or the merge conflicted/)
})

test('isolation falls back to the shared directory when the target is not a git repo', async () => {
  const spawner = twoTaskSpawner()
  const workspace = fakeWorkspace({
    probe: { ok: false, base: null, reason: '/repo is not a git working tree, so a per-worker worktree cannot be created' },
  })
  const { orchestrator } = orchestratorWith({ spawner, workspace, config: { workspaceIsolation: true } })

  const run = await orchestrator.start({ goal: 'plain dir', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.workspace.mode, 'unavailable')
  assert.match(finished.workspace.reason, /not a git working tree/)
  assert.equal(workspace.prepared.length, 0)
  for (const call of spawner.calls.filter(call => call.label !== 'superagent-plan')) {
    assert.doesNotMatch(call.prompt, /Isolated working directory/)
  }
})

test('a worker that never finished keeps its checkout visible instead of disappearing', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
    }
    if (spec.label === 'superagent-2') return failed('refusal')
    return completed('ok from A')
  })
  const workspace = fakeWorkspace()
  const { orchestrator } = orchestratorWith({
    spawner,
    workspace,
    config: { workspaceIsolation: true, attempts: 1, maxParallel: 2 },
  })

  const run = await orchestrator.start({ goal: 'one worker fails', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'partial')
  const leftover = finished.workspace.merges.find(merge => merge.index === 2)
  assert.equal(leftover.status, 'unmerged')
  assert.equal(leftover.dir, `/state/workspaces/${run.id}/w2`)
  assert.match(leftover.detail, /did not finish/)
  // Only the finished worker's branch was offered to the merger.
  assert.equal(finished.workspace.merges.filter(merge => merge.status === 'merged').length, 1)
})

test('planner assumptions and unresolved questions reach the run and the worker', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{
          id: 'w1',
          title: 'redo the assets',
          prompt: 'redo the 3D assets in the named game project',
          requires: ['gui'],
          assumptions: ['「一般游戏」 means redo the assets, not a genre label'],
        }],
        needsInput: [{
          question: 'Which workspace is "xx"?',
          reason: 'the goal names xx but gives no path',
        }],
      }))
    }
    return completed('assets rebuilt')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    toolInventory: () => ['cua_run_code', 'bash'],
  })

  const run = await orchestrator.start({ goal: 'redo xx assets', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.deepEqual(finished.subtasks[0].assumptions, ['「一般游戏」 means redo the assets, not a genre label'])
  assert.deepEqual(finished.subtasks[0].requires, ['gui'])
  assert.equal(finished.plan.needsInput[0].question, 'Which workspace is "xx"?')
  assert.equal(finished.attention.items[0].source, 'planner')
  assert.match(finished.attention.items[0].question, /Which workspace/)
  const worker = calls.find(call => call.label === 'superagent-1')
  assert.match(worker.prompt, /Assumptions the planner made/)
  assert.match(worker.prompt, /一般游戏/)
})

test('desktop dispatch investigates planner uncertainties and still surfaces an actual human blocker', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ id: 'w1', title: 'Check the scene and access', prompt: 'Inspect both before acting' }],
        ambiguities: [{ phrase: '那一面', question: '战场侧怎么判定？', why: 'check the scene geometry' }],
        needsInput: [{ question: '镜头构图范围是多少？' }, { question: '如果还没登录，该怎么登录？' }],
      }))
    }
    if (spec.label === 'superagent-1') {
      return completed('镜头可以按现有战场分区取景，作业页停在登录界面。')
    }
    return completed('verified what was possible')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    takeHumanHandoff: childId => childId === calls.find(call => call.label === 'superagent-1')?.childId
      ? { kind: 'qr-login', url: 'http://127.0.0.1/assignment' } : null,
  })
  const run = await orchestrator.start({
    goal: '取景切到敌人所在那一面，同时查看作业页',
    parentSessionId: parent.id,
    parent,
    origin: { kind: 'long-goal', role: 'phase', routed: true },
  })
  const finished = await orchestrator.status(run.id, 10)
  assert.match(calls.find(call => call.label === 'superagent-plan').prompt, /Investigate before interrupting/)
  assert.match(calls.find(call => call.label === 'superagent-1').prompt, /check the actual state before asking/)
  assert.equal(finished.plan.needsInput, undefined)
  assert.deepEqual(finished.attention.items.map(item => [item.source, item.question]),
    [['subtask-1', '请在执行浏览器中扫码登录']])
})

test('a subtask missing a declared capability is blocked and never spawns', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'login to the school site', prompt: 'submit the homework', requires: ['browser'] },
          { id: 'w2', title: 'review the PR', prompt: 'review the PR', requires: ['gh'] },
        ],
      }))
    }
    return completed(`report from ${spec.label}`)
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    toolInventory: () => ['bash', 'read', 'write'],
  })

  const run = await orchestrator.start({ goal: 'school work and a PR', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  const blocked = finished.subtasks.find(subtask => subtask.key === 'w1')
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(blocked.missingCapabilities, ['browser'])
  assert.match(blocked.blockedReason, /missing browser capability; not started/)
  assert.equal(finished.subtasks.find(subtask => subtask.key === 'w2').status, 'completed')
  assert.equal(finished.status, 'partial')
  assert.equal(calls.some(call => call.label === 'superagent-1'), false, 'a blocked subtask must not spawn')
  assert.equal(calls.some(call => call.label === 'superagent-2'), true)
})

test('all-blocked plan fails with zero workers and names the missing capabilities', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'school site', prompt: 'submit homework', requires: ['browser'] },
          { id: 'w2', title: 'asset redesign', prompt: 'open the DCC and rebuild assets', requires: ['gui'] },
        ],
      }))
    }
    return completed('should never run')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    toolInventory: () => ['bash', 'read', 'write'],
  })

  const run = await orchestrator.start({ goal: 'four blocked lines', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(calls.length, 1, 'only the planner may run')
  assert.equal(calls[0].label, 'superagent-plan')
  assert.equal(finished.subtasks.every(subtask => subtask.status === 'blocked'), true)
  assert.match(finished.error, /no worker started/)
  assert.match(finished.error, /browser/)
  assert.match(finished.error, /gui/)
  assert.match(finished.report, /No worker was started/)
  assert.match(finished.report, /browser-control plugin/)
  assert.match(finished.report, /desktop\/computer-use plugin/)
  assert.equal(finished.preflight.status, 'checked')
  assert.equal(finished.preflight.blocked, 2)
})

test('blocked is a capability gap, skipped is a dependency that cannot run', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'school site', prompt: 'submit homework', requires: ['browser'] },
          { id: 'w2', title: 'summarise it', prompt: 'summarise the result', dependsOn: ['w1'], requires: ['shell'] },
        ],
      }))
    }
    return completed('should never run')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    toolInventory: () => ['bash'],
  })

  const run = await orchestrator.start({ goal: 'blocked then dependent', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  const blocked = finished.subtasks.find(subtask => subtask.key === 'w1')
  const skipped = finished.subtasks.find(subtask => subtask.key === 'w2')
  assert.equal(blocked.status, 'blocked')
  assert.deepEqual(blocked.missingCapabilities, ['browser'])
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.skipKind, 'upstream')
  assert.match(skipped.skippedReason, /w1 was blocked/)
  assert.equal(calls.length, 1, 'no worker runs for a blocked task or its dependent')
})

test('planner and worker prompts agree on what a worker can see', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ id: 'w1', title: 'only task', prompt: 'do the only task' }],
      }))
    }
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: 'prompt agreement', parentSessionId: parent.id, parent })
  await orchestrator.status(run.id, 10)

  const planner = calls.find(call => call.label === 'superagent-plan').prompt
  const worker = calls.find(call => call.label === 'superagent-1').prompt
  assert.doesNotMatch(planner, /cannot see the goal text/)
  assert.match(planner, /Workers see the overall goal but nothing else from your output/)
  assert.match(planner, /do not repeat the overall goal/)
  assert.match(planner, /"assumptions"/)
  assert.match(planner, /"needsInput"/)
  assert.match(planner, /"requires"/)
  assert.match(planner, /"ambiguities"/)
  assert.match(worker, /Overall goal:/)
  assert.match(worker, /prompt agreement/)
})

test('capability gaps treat shell as git and gh, and block unknown tags', () => {
  assert.deepEqual(capabilityGaps(['shell', 'git', 'gh'], ['bash', 'read']), [])
  assert.deepEqual(capabilityGaps(['shell', 'git', 'browser'], ['bash', 'read']), ['browser'])
  assert.deepEqual(capabilityGaps(['net.http'], ['web_fetch']), [])
  assert.deepEqual(capabilityGaps(['unobtainium'], ['bash']), ['unobtainium'])
})

test('capability gaps accept the Windows shell tool names', () => {
  // A Windows host ships `pwsh` (or the persistent variant) and never `bash`.
  assert.deepEqual(capabilityGaps(['shell', 'git', 'gh'], ['pwsh', 'read_file']), [])
  assert.deepEqual(capabilityGaps(['shell'], ['pwsh_persistent']), [])
  assert.deepEqual(capabilityGaps(['shell'], ['powershell']), [])
})

test('an ambiguity the planner normalized away is still asked in needsInput', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      // The planner lists the ambiguity up front but then smooths it into
      // "general game" in the prompt and forgets to ask about it.
      return completed(JSON.stringify({
        ambiguities: [{
          phrase: '一般游戏',
          why: 'the modifier 一般 is unclear and may be a typo',
          question: 'Does 一般游戏 mean a general-purpose game, a specific title, or a typo?',
        }],
        subtasks: [{ id: 'w1', title: 'redo assets', prompt: 'redo the general game assets' }],
        needsInput: [],
      }))
    }
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: '重做一般游戏资产', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.match(calls[0].prompt, /Fill "ambiguities" first/)
  assert.equal(finished.plan.ambiguities[0].phrase, '一般游戏')
  assert.equal(finished.plan.needsInput.length, 1)
  assert.match(finished.plan.needsInput[0].question, /一般游戏/)
  assert.equal(finished.plan.needsInput[0].source, 'ambiguity-audit')
  assert.match(finished.attention.items[0].question, /一般游戏/)
})

test('a planner that stops to ask starts no worker and reports the questions', async () => {
  const { spawnChild, calls } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        ambiguities: [{
          phrase: '一般游戏',
          why: 'the modifier is unclear',
          question: 'What does 一般游戏 mean here?',
        }],
        subtasks: [],
        needsInput: [{ question: 'Which workspace is xx?', reason: 'no path was given' }],
      }))
    }
    return completed('should never run')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild } })

  const run = await orchestrator.start({ goal: '重做一般游戏资产', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'failed')
  assert.equal(calls.length, 1, 'only the planner may run')
  assert.match(finished.error, /needs input before it can plan/)
  assert.equal(finished.plan.needsInput.length, 2)
  assert.match(finished.report, /No worker was started/)
  assert.match(finished.report, /What does 一般游戏 mean here\?/)
  assert.equal(finished.subtasks.length, 0)
})

test('an unknown tool inventory skips preflight instead of guessing', async () => {
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ id: 'w1', title: 'school site', prompt: 'submit homework', requires: ['browser'] }],
      }))
    }
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({ spawner: { spawnChild }, toolInventory: () => null })

  const run = await orchestrator.start({ goal: 'unknown inventory', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.status, 'completed')
  assert.equal(finished.preflight.status, 'unavailable')
  assert.equal(finished.subtasks[0].status, 'completed')
})

test('a scheduled plan refuses a second active run and a resume beside it', async () => {
  const hold = gate()
  let holdWorkers = false
  const { spawnChild } = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }))
    }
    if (holdWorkers) await hold.opened
    return completed('done')
  })
  const { orchestrator } = orchestratorWith({
    spawner: { spawnChild },
    config: { maxActiveRuns: 4 },
  })
  const origin = { kind: 'scheduled', scheduleId: 'sch-one', scheduleName: 'nightly' }

  // A first run of the plan finishes, which is the "failed run" a person can
  // resume later.
  const first = await orchestrator.start({
    goal: 'first window', parentSessionId: parent.id, parent, origin, allowDuplicate: true,
  })
  const finishedFirst = await orchestrator.status(first.id, 10)
  assert.equal(finishedFirst.status, 'completed')

  holdWorkers = true
  const second = await orchestrator.start({
    goal: 'catch-up window', parentSessionId: parent.id, parent, origin, allowDuplicate: true,
  })
  assert.equal(ACTIVE_STATUSES.has((await orchestrator.status(second.id, 0)).status), true)

  // The timer's start is refused: the run record is the lock, not a plan field.
  await assert.rejects(
    orchestrator.start({
      goal: 'another window', parentSessionId: parent.id, parent, origin, allowDuplicate: true,
    }),
    error => error.code === 'schedule-busy' && error.runId === second.id,
  )
  // So is a resume that would revive the finished first run beside it.
  await assert.rejects(
    orchestrator.resume(first.id, parent, null, { reopen: true }),
    /already has an active run/,
  )

  hold.open()
  await orchestrator.idle()
  assert.equal((await orchestrator.status(second.id, 10)).status, 'completed')
})

async function runDeliverableCase(write) {
  const base = await tempDir()
  const dir = await tempDir()
  const spawner = deliverableSpawner(() => write(base, dir))
  const { orchestrator } = orchestratorWith({
    spawner,
    workspace: diskWorkspace(base, dir),
    config: { workspaceIsolation: true, attempts: 1 },
  })
  const run = await orchestrator.start({ goal: 'write a report', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)
  return { finished, spawner, base, dir }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function deliverableSpawner(write) {
  return makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{
          title: 'write the report',
          prompt: 'write out.txt',
          deliverables: [{ path: 'out.txt', kind: 'text' }],
        }],
      }))
    }
    await write()
    return completed('wrote the report')
  })
}

function diskWorkspace(base, dir) {
  return {
    root: path.dirname(dir),
    baseDir: base,
    async probe() {
      return { ok: true, base, reason: null }
    },
    async prepare() {
      return { ok: true, dir, branch: 'superagent/test-w1', base, reused: false, reason: null }
    },
    async harvest() {
      return { status: 'committed', files: [], commit: 'abc1234', detail: null }
    },
    async mergeAll(workers) {
      return workers.map(worker => ({
        index: worker.index,
        branch: worker.branch,
        dir: null,
        status: 'merged',
        files: [],
        detail: null,
      }))
    },
    async release() {},
  }
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-root-'))
}

test('an unregistered key written by two sessions does not merge unrelated cards', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    if (spec.label === 'superagent-1') {
      return completed('Did A.\n\n```attention\n'
        + '{"key":"playtest-time","question":"你能参加哪一个试玩时间？","options":["周六下午","周日晚上"],"reason":"需要本人到场"}\n```')
    }
    if (spec.label === 'superagent-2') {
      return completed('Did B.\n\n```attention\n'
        + '{"key":"playtest-time","question":"试玩安排选哪个时间？","options":["周六下午","周日晚上"],"reason":"两个时间都能排"}\n```')
    }
    return completed('worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, config: { maxParallel: 2, attempts: 1 } })

  const run = await orchestrator.start({ goal: 'playtest scheduling', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  // The key is model-written, not registered by the runtime, so it is only a
  // citation: it may not join two cards. The goal record validates it later.
  assert.equal(finished.attention.items.length, 2, 'an unregistered key must not merge two questions')
  assert.deepEqual(finished.attention.items.map(item => item.source), ['subtask-1', 'subtask-2'])
  assert.deepEqual(finished.attention.items.map(item => item.refKey), ['playtest-time', 'playtest-time'])
  assert.equal(new Set(finished.attention.items.map(item => item.key)).size, 2, 'each card has its own runtime key')
  assert.equal(finished.attentionSeq, 2)
})

test('two genuinely different decisions still keep two cards', async () => {  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    if (spec.label === 'superagent-1') {
      return completed('Did A.\n\n```attention\n'
        + '{"question":"试玩定在哪个时间？","options":["周六下午","周日晚上"],"reason":"需要本人到场"}\n```')
    }
    if (spec.label === 'superagent-2') {
      return completed('Did B.\n\n```attention\n'
        + '{"question":"发布说明用哪种口吻？","options":["正式","口语"],"reason":"两个都能写"}\n```')
    }
    return completed('worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, config: { maxParallel: 2, attempts: 1 } })

  const run = await orchestrator.start({ goal: 'playtest and release', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.attention.items.length, 2)
  assert.deepEqual(finished.attention.items.map(item => item.source), ['subtask-1', 'subtask-2'])
})

test('equal options and near-identical wording never merge two unrelated decisions', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    if (spec.label === 'superagent-1') {
      return completed('Did A.\n\n```attention\n'
        + '{"question":"试玩日期要不要定在周六？","options":["是","否"],"reason":"需要你确认"}\n```')
    }
    if (spec.label === 'superagent-2') {
      return completed('Did B.\n\n```attention\n'
        + '{"question":"发布说明要不要只给团队看？","options":["是","否"],"reason":"需要你确认"}\n```')
    }
    return completed('worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, config: { maxParallel: 2, attempts: 1 } })

  const run = await orchestrator.start({ goal: 'playtest and release', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.attention.items.length, 2, 'a shared 是/否 option set is not an identity')
  // Each card still gets its own referenceable runtime key; the key must not be
  // what merges them, since these are two unrelated decisions.
  const keys = finished.attention.items.map(item => item.key)
  assert.equal(new Set(keys).size, 2, 'two cards must not share a runtime key')
  assert.ok(keys.every(key => key.startsWith(`${run.id.toLowerCase()}:`)), 'the runtime assigns the key')
  assert.ok(finished.attention.items.every(item => !item.refKey), 'an unkeyed question cites nothing')
})

test('an aggregator restating a worker question without a key keeps its own card', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
      }))
    }
    if (spec.label === 'superagent-1') {
      return completed('Did A.\n\n```attention\n'
        + '{"question":"你能参加哪一个试玩时间？","options":["周六下午","周日晚上"],"reason":"需要本人到场"}\n```')
    }
    if (spec.label === 'superagent-aggregate') {
      return completed('Both workers reported.\n\n```attention\n'
        + '{"question":"试玩安排选哪个时间？","options":["周六下午","周日晚上"],"reason":"报告没有定下来"}\n```')
    }
    return completed('worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, config: { maxParallel: 2, attempts: 1 } })

  const run = await orchestrator.start({ goal: 'aggregate a playtest question', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.attention.items.length, 2, 'the summary session cannot merge by similarity alone')
  assert.deepEqual(finished.attention.items.map(item => item.source), ['subtask-1', 'aggregator'])
})

test('a plain question gets a runtime key the aggregator can cite, leaving one card', async () => {
  const spawner = makeSpawner(async spec => {
    if (spec.label === 'superagent-plan') {
      return completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'prepare scheduling' }, { title: 'B', prompt: 'draft briefing' }],
      }))
    }
    if (spec.label === 'superagent-1') {
      // No key: the execution session asks naturally.
      return completed('Schedule checked.\n\n```attention\n'
        + '{"question":"试玩定在周六还是周日？","options":["周六","周日"],"reason":"需要本人选时间"}\n```')
    }
    if (spec.label === 'superagent-aggregate') {
      // Cite only a key the prompt actually offered, as the audit script does.
      const cited = [...spec.prompt.matchAll(/^- key "([^"]+)": (.+)$/gm)]
        .find(match => match[2].includes('试玩'))
      return completed('Both parts done.\n\n```attention\n'
        + JSON.stringify({
          question: '试玩安排选哪个时间？', options: ['周六', '周日'], reason: '汇总时仍未定',
          ...(cited ? { key: cited[1] } : {}),
        })
        + '\n```')
    }
    return completed('worker result')
  })
  const { orchestrator } = orchestratorWith({ spawner, config: { maxParallel: 2, attempts: 1 } })

  const run = await orchestrator.start({ goal: 'prepare playtest scheduling and briefing', parentSessionId: parent.id, parent })
  const finished = await orchestrator.status(run.id, 10)

  assert.equal(finished.attention.items.length, 1, 'citing the registered key keeps one card')
  const [item] = finished.attention.items
  assert.match(item.key, new RegExp(`^${run.id.toLowerCase()}:q\\d+$`), 'the runtime assigns a referenceable key')
  assert.equal(item.refKey, undefined, 'no invented key was appended')
  assert.deepEqual(item.askedBy, ['subtask-1', 'aggregator'])
  const aggregate = spawner.calls.find(call => call.label === 'superagent-aggregate')
  assert.ok(aggregate?.prompt.includes(`key "${item.key}"`), 'the registered key reached the aggregator prompt')
})
