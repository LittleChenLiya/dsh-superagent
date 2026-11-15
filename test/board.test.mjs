import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBoard } from '../lib/board.js'
import { explainFailure } from '../lib/board-messages.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createStore } from '../lib/store.js'

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

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString()
}

function fixtureRun() {
  return {
    id: 'run-1',
    goal: '修复登录崩溃并补一组回归测试',
    status: 'failed',
    mode: 'planned',
    createdAt: iso(-120_000),
    finishedAt: iso(-10_000),
    parentSessionId: 'session-owner',
    usage: { totalTokens: 4_200, inputTokens: 3_000, outputTokens: 1_200 },
    cost: { text: '¥0.12', currency: 'CNY', unpriced: [] },
    attention: {
      at: iso(-60_000),
      items: [
        {
          id: 'q1',
          source: 'planner',
          question: '旧版 Node 18 还要不要支持？',
          options: ['继续支持', '只支持 Node 20+'],
          reason: '目标里没有写兼容范围',
        },
      ],
    },
    subtasks: [
      {
        key: 'w1',
        index: 1,
        title: '读取崩溃日志',
        status: 'completed',
        attempts: 1,
        startedAt: iso(-110_000),
        finishedAt: iso(-90_000),
        result: '找到三处空指针。',
        usage: { totalTokens: 900 },
        cost: { text: '¥0.02', currency: 'CNY', unpriced: [] },
        dependsOn: [],
        deliverables: ['notes/crash.md'],
      },
      {
        key: 'w2',
        index: 2,
        title: '复现并修复',
        status: 'failed',
        attempts: 2,
        startedAt: iso(-90_000),
        finishedAt: iso(-30_000),
        error: 'spawn EPERM',
        dependsOn: ['w1'],
      },
      {
        key: 'w3',
        index: 3,
        title: '补回归测试',
        status: 'skipped',
        skipKind: 'upstream',
        dependsOn: ['w2'],
        waitingOn: ['w2'],
        attempts: 0,
      },
    ],
  }
}

function activeRun() {
  return {
    id: 'run-2',
    goal: '整理发布说明',
    status: 'running',
    createdAt: iso(-8_000),
    parentSessionId: 'session-owner',
    usage: { totalTokens: 150 },
    subtasks: [
      { key: 'w1', index: 1, title: '收集提交记录', status: 'completed', attempts: 1, startedAt: iso(-7_000), finishedAt: iso(-4_000), dependsOn: [] },
      { key: 'w2', index: 2, title: '写发布摘要', status: 'running', attempts: 1, startedAt: iso(-4_000), dependsOn: ['w1'] },
      { key: 'w3', index: 3, title: '校对链接', status: 'waiting', dependsOn: ['w2'] },
    ],
  }
}

function unverifiedRun() {
  return {
    id: 'run-3',
    goal: '导出兼容性矩阵',
    status: 'partial',
    createdAt: iso(-40_000),
    finishedAt: iso(-5_000),
    parentSessionId: 'session-owner',
    subtasks: [
      {
        key: 'w1',
        index: 1,
        title: '生成矩阵文件',
        status: 'unverified',
        attempts: 1,
        startedAt: iso(-35_000),
        finishedAt: iso(-8_000),
        unverifiedReason: '当前会话没有表格读取工具。',
        result: 'matrix.csv 已生成。',
        deliverables: ['matrix.csv'],
      },
    ],
  }
}

function templateList() {
  return [
    {
      id: 'bugfix-verify',
      title: 'Fix a bug and prove it with tests',
      whenToUse: '有一个能复现的缺陷',
      whenNotToUse: ['缺陷还无法复现'],
      variables: [
        { name: 'symptom', description: 'The error you see' },
        { name: 'reproduction', description: 'Steps' },
        { name: 'expected', description: 'Expected behaviour' },
      ],
    },
    { id: 'review-fix', title: 'Review and fix', whenToUse: '提交前审查', whenNotToUse: [], variables: [{ name: 'target', description: 'Diff' }] },
    { id: 'docs-examples', title: 'Docs', whenToUse: '文档过时', whenNotToUse: [], variables: [{ name: 'change', description: 'What changed' }] },
    { id: 'research-report', title: 'Research', whenToUse: '需要报告', whenNotToUse: [], variables: [{ name: 'question', description: 'Question' }] },
  ]
}

