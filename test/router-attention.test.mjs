import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRouter, readRouterDecision } from '../lib/router.js'
import { approvePlan, createCandidatePlanPreview } from '../lib/plan-preview.js'

// Scratch state stays outside the repository; DSH_TEST_TMP_DIR only redirects it.
const TMP_ROOT = process.env.DSH_TEST_TMP_DIR ?? os.tmpdir()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(check, what, timeoutMs = 15000) {
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

const CANDIDATE_MODEL = 'test/candidate-model'
const CANDIDATE_PRICE = { input: 1, output: 1, cacheRead: 0, currency: 'USD' }

async function candidateSubmission(base, id) {
  const project = path.join(base, 'workspace').replaceAll('\\', '/')
  const goal = { title: 'Ship candidate release', description: 'Draft and review the release notes.' }
  const preview = createCandidatePlanPreview({
    goal,
    project,
    subtasks: [
      {
        id: 'draft', title: 'Draft release notes', prompt: 'Write the release notes.',
        dependsOn: [], acceptance: [{ text: 'The release notes cover every change.' }],
        deliverables: ['docs/release.md'], maxRounds: 2, maxWallClockMinutes: 15,
      },
      {
        id: 'review', title: 'Review evidence', objective: 'Check every claim against the evidence.',
        dependsOn: ['draft'], acceptance: ['Every claim has evidence.'],
        deliverables: [], maxRounds: 3, maxWallClockMinutes: 20,
      },
    ],
    capabilities: ['analysis', `model.${CANDIDATE_MODEL}`],
    budget: { maxCost: 1 },
    model: { name: CANDIDATE_MODEL, pricing: CANDIDATE_PRICE },
    permissionScope: {
      tools: [], allow: [`model.${CANDIDATE_MODEL}`], deny: ['network', 'shell.execute'], approvalMode: 'manual',
    },
    runtime: { cwd: project, isolation: 'workspace', provider: 'local' },
  })
  assert.equal(preview.status, 'ready')
  const planApproval = approvePlan(preview, { planDigest: preview.planDigest, approvedBy: 'router-test' })
  const candidatePlan = structuredClone(preview.inputSnapshot)
  return {
    project, preview, planApproval, candidatePlan,
    input: {
      id, text: JSON.stringify(goal), project, target: null, intent: 'task',
      candidatePlan, planApproval,
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

test('a model permission failure in a finish chunk is shown before any task is dispatched', async () => {
  const { base, state } = await fixture('superagent-router-model-permission')
  const original = '帮我看看新作业和课程更新。我的塔防空格镜头太近，改好以后打包，打好了发消息给我。顺便看看最近的 PR 和今晚吃什么。'
  const model = { provider: 'local', model: 'denied-model' }
  let dispatches = 0
  const h = harness({
    state, projects: [], tasks: [],
    classify: () => readRouterDecision((async function* () {
      yield { type: 'text-delta', text: '{"action":"task","text":"incomplete request"}' }
      yield { type: 'finish', reason: { kind: 'error', failure: {
        code: 'AUTH', message: '403 gateway rejected request [private diagnostic]',
      } } }
    })(), model),
    execute: async () => { dispatches++ },
  })
  try {
    const router = h.boot()
    await router.submit({ id: 'denied-route', text: original })
    const messages = (await settled(router)).messages
    assert.equal(messages.find(message => message.role === 'user').text, original)
    const response = messages.find(message => message.role === 'assistant')
    assert.equal(response.error, true)
    assert.match(response.text, /local\/denied-model 的访问被拒绝/)
    assert.doesNotMatch(response.text, /private diagnostic|未返回有效指令/)
    assert.equal(dispatches, 0)
  } finally {
    await h.stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('stream parsing still accepts fenced JSON and reports malformed output separately', async () => {
  const model = { provider: 'local', model: 'test-model' }
  const chunks = text => (async function* () {
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  assert.deepEqual(await readRouterDecision(chunks('```json\n{"action":"reply","text":"OK"}\n```'), model),
    { action: 'reply', text: 'OK' })
  await assert.rejects(readRouterDecision(chunks('reply without JSON'), model), /未返回有效指令/)
})

test('a new task forwards the complete original request even when the router model focuses on one item', async () => {
  const { base, state } = await fixture('superagent-route-original')
  const original = '帮我看看作业。塔防镜头太近，帮我改一下。再看看我的 PR 和晚饭。对了，塔防改好了打包，打包成功再告诉我。'
  const dispatched = []
  const h = harness({
    state, projects: [], tasks: [],
    classify: async () => ({ action: 'task', title: '调整塔防镜头', text: '塔防镜头太近，帮我改一下。' }),
    execute: async decision => { dispatched.push(decision); return { text: '已接单', taskId: 'goal' } },
  })
  try {
    const router = h.boot()
    await router.submit({ id: 'mixed-request', text: original })
    await settled(router)
    assert.equal(dispatched.length, 1)
    assert.equal(dispatched[0].text, original)
  } finally {
    await h.stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

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

test('an answerable part reaches the chat before a slow dispatch, and a replay adds neither answer nor task', async () => {
  const { base, state } = await fixture('superagent-instant-answer')
  const releases = []
  let dispatches = 0
  let received = null
  const text = '塔防空格镜头太近，改好以后打包；顺便想今晚三个朋友吃什么，人均一百的家常菜。'
  const { boot, stopAll } = harness({
    state, projects: [], tasks: [],
    classify: async () => ({
      action: 'task', title: '塔防镜头和晚饭', text,
      reply: '今晚可以点清蒸鲈鱼、番茄炒蛋、蒜蓉西兰花，再加一个冬瓜排骨汤，人均大约八十。',
    }),
    execute: async decision => {
      dispatches += 1
      received = decision
      await new Promise(resolve => releases.push(resolve))
      return { text: '塔防镜头已交给执行方。', taskId: 'goal-tower' }
    },
  })
  const router = boot()
  try {
    await router.submit({ id: 'mixed-route-1', text })
    // The dispatch is deliberately stuck: the instant answer must already be in
    // the conversation at this point, not after the planner returns.
    const during = await until(async () => {
      if (releases.length === 0) return null
      const snapshot = await router.snapshot()
      return snapshot.messages.some(message => message.id === 'instant-mixed-route-1') ? snapshot : null
    }, 'the instant answer while the task is still dispatching')
    assert.equal(during.pending, 1)
    assert.equal(dispatches, 1)
    const instant = during.messages.find(message => message.id === 'instant-mixed-route-1')
    assert.match(instant.text, /清蒸鲈鱼/)
    assert.equal(instant.for, 'mixed-route-1')
    assert.equal(during.messages.find(message => message.role === 'user').text, text, 'the background task keeps the full original text')
    assert.match(received?.deliveredReply ?? '', /清蒸鲈鱼/, 'the planner must know this part already reached the chat')

    // A duplicate delivery of the same request id must not start a second task
    // or repeat the immediate answer.
    await router.submit({ id: 'mixed-route-1', text })
    releases.shift()()
    const after = await until(async () => {
      const snapshot = await router.snapshot()
      return snapshot.pending === 0 && snapshot.messages.some(message => message.taskId === 'goal-tower') ? snapshot : null
    }, 'the dispatched task receipt')
    assert.equal(dispatches, 1)
    assert.equal(after.messages.filter(message => message.id === 'instant-mixed-route-1').length, 1)
    assert.equal(after.messages.filter(message => message.taskId === 'goal-tower').length, 1)
  } finally {
    for (const release of releases) release()
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a finished phase is delivered once with its conclusion and evidence entry, while unfinished phases keep their real status', async () => {
  const { base, state } = await fixture('superagent-phase-receipt')
  const tasks = [{
    id: 'goal-playtest', project: 'game', title: '塔防试玩与镜头', status: 'running', routed: true,
    phases: [
      {
        id: 'p1', title: '镜头方案', status: 'completed', dependsOn: [], runId: 'run-1',
        finishedAt: '2026-11-21T02:00:00.000Z',
        summary: '把镜头切到敌人来的一侧，门口留 1.5 秒空镜；复验清单 4 项。',
      },
      { id: 'p2', title: '试玩安排', status: 'needs-decision', dependsOn: ['p1'] },
    ],
  }]
  let router
  const { boot, stopAll } = harness({
    state, projects: [{ name: 'game', cwd: 'game' }], tasks,
    classify: () => ({ action: 'status' }), execute: async () => ({ text: '任务仍在进行。' }),
  })
  const phaseReceipts = messages => messages.filter(message => message.id?.startsWith('phase-goal-playtest-p1-'))
  try {
    router = boot()
    const first = await until(async () => {
      const hits = phaseReceipts((await router.snapshot()).messages)
      return hits.length === 1 ? hits : null
    }, 'the phase receipt')
    assert.match(first[0].text, /门口留 1\.5 秒空镜/)
    assert.match(first[0].text, /复验清单与证据/)
    assert.equal(first[0].taskId, 'goal-playtest')
    assert.equal(first[0].phaseId, 'p1')
    assert.equal(first[0].runId, 'run-1')

    // Polling and a restart must not repeat the same finished phase.
    await sleep(150)
    await settled(router, 'poll after the phase receipt')
    await stopAll()
    router = boot()
    await settled(router, 'restart after the phase receipt')
    await sleep(150)
    assert.equal(phaseReceipts((await router.snapshot()).messages).length, 1)

    // A failed phase is not presented as accepted work, and the closing note
    // names what did not arrive.
    tasks[0].phases[1].status = 'failed'
    tasks[0].phases[1].finishedAt = '2026-11-21T03:00:00.000Z'
    tasks[0].status = 'partial'
    tasks[0].finishedAt = '2026-11-21T03:00:00.000Z'
    const closing = await until(async () => {
      const messages = (await router.snapshot()).messages
      return messages.find(message => message.id?.startsWith('result-goal-playtest-')) ?? null
    }, 'the closing note')
    assert.match(closing.text, /未交付/)
    assert.match(closing.text, /p2「试玩安排」failed/)
    assert.doesNotMatch(closing.text, /p2「试玩安排」已完成/)
    assert.equal(phaseReceipts((await router.snapshot()).messages).length, 1, 'a failed phase needs no accepted receipt')
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a state from before the upgrade does not backfill receipts for work already finished', async () => {
  const { base, state } = await fixture('superagent-phase-receipt-upgrade')
  const tasks = [{
    id: 'goal-old', project: 'game', title: '上一轮完成的任务', status: 'completed', routed: true,
    finishedAt: '2026-11-20T02:00:00.000Z',
    phases: [{
      id: 'p1', title: '旧阶段', status: 'completed', dependsOn: [], runId: 'run-old',
      finishedAt: '2026-11-20T02:00:00.000Z', summary: '旧版本完成时没有阶段回执。',
    }],
  }]
  // Exactly what the previous build persisted: no phaseOutcomes at all.
  await fsp.writeFile(path.join(state, 'router.json'), JSON.stringify({
    version: 2, revision: 4, messages: [], commands: [], memory: [], outcomes: {}, facts: [],
  }))
  const { boot, stopAll } = harness({
    state, projects: [{ name: 'game', cwd: 'game' }], tasks,
    classify: () => ({ action: 'status' }), execute: async () => ({ text: '任务仍在进行。' }),
  })
  const phaseReceipts = messages => messages.filter(message => message.id?.startsWith('phase-'))
  try {
    const router = boot()
    await settled(router, 'the upgrade pass')
    await sleep(200)
    assert.equal(phaseReceipts((await router.snapshot()).messages).length, 0,
      'historical work must not appear as a new phase receipt')

    // Work that finishes after the boundary does get its own receipt.
    tasks[0].phases.push({
      id: 'p2', title: '新阶段', status: 'completed', dependsOn: ['p1'], runId: 'run-new',
      finishedAt: '2026-11-21T05:00:00.000Z', summary: '升级后完成的新阶段。',
    })
    const fresh = await until(async () => {
      const hits = phaseReceipts((await router.snapshot()).messages)
        .filter(message => message.phaseId === 'p2')
      return hits.length === 1 ? hits : null
    }, 'the post-upgrade phase receipt')
    assert.match(fresh[0].text, /升级后完成的新阶段/)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('asking which decisions are pending answers with the options without parking the task', async () => {
  const { base, state } = await fixture('superagent-ask-decisions')
  const tasks = [{
    id: 'goal-playtest', project: 'game', title: '试玩安排', status: 'running', routed: true,
    // The goal card stores the answer/stop mechanics; the worker's own choices
    // are what a person can actually pick, so those must reach the chat.
    decisions: [{ id: 'd1', question: '阶段 p2 的执行 agent 需要你决定：试玩定在哪个时间？',
      options: ['answer', 'stop'], source: { options: ['周六下午', '周日晚上'] }, answer: null }],
  }]
  let executed = 0
  const { boot, stopAll } = harness({
    state, projects: [{ name: 'game', cwd: 'game' }], tasks,
    classify: () => ({ action: 'status' }), execute: async () => { executed += 1; return { text: '状态已更新。' } },
  })
  const router = boot()
  try {
    await router.submit({ id: 'ask-decisions', project: 'game', text: '现在哪些事需要我决定？' })
    const snapshot = await settled(router)
    const answer = snapshot.messages.at(-1)
    assert.equal(answer.role, 'assistant')
    assert.match(answer.text, /试玩定在哪个时间/)
    assert.match(answer.text, /周六下午 \/ 周日晚上/)
    assert.doesNotMatch(answer.text, /answer \/ stop/, 'the mechanics are not a person\'s choice')
    assert.equal(executed, 0, 'a read-only question must not start or park a task')
    assert.deepEqual(snapshot.messages.at(-1).taskIds, ['goal-playtest'])
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('an approved candidate plan is accepted, advertised, and persisted without its approval credential', async () => {
  const { base, state } = await fixture('superagent-candidate-approved')
  const candidate = await candidateSubmission(base, 'candidate-approved-1')
  const { boot, stopAll } = harness({
    state, projects: [{ name: 'release', cwd: candidate.project }], tasks: [],
    classify: () => assert.fail('an approved candidate plan must not be classified'),
    execute: async () => ({ text: '已接下已批准的计划。', taskId: 'candidate-goal' }),
  })
  const router = boot()
  try {
    const accepted = await router.submit(candidate.input)
    assert.deepEqual(accepted, { accepted: true, id: candidate.input.id, planDigest: candidate.preview.planDigest })
    const snapshot = await settled(router)
    assert.equal(snapshot.planExecution, 'candidate-plan-v1')

    const command = await router.getCommand(candidate.input.id)
    assert.deepEqual(command.candidatePlan, candidate.preview.inputSnapshot)
    assert.equal(command.planDigest, candidate.preview.planDigest)
    assert.equal(Object.hasOwn(command, 'planApproval'), false)
    assert.equal(Object.hasOwn(command, 'preview'), false)
    assert.doesNotMatch(JSON.stringify(command), /plan-approval-credential|router-test/)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('candidate processing returns the exact deterministic DAG decision without calling the classifier', async () => {
  const { base, state } = await fixture('superagent-candidate-dag')
  const first = await candidateSubmission(base, 'candidate-dag-1')
  const second = await candidateSubmission(base, 'candidate-dag-2')
  const decisions = []
  let classifyCalls = 0
  const { boot, stopAll } = harness({
    state, projects: [{ name: 'release', cwd: first.project }], tasks: [],
    classify: () => { classifyCalls += 1; assert.fail('candidate execution must bypass classification') },
    execute: async decision => {
      decisions.push(decision)
      return { text: '已接下已批准的计划。', taskId: `goal-${decision.requestId}` }
    },
  })
  const router = boot()
  try {
    await router.submit(first.input)
    await router.submit(second.input)
    const snapshot = await settled(router)
    assert.equal(classifyCalls, 0)
    assert.equal(snapshot.metrics.classifyCalls, 0)
    assert.equal(decisions.length, 2)

    const decision = decisions[0]
    assert.equal(decision.action, 'task')
    assert.equal(decision.target, null)
    assert.equal(decision.project, first.project)
    assert.equal(decision.text, first.input.text)
    assert.equal(decision.title, 'Ship candidate release')
    assert.deepEqual(decision.phases, [
      {
        id: 'draft', title: 'Draft release notes', objective: 'Write the release notes.', dependsOn: [],
        acceptance: [{ text: 'The release notes cover every change.' }], deliverables: ['docs/release.md'],
        maxRounds: 2, maxWallClockMinutes: 15,
      },
      {
        id: 'review', title: 'Review evidence', objective: 'Check every claim against the evidence.',
        dependsOn: ['draft'], acceptance: ['Every claim has evidence.'], deliverables: [],
        maxRounds: 3, maxWallClockMinutes: 20,
      },
    ])
    assert.deepEqual(decision.budget, first.preview.budget)
    assert.deepEqual(decision.model, first.preview.model)
    assert.deepEqual(decision.permissionScope, first.preview.permissionScope)
    assert.deepEqual(decision.runtime, first.preview.runtime)
    assert.deepEqual(decision.candidatePlan, first.preview.inputSnapshot)
    assert.equal(decision.planDigest, first.preview.planDigest)
    assert.equal(decision.requestId, first.input.id)
    assert.equal(decision.origin, null)
    assert.equal(decision.deliveredReply, null)
    assert.deepEqual(decision.preferences, [])
    assert.equal(Object.hasOwn(decision, 'planApproval'), false)
    assert.equal(Object.hasOwn(decision, '__classified'), false)

    const stable = ({ requestId, at, ...value }) => value
    assert.deepEqual(stable(decisions[0]), stable(decisions[1]), 'only request envelope fields may differ')
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('tampered, mismatched, blocked, and cross-goal or cross-project candidate submissions are rejected', async () => {
  const { base, state } = await fixture('superagent-candidate-reject')
  const candidate = await candidateSubmission(base, 'candidate-rejected-1')
  const otherProject = path.join(base, 'other-workspace').replaceAll('\\', '/')
  let classifyCalls = 0
  let executions = 0
  const { boot, stopAll } = harness({
    state, projects: [{ name: 'release', cwd: candidate.project }, { name: 'other', cwd: otherProject }], tasks: [],
    classify: () => { classifyCalls += 1; return { action: 'task' } },
    execute: async () => { executions += 1; return { text: '不应执行' } },
  })
  const router = boot()
  const reject = async (input, code) => {
    await assert.rejects(router.submit(input), error => {
      assert.equal(error.code, code)
      return true
    })
    assert.equal(await router.getCommand(input.id), null)
  }
  try {
    const tamperedPlan = structuredClone(candidate.input)
    tamperedPlan.id = 'candidate-plan-tampered'
    tamperedPlan.candidatePlan.subtasks[0].prompt = 'Tampered after approval.'
    await reject(tamperedPlan, 'PLAN_DIGEST_MISMATCH')

    const tamperedApproval = structuredClone(candidate.input)
    tamperedApproval.id = 'candidate-approval-tampered'
    tamperedApproval.planApproval.runtime.provider = 'other-provider'
    await reject(tamperedApproval, 'PLAN_APPROVAL_TAMPERED')

    const otherPreview = createCandidatePlanPreview({ ...candidate.candidatePlan, goal: 'Another approved goal' })
    const mismatchedApproval = structuredClone(candidate.input)
    mismatchedApproval.id = 'candidate-approval-mismatch'
    mismatchedApproval.planApproval = approvePlan(otherPreview, { planDigest: otherPreview.planDigest })
    await reject(mismatchedApproval, 'PLAN_DIGEST_MISMATCH')

    const blockedPreview = createCandidatePlanPreview({ ...candidate.candidatePlan, runtime: {} })
    assert.equal(blockedPreview.status, 'blocked')
    const blocked = structuredClone(candidate.input)
    blocked.id = 'candidate-blocked-plan'
    blocked.candidatePlan = blockedPreview.inputSnapshot
    blocked.planApproval = { planDigest: blockedPreview.planDigest }
    await reject(blocked, 'PLAN_BLOCKED')

    const wrongGoal = structuredClone(candidate.input)
    wrongGoal.id = 'candidate-goal-mismatch'
    wrongGoal.text = 'A different goal.'
    await reject(wrongGoal, 'PLAN_GOAL_MISMATCH')

    const wrongProject = structuredClone(candidate.input)
    wrongProject.id = 'candidate-project-mismatch'
    wrongProject.project = otherProject
    await reject(wrongProject, 'PLAN_PROJECT_MISMATCH')

    const snapshot = await router.snapshot()
    assert.equal(snapshot.pending, 0)
    assert.deepEqual(snapshot.messages, [])
    assert.equal(classifyCalls, 0)
    assert.equal(executions, 0)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('candidate request-id replay survives restart without another dispatch and cannot change the binding', async () => {
  const { base, state } = await fixture('superagent-candidate-replay')
  const candidate = await candidateSubmission(base, 'candidate-replay-1')
  let classifyCalls = 0
  let executions = 0
  const { boot, stopAll } = harness({
    state, projects: [{ name: 'release', cwd: candidate.project }], tasks: [],
    classify: () => { classifyCalls += 1; return { action: 'task' } },
    execute: async () => { executions += 1; return { text: '已接下已批准的计划。', taskId: 'candidate-goal' } },
  })
  let router = boot()
  try {
    const first = await router.submit(candidate.input)
    const immediateReplay = await router.submit(candidate.input)
    assert.deepEqual(immediateReplay, first)
    await settled(router)
    assert.equal(executions, 1)

    await stopAll()
    router = boot()
    const restartedReplay = await router.submit(candidate.input)
    assert.deepEqual(restartedReplay, first)
    const snapshot = await settled(router)
    assert.equal(executions, 1)
    assert.equal(classifyCalls, 0)
    assert.equal(snapshot.messages.filter(message => message.id === candidate.input.id).length, 1)
    assert.equal(snapshot.messages.filter(message => message.id === `reply-${candidate.input.id}`).length, 1)

    const changedPlan = structuredClone(candidate.candidatePlan)
    changedPlan.subtasks[0].prompt = 'A different plan reusing the same request id.'
    const changedPreview = createCandidatePlanPreview(changedPlan)
    const changed = {
      ...structuredClone(candidate.input),
      candidatePlan: changedPreview.inputSnapshot,
      planApproval: approvePlan(changedPreview, { planDigest: changedPreview.planDigest }),
    }
    await assert.rejects(router.submit(changed), error => error.code === 'REQUEST_ID_CONFLICT')
    assert.equal(executions, 1)
    assert.deepEqual((await router.getCommand(candidate.input.id)).candidatePlan, candidate.preview.inputSnapshot)
  } finally {
    await stopAll()
    await fsp.rm(base, { recursive: true, force: true })
  }
})
