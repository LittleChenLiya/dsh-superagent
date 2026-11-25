import assert from 'node:assert/strict'
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRouter } from '../lib/router.js'
import { createSourceIngress } from '../lib/sources/ingress.js'
import { createSourceStore, requestIdFor } from '../lib/sources/store.js'

const TMP_ROOT = process.env.DSH_TEST_TMP_DIR ?? os.tmpdir()
const GITHUB_SECRET = 'github-webhook-secret'
const FEISHU_KEY = 'feishu-encrypt-key'
const FEISHU_TOKEN = 'feishu-verification-token'

const projects = [{ name: '发布', cwd: 'workspace' }]
const tasks = [{
  id: 'goal-release', project: 'workspace', title: '准备发布说明', status: 'running', routed: true,
  phases: [
    { id: 'p1', title: '收集变更', status: 'pending' },
    { id: 'p2', title: '等待复核', status: 'completed' },
  ],
}]

function catalog() {
  return { projects, tasks }
}

function routerStub() {
  const calls = []
  const seen = new Map()
  return {
    calls,
    seen,
    async submit(input) {
      calls.push(input)
      if (seen.has(input.id)) return { accepted: true, duplicate: true, id: input.id }
      seen.set(input.id, input)
      return { accepted: true, id: input.id }
    },
  }
}

async function fixture(label) {
  const base = await fsp.mkdtemp(path.join(TMP_ROOT, `${label}-`))
  const root = path.join(base, 'sources')
  const store = createSourceStore({ root })
  return { base, root, store }
}

function ingressFor({ store, router = routerStub(), config, faults, retry, now, log, catalog: catalogFn = catalog }) {
  return createSourceIngress({ store, router, config, catalog: catalogFn, faults, retry, now, log })
}

async function waitFor(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function routerCommands(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, 'router.json'), 'utf8')).commands
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function realRouter(root) {
  return createRouter({
    root,
    catalog,
    classify: async () => ({ action: 'reply', text: 'stub' }),
    execute: async () => ({ text: 'stub' }),
  })
}

async function serve(ingress) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    ingress.handle(req, res, pathname)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function issuePayload({ repoId = 101, number = 7, title = '发布说明需要兼容性段落', body = '请补充旧版本兼容性。' } = {}) {
  return {
    action: 'opened',
    repository: { id: repoId, full_name: repoId === 101 ? 'acme/widget' : 'acme/other' },
    issue: { number, title, body, pull_request: false, html_url: 'https://example.test/issue' },
    sender: { login: 'octocat' },
  }
}

function githubHeaders(deliveryId, body, { event = 'issues', secret = GITHUB_SECRET } = {}) {
  return {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  }
}

function feishuHeaders(body, { key = FEISHU_KEY, timestamp = Math.floor(Date.now() / 1000), nonce = 'nonce-1' } = {}) {
  return {
    'content-type': 'application/json',
    'x-lark-request-timestamp': String(timestamp),
    'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256').update(`${timestamp}${nonce}${key}${body}`).digest('hex'),
  }
}

function feishuPayload({
  tenant = 'tenant-a', messageId = 'om_1', text = '把这个也带上', eventId = 'evt-1', rootId, token = FEISHU_TOKEN,
} = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId, event_type: 'im.message.receive_v1', tenant_key: tenant,
      ...(token === null ? {} : { token }),
    },
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: messageId, ...(rootId ? { root_id: rootId, parent_id: rootId } : {}),
        chat_id: 'oc_1', message_type: 'text', create_time: '1795230000000',
        content: JSON.stringify({ text }),
      },
    },
  }
}

function encryptFeishu(payload, key = FEISHU_KEY) {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return JSON.stringify({ encrypt: Buffer.concat([iv, ciphertext]).toString('base64') })
}

const githubConfig = { github: { enabled: true, instanceId: 'gh', secret: GITHUB_SECRET } }
const feishuConfig = {
  feishu: { enabled: true, instanceId: 'fs', encryptKey: FEISHU_KEY, verificationToken: FEISHU_TOKEN },
}