function fakeHost({ extras = [] } = {}) {
  const runs = new Map([
    ['run-1', fixtureRun()],
    ['run-2', activeRun()],
    ['run-3', unverifiedRun()],
  ])
  const calls = []
  const host = {
    capabilities: () => ({ start: true, answer: true, reason: null }),
    templates: async () => templateList(),
    listRuns: async () => [...runs.values()],
    readRun: async id => runs.get(id) ?? null,
    answer: async args => {
      calls.push(['answer', args])
      return { ...args, status: 'completed', resumed: true }
    },
    cancelSubtask: async args => {
      calls.push(['cancelSubtask', args])
      const run = runs.get(args.runId)
      const subtask = run.subtasks.find(item => item.key === args.subtask)
      subtask.status = 'cancelled'
      return run
    },
    rerunSubtask: async args => {
      calls.push(['rerunSubtask', args])
      return { ...runs.get(args.runId), status: 'queued' }
    },
    reviewSubtask: async args => {
      calls.push(['reviewSubtask', args])
      return { ...runs.get(args.runId), status: 'queued' }
    },
    resumeRun: async args => {
      calls.push(['resumeRun', args])
      return { ...runs.get(args.runId), status: 'queued' }
    },
    startTemplate: async args => {
      calls.push(['startTemplate', args])
      return { id: 'run-4', status: 'queued' }
    },
    extraInbox: async () => extras,
    answerInbox: async args => {
      calls.push(['answerInbox', args])
      return { message: '已处理' }
    },
    auditFor: async ({ runId }) => [
      {
        id: 'e1',
        at: iso(-80_000),
        kind: 'worker.start',
        action: 'start_subtask',
        subtaskId: 'subtask-2',
        actor: 'session:session-owner',
        decision: 'allow',
        result: 'ok',
        target: '复现并修复',
        meta: {},
      },
    ],
  }
  return { host, calls, runs }
}

async function startBoard({ extras } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-board-'))
  const harness = fakeHost({ extras })
  const panel = createBoard({
    port: 0,
    stateRoot: base,
    host: harness.host,
    version: 'test',
    log: () => {},
  })
  await panel.start()
  return { panel, base, calls: harness.calls }
}

async function request(panel, method, route, { body, token = panel.token, headers = {} } = {}) {
  const merged = { ...headers }
  if (token !== null) merged.authorization = `Bearer ${token}`
  if (body !== undefined) merged['content-type'] = 'application/json'
  const response = await fetch(`${panel.url}${route}`, {
    method,
    headers: merged,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // The page is HTML.
  }
  return { status: response.status, json, text }
}

async function collectFrames(response, { count = 1, timeoutMs = 2500 } = {}) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames = []
  let buffer = ''
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs)
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
          try {
            frames.push(JSON.parse(line.slice(5).trimStart()))
          } catch {
            // A malformed frame does not make the stream unreadable.
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

test('board refuses requests without its token and publishes a discovery file', async t => {
  const { panel, base } = await startBoard()
  t.after(() => panel.stop())

  const denied = await request(panel, 'GET', '/api/board/state', { token: null })
  assert.equal(denied.status, 401)
  assert.equal(denied.json.error.id, 'unauthorized')

  const page = await fetch(`${panel.url}/`)
  assert.equal(page.status, 401)
  const allowed = await fetch(`${panel.url}/?token=${encodeURIComponent(panel.token)}`)
  assert.equal(allowed.status, 200)
  assert.match(await allowed.text(), /任务看板/)

  const discovery = JSON.parse(await fsp.readFile(path.join(base, 'board.json'), 'utf8'))
  assert.equal(discovery.service, 'dsh-superagent-board')
  assert.equal(discovery.url, panel.url)
  assert.equal(discovery.mode, 'ready')
  assert.ok(discovery.token.length > 20)
})

test('board rejects a foreign Host header even with the right token', async t => {
  const { panel } = await startBoard()
  t.after(() => panel.stop())
  const port = new URL(panel.url).port
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/board/health',
      headers: { host: 'evil.example:80', authorization: `Bearer ${panel.token}` },
    }, res => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 403)
})

