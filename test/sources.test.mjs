import assert from 'node:assert/strict'
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

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

function ingressFor({ store, router = routerStub(), config, faults }) {
  return createSourceIngress({ store, router, config, catalog, faults })
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

function feishuPayload({ tenant = 'tenant-a', messageId = 'om_1', text = '把这个也带上', eventId = 'evt-1' } = {}) {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', tenant_key: tenant, token: FEISHU_TOKEN },
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: messageId, chat_id: 'oc_1', message_type: 'text', create_time: '1795230000000',
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