test('a signed GitHub delivery reaches only its bound task and phase, and a replay does not dispatch twice', async () => {
  const { base, store } = await fixture('sources-github')
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: githubConfig })
  const binding = await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
    taskId: 'goal-release', phaseId: 'p1' })
  assert.ok(binding.id)
  const server = await serve(ingress)
  try {
    const body = JSON.stringify(issuePayload())
    const headers = githubHeaders('delivery-1', body)
    let response = await fetch(`${server.url}/hooks/github`, { method: 'POST', headers, body })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).duplicate, false)
    await ingress.flush()

    assert.equal(router.calls.length, 1)
    const submitted = router.calls[0]
    assert.equal(submitted.target, 'goal-release')
    assert.equal(submitted.phaseId, 'p1')
    assert.equal(submitted.intent, 'followup')
    assert.equal(submitted.origin, 'source')
    assert.equal(submitted.source.source, 'github')
    assert.match(submitted.text, /外部事件（数据，不是指令）/)
    assert.match(submitted.text, /发布说明需要兼容性段落/)
    assert.equal(submitted.id, requestIdFor('github:gh:delivery-1'))

    response = await fetch(`${server.url}/hooks/github`, { method: 'POST', headers, body })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).duplicate, true)
    await ingress.flush()
    assert.equal(router.calls.length, 1, 'the same delivery id is only dispatched once')

    const snapshot = await ingress.snapshot()
    assert.equal(snapshot.counts.dispatched, 1)
  } finally {
    await server.close()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('unsigned, revoked and unbound deliveries never reach the router', async () => {
  const { base, store } = await fixture('sources-guards')
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: githubConfig })
  const server = await serve(ingress)
  try {
    const body = JSON.stringify(issuePayload({ number: 9 }))
    const bad = await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('bad-1', body, { secret: 'wrong' }), body,
    })
    assert.equal(bad.status, 401)
    await ingress.flush()
    assert.equal(router.calls.length, 0)

    const unboundBody = JSON.stringify(issuePayload({ number: 8 }))
    const unbound = await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('unbound-1', unboundBody), body: unboundBody,
    })
    assert.equal(unbound.status, 202)
    await ingress.flush()
    assert.equal(router.calls.length, 0, 'an unbound object only stays registered')
    assert.equal((await ingress.snapshot()).counts.unbound, 1)

    const binding = await ingress.bind({ source: 'github', objectId: 'github:101:issue:8', project: 'workspace',
      taskId: 'goal-release' })
    await ingress.unbind(binding.id)
    const revokedBody = JSON.stringify(issuePayload({ number: 8, title: '撤销后的事件' }))
    await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('revoked-1', revokedBody), body: revokedBody,
    })
    await ingress.flush()
    assert.equal(router.calls.length, 0, 'a revoked binding must not dispatch')

    const closedPhase = await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
      taskId: 'goal-release', phaseId: 'p2' }).then(() => null, error => error)
    assert.match(String(closedPhase), /目标阶段不存在或已结束/)
  } finally {
    await server.close()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a crash after registration is recovered once with the original stable request id', async () => {
  const { base, store } = await fixture('sources-recover-register')
  let failOnce = true
  const first = routerStub()
  const ingress = ingressFor({ store, router: first, config: githubConfig, faults: {
    afterRegister: () => { if (failOnce) { failOnce = false; throw new Error('injected crash after registration') } },
  } })
  const server = await serve(ingress)
  try {
    await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace', taskId: 'goal-release' })
    const body = JSON.stringify(issuePayload())
    const response = await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('crash-1', body), body,
    })
    assert.equal(response.status, 500)
    assert.equal((await ingress.snapshot()).counts.registered, 1)
    assert.equal(first.calls.length, 0)
  } finally {
    await server.close()
  }

  const second = routerStub()
  const restarted = ingressFor({ store, router: second, config: githubConfig })
  const recovered = await restarted.recover()
  assert.deepEqual(recovered.map(item => item.status), ['dispatched'])
  assert.equal(second.calls.length, 1)
  assert.equal(second.calls[0].id, requestIdFor('github:gh:crash-1'))
  await fsp.rm(base, { recursive: true, force: true })
})

test('a crash after the router accepted the event retries the same id and the router dedupes', async () => {
  const { base, store } = await fixture('sources-recover-submit')
  let failOnce = true
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: githubConfig, faults: {
    afterSubmit: () => { if (failOnce) { failOnce = false; throw new Error('injected crash after submit') } },
  } })
  const server = await serve(ingress)
  try {
    await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace', taskId: 'goal-release' })
    const body = JSON.stringify(issuePayload())
    await fetch(`${server.url}/hooks/github`, { method: 'POST', headers: githubHeaders('crash-2', body), body })
    await ingress.flush()
    assert.equal(router.calls.length, 1)
    assert.equal((await ingress.snapshot()).counts.dispatching, 1)
  } finally {
    await server.close()
  }

  const restarted = ingressFor({ store, router, config: githubConfig })
  const recovered = await restarted.recover()
  assert.deepEqual(recovered.map(item => item.status), ['dispatched'])
  assert.equal(router.calls.length, 2, 'the retry reaches the router')
  assert.equal(router.seen.size, 1, 'but only one logical request exists')
  assert.equal(router.calls[1].id, router.calls[0].id)
  await fsp.rm(base, { recursive: true, force: true })
})

