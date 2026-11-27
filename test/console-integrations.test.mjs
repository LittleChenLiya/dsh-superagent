import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createConsole } from '../lib/console.js'
import { apply } from '../lib/index.js'
import { createNotifyPreferences, DEFAULT_NOTIFY_PREFERENCES } from '../lib/notify-preferences.js'
import { aggregateNotificationCenter } from '../lib/notification-center.js'
import { createAgentProfileStore } from '../lib/agent-profiles.js'
import { createPlanPreview, approvePlan, createCandidatePlanPreview } from '../lib/plan-preview.js'
import { createVoiceService, encodeWav } from '../lib/voice.js'
import { createDevicePairingStore } from '../lib/device-pairing.js'
import { createRuntimeStream } from '../lib/runtime-stream.js'

async function fixture(t, adapter = null) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-console-integrations-'))
  const state = path.join(root, 'state')
  await fsp.mkdir(state, { recursive: true })
  const fake = adapter ?? fakeHost({ preferencesFile: path.join(state, 'notification-preferences.json') })
  const host = fake.host ?? fake
  const panel = createConsole({ port: 0, stateRoot: state, host, version: 'test', log: () => {} })
  await panel.start()
  t.after(async () => {
    await panel.stop()
    await fsp.rm(root, { recursive: true, force: true })
  })
  return { root, state, panel, host: fake }
}