test('board state turns runs into Chinese subtask cards and an inbox', async t => {
  const { panel } = await startBoard()
  t.after(() => panel.stop())

  const state = (await request(panel, 'GET', '/api/board/state')).json.data
  assert.equal(state.service, 'dsh-superagent-board')
  assert.equal(state.runs.length, 3)
  assert.equal(state.templates.length, 4)

  const failed = state.runs.find(run => run.id === 'run-1')
  assert.equal(failed.statusLabel, '失败')
  assert.equal(failed.subtasks.find(item => item.key === 'w1').statusLabel, '已完成')
  assert.equal(failed.subtasks.find(item => item.key === 'w2').explanation.code, 'spawn-eperm')
  assert.match(failed.subtasks.find(item => item.key === 'w2').explanation.title, /系统拒绝/)
  assert.match(failed.subtasks.find(item => item.key === 'w3').skipReason, /前置任务没有完成/)
  assert.equal(failed.counts.completed, 1)

  const active = state.runs.find(run => run.id === 'run-2')
  const running = active.subtasks.find(item => item.key === 'w2')
  assert.equal(running.canCancel, true)
  assert.equal(running.canRerun, false)

  const question = state.inbox.find(item => item.id === 'question:run-1:q1')
  assert.ok(question)
  assert.match(question.title, /旧版 Node 18/)
  assert.deepEqual(question.options, ['继续支持', '只支持 Node 20+'])

  const review = state.inbox.find(item => item.id === 'review:run-3:w1')
  assert.ok(review)
  assert.equal(review.kind, 'review')
})

test('the inbox routes an answer to the right host action', async t => {
  const { panel, calls } = await startBoard()
  t.after(() => panel.stop())

  const answered = await request(panel, 'POST', '/api/board/inbox/question:run-1:q1/answer', {
    body: { answer: '只支持 Node 20+' },
  })
  assert.equal(answered.status, 200)
  assert.match(answered.json.data.message, /回答/)
  const questionCall = calls.find(call => call[0] === 'answer')
  assert.deepEqual(questionCall[1], { runId: 'run-1', attentionId: 'q1', answer: '只支持 Node 20+' })

  const reviewed = await request(panel, 'POST', '/api/board/inbox/review:run-3:w1/answer', {
    body: { answer: '确认通过' },
  })
  assert.equal(reviewed.status, 200)
  const reviewCall = calls.find(call => call[0] === 'reviewSubtask')
  assert.equal(reviewCall[1].verdict, 'accept')

  const missing = await request(panel, 'POST', '/api/board/inbox/question:run-1:q1/answer', { body: {} })
  assert.equal(missing.status, 400)
})

test('a resumed run is reported as queued, not completed', async t => {
  const { panel } = await startBoard()
  t.after(() => panel.stop())
  const resume = await request(panel, 'POST', '/api/board/runs/run-1/resume', { body: {} })
  assert.equal(resume.status, 200)
  assert.equal(resume.json.data.status, 'queued')
})

test('cancel, rerun, review, resume and template start all go through the host', async t => {
  const { panel } = await startBoard()
  t.after(() => panel.stop())

  const cancel = await request(panel, 'POST', '/api/board/runs/run-2/subtasks/w2/cancel', { body: {} })
  assert.equal(cancel.status, 200)
  assert.equal(cancel.json.data.status, 'cancelled')

  const rerun = await request(panel, 'POST', '/api/board/runs/run-1/subtasks/w2/rerun', { body: {} })
  assert.equal(rerun.status, 200)
  assert.equal(rerun.json.data.status, 'queued')

  const resume = await request(panel, 'POST', '/api/board/runs/run-1/resume', { body: {} })
  assert.equal(resume.status, 200)

  const start = await request(panel, 'POST', '/api/board/templates/bugfix-verify/start', {
    body: { values: { symptom: '崩溃', reproduction: 'npm start', expected: '正常启动' } },
  })
  assert.equal(start.status, 200)
  assert.equal(start.json.data.runId, 'run-4')
})

test('rerunning a subtask while the run is still working answers 409 with a sentence', async t => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-board-'))
  const host = {
    capabilities: () => ({ start: true, answer: true, reason: null }),
    templates: async () => templateList(),
    listRuns: async () => [activeRun()],
    readRun: async id => (id === 'run-2' ? activeRun() : null),
    rerunSubtask: async () => {
      throw new Error('run run-2 is still active; wait for it to finish or stop the subtask first')
    },
    auditFor: async () => [],
  }
  const panel = createBoard({ port: 0, stateRoot: base, host, version: 'test', log: () => {} })
  await panel.start()
  t.after(() => panel.stop())

  const rerun = await request(panel, 'POST', '/api/board/runs/run-2/subtasks/w2/rerun', { body: {} })
  assert.equal(rerun.status, 409)
  assert.equal(rerun.json.error.id, 'run-active')
  assert.match(rerun.json.error.summary, /还在进行/)
})

