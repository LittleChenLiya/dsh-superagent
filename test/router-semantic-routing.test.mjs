import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRouter } from '../lib/router.js'
import { inferFollowupPhase } from '../lib/work-context.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) {
  for (let i = 0; i < 500; i += 1) {
    const value = await check()
    if (value) return value
    await sleep(10)
  }
  assert.fail('router queue did not drain')
}
async function fixture(label) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`))
  const state = path.join(base, 'state')
  await fsp.mkdir(state)
  return { base, state }
}
async function settled(router) {
  return until(async () => {
    const snapshot = await router.snapshot()
    return snapshot.pending === 0 ? snapshot : null
  })
}

const phasedTask = {
  id: 'goal-release', project: 'release', title: '发布说明', status: 'running', routed: true,
  phases: [
    { id: 'draft', title: '初稿撰写', objective: '起草发布文案', status: 'completed' },
    { id: 'compat', title: '兼容性', objective: '检查迁移和兼容说明', aliases: ['兼容说明'], status: 'running' },
    { id: 'ship', title: '发布', objective: '部署上线', status: 'pending' },
  ],
}

test('phase routing uses semantics, recognizes whole-goal requests, and clarifies only real ambiguity', () => {
  assert.equal(inferFollowupPhase('把兼容说明再补详细一点', phasedTask).phaseId, 'compat')
  assert.equal(inferFollowupPhase('检查一下迁移注意事项', phasedTask).phaseId, 'compat')
  assert.equal(inferFollowupPhase('部署上线前再确认一次', phasedTask).phaseId, 'ship')
  assert.equal(inferFollowupPhase('再核对一下语气', phasedTask).kind, 'ambiguous')
  assert.equal(inferFollowupPhase('兼容性和发布都要补充', phasedTask).kind, 'cross-phase')
})

test('followup phase inference and explicit whole-goal scope avoid unnecessary clarification', async () => {
  const { base, state } = await fixture('superagent-semantic-phase')
  const executions = []
  let router
  try {
    router = createRouter({
      root: state, catalog: async () => ({ projects: [{ name: '发布', cwd: 'release' }], tasks: [phasedTask] }),
      classify: () => ({ action: 'followup', taskId: 'goal-release', text: '补充要求' }),
      execute: async decision => { executions.push(decision); return { text: '已送达', taskId: decision.target } },
    })
    router.start()
    await router.submit({ id: 'phase-semantic-1', project: 'release', text: '把兼容说明再补详细一点' })
    await settled(router)
    assert.equal(executions[0].phaseId, 'compat')
    assert.ok(executions[0].snapshot.facts !== undefined, 'followup carries the bounded snapshot')

    await router.submit({ id: 'phase-goal-1', project: 'release', text: '所有阶段都要遵守新的语气' })
    await settled(router)
    assert.equal(executions[1].phaseId, undefined)

    await router.submit({ id: 'phase-ambiguous-1', project: 'release', text: '再核对一下语气' })
    const snapshot = await settled(router)
    assert.equal(executions.length, 2)
    assert.match(snapshot.messages.at(-1).text, /多个阶段/)
  } finally {
    await router?.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('answer-decision exposes pending choices and validates task and project ownership', async () => {
  const { base, state } = await fixture('superagent-answer-decision')
  const task = { ...phasedTask, decisions: [
    { id: 'decision-time', question: '试玩定在哪个时间？', options: ['answer', 'stop'], source: { options: ['周六下午', '周日晚上'] } },
  ] }
  const other = { id: 'goal-other', project: 'other', title: '其他任务', status: 'running', decisions: [
    { id: 'decision-other', question: '选哪个？', options: ['A', 'B'] },
  ] }
  const contexts = []
  const executions = []
  let router
  try {
    router = createRouter({
      root: state,
      catalog: async () => ({ projects: [{ name: '发布', cwd: 'release' }, { name: '其他', cwd: 'other' }], tasks: [task, other] }),
      classify: context => {
        contexts.push(context)
        if (context.input === '选 B，因为周末更方便') return { action: 'answer-decision', taskId: 'goal-release',
          decisionId: 'decision-time', answer: 'B', note: '周末更方便' }
        return { action: 'answer-decision', taskId: 'goal-other', decisionId: 'decision-time', answer: 'A' }
      },
      execute: async decision => { executions.push(decision); return { text: '已记录你的选择。' } },
    })
    router.start()
    await router.submit({ id: 'answer-decision-1', project: 'release', text: '选 B，因为周末更方便' })
    await settled(router)
    assert.deepEqual(contexts[0].tasks.find(item => item.id === 'goal-release').decisions[0], {
      id: 'decision-time', taskId: 'goal-release', question: '试玩定在哪个时间？',
      options: ['周六下午', '周日晚上'], phaseId: null,
    })
    assert.deepEqual({ action: executions[0].action, target: executions[0].target, decisionId: executions[0].decisionId,
      answer: executions[0].answer, note: executions[0].note }, {
      action: 'answer-decision', target: 'goal-release', decisionId: 'decision-time', answer: 'B', note: '周末更方便',
    })
    await router.submit({ id: 'answer-decision-2', project: 'release', text: '回答别的任务' })
    const snapshot = await settled(router)
    assert.equal(executions.length, 1, 'a decision cannot cross task/project ownership')
    assert.match(snapshot.messages.at(-1).text, /待决问题/)
  } finally {
    await router?.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('workspace paths and a unique recent workspace are inferred without user syntax', async () => {
  const { base, state } = await fixture('superagent-workspace-infer')
  const contexts = []
  const executions = []
  let router
  try {
    router = createRouter({
      root: state,
      catalog: async () => ({ projects: [{ name: '发布', cwd: 'release' }, { name: '反馈', cwd: 'feedback' }], tasks: [] }),
      classify: context => { contexts.push(context); return { action: 'task', title: '新任务', useContext: false } },
      execute: async decision => { executions.push(decision); return { text: '已接下', taskId: 'goal-new' } },
    })
    router.start()
    await router.submit({ id: 'workspace-path-1', text: '检查 release/docs/release.md 的链接' })
    await settled(router)
    assert.equal(executions[0].project, 'release')
    assert.equal(contexts[0].project, 'p1')

    await router.submit({ id: 'workspace-recent-1', text: '再写一段全新的说明' })
    await settled(router)
    assert.equal(executions[1].project, 'release', 'the unique recent workspace is reused')
  } finally {
    await router?.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('natural language schedules receive safe defaults and nine-item lists become batch actions', async () => {
  const { base, state } = await fixture('superagent-natural-actions')
  const executions = []
  let classifyCalls = 0
  let router
  try {
    router = createRouter({
      root: state, catalog: async () => ({ projects: [{ name: '发布', cwd: 'release' }], tasks: [] }),
      classify: () => { classifyCalls += 1; return { action: 'schedule', name: '每日检查', prompt: '每天检查发布状态',
        relativePath: '../escape.md', triggerType: 'every', everyMs: -1, timeZone: 'Invalid/Zone', budget: {} } },
      execute: async decision => { executions.push(decision); return { text: '已创建自动化', taskId: decision.target } },
    })
    router.start()
    await router.submit({ id: 'schedule-natural-1', project: 'release', text: '以后每天检查发布状态' })
    await settled(router)
    assert.deepEqual({ action: executions[0].action, relativePath: executions[0].relativePath,
      triggerType: executions[0].triggerType, everyMs: executions[0].everyMs, budget: executions[0].budget }, {
      action: 'schedule', relativePath: 'artifacts/automation.md', triggerType: 'every', everyMs: 60000,
      budget: { maxCost: 1, maxWallClockMinutes: 30 },
    })
    assert.equal(executions[0].prompt, '每天检查发布状态')

    const list = Array.from({ length: 9 }, (_, index) => `${index + 1}. 核对配置 ${index + 1}`).join('\n')
    await router.submit({ id: 'batch-natural-1', project: 'release', text: list })
    await settled(router)
    assert.equal(classifyCalls, 1, 'a long independent list bypasses the classifier')
    assert.equal(executions[1].action, 'batch')
    assert.equal(executions[1].batch.length, 9)
    assert.equal(executions[1].batch[0].objective, '核对配置 1')
  } finally {
    await router?.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('task snapshots include older messages, durable facts, and task reports within bounds', async () => {
  const { base, state } = await fixture('superagent-bounded-snapshot')
  const messages = Array.from({ length: 30 }, (_, index) => ({ id: `seed-${index}`, role: index % 2 ? 'assistant' : 'user',
    text: index === 0 ? '兼容性必须保留依据' : `历史消息 ${index}`, project: 'release', at: Date.now() - 30000 + index }))
  await fsp.writeFile(path.join(state, 'router.json'), JSON.stringify({ version: 2, revision: 1, messages,
    commands: [], memory: [], outcomes: {}, facts: [{ id: 'fact-1', project: 'release', taskId: 'goal-release',
      phaseId: null, kind: 'decision', key: 'tone', subject: '语气', value: '克制', confirmedAt: Date.now() }] }))
  const task = { ...phasedTask, report: '最终报告：兼容性已验证。', artifacts: [{ path: 'reports/release.md', summary: '发布报告' }] }
  const executions = []
  let router
  try {
    router = createRouter({
      root: state, catalog: async () => ({ projects: [{ name: '发布', cwd: 'release' }], tasks: [task] }),
      classify: () => ({ action: 'task', title: '继续发布', useContext: true }),
      execute: async decision => { executions.push(decision); return { text: '已接下', taskId: 'goal-new' } },
    })
    router.start()
    await router.submit({ id: 'snapshot-bounded-1', project: 'release', text: '沿用之前的依据继续' })
    await settled(router)
    const snapshot = executions[0].snapshot
    assert.ok(snapshot.length > 10, 'the snapshot is not limited to ten messages')
    assert.ok(snapshot.messages.some(message => message.text.includes('兼容性必须保留依据')))
    assert.equal(snapshot.facts[0].value, '克制')
    assert.ok(snapshot.artifacts.some(item => item.summary.includes('兼容性已验证')))
    assert.ok(snapshot.length <= 36 && snapshot.facts.length <= 16 && snapshot.artifacts.length <= 12)
  } finally {
    await router?.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})
