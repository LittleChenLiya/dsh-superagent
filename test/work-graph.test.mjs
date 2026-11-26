import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRouter } from '../lib/router.js'
import { currentFacts, taskImpact } from '../lib/work-context.js'

test('a changed input marks its accepted dependents and preserves other branches', () => {
  const date = (day) => `2026-11-${day}T00:00:00.000Z`
  const phase = (id, dependsOn, day) => ({
    id, title: id, dependsOn, status: 'completed', finishedAt: date(day), runId: `run-${id}`,
  })
  const task = { id: 'release', project: 'workspace', phases: [
    phase('scope', [], 11), phase('draft', ['scope'], 12), phase('review', ['draft'], 13), phase('assets', [], 12),
  ] }
  const facts = ['beta', 'stable'].map((value, index) => ({
    id: `f${index}`, kind: 'decision', origin: 'user', project: task.project, taskId: task.id,
    phaseId: 'scope', key: 'channel', subject: '发布渠道', value, validFrom: date(index ? 14 : 10),
  }))
  facts.push({ ...facts[1], id: 'foreign', project: 'other', phaseId: null, validFrom: date(15) })
  const impact = taskImpact(task, facts, Date.parse(date(16)))
  assert.deepEqual(impact.reReview.map(item => item.phaseId), ['scope', 'draft', 'review'])
  assert.deepEqual(impact.canContinue.map(item => item.phaseId), ['assets'])
  assert.equal(impact.reReview[2].runId, 'run-review')
  assert.match(impact.reReview[0].reason, /发布渠道/)
  assert.equal(taskImpact(task, facts, Date.parse(date(13))), null)
  task.phases[0].finishedAt = date(15)
  assert.deepEqual(taskImpact(task, facts, Date.parse(date(16))).reReview.map(item => item.phaseId), ['draft', 'review'])
  task.phases[1].finishedAt = date(16)
  task.phases[2].finishedAt = date(17)
  assert.equal(taskImpact(task, facts, Date.parse(date(18))), null)
})

// Scratch state stays outside the repository; DSH_TEST_TMP_DIR only redirects it.
const TMP_ROOT = process.env.DSH_TEST_TMP_DIR ?? os.tmpdir()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

async function fixture(label) {
  const base = await fsp.mkdtemp(path.join(TMP_ROOT, `${label}-`))
  const state = path.join(base, 'state')
  await fsp.mkdir(state)
  return { base, state }
}

function harness({ state, projects, tasks, classify = () => ({ action: 'reply', text: '收到' }), execute }) {
  const routers = []
  const boot = () => {
    const router = createRouter({ root: state, catalog: async () => ({ projects, tasks }), classify, execute })
    routers.push(router)
    router.start()
    return router
  }
  return {
    boot,
    async stopAll() {
      for (const router of routers) await router.stop()
    },
  }
}

async function settled(router, what = 'router queue to drain') {
  return until(async () => {
    const snapshot = await router.snapshot()
    return snapshot.pending === 0 ? snapshot : null
  }, what)
}

const receipts = (messages, taskId) => messages.filter(message =>
  message.id?.startsWith(`result-${taskId}-`) && message.taskId === taskId)

