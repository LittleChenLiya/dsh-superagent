import assert from 'node:assert/strict'
import test from 'node:test'

import { createCapabilityCenterAdapter } from '../lib/capability-center.js'

function settingsFixture(servers, revision = 7) {
  let current = servers
  const calls = []
  return {
    calls,
    get revision() { return revision },
    async get(path) {
      return path === 'mcp.servers' ? current : { servers: current }
    },
    async set(path, value, options) {
      calls.push({ path, value, options })
      if (options.expectedSettingsRevision !== revision) {
        const error = new Error('stale settings')
        error.statusCode = 409
        throw error
      }
      current = value
      revision += 1
      return { revision }
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('missing services produce explicit unsupported views and no fake connectors', async () => {
  const center = createCapabilityCenterAdapter({})
  const snapshot = await center.snapshot()
  assert.equal(snapshot.skills.supported, false)
  assert.equal(snapshot.mcp.supported, false)
  assert.equal(snapshot.grants.supported, false)
  assert.deepEqual(snapshot.connectors, { supported: false, items: [] })
  assert.deepEqual(snapshot.mcp.operations, {
    list: false,
    watch: false,
    probe: false,
    restart: false,
    add: false,
    setEnabled: false,
  })
  assert.equal((await center.watch(() => {})).supported, false)
  await assert.rejects(center.probe('missing'), error => error.statusCode === 503 && error.code === 'MCP_PROBE_UNSUPPORTED')
  await center.dispose()
})

test('snapshot aggregates host capabilities, preserves same-name skills, and redacts configuration', async () => {
  const settings = settingsFixture({
    docs: {
      enabled: true,
      transport: 'streamable-http',
      url: 'https://private.example.test/mcp?token=url-secret',
      env: { TOKEN: 'env-secret' },
      headers: { Authorization: 'Bearer header-secret' },
    },
  })
  const center = createCapabilityCenterAdapter({
    skills: {
      async snapshot() {
        return {
          skills: [
            { name: 'review', source: 'user', description: 'Review changes', status: { state: 'ready' }, secret: 'skill-secret' },
            { name: 'review', source: 'workspace', description: 'Workspace review' },
          ],
        }
      },
    },
    mcpManager: {
      async list() {
        return {
          servers: [{
            name: 'docs',
            status: { state: 'connected', detail: 'status-secret' },
            url: 'https://private.example.test/mcp?token=url-secret',
            env: { TOKEN: 'env-secret' },
            headers: { Authorization: 'Bearer header-secret' },
          }],
        }
      },
      probe: async () => ({ ok: true, status: 'connected' }),
      restart: async () => ({ ok: true, status: 'connected' }),
      watch: () => () => {},
    },
    settings,
    credentials: {
      async list() {
        return [{ id: 'cred-1', provider: 'github', status: 'configured', payload: { token: 'grant-secret' }, secret: 'credential-secret' }]
      },
    },
    authorization: {
      async snapshot() {
        return { authorizations: [{ id: 'grant-1', clientId: 'client', scopes: ['repo', 'read:org'], payload: 'grant-secret' }] }
      },
    },
    permissions: {
      async list() {
        return [{ id: 'perm-1', resource: 'workspace', action: 'write', effect: 'allow', secret: 'permission-secret' }]
      },
    },
  })

  const snapshot = await center.snapshot()
  assert.equal(snapshot.settingsRevision, 7)
  assert.equal(snapshot.skills.supported, true)
  assert.deepEqual(snapshot.skills.duplicates, [{ name: 'review', count: 2 }])
  assert.equal(snapshot.skills.items.length, 2)
  assert.equal(snapshot.skills.items[0].status, 'ready')
  assert.deepEqual(snapshot.mcp.servers, [{
    name: 'docs',
    configured: true,
    registered: true,
    enabled: true,
    status: 'connected',
    manageable: true,
    pluginOwned: false,
    transport: 'streamable-http',
  }])
  assert.deepEqual(snapshot.mcp.operations, {
    list: true,
    watch: true,
    probe: true,
    restart: true,
    add: true,
    setEnabled: true,
  })
  assert.equal(snapshot.grants.supported, true)
  assert.deepEqual(snapshot.grants.items.map(item => item.source), ['credentials', 'authorization', 'permissions'])
  assert.deepEqual(snapshot.grants.items[1].scopes, ['repo', 'read:org'])
  assert.equal(snapshot.connectors.supported, false)
  assert.deepEqual(snapshot.connectors.items, [])

  const serialized = JSON.stringify(snapshot)
  for (const secret of ['url-secret', 'env-secret', 'header-secret', 'grant-secret', 'credential-secret', 'permission-secret', 'skill-secret', 'status-secret', 'private.example.test']) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  await center.dispose()
})

test('public grants preserve bounded scalar scopes and exclude unsafe array content', async () => {
  const safeScopes = ['repo', 7, true]
  const extraScopes = Array.from({ length: 101 }, (_, index) => `scope-${index}`)
  const center = createCapabilityCenterAdapter({
    authorization: {
      async snapshot() {
        return {
          authorizations: [{
            id: 'grant-1',
            scopes: [
              ...safeScopes,
              null,
              undefined,
              { token: 'array-secret' },
              ['nested-secret'],
              Infinity,
              NaN,
              1n,
              Symbol('symbol-secret'),
              () => 'function-secret',
              'x'.repeat(513),
              ...extraScopes,
            ],
            unsafeScopes: ['unrequested-secret'],
          }],
        }
      },
    },
  })

  const snapshot = await center.snapshot()
  const grant = snapshot.grants.items[0]
  assert.deepEqual(grant.scopes, [...safeScopes, ...extraScopes.slice(0, 97)])
  assert.equal(grant.scopes.length, 100)
  assert.equal('unsafeScopes' in grant, false)
  assert.doesNotMatch(JSON.stringify(grant), /array-secret|nested-secret|unrequested-secret|function-secret/)
  await center.dispose()
})

test('watch subscribes once, emits only sanitized snapshots, and releases the host watch', async () => {
  let notify
  let entries = [{ name: 'docs', status: 'connecting', headers: { Authorization: 'watch-secret' } }]
  let subscriptions = 0
  let releases = 0
  const settings = settingsFixture({ docs: { enabled: true, headers: { Authorization: 'settings-secret' } } })
  const center = createCapabilityCenterAdapter({
    mcpManager: {
      list: () => entries,
      watch(callback) {
        subscriptions += 1
        notify = callback
        return () => { releases += 1 }
      },
    },
    settings,
  })
  const first = []
  const second = []
  const stopFirst = center.watch(event => first.push(event))
  const stopSecond = center.watch(event => second.push(event))
  assert.equal(subscriptions, 1)
  assert.equal((await center.snapshot()).mcp.watching, true)

  entries = [{ name: 'docs', status: { state: 'connected' }, env: { TOKEN: 'watch-secret' } }]
  notify({ name: 'docs', env: { TOKEN: 'raw-watch-secret' }, payload: 'raw-watch-secret' })
  await tick()
  await tick()
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.equal(first[0].type, 'snapshot')
  assert.equal(first[0].snapshot.mcp.servers[0].status, 'connected')
  assert.doesNotMatch(JSON.stringify(first), /watch-secret|settings-secret|raw-watch-secret/)

  stopFirst()
  assert.equal(releases, 0)
  stopSecond()
  await tick()
  assert.equal(releases, 1)
  assert.equal((await center.snapshot()).mcp.watching, false)
  await center.dispose()
})

test('probe and restart use enabled registered servers and reject disabled probes', async () => {
  const calls = []
  let enabled = true
  const center = createCapabilityCenterAdapter({
    mcpManager: {
      list: () => [{ name: 'docs', status: enabled ? 'connected' : 'disabled' }],
      probe: async name => { calls.push(['probe', name]); return { ok: true, status: 'connected', env: { TOKEN: 'probe-secret' } } },
      restart: async name => { calls.push(['restart', name]); return { ok: true, status: 'connected', url: 'https://restart-secret.example' } },
    },
    settings: settingsFixture({ docs: { enabled: true } }),
  })
  assert.deepEqual(await center.execute({ action: 'probe', name: 'docs' }), { name: 'docs', ok: true, status: 'connected' })
  assert.deepEqual(await center.execute('restart', { serverName: 'docs' }), { name: 'docs', ok: true, status: 'connected' })
  assert.deepEqual(calls, [['probe', 'docs'], ['restart', 'docs']])
  assert.doesNotMatch(JSON.stringify(calls), /secret/)

  enabled = false
  await assert.rejects(center.probe('docs'), error => error.statusCode === 409 && error.code === 'MCP_SERVER_DISABLED')
  assert.deepEqual(calls, [['probe', 'docs'], ['restart', 'docs']])
  await assert.rejects(center.execute({ action: 'watch', name: 'docs' }), error => error.statusCode === 400 && error.code === 'UNSUPPORTED_MCP_ACTION')
  await assert.rejects(center.execute({ action: 'setEnabled', name: 'docs' }), error => error.statusCode === 400 && error.code === 'INVALID_MCP_ENABLED')
  await center.dispose()
})

test('registered plugin-owned and unmanaged servers cannot be enabled or disabled', async () => {
  let writes = 0
  const settings = {
    revision: 3,
    get: async path => path === 'mcp.servers' ? { plugin: { enabled: true, owner: { kind: 'plugin' } } } : {},
    set: async () => { writes += 1 },
  }
  const center = createCapabilityCenterAdapter({
    mcpManager: {
      list: () => [
        { name: 'plugin', status: 'connected' },
        { name: 'superagent-memory', status: 'connected' },
        { name: 'unmanaged', status: 'connected' },
      ],
    },
    settings,
  })
  for (const name of ['plugin', 'superagent-memory']) {
    for (const enabled of [true, false]) {
      await assert.rejects(center.setEnabled({ name, enabled, expectedSettingsRevision: 3 }), error => (
        error.statusCode === 409 && error.code === 'PLUGIN_OWNED_MCP_SERVER'
      ))
    }
  }
  for (const enabled of [true, false]) {
    await assert.rejects(center.setEnabled('unmanaged', enabled, 3), error => (
      error.statusCode === 409 && error.code === 'MCP_SERVER_NOT_SETTINGS_OWNED'
    ))
  }
  assert.equal(writes, 0)
  await center.dispose()
})

test('setEnabled checks and forwards expectedSettingsRevision without exposing secrets', async () => {
  const settings = settingsFixture({
    docs: {
      enabled: true,
      transport: 'streamable-http',
      url: 'https://private.example.test/mcp?token=url-secret',
      headers: { Authorization: 'Bearer header-secret' },
      env: { TOKEN: 'env-secret' },
    },
  })
  const center = createCapabilityCenterAdapter({
    mcpManager: { list: () => [{ name: 'docs', status: 'connected' }] },
    settings,
  })
  await assert.rejects(center.setEnabled({ name: 'docs', enabled: false, expectedSettingsRevision: 6 }), error => {
    assert.equal(error.statusCode, 409)
    assert.equal(error.code, 'SETTINGS_REVISION_CONFLICT')
    assert.equal(error.expectedSettingsRevision, 6)
    assert.equal(error.actualSettingsRevision, 7)
    return true
  })
  assert.equal(settings.calls.length, 0)

  const result = await center.setEnabled({ name: 'docs', enabled: false, expectedSettingsRevision: 7 })
  assert.deepEqual(result, { ok: true, name: 'docs', enabled: false, settingsRevision: 8 })
  assert.equal(settings.calls.length, 1)
  assert.deepEqual(settings.calls[0].options, { expectedSettingsRevision: 7 })
  assert.equal(settings.calls[0].value.docs.enabled, false)
  assert.equal(settings.calls[0].value.docs.headers.Authorization, 'Bearer header-secret')
  assert.equal(settings.calls[0].value.docs.env.TOKEN, 'env-secret')
  assert.equal(settings.calls[0].value.docs.url, 'https://private.example.test/mcp?token=url-secret')
  assert.doesNotMatch(JSON.stringify(result), /secret|private\.example/)

  const snapshot = await center.snapshot()
  assert.equal(snapshot.settingsRevision, 8)
  assert.equal(snapshot.mcp.servers[0].enabled, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private\.example/)
  await center.dispose()
})

test('host failures never leak exception text, URLs, or credentials', async () => {
  const center = createCapabilityCenterAdapter({
    mcpManager: {
      list: () => [{ name: 'docs', status: 'connected' }],
      probe: async () => { throw new Error('https://private.example token=probe-secret') },
      restart: async () => ({ ok: false, reason: 'Bearer restart-secret' }),
    },
    settings: settingsFixture({ docs: { enabled: true } }),
  })
  await assert.rejects(center.probe('docs'), error => {
    assert.equal(error.statusCode, 502)
    assert.equal(error.code, 'MCP_PROBE_FAILED')
    assert.doesNotMatch(JSON.stringify(error), /probe-secret|private\.example/)
    return true
  })
  const restarted = await center.restart('docs')
  assert.deepEqual(restarted, { name: 'docs', ok: false, error: 'MCP_OPERATION_FAILED' })
  assert.doesNotMatch(JSON.stringify(restarted), /restart-secret/)
  await center.dispose()
})

test('a real connector registry is surfaced without inventing one from MCP servers', async () => {
  const center = createCapabilityCenterAdapter({
    connectorRegistry: {
      async list() {
        return { connectors: [{ id: 'conn-1', name: 'browser', kind: 'browser', enabled: true, url: 'https://connector-secret.example' }] }
      },
    },
    mcpManager: { list: () => [{ name: 'docs', status: 'connected' }] },
  })
  const snapshot = await center.snapshot()
  assert.deepEqual(snapshot.connectors, {
    supported: true,
    items: [{ name: 'browser', id: 'conn-1', kind: 'browser', enabled: true }],
  })
  assert.doesNotMatch(JSON.stringify(snapshot), /connector-secret/)
  await center.dispose()
})

test('addServer writes validated MCP settings and refuses plaintext credentials', async () => {
  const settings = settingsFixture({ docs: { enabled: true } }, 4)
  const center = createCapabilityCenterAdapter({ settings })
  await assert.rejects(center.addServer({ name: 'unsafe', expectedSettingsRevision: 4,
    server: { transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: 'plain-secret' } } }),
  error => error.statusCode === 400 && error.code === 'MCP_CREDENTIAL_FORBIDDEN')
  await assert.rejects(center.addServer({ name: 'remote', expectedSettingsRevision: 4,
    server: { transport: 'http', url: 'https://mcp.example.test?token=plain-secret' } }),
  error => error.statusCode === 400 && error.code === 'MCP_CREDENTIAL_FORBIDDEN')
  assert.equal(settings.calls.length, 0)
  const result = await center.addServer({ name: 'local', expectedSettingsRevision: 4,
    server: { transport: 'stdio', command: 'node', args: ['server.js'], env: { TOKEN: '${MCP_TOKEN}' } } })
  assert.deepEqual(result, { ok: true, name: 'local', settingsRevision: 5, restartRequired: false })
  assert.deepEqual(settings.calls[0].value.local, {
    transport: 'stdio', enabled: true, command: 'node', args: ['server.js'], env: { TOKEN: '${MCP_TOKEN}' },
  })
  assert.equal(settings.calls[0].options.expectedSettingsRevision, 4)
  await assert.rejects(center.addServer({ name: 'local', expectedSettingsRevision: 5,
    server: { transport: 'stdio', command: 'node' } }), error => error.statusCode === 409 && error.code === 'MCP_SERVER_EXISTS')
})

test('settings writes are serialized so a stale concurrent request cannot win', async () => {
  const gate = deferred()
  const settings = settingsFixture({ docs: { enabled: true } }, 1)
  const originalSet = settings.set.bind(settings)
  settings.set = async (...args) => {
    await gate.promise
    return originalSet(...args)
  }
  const center = createCapabilityCenterAdapter({
    mcpManager: { list: () => [{ name: 'docs', status: 'connected' }] },
    settings,
  })
  const first = center.setEnabled({ name: 'docs', enabled: false, expectedSettingsRevision: 1 })
  const stale = center.setEnabled({ name: 'docs', enabled: true, expectedSettingsRevision: 1 })
  gate.resolve()
  assert.deepEqual(await first, { ok: true, name: 'docs', enabled: false, settingsRevision: 2 })
  await assert.rejects(stale, error => error.statusCode === 409 && error.code === 'SETTINGS_REVISION_CONFLICT')
  assert.equal(settings.calls.length, 1)
  await center.dispose()
})