test('two repositories and two tenants with the same number never share a binding', async () => {
  const { base, store } = await fixture('sources-identity')
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: { ...githubConfig, ...feishuConfig } })
  const server = await serve(ingress)
  try {
    await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace', taskId: 'goal-release' })
    await ingress.bind({ source: 'feishu', objectId: 'feishu:tenant-a:message:om_1', project: 'workspace',
      taskId: 'goal-release' })

    const sameNumber = JSON.stringify(issuePayload({ repoId: 202, number: 7, title: '另一仓库的 7 号' }))
    await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('other-repo-1', sameNumber), body: sameNumber,
    })
    const otherTenant = JSON.stringify(feishuPayload({ tenant: 'tenant-b', text: '另一租户的消息', eventId: 'evt-b' }))
    await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(otherTenant), body: otherTenant,
    })
    await ingress.flush()
    assert.equal(router.calls.length, 0, 'same id in a different repository or tenant needs its own binding')

    const snapshot = await ingress.snapshot()
    assert.equal(snapshot.counts.unbound, 2)

    const ownTenant = JSON.stringify(feishuPayload({ text: '本租户的补充', eventId: 'evt-a' }))
    await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(ownTenant), body: ownTenant,
    })
    await ingress.flush()
    assert.equal(router.calls.length, 1)
    assert.match(router.calls[0].text, /本租户的补充/)
  } finally {
    await server.close()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('Feishu verifies the signature, answers the handshake, decrypts events and dedupes a replay', async () => {
  const { base, store } = await fixture('sources-feishu')
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: feishuConfig })
  const server = await serve(ingress)
  try {
    await ingress.bind({ source: 'feishu', objectId: 'feishu:tenant-a:message:om_1', project: 'workspace',
      taskId: 'goal-release', phaseId: 'p1' })

    const challengeBody = JSON.stringify({ type: 'url_verification', challenge: 'ch-1', token: FEISHU_TOKEN })
    const challenge = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(challengeBody), body: challengeBody,
    })
    assert.equal(challenge.status, 200)
    assert.deepEqual(await challenge.json(), { challenge: 'ch-1' })

    const encrypted = encryptFeishu(feishuPayload())
    const bad = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(encrypted, { key: 'wrong' }), body: encrypted,
    })
    assert.equal(bad.status, 401)

    const accepted = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(encrypted), body: encrypted,
    })
    assert.equal(accepted.status, 200)
    await ingress.flush()
    assert.equal(router.calls.length, 1)
    assert.equal(router.calls[0].phaseId, 'p1')
    assert.match(router.calls[0].text, /把这个也带上/)

    const replay = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(encrypted), body: encrypted,
    })
    assert.equal((await replay.json()).duplicate, true)
    await ingress.flush()
    assert.equal(router.calls.length, 1)
  } finally {
    await server.close()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the same delivery id from another source instance is a different event', async () => {
  const { base, store } = await fixture('sources-instances')
  const router = routerStub()
  const first = ingressFor({ store, router, config: githubConfig })
  await first.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace', taskId: 'goal-release' })
  const firstServer = await serve(first)
  const body = JSON.stringify(issuePayload())
  await fetch(`${firstServer.url}/hooks/github`, { method: 'POST', headers: githubHeaders('shared-1', body), body })
  await first.flush()
  await firstServer.close()

  const second = ingressFor({ store, router, config: {
    github: { enabled: true, instanceId: 'gh-backup', secret: GITHUB_SECRET },
  } })
  const secondServer = await serve(second)
  await fetch(`${secondServer.url}/hooks/github`, { method: 'POST', headers: githubHeaders('shared-1', body), body })
  await second.flush()
  await secondServer.close()

  const snapshot = await second.snapshot()
  assert.equal(snapshot.counts.dispatched, 1)
  assert.equal(snapshot.counts.unbound, 1, 'the second instance has its own record and no binding')
  assert.equal(router.seen.size, 1)
  await fsp.rm(base, { recursive: true, force: true })
})