test('extra inbox items are shown with a Chinese why and impact', async t => {
  const extras = [
    {
      id: 'permission:evt-1',
      kind: 'permission',
      kindLabel: '需要你授权',
      title: '有一个操作被权限策略拦下，等你点头',
      what: '被拦下的操作：shell / run',
      why: '策略要求人来确认这一次。',
      options: ['允许这次操作', '不允许'],
      impact: '允许后这一次操作会被放行。',
      input: 'choice',
      canAnswer: true,
    },
  ]
  const { panel } = await startBoard({ extras })
  t.after(() => panel.stop())
  const state = (await request(panel, 'GET', '/api/board/state')).json.data
  const item = state.inbox.find(entry => entry.id === 'permission:evt-1')
  assert.ok(item)
  assert.match(item.why, /人来确认/)
  const answered = await request(panel, 'POST', '/api/board/inbox/permission:evt-1/answer', {
    body: { answer: '允许这次操作' },
  })
  assert.equal(answered.status, 200)
  assert.equal(answered.json.data.message, '已处理')
})

test('run detail includes full output, deliverables and per-subtask audit', async t => {
  const { panel } = await startBoard()
  t.after(() => panel.stop())
  const detail = (await request(panel, 'GET', '/api/board/runs/run-1')).json.data
  assert.equal(detail.run.subtasks.length, 3)
  assert.equal(detail.subtasks.find(item => item.key === 'w1').result, '找到三处空指针。')
  assert.deepEqual(detail.subtasks.find(item => item.key === 'w1').deliverables, ['notes/crash.md'])
  assert.equal(detail.subtasks.find(item => item.key === 'w2').audit.length, 1)
  assert.equal(detail.audit.length, 1)
})

