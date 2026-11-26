import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectArtifacts } from '../lib/artifacts.js'
import { apply } from '../lib/index.js'
import { createMarketSignaturePayload, DEFAULT_REGISTRY } from '../lib/market-client.js'
import { createStore } from '../lib/store.js'

async function waitForJson(file, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

async function mount(t, { config = {}, services = {}, env = {} } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-console-platform-'))
  const state = path.join(root, 'state')
  const home = path.join(root, 'home')
  await fsp.mkdir(state)
  await fsp.mkdir(home)
  const previous = { DSH_HOME: process.env.DSH_HOME, ...Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])) }
  process.env.DSH_HOME = home
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const listeners = new Map()
  const effects = []
  const ctx = {
    tools: { register: () => {} },
    get: name => services[name],
    on(event, listener) {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
    },
    effect(factory) { effects.push(factory) },
    async dispose() {
      for (const listener of listeners.get('dispose') ?? []) await listener()
      for (const factory of effects.reverse()) await factory()
    },
  }
  apply(ctx, {
    stateDir: state, consolePort: 0, consoleRoot: root, workbenchRoot: root,
    notifyOnComplete: false, audit: true, memory: false, scheduleProvider: 'local',
    ...config,
  })
  t.after(async () => {
    let timer
    try {
      await Promise.race([
        ctx.dispose(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('host disposal timed out')), 5000) }),
      ])
    } finally {
      clearTimeout(timer)
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelayMs: 50 })
  })
  const discovery = await waitForJson(path.join(state, 'console.json'))
  return { root, state, panel: { url: discovery.url, token: discovery.token }, ctx }
}

async function request(panel, method, route, body, token = panel.token) {
  const headers = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${panel.url}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* HTML or empty response */ }
  return { status: response.status, json, text }
}

function rule(extra = {}) {
  return {
    name: 'Daily automation',
    trigger: { type: 'cron', cron: '0 9 * * *', timeZone: 'UTC' },
    action: { type: 'run', prompt: 'Summarize the project.' },
    output: { relativePath: 'artifacts/daily.md' },
    ...extra,
  }
}

