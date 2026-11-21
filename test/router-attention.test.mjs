import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRouter } from '../lib/router.js'

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

function harness({ state, projects, tasks, classify, execute }) {
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

test('a known alias in the same workspace answers status and plan without the classifier or a new task', async () => {
  const { base, state } = await fixture('superagent-attention-alias')
  const projects = [{ name: '发布', cwd: 'release' }]
  const tasks = [{ id: 'goal-notes', project: 'release', title: '准备发布说明', status: 'running', routed: true }]
  let classifyCalls = 0
  const executed = []
  const classify = () => {
    classifyCalls += 1
    return { action: 'task', text: '不应走到分类器' }
  }
  const execute = async command => {
    executed.push(command)
    return { text: command.action === 'status' ? '进行中' : '已送达执行方', taskId: command.target }
  }
  const { boot, stopAll } = harness({ state, projects, tasks, classify, execute })
  let router = boot()
  try {
    await router.submit({ id: 'attention-alias-1', project: 'release', text: '把准备发布说明叫做发版说明' })
    await settled(router)
    assert.equal((await router.snapshot()).messages.at(-1).text, '已记录别名「发版说明」。')

    await router.submit({ id: 'attention-status-1', project: 'release', text: '/状态 发版说明' })
    const status = await settled(router)
    assert.equal(status.messages.at(-1).text, '进行中')
    assert.equal(executed.at(-1).action, 'status')
    assert.equal(executed.at(-1).target, 'goal-notes')

    await router.submit({ id: 'attention-plan-1', project: 'release', text: '/方案 发版说明' })
    const plan = await settled(router)
    assert.equal(plan.messages.at(-1).text, '这项任务还没有已确认的决定。')

    assert.equal(classifyCalls, 0, 'alias status and plan reads must not call the classifier')
    assert.equal(executed.filter(command => command.action === 'task').length, 0, 'a read must never create a task')
    assert.equal(tasks.length, 1)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('one terminal receipt per finished timestamp survives polling and restarts, and a new finishedAt gets its own receipt', async () => {
  const { base, state } = await fixture('superagent-attention-receipt')
  const projects = [{ name: '发布', cwd: 'release' }]
  const tasks = [{ id: 'goal-deliver', project: 'release', title: '整理发布说明', status: 'running', routed: true }]
  const classify = () => ({ action: 'reply', text: '收到' })
  const execute = async () => ({ text: '已送达执行方' })
  const { boot, stopAll } = harness({ state, projects, tasks, classify, execute })
  let router = boot()
  try {
    await settled(router, 'initial poll')
    assert.equal(receipts((await router.snapshot()).messages, 'goal-deliver').length, 0)

    tasks[0].status = 'completed'
    tasks[0].finishedAt = '2026-11-21T02:00:00.000Z'
    router = boot()
    const first = await until(async () => {
      const hits = receipts((await router.snapshot()).messages, 'goal-deliver')
      return hits.length === 1 ? hits : null
    }, 'first delivery receipt')
    assert.equal(first[0].text, '「整理发布说明」已交付。')

    // Extra polling cycles and a restart must not repeat the same terminal state.
    await sleep(150)
    await settled(router, 'poll after delivery')
    router = boot()
    await settled(router, 'restart without new work')
    await sleep(150)
    const repeated = receipts((await router.snapshot()).messages, 'goal-deliver')
    assert.equal(repeated.length, 1, 'the same terminal receipt must appear exactly once')
    assert.equal(new Set(repeated.map(message => message.id)).size, 1)

    // A later run finishing with a new timestamp is a distinct delivery.
    tasks[0].finishedAt = '2026-11-21T03:00:00.000Z'
    router = boot()
    const both = await until(async () => {
      const hits = receipts((await router.snapshot()).messages, 'goal-deliver')
      return hits.length === 2 ? hits : null
    }, 'second delivery receipt')
    assert.equal(new Set(both.map(message => message.id)).size, 2, 'a new finishedAt needs its own message id')
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a supplement naming the earlier foreground task still targets it after another background task delivered', async () => {
  const { base, state } = await fixture('superagent-attention-binding')
  const projects = [{ name: '发布', cwd: 'release' }]
  const tasks = [
    { id: 'goal-notes', project: 'release', title: '准备发布说明', status: 'running', routed: true },
    { id: 'goal-feedback', project: 'release', title: '汇总反馈', status: 'running', routed: true },
  ]
  const executed = []
  const initial = '发版说明那件事，把结尾的注意事项补一段'
  const phaseSpecific = '发版说明那件事，正文复核阶段补一个注意事项'
  const phaseAmbiguous = '发版说明那件事，再核对一下语气'
  let classifyCalls = 0
  const classify = ({ input, tasks: candidates }) => {
    classifyCalls += 1
    assert.ok([initial, phaseSpecific, phaseAmbiguous].includes(input))
    const ids = candidates.map(task => task.id)
    assert.ok(ids.includes('goal-notes'), 'the named foreground task must stay visible to the classifier')
    assert.ok(ids.includes('goal-feedback'), 'the freshly delivered task must stay a valid candidate')
    // A classifier anchored on the freshest delivery picks the background task.
    return { action: 'followup', taskId: 'goal-feedback', text: '模型为反馈任务改写的要求',
      ...(input === initial ? {} : { phaseId: 'p1' }) }
  }
  const execute = async command => {
    executed.push(command)
    return { text: '已送达执行方', taskId: command.target }
  }
  const { boot, stopAll } = harness({ state, projects, tasks, classify, execute })
  let router = boot()
  try {
    await router.submit({ id: 'attention-alias-2', project: 'release', text: '把准备发布说明叫做发版说明' })
    await settled(router)

    tasks[1].status = 'completed'
    tasks[1].finishedAt = '2026-11-21T02:30:00.000Z'
    router = boot()
    await until(async () => receipts((await router.snapshot()).messages, 'goal-feedback').length === 1,
      'background delivery receipt')

    await router.submit({ id: 'attention-followup-1', project: 'release', text: initial })
    const after = await settled(router)

    assert.equal(classifyCalls, 1)
    assert.deepEqual(executed.map(command => [command.action, command.target]), [['followup', 'goal-notes']],
      `an explicit alias must keep the supplement on the original task; router replied: ${after.messages.at(-1).text}`)
    assert.equal(executed[0].text, initial)

    tasks[0].phases = [
      { id: 'p1', title: '写初稿', status: 'running' },
      { id: 'p2', title: '正文复核', status: 'pending' },
    ]
    await router.submit({ id: 'attention-followup-2', project: 'release', text: phaseSpecific })
    await settled(router)
    assert.equal(executed[1].target, 'goal-notes')
    assert.equal(executed[1].phaseId, 'p2', 'a phase ID from a different task must not be reused')

    await router.submit({ id: 'attention-followup-3', project: 'release', text: phaseAmbiguous })
    const unresolved = await settled(router)
    assert.equal(executed.length, 2)
    assert.deepEqual(unresolved.messages.at(-1).taskIds, ['goal-notes'])
    assert.match(unresolved.messages.at(-1).text, /写明要补充到哪个/)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})
