import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { normalizeFeishuEvent } from '../lib/sources/feishu-events.js'

const VERIFY = 'feishu-verification-token'
const APP_ID = 'cli_test_app'
const APP_SECRET = 'test-app-secret'

async function waitFor(check, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() >= deadline) assert.fail(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function waitForJson(file, timeoutMs = 8000) {
  return waitFor(async () => {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return null
    }
  }, `timed out waiting for ${file}`, timeoutMs)
}

function sessionServices(root) {
  const sessions = new Map([['session-owner', { sessionId: 'session-owner', cwd: root }]])
  const agentFor = id => ({
    id,
    session: { cwd: sessions.get(id)?.cwd ?? root, header: { cwd: sessions.get(id)?.cwd ?? root, delegationDepth: 0 } },
    async followup() {},
  })
  const sessionController = {
    async create({ sessionId, cwd }) {
      const id = sessionId ?? randomUUID()
      sessions.set(id, { sessionId: id, cwd })
      return { sessionId: id }
    },
    async list() { return { items: [...sessions.values()] } },
    async resolveAgent(id) { return { agent: sessions.has(id) ? agentFor(id) : null } },
    async prompt() {},
    async cancel() { return { accepted: true } },
    async events() { return { records: [] } },
    async *follow() {},
  }
  return {
    sessionController,
    agents: {
      get: id => sessions.has(id) ? agentFor(id) : undefined,
      async create({ sessionId, cwd }) {
        sessions.set(sessionId, { sessionId, cwd })
        return { agent: agentFor(sessionId) }
      },
      async resume({ resumeSessionId }) {
        if (!sessions.has(resumeSessionId)) throw new Error('missing session')
        return { agent: agentFor(resumeSessionId) }
      },
    },
    subagents: {
      async startActivation() {
        return { childId: `child-${randomUUID()}`, result: Promise.resolve({
          output: [{ type: 'text', text: 'invalid plan' }], stopReason: 'completed',
        }), async dispose() {} }
      },
    },
  }
}