test('the event stream opens with a full snapshot, so a reconnect restores the board', async t => {
  const { panel } = await startBoard()
  t.after(() => panel.stop())
  const response = await fetch(`${panel.url}/api/board/events`, {
    headers: { authorization: `Bearer ${panel.token}` },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const frames = await collectFrames(response, { count: 1 })
  assert.equal(frames[0].type, 'snapshot')
  assert.equal(frames[0].data.runs.length, 3)
  assert.ok(frames[0].seq > 0)
})

test('the event stream accepts the token in the query string, since EventSource cannot send headers', async t => {
  const { panel } = await startBoard()
  t.after(() => panel.stop())
  const ok = await fetch(`${panel.url}/api/board/events?token=${encodeURIComponent(panel.token)}`)
  assert.equal(ok.status, 200)
  const frames = await collectFrames(ok, { count: 1 })
  assert.equal(frames[0].type, 'snapshot')
  const wrong = await fetch(`${panel.url}/api/board/events?token=nope`)
  assert.equal(wrong.status, 401)
  const stateWithoutQuery = await fetch(`${panel.url}/api/board/state?token=${encodeURIComponent(panel.token)}`)
  assert.equal(stateWithoutQuery.status, 401, '只有事件流允许把口令放在地址里')
})

test('every known failure has a plain Chinese title and an action', () => {
  const cases = [
    ['missing capability', { status: 'blocked', missingCapabilities: ['browser'] }, 'capability-missing'],
    ['planner did not return a usable plan', { status: 'failed', error: 'planner did not return a usable plan' }, 'plan-unusable'],
    ['deliverable missing', { status: 'failed', error: 'empty deliverable: report.md' }, 'deliverable-missing'],
    ['write denied', { status: 'failed', error: 'sandbox: EACCES write denied' }, 'sandbox-write'],
    ['spawn EPERM', { status: 'failed', error: 'spawn EPERM' }, 'spawn-eperm'],
    ['endpoint down', { status: 'failed', error: 'ECONNREFUSED 127.0.0.1:8080' }, 'model-unavailable'],
    ['child stopped without a result', { status: 'failed', error: 'child stopped with reason "error"' }, 'model-unavailable'],
    ['budget', { status: 'failed', error: 'deadline reached: 60 minutes' }, 'budget-or-timeout'],
    ['owner gone', { status: 'failed', error: 'the owning session s1 is not live' }, 'schedule-owner-gone'],
    ['host stopped mid-run', { status: 'interrupted', error: 'host process stopped while the run was active' }, 'interrupted'],
  ]
  for (const [label, subtask, code] of cases) {
    const explanation = explainFailure({ id: 'r1' }, { key: 'w1', title: label, ...subtask })
    assert.equal(explanation.code, code, label)
    assert.ok(explanation.title.length > 4, label)
    assert.ok(explanation.what.length > 8, label)
    assert.ok(explanation.action, label)
  }
})

test('stopping the board removes its discovery file and closes the socket', async t => {
  const { panel, base } = await startBoard()
  const url = panel.url
  await panel.stop()
  await assert.rejects(fsp.access(path.join(base, 'board.json')))
  const response = await fetch(`${url}/api/board/health`).catch(error => error)
  assert.ok(response instanceof Error)
  void t
})

test('cancelling one subtask keeps the run alive, and rerunning it revives only that branch', async t => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-board-run-'))
  const store = createStore(base)
  await store.init()
  let firstAttempt = 0
  let planCalls = 0
  const spawnChild = async spec => {
    if (spec.label === 'superagent-plan') {
      planCalls += 1
      return {
        childId: `plan-${planCalls}`,
        result: Promise.resolve(completed(JSON.stringify({
          subtasks: [
            { id: 'a', title: '读日志', prompt: 'read the log' },
            { id: 'b', title: '写测试', prompt: 'write the test', dependsOn: ['a'] },
          ],
        }))),
        dispose: async () => {},
      }
    }
    if (spec.label === 'superagent-1') {
      firstAttempt += 1
      if (firstAttempt === 1) {
        return {
          childId: 'slow-a',
          // Deliberately still running: the board's stop button is the only
          // thing that ends this attempt.
          result: new Promise(resolve => setTimeout(() => resolve(completed('a finished late')), 4_000)),
          dispose: async () => {},
        }
      }
      return { childId: 'fast-a', result: Promise.resolve(completed('a finished')), dispose: async () => {} }
    }
    return {
      childId: `child-${spec.label}`,
      result: Promise.resolve(completed(spec.label === 'superagent-aggregate' ? 'report' : 'b finished')),
      dispose: async () => {},
    }
  }
  const orchestrator = createOrchestrator({
    store,
    config: BASE_CONFIG,
    spawnChild,
    readUsage: async () => ({ inputTokens: 10, outputTokens: 2, totalTokens: 12, modelCalls: 1 }),
    log: () => {},
  })
  t.after(() => fsp.rm(base, { recursive: true, force: true }))

  const parent = { id: 'session-owner' }
  const run = await orchestrator.start({ goal: 'fix it', parentSessionId: parent.id, parent })

  let current = run
  for (let tick = 0; tick < 100; tick += 1) {
    current = await orchestrator.status(run.id)
    if (current.subtasks.length === 2
      && current.subtasks.find(item => item.key === 'a')?.status === 'running') break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(current.subtasks.length, 2)
  assert.equal(current.subtasks.find(item => item.key === 'a').status, 'running')

  const stopped = await orchestrator.cancelSubtask(run.id, 'a')
  assert.equal(stopped.status, 'running')
  assert.equal(stopped.subtasks.find(item => item.key === 'a').status, 'cancelled')

  const settled = await orchestrator.status(run.id, 10)
  assert.equal(settled.status, 'cancelled')
  assert.equal(settled.subtasks.find(item => item.key === 'a').status, 'cancelled')
  assert.equal(settled.subtasks.find(item => item.key === 'b').status, 'skipped')
  assert.equal(settled.subtasks.find(item => item.key === 'b').skipKind, 'upstream')

  const failure = explainFailure(settled, settled.subtasks.find(item => item.key === 'a'))
  assert.equal(failure.code, 'cancelled')

  const queued = await orchestrator.rerunSubtask(run.id, 'a', parent)
  assert.equal(queued.status, 'queued')
  assert.deepEqual(
    queued.subtasks.filter(item => item.status === 'pending').map(item => item.key).sort(),
    ['a', 'b'],
  )

  const done = await orchestrator.status(run.id, 10)
  assert.equal(done.status, 'completed')
  assert.equal(done.subtasks.find(item => item.key === 'a').status, 'completed')
  assert.equal(done.subtasks.find(item => item.key === 'b').status, 'completed')

  await assert.rejects(() => orchestrator.cancelSubtask(run.id, 'a'), /has no running subtask|is completed/)
})
