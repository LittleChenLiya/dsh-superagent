import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createConsole } from '../lib/console.js'
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

async function fixture() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-console-'))
  const state = path.join(base, 'state')
  await fsp.mkdir(state, { recursive: true })
  return { base, state }
}

async function startConsole(state, host) {
  const panel = createConsole({
    port: 0,
    stateRoot: state,
    host,
    version: 'test',
    log: () => {},
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
    emit: frame => subscriber?.(frame),
    hasSubscriber: () => Boolean(subscriber),
  }
}

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
    assert.match(html, /这是对话会话，不是 run 指挥台/)
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
        listener(history)
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
    const frames = await collectFrames(second, { count: 3, timeoutMs: 1200 })
    assert.equal(frames[0]?.type, 'hello')
    const replay = frames.find(frame => frame.type === 'stream.snapshot')
    assert.ok(replay, `the second tab must replay the cached snapshot, got ${JSON.stringify(frames)}`)
    assert.equal(replay.records.length, 1)
    // The opening snapshot predates the turn; the second tab must also see what
    // streamed after it, otherwise its transcript misses the ongoing reply.
    const delta = frames.find(frame => frame.type === 'assistant.frame')
    assert.ok(delta, `the second tab must replay the frames since the snapshot, got ${JSON.stringify(frames)}`)
    for (let index = 1; index < frames.length; index += 1) {
      assert.ok(frames[index].seq > frames[index - 1].seq, 'replayed frames must keep increasing sequence numbers')
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