function feishuFetch({ replies, failReplies = false }) {
  return async (url, init) => {
    if (String(url).includes('/tenant_access_token/')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).includes('/messages/') && String(url).endsWith('/reply')) {
      const body = JSON.parse(init.body)
      replies.push({ uuid: body.uuid, text: JSON.parse(body.content).text })
      if (failReplies) throw new TypeError('fake transport failure')
      return new Response(JSON.stringify({ code: 0, data: { message_id: `om_reply_${replies.length}` } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fake Feishu request: ${url}`)
  }
}

function event({ eventId, messageId, text = '请处理这件事' }) {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', tenant_key: 'tenant-a', token: VERIFY },
    event: {
      sender: { sender_id: { open_id: 'ou_actor' } },
      message: {
        message_id: messageId, chat_id: 'oc_chat', chat_type: 'group', message_type: 'text',
        create_time: '1795230000000', content: JSON.stringify({ text }),
      },
    },
  }
}

async function postEvent(panel, payload) {
  const response = await fetch(`${panel.url}/hooks/feishu`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  assert.equal(response.status, 200, await response.text())
}

async function consoleRequest(panel, method, route, body) {
  const response = await fetch(`${panel.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${panel.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await response.json()
  return { status: response.status, json }
}

async function mountAt(t, root, fetchImpl, contexts) {
  const state = path.join(root, 'state')
  const home = path.join(root, 'home')
  await fsp.mkdir(state, { recursive: true })
  await fsp.mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  const listeners = new Map()
  const effects = []
  const services = sessionServices(root)
  const ctx = {
    tools: { register: () => {} },
    get: name => services[name],
    on(name, listener) {
      const entries = listeners.get(name) ?? []
      entries.push(listener)
      listeners.set(name, entries)
    },
    effect(factory) { effects.push(factory) },
    async dispose() {
      for (const listener of listeners.get('dispose') ?? []) await listener()
      for (const factory of effects.reverse()) await factory()
    },
  }
  contexts.push(ctx)
  apply(ctx, {
    stateDir: state, consolePort: 0, consoleRoot: root, workbenchRoot: root,
    notifyOnComplete: false, audit: true, memory: false, scheduleProvider: 'local',
    sources: { enabled: true, feishu: { enabled: true, instanceId: 'fs', verificationTokenEnv: 'FS_VERIFY',
      outbound: { appIdEnv: 'FS_APP_ID', appSecretEnv: 'FS_APP_SECRET', fetchImpl } } },
  })
  const discovery = await waitForJson(path.join(state, 'console.json'))
  return { state, panel: { url: discovery.url, token: discovery.token }, ctx }
}

async function fixture(t, fetchImpl) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-feishu-outbound-'))
  await fsp.mkdir(path.join(root, 'project'))
  const project = await fsp.realpath(path.join(root, 'project'))
  const previous = Object.fromEntries(['DSH_HOME', 'FS_VERIFY', 'FS_APP_ID', 'FS_APP_SECRET'].map(key => [key, process.env[key]]))
  process.env.FS_VERIFY = VERIFY
  process.env.FS_APP_ID = APP_ID
  process.env.FS_APP_SECRET = APP_SECRET
  const contexts = []
  t.after(async () => {
    for (const ctx of contexts.reverse()) await ctx.dispose()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelayMs: 50 })
  })
  const mounted = await mountAt(t, root, fetchImpl, contexts)
  const registered = await consoleRequest(mounted.panel, 'POST', '/api/console/projects', { cwd: project })
  assert.equal(registered.status, 200, JSON.stringify(registered.json))
  assert.equal(registered.json.data.project.cwd, project)
  return { root, project, contexts, ...mounted }
}

test('normalization retains Feishu topic, actor and chat metadata', () => {
  const normalized = normalizeFeishuEvent({ payload: event({ eventId: 'evt-shape', messageId: 'om_shape' }),
    receivedAt: '2026-11-26T00:00:00.000Z' })
  assert.equal(normalized.subject.chatId, 'oc_chat')
  assert.equal(normalized.subject.rootId, 'om_shape')
  assert.equal(normalized.subject.messageId, 'om_shape')
  assert.equal(normalized.subject.actor, 'ou_actor')
  assert.equal(normalized.subject.openId, 'ou_actor')
  assert.equal(normalized.subject.chatType, 'group')
  assert.deepEqual(normalized.actor, { openId: 'ou_actor' })
})

test('real apply sends short new/followup/status receipts and a redacted terminal topic summary', async t => {
  const replies = []
  const { state, project, panel } = await fixture(t, feishuFetch({ replies }))
  const binding = await consoleRequest(panel, 'POST', '/api/console/sources/bind', {
    source: 'feishu', objectId: 'feishu:tenant-a:message:om_new', project, autoStart: true,
  })
  assert.equal(binding.status, 200, JSON.stringify(binding.json))
  await postEvent(panel, event({ eventId: 'evt-new', messageId: 'om_new', text: '启动一个后台任务' }))
  await waitFor(() => replies.length === 1, 'new-task receipt was not sent')
  assert.match(replies[0].text, /已接新任务/)
  assert.ok(replies[0].text.length < 200)
  const goalId = replies[0].text.match(/g-r[0-9a-f]{28}/)?.[0]
  assert.ok(goalId, replies[0].text)
  const goalFile = path.join(state, 'goals', `${goalId}.json`)
  const goal = await waitForJson(goalFile)
  goal.status = 'paused'
  goal.pausedReason = 'test-control'
  goal.phases = [{ id: 'p1', title: 'Work', status: 'ready', dependsOn: [], summary: null }]
  await fsp.writeFile(goalFile, JSON.stringify(goal))

  const statusBinding = await consoleRequest(panel, 'POST', '/api/console/sources/bind', {
    source: 'feishu', objectId: 'feishu:tenant-a:message:om_status', project, taskId: goalId, intent: 'status',
  })
  assert.equal(statusBinding.status, 200, JSON.stringify(statusBinding.json))
  await postEvent(panel, event({ eventId: 'evt-status', messageId: 'om_status', text: '查询进度' }))
  await waitFor(() => replies.length === 2, 'status receipt was not sent')
  assert.match(replies[1].text, /已查询任务状态/)

  const followBinding = await consoleRequest(panel, 'POST', '/api/console/sources/bind', {
    source: 'feishu', objectId: 'feishu:tenant-a:message:om_follow', project, taskId: goalId, intent: 'followup',
  })
  assert.equal(followBinding.status, 200, JSON.stringify(followBinding.json))
  await postEvent(panel, event({ eventId: 'evt-follow', messageId: 'om_follow', text: '补充验收要求' }))
  await waitFor(() => replies.length === 3, 'followup receipt was not sent')
  assert.match(replies[2].text, /补充要求已送达/)

  const completed = JSON.parse(await fsp.readFile(goalFile, 'utf8'))
  completed.status = 'completed'
  completed.finishedAt = new Date().toISOString()
  completed.phases[0].status = 'completed'
  completed.phases[0].summary = 'Bearer topsecret C:\\private\\report.txt'
  await fsp.writeFile(goalFile, JSON.stringify(completed))
  await waitFor(() => replies.length === 4, 'terminal topic summary was not sent')
  assert.match(replies[3].text, /已结束/)
  assert.equal(replies[3].text.includes('topsecret'), false)
  assert.equal(replies[3].text.includes('private'), false)
  assert.match(replies[3].text, /\[REDACTED\]/)
  assert.match(replies[3].text, /\[path\]/)

  const saved = await waitFor(async () => {
    const current = JSON.parse(await fsp.readFile(path.join(state, 'feishu-outbox.json'), 'utf8'))
    return Object.values(current.records).filter(record => record.status === 'sent').length === 4 ? current : null
  }, 'terminal receipt did not settle in the outbox')
  assert.equal(Object.values(saved.records).filter(record => record.status === 'sent').length, 4)
  assert.equal(JSON.stringify(saved).includes(APP_SECRET), false)
  const audit = await fsp.readFile(path.join(state, 'audit', 'audit.jsonl'), 'utf8')
  assert.match(audit, /feishu\.receipt:/)
  assert.match(audit, /feishu\.terminal\.enqueue/)
  assert.equal(audit.includes(APP_SECRET), false)
})

test('outbox startup recovery resends a pending receipt once and refuses a revoked binding', async t => {
  const replies = []
  const { state, project, panel, ctx, root, contexts } = await fixture(t, feishuFetch({ replies, failReplies: true }))
  const bindings = []
  for (const suffix of ['a', 'b']) {
    const messageId = `om_restart_${suffix}`
    const bound = await consoleRequest(panel, 'POST', '/api/console/sources/bind', {
      source: 'feishu', objectId: `feishu:tenant-a:message:${messageId}`, project, autoStart: true,
    })
    assert.equal(bound.status, 200)
    bindings.push({ messageId, ...bound.json.data })
    await postEvent(panel, event({ eventId: `evt-restart-${suffix}`, messageId }))
  }
  const outboxFile = path.join(state, 'feishu-outbox.json')
  const pending = await waitForJson(outboxFile)
  await waitFor(async () => Object.values(JSON.parse(await fsp.readFile(outboxFile, 'utf8')).records)
    .filter(record => record.status === 'pending').length === 2, 'two receipts did not enter retry backoff')
  await waitFor(() => replies.length === 2, 'both failed receipts were not attempted')
  const revoked = await consoleRequest(panel, 'POST', '/api/console/sources/unbind', { id: bindings[1].binding.id })
  assert.equal(revoked.status, 200)
  await ctx.dispose()

  const successfulReplies = []
  const restarted = await mountAt(t, root, feishuFetch({ replies: successfulReplies }), contexts)
  await waitFor(async () => {
    const current = JSON.parse(await fsp.readFile(outboxFile, 'utf8'))
    return Object.values(current.records).filter(record => record.status === 'sent').length === 1
      && Object.values(current.records).filter(record => record.status === 'dead').length === 1
  }, 'startup recovery did not settle the active and revoked receipts')
  assert.equal(successfulReplies.length, 1)
  const recovered = JSON.parse(await fsp.readFile(outboxFile, 'utf8'))
  const sent = Object.values(recovered.records).find(record => record.status === 'sent')
  const dead = Object.values(recovered.records).find(record => record.status === 'dead')
  assert.equal(successfulReplies[0].uuid, sent.idempotencyKey)
  assert.equal(sent.attempts, 2)
  assert.equal(dead.lastError, 'binding-revoked')
  assert.equal(dead.messageId, bindings[1].messageId)
  assert.equal(pending.records[sent.key].idempotencyKey, sent.idempotencyKey)
  assert.equal(restarted.panel.url.startsWith('http://127.0.0.1:'), true)
})