async function request(panel, method, route, body, { token = panel.token, headers = {} } = {}) {
  const allHeaders = { ...headers }
  if (token !== null) allHeaders.authorization = `Bearer ${token}`
  if (body !== undefined) allHeaders['content-type'] = 'application/json'
  const response = await fetch(`${panel.url}${route}`, {
    method,
    headers: allHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* static asset */ }
  return { status: response.status, json, text, headers: response.headers }
}

function rawRequest(panel, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${panel.url}${route}`, { headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* static asset */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function adapterError(status, code, message = code) {
  return Object.assign(new Error(message), { status, code })
}

function fakeHost({ preferencesFile = path.join(os.tmpdir(), `unused-preferences-${process.pid}-${Math.random()}.json`) } = {}) {
  const state = {
    allowWrites: true,
    allowReads: true,
    settingsRevision: 1,
    capabilityActions: [],
    runtimeActions: [],
    runtimeStream: createRuntimeStream({ limit: 20 }),
    memoryWrites: [],
    entries: [
      { id: 'editable', type: 'user-preference', editable: true, forgettable: true, revision: 1, body: 'concise' },
      { id: 'readonly', type: 'project-rule', editable: false, forgettable: false, revision: 1, body: 'rule' },
    ],
  }
  const today = new Date().toISOString()
  const runs = [{ id: 'run-1', goal: 'Ship the release', status: 'completed', createdAt: today,
    finishedAt: today, parentSessionId: 'session-1', attention: { items: [] } }]
  const preferences = createNotifyPreferences({ file: preferencesFile })
  const host = {
    capabilities: () => ({ chat: true, reason: null }),
    authorizeConsoleAction: action => action === 'memory.write' ? state.allowWrites
      : action === 'memory.read' ? state.allowReads : true,
    async notificationPreferences(action, patch) {
      const value = action === 'update' ? await preferences.update(patch) : await preferences.read()
      return { preferences: value, revision: createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24) }
    },
    async notificationCenter(options = {}) {
      const value = await preferences.read()
      const center = aggregateNotificationCenter({ runs, approvals: options.approvals ?? [], preferences: value,
        readIds: options.readIds ?? [] })
      return { ...center, brief: center.dailyBrief, preferences: value,
        revision: createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24) }
    },
    async capabilities(action, payload = {}) {
      if (action === undefined) return { chat: true, reason: null }
      if (action === 'snapshot') return { schemaVersion: 1, available: true, settingsRevision: state.settingsRevision,
        skills: { supported: false, items: [] }, mcp: { supported: false, servers: [] }, grants: { supported: false, items: [] } }
      state.capabilityActions.push({ action, ...payload })
      if (action === 'setEnabled') {
        if (payload.expectedSettingsRevision !== state.settingsRevision) {
          throw adapterError(409, 'SETTINGS_REVISION_CONFLICT')
        }
        state.settingsRevision++
        return { ok: true, name: payload.name, enabled: payload.enabled, settingsRevision: state.settingsRevision }
      }
      return { ok: true, name: payload.name, action }
    },
    async memory(action, payload = {}) {
      if (action === 'status') return { enabled: true, sources: {} }
      if (action === 'snapshot' || action === 'query') return { enabled: true, entries: structuredClone(state.entries) }
      const entry = state.entries.find(item => item.id === payload.id)
      if (!entry) throw adapterError(404, 'NOT_FOUND')
      if (!entry.editable) throw adapterError(403, 'READ_ONLY')
      if (action === 'update') {
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== entry.revision) {
          throw adapterError(409, 'REVISION_CONFLICT')
        }
        Object.assign(entry, payload.patch)
        entry.revision++
        state.memoryWrites.push(structuredClone(payload))
        return structuredClone(entry)
      }
      state.entries = state.entries.filter(item => item.id !== entry.id)
      state.memoryWrites.push(structuredClone(payload))
      return { id: entry.id, forgotten: true, mode: 'physical', revision: entry.revision + 1 }
    },
    async runtimeView(action, payload = {}) {
      if (action === 'snapshot') return { available: false, services: { runtime: false, browser: false, desktop: false } }
      if (action === 'currentAction') return null
      state.runtimeActions.push({ action, ...payload })
      return { ok: true, action, ...payload }
    },
    runtimeViewSubscribe: listener => state.runtimeStream.subscribe(listener),
    runtimeViewRead: options => state.runtimeStream.read(options),
    runtimeViewImage: async file => ({ body: Buffer.from(file === 'missing.png' ? 'missing' : 'png'), contentType: 'image/png' }),
    async evidence(runId) {
      return runId === 'run-1' ? { runId, cards: [{ id: 'evidence-1', status: 'passed' }], summary: { total: 1 } } : null
    },
    async cost(action, payload = {}) {
      if (action === 'summary') return { runs: 1, complete: true, totalMicros: 100 }
      if (action === 'route') return { ok: true, status: 'selected', route: 'test/model', ...payload }
      if (Object.hasOwn(payload, 'budgets')) return { ok: true, status: 'configured', budgets: payload.budgets }
      return { ok: true, status: 'ok', currency: payload.currency, ...payload }
    },
    async voice(action, payload = {}) {
      if (action === 'catalog') return { models: ['test/model'] }
      throw adapterError(503, 'unavailable', 'remote.speech is unavailable')
    },
  }
  return { host, state, runs, preferences }
}

function worker(id = 'worker-1') {
  return { id, name: 'Worker One', role: 'worker', tools: ['read_file'], permissions: ['workspace.read'],
    memoryScope: 'project', workspaceScope: 'project' }
}

function planInput(workspace) {
  return {
    goal: { id: 'goal-1', title: 'Prepare release', description: 'Produce a checked release note' },
    plan: { subtasks: [{ id: 'draft', title: 'Draft', model: 'test/model', inputTokens: 100, outputTokens: 50,
      capabilities: ['model.test/model'] }] },
    capabilities: ['model.test/model'],
    pricing: { 'test/model': { input: 2, output: 4, currency: 'CNY' } },
    workspace,
    permissionPolicy: { allowedPermissions: ['read', 'write'], allowedPaths: ['.'] },
  }
}

test('new APIs require the console token and reject a non-loopback Host first', async t => {
  const { panel } = await fixture(t)
  const routes = [
    ['GET', '/api/console/notifications/preferences'], ['GET', '/api/console/notifications'],
    ['GET', '/api/console/capabilities'], ['GET', '/api/console/memory'],
    ['GET', '/api/console/runtime-view'], ['GET', '/api/console/runs/run-1/evidence'],
    ['GET', '/api/console/cost'], ['GET', '/api/console/profiles'], ['GET', '/api/console/device/status'],
  ]
  for (const [method, route] of routes) {
    const response = await request(panel, method, route, undefined, { token: null })
    assert.equal(response.status, 401, route)
    assert.equal(response.json.ok, false)
    assert.equal(response.json.error.id, 'unauthorized')
  }
  const wrongHost = await rawRequest(panel, '/api/console/memory', {
    host: 'example.com', authorization: `Bearer ${panel.token}`,
  })
  assert.equal(wrongHost.status, 403)
  assert.equal(wrongHost.json.error.id, 'forbidden-host')
})

test('method and action validation use WorkbenchError response shapes', async t => {
  const { panel } = await fixture(t)
  const cases = [
    ['POST', '/api/console/notifications/preferences', {}, 405],
    ['POST', '/api/console/notifications', {}, 405],
    ['DELETE', '/api/console/memory', undefined, 405],
    ['POST', '/api/console/memory', { action: 'delete' }, 400],
    ['POST', '/api/console/capabilities', { action: 'setEnabled', name: 'mcp', enabled: true }, 400],
    ['POST', '/api/console/runtime-view', { action: 'capture', source: 'screen' }, 400],
    ['POST', '/api/console/cost', { action: 'budget', budgets: { CNY: -1 } }, 400],
    ['POST', '/api/console/profiles', { action: 'toggle', id: 'worker-1', enabled: 'yes' }, 400],
    ['POST', '/api/console/plan-preview', { action: 'approve', preview: {}, planDigest: '' }, 400],
    ['GET', '/api/console/voice/transcribe', undefined, 405],
    ['POST', '/api/console/voice/transcribe', {}, 400],
    ['POST', '/api/console/device/status', {}, 405],
  ]
  for (const [method, route, body, expected] of cases) {
    const response = await request(panel, method, route, body)
    assert.equal(response.status, expected, `${method} ${route}`)
    assert.equal(response.json.ok, false)
    assert.equal(typeof response.json.error.summary, 'string')
    assert.equal(typeof response.json.error.id, 'string')
  }
})

test('missing host integrations return 501 instead of fabricated success', async t => {
  const { panel } = await fixture(t, { capabilities: () => ({ chat: false, reason: 'no session service' }) })
  for (const route of ['notifications', 'capabilities', 'memory', 'runtime-view', 'runs/run-1/evidence', 'cost', 'profiles', 'device/status']) {
    const response = await request(panel, 'GET', `/api/console/${route}`)
    assert.equal(response.status, 501, route)
    assert.equal(response.json.error.id, 'integration-unavailable')
  }
})

test('notification preference updates persist and immediately change inbox aggregation and revision', async t => {
  const { panel } = await fixture(t)
  const before = await request(panel, 'GET', '/api/console/notifications')
  assert.equal(before.status, 200)
  assert.ok(before.json.data.inbox.some(item => item.event === 'completed'))
  assert.ok(before.json.data.brief)
  assert.deepEqual(before.json.data.preferences, DEFAULT_NOTIFY_PREFERENCES)

  const updated = await request(panel, 'PATCH', '/api/console/notifications/preferences', {
    events: { completed: 'off' },
    dailyBrief: { enabled: false },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.data.preferences.events.completed, 'off')
  assert.notEqual(updated.json.data.revision, before.json.data.revision)

  const after = await request(panel, 'GET', '/api/console/notifications')
  assert.equal(after.json.data.inbox.some(item => item.event === 'completed'), false)
  assert.equal(after.json.data.brief, null)
  assert.equal(after.json.data.revision, updated.json.data.revision)
})

test('memory reads and writes honour host permissions and read-only record types', async t => {
  const { panel, host } = await fixture(t)
  const state = host.state
  state.allowWrites = false
  const denied = await request(panel, 'POST', '/api/console/memory', {
    action: 'update', id: 'editable', patch: { body: 'changed' },
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.id, 'forbidden')
  assert.equal(state.memoryWrites.length, 0)

  state.allowWrites = true
  const readOnly = await request(panel, 'POST', '/api/console/memory', {
    action: 'update', id: 'readonly', patch: { body: 'changed' },
  })
  assert.equal(readOnly.status, 403)
  assert.equal(readOnly.json.error.id, 'READ_ONLY')

  const updated = await request(panel, 'POST', '/api/console/memory', {
    action: 'update', id: 'editable', expectedRevision: 1, patch: { body: 'changed' },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.data.body, 'changed')
  assert.equal(updated.json.data.revision, 2)

  state.allowReads = false
  assert.equal((await request(panel, 'GET', '/api/console/memory')).status, 403)
})

test('capability actions enforce optimistic settings revisions', async t => {
  const { panel, host } = await fixture(t)
  const snapshot = await request(panel, 'GET', '/api/console/capabilities')
  assert.equal(snapshot.json.data.settingsRevision, 1)
  const changed = await request(panel, 'POST', '/api/console/capabilities', {
    action: 'setEnabled', name: 'docs', enabled: false, expectedSettingsRevision: 1,
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.json.data.settingsRevision, 2)
  const stale = await request(panel, 'POST', '/api/console/capabilities', {
    action: 'setEnabled', name: 'docs', enabled: true, expectedSettingsRevision: 1,
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.json.error.id, 'SETTINGS_REVISION_CONFLICT')
  assert.equal(host.state.capabilityActions.length, 2)
  const added = await request(panel, 'POST', '/api/console/capabilities', {
    action: 'add', name: 'local', expectedSettingsRevision: 2,
    server: { transport: 'stdio', command: 'node', args: ['server.js'] },
  })
  assert.equal(added.status, 200)
  assert.deepEqual(host.state.capabilityActions.at(-1), {
    action: 'add', name: 'local', expectedSettingsRevision: 2,
    server: { transport: 'stdio', command: 'node', args: ['server.js'] },
  })
  const invalid = await request(panel, 'POST', '/api/console/capabilities', {
    action: 'add', name: 'local', expectedSettingsRevision: 2,
  })
  assert.equal(invalid.status, 400)
})

test('runtime streams replay cursor events and serve only validated frame bytes', async t => {
  const fake = fakeHost()
  fake.state.runtimeStream.publish({ type: 'screenshot', path: 'C:/shots/frame.png', capturedAt: Date.now() })
  const { panel } = await fixture(t, fake)
  const response = await fetch(`${panel.url}/api/console/runtime-view/events?cursor=0`, {
    headers: { authorization: `Bearer ${panel.token}` },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const chunk = await Promise.race([
    reader.read(),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('runtime stream timed out')), 2000); timer.unref?.() }),
  ])
  const text = new TextDecoder().decode(chunk.value)
  assert.match(text, /"type":"runtime"/)
  assert.match(text, /"type":"screenshot"/)
  assert.match(text, /frame\.png/)
  const firstCursor = Number(/id: (\d+)/.exec(text)?.[1])
  assert.ok(Number.isSafeInteger(firstCursor) && firstCursor > 0, 'runtime events carry an SSE resume id')
  await reader.cancel()
  fake.state.runtimeStream.publish({ type: 'current-action', action: { id: 'action-2', name: 'open-document' } })
  const resumed = await fetch(`${panel.url}/api/console/runtime-view/events?cursor=0`, {
    headers: { authorization: `Bearer ${panel.token}`, 'last-event-id': String(firstCursor) },
  })
  const resumedReader = resumed.body.getReader()
  const resumedChunk = await Promise.race([
    resumedReader.read(),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('resumed runtime stream timed out')), 2000); timer.unref?.() }),
  ])
  const resumedText = new TextDecoder().decode(resumedChunk.value)
  assert.match(resumedText, /open-document/)
  assert.doesNotMatch(resumedText, /frame\.png/, 'Last-Event-ID wins over a stale query cursor')
  await resumedReader.cancel()
  const frame = await request(panel, 'GET', '/api/console/runtime-view/frame?path=C%3A%2Fshots%2Fframe.png')
  assert.equal(frame.status, 200)
  assert.equal(frame.headers.get('content-type'), 'image/png')
  assert.equal(frame.text, 'png')
})

test('profile list/get/create/update/toggle/remove routes share a durable store', async t => {
  const base = fakeHost()
  const profileHost = base.host
  let store
  profileHost.profiles = async (action, payload = {}) => {
    const options = { actor: 'local' }
    if (action === 'list') return store.list(payload, options)
    if (action === 'get') return store.get(payload.id, options)
    if (action === 'create') return store.create(payload.profile ?? payload, options)
    if (action === 'update') return store.update(payload.id, payload.patch ?? {}, { ...options, expectedRevision: payload.expectedRevision })
    if (action === 'toggle') return store.setEnabled(payload.id, payload.enabled, options)
    if (action === 'remove') return store.remove(payload.id, options)
    throw new Error('unsupported profile action')
  }
  const { root, panel } = await fixture(t, profileHost)
  store = createAgentProfileStore({ file: path.join(root, 'profiles.json') })
  const created = await request(panel, 'POST', '/api/console/profiles', { action: 'create', profile: worker() })
  assert.equal(created.status, 200)
  assert.equal(created.json.data.revision, 1)
  const listed = await request(panel, 'GET', '/api/console/profiles?includeDisabled=true')
  assert.ok(listed.json.data.some(item => item.id === 'worker-1'))
  assert.equal((await request(panel, 'GET', '/api/console/profiles/worker-1')).json.data.name, 'Worker One')
  const renamed = await request(panel, 'POST', '/api/console/profiles', {
    action: 'update', id: 'worker-1', expectedRevision: 1, patch: { name: 'Worker Two' },
  })
  assert.equal(renamed.json.data.revision, 2)
  assert.equal((await request(panel, 'POST', '/api/console/profiles', {
    action: 'update', id: 'worker-1', expectedRevision: 1, patch: { name: 'stale' },
  })).status, 409)
  assert.equal((await request(panel, 'POST', '/api/console/profiles', {
    action: 'toggle', id: 'worker-1', enabled: false,
  })).json.data.enabled, false)
  assert.equal((await request(panel, 'GET', '/api/console/profiles')).json.data.some(item => item.id === 'worker-1'), false)
  assert.equal((await request(panel, 'POST', '/api/console/profiles', {
    action: 'remove', id: 'worker-1',
  })).status, 200)
  await assert.rejects(store.get('worker-1'), { code: 'PROFILE_NOT_FOUND' })
})

test('plan preview approval binds the exact digest and never starts execution', async t => {
  const { root } = await fixture(t)
  const host = fakeHost().host
  host.planPreview = async (action, payload) => action === 'candidate'
    ? createCandidatePlanPreview(payload)
    : action === 'preview'
      ? createPlanPreview({ ...payload, workspace: payload.workspace ?? root })
      : approvePlan(payload.preview, { planDigest: payload.planDigest, confirmations: payload.confirmations, approvedBy: 'local' })
  const { panel } = await fixture(t, host)
  const preview = await request(panel, 'POST', '/api/console/plan-preview', { action: 'preview', ...planInput(root) })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.data.sideEffects, 'none')
  assert.equal(preview.json.data.executionStarted, false)
  assert.ok(preview.json.data.planDigest)
  const approved = await request(panel, 'POST', '/api/console/plan-preview', {
    action: 'approve', preview: preview.json.data, planDigest: preview.json.data.planDigest,
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.json.data.kind, 'execution-spec')
  assert.equal(approved.json.data.executionStarted, false)
  assert.equal(approved.json.data.planDigest, preview.json.data.planDigest)
  const candidate = await request(panel, 'POST', '/api/console/plan-preview', { action: 'candidate',
    goal: 'Prepare a candidate release', project: root,
    subtasks: [{ id: 'draft', title: 'Draft', prompt: 'Write the release note', capabilities: [] }],
    capabilities: [], model: 'test/model', pricing: { 'test/model': { input: 2, output: 4, currency: 'CNY' } },
    permissionScope: { tools: [], allow: ['workspace.read'], deny: [], approvalMode: 'policy' },
    runtime: { cwd: root, isolation: 'workspace', provider: 'local' },
  })
  assert.equal(candidate.status, 200, JSON.stringify(candidate.json))
  assert.equal(candidate.json.data.kind, 'candidate-plan-preview')
  assert.equal(candidate.json.data.executionStarted, false)
  assert.ok(candidate.json.data.permissionScope)
  assert.ok(candidate.json.data.runtime)
  assert.equal((await request(panel, 'POST', '/api/console/plan-preview', {
    action: 'approve', preview: preview.json.data, planDigest: '0'.repeat(64),
  })).status, 409)
})

test('voice transcription delegates a validated WAV to remote.speech and reports missing service', async t => {
  const { root } = await fixture(t)
  const calls = []
  const voice = createVoiceService({ remote: { speech: {
    catalog: async () => ({ models: ['test/model'] }),
    transcribe: async input => { calls.push(input); return { text: 'ship it' } },
  } } })
  const host = fakeHost().host
  host.voice = async (action, payload) => action === 'catalog' ? voice.catalog()
    : { text: await voice.transcribe(Buffer.from(payload.audio, 'base64'), payload.options) }
  const { panel } = await fixture(t, host)
  const wav = encodeWav(new Int16Array([0, 100, -100]))
  const response = await request(panel, 'POST', '/api/console/voice/transcribe', {
    audio: Buffer.from(wav).toString('base64'), options: { language: 'en' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.data.text, 'ship it')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mimeType, 'audio/wav')
  assert.equal(calls[0].format.sampleRate, 16000)
  assert.equal(calls[0].language, 'en')

  const missing = await fixture(t, fakeHost().host)
  const unavailable = await request(missing.panel, 'POST', '/api/console/voice/transcribe', {
    audio: Buffer.from(wav).toString('base64'),
  })
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.json.error.id, 'unavailable')
})

test('PWA assets have correct MIME/CSP and the served worker excludes APIs from cache', async t => {
  const { panel } = await fixture(t)
  const manifest = await request(panel, 'GET', '/manifest.webmanifest', undefined, { token: null })
  assert.equal(manifest.status, 200)
  assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/)
  assert.match(manifest.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal(JSON.parse(manifest.text).start_url, '/mobile.html')

  const mobile = await request(panel, 'GET', '/mobile.html', undefined, { token: null })
  assert.equal(mobile.status, 200)
  assert.match(mobile.headers.get('content-type'), /^text\/html/)
  assert.match(mobile.headers.get('content-security-policy'), /worker-src 'self'/)
  assert.match(mobile.headers.get('content-security-policy'), /connect-src 'self'/)
  for (const tag of ['style', 'script']) {
    const start = mobile.text.indexOf(`<${tag}>`) + tag.length + 2
    const content = mobile.text.slice(start, mobile.text.indexOf(`</${tag}>`, start))
    const hash = createHash('sha256').update(content).digest('base64')
    assert.ok(mobile.headers.get('content-security-policy').includes(`'sha256-${hash}'`),
      `${tag} header CSP must match the served inline content`)
  }

  const worker = await request(panel, 'GET', '/sw.js', undefined, { token: null })
  assert.equal(worker.status, 200)
  assert.match(worker.headers.get('content-type'), /^application\/javascript/)
  assert.match(worker.text, /'api'/)
  assert.match(worker.text, /isSensitivePath\(pathname\)/)

  const icon = await request(panel, 'GET', '/icons/superagent-192.svg', undefined, { token: null })
  assert.equal(icon.status, 200)
  assert.match(icon.headers.get('content-type'), /^image\/svg\+xml/)
  assert.match(icon.text, /<svg/)
  assert.equal((await request(panel, 'GET', '/icons/..%2fconsole.json', undefined, { token: null })).status, 404)
  assert.equal((await rawRequest(panel, '/mobile.html', { host: 'example.com' })).status, 403)
})

test('device pair/status/revoke routes return the token once and keep status sanitized', async t => {
  const { root } = await fixture(t)
  const devices = createDevicePairingStore({ file: path.join(root, 'devices.json') })
  const host = fakeHost().host
  host.capabilities = () => ({ chat: true })
  host.devicePairing = async (action, payload = {}) => action === 'pair' ? devices.pair(payload)
    : action === 'verify' ? devices.verify(payload.token)
      : action === 'status' ? devices.status(payload.id) : devices.revoke(payload.id)
  const { panel } = await fixture(t, host)
  const paired = await request(panel, 'POST', '/api/console/device/pair', {
    name: 'Phone', scopes: ['chat', 'tasks', 'approval'], expiresInSeconds: 120,
  })
  assert.equal(paired.status, 200)
  assert.match(paired.json.data.token, /^dsm_/)
  assert.deepEqual(paired.json.data.scopes, ['chat', 'tasks', 'approval'])
  const status = await request(panel, 'GET', `/api/console/device/status?id=${paired.json.data.id}`)
  assert.equal(status.status, 200)
  assert.equal(status.json.data.status, 'active')
  assert.equal(status.json.data.token, undefined)
  assert.equal(status.json.data.tokenHash, undefined)
  const realtime = await fetch(`${panel.url}/api/console/events`, {
    headers: { authorization: `Bearer ${paired.json.data.token}` },
  })
  if (realtime.status !== 200) assert.fail(await realtime.text())
  assert.match(realtime.headers.get('content-type'), /text\/event-stream/)
  await realtime.body.cancel()
  const revoked = await request(panel, 'POST', '/api/console/device/revoke', { id: paired.json.data.id })
  assert.equal(revoked.json.data.status, 'revoked')
  assert.equal(await devices.verify(paired.json.data.token), null)
  assert.equal((await request(panel, 'GET', '/api/console/device/status')).json.data[0].status, 'revoked')
})

test('real apply wiring persists integrations and audits sensitive actions without logging tokens', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-real-console-integrations-'))
  const state = path.join(root, 'state')
  const disposeEvents = []
  const effects = []
  const ctx = {
    tools: { register: () => {} },
    get: () => undefined,
    on: (event, callback) => { if (event === 'dispose') disposeEvents.push(callback) },
    effect: callback => { effects.push(callback()) },
  }
  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose?.()
    for (const dispose of disposeEvents.reverse()) await dispose?.()
    await fsp.rm(root, { recursive: true, force: true })
  })
  apply(ctx, { stateDir: state, consolePort: 0, consoleRoot: root, workbenchRoot: root,
    notifyOnComplete: false, audit: true, memory: true, runtime: { enabled: false } })
  const discovery = await waitForJson(path.join(state, 'console.json'))
  const panel = { url: discovery.url, token: discovery.token }

  assert.equal((await request(panel, 'GET', '/api/console/capabilities')).json.data.schemaVersion, 1)
  assert.equal((await request(panel, 'GET', '/api/console/runtime-view')).json.data.available, false)
  assert.equal((await request(panel, 'GET', '/api/console/cost')).status, 200)
  assert.equal((await request(panel, 'GET', '/api/console/runs/missing/evidence')).status, 404)

  const fromText = await request(panel, 'POST', '/api/console/automations', {
    action: 'from-text', text: '每天9点 总结项目状态',
  })
  assert.equal(fromText.status, 200, JSON.stringify(fromText.json))
  assert.equal(fromText.json.data.rule.trigger.cron, '0 9 * * *')
  assert.equal(fromText.json.data.preview.executionStarted, false)
  assert.ok(fromText.json.data.rule.budget.maxModelCalls > 0)

  const autoPlan = await request(panel, 'POST', '/api/console/plan-preview', {
    action: 'auto', goal: '检查项目并总结状态', project: root, constraints: { maxSubtasks: 2 },
  })
  assert.equal(autoPlan.status, 200, JSON.stringify(autoPlan.json))
  assert.equal(autoPlan.json.data.kind, 'candidate-plan-preview')
  assert.equal(autoPlan.json.data.status, 'ready')
  assert.ok(autoPlan.json.data.inputSnapshot.subtasks.length >= 1)
  assert.equal(autoPlan.json.data.generation.userSuppliedSubtasks, false)
  assert.equal(path.resolve(autoPlan.json.data.runtime.cwd), path.resolve(root))

  const preferences = await request(panel, 'PATCH', '/api/console/notifications/preferences', {
    events: { completed: 'off' },
  })
  assert.equal(preferences.status, 200)
  assert.equal(JSON.parse(await fsp.readFile(path.join(state, 'notification-preferences.json'), 'utf8')).events.completed, 'off')

  assert.equal((await request(panel, 'POST', '/api/console/profiles', { action: 'create', profile: worker('real-worker') })).status, 200)
  assert.ok(JSON.parse(await fsp.readFile(path.join(state, 'agent-profiles.json'), 'utf8')).profiles.some(item => item.id === 'real-worker'))

  const paired = await request(panel, 'POST', '/api/console/device/pair', { name: 'Real phone', scopes: ['chat', 'inbox'] })
  assert.equal(paired.status, 200)
  const devices = await fsp.readFile(path.join(state, 'devices.json'), 'utf8')
  assert.equal(devices.includes(paired.json.data.token), false)
  assert.match(devices, /"tokenHash": "[a-f0-9]{64}"/)
  const audit = await fsp.readFile(path.join(state, 'audit', 'audit.jsonl'), 'utf8')
  assert.match(audit, /notifications\.preferences\.update/)
  assert.match(audit, /profiles\.create/)
  assert.match(audit, /devices\.pair/)
  assert.equal(audit.includes(paired.json.data.token), false)
})

async function waitForJson(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}
