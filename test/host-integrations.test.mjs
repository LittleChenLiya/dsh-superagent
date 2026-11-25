import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { apply } from '../lib/index.js'

const execFileAsync = promisify(execFile)
const OWNER = 'session-host-integration'

function gate() {
  let open
  const opened = new Promise(resolve => { open = resolve })
  return { opened, open }
}

async function within(promise, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function completed(text) {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

function directSubagents(onSpawn = () => {}) {
  return {
    async startActivation(spec) {
      onSpawn(spec)
      return {
        childId: `child-${spec.label}`,
        result: Promise.resolve(completed('host integration answer')),
        dispose: async () => {},
      }
    },
  }
}

/** The same tool-registration surface as plugin.test, plus host lifecycle/services. */
async function mount(t, { config = {}, services = {}, subagents = directSubagents() } = {}) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-host-integrations-'))
  const stateDir = path.join(temporary, 'state')
  const home = path.join(temporary, 'home')
  await fsp.mkdir(home)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tools = new Map()
  const listeners = new Map()
  const effects = []
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents,
    get: name => services[name],
    on(event, listener) {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
      return () => listeners.set(event, entries.filter(entry => entry !== listener))
    },
    effect(factory) {
      effects.push(factory)
    },
    async dispose() {
      for (const listener of listeners.get('dispose') ?? []) await listener()
      for (const factory of effects.reverse()) await factory()
    },
  }
  apply(ctx, { stateDir, notifyOnComplete: false, ...config })
  t.after(async () => {
    await ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return { ctx, tools, stateDir, temporary, execute: (name, args = {}, agent = { id: OWNER }) => tools.get(name).execute(args, { agent }) }
}

function owner(cwd) {
  return {
    id: OWNER,
    session: { header: { cwd, delegationDepth: 0 } },
    ctx: { tools: { get: () => undefined } },
  }
}

function parseStatus(text) {
  assert.doesNotMatch(text, /^\[error\]/, text)
  return JSON.parse(text)
}

function fakeScheduleService() {
  const tasks = new Map()
  const calls = []
  let sequence = 0
  return {
    tasks,
    calls,
    async create(request, actorSessionId) {
      calls.push({ method: 'create', args: [request, actorSessionId] })
      const task = {
        id: `host-task-${++sequence}`,
        title: request.title,
        prompt: request.prompt,
        kind: request.timing.kind,
        ...request.timing,
        target: request.target,
        status: 'active',
        updatedAt: '2026-11-25T12:00:00.000Z',
      }
      tasks.set(task.id, structuredClone(task))
      return structuredClone(task)
    },
    async list(request) {
      calls.push({ method: 'list', args: [request] })
      const items = [...tasks.values()]
      return { items: structuredClone(items), total: items.length, limit: request.limit, offset: request.offset }
    },
    async view(request) {
      calls.push({ method: 'view', args: [request] })
      return structuredClone(tasks.get(request.id) ?? { id: request.id, code: 'schedule_not_found' })
    },
    async edit(request) {
      calls.push({ method: 'edit', args: [request] })
      if (request.action === 'delete') return { id: request.id, deleted: true }
      return structuredClone(tasks.get(request.id))
    },
    async run(request) {
      calls.push({ method: 'run', args: [request] })
      return structuredClone(tasks.get(request.id))
    },
    async history(request) {
      calls.push({ method: 'history', args: [request] })
      return { id: request.id, records: [] }
    },
    async deleteInactive() {
      calls.push({ method: 'deleteInactive', args: [] })
      return { deleted: 0 }
    },
  }
}

async function git(cwd, args) {
  return execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'host-test',
      GIT_AUTHOR_EMAIL: 'host-test@example.invalid',
      GIT_COMMITTER_NAME: 'host-test',
      GIT_COMMITTER_EMAIL: 'host-test@example.invalid',
    },
  })
}

test('default host integrations stay off and the plugin still mounts all tools', async t => {
  const host = await mount(t)
  assert.equal(host.tools.size, 14)
  const status = parseStatus(await host.execute('superagent_audit', { format: 'status' }))
  assert.equal(status.observability.configured, false)
  assert.equal(status.observability.enabled, false)
  assert.equal(status.mcpMemory.status, 'disabled')
  assert.equal(status.hostSchedule, 'unavailable')
  assert.equal(status.workspaceProvider, 'local')
  assert.equal(status.reviewer, 'disabled')
})

