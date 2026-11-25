import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMCPMemoryBridge,
  DEFAULT_MCP_MEMORY_CONFIG,
  normalizeMCPMemoryConfig,
} from '../lib/mcp-memory.js'

function managerWith(register, list = () => []) {
  const manager = {
    lastName: null,
    register(name, entry) {
      manager.lastName = name
      return register(entry)
    },
    list,
  }
  return manager
}

test('defaults are disabled, copied, and never register with the manager', () => {
  assert.deepEqual(DEFAULT_MCP_MEMORY_CONFIG, {
    enabled: false,
    serverName: 'superagent-memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    url: '',
    headers: {},
  })
  assert.equal(Object.isFrozen(DEFAULT_MCP_MEMORY_CONFIG), true)
  assert.equal(Object.isFrozen(DEFAULT_MCP_MEMORY_CONFIG.args), true)

  let calls = 0
  const bridge = createMCPMemoryBridge({
    mcpManager: managerWith(() => { calls += 1 }),
  })
  assert.equal(calls, 0)
  assert.equal(bridge.status().status, 'disabled')
  assert.match(bridge.status().reason, /configuration/)
})

test('normalization copies nested values and resolves environment references', () => {
  const input = {
    enabled: true,
    env: { PLAIN: 'value', TOKEN: { env: 'MCP_TEST_TOKEN' }, DOLLAR: '$MCP_TEST_TOKEN', BRACED: '${MCP_TEST_TOKEN}' },
  }
  const normalized = normalizeMCPMemoryConfig(input, { MCP_TEST_TOKEN: 'resolved-secret' })
  assert.deepEqual(normalized.env, {
    PLAIN: 'value',
    TOKEN: 'resolved-secret',
    DOLLAR: 'resolved-secret',
    BRACED: 'resolved-secret',
  })
  normalized.args.push('changed')
  normalized.env.PLAIN = 'changed'
  assert.deepEqual(input.args, undefined)
  assert.equal(input.env.PLAIN, 'value')
  assert.deepEqual(DEFAULT_MCP_MEMORY_CONFIG.args, ['-y', '@modelcontextprotocol/server-memory'])
})

test('a late manager is retried without installing or spawning anything', async () => {
  let current = null
  const calls = []
  const bridge = createMCPMemoryBridge({
    config: { enabled: true },
    mcpManager: () => current,
  })
  assert.equal(bridge.status().status, 'disabled')
  current = {
    register(name, entry) {
      calls.push({ name, entry })
      return () => {}
    },
    list: () => [],
  }
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'superagent-memory')
  assert.equal(bridge.status().status, 'registered')
  await bridge.dispose()
})

test('stdio registration forwards only manager fields and disposes once', async () => {
  const calls = []
  let releases = 0
  const manager = managerWith(config => {
    calls.push(config)
    return () => { releases += 1 }
  })
  const bridge = createMCPMemoryBridge({
    config: { enabled: true, serverName: 'memory-test', env: { MODE: 'test' } },
    mcpManager: manager,
  })
  assert.equal(manager.lastName, 'memory-test')
  assert.equal(bridge.status().status, 'registered')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: { MODE: 'test' },
  })
  await Promise.all([bridge.dispose(), bridge.dispose()])
  assert.equal(releases, 1)
  assert.equal(bridge.status().status, 'disabled')
})

test('registration disposer follows a Cordis effect lifecycle', async () => {
  let cleanup
  let releases = 0
  const ctx = {
    effect(execute) {
      cleanup = execute()
      return cleanup
    },
  }
  const bridge = createMCPMemoryBridge({
    ctx,
    config: { enabled: true },
    mcpManager: managerWith(() => () => { releases += 1 }),
  })
  assert.equal(typeof cleanup, 'function')
  await cleanup()
  assert.equal(releases, 1)
  assert.equal(bridge.status().status, 'disabled')
})

test('a lifecycle hook failure releases registration without crashing', async () => {
  let released = false
  let bridge
  assert.doesNotThrow(() => {
    bridge = createMCPMemoryBridge({
      ctx: { effect: () => { throw new Error('context is inactive') } },
      config: { enabled: true },
      mcpManager: managerWith(() => () => { released = true }),
    })
  })
  await bridge.ready
  await bridge.dispose()
  assert.equal(released, true)
})

test('http registration normalizes transport and accepts string/header env credentials', () => {
  let received
  const bridge = createMCPMemoryBridge({
    config: {
      enabled: true,
      transport: 'http',
      url: 'https://memory.example.test/mcp',
      headers: { Authorization: 'Bearer literal', 'X-Test': { $env: 'MCP_TEST_HEADER' } },
    },
    env: { MCP_TEST_HEADER: 'resolved-header' },
    mcpManager: managerWith(config => { received = config }),
  })
  assert.equal(bridge.status().status, 'registered')
  assert.equal(received.transport, 'streamable-http')
  assert.equal(received.url, 'https://memory.example.test/mcp')
  assert.deepEqual(received.headers, {
    Authorization: 'Bearer literal',
    'X-Test': 'resolved-header',
  })
})