test('real apply wires automation CRUD, pure preview, scheduler plans, Router run-now, revisions and audit', async t => {
  const { state, panel } = await mount(t)
  const created = await request(panel, 'POST', '/api/console/automations', { action: 'create', rule: rule() })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const id = created.json.data.id
  assert.equal(created.json.data.enabled, false)
  assert.equal(created.json.data.revision, 1)
  assert.equal(created.json.data.scheduleId, null)
  assert.ok((await request(panel, 'GET', '/api/console/automations')).json.data.some(item => item.id === id))
  assert.equal((await request(panel, 'GET', `/api/console/automations/${id}`)).json.data.name, 'Daily automation')

  const beforePreview = await fsp.readFile(path.join(state, 'automations.json'), 'utf8')
  const preview = await request(panel, 'POST', '/api/console/automations', {
    action: 'preview', rule: rule({ output: { relativePath: '../escape.md' } }),
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.data.valid, false)
  assert.equal(preview.json.data.sideEffects, 'none')
  assert.equal(preview.json.data.executionStarted, false)
  assert.equal(await fsp.readFile(path.join(state, 'automations.json'), 'utf8'), beforePreview)

  const enabled = await request(panel, 'POST', '/api/console/automations', {
    action: 'toggle', id, enabled: true, expectedRevision: 1,
  })
  assert.equal(enabled.status, 200)
  assert.ok(enabled.json.data.scheduleId)
  const schedules = JSON.parse(await fsp.readFile(path.join(state, 'schedules.json'), 'utf8'))
  const plan = schedules.plans.find(item => item.id === enabled.json.data.scheduleId)
  assert.equal(plan.enabled, true)
  assert.equal(plan.schedule.cron, '0 9 * * *')

  assert.equal((await request(panel, 'POST', '/api/console/automations', {
    action: 'update', id, expectedRevision: 1, patch: { name: 'Stale' },
  })).status, 409)
  const updated = await request(panel, 'POST', '/api/console/automations', {
    action: 'update', id, expectedRevision: 2, patch: { name: 'Renamed automation' },
  })
  assert.equal(updated.json.data.revision, 3)

  const run = await request(panel, 'POST', '/api/console/automations', {
    action: 'run-now', id, idempotencyKey: 'manual-run-1',
  })
  assert.equal(run.status, 200, JSON.stringify(run.json))
  assert.equal(run.json.data.status, 'queued')
  const replay = await request(panel, 'POST', '/api/console/automations', {
    action: 'run-now', id, idempotencyKey: 'manual-run-1',
  })
  assert.equal(replay.json.data.id, run.json.data.id)
  assert.equal(replay.json.data.replayed, true)
  const router = JSON.parse(await fsp.readFile(path.join(state, 'router.json'), 'utf8'))
  assert.equal(router.commands.filter(command => command.id === run.json.data.result.requestId).length, 1)
  assert.ok((await request(panel, 'GET', `/api/console/automations/${id}/executions`)).json.data.some(item => item.id === run.json.data.id))
  let terminalExecution = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    terminalExecution = (await request(panel, 'GET', `/api/console/automations/${id}/executions`)).json.data
      .find(item => item.id === run.json.data.id)
    if (!['queued', 'running'].includes(terminalExecution.status)) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(terminalExecution, JSON.stringify(await request(panel, 'GET', `/api/console/automations/${id}/executions`)))
  assert.equal(terminalExecution.status, 'failed')
  assert.deepEqual(terminalExecution.result.output, { relativePath: 'artifacts/daily.md' })
  assert.ok(terminalExecution.finishedAt)

  const disabled = await request(panel, 'POST', '/api/console/automations', {
    action: 'toggle', id, enabled: false, expectedRevision: 3,
  })
  assert.equal(disabled.json.data.enabled, false)
  const paused = JSON.parse(await fsp.readFile(path.join(state, 'schedules.json'), 'utf8'))
  assert.equal(paused.plans.find(item => item.id === disabled.json.data.scheduleId).enabled, false)

  const crud = await request(panel, 'POST', '/api/console/automations', { action: 'create', rule: rule({ name: 'Remove me' }) })
  const removed = await request(panel, 'POST', '/api/console/automations', {
    action: 'remove', id: crud.json.data.id, expectedRevision: 1,
  })
  assert.equal(removed.status, 200)
  assert.equal((await request(panel, 'GET', `/api/console/automations/${crud.json.data.id}`)).json.data, null)

  const audit = await fsp.readFile(path.join(state, 'audit', 'audit.jsonl'), 'utf8')
  for (const action of ['automations.create', 'automations.toggle', 'automations.update', 'automations.run-now', 'automations.remove']) {
    assert.match(audit, new RegExp(action))
  }
  assert.equal(audit.includes('manual-run-1'), false)
})

test('share tokens are independent and read-only, market install is 501, and local imports never execute', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const item = {
    kind: 'skill', name: 'review-skill', displayName: 'Review Skill', description: 'Review only.',
    version: '1.2.3', engines: { node: '>=24.9.0 <25', dsh: '>=0.2.2-rc.1 <0.3.0-0' },
    commit: 'a'.repeat(40), sha256: 'b'.repeat(64), registry: DEFAULT_REGISTRY,
  }
  item.signature = { algorithm: 'ed25519', keyId: 'test-market',
    value: sign(null, createMarketSignaturePayload(item), privateKey).toString('base64') }
  const calls = []
  const providers = []
  const skills = {
    registerProvider(create) {
      const provider = create({ signal: new AbortController().signal, invalidate() {} })
      providers.push(provider)
      return () => { const index = providers.indexOf(provider); if (index >= 0) providers.splice(index, 1) }
    },
    async snapshot() {
      const items = []
      for (const provider of providers) items.push(...await provider.list({}))
      return { skills: items, complete: true }
    },
    async get(name) {
      for (const provider of providers) {
        const candidate = (await provider.list({})).find(item => item.name === name)
        if (candidate) return provider.get(candidate, {})
      }
      return undefined
    },
  }
  const { root, state, panel } = await mount(t, { services: { skills }, config: { market: {
    trustedPublicKeys: { 'test-market': publicKeyPem }, dshVersion: '0.2.2',
    fetchImpl: async url => {
      calls.push(String(url))
      return new Response(JSON.stringify({ items: [item] }), { status: 200,
        headers: { 'content-type': 'application/json' } })
    },
  } } })

  const created = await request(panel, 'POST', '/api/console/shares', {
    action: 'create', share: { artifactIds: ['artifact-a'], role: 'commenter' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const token = created.json.data.token
  assert.match(token, /^shr_/)
  const publicRead = await request(panel, 'GET', `/api/share/${token}`, undefined, null)
  assert.equal(publicRead.status, 200)
  assert.deepEqual(publicRead.json.data.artifactIds, ['artifact-a'])
  assert.deepEqual(publicRead.json.data.capabilities, ['share.read', 'share.comment'])
  assert.equal(publicRead.json.data.token, undefined)
  assert.equal((await request(panel, 'GET', `/api/share/${token}?artifactId=artifact-secret`, undefined, null)).status, 403)
  assert.equal((await request(panel, 'POST', `/api/share/${token}`, {}, null)).status, 405)

  const comment = await request(panel, 'POST', '/api/console/shares', {
    action: 'comment', token, comment: { artifactId: 'artifact-a', text: 'Looks good.', idempotencyKey: 'comment-1' },
  })
  assert.equal(comment.status, 200)
  assert.equal(comment.json.data.replayed, false)
  assert.equal((await request(panel, 'POST', '/api/console/shares', {
    action: 'comment', token, comment: { artifactId: 'artifact-a', text: 'Looks good.', idempotencyKey: 'comment-1' },
  })).json.data.replayed, true)
  const rawShares = await fsp.readFile(path.join(state, 'shares', 'shares.json'), 'utf8')
  assert.equal(rawShares.includes(token), false)

  const search = await request(panel, 'GET', '/api/console/market?query=review')
  assert.equal(search.status, 200, JSON.stringify(search.json))
  assert.equal(search.json.data.items[0].signature.verified, true)
  const detail = await request(panel, 'POST', '/api/console/market', {
    action: 'detail', name: 'review-skill', kind: 'skill', version: '1.2.3',
  })
  assert.equal(detail.status, 200)
  const handoff = await request(panel, 'POST', '/api/console/market', {
    action: 'install-handoff', item: detail.json.data, enabled: true,
  })
  assert.equal(handoff.status, 501, JSON.stringify(handoff.json))
  assert.equal(handoff.json.error.id, 'MARKET_INSTALL_NOT_IMPLEMENTED')
  assert.equal(handoff.json.data.executed, false)
  assert.equal(handoff.json.data.installed, false)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(url => url.startsWith('https://registry.npmjs.org/')))

  const source = path.join(root, 'local-skill')
  await fsp.mkdir(source)
  await fsp.writeFile(path.join(source, 'SKILL.md'), '---\nname: local-review\ndescription: Review locally.\n---\n# Review\n')
  const imported = await request(panel, 'POST', '/api/console/market', {
    action: 'import', sourceDirectory: source, enabled: false,
  })
  assert.equal(imported.status, 200, JSON.stringify(imported.json))
  assert.equal(imported.json.data.enabled, false)
  assert.equal(imported.json.data.execution, 'never-automatic')
  assert.equal(imported.json.data.hostRegistration, 'registered')
  assert.equal(await fsp.access(path.join(state, 'skills', 'local-review', 'skill.json')).then(() => true, () => false), true)
  const beforeEnable = await request(panel, 'GET', '/api/console/capabilities')
  assert.equal(beforeEnable.json.data.skills.items.find(item => item.name === 'local-review').enabled, false)
  const enabledSkill = await request(panel, 'POST', '/api/console/capabilities', {
    action: 'setSkillEnabled', name: 'local-review', enabled: true,
  })
  assert.equal(enabledSkill.status, 200, JSON.stringify(enabledSkill.json))
  const loadedSkill = await request(panel, 'POST', '/api/console/capabilities', {
    action: 'loadSkill', name: 'local-review', cwd: root,
  })
  assert.equal(loadedSkill.status, 200, JSON.stringify(loadedSkill.json))
  assert.match(loadedSkill.json.data.content, /# Review/)
  assert.equal(loadedSkill.json.data.invocation.modelInvocable, true)

  const revoked = await request(panel, 'POST', '/api/console/shares', { action: 'remove', id: created.json.data.share.id })
  assert.equal(revoked.status, 200)
  assert.equal((await request(panel, 'GET', `/api/share/${token}`, undefined, null)).status, 403)
  const audit = await fsp.readFile(path.join(state, 'audit', 'audit.jsonl'), 'utf8')
  assert.match(audit, /shares\.create/)
  assert.match(audit, /shares\.comment/)
  assert.match(audit, /market\.install-handoff/)
  assert.match(audit, /market\.import/)
  assert.equal(audit.includes(token), false)
})

test('real apply shares serve durable artifact bytes and enforce filesystem and stable-ID boundaries', async t => {
  const { root, state, panel } = await mount(t)
  const workspace = path.join(root, 'workspace')
  const reports = path.join(state, 'reports')
  const outside = path.join(root, 'outside')
  await Promise.all([workspace, reports, outside].map(dir => fsp.mkdir(dir, { recursive: true })))

  const runId = 'share-run-1'
  const reportFile = path.join(reports, `${runId}.md`)
  const htmlFile = path.join(workspace, 'release.html')
  const outsideFile = path.join(outside, 'secret.txt')
  const escapeDir = path.join(workspace, 'escape')
  const escapedFile = path.join(escapeDir, 'secret.txt')
  const missingFile = path.join(workspace, 'missing.md')
  const reportBytes = Buffer.from('# Durable report\r\n\r\nExact UTF-8: 发布 ✓\r\n', 'utf8')
  const htmlBytes = Buffer.from('<!doctype html>\r\n<html lang="zh"><body><h1>发布 ✓</h1></body></html>\r\n', 'utf8')
  const secretBytes = Buffer.from('outside-workspace-secret\n', 'utf8')
  await Promise.all([
    fsp.writeFile(reportFile, reportBytes),
    fsp.writeFile(htmlFile, htmlBytes),
    fsp.writeFile(outsideFile, secretBytes),
  ])
  await fsp.symlink(outside, escapeDir, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await fsp.realpath(escapedFile), await fsp.realpath(outsideFile))

  const at = new Date().toISOString()
  const declared = (name, kind, file, bytes) => ({ name, kind, path: file, bytes: bytes.length, at })
  const run = {
    id: runId, goal: 'Publish durable artifacts', status: 'completed', createdAt: at, finishedAt: at,
    parentSessionId: 'owner-1', workspace: { base: workspace }, report: '# Durable report\r\n',
    artifacts: [
      declared('durable-report.md', 'report', reportFile, reportBytes),
      declared('release.html', 'html', htmlFile, htmlBytes),
      declared('outside.txt', 'text', outsideFile, secretBytes),
      declared('escaped.txt', 'text', escapedFile, secretBytes),
      declared('missing.md', 'report', missingFile, Buffer.alloc(0)),
    ],
  }
  const store = createStore(state)
  await store.init()
  await store.write(run)
  assert.equal((await store.read(runId)).id, runId)

  const descriptors = collectArtifacts([run], {})
  const idFor = file => {
    const descriptor = descriptors.find(item => item.path === file)
    assert.ok(descriptor, `missing stable artifact descriptor for ${file}`)
    return descriptor.id
  }
  const reportId = idFor(reportFile)
  const htmlId = idFor(htmlFile)
  const outsideId = idFor(outsideFile)
  const escapedId = idFor(escapedFile)
  const missingId = idFor(missingFile)
  const runPrefix = `art_${Buffer.from(runId, 'utf8').toString('base64url')}.`
  const wrongId = `${runPrefix}${'A'.repeat(43)}`
  const artifactIds = [reportId, htmlId, outsideId, escapedId, missingId, wrongId]
  assert.ok(artifactIds.every(id => id.startsWith(runPrefix)))

  const created = await request(panel, 'POST', '/api/console/shares', {
    action: 'create', share: { artifactIds, role: 'viewer' },
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const token = created.json.data.token
  const publicRead = await request(panel, 'GET', `/api/share/${token}`, undefined, { token: null })
  assert.equal(publicRead.status, 200, JSON.stringify(publicRead.json))
  assert.deepEqual(publicRead.json.data.artifactIds, artifactIds)
  assert.deepEqual(publicRead.json.data.capabilities, ['share.read'])
  assert.equal(publicRead.json.data.token, undefined)

  const publicArtifact = async artifactId => {
    const response = await fetch(`${panel.url}/api/share/${encodeURIComponent(token)}/artifact/${encodeURIComponent(artifactId)}`)
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) }
  }
  const assertFile = (response, bytes, type, csp) => {
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, bytes)
    assert.equal(response.headers.get('content-type'), type)
    assert.equal(response.headers.get('content-length'), String(bytes.length))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('content-security-policy'), csp)
  }

  await t.test('declared report is served from the state report root outside the workspace', async () => {
    assert.equal(path.dirname(reportFile), reports)
    assert.notEqual(path.relative(workspace, reportFile), '')
    assertFile(await publicArtifact(reportId), reportBytes, 'text/markdown; charset=utf-8', null)
  })

  await t.test('workspace HTML is served byte-for-byte with its exact sandbox CSP', async () => {
    const response = await publicArtifact(htmlId)
    assertFile(response, htmlBytes, 'text/html; charset=utf-8',
      "sandbox allow-scripts allow-popups allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src data: https:; connect-src https:; media-src https: data:")
    assert.equal(response.headers.get('content-disposition'), 'inline; filename="release.html"')
  })

  await t.test('declared files outside both allowed roots are rejected without leaking bytes', async () => {
    const response = await publicArtifact(outsideId)
    assert.equal(response.status, 403)
    assert.equal(response.body.includes(secretBytes), false)
  })

  await t.test('workspace symlink and junction escapes are rejected after realpath resolution', async () => {
    const response = await publicArtifact(escapedId)
    assert.equal(response.status, 403)
    assert.equal(response.body.includes(secretBytes), false)
  })

  await t.test('a declared artifact whose file disappeared returns 404', async () => {
    assert.equal((await publicArtifact(missingId)).status, 404)
  })

  await t.test('a well-formed but wrong stable artifact ID returns 404', async () => {
    assert.notEqual(wrongId, reportId)
    assert.equal((await publicArtifact(wrongId)).status, 404)
  })

  await t.test('the same workspace file has a run-scoped stable ID that another run cannot share', async () => {
    const otherRun = {
      ...run, id: 'share-run-2', parentSessionId: 'owner-2', report: '',
      artifacts: [declared('other-release.html', 'html', htmlFile, htmlBytes)],
    }
    await store.write(otherRun)
    const otherId = collectArtifacts([otherRun], {})[0].id
    assert.notEqual(otherId, htmlId)
    assert.ok(otherId.startsWith('art_c2hhcmUtcnVuLTI.'))
    const metadata = await request(panel, 'GET', `/api/share/${token}?artifactId=${encodeURIComponent(otherId)}`, undefined, { token: null })
    assert.equal(metadata.status, 403)
    assert.equal((await publicArtifact(otherId)).status, 403)
  })

  await t.test('revocation rejects both public metadata and artifact content without console auth', async () => {
    const revoked = await request(panel, 'POST', '/api/console/shares', { action: 'remove', id: created.json.data.share.id })
    assert.equal(revoked.status, 200, JSON.stringify(revoked.json))
    const metadata = await request(panel, 'GET', `/api/share/${token}`, undefined, { token: null })
    assert.equal(metadata.status, 403)
    assert.equal(metadata.json.error.id, 'share-revoked')
    const content = await publicArtifact(reportId)
    assert.equal(content.status, 403)
    assert.equal(content.body.includes(reportBytes), false)
  })
})

test('device tokens allow only their scopes and reject revoked or expired credentials', async t => {
  const { state, panel } = await mount(t)
  const paired = await request(panel, 'POST', '/api/console/device/pair', {
    name: 'Scoped phone', scopes: ['chat', 'tasks', 'inbox', 'artifacts', 'approval'], expiresInSeconds: 120,
  })
  assert.equal(paired.status, 200)
  const token = paired.json.data.token
  const devices = JSON.parse(await fsp.readFile(path.join(state, 'devices.json'), 'utf8'))
  assert.equal(JSON.stringify(devices).includes(token), false)
  assert.match(JSON.stringify(devices), /"tokenHash":"[a-f0-9]{64}"/)

  const allowed = [
    ['POST', '/api/console/message', { text: 'hello from scoped device' }, 200],
    ['GET', '/api/console/workbench', undefined, 200],
    ['GET', '/api/console/notifications', undefined, 200],
    ['GET', '/api/console/artifacts', undefined, 200],
    ['GET', '/api/console/device/status', undefined, 200],
    ['GET', '/api/console/sessions', undefined, 200],
    ['POST', '/api/console/approval', {}, 400],
  ]
  for (const [method, route, body, status] of allowed) {
    const response = await request(panel, method, route, body, token)
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(response.json)}`)
  }
  const denied = [
    '/api/console/automations', '/api/console/cloud-worker', '/api/console/shares', '/api/console/market',
    '/api/console/memory', '/api/console/capabilities', '/api/console/runtime-view', '/api/console/profiles',
    '/api/console/state', '/api/console/cost', '/api/console/sources',
  ]
  for (const route of denied) {
    const response = await request(panel, 'GET', route, undefined, token)
    assert.equal(response.status, 403, route)
    assert.equal(response.json.error.id, 'device-scope-forbidden')
  }
  assert.equal((await request(panel, 'GET', '/', undefined, token)).status, 403)

  await request(panel, 'POST', '/api/console/device/revoke', { id: paired.json.data.id })
  assert.equal((await request(panel, 'POST', '/api/console/message', { text: 'revoked' }, token)).status, 401)

  const expiring = await request(panel, 'POST', '/api/console/device/pair', {
    name: 'Expiring phone', scopes: ['chat'], expiresInSeconds: 120,
  })
  const expiredState = JSON.parse(await fsp.readFile(path.join(state, 'devices.json'), 'utf8'))
  const expired = expiredState.devices.find(device => device.id === expiring.json.data.id)
  expired.expiresAt = '2000-01-01T00:00:00.000Z'
  await fsp.writeFile(path.join(state, 'devices.json'), JSON.stringify(expiredState))
  assert.equal((await request(panel, 'POST', '/api/console/message', { text: 'expired' }, expiring.json.data.token)).status, 401)
  const audit = await fsp.readFile(path.join(state, 'audit', 'audit.jsonl'), 'utf8')
  assert.match(audit, /devices\.authorize/)
  assert.equal(audit.includes(token), false)
})

test('remote Worker console actions persist jobs and observed state', async t => {
  const calls = []
  const content = Buffer.from('# Remote result\n')
  const digest = createHash('sha256').update(content).digest('hex')
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method })
    if (init.method === 'POST' && String(url).endsWith('/v1/workers')) return new Response(JSON.stringify({
      workerId: 'worker-1', state: 'queued', leaseId: 'lease-1', fencingToken: 7,
      leaseExpiresAt: '2026-11-26T12:05:00.000Z',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (init.method === 'GET' && String(url).endsWith('/v1/workers/worker-1')) return new Response(JSON.stringify({
      workerId: 'worker-1', state: 'running', fencingToken: 7,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (init.method === 'POST' && String(url).endsWith('/v1/workers/worker-1/reattach')) return new Response(JSON.stringify({
      workerId: 'worker-1', state: 'running', leaseId: 'lease-renewed', fencingToken: 7,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z', nextCursor: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (init.method === 'POST' && String(url).endsWith('/v1/workers/worker-1/artifacts/finalize')) return new Response(JSON.stringify({
      workerId: 'worker-1', artifactId: 'artifact-remote-1', finalizedAt: new Date().toISOString(),
      manifest: { version: 1, algorithm: 'sha256', entries: [{ path: 'report.md', size: content.length,
        sha256: digest, encoding: 'base64', content: content.toString('base64') }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    throw new Error(`unexpected remote request ${init.method} ${url}`)
  }
  const { root, panel, state } = await mount(t, { config: { remoteWorker: {
    endpoint: 'https://worker.example.test', provider: 'remote', model: 'model-v1', fetchImpl,
  } } })
  await fsp.mkdir(path.join(state, 'runs'), { recursive: true })
  await fsp.writeFile(path.join(state, 'runs', 'run-1.json'), JSON.stringify({
    id: 'run-1', goal: 'Remote task', status: 'completed', createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), workspace: { base: root }, artifacts: [],
  }))
  const spec = {
    run: { id: 'run-1' }, subtask: { id: 'subtask-1' }, attempt: 1,
    repoSnapshot: { provider: 'workspace', ref: root },
    prompt: 'Implement the remote worker protocol.', model: { provider: 'remote', ref: 'model-v1' },
    toolScope: { allow: ['read_file'], deny: ['shell'] }, approvalScope: { mode: 'manual', scopes: [] },
    budget: { maxTokens: 1000, maxWallSeconds: 300 }, deadline: '2026-11-26T12:10:00.000Z',
    checkpoint: { ref: 'checkpoint-1', cursor: 0 },
  }
  const submitted = await request(panel, 'POST', '/api/console/cloud-worker', {
    action: 'submit', workSpec: spec, idempotencyKey: 'remote-submit-1',
  })
  assert.equal(submitted.status, 200)
  assert.equal(submitted.json.data.workerId, 'worker-1')
  const snapshot = await request(panel, 'POST', '/api/console/cloud-worker', { action: 'snapshot', workerId: 'worker-1' })
  assert.equal(snapshot.status, 200)
  assert.equal(snapshot.json.data.state, 'running')
  const status = await request(panel, 'GET', '/api/console/cloud-worker')
  assert.equal(status.json.data.active, 1)
  assert.equal(status.json.data.jobs[0].state, 'running')
  const persisted = JSON.parse(await fsp.readFile(path.join(state, 'remote-jobs.json'), 'utf8'))
  assert.equal(persisted.jobs[0].workerId, 'worker-1')
  assert.equal(persisted.jobs[0].state, 'running')
  assert.equal(persisted.jobs[0].fencingToken, 7)
  assert.equal(calls.length, 2)
  persisted.jobs[0].lease.expiresAt = '2000-01-01T00:00:00.000Z'
  await fsp.writeFile(path.join(state, 'remote-jobs.json'), JSON.stringify(persisted))
  const renewed = await request(panel, 'POST', '/api/console/cloud-worker', { action: 'snapshot', workerId: 'worker-1' })
  assert.equal(renewed.status, 200, JSON.stringify(renewed.json))
  assert.equal(renewed.json.data.state, 'running')
  const renewedState = JSON.parse(await fsp.readFile(path.join(state, 'remote-jobs.json'), 'utf8'))
  assert.equal(renewedState.jobs[0].lease.id, 'lease-renewed')
  assert.equal(renewedState.jobs[0].lastCursor, 0)
  assert.equal(calls.length, 4)
  const finalized = await request(panel, 'POST', '/api/console/cloud-worker', {
    action: 'finalize', workerId: 'worker-1', idempotencyKey: 'finalize-remote-1',
  })
  assert.equal(finalized.status, 200, JSON.stringify(finalized.json))
  assert.equal(finalized.json.data.registration.artifacts.length, 1)
  assert.equal(finalized.json.data.manifest.entries[0].content, undefined)
  const stored = JSON.parse(await fsp.readFile(path.join(state, 'runs', 'run-1.json'), 'utf8'))
  assert.equal(stored.artifacts.length, 1)
  assert.equal(await fsp.readFile(stored.artifacts[0].path, 'utf8'), content.toString())
  assert.equal(calls.length, 5)
})

test('missing market and remote Worker services fail explicitly instead of fabricating success', async t => {
  const { panel } = await mount(t)
  const cloud = await request(panel, 'GET', '/api/console/cloud-worker')
  assert.equal(cloud.status, 503)
  assert.equal(cloud.json.error.id, 'CLOUD_WORKER_UNAVAILABLE')
  const market = await request(panel, 'GET', '/api/console/market')
  assert.equal(market.status, 503)
  assert.equal(market.json.error.id, 'MARKET_UNAVAILABLE')
})