test('MCP memory registration has exactly name and entry and is released by ctx disposal', async t => {
  const registration = gate()
  const released = gate()
  const calls = []
  const manager = {
    register(...args) {
      calls.push(args)
      return registration.opened.then(() => async () => released.open())
    },
    list: () => [{ serverName: 'release-test-memory', status: 'connected' }],
  }
  const host = await mount(t, {
    services: { mcpManager: manager },
    config: {
      mcpMemory: {
        enabled: true,
        serverName: 'release-test-memory',
        command: 'memory-server',
        args: ['--stdio'],
        env: { MEMORY_MODE: 'test' },
      },
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 2)
  assert.equal(calls[0][0], 'release-test-memory')
  assert.deepEqual(calls[0][1], {
    transport: 'stdio', command: 'memory-server', args: ['--stdio'], env: { MEMORY_MODE: 'test' },
  })

  const disposing = host.ctx.dispose()
  registration.open()
  await within(released.opened, 'ctx.dispose did not release the MCP registration')
  await disposing
  assert.equal(calls.length, 1)
})

test('real run execution emits metadata-only OTel run events', async t => {
  const events = []
  const finished = gate()
  const reporterOptions = []
  const host = await mount(t, {
    services: {
      otel: {
        createEventReporter(options) {
          reporterOptions.push(options)
          return {
            emit(event) {
              events.push(event)
              if (event.attributes.eventType === 'run.finished') finished.open()
            },
            async shutdown() {},
          }
        },
      },
    },
    config: { observability: { enabled: true, endpoint: 'http://otel.invalid/v1/events', exportSessionLogs: true } },
  })
  const secret = 'PRIVATE_GOAL_AND_REPORT_SENTINEL'
  const started = await host.execute('superagent_start', { goal: secret, mode: 'direct' }, owner())
  const runId = /run ([0-9A-Za-z-]+) —/.exec(started)?.[1]
  assert.ok(runId, started)
  await within(finished.opened, 'the real run did not emit run.finished')

  assert.equal(reporterOptions.length, 1)
  const runEvents = events.filter(event => event.attributes.runId === runId)
  assert.ok(runEvents.some(event => event.attributes.eventType === 'run.milestone'))
  assert.ok(runEvents.some(event => event.attributes.eventType === 'run.finished'))
  for (const event of runEvents) {
    assert.equal(event.eventName, 'dsh-superagent.event')
    assert.equal(Object.hasOwn(event, 'goal'), false)
    assert.equal(Object.hasOwn(event, 'report'), false)
    assert.equal(Object.hasOwn(event.attributes, 'goal'), false)
    assert.equal(Object.hasOwn(event.attributes, 'report'), false)
    assert.doesNotMatch(JSON.stringify(event), new RegExp(secret))
  }
  assert.match(await host.execute('superagent_status', { run_id: runId, wait_seconds: 10 }), /— completed/)
})

test('audit format=status reports observability, MCP memory, and host schedule state', async t => {
  const schedule = fakeScheduleService()
  const host = await mount(t, {
    services: {
      mcpManager: { register: () => () => {}, list: () => [{ serverName: 'superagent-memory', status: 'connected' }] },
      schedule: { schedule },
      otel: { createEventReporter: () => ({ emit() {}, async shutdown() {} }) },
    },
    config: {
      observability: { enabled: true, endpoint: 'http://otel.invalid/v1/events' },
      mcpMemory: { enabled: true },
      workspaceProvider: 'host',
      reviewerEnabled: true,
    },
  })
  const status = parseStatus(await host.execute('superagent_audit', { format: 'status' }))
  assert.equal(status.observability.enabled, true)
  assert.equal(status.observability.reporting, 'active')
  assert.equal(status.mcpMemory.status, 'connected')
  assert.equal(status.hostSchedule, 'available')
  assert.equal(status.workspaceProvider, 'host')
  assert.equal(status.reviewer, 'enabled')
})

test('schedule create uses the host service directly and creates no local plan', async t => {
  const schedule = fakeScheduleService()
  const host = await mount(t, { services: { schedule: { schedule } } })
  const agent = owner(host.temporary)
  const created = await host.execute('superagent_schedule', {
    action: 'create', name: 'Host release check', goal: 'verify release', mode: 'direct', every_minutes: 5,
  }, agent)
  assert.match(created, /created Host Schedule task host-task-1/)
  assert.match(created, /no plugin-local timer was armed/)
  assert.equal(schedule.tasks.size, 1)
  const create = schedule.calls.find(call => call.method === 'create')
  assert.equal(create.args.length, 2)
  assert.equal(create.args[1], OWNER)
  assert.equal(create.args[0].title, 'Host release check')
  assert.deepEqual(create.args[0].timing, { kind: 'every', every_seconds: 300 })
  assert.deepEqual(create.args[0].target, { kind: 'session', sessionId: OWNER })
  assert.match(create.args[0].prompt, /superagent_start/)
  assert.match(create.args[0].prompt, /verify release/)
  await assert.rejects(fsp.stat(path.join(host.stateDir, 'schedules.json')), { code: 'ENOENT' })
  const listed = await host.execute('superagent_schedule', { action: 'list' }, agent)
  assert.match(listed, /Host Scheduler:\nhost-task-1\s+active\s+Host release check\s+every/)
})

test('scheduleProvider=local never registers a host task', async t => {
  const schedule = fakeScheduleService()
  const host = await mount(t, { services: { schedule: { schedule } }, config: { scheduleProvider: 'local' } })
  const created = await host.execute('superagent_schedule', {
    action: 'create', name: 'Local only', goal: 'stay local', every_minutes: 5,
  }, owner(host.temporary))
  assert.match(created, /created schedule sch-/)
  assert.equal(schedule.calls.length, 0)
})

test('workspaceProvider=host uses host worktrees.create and restores the parent cwd', async t => {
  const repository = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-host-repo-'))
  t.after(() => fsp.rm(repository, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  await git(repository, ['init', '-b', 'main'])
  await git(repository, ['config', 'core.autocrlf', 'false'])
  await fsp.writeFile(path.join(repository, '.gitignore'), '.superagent/\n')
  await fsp.writeFile(path.join(repository, 'notes.txt'), 'initial\n')
  await git(repository, ['add', '-A'])
  await git(repository, ['commit', '-m', 'initial'])
  const { stdout: baseCommit } = await git(repository, ['rev-parse', 'HEAD'])
  const parent = owner(repository)
  let cwd = repository
  const calls = { create: [], set: [] }
  const spawned = []
  const worktrees = {
    async create(agent, request) {
      calls.create.push({ agent, request })
      const dir = path.join(repository, '.superagent', 'worktrees', request.name)
      await git(repository, ['worktree', 'add', '-b', request.name, dir, 'HEAD'])
      cwd = dir
      return { path: dir, branch: request.name, baseCommit: baseCommit.trim(), repositoryRoot: repository }
    },
    async restore() { throw new Error('a new run must not restore a worktree') },
  }
  const workingDirectory = {
    defaultDirectory: repository,
    get() { return cwd },
    async set(agent, dir) {
      calls.set.push({ agent, dir })
      cwd = dir
      return dir
    },
  }
  const services = {}
  const host = await mount(t, {
    services,
    config: { workspaceIsolation: true, workspaceProvider: 'host', workspaceRoot: repository },
    subagents: directSubagents(spec => {
      if (spec.label === 'superagent-direct') spawned.push(spec)
    }),
  })
  services.worktrees = worktrees
  services.workingDirectory = workingDirectory
  const result = await host.execute('superagent_start', { goal: 'write in host worktree', mode: 'direct', wait_seconds: 10 }, parent)
  assert.match(result, /— completed/)
  assert.doesNotMatch(result, /workspace isolation unavailable/)
  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].agent, parent)
  assert.equal(calls.create[0].request.name, `superagent-${/run ([0-9A-Za-z-]+) —/.exec(result)[1]}-w1`)
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].cwd, path.join(repository, '.superagent', 'worktrees', calls.create[0].request.name))
  assert.deepEqual(calls.set, [{ agent: parent, dir: repository }])
  assert.equal(cwd, repository)
  assert.equal(workingDirectory.get(parent.session), repository)
})

test('missing host services degrade through real tool paths without crashing', async t => {
  const host = await mount(t, {
    config: {
      observability: { enabled: true, endpoint: 'http://otel.invalid/v1/events' },
      mcpMemory: { enabled: true },
      workspaceIsolation: true,
      workspaceProvider: 'host',
    },
  })
  const agent = owner(host.temporary)
  const status = parseStatus(await host.execute('superagent_audit', { format: 'status' }))
  assert.equal(status.observability.enabled, false)
  assert.equal(status.mcpMemory.status, 'disabled')
  assert.match(status.mcpMemory.reason, /mcp manager is unavailable/)
  assert.equal(status.hostSchedule, 'unavailable')

  const created = await host.execute('superagent_schedule', {
    action: 'create', name: 'Local fallback', goal: 'still works', every_minutes: 5,
  }, agent)
  assert.match(created, /created schedule sch-/)
  assert.match(created, /plugin-local timer is armed/)
  const result = await host.execute('superagent_start', { goal: 'missing services', mode: 'direct', wait_seconds: 10 }, agent)
  assert.match(result, /— completed/)
  assert.match(result, /isolation was requested but is unavailable/)
  assert.match(result, /host worktrees service is unavailable/)
})