test('enabled config without a usable manager is disabled with a reason', () => {
  for (const mcpManager of [undefined, null, {}, { register: true }]) {
    const bridge = createMCPMemoryBridge({ mcpManager, config: { enabled: true } })
    assert.equal(bridge.status().status, 'disabled')
    assert.match(bridge.status().reason, /unavailable/)
  }
})

test('bad config is rejected without calling register or leaking values', () => {
  const invalid = [
    null,
    { enabled: 'true' },
    { serverName: '' },
    { serverName: 'bad name' },
    { serverName: 'a'.repeat(33) },
    { transport: 'sse' },
    { transport: 'stdio', command: '' },
    { transport: 'stdio', args: '-y' },
    { transport: 'stdio', args: [1] },
    { transport: 'stdio', env: [] },
    { transport: 'stdio', env: { TOKEN: { secret: 'do-not-log' } } },
    { transport: 'stdio', env: { TOKEN: { env: 'MISSING_TEST_VALUE' } } },
    { transport: 'http', url: '' },
    { transport: 'http', url: '/relative' },
    { transport: 'http', url: 'file:///tmp/mcp' },
    { transport: 'http', url: 'https://user:password@example.test/mcp' },
    { transport: 'http', url: 'https://example.test/mcp', headers: { 'Bad Header': 'x' } },
  ]
  for (const config of invalid) {
    assert.throws(() => normalizeMCPMemoryConfig(config, {}), TypeError)
  }

  let calls = 0
  const logs = []
  const bridge = createMCPMemoryBridge({
    config: { enabled: true, transport: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer do-not-log' } },
    // Force a manager error containing the same secret; it must not reach logs/status.
    mcpManager: managerWith(() => { calls += 1; throw new Error('Bearer do-not-log') }),
    log: message => logs.push(message),
  })
  assert.equal(calls, 1)
  assert.equal(bridge.status().status, 'error')
  assert.doesNotMatch(JSON.stringify(bridge.status()), /do-not-log/)
  assert.doesNotMatch(logs.join('\n'), /do-not-log/)
})

test('register failure is contained for synchronous and asynchronous managers', async () => {
  const sync = createMCPMemoryBridge({
    config: { enabled: true },
    mcpManager: managerWith(() => { throw new Error('registration exploded') }),
  })
  assert.equal(sync.status().status, 'error')
  await sync.dispose()

  const asyncBridge = createMCPMemoryBridge({
    config: { enabled: true },
    mcpManager: managerWith(() => Promise.reject(new Error('registration exploded'))),
  })
  assert.equal(asyncBridge.status().status, 'registering')
  await asyncBridge.ready
  assert.equal(asyncBridge.status().status, 'error')
})

test('status prefers manager list and falls back to registered when absent', async () => {
  let entries = [{ serverName: 'superagent-memory', status: 'connected', env: { TOKEN: 'hidden' } }]
  const bridge = createMCPMemoryBridge({
    config: { enabled: true },
    mcpManager: managerWith(() => () => {}, () => entries),
  })
  assert.deepEqual(bridge.status(), {
    serverName: 'superagent-memory',
    transport: 'stdio',
    status: 'connected',
  })
  assert.doesNotMatch(JSON.stringify(bridge.status()), /hidden/)

  entries = [{ serverName: 'other', status: 'error' }]
  assert.equal(bridge.status().status, 'registered')
  entries = { servers: [{ name: 'superagent-memory', state: 'connecting' }] }
  assert.equal(bridge.status().status, 'connecting')
  entries = new Map([['superagent-memory', { status: 'offline' }]])
  assert.equal(bridge.status().status, 'offline')
  entries = []
  assert.equal(bridge.status().status, 'registered')
  await bridge.dispose()
})

test('status survives list failures and observes asynchronous lists', async () => {
  let list = () => { throw new Error('list unavailable') }
  const bridge = createMCPMemoryBridge({
    config: { enabled: true },
    mcpManager: managerWith(() => () => {}, () => list()),
  })
  assert.equal(bridge.status().status, 'registered')
  list = async () => [{ serverName: 'superagent-memory', status: 'connected' }]
  assert.equal(bridge.status().status, 'registered')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(bridge.status().status, 'connected')
  await bridge.dispose()
})

test('object-shaped registration disposers are released', async () => {
  let released = false
  const bridge = createMCPMemoryBridge({
    config: { enabled: true },
    mcpManager: managerWith(() => ({ dispose: async () => { released = true } })),
  })
  await bridge.dispose()
  assert.equal(released, true)
})
