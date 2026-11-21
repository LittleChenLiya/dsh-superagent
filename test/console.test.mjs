import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createConsole } from '../lib/console.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createStore } from '../lib/store.js'
import { createRouter } from '../lib/router.js'
import { createSourceStore } from '../lib/sources/store.js'
import { createSourceIngress } from '../lib/sources/ingress.js'
import { currentFacts, putFact } from '../lib/work-context.js'

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

function completed(text) {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

test('one router dispatches independently scoped tasks and resumes with its decisions after restart', async () => {
  const { base, state } = await fixture()
  const { host } = fakeHost()
  const tasks = []
  const executed = []
  const projects = [{ name: '发布', cwd: 'release' }, { name: '反馈', cwd: 'feedback' }]
  host.workbench = async () => ({ projects, runs: [], goals: [], inbox: [] })
  const classify = ({ input, project, tasks: candidates }) => {
    if (input.startsWith('以后')) return { action: 'remember', text: '写升级提醒', projectId: project }
    if (input === '暂停刚才那个') return { action: 'pause', taskId: candidates[0].id }
    if (input === '查发布进度') return { action: 'status', taskId: 'goal-a' }
    if (input === '昨天发版那件事，兼容性继续查') {
      const match = candidates.find(task => task.aliases?.includes('发版'))
      assert.ok(match.confirmed.some(item => item.value === '先灰度 10%'))
      return { action: 'followup', taskId: match.id, phaseId: 'compat', text: '兼容性继续查' }
    }
    if (input.startsWith('补充')) {
      assert.ok(candidates.find(task => task.id === 'goal-a').phases.some(phase => phase.id === 'compat'))
      return { action: 'followup', taskId: 'goal-a', phaseId: input.endsWith('安装') ? 'foreign' : input.includes('兼容性') ? 'compat' : null }
    }
    return { action: 'task', text: input, projectId: project }
  }
  const execute = async command => {
    executed.push(command)
    if (command.action === 'task') {
      const id = command.project === 'release' ? 'goal-a' : 'goal-b'
      tasks.push({ id, project: command.project, title: command.text, status: 'running', routed: true })
      return { text: '已接收', taskId: id }
    }
    return { text: command.action === 'status' ? '进行中' : '已送达执行方', taskId: command.target }
  }
  const newRouter = () => createRouter({ root: state, catalog: async () => ({ projects, tasks }), classify, execute })
  let router = newRouter()
  let panel
  const settled = async () => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const snapshot = await router.snapshot()
      if (snapshot.pending === 0) return snapshot
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    assert.fail('router queue did not drain')
  }
  try {
    panel = await startConsole(state, host, { router })
    const post = (route, body) => request(panel, 'POST', `/api/console/${route}`, body)
    assert.equal((await post('bootstrap', {})).json.data.mode, 'router')
    assert.equal(panel.sessionId, null)
    for (const route of ['session', 'session/switch', 'workbench']) assert.equal((await post(route, {})).status, 405)
    await post('message', { id: 'route-memory-1', project: 'release', text: '以后发布说明都写升级提醒' })
    await post('message', { id: 'route-release-1', project: 'release', text: '准备发布' })
    await post('message', { id: 'route-feedback-1', project: 'feedback', text: '汇总反馈' })
    await post('message', { id: 'route-release-1', project: 'release', text: '准备发布' })
    await settled()
    assert.equal(tasks.length, 2)
    assert.equal(executed[0].preferences[0].text, '写升级提醒')
    assert.deepEqual(executed[1].preferences, [])
    assert.equal((await post('message', { project: 'feedback', target: 'goal-a', text: '失败即结束', intent: 'followup' })).status, 500)
    await post('message', { id: 'route-add-1', target: 'goal-a', text: '补上迁移指引', intent: 'followup' })
    await post('message', { id: 'route-ambiguous-1', text: '暂停刚才那个' })
    const before = await settled()
    assert.equal(executed[2].target, 'goal-a')
    assert.equal(executed[2].project, 'release')
    assert.equal(executed.length, 3, 'ambiguous pause must not be applied')
    assert.deepEqual(before.messages.at(-1).taskIds, ['goal-a', 'goal-b'])
    assert.equal((await post('router/choose', { requestId: 'route-ambiguous-1', target: 'goal-b' })).status, 200)
    const chosen = await settled()
    assert.equal(executed.at(-1).action, 'pause')
    assert.equal(executed.at(-1).target, 'goal-b')
    assert.equal(chosen.messages.find(message => message.id === 'reply-route-ambiguous-1').choiceFor, undefined)
    await panel.stop()

    router = newRouter()
    panel = await startConsole(state, host, { router })
    assert.deepEqual((await router.snapshot()).messages, chosen.messages)
    assert.equal((await post('message', { id: 'route-status-1', text: '查发布进度' })).status, 200)
    assert.equal((await settled()).messages.at(-1).text, '进行中')
    assert.equal(executed.at(-1).target, 'goal-a')

    tasks[0].phases = [{ id: 'compat', title: '兼容性', status: 'pending' }, { id: 'review', title: '评审', status: 'running' }]
    tasks[1].phases = [{ id: 'foreign', title: '安装', status: 'running' }]
    await post('message', { id: 'route-phase-1', text: '补充兼容性' })
    await settled()
    assert.equal(executed.at(-1).target, 'goal-a')
    assert.equal(executed.at(-1).phaseId, 'compat')
    await post('message', { id: 'route-phase-2', target: 'goal-a', phaseId: 'review', text: '保留依据', intent: 'followup' })
    await settled()
    assert.equal(executed.at(-1).phaseId, 'review')
    const exactCount = executed.length
    assert.equal((await post('message', { target: 'goal-a', phaseId: 'foreign', text: '跨任务追加', intent: 'followup' })).status, 500)
    await post('message', { id: 'route-phase-3', text: '补充安装' })
    assert.match((await settled()).messages.at(-1).text, /无法接收/)
    await post('message', { id: 'route-phase-4', project: 'release', text: '补充一个要求' })
    assert.match((await settled()).messages.at(-1).text, /多个阶段/)
    assert.equal(executed.length, exactCount, 'an unresolved phase must never turn into a goal-wide instruction')

    await post('message', { id: 'route-context-1', project: 'release', text: '查发布进度' })
    await settled()
    assert.equal(executed.at(-1).snapshot, undefined)
    const batch = ['/批量 配置清点', ...Array.from({ length: 5000 }, (_, i) => `核对配置 ${i}`)].join('\n')
    assert.equal((await post('message', { id: 'route-batch-1', project: 'release', text: batch, contextMode: 'snapshot' })).status, 200)
    const batched = await settled()
    assert.equal(executed.at(-1).action, 'batch')
    assert.equal(executed.at(-1).batch.length, 5000)
    assert.ok(executed.at(-1).snapshot.some(message => message.text === '查发布进度'))
    assert.ok(!executed.at(-1).snapshot.some(message => message.text === '汇总反馈' || message.text.includes('批量清单')))
    assert.ok(batched.messages.find(message => message.id === 'route-batch-1').text.length < 100)
    assert.equal((await post('message', { text: '/批量 路径校验\n检查文件 => ../outside.txt' })).status, 500)

    await post('message', { id: 'work-alias-release', project: 'release', text: '把准备发布叫做发版' })
    await post('message', { id: 'work-decision-release', project: 'release', text: '记下发版的发布方案：先灰度 10%' })
    await settled()
    assert.equal((await router.taskFacts(tasks[0])).at(-1).value, '先灰度 10%')
    assert.equal((await router.taskFacts(tasks[1])).length, 0)
    await panel.stop()
    router = newRouter()
    panel = await startConsole(state, host, { router })
    await post('message', { id: 'work-status-release', project: 'release', text: '发版到哪了' })
    assert.equal((await settled()).messages.at(-1).text, '进行中')
    await post('message', { id: 'work-read-release', project: 'release', text: '发版的当前方案' })
    assert.match((await settled()).messages.at(-1).text, /先灰度 10%/)
    await post('message', { id: 'work-resume-release', text: '昨天发版那件事，兼容性继续查' })
    await settled()
    assert.equal(executed.at(-1).target, 'goal-a')
    assert.equal(executed.at(-1).phaseId, 'compat')
    await post('message', { id: 'work-wrong-project', project: 'feedback', text: '/方案 发版' })
    assert.match((await settled()).messages.at(-1).text, /找不到/)
    await post('message', { id: 'work-alias-feedback', project: 'feedback', text: '/别名 goal-b | 发版' })
    await post('message', { id: 'work-ambiguous-project', text: '/方案 发版' })
    assert.match((await settled()).messages.at(-1).text, /2 项工作/)
    await post('message', { id: 'work-remove-decision', project: 'release', text: '/撤销决定 发版 | 发布方案' })
    await post('message', { id: 'work-read-revoked', project: 'release', text: '/方案 发版' })
    assert.match((await settled()).messages.at(-1).text, /没有已确认的决定/)
  } finally {
    await panel?.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('dated facts retain their source and cannot revive an expired or withdrawn decision', () => {
  const state = {}
  const fact = { kind: 'decision', taskId: 'goal-1', project: 'release', key: 'plan', subject: 'Plan' }
  putFact(state, { ...fact, value: 'first' }, { id: 'user-a', at: 100 })
  putFact(state, { ...fact, value: 'second', expiresAt: 220 }, { id: 'user-b', at: 200 })
  assert.deepEqual(currentFacts(state.facts, 210).map(item => [item.id, item.replaces, item.source, item.value]),
    [['user-b', 'user-a', 'user-message', 'second']])
  assert.deepEqual(currentFacts(state.facts, 220), [])
  putFact(state, { ...fact, revoked: true }, { id: 'user-c', at: 250 })
  assert.deepEqual(currentFacts(state.facts, 300), [])
})

async function fixture() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-console-'))
  const state = path.join(base, 'state')
  await fsp.mkdir(state, { recursive: true })
  return { base, state }
}

async function startConsole(state, host, options = {}) {
  const panel = createConsole({
    port: 0,
    stateRoot: state,
    host,
    version: 'test',
    log: () => {},
    ...options,
  })
  await panel.start()
  return panel
}

async function request(panel, method, route, body, token = panel.token) {
  const headers = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${panel.url}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // HTML pages are checked with `text`.
  }
  return { status: response.status, json, text, headers: response.headers }
}

function fakeHost({ sessionId = 'session-console', onPrompt = null } = {}) {
  const prompts = []
  const answers = []
  const cancels = []
  let subscriber = null
  const host = {
    capabilities: () => ({ chat: true, reason: null }),
    createSession: async () => ({ sessionId }),
    prompt: async ({ sessionId: target, text, mode }) => {
      prompts.push({ sessionId: target, text, mode })
      for (const frame of onPrompt ? onPrompt(text) : []) {
        if (subscriber) subscriber(frame)
      }
      return { accepted: true }
    },
    listRuns: async () => [],
    cancelTurn: async target => {
      cancels.push(target)
      return { accepted: true }
    },
    answer: async args => {
      answers.push(args)
      return { ...args, status: 'completed' }
    },
    subscribe: (id, listener) => {
      subscriber = listener
      return () => {
        subscriber = null
      }
    },
  }
  return {
    host,
    prompts,
    answers,
    cancels,
    emit: frame => subscriber?.(frame),
    hasSubscriber: () => Boolean(subscriber),
  }
}

test('a console goal and targeted instructions stay in their own conversation', async () => {
  const { base, state } = await fixture()
  const { host, prompts } = fakeHost()
  const goals = []
  const instructions = []
  host.listGoals = async session => goals.filter(goal => goal.session === session)
  host.createGoal = async (session, text) => {
    const goal = { id: 'goal-1', goal: text, session, status: 'planning' }
    goals.push(goal)
    return goal
  }
  host.actOnGoal = async (session, id, action, body) => {
    assert.equal(session, 'session-console')
    assert.equal(id, 'goal-1')
    assert.equal(action, 'answer')
    assert.equal(body.decisionId, 'd1')
    return goals[0]
  }
  host.instructRun = async (session, id, instruction) => {
    instructions.push({ session, id, ...instruction })
    return { id: 'i1', targets: [{ subtaskIndex: 2, status: 'pending' }] }
  }
  const panel = await startConsole(state, host)
  try {
    const post = (route, body) => request(panel, 'POST', `/api/console/${route}`, body)
    const stream = await fetch(`${panel.url}/api/console/events`, { headers: { Authorization: `Bearer ${panel.token}` } })
    assert.equal(stream.status, 200)
    const created = await post('goals', { text: 'Prepare two deliverables' })
    assert.equal(created.status, 200)
    assert.equal(prompts.length, 0)
    const frames = await collectFrames(stream, { count: 4 })
    assert.ok(frames.some(frame => frame.type === 'session' && frame.sessionId === 'session-console'))
    const snapshot = await request(panel, 'GET', '/api/console/state')
    assert.equal(snapshot.json.data.goals[0].id, 'goal-1')
    assert.equal((await post('goals/goal-1/answer', { sessionId: 'other-session', decisionId: 'd1' })).status, 409)
    assert.equal((await post('goals/goal-1/answer', { sessionId: 'session-console', decisionId: 'd1' })).status, 200)
    const route = 'runs/release-notes/instruction'
    assert.equal((await post(route, { sessionId: 'other-session', mode: 'inject', subtaskIndex: 2, text: 'Address customers' })).status, 409)
    assert.equal((await post(route, { sessionId: 'session-console', mode: 'inject', text: 'Address customers' })).status, 400)
    const sent = await post(route, { sessionId: 'session-console', mode: 'inject', subtaskIndex: 2, text: 'Address customers' })
    assert.equal(sent.json.data.targets[0].status, 'pending')
    assert.deepEqual(instructions, [{ session: 'session-console', id: 'release-notes', text: 'Address customers', mode: 'inject', subtaskIndex: 2 }])
  } finally {
    await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the workbench follows the active project and exposes its own task transcript and files', async () => {
  const { base, state } = await fixture()
  const project = path.join(base, 'project')
  await fsp.mkdir(project)
  await fsp.writeFile(path.join(project, 'report.txt'), 'approved report')
  const { host } = fakeHost()
  let name = ''
  host.createSession = async ({ cwd }) => {
    assert.equal(cwd, project)
    return { sessionId: 'project-session' }
  }
  host.workbench = async sessionId => ({ name, project: sessionId ? { cwd: project } : null })
  host.nameWorkbench = async value => { name = value }
  host.sessionWorkspace = async () => project
  host.readRun = async (sessionId, id) => sessionId === 'project-session' && id === 'run-1'
    ? { report: '[Report](report.txt) [Outside](../private.txt)' } : null
  host.readWorkerSession = async (sessionId, id, worker) => sessionId === 'project-session' && id === 'run-1' && worker === 'worker-1'
    ? { title: 'Prepare report', records: [{ type: 'event', event: { type: 'assistant/message' } }] } : null
  const panel = await startConsole(state, host)
  try {
    const url = '/api/console'
    assert.equal((await request(panel, 'GET', `${url}/workbench`)).json.data.project, null)
    assert.equal((await request(panel, 'POST', `${url}/workbench`, { name: '  交付助理  ' })).json.data.name, '交付助理')
    assert.equal((await request(panel, 'POST', `${url}/workbench`, { name: ' ' })).status, 400)
    assert.equal((await request(panel, 'POST', `${url}/session`, { cwd: project })).json.data.sessionId, 'project-session')
    assert.equal((await request(panel, 'GET', `${url}/workbench`)).json.data.project.cwd, project)
    assert.equal((await request(panel, 'GET', `${url}/runs/run-1/worker/worker-1`)).json.data.title, 'Prepare report')
    assert.equal((await request(panel, 'GET', `${url}/runs/run-1/worker/foreign`)).status, 404)
    assert.equal((await request(panel, 'GET', `${url}/artifact?runId=run-1&path=report.txt`)).text, 'approved report')
    assert.equal((await request(panel, 'GET', `${url}/artifact?runId=run-1&path=${encodeURIComponent('../private.txt')}`)).status, 403)
  } finally {
    await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('cross-project inbox actions and task controls leave the current chat in place', async () => {
  const { base, state } = await fixture()
  const { host, cancels, prompts, answers } = fakeHost()
  const taskCalls = []
  const project = { cwd: base, name: 'Release' }
  const item = { id: 'q1', source: 'plan', question: 'Ship?', options: ['Ship'] }
  host.openSession = async id => id === 'release-session' ? { sessionId: id } : null
  host.workbench = async () => ({
    sessionProjects: { 'release-session': project },
    inbox: answers.length ? [] : [{ id: 'run:release:q1', kind: 'question', sessionId: 'release-session', runId: 'release', item }],
  })
  host.sessionWorkspace = async () => base
  host.readRun = async (owner, id) => owner === 'release-session' && id === 'release'
    ? { id, parentSessionId: owner, report: '[Report](release.md)' } : null
  host.instructRun = async (owner, id, instruction) => {
    taskCalls.push(['instruction', owner, id, instruction.text])
    return { id: 'instruction-1' }
  }
  host.cancelRun = async (owner, id) => {
    taskCalls.push(['cancel', owner, id])
    return { status: 'cancelled' }
  }
  await fsp.writeFile(path.join(base, 'release.md'), '# Release')
  const panel = await startConsole(state, host)
  let events
  try {
    const get = route => request(panel, 'GET', `/api/console/${route}`)
    const post = (route, body) => request(panel, 'POST', `/api/console/${route}`, body)
    await post('session', {})
    const response = await fetch(`${panel.url}/api/console/events`, { headers: { authorization: `Bearer ${panel.token}` } })
    events = response.body.getReader()
    await events.read()
    const pending = panel.askApproval({ toolName: 'write_file', ownerSessionId: 'release-session' })
    const { inbox } = (await get('workbench')).json.data
    assert.deepEqual(inbox.map(entry => [entry.kind, entry.project.name, entry.read]), [
      ['approval', 'Release', false], ['question', 'Release', false],
    ])
    assert.equal((await post('notices/read', { ids: inbox.map(entry => entry.id) })).status, 200)
    assert.ok((await get('workbench')).json.data.inbox.every(entry => entry.read))
    assert.equal((await post('approval', { id: inbox[0].item.id, decision: 'allow-tool' })).status, 409)
    assert.equal((await post('approval', { id: inbox[0].item.id, decision: 'allow' })).status, 200)
    assert.equal(await pending, 'allowed-once')
    assert.equal((await post('answer', { owner: 'release-session', runId: 'release', attentionId: 'q1', answer: 'Ship' })).status, 200)
    assert.equal(answers[0].sessionId, 'release-session')
    assert.deepEqual((await get('workbench')).json.data.inbox, [])

    assert.equal((await get('runs/release?owner=foreign')).status, 404)
    assert.equal((await get('artifact?owner=release-session&runId=release&path=release.md')).text, '# Release')
    assert.equal((await post('runs/release/instruction?owner=release-session', { sessionId: 'release-session', mode: 'followup', text: 'Mention rollout' })).status, 200)
    assert.equal((await post('cancel', { sessionId: 'session-console' })).status, 200)
    assert.deepEqual(taskCalls, [['instruction', 'release-session', 'release', 'Mention rollout']])
    assert.equal((await post('runs/release/cancel', { owner: 'release-session' })).status, 200)
    assert.deepEqual(taskCalls.at(-1), ['cancel', 'release-session', 'release'])
    assert.deepEqual(cancels, ['session-console'])
    assert.deepEqual(prompts, [])
    assert.equal((await get('state')).json.data.sessionId, 'session-console')
  } finally {
    await events?.cancel()
    await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

async function collectFrames(response, { count = 12, timeoutMs = 2500 } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames = []
  let buffer = ''
  const timer = setTimeout(() => {
    reader.cancel().catch(() => {})
  }, timeoutMs)
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trimStart()
          if (!raw) continue
          try {
            frames.push(JSON.parse(raw))
          } catch {
            // Ignore a malformed frame; the stream is still readable.
          }
        }
        cut = buffer.indexOf('\n\n')
      }
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  return frames
}

async function realOrchestrator(state, { attention = false } = {}) {
  const store = createStore(state)
  await store.init()
  let seq = 0
  const spawnChild = async spec => {
    const childId = `child-${++seq}`
    let result
    if (spec.label === 'superagent-plan') {
      result = Promise.resolve(completed(JSON.stringify({
        subtasks: [{ title: 'A', prompt: 'do A' }],
      })))
    } else if (spec.label === 'superagent-1' && attention) {
      result = Promise.resolve(completed(
        'Everything I could do is done.\n\n'
        + '```attention\n{"question":"Which region?","options":["eu","us"],"reason":"the reports disagree"}\n```',
      ))
    } else {
      result = Promise.resolve(completed(spec.label === 'superagent-aggregate' ? 'final report' : 'worker result'))
    }
    return { childId, result, dispose: async () => {} }
  }
  const orchestrator = createOrchestrator({
    store,
    config: BASE_CONFIG,
    spawnChild,
    readUsage: async () => ({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      modelCalls: 1,
      models: { 'test/model': { inputTokens: 10, outputTokens: 2, calls: 1 } },
    }),
    log: () => {},
  })
  return { store, orchestrator }
}

test('the console page and every API refuse a request without the token', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    panel = await startConsole(state, fakeHost().host)
    const anonymous = await request(panel, 'GET', '/api/console/state', undefined, null)
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.id, 'unauthorized')

    const wrong = await request(panel, 'GET', '/api/console/state', undefined, 'not-the-token')
    assert.equal(wrong.status, 401)

    const tools = await request(panel, 'GET', '/api/console/tools', undefined, null)
    assert.equal(tools.status, 401)

    const pageWithoutToken = await fetch(`${panel.url}/`)
    assert.equal(pageWithoutToken.status, 401)
    const page = await fetch(`${panel.url}/?token=${encodeURIComponent(panel.token)}`)
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /说一句要做什么；它自己决定一步做完还是拆开并行/)
    // The page keeps the right-side rail: one square card per conversation,
    // a remembered collapsed state, and an overlay instead of a squeeze at 720px.
    assert.match(html, /id="schedRail"/)
    assert.match(html, /rail-grid/)
    assert.match(html, /dsh-superagent-rail-collapsed/)
    assert.match(html, /@media \(max-width: 720px\)[\s\S]*\.sched-rail \{ width: min\(320px/)
    assert.doesNotMatch(html, /sched-track/)
    // Copy guard: marketing filler must not creep back into user-visible text.
    assert.doesNotMatch(html, /一键|赋能|无缝|让我们|为您/)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)

    const discovery = JSON.parse(await fsp.readFile(path.join(state, 'console.json'), 'utf8'))
    assert.equal(discovery.token, panel.token)
    assert.equal(discovery.url, panel.url)
    assert.equal(discovery.service, 'dsh-superagent-console')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the page lets its framer in, and only the framers that may be there', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    panel = await startConsole(state, fakeHost().host)
    const token = encodeURIComponent(panel.token)
    const policyOf = async hint => {
      const suffix = hint === null ? '' : `&parent=${encodeURIComponent(hint)}`
      const response = await fetch(`${panel.url}/?token=${token}${suffix}`)
      assert.equal(response.status, 200)
      return response.headers.get('content-security-policy') ?? ''
    }

    // The desktop shell frames from its own scheme; it works without any hint.
    const plain = await policyOf(null)
    assert.match(plain, /frame-ancestors [^;]*'self'/)
    assert.match(plain, /frame-ancestors [^;]*dsh-app:/)

    // The reported page scheme is echoed back, so a shell that renames its
    // scheme needs no release here.
    assert.match(await policyOf('dsh-app://app'), /frame-ancestors [^;]*dsh-app:\/\/app/)
    assert.match(await policyOf('dsh-shell://host'), /frame-ancestors [^;]*dsh-shell:\/\/host/)

    // The web profile frames from loopback http, which is always listed.
    assert.match(await policyOf('http://127.0.0.1:5173'), /frame-ancestors [^;]*http:\/\/127\.0\.0\.1:5173/)

    // A page on the internet is not a legitimate framer, hint or no hint.
    for (const bad of ['https://evil.example', 'http://evil.example', 'javascript:alert(1)', "dsh-app://app; script-src *"]) {
      assert.doesNotMatch(await policyOf(bad), /evil\.example|javascript:|script-src \*/)
    }
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the page carries both host palettes and follows the shell theme', async () => {
  const file = new URL('../public/console.html', import.meta.url)
  const html = await fsp.readFile(file, 'utf8')
  // Light is the host default set, dark is the host's dark set — values copied
  // from design-platform.css, not one palette inverted into the other.
  assert.match(html, /:root \{[^}]*color-scheme: light/)
  assert.match(html, /:root\[data-theme='dark'\] \{[^}]*color-scheme: dark/)
  assert.match(html, /--bg: rgb\(255, 255, 255\)/)
  assert.match(html, /--bg: rgb\(21, 21, 23\)/)
  assert.match(html, /--accent: rgb\(65, 118, 230\)/)
  assert.match(html, /--accent: rgb\(122, 170, 255\)/)
  // The theme rides in on the URL, and switching later needs no reload.
  assert.match(html, /location\.search\)\.get\('theme'\)/)
  assert.match(html, /dsh-superagent-theme/)
})

test('a Host header that is not loopback is refused before the token is checked', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    panel = await startConsole(state, fakeHost().host)
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: panel.port,
        path: '/api/console/state',
        method: 'GET',
        headers: {
          host: 'evil.example',
          authorization: `Bearer ${panel.token}`,
        },
      }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a submitted message starts a real run and the run panel reads it back', async () => {
  const { base, state } = await fixture()
  let panel = null
  let orchestrator = null
  try {
    const runtime = await realOrchestrator(state)
    orchestrator = runtime.orchestrator
    const sessionId = 'session-console'
    let started = null
    const host = {
      capabilities: () => ({ chat: true, reason: null }),
      createSession: async () => ({ sessionId }),
      prompt: async ({ text }) => {
        started = await orchestrator.start({
          goal: text,
          parentSessionId: sessionId,
          parent: { id: sessionId },
        })
        return { accepted: true }
      },
      listRuns: async target => {
        const runs = await runtime.store.list()
        return runs.filter(run => run.parentSessionId === target).map(run => ({
          id: run.id,
          goal: run.goal,
          status: run.status,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          parentSessionId: run.parentSessionId,
          cost: null,
          usage: null,
          subtasks: run.subtasks,
          attention: [],
          report: run.report ?? null,
          reportTruncated: false,
        }))
      },
      answer: async args => args,
      subscribe: () => () => {},
    }
    panel = await startConsole(state, host)
    const created = await request(panel, 'POST', '/api/console/session', {})
    assert.equal(created.status, 200)
    assert.equal(created.json.data.sessionId, sessionId)

    const sent = await request(panel, 'POST', '/api/console/message', { text: 'fix the login failure' })
    assert.equal(sent.status, 200)
    assert.equal(sent.json.data.accepted, true)
    assert.ok(started, 'the message must reach the orchestrator, not a mock UI')
    assert.equal(started.goal, 'fix the login failure')
    assert.equal(started.parentSessionId, sessionId)

    const listed = await request(panel, 'GET', '/api/console/runs')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.data.runs.length, 1)
    assert.equal(listed.json.data.runs[0].id, started.id)
    assert.equal(listed.json.data.runs[0].goal, 'fix the login failure')

    await orchestrator.status(started.id, 10)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a running turn can be stopped through the host session controller', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const fake = fakeHost()
    panel = await startConsole(state, fake.host)
    await request(panel, 'POST', '/api/console/session', {})
    const stopped = await request(panel, 'POST', '/api/console/cancel', {})
    assert.equal(stopped.status, 200)
    assert.deepEqual(stopped.json.data, { canceling: true })
    assert.deepEqual(fake.cancels, ['session-console'], 'the stop button must reach the host, not just the page')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('stopping a turn fails loudly when the host offers no cancel', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const fake = fakeHost()
    delete fake.host.cancelTurn
    panel = await startConsole(state, fake.host)
    await request(panel, 'POST', '/api/console/session', {})
    const stopped = await request(panel, 'POST', '/api/console/cancel', {})
    assert.equal(stopped.status, 501)
    assert.equal(stopped.json.ok, false)
    assert.equal(stopped.json.error.id, 'cancel-unsupported')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('attention answers reach the same orchestrator.answer path as superagent_answer', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const runtime = await realOrchestrator(state, { attention: true })
    const sessionId = 'session-console'
    const run = await runtime.orchestrator.start({
      goal: 'needs a decision',
      parentSessionId: sessionId,
      parent: { id: sessionId },
    })
    const finished = await runtime.orchestrator.status(run.id, 10)
    assert.equal(finished.attention.items.length, 1)
    const question = finished.attention.items[0]
    assert.ok(question.id)

    let answerResult = null
    const host = {
      capabilities: () => ({ chat: true, reason: null }),
      createSession: async () => ({ sessionId }),
      prompt: async () => ({ accepted: true }),
      listRuns: async target => {
        const runs = await runtime.store.list()
        return runs.filter(item => item.parentSessionId === target).map(item => ({
          id: item.id,
          goal: item.goal,
          status: item.status,
          createdAt: item.createdAt,
          finishedAt: item.finishedAt,
          parentSessionId: item.parentSessionId,
          cost: null,
          usage: null,
          subtasks: item.subtasks,
          attention: (item.attention?.items ?? []).filter(entry => !entry.answer).map(entry => ({
            id: entry.id,
            question: entry.question,
            options: entry.options,
            reason: entry.reason,
          })),
          report: item.report ?? null,
          reportTruncated: false,
        }))
      },
      answer: async ({ runId, attentionId, answer }) => {
        answerResult = await runtime.orchestrator.answer(
          runId,
          attentionId,
          answer,
          { id: sessionId },
          'Asia/Shanghai',
        )
        return {
          runId,
          attentionId,
          status: answerResult.run?.status ?? null,
          resumed: answerResult.resumed,
        }
      },
      subscribe: () => () => {},
    }
    panel = await startConsole(state, host)
    await request(panel, 'POST', '/api/console/session', {})
    const answered = await request(panel, 'POST', '/api/console/answer', {
      runId: run.id,
      attentionId: question.id,
      answer: 'eu',
    })
    assert.equal(answered.status, 200)
    assert.equal(answered.json.data.attentionId, question.id)

    assert.ok(answerResult, 'the console route must reach orchestrator.answer')
    assert.equal(answerResult.attention.answer, 'eu')
    assert.ok(answerResult.attention.answeredAt, 'the answer must be recorded by orchestrator.answer')
    assert.equal(answerResult.attentionId, question.id)
    assert.equal(answered.json.data.attentionId, question.id)
    await runtime.orchestrator.status(run.id, 10)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the event stream keeps the host order: user message, assistant start/chunk/end, state, runs', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const sessionId = 'session-console'
    const fake = fakeHost({
      sessionId,
      onPrompt: text => [
        { type: 'stream.snapshot', header: { id: sessionId }, cursor: 0, records: [] },
        {
          type: 'session.event',
          event: {
            type: 'user/message',
            data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
          },
        },
        { type: 'assistant.frame', frame: { type: 'start' } },
        { type: 'assistant.frame', frame: { type: 'chunk', chunk: { type: 'text-delta', text: '你好' } } },
        { type: 'assistant.frame', frame: { type: 'end' } },
        { type: 'session.state', state: { running: false, pendingInput: [], queue: [] } },
      ],
    })
    panel = await startConsole(state, fake.host)
    await request(panel, 'POST', '/api/console/session', {})
    const response = await fetch(`${panel.url}/api/console/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    assert.equal(response.status, 200)
    const collected = collectFrames(response, { count: 9, timeoutMs: 1500 })
    // Give the stream a beat to write `hello`, then submit.
    await new Promise(resolve => setTimeout(resolve, 30))
    const sent = await request(panel, 'POST', '/api/console/message', { text: 'hello' })
    assert.equal(sent.status, 200)
    const frames = await collected

    const indexOf = predicate => frames.findIndex(predicate)
    const user = indexOf(frame => frame.type === 'session.event' && frame.event?.type === 'user/message')
    const start = indexOf(frame => frame.type === 'assistant.frame' && frame.frame?.type === 'start')
    const chunk = indexOf(frame => frame.type === 'assistant.frame' && frame.frame?.type === 'chunk')
    const end = indexOf(frame => frame.type === 'assistant.frame' && frame.frame?.type === 'end')
    const stateEvent = indexOf(frame => frame.type === 'session.state')
    assert.ok(user >= 0 && start > user && chunk > start && end > chunk && stateEvent > end, JSON.stringify(frames))
    assert.ok(frames.length >= 8, `expected the stream frames, got ${frames.length}`)
    for (let index = 1; index < frames.length; index += 1) {
      assert.ok(frames[index].seq > frames[index - 1].seq, 'SSE sequence numbers must increase')
    }
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a large streamed frame does not close the connection', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const sessionId = 'session-backpressure'
    const bigText = 'x'.repeat(200_000)
    const fake = fakeHost({
      sessionId,
      onPrompt: () => [
        {
          type: 'session.event',
          event: {
            type: 'assistant/message',
            seq: 2,
            data: { message: { content: [{ type: 'text', text: bigText }] } },
          },
        },
        { type: 'assistant.frame', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'after-1' } } },
        { type: 'assistant.frame', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'after-2' } } },
        { type: 'assistant.frame', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'after-3' } } },
        { type: 'assistant.frame', frame: { type: 'end' } },
      ],
    })
    panel = await startConsole(state, fake.host)
    await request(panel, 'POST', '/api/console/session', {})
    const response = await fetch(`${panel.url}/api/console/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    assert.equal(response.status, 200)
    const collected = collectFrames(response, { count: 6, timeoutMs: 2500 })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal((await request(panel, 'POST', '/api/console/message', { text: 'stream a lot' })).status, 200)
    const frames = await collected

    // A write that exceeds the socket high-water mark is ordinary backpressure:
    // the tab must keep receiving the deltas that follow the big frame.
    const big = frames.find(frame => frame.type === 'session.event')
    assert.ok(big, `expected the big event, got ${frames.map(frame => frame.type).join(',')}`)
    assert.equal(big.event.data.message.content[0].text.length, 200_000)
    const tail = frames.filter(frame => frame.type === 'assistant.frame')
    assert.equal(tail.length, 4, `the stream stopped after the big frame: ${frames.map(frame => frame.type).join(',')}`)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a reconnect after the last tab left reopens the follow stream with the full history', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const sessionId = 'session-reconnect'
    const history = {
      type: 'stream.snapshot',
      header: { id: sessionId },
      cursor: 9,
      records: [{
        type: 'event',
        event: {
          type: 'user/message',
          seq: 9,
          time: Date.now(),
          data: { content: [{ type: 'text', text: 'earlier turn' }], source: { kind: 'user' } },
        },
      }],
    }
    let subscribes = 0
    let subscriber = null
    const host = {
      capabilities: () => ({ chat: true, reason: null }),
      createSession: async () => ({ sessionId }),
      prompt: async () => ({ accepted: true }),
      listRuns: async () => [],
      answer: async args => args,
      subscribe: (_id, listener) => {
        subscribes += 1
        subscriber = listener
        // The real host's later openings can come back with just the session's
        // setup records; the console must not let that erase the history.
        listener(subscribes === 1
          ? history
          : { type: 'stream.snapshot', header: { id: sessionId }, cursor: 2, records: [], hasMore: false })
        return () => {
          subscriber = null
        }
      },
    }
    panel = await startConsole(state, host)
    await request(panel, 'POST', '/api/console/session', {})

    const first = await fetch(`${panel.url}/api/console/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    const firstFrames = await collectFrames(first, { count: 2, timeoutMs: 1500 })
    assert.ok(firstFrames.some(frame => frame.type === 'stream.snapshot'))
    assert.equal(subscribes, 1)

    // Everyone left: the follow loop is released together with its cached window.
    await first.body.cancel().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(subscriber, null, 'the follow loop must stop once no tab is watching')

    const reopened = await fetch(`${panel.url}/api/console/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    const frames = await collectFrames(reopened, { count: 2, timeoutMs: 1500 })
    assert.equal(frames[0]?.type, 'hello')
    const snapshot = frames.find(frame => frame.type === 'stream.snapshot')
    assert.ok(snapshot, `a reconnect must replay history, got ${frames.map(frame => frame.type).join(',')}`)
    assert.equal(snapshot.records.length, 1)
    assert.equal(subscribes, 2, 'the reconnect must reopen the follow stream, not replay a stale cache')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a second tab receives the cached snapshot instead of an empty conversation', async () => {
  const { base, state } = await fixture()
  let panel = null
  let first = null
  try {
    const sessionId = 'session-console'
    const fake = fakeHost({
      sessionId,
      onPrompt: text => [
        {
          type: 'stream.snapshot',
          header: { id: sessionId },
          cursor: 1,
          records: [{
            type: 'event',
            event: {
              type: 'user/message',
              seq: 1,
              time: Date.now(),
              data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
            },
          }],
        },
        { type: 'assistant.frame', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'partial' } } },
      ],
    })
    panel = await startConsole(state, fake.host)
    await request(panel, 'POST', '/api/console/session', {})

    first = await fetch(`${panel.url}/api/console/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    assert.equal(first.status, 200)
    await new Promise(resolve => setTimeout(resolve, 30))
    const sent = await request(panel, 'POST', '/api/console/message', { text: 'hello' })
    assert.equal(sent.status, 200)

    const second = await fetch(`${panel.url}/api/console/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    assert.equal(second.status, 200)
    const collected = collectFrames(second, { count: 4, timeoutMs: 1500 })
    await new Promise(resolve => setTimeout(resolve, 30))
    // What happens after the second tab is watching must reach it live.
    fake.emit({
      type: 'session.event',
      event: { type: 'tool/call', seq: 2, time: Date.now(), data: { callId: 'call-1', name: 'pwsh', arguments: '{}' } },
    })
    const frames = await collected
    assert.equal(frames[0]?.type, 'hello')
    const history = frames.find(frame => frame.type === 'stream.snapshot')
    assert.ok(history, `the second tab must receive the conversation history, got ${JSON.stringify(frames)}`)
    assert.equal(history.records.length, 1)
    assert.equal(history.records[0].event.type, 'user/message')
    const live = frames.find(frame => frame.type === 'session.event')
    assert.equal(live?.event?.type, 'tool/call')
    for (let index = 1; index < frames.length; index += 1) {
      assert.ok(frames[index].seq > frames[index - 1].seq, 'frames must keep increasing sequence numbers')
    }
    assert.ok(fake.hasSubscriber(), 'the second tab must not restart the follow loop')
  } finally {
    await first?.body?.cancel().catch(() => {})
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the tools route reports the mounted tools the host returns, never a fixed list', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const fake = fakeHost({ sessionId: 'session-tools' })
    fake.host.listTools = async () => [
      { name: 'read', description: 'read a file' },
      { name: 'browser_open', description: 'open a page' },
      { name: 'desktop_click', description: 'click at a point' },
    ]
    panel = await startConsole(state, fake.host)
    const before = await request(panel, 'GET', '/api/console/tools')
    assert.equal(before.status, 200)
    assert.equal(before.json.data.reason, 'no-session')

    await request(panel, 'POST', '/api/console/bootstrap', {})
    const after = await request(panel, 'GET', '/api/console/tools')
    assert.equal(after.status, 200)
    assert.deepEqual(after.json.data.tools.map(tool => tool.name), ['read', 'browser_open', 'desktop_click'])

    // A host that cannot enumerate tools says so; the page must not invent names.
    await panel.stop()
    panel = await startConsole(state, fakeHost({ sessionId: 'session-no-tools' }).host)
    await request(panel, 'POST', '/api/console/bootstrap', {})
    const unsupported = await request(panel, 'GET', '/api/console/tools')
    assert.equal(unsupported.json.data.tools, null)
    assert.match(unsupported.json.data.reason, /enumerate/)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('without sessionController the page reports unavailable and refuses to fake a session', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    panel = await startConsole(state, {
      capabilities: () => ({ chat: false, reason: '宿主没有挂载 sessionController' }),
      createSession: async () => {
        throw new Error('must not be called')
      },
      prompt: async () => {
        throw new Error('must not be called')
      },
      listRuns: async () => [],
      answer: async () => ({}),
      subscribe: () => () => {},
    })
    const boot = await request(panel, 'POST', '/api/console/bootstrap', {})
    assert.equal(boot.status, 503)
    assert.equal(boot.json.error.id, 'console-unavailable')
    const stateResponse = await request(panel, 'GET', '/api/console/state')
    assert.equal(stateResponse.status, 200)
    assert.equal(stateResponse.json.data.mode, 'unavailable')
    assert.match(stateResponse.json.data.capabilities.reason, /sessionController/)
    const events = await request(panel, 'GET', '/api/console/events?sessionId=session-console')
    assert.equal(events.status, 503)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the artifact route only opens files a run report names', async () => {
  const { base, state } = await fixture()
  const outDir = path.join(base, 'out')
  await fsp.mkdir(outDir, { recursive: true })
  const reportFile = path.join(outDir, 'report.html')
  await fsp.writeFile(reportFile, '<h1>ok</h1>')
  const secret = path.join(base, 'secret.txt')
  await fsp.writeFile(secret, 'nope')
  const { host } = fakeHost()
  host.listRuns = async () => [{ id: 'run-1', report: `wrote ${reportFile}` }]
  host.readRun = async (sessionId, runId) => (runId === 'run-1' ? { id: 'run-1', report: `wrote ${reportFile}` } : null)
  let panel = null
  try {
    panel = await startConsole(state, host)
    assert.equal((await request(panel, 'POST', '/api/console/bootstrap', {})).status, 200)
    const query = `path=${encodeURIComponent(reportFile)}&runId=run-1&token=${encodeURIComponent(panel.token)}`
    const listed = await fetch(`${panel.url}/api/console/artifact?${query}`)
    assert.equal(listed.status, 200)
    assert.match(listed.headers.get('content-security-policy') ?? '', /sandbox/)
    assert.match(await listed.text(), /<h1>ok<\/h1>/)
    const denied = await fetch(`${panel.url}/api/console/artifact?path=${encodeURIComponent(secret)}&token=${encodeURIComponent(panel.token)}`)
    assert.equal(denied.status, 403)
    const unauthorized = await fetch(`${panel.url}/api/console/artifact?path=${encodeURIComponent(reportFile)}`)
    assert.equal(unauthorized.status, 401)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a restart reopens the same conversation, and a dead id is forgotten rather than faked', async () => {
  const { base, state } = await fixture()
  let first = null
  let second = null
  try {
    const fake = fakeHost({
      sessionId: 'session-console',
      onPrompt: text => [{
        type: 'stream.snapshot',
        header: { id: 'session-console' },
        cursor: 1,
        records: [{
          type: 'event',
          event: {
            type: 'user/message',
            seq: 1,
            time: Date.now(),
            data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
          },
        }],
      }],
    })
    first = await startConsole(state, fake.host)
    const boot = await request(first, 'POST', '/api/console/bootstrap', {})
    assert.equal(boot.status, 200)
    assert.equal(boot.json.data.sessionId, 'session-console')
    const live = await fetch(`${first.url}/api/console/events?sessionId=session-console`, {
      headers: { authorization: `Bearer ${first.token}` },
    })
    assert.equal(live.status, 200)
    // Keep the tab open (no read/abort): the prompt's frames must reach a real
    // subscriber, which is what fills the remembered transcript.
    await request(first, 'POST', '/api/console/message', { text: '记住这一句' })
    const timeline = path.join(state, 'console-timeline.json')
    let saved = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      saved = JSON.parse(await fsp.readFile(timeline, 'utf8').catch(() => 'null'))
      if ((saved?.records?.length ?? 0) > 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(saved?.sessionId, 'session-console')
    assert.ok(
      JSON.stringify(saved.records).includes('记住这一句'),
      `the transcript window must be remembered, got ${JSON.stringify(saved.records).slice(0, 300)}`,
    )
  } finally {
    if (first) await first.stop()
  }
  try {
    // Same state root, new process: the remembered id and transcript come back,
    // so the page reopens the same words instead of an empty conversation.
    second = await startConsole(state, fakeHost().host)
    const stateResponse = await request(second, 'GET', '/api/console/state')
    assert.equal(stateResponse.json.data.sessionId, 'session-console')
    const boot = await request(second, 'POST', '/api/console/bootstrap', {})
    assert.equal(boot.json.data.sessionId, 'session-console')
    const replay = await fetch(`${second.url}/api/console/events?sessionId=session-console`, {
      headers: { authorization: `Bearer ${second.token}` },
    })
    const frames = await collectFrames(replay, { count: 2, timeoutMs: 800 })
    assert.ok(
      frames.some(frame => JSON.stringify(frame).includes('记住这一句')),
      `the first opening after a restart must carry the transcript, got ${JSON.stringify(frames).slice(0, 400)}`,
    )
  } finally {
    if (second) await second.stop()
  }
  // A remembered session the host can no longer open is dropped, not replayed.
  const broken = fakeHost()
  broken.host.subscribe = () => {
    throw new Error('session not found')
  }
  let third = null
  try {
    third = await startConsole(state, broken.host)
    const response = await fetch(`${third.url}/api/console/events?sessionId=session-console`, {
      headers: { authorization: `Bearer ${third.token}` },
    })
    assert.equal(response.status, 200)
    await collectFrames(response, { count: 1, timeoutMs: 300 }).catch(() => {})
    const after = await request(third, 'GET', '/api/console/state')
    assert.equal(after.json.data.sessionId, null)
    let saved = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      saved = JSON.parse(await fsp.readFile(path.join(state, 'console-timeline.json'), 'utf8').catch(() => 'null'))
      if (saved?.sessionId === null) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(saved?.sessionId, null)
  } finally {
    if (third) await third.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('an oversized remembered timeline is rewritten to the stated bound at startup', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    // A file left by an older build: 200 fat records, well past both bounds.
    const records = Array.from({ length: 200 }, (_, index) => ({
      type: 'event',
      event: {
        type: 'user/message',
        seq: index + 1,
        time: Date.now(),
        data: { content: [{ type: 'text', text: 'x'.repeat(2000) }], source: { kind: 'user' } },
      },
    }))
    await fsp.writeFile(
      path.join(state, 'console-timeline.json'),
      JSON.stringify({ version: 1, sessionId: 'session-console', savedAt: new Date().toISOString(), records }),
    )
    panel = await startConsole(state, fakeHost().host)
    let saved = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      saved = JSON.parse(await fsp.readFile(path.join(state, 'console-timeline.json'), 'utf8'))
      if (saved.records.length <= 120) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(saved.sessionId, 'session-console')
    assert.ok(saved.records.length <= 120, `expected at most 120 records, got ${saved.records.length}`)
    assert.ok(
      Buffer.byteLength(JSON.stringify(saved.records)) <= 160 * 1024,
      `expected at most 160 KiB of records, got ${Buffer.byteLength(JSON.stringify(saved.records))}`,
    )
    assert.ok(saved.records.length > 0, 'trimming must keep the newest records, not drop them all')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the console stops a run, lists conversations and refuses a foreign one', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const fake = fakeHost()
    const cancelled = []
    const host = {
      ...fake.host,
      cancelRun: async (sessionId, runId) => {
        cancelled.push({ sessionId, runId })
        if (runId !== 'run-1') return null
        return { runId, status: 'cancelled', cancelPending: false }
      },
      listSessions: async () => ([{
        sessionId: 'session-console',
        updatedAt: Date.UTC(2026, 10, 15, 16, 18),
        running: false,
        blank: false,
        runs: 2,
        artifacts: 3,
        first: '并行写三个小文件',
        title: null,
      }]),
      openSession: async id => (id === 'session-console' ? { sessionId: id } : null),
      // The rail route groups the host's own run rows per conversation.
      listSchedules: async () => ([{
        sessionId: 'session-console',
        updatedAt: Date.UTC(2026, 10, 15, 16, 18),
        running: true,
        blank: false,
        rows: [{ id: 'run-1', status: 'running', subtasks: [{ key: 's1', status: 'running' }] }],
      }]),
    }
    panel = await startConsole(state, host)
    await request(panel, 'POST', '/api/console/session', {})

    const schedules = await request(panel, 'GET', '/api/console/schedules')
    assert.equal(schedules.status, 200)
    assert.equal(schedules.json.data.sessions[0].rows[0].id, 'run-1')
    assert.equal(schedules.json.data.sessions[0].rows[0].subtasks[0].status, 'running')

    const sessions = await request(panel, 'GET', '/api/console/sessions')
    assert.equal(sessions.status, 200)
    assert.equal(sessions.json.data.currentSessionId, 'session-console')
    assert.equal(sessions.json.data.sessions.length, 1)
    assert.equal(sessions.json.data.sessions[0].artifacts, 3)

    const stopped = await request(panel, 'POST', '/api/console/runs/run-1/cancel', {})
    assert.equal(stopped.status, 200)
    assert.equal(stopped.json.data.status, 'cancelled')
    assert.deepEqual(cancelled, [{ sessionId: 'session-console', runId: 'run-1' }])

    const missing = await request(panel, 'POST', '/api/console/runs/run-404/cancel', {})
    assert.equal(missing.status, 404)

    const foreign = await request(panel, 'POST', '/api/console/session/switch', { sessionId: 'session-someone-else' })
    assert.equal(foreign.status, 404)

    const reopen = await request(panel, 'POST', '/api/console/session/switch', { sessionId: 'session-console' })
    assert.equal(reopen.status, 200)
    assert.equal(reopen.json.data.switched, false)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a remembered conversation that had no saved words still records the next turn', async () => {
  const { base, state } = await fixture()
  let first = null
  let second = null
  try {
    first = await startConsole(state, fakeHost().host)
    await request(first, 'POST', '/api/console/bootstrap', {})
  } finally {
    if (first) await first.stop()
  }
  const fake = fakeHost({
    sessionId: 'session-console',
    onPrompt: text => [{
      type: 'stream.snapshot',
      header: { id: 'session-console' },
      cursor: 1,
      records: [{
        type: 'event',
        event: {
          type: 'user/message',
          seq: 1,
          time: Date.now(),
          data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
        },
      }],
    }],
  })
  try {
    second = await startConsole(state, fake.host)
    const live = await fetch(`${second.url}/api/console/events?sessionId=session-console`, {
      headers: { authorization: `Bearer ${second.token}` },
    })
    assert.equal(live.status, 200)
    await request(second, 'POST', '/api/console/message', { text: '这句要留下' })
    let saved = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      saved = JSON.parse(await fsp.readFile(path.join(state, 'console-timeline.json'), 'utf8').catch(() => 'null'))
      if ((saved?.records?.length ?? 0) > 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(
      JSON.stringify(saved?.records ?? []).includes('这句要留下'),
      `a restored conversation must keep recording, got ${JSON.stringify(saved?.records ?? []).slice(0, 200)}`,
    )
  } finally {
    if (second) await second.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('closing the last page parks a pending approval instead of cancelling it', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    panel = await startConsole(state, fakeHost().host)
    await request(panel, 'POST', '/api/console/session', {})
    const response = await fetch(`${panel.url}/api/console/events?sessionId=session-console`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    const reader = response.body.getReader()
    await reader.read() // hello
    const answer = panel.askApproval({ toolName: 'write_file', reason: 'outside every allowed root' })
    await new Promise(resolve => setTimeout(resolve, 60))
    const before = await request(panel, 'GET', '/api/console/state')
    assert.equal(before.json.data.approvals.length, 1)
    const approvalId = before.json.data.approvals[0].id

    await reader.cancel()
    const settled = await Promise.race([
      answer,
      new Promise(resolve => setTimeout(() => resolve('still-waiting'), 600)),
    ])
    assert.equal(settled, 'still-waiting', 'closing the panel must not answer a tool call')
    const after = await request(panel, 'GET', '/api/console/state')
    assert.equal(after.json.data.approvals.length, 1, 'the question survives for the next client')

    // Reopening and answering still works, and the parked call resolves 允许.
    const again = await fetch(`${panel.url}/api/console/events?sessionId=session-console`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    const againReader = again.body.getReader()
    await againReader.read()
    const decision = await request(panel, 'POST', '/api/console/approval', { id: approvalId, decision: 'allow' })
    assert.equal(decision.status, 200)
    assert.match(String(await answer), /^allow/)
    await againReader.cancel()

    // A stray answer cannot revive a settled ask, and only an owner may answer.
    const unknown = await request(panel, 'POST', '/api/console/approval', { id: 'ap_missing', decision: 'allow' })
    assert.equal(unknown.status, 409)
    const bad = await request(panel, 'POST', '/api/console/approval', { id: 'ap_missing', decision: 'maybe' })
    assert.equal(bad.status, 400)
    const anonymous = await request(panel, 'POST', '/api/console/approval', { id: 'ap_missing', decision: 'allow' }, null)
    assert.equal(anonymous.status, 401)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('two pending approvals keep their own identity and decisions', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    panel = await startConsole(state, fakeHost().host)
    await request(panel, 'POST', '/api/console/session', {})
    const response = await fetch(`${panel.url}/api/console/events?sessionId=session-console`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    const reader = response.body.getReader()
    await reader.read() // hello
    const first = panel.askApproval({ toolName: 'write_file', callId: 'call-a', reason: 'first outside write' })
    const second = panel.askApproval({ toolName: 'write_file', callId: 'call-b', reason: 'second outside write' })
    await new Promise(resolve => setTimeout(resolve, 60))

    const view = await request(panel, 'GET', '/api/console/state')
    assert.equal(view.json.data.approvals.length, 2)
    const [a, b] = view.json.data.approvals
    assert.notEqual(a.id, b.id)
    assert.equal(a.callId, 'call-a')
    assert.equal(b.callId, 'call-b')
    assert.equal(a.reason, 'first outside write')
    assert.equal(b.reason, 'second outside write')

    const allow = await request(panel, 'POST', '/api/console/approval', { id: a.id, decision: 'allow' })
    assert.equal(allow.status, 200)
    assert.equal(await first, 'allowed-once')
    const duplicate = await request(panel, 'POST', '/api/console/approval', { id: a.id, decision: 'reject' })
    assert.equal(duplicate.status, 409)
    const remaining = await request(panel, 'GET', '/api/console/state')
    assert.deepEqual(remaining.json.data.approvals.map(entry => entry.id), [b.id])

    const reject = await request(panel, 'POST', '/api/console/approval', { id: b.id, decision: 'reject' })
    assert.equal(reject.status, 200)
    assert.equal(await second, 'rejected')
    await reader.cancel().catch(() => {})
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('an approval never resolves without a page, and refuses stray answers', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    panel = await startConsole(state, fakeHost().host)
    // No stream is open, so the only honest answer is "nobody decided".
    assert.equal(
      await panel.askApproval({ toolName: 'write_file', reason: 'blocked outside the workspace' }),
      'cancelled',
    )
    const unknown = await request(panel, 'POST', '/api/console/approval', { id: 'ap_missing', decision: 'allow' })
    assert.equal(unknown.status, 409)
    const bad = await request(panel, 'POST', '/api/console/approval', { id: 'ap_missing', decision: 'maybe' })
    assert.equal(bad.status, 400)
    const anonymous = await request(panel, 'POST', '/api/console/approval', { id: 'ap_missing', decision: 'allow' }, null)
    assert.equal(anonymous.status, 401)
    const view = await request(panel, 'GET', '/api/console/state')
    assert.deepEqual(view.json.data.approvals, [])
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})


test('an approval shows what it will do, when it expires, and can be allowed for the conversation', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const fake = fakeHost({ sessionId: 'session-approval' })
    let created = 0
    fake.host.createSession = async () => ({ sessionId: `session-approval-${++created}` })
    panel = await startConsole(state, fake.host)
    assert.equal((await request(panel, 'POST', '/api/console/session', {})).status, 200)
    const boot = await request(panel, 'GET', '/api/console/state')
    const sessionId = boot.json.data.sessionId
    const stream = await fetch(`${panel.url}/api/console/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    assert.equal(stream.status, 200)
    const collected = collectFrames(stream, { count: 100, timeoutMs: 2000 })
    await new Promise(resolve => setTimeout(resolve, 30))

    const waitForApproval = async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const view = await request(panel, 'GET', '/api/console/state')
        const pending = view.json.data.approvals
        if (pending.length > 0) return pending[0]
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('no approval reached the page')
    }

    const writeArgs = JSON.stringify({
      path: 'D:\\work\\report.md',
      content: `# 结果\n\n- 一\n- 二\n${'x'.repeat(4200)}`,
    })
    const first = panel.askApproval({
      toolName: 'write_file',
      callId: 'call-write-1',
      callArguments: writeArgs,
      reason: 'blocked outside the workspace',
      source: '子任务 A',
    })
    const asked = await waitForApproval()
    assert.equal(asked.toolName, 'write_file')
    assert.equal(asked.callArguments.length, 4000, 'the payload must cap the arguments, not drop them')
    assert.ok(asked.callArguments.includes('report.md'), 'the page needs the real path and body to preview it')
    const expiresAt = Date.parse(asked.expiresAt)
    assert.ok(Number.isFinite(expiresAt), `expiresAt must be a date, got ${asked.expiresAt}`)
    assert.ok(expiresAt - Date.now() > 9 * 60 * 1000, 'the deadline must be visible far enough ahead')

    const allowTool = await request(panel, 'POST', '/api/console/approval', {
      id: asked.id,
      decision: 'allow-tool',
    })
    assert.equal(allowTool.status, 200)
    assert.deepEqual(allowTool.json.data, {
      id: asked.id, outcome: 'allowed-once', scope: 'tool', toolName: 'write_file',
    })
    assert.equal(await first, 'allowed-once')

    // The same tool inside this conversation no longer interrupts, and the
    // host still receives an allow-once answer it understands.
    assert.equal(
      await panel.askApproval({ toolName: 'write_file', callId: 'call-write-2', callArguments: writeArgs }),
      'allowed-once',
    )
    assert.deepEqual((await request(panel, 'GET', '/api/console/state')).json.data.approvals, [])

    // A different tool still asks, and a plain reject keeps working.
    const shell = panel.askApproval({
      toolName: 'shell',
      callId: 'call-shell-1',
      callArguments: JSON.stringify({ command: 'node scripts/report.mjs --out D:\\work\\report.md' }),
    })
    const shellAsk = await waitForApproval()
    assert.equal(shellAsk.toolName, 'shell')
    const rejected = await request(panel, 'POST', '/api/console/approval', {
      id: shellAsk.id,
      decision: 'reject',
    })
    assert.equal(rejected.status, 200)
    assert.equal(await shell, 'rejected')

    // A new conversation drops the tool allowance: the same tool asks again.
    assert.equal((await request(panel, 'POST', '/api/console/session', {})).status, 200)
    const again = panel.askApproval({ toolName: 'write_file', callId: 'call-write-3', callArguments: writeArgs })
    const fresh = await waitForApproval()
    assert.equal(fresh.toolName, 'write_file')
    await request(panel, 'POST', '/api/console/approval', { id: fresh.id, decision: 'reject' })
    assert.equal(await again, 'rejected')

    const frames = await collected
    const askedFrames = frames.filter(frame => frame.type === 'approval' && frame.action === 'asked')
    assert.ok(askedFrames.length >= 3, `expected every ask on the stream, got ${JSON.stringify(frames.map(f => f.action))}`)
    assert.ok(askedFrames.every(frame => frame.approval?.expiresAt), 'each ask must carry its deadline')
    const toolDecision = frames.find(frame => frame.type === 'approval' && frame.action === 'decided' && frame.scope === 'tool')
    assert.ok(toolDecision, 'the page must hear that the whole tool was allowed')
    const auto = frames.find(frame => frame.type === 'approval' && frame.action === 'auto')
    assert.equal(auto?.toolName, 'write_file', 'a skipped ask must still be announced')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a dropped file lands inside the conversation workspace and unsafe ones are refused', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const workspace = path.join(base, 'workspace')
    await fsp.mkdir(workspace, { recursive: true })
    const fake = fakeHost({ sessionId: 'session-upload' })
    fake.host.sessionWorkspace = async () => workspace
    panel = await startConsole(state, fake.host, { maxUploadBytes: 1024 })
    assert.equal((await request(panel, 'POST', '/api/console/session', {})).status, 200)

    const text = '# 需求\n\n把这张图放进消息。\n'
    const body = Buffer.from(text, 'utf8').toString('base64')
    const saved = await request(panel, 'POST', '/api/console/upload', { name: '需求.md', data: body })
    assert.equal(saved.status, 200)
    const file = saved.json.data.path
    assert.ok(path.resolve(file).startsWith(path.resolve(workspace) + path.sep), `${file} must stay in ${workspace}`)
    assert.equal(await fsp.readFile(file, 'utf8'), text)
    assert.equal(saved.json.data.size, Buffer.byteLength(text))

    // A name that tries to climb out is reduced to a bare file name.
    const climb = await request(panel, 'POST', '/api/console/upload', { name: '../../../逃出去.md', data: body })
    assert.equal(climb.status, 200)
    assert.equal(path.dirname(path.resolve(climb.json.data.path)), path.dirname(path.resolve(file)))
    assert.ok(!(await fsp.readdir(base)).includes('逃出去.md'), 'nothing may be written beside the workspace')

    // A second drop with the same name does not overwrite the first.
    const again = await request(panel, 'POST', '/api/console/upload', { name: '需求.md', data: body })
    assert.equal(again.status, 200)
    assert.notEqual(again.json.data.path, file)

    const exe = await request(panel, 'POST', '/api/console/upload', { name: 'setup.exe', data: body })
    assert.equal(exe.status, 415)
    assert.ok(exe.json.error.hint.includes('图片'), 'the failure names what can be dropped')

    const big = Buffer.alloc(2048, 0x61).toString('base64')
    const tooLarge = await request(panel, 'POST', '/api/console/upload', { name: '大文件.md', data: big })
    assert.equal(tooLarge.status, 413)
    assert.ok(tooLarge.json.error.summary.includes('超过'), tooLarge.json.error.summary)

    const anonymous = await request(panel, 'POST', '/api/console/upload', { name: '需求.md', data: body }, null)
    assert.equal(anonymous.status, 401)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('notices stay read after the page is closed and the console restarts', async () => {
  const { base, state } = await fixture()
  let panel = null
  try {
    const fake = fakeHost({ sessionId: 'session-notice' })
    panel = await startConsole(state, fake.host)
    assert.equal((await request(panel, 'POST', '/api/console/session', {})).status, 200)
    const boot = await request(panel, 'GET', '/api/console/state')
    assert.deepEqual(boot.json.data.readNoticeIds, [])

    const ids = ['run:r1:completed', 'run:r2:attention']
    const marked = await request(panel, 'POST', '/api/console/notices/read', { ids })
    assert.equal(marked.status, 200)
    assert.equal(marked.json.data.added, 2)
    const twice = await request(panel, 'POST', '/api/console/notices/read', { ids })
    assert.equal(twice.json.data.added, 0)

    const empty = await request(panel, 'POST', '/api/console/notices/read', { ids: [] })
    assert.equal(empty.status, 400)
    const anonymous = await request(panel, 'POST', '/api/console/notices/read', { ids }, null)
    assert.equal(anonymous.status, 401)

    await panel.stop()
    panel = await startConsole(state, fake.host)
    const reopened = await request(panel, 'GET', '/api/console/state')
    assert.deepEqual([...reopened.json.data.readNoticeIds].sort(), [...ids].sort())
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the host-origin relay carries the console API and adds the token itself', async () => {
  const { state } = await fixture()
  const panel = await startConsole(state, fakeHost())
  const relay = http.createServer((req, res) => panel.proxy(req, res))
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${relay.address().port}`
  try {
    // The panel sends no credentials: the node half supplies them.
    const state1 = await fetch(`${origin}/superagent/api/console/state`, { headers: { accept: 'application/json' } })
    assert.equal(state1.status, 200)
    const body = await state1.json()
    assert.equal(body.ok, true)
    assert.ok(body.data.sessionId === null || typeof body.data.sessionId === 'string')

    // The prefix maps to `/api`, and unknown routes still come back as JSON.
    const missing = await fetch(`${origin}/superagent/api/console/nope`, { headers: { accept: 'application/json' } })
    assert.equal(missing.status, 404)
    const answer = await missing.json()
    assert.equal(answer.ok, false)
  } finally {
    await new Promise(resolve => relay.close(resolve))
    await panel.stop()
    await fsp.rm(path.dirname(state), { recursive: true, force: true })
  }
})

test('the console binds and revokes a source with the same token it uses for everything else', async () => {
  const { base, state } = await fixture()
  const sourceRoot = path.join(base, 'sources')
  await fsp.mkdir(sourceRoot, { recursive: true })
  const store = createSourceStore({ root: sourceRoot })
  const task = {
    id: 'goal-empty', project: '/work/one', title: '准备发布说明', status: 'running',
    phases: [{ id: 'p1', title: '准备发布说明', status: 'running' }],
  }
  const ingress = createSourceIngress({
    store,
    router: { submitSource: async () => ({ status: 'delivered' }) },
    config: {
      github: { enabled: true, instanceId: 'gh-console', secret: 'console-secret' },
      feishu: { enabled: true, instanceId: 'fs-console', encryptKey: 'console-key', verificationToken: 'console-token' },
    },
    catalog: async () => ({ projects: [{ name: 'one', cwd: '/work/one' }], tasks: [task] }),
  })
  const panel = await startConsole(state, fakeHost().host, { sources: ingress })
  try {
    const anonymous = await request(panel, 'POST', '/api/console/sources/bind', {
      source: 'github', objectId: 'github:1:issue:7', project: '/work/one', taskId: 'goal-empty', phaseId: 'p1',
    }, null)
    assert.equal(anonymous.status, 401, 'a binding cannot be written without the console token')

    const bound = await request(panel, 'POST', '/api/console/sources/bind', {
      source: 'github', objectId: 'github:1:issue:7', project: '/work/one', taskId: 'goal-empty', phaseId: 'p1',
    })
    assert.equal(bound.status, 200, bound.text)
    const binding = bound.json.data.binding
    assert.equal(binding.taskId, 'goal-empty')
    assert.equal(binding.phaseId, 'p1')
    assert.equal(binding.revokedAt, null)

    const listed = await request(panel, 'GET', '/api/console/sources')
    assert.ok(listed.json.data.bindings.some(item => item.id === binding.id), 'the card cannot see the new binding')

    const unknown = await request(panel, 'POST', '/api/console/sources/unbind', { id: 'missing' })
    assert.equal(unknown.status, 404, 'an unknown binding must not report success')

    const revoked = await request(panel, 'POST', '/api/console/sources/unbind', { id: binding.id })
    assert.equal(revoked.status, 200, revoked.text)
    const after = await request(panel, 'GET', '/api/console/sources')
    assert.equal(after.json.data.bindings.find(item => item.id === binding.id), undefined, 'a revoked binding must disappear from the card')
  } finally {
    await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})
