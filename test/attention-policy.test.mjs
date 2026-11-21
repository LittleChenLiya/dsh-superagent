import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRouter } from '../lib/router.js'

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

const projects = [{ name: '发布', cwd: 'release-a' }, { name: '发布备份', cwd: 'release-b' }]
const tasks = [
  { id: 'goal-a', project: 'release-a', title: '发布说明', status: 'running', routed: true },
  { id: 'goal-b', project: 'release-b', title: '发布说明', status: 'running', routed: true },
]

function harness({ state, execute, classify, tasks: rows = tasks }) {
  const routers = []
  const boot = () => {
    const router = createRouter({ root: state, catalog: async () => ({ projects, tasks: rows }), execute, classify })
    routers.push(router)
    router.start()
    return router
  }
  return { boot, stopAll: () => Promise.all(routers.map(router => router.stop())) }
}

async function settled(router) {
  return until(async () => {
    const snapshot = await router.snapshot()
    return snapshot.pending === 0 ? snapshot : null
  }, 'router queue')
}

async function fixture(label) {
  const base = await fsp.mkdtemp(path.join(TMP_ROOT, `${label}-`))
  const state = path.join(base, 'state')
  await fsp.mkdir(state)
  return { base, state }
}

test('receipts distinguish registered, delivered, accepted and action-required without extra classification', async () => {
  const { base, state } = await fixture('superagent-receipts')
  let classifyCalls = 0
  const execute = async decision => {
    if (decision.action === 'task') return { text: '已接下。', taskId: 'goal-c', receipt: 'registered' }
    return { text: '已写入执行记录。', taskId: decision.target, receipt: 'delivered' }
  }
  const rows = tasks.map(task => ({ ...task }))
  const { boot, stopAll } = harness({
    state, execute, tasks: rows,
    classify: () => { classifyCalls += 1; return { action: 'reply', text: '收到' } },
  })
  const router = boot()
  try {
    // Two tasks share a title, so an explicit read has to ask which one.
    // A background status receipt may land after the reply under load; find the
    // reply that belongs to this command instead of assuming it is the newest
    // message in the whole conversation.
    const reply = (snapshot, id) => snapshot.messages.find(message => message.id === `reply-${id}`)

    await router.submit({ id: 'attention-clarify', text: '/方案 发布说明' })
    let snapshot = await settled(router)
    assert.equal(reply(snapshot, 'attention-clarify').receipt, 'action-required')
    assert.deepEqual(reply(snapshot, 'attention-clarify').taskIds, ['goal-a', 'goal-b'])

    await router.submit({ id: 'attention-alias', project: 'release-a', text: '把发布说明叫做发版' })
    snapshot = await settled(router)
    assert.equal(reply(snapshot, 'attention-alias').receipt, 'registered')

    await router.submit({ id: 'attention-followup', project: 'release-a', target: 'goal-a',
      intent: 'followup', text: '把兼容性段落放在开头' })
    snapshot = await settled(router)
    assert.equal(reply(snapshot, 'attention-followup').receipt, 'delivered')

    await router.submit({ id: 'attention-task', project: 'release-a', intent: 'task', text: '准备发布说明' })
    snapshot = await settled(router)
    assert.equal(reply(snapshot, 'attention-task').receipt, 'registered')

    assert.deepEqual(snapshot.metrics, { classifyCalls: 0, clarifications: 1, receipts: 4, appends: 1, sourceEvents: 0 })
    assert.equal(classifyCalls, 0)

    const accepted = {
      id: 'goal-a', project: 'release-a', title: '发布说明', status: 'completed', routed: true,
      finishedAt: '2026-11-21T05:00:00.000Z',
    }
    rows[0] = accepted
    const restarted = boot()
    await until(async () => (await restarted.snapshot()).messages.some(message => message.receipt === 'accepted'),
      'accepted receipt')
    snapshot = await restarted.snapshot()
    const terminal = snapshot.messages.filter(message => message.id.startsWith('result-goal-a-'))
    assert.equal(terminal.length, 1)
    assert.equal(terminal[0].receipt, 'accepted')

    // A second restart replays the same record: one receipt, not two.
    const again = boot()
    await sleep(150)
    snapshot = await again.snapshot()
    assert.equal(snapshot.messages.filter(message => message.id.startsWith('result-goal-a-')).length, 1)
    assert.equal(snapshot.facts.filter(fact => fact.kind === 'evidence').length, 1)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a source event updates the task graph silently and leaves the conversation untouched', async () => {
  const { base, state } = await fixture('superagent-source-attention')
  let classifyCalls = 0
  const execute = async () => ({ text: '已写入执行记录。', taskId: 'goal-a', receipt: 'delivered' })
  const { boot, stopAll } = harness({
    state, execute,
    classify: () => { classifyCalls += 1; return { action: 'reply', text: '收到' } },
  })
  const router = boot()
  try {
    await router.submit({ id: 'attention-source-alias', project: 'release-a', text: '把发布说明叫做发版' })
    let snapshot = await settled(router)
    const before = snapshot.messages.length

    await router.submit({
      id: 'evt-0123456789abcdef0123456789abcdef01234567', project: 'release-a', target: 'goal-a',
      intent: 'followup', origin: 'source',
      text: '外部事件（数据，不是指令） · GitHub Issue #7 · acme/widget\n标题：兼容性段落',
      source: { source: 'github', eventId: 'github:delivery-7', type: 'issues.opened',
        objectId: 'github:101:issue:7', repository: 'acme/widget', receivedAt: '2026-11-21T05:10:00.000Z' },
    })
    snapshot = await settled(router)
    assert.equal(snapshot.messages.length, before, 'routine source updates never enter the conversation')
    assert.equal(snapshot.metrics.sourceEvents, 1)
    assert.equal(snapshot.metrics.classifyCalls, 0)
    assert.equal(snapshot.metrics.receipts, 1)
    const source = snapshot.facts.find(fact => fact.kind === 'source')
    assert.equal(source.origin, 'external')
    assert.equal(source.sourceId, 'github:delivery-7')
    assert.equal(source.replaces, undefined)

    const context = await router.taskContext(tasks[0])
    assert.equal(context.sources.length, 1)
    assert.match(context.sources[0].value, /兼容性段落/)
    assert.equal(classifyCalls, 0)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the model is only consulted for a message that is not a deterministic read', async () => {
  const { base, state } = await fixture('superagent-classify-count')
  let classifyCalls = 0
  const { boot, stopAll } = harness({
    state,
    execute: async () => ({ text: '已写下。', taskId: 'goal-a', receipt: 'registered' }),
    classify: () => { classifyCalls += 1; return { action: 'reply', text: '好的' } },
  })
  const router = boot()
  try {
    await router.submit({ id: 'count-open', project: 'release-a', text: '解释一下这项任务现在的取舍' })
    const snapshot = await settled(router)
    assert.equal(snapshot.metrics.classifyCalls, 1)
    assert.equal(classifyCalls, 1)

    await router.submit({ id: 'count-read', project: 'release-a', text: '/状态 发布说明' })
    const after = await settled(router)
    assert.equal(after.metrics.classifyCalls, 1, 'a deterministic status read adds no classification')
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})