test('Feishu replies resolve to the bound root message and each reply is queued once', async () => {
  const { base, store } = await fixture('sources-feishu-thread')
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: feishuConfig })
  const server = await serve(ingress)
  try {
    const root = encryptFeishu(feishuPayload({ messageId: 'om_root', eventId: 'evt-root', text: '根消息' }))
    let response = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(root), body: root,
    })
    assert.equal(response.status, 200)
    await ingress.flush()
    const rootRecord = (await ingress.snapshot()).recent.find(item => item.deliveryId === 'evt-root')
    assert.equal(rootRecord.objectId, 'feishu:tenant-a:message:om_root')
    assert.equal(rootRecord.status, 'unbound')

    const binding = await ingress.bind({
      source: 'feishu', objectId: rootRecord.objectId, project: 'workspace',
      taskId: 'goal-release', phaseId: 'p1',
    })

    const first = encryptFeishu(feishuPayload({
      messageId: 'om_reply_1', rootId: 'om_root', eventId: 'evt-r1', text: '第一条回复',
    }))
    response = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(first), body: first,
    })
    assert.equal(response.status, 200)
    await ingress.flush()

    const second = encryptFeishu(feishuPayload({
      messageId: 'om_reply_2', rootId: 'om_root', eventId: 'evt-r2', text: '第二条回复',
    }))
    response = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(second), body: second,
    })
    assert.equal(response.status, 200)
    await ingress.flush()

    assert.equal(router.calls.length, 2, '两条回复各入队一次')
    for (const [index, marker] of [[0, '第一条回复'], [1, '第二条回复']]) {
      assert.equal(router.calls[index].target, 'goal-release')
      assert.equal(router.calls[index].phaseId, 'p1')
      assert.equal(router.calls[index].source.objectId, rootRecord.objectId)
      assert.match(router.calls[index].text, new RegExp(marker))
    }
    const records = (await ingress.snapshot()).recent
    assert.equal(records.find(item => item.deliveryId === 'evt-r1').data.subject.messageId, 'om_reply_1')

    const replay = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(first), body: first,
    })
    assert.equal((await replay.json()).duplicate, true)
    await ingress.flush()
    assert.equal(router.calls.length, 2, '同一回复重投不得二次提交')

    const otherRoot = encryptFeishu(feishuPayload({ messageId: 'om_other', eventId: 'evt-other', text: '其他根消息' }))
    await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(otherRoot), body: otherRoot,
    })
    await ingress.flush()

    const otherTenant = encryptFeishu(feishuPayload({
      tenant: 'tenant-b', messageId: 'om_reply_b', rootId: 'om_root', eventId: 'evt-rb', text: '另一租户',
    }))
    await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(otherTenant), body: otherTenant,
    })
    await ingress.flush()
    assert.equal(router.calls.length, 2, '其他根消息与其他租户不得命中绑定')

    await ingress.unbind(binding.id)
    const revoked = encryptFeishu(feishuPayload({
      messageId: 'om_reply_3', rootId: 'om_root', eventId: 'evt-r3', text: '撤销后到达',
    }))
    await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(revoked), body: revoked,
    })
    await ingress.flush()
    assert.equal(router.calls.length, 2, '撤销后的回复不得派工')
    const revokedRecord = (await ingress.snapshot()).recent.find(item => item.deliveryId === 'evt-r3')
    assert.ok(['revoked', 'unbound'].includes(revokedRecord.status), '撤销后的回复只留在来源记录')
  } finally {
    await server.close()
    ingress.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('token-only Feishu mode accepts v2 header tokens and rejects misplaced credentials', async () => {
  const { base, store } = await fixture('sources-feishu-token')
  const router = routerStub()
  const logs = []
  const ingress = ingressFor({
    store, router,
    config: { feishu: { enabled: true, instanceId: 'fs', verificationToken: FEISHU_TOKEN } },
    log: message => logs.push(String(message)),
  })
  const server = await serve(ingress)
  try {
    await ingress.bind({
      source: 'feishu', objectId: 'feishu:tenant-a:message:om_1', project: 'workspace',
      taskId: 'goal-release', phaseId: 'p1',
    })
    const unsigned = { 'content-type': 'application/json' }
    const valid = JSON.stringify(feishuPayload({ eventId: 'token-v2-1' }))
    let response = await fetch(`${server.url}/hooks/feishu`, { method: 'POST', headers: unsigned, body: valid })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).duplicate, false)
    await ingress.flush()
    assert.equal(router.calls.length, 1)
    assert.equal(router.calls[0].phaseId, 'p1')
    const countsAfterValid = (await ingress.snapshot()).counts

    const wrong = JSON.stringify(feishuPayload({ eventId: 'token-v2-2', token: 'wrong-token' }))
    response = await fetch(`${server.url}/hooks/feishu`, { method: 'POST', headers: unsigned, body: wrong })
    assert.equal(response.status, 401)

    const missing = JSON.stringify(feishuPayload({ eventId: 'token-v2-3', token: null }))
    response = await fetch(`${server.url}/hooks/feishu`, { method: 'POST', headers: unsigned, body: missing })
    assert.equal(response.status, 401)

    const misplaced = feishuPayload({ eventId: 'token-v2-4', token: null })
    misplaced.token = FEISHU_TOKEN
    response = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: unsigned, body: JSON.stringify(misplaced),
    })
    assert.equal(response.status, 401, 'v2 事件只认 header.token')

    await ingress.flush()
    assert.equal(router.calls.length, 1)
    assert.deepEqual((await ingress.snapshot()).counts, countsAfterValid, '凭据不合法的事件不得登记')

    const challengeBody = JSON.stringify({ type: 'url_verification', challenge: 'ch-token', token: FEISHU_TOKEN })
    response = await fetch(`${server.url}/hooks/feishu`, { method: 'POST', headers: unsigned, body: challengeBody })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { challenge: 'ch-token' })

    const badChallenge = JSON.stringify({ type: 'url_verification', challenge: 'ch-bad', token: 'wrong-token' })
    response = await fetch(`${server.url}/hooks/feishu`, { method: 'POST', headers: unsigned, body: badChallenge })
    assert.equal(response.status, 401)

    const misplacedChallenge = JSON.stringify({
      type: 'url_verification', challenge: 'ch-h', header: { token: FEISHU_TOKEN },
    })
    response = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: unsigned, body: misplacedChallenge,
    })
    assert.equal(response.status, 401, '握手只认请求体顶层的 token')

    // Encrypted mode still enforces the signed freshness window.
    const stale = ingressFor({
      store, router, config: feishuConfig, log: () => {},
      now: () => Date.now() + 10 * 60 * 1000,
    })
    const staleServer = await serve(stale)
    const sealed = encryptFeishu(feishuPayload({ eventId: 'stale-1' }))
    const expired = await fetch(`${staleServer.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(sealed), body: sealed,
    })
    assert.equal(expired.status, 401)
    await staleServer.close()

    const exposed = JSON.stringify(await ingress.snapshot()) + JSON.stringify(logs)
    assert.equal(exposed.includes(FEISHU_TOKEN), false, '来源记录与日志不得含 token')
    assert.equal(exposed.includes('wrong-token'), false)
  } finally {
    await server.close()
    ingress.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a temporary Router rejection keeps the delivery and resumes with the same request id', async () => {
  {
    const { base, store } = await fixture('sources-retry-inline')
    const real = realRouter(path.join(base, 'router'))
    let attempts = 0
    const router = {
      async submit(input) {
        attempts += 1
        if (attempts === 1) {
          const error = new Error('待处理消息过多，请稍后再发')
          error.code = 'queue-full'
          throw error
        }
        return real.submit(input)
      },
    }
    const ingress = ingressFor({ store, router, config: githubConfig, retry: { baseMs: 10, maxAttempts: 4 } })
    const server = await serve(ingress)
    try {
      await ingress.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      const body = JSON.stringify(issuePayload())
      const response = await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('retry-inline', body), body,
      })
      assert.equal(response.status, 202)
      await waitFor(async () => (await ingress.snapshot()).recent[0]?.status === 'dispatched')
      assert.equal(attempts, 2, '上游只投递一次，队列释放后自动重试一次')
      const recent = (await ingress.snapshot()).recent[0]
      assert.equal(recent.attempts, 2)
      assert.equal(recent.deliveredTo, 'router-queue')
      assert.equal(recent.route.phaseId, 'p1')
      const commands = await routerCommands(path.join(base, 'router'))
      assert.equal(commands.length, 1, '原任务只追加一次')
      assert.equal(commands[0].id, requestIdFor('github:gh:retry-inline'))
      assert.equal(commands[0].phaseId, 'p1')
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  {
    const { base, store } = await fixture('sources-retry-restart')
    const real = realRouter(path.join(base, 'router'))
    let calls = 0
    const reject = {
      async submit() {
        calls += 1
        const error = new Error('待处理消息过多，请稍后再发')
        error.code = 'queue-full'
        throw error
      },
    }
    const first = ingressFor({ store, router: reject, config: githubConfig, retry: { baseMs: 60_000, maxAttempts: 4 } })
    const server = await serve(first)
    let requestId
    try {
      await first.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      const body = JSON.stringify(issuePayload())
      const response = await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('retry-restart', body), body,
      })
      assert.equal(response.status, 202)
      await first.flush()
      const waiting = (await first.snapshot()).recent[0]
      assert.equal(waiting.status, 'retrying')
      requestId = waiting.requestId
      assert.equal(requestId, requestIdFor('github:gh:retry-restart'))
    } finally {
      await server.close()
      first.stop()
    }

    const restarted = ingressFor({
      store, config: githubConfig,
      // The restart happens after the persisted backoff deadline.
      now: () => Date.now() + 60_000,
      router: { async submit(input) { calls += 1; return real.submit(input) } },
    })
    const recovered = await restarted.recover()
    assert.deepEqual(recovered.map(item => item.status), ['dispatched'])
    const done = (await restarted.snapshot()).recent[0]
    assert.equal(done.requestId, requestId, '重启后复用同一 requestId')
    assert.equal(calls, 2)
    const commands = await routerCommands(path.join(base, 'router'))
    assert.equal(commands.length, 1, '重启恢复后原任务只追加一次')
    assert.equal(commands[0].id, requestId)
    restarted.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('temporary failures re-check authorization and stop at a bounded retry budget', async () => {
  {
    const { base, store } = await fixture('sources-retry-revoked')
    let calls = 0
    const rejecting = {
      async submit() {
        calls += 1
        const error = new Error('待处理消息过多，请稍后再发')
        error.code = 'queue-full'
        throw error
      },
    }
    let clock = Date.now()
    const ingress = ingressFor({
      store, router: rejecting, config: githubConfig,
      retry: { baseMs: 60_000, maxAttempts: 4 }, now: () => clock,
    })
    const server = await serve(ingress)
    try {
      const binding = await ingress.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      const body = JSON.stringify(issuePayload())
      await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('retry-revoked', body), body,
      })
      await ingress.flush()
      assert.equal((await ingress.snapshot()).recent[0].status, 'retrying')
      await ingress.unbind(binding.id)
      clock += 60_000
      const recovered = await ingress.recover()
      assert.ok(['revoked', 'unbound'].includes(recovered[0].status), '撤销后的绑定不再授权')
      assert.equal(calls, 1, '暂时失败期间撤销绑定后不得派送')
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  {
    const { base, store } = await fixture('sources-retry-budget')
    let calls = 0
    const rejecting = {
      async submit() {
        calls += 1
        const error = new Error('待处理消息过多，请稍后再发')
        error.code = 'queue-full'
        throw error
      },
    }
    const ingress = ingressFor({ store, router: rejecting, config: githubConfig, retry: { baseMs: 5, maxAttempts: 2 } })
    const server = await serve(ingress)
    try {
      await ingress.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      const body = JSON.stringify(issuePayload())
      await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('retry-budget', body), body,
      })
      await waitFor(async () => (await ingress.snapshot()).recent[0]?.status === 'failed')
      const failed = (await ingress.snapshot()).recent[0]
      assert.equal(failed.attempts, 2)
      assert.match(failed.reason, /重试预算耗尽/)
      assert.equal(calls, 2)
      assert.deepEqual(await ingress.recover(), [], '终态失败不再进入恢复扫描')
      assert.equal(calls, 2)
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }
})

test('an unreadable source state is reported and the original file is preserved', async () => {
  const { base, store } = await fixture('sources-state')
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: githubConfig })
  const server = await serve(ingress)
  try {
    const binding = await ingress.bind({
      source: 'github', objectId: 'github:101:issue:7', project: 'workspace', taskId: 'goal-release',
    })
    const valid = await fsp.readFile(store.file, 'utf8')
    assert.match(valid, new RegExp(binding.id))

    const corrupt = '{"version":1,"bindings":[{"id":"broken"}],"events":'
    await fsp.writeFile(store.file, corrupt, 'utf8')
    let error = await store.registerEvent('github:gh:state-1', { source: 'github' }).then(() => null, value => value)
    assert.equal(error?.code, 'source-state-invalid')
    assert.equal(await fsp.readFile(store.file, 'utf8'), corrupt, '损坏文件不得被登记覆盖')
    for (const read of [
      () => store.registerInstance({ source: 'github', instanceId: 'gh' }),
      () => store.snapshot(),
      () => store.findBinding({ source: 'github', instanceId: 'gh', objectId: 'github:101:issue:7' }),
      () => store.pendingEvents(),
    ]) {
      await assert.rejects(read, reason => reason?.code === 'source-state-invalid')
    }

    const body = JSON.stringify(issuePayload())
    const rejected = await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('state-1', body), body,
    })
    assert.equal(rejected.status, 503)
    const payload = await rejected.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error, 'source-state-unreadable')
    assert.equal(router.calls.length, 0)
    assert.equal(await fsp.readFile(store.file, 'utf8'), corrupt)

    const unsupported = '{"version":99,"events":{}}'
    await fsp.writeFile(store.file, unsupported, 'utf8')
    error = await store.read().then(() => null, value => value)
    assert.equal(error?.code, 'source-state-unsupported')
    assert.equal(await fsp.readFile(store.file, 'utf8'), unsupported)

    await fsp.rm(store.file, { force: true })
    await fsp.mkdir(store.file)
    error = await store.read().then(() => null, value => value)
    assert.equal(error?.code, 'source-state-unreadable')
    await fsp.rm(store.file, { recursive: true, force: true })

    await fsp.writeFile(store.file, valid, 'utf8')
    const restored = await store.listBindings()
    assert.equal(restored.length, 1, '恢复有效状态后旧绑定仍在')
    assert.equal(restored[0].id, binding.id)

    const accepted = await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('state-2', body), body,
    })
    assert.equal(accepted.status, 202)
    await ingress.flush()
    assert.equal(router.calls.length, 1)
    assert.equal((await ingress.snapshot()).counts.dispatched, 1)
  } finally {
    await server.close()
    ingress.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('binding without a task needs an explicit autoStart rule', async () => {
  const { base, store } = await fixture('sources-autostart')
  const router = routerStub()
  const ingress = ingressFor({ store, router, config: githubConfig })
  const server = await serve(ingress)
  try {
    await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace' })
    const body = JSON.stringify(issuePayload({ number: 7 }))
    await fetch(`${server.url}/hooks/github`, { method: 'POST', headers: githubHeaders('auto-1', body), body })
    await ingress.flush()
    assert.equal(router.calls.length, 0)
    assert.equal((await ingress.snapshot()).counts.held, 1)

    await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace', autoStart: true })
    const body2 = JSON.stringify(issuePayload({ number: 7, title: '自动开工的事件' }))
    await fetch(`${server.url}/hooks/github`, { method: 'POST', headers: githubHeaders('auto-2', body2), body: body2 })
    await ingress.flush()
    assert.equal(router.calls.length, 1)
    assert.equal(router.calls[0].intent, 'task')
    assert.equal(router.calls[0].target, undefined)
  } finally {
    await server.close()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a temporary catalog read stays retryable and re-checks the binding and phase', async () => {
  {
    const { base, store } = await fixture('sources-catalog-retry')
    const router = routerStub()
    let offline = false
    const ingress = ingressFor({
      store, router, config: githubConfig,
      catalog: async () => {
        if (offline) throw Object.assign(new Error('Work catalog temporarily unavailable'), { code: 'EBUSY' })
        return catalog()
      },
      retry: { baseMs: 250, maxAttempts: 3 },
    })
    const updateEvent = store.updateEvent
    let delayedRetry = false
    store.updateEvent = async (key, patch) => {
      const result = await updateEvent(key, patch)
      if (patch.status === 'retrying' && !delayedRetry) {
        delayedRetry = true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return result
    }
    const server = await serve(ingress)
    try {
      await ingress.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      offline = true
      const body = JSON.stringify(issuePayload())
      const response = await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('catalog-retry', body), body,
      })
      assert.equal(response.status, 202)
      await ingress.flush()
      const waiting = (await ingress.snapshot()).recent[0]
      assert.equal(waiting.status, 'retrying', '清单暂不可用不得转成 unauthorized')
      assert.equal(waiting.attempts, 1)
      assert.match(waiting.reason, /工作清单暂不可用/)
      assert.equal(router.calls.length, 0)

      offline = false
      await waitFor(async () => (await ingress.snapshot()).recent[0]?.status === 'dispatched')
      const done = (await ingress.snapshot()).recent[0]
      assert.equal(done.requestId, requestIdFor('github:gh:catalog-retry'))
      assert.equal(done.route.phaseId, 'p1')
      assert.equal(router.calls.length, 1)
      assert.equal(router.calls[0].id, done.requestId)
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  {
    // Restart with the persisted deadline already due.
    const { base, store } = await fixture('sources-catalog-restart')
    const router = routerStub()
    let offline = false
    let clock = Date.parse('2026-01-01T00:00:00Z')
    const ingress = ingressFor({
      store, router, config: githubConfig,
      catalog: async () => {
        if (offline) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        return catalog()
      },
      retry: { baseMs: 30_000, maxAttempts: 3 },
      now: () => clock,
    })
    await ingress.bind({
      source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
      taskId: 'goal-release', phaseId: 'p1',
    })
    offline = true
    const server = await serve(ingress)
    let requestId
    try {
      const body = JSON.stringify(issuePayload())
      await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('catalog-restart', body), body,
      })
      await ingress.flush()
      const waiting = (await ingress.snapshot()).recent[0]
      assert.equal(waiting.status, 'retrying')
      requestId = waiting.requestId
      assert.equal(Date.parse(waiting.nextAttemptAt), clock + 30_000)
    } finally {
      await server.close()
      ingress.stop()
    }

    const restarted = ingressFor({
      store, router, config: githubConfig,
      retry: { baseMs: 30_000, maxAttempts: 3 },
      now: () => clock + 30_000,
    })
    const recovered = await restarted.recover()
    assert.deepEqual(recovered.map(item => item.status), ['dispatched'])
    const done = (await restarted.snapshot()).recent[0]
    assert.equal(done.requestId, requestId, '重启后复用同一 requestId')
    assert.equal(router.calls.length, 1)
    restarted.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }

  {
    // A binding revoked while the catalog is unavailable must not dispatch.
    const { base, store } = await fixture('sources-catalog-revoked')
    let offline = false
    let clock = Date.parse('2026-03-01T00:00:00Z')
    const router = routerStub()
    const ingress = ingressFor({
      store, router, config: githubConfig,
      catalog: async () => {
        if (offline) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        return catalog()
      },
      retry: { baseMs: 30_000, maxAttempts: 3 },
      now: () => clock,
    })
    const binding = await ingress.bind({
      source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
      taskId: 'goal-release', phaseId: 'p1',
    })
    offline = true
    const server = await serve(ingress)
    try {
      const body = JSON.stringify(issuePayload())
      await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('catalog-revoked', body), body,
      })
      await ingress.flush()
      assert.equal((await ingress.snapshot()).recent[0].status, 'retrying')
      await ingress.unbind(binding.id)
      offline = false
      clock += 30_000
      const recovered = await ingress.recover()
      assert.ok(['revoked', 'unbound'].includes(recovered[0].status))
      assert.equal(router.calls.length, 0, '撤销绑定后不得派送')
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  {
    // A successful read that confirms the phase is closed stays final.
    const { base, store } = await fixture('sources-catalog-denied')
    const router = routerStub()
    let closed = false
    const ingress = ingressFor({
      store, router, config: githubConfig,
      catalog: async () => {
        const data = catalog()
        if (!closed) return data
        return {
          projects: data.projects,
          tasks: data.tasks.map(task => ({
            ...task, phases: task.phases.map(phase => ({ ...phase, status: 'completed' })),
          })),
        }
      },
      retry: { baseMs: 10, maxAttempts: 3 },
    })
    const server = await serve(ingress)
    try {
      const binding = await ingress.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      closed = true
      const body = JSON.stringify(issuePayload())
      await fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('catalog-denied', body), body,
      })
      await ingress.flush()
      const snapshot = await ingress.snapshot()
      const denied = snapshot.recent[0]
      assert.equal(denied.status, 'unauthorized', '成功读取后确认无权应保持终态')
      assert.equal(snapshot.instances.github.enabled, true)
      assert.match(snapshot.deliveries[binding.id][0].reason, /阶段已结束/)
      closed = false
      await ingress.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace', taskId: 'goal-release',
      })
      assert.equal((await ingress.snapshot()).deliveries[binding.id], undefined, '旧阶段的拒绝不属于新绑定')
      await new Promise(resolve => setTimeout(resolve, 40))
      await ingress.flush()
      assert.equal((await ingress.snapshot()).recent[0].status, 'unauthorized')
      assert.equal(router.calls.length, 0)
      assert.deepEqual(await ingress.recover(), [])
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }
})

test('duplicate deliveries reuse the backoff window and the terminal state', async () => {
  {
    const { base, store } = await fixture('sources-replay-clock')
    let clock = Date.parse('2026-04-01T00:00:00Z')
    let calls = 0
    const router = {
      async submit(input) {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('queue full'), { code: 'queue-full' })
        return { accepted: true, id: input.id }
      },
    }
    const ingress = ingressFor({
      store, router, config: githubConfig,
      retry: { baseMs: 30_000, maxAttempts: 3 },
      now: () => clock,
    })
    const server = await serve(ingress)
    try {
      await ingress.bind({
        source: 'github', objectId: 'github:101:issue:7', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      const body = JSON.stringify(issuePayload())
      const post = () => fetch(`${server.url}/hooks/github`, {
        method: 'POST', headers: githubHeaders('replay-clock', body), body,
      })
      assert.equal((await post()).status, 202)
      await ingress.flush()
      const first = (await ingress.snapshot()).recent[0]
      assert.equal(first.status, 'retrying')
      assert.equal(first.attempts, 1)
      const deadline = first.nextAttemptAt
      assert.equal(Date.parse(deadline), clock + 30_000)

      await post()
      await ingress.flush()
      await post()
      await ingress.flush()
      const early = (await ingress.snapshot()).recent[0]
      assert.equal(early.status, 'retrying')
      assert.equal(early.attempts, 1, '退避窗口内的重投不得消耗尝试')
      assert.equal(early.nextAttemptAt, deadline, '退避窗口内的重投不得移动重试时间')
      assert.equal(calls, 1)

      clock += 29_999
      const notDue = await ingress.recover()
      assert.equal(notDue[0].status, 'retrying')
      assert.equal(calls, 1)
      assert.equal((await ingress.snapshot()).recent[0].nextAttemptAt, deadline)

      clock += 1
      const due = await ingress.recover()
      assert.equal(due[0].status, 'dispatched')
      const done = (await ingress.snapshot()).recent[0]
      assert.equal(done.attempts, 2)
      assert.equal(done.requestId, requestIdFor('github:gh:replay-clock'))
      assert.equal(calls, 2, '到期后只执行一次应有的重试')
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }

  {
    // Feishu deliveries share the same entry point and terminal rules.
    const { base, store } = await fixture('sources-replay-feishu')
    let clock = Date.parse('2026-05-01T00:00:00Z')
    let calls = 0
    const router = {
      async submit() {
        calls += 1
        throw Object.assign(new Error('queue full'), { code: 'queue-full' })
      },
    }
    const ingress = ingressFor({
      store, router, config: feishuConfig,
      retry: { baseMs: 10_000, maxAttempts: 2 },
      now: () => clock,
    })
    const server = await serve(ingress)
    try {
      await ingress.bind({
        source: 'feishu', objectId: 'feishu:tenant-a:message:om_1', project: 'workspace',
        taskId: 'goal-release', phaseId: 'p1',
      })
      const body = encryptFeishu(feishuPayload({ eventId: 'duplicate-feishu' }))
      const post = () => fetch(`${server.url}/hooks/feishu`, {
        method: 'POST', headers: feishuHeaders(body, { timestamp: Math.floor(clock / 1000) }), body,
      })
      const first = await post()
      assert.equal(first.status, 200)
      assert.equal((await first.json()).duplicate, false)
      await ingress.flush()
      const waiting = (await ingress.snapshot()).recent[0]
      assert.equal(waiting.status, 'retrying')
      assert.equal(waiting.attempts, 1)
      const deadline = waiting.nextAttemptAt

      const replay = await post()
      assert.equal(replay.status, 200)
      assert.equal((await replay.json()).duplicate, true)
      await ingress.flush()
      const early = (await ingress.snapshot()).recent[0]
      assert.equal(early.attempts, 1)
      assert.equal(early.nextAttemptAt, deadline)
      assert.equal(calls, 1)

      clock += 10_000
      const exhausted = await ingress.recover()
      assert.equal(exhausted[0].status, 'failed')
      const failed = (await ingress.snapshot()).recent[0]
      assert.equal(failed.attempts, 2)
      assert.match(failed.reason, /重试预算耗尽/)

      const afterTerminal = await post()
      assert.equal((await afterTerminal.json()).duplicate, true)
      await ingress.flush()
      assert.equal((await ingress.snapshot()).recent[0].status, 'failed')
      assert.equal(calls, 2, '终态后的重投不得再派发')
      assert.deepEqual(await ingress.recover(), [])

      const restarted = ingressFor({
        store, router, config: feishuConfig,
        retry: { baseMs: 10_000, maxAttempts: 2 },
        now: () => clock,
      })
      assert.deepEqual(await restarted.recover(), [])
      assert.equal((await restarted.snapshot()).recent[0].status, 'failed')
      assert.equal(calls, 2, '终态在重启后保持稳定')
      restarted.stop()
    } finally {
      await server.close()
      ingress.stop()
      await fsp.rm(base, { recursive: true, force: true })
    }
  }
})