test('a plan stays current per workspace across a restart and reads never call the classifier', async () => {
  const { base, state } = await fixture('superagent-graph-plan')
  const projects = [{ name: '发布', cwd: 'release-a' }, { name: '发布备份', cwd: 'release-b' }]
  const tasks = [
    { id: 'goal-release-a', project: 'release-a', title: '发布说明', status: 'running', routed: true },
    { id: 'goal-release-b', project: 'release-b', title: '发布计划', status: 'running', routed: true },
  ]
  let classifyCalls = 0
  const execute = async () => ({ text: '进行中' })
  const { boot, stopAll } = harness({
    state, projects, tasks, execute,
    classify: () => { classifyCalls += 1; return { action: 'reply', text: '不应走到分类器' } },
  })
  let router = boot()
  try {
    await router.submit({ id: 'graph-alias-a', project: 'release-a', text: '把发布说明叫做发版' })
    await router.submit({ id: 'graph-alias-b', project: 'release-b', text: '把发布计划叫做发版' })
    await settled(router)
    await router.submit({ id: 'graph-plan-1', project: 'release-a', text: '记下发版的兼容性策略：先查旧版' })
    await settled(router)

    router = boot()
    await router.submit({ id: 'graph-plan-read-a', project: 'release-a', text: '/方案 发版' })
    const a = await settled(router)
    assert.match(a.messages.at(-1).text, /先查旧版/)

    await router.submit({ id: 'graph-plan-read-b', project: 'release-b', text: '/方案 发版' })
    const b = await settled(router)
    assert.equal(b.messages.at(-1).text, '这项任务还没有已确认的决定。')

    const factsA = await router.taskFacts({ id: 'goal-release-a', project: 'release-a' })
    const factsB = await router.taskFacts({ id: 'goal-release-b', project: 'release-b' })
    assert.deepEqual(factsA.map(item => item.value), ['先查旧版'])
    assert.equal(factsB.length, 0)
    assert.equal(classifyCalls, 0, 'deterministic reads must not call the classifier')
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('phase-scoped decisions, withdrawals, expiry and cross-workspace facts never reach the wrong execution line', async () => {
  const { base, state } = await fixture('superagent-graph-scope')
  const projects = [{ name: '发布', cwd: 'release-a' }, { name: '发布备份', cwd: 'release-b' }]
  const tasks = [{
    id: 'goal-phases', project: 'release-a', title: '发版', status: 'running', routed: true,
    phases: [
      { id: 'p1', title: '兼容性核查', status: 'running' },
      { id: 'p2', title: '发布说明复核', status: 'pending' },
    ],
  }]
  let classifyCalls = 0
  const { boot, stopAll } = harness({
    state, projects, tasks,
    execute: async () => ({ text: '已送达执行方' }),
    classify: () => { classifyCalls += 1; return { action: 'reply', text: '收到' } },
  })
  const router = boot()
  try {
    await router.submit({ id: 'graph-scope-1', project: 'release-a',
      text: '/决定 发版 | 兼容性核查 策略 | 先查旧版 | 1天' })
    await settled(router)
    const p1 = await router.taskFacts(tasks[0], 'p1')
    const p2 = await router.taskFacts(tasks[0], 'p2')
    assert.equal(p1.length, 1)
    assert.equal(p1[0].phaseId, 'p1')
    assert.equal(p2.length, 0, 'another phase must not receive this decision')

    const snapshot = await router.snapshot()
    const saved = snapshot.facts.find(fact => fact.kind === 'decision')
    assert.equal(saved.origin, 'user')
    assert.equal(saved.phaseId, 'p1')
    assert.ok(saved.validFrom)
    assert.ok(saved.expiresAt > Date.now(), 'a 1-day decision is still valid now')

    // Expiry is evaluated on read, never by mutating the record.
    assert.equal(currentFacts([{ ...saved, confirmedAt: saved.confirmedAt }], Date.now() + 2 * 24 * 60 * 60 * 1000).length, 0)

    await router.submit({ id: 'graph-scope-2', project: 'release-b', text: '把发布说明叫做发版' })
    await router.submit({ id: 'graph-scope-3', project: 'release-b', text: '记下发版的语气：正式' })
    await settled(router)
    const isolated = await router.taskFacts(tasks[0])
    assert.equal(isolated.length, 1, 'another workspace must not contribute facts')
    assert.equal(isolated[0].value, '先查旧版')

    await router.submit({ id: 'graph-scope-4', project: 'release-a', text: '/撤销决定 发版 | 兼容性核查 策略' })
    await settled(router)
    assert.equal((await router.taskFacts(tasks[0], 'p1')).length, 0, 'a withdrawal must remove the phase value')

    await router.submit({ id: 'graph-scope-5', project: 'release-a', text: '/状态 发版' })
    await settled(router)
    assert.equal(classifyCalls, 0)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a finished run leaves evidence that a deterministic query can read after a restart', async () => {
  const { base, state } = await fixture('superagent-graph-evidence')
  const projects = [{ name: '发布', cwd: 'release' }]
  const tasks = [{ id: 'goal-evidence', project: 'release', title: '准备发布说明', status: 'running', routed: true }]
  let classifyCalls = 0
  const { boot, stopAll } = harness({
    state, projects, tasks,
    execute: async () => ({ text: '进行中' }),
    classify: () => { classifyCalls += 1; return { action: 'reply', text: '收到' } },
  })
  let router = boot()
  try {
    await router.submit({ id: 'graph-evidence-alias', project: 'release', text: '把准备发布说明叫做发版说明' })
    await settled(router)
    tasks[0].status = 'completed'
    tasks[0].finishedAt = '2026-11-21T04:00:00.000Z'
    router = boot()
    await until(async () => receipts((await router.snapshot()).messages, 'goal-evidence').length === 1, 'delivery receipt')

    router = boot()
    await router.submit({ id: 'graph-evidence-read', project: 'release', text: '/证据 发版说明' })
    const after = await settled(router)
    assert.match(after.messages.at(-1).text, /交付结论/)
    assert.match(after.messages.at(-1).text, /运行/)
    const evidence = after.facts.filter(fact => fact.kind === 'evidence')
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].origin, 'run')
    assert.equal(evidence[0].source, 'run')
    assert.equal(evidence[0].taskId, 'goal-evidence')
    assert.equal(classifyCalls, 0, 'evidence reads are deterministic')
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('legacy state loads, migrates once, and a correction records what it replaced', async () => {
  const { base, state } = await fixture('superagent-graph-migrate')
  const at = Date.now() - 60_000
  const legacy = {
    revision: 3,
    messages: [],
    commands: [],
    memory: [],
    outcomes: {},
    facts: [{
      id: 'legacy-fact', project: 'release', taskId: 'goal-legacy', kind: 'decision', key: '兼容性',
      subject: '兼容性', value: '旧策略', confirmedAt: at, source: 'user-message', revoked: false, expiresAt: null,
    }],
  }
  await fsp.writeFile(path.join(state, 'router.json'), JSON.stringify(legacy))
  const projects = [{ name: '发布', cwd: 'release' }]
  const tasks = [{ id: 'goal-legacy', project: 'release', title: '发版', status: 'running', routed: true }]
  const { boot, stopAll } = harness({ state, projects, tasks, execute: async () => ({ text: '收到' }) })
  let router = boot()
  try {
    const loaded = await router.snapshot()
    assert.equal(loaded.facts[0].value, '旧策略')
    assert.equal(loaded.facts[0].origin, 'user')
    assert.equal(loaded.facts[0].validFrom, at)

    await router.submit({ id: 'graph-migrate-write', project: 'release', text: '/决定 发版 | 兼容性 | 新策略' })
    await settled(router)
    router = boot()
    const current = (await router.snapshot()).facts.filter(fact => fact.kind === 'decision')
    assert.equal(current.length, 1, 'one current value per key')
    assert.equal(current[0].value, '新策略')
    assert.equal(current[0].replaces, 'legacy-fact')

    const file = JSON.parse(await fsp.readFile(path.join(state, 'router.json'), 'utf8'))
    assert.equal(file.version, 2, 'a write persists the migration')
    assert.ok(file.facts.every(fact => fact.origin && fact.validFrom))
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('an answered decision from a prerequisite phase reaches the later session, never an unrelated phase', async () => {
  const { base, state } = await fixture('superagent-graph-lineage')
  const tasks = [{
    id: 'goal-lineage', project: 'game', title: '试玩与镜头', status: 'running', routed: true,
    phases: [
      { id: 'p1', title: '执行', status: 'completed', dependsOn: [] },
      { id: 'p2', title: '汇总', status: 'running', dependsOn: ['p1'] },
      { id: 'p3', title: '无关', status: 'running', dependsOn: [] },
    ],
    decisions: [{
      id: 'd1', phaseId: 'p1', question: '阶段 p1 的执行 agent 需要你决定：你能参加哪一个试玩时间？',
      answer: 'answer', answerText: '周六下午可以', answeredAt: '2026-11-21T02:00:00.000Z',
    }],
  }]
  const { boot, stopAll } = harness({ state, projects: [], tasks })
  const router = boot()
  try {
    const summary = await router.taskFacts(tasks[0], 'p2')
    assert.equal(summary.length, 1)
    assert.equal(summary[0].value, '周六下午可以', 'the later session must see the answer it would otherwise ask again')
    assert.equal((await router.taskFacts(tasks[0], 'p3')).length, 0, 'an unrelated phase must stay isolated')
    assert.equal((await router.taskFacts(tasks[0], 'p1')).length, 1)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})
