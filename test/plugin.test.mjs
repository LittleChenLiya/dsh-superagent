import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/** A promise that resolves when `open()` is called, with no polling. */
function gate() {
  let open
  const opened = new Promise(resolve => {
    open = resolve
  })
  return { opened, open: () => open() }
}


/**
 * Mount the plugin against a fake host: only `tools.register`, `subagents`, and
 * `agents` are provided, which is the whole injected surface.
 */
test('the plugin mounts, registers five tools, and runs a goal end to end', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents: {
      async startActivation(spec) {
        const text = spec.label === 'superagent-plan'
          ? JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] })
          : 'the answer'
        return {
          childId: `child-${spec.label}`,
          result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    get: () => undefined,
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: false })

    assert.equal(name, 'dsh-superagent')
    assert.deepEqual(inject, ['tools', 'agents'])
    assert.deepEqual(
      [...tools.keys()].sort(),
      ['superagent_cancel', 'superagent_list', 'superagent_resume', 'superagent_start', 'superagent_status'],
    )

    const started = await tools.get('superagent_start').execute(
      { goal: 'say hi', wait_seconds: 10 },
      { agent: { id: 'session-1' } },
    )
    assert.match(started, /— completed/)
    assert.match(started, /report:/)
    assert.match(started, /the answer/)
    assert.match(started, /usage: not recorded/)
    assert.doesNotMatch(started, /\[error/)

    const listed = await tools.get('superagent_list').execute({})
    assert.match(listed, /1 run\(s\):/)
    assert.match(listed, /state: \d+ file\(s\), [\d.]+ (B|KB|MB) in /)

    const missing = await tools.get('superagent_status').execute({ run_id: '20260101T000000-none' })
    assert.match(missing, /^\[error\] no run with that id/)
    assert.match(missing, /^hint: /m)
    assert.match(missing, /^detail: /m)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('without a subagents service the tools still mount and explain what is missing', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: () => undefined,
  }

  try {
    apply(ctx, { stateDir })
    assert.equal(tools.size, 5, 'the tools must not vanish when the service is optional')

    const started = await tools.get('superagent_start').execute({ goal: 'needs workers' }, { agent: { id: 'session-1' } })
    assert.match(started, /subagent service is unavailable/)
    assert.match(started, /hint: /)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('an unusable state directory is reported instead of an empty run list', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const blocked = path.join(dir, 'not-a-directory')
  await fsp.writeFile(blocked, 'this is a file', 'utf8')
  const tools = new Map()
  const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, get: () => undefined }

  try {
    apply(ctx, { stateDir: path.join(blocked, 'nested') })
    const listed = await tools.get('superagent_list').execute({})
    assert.match(listed, /^\[error\]/)
    assert.match(listed, /state directory/i)
    assert.doesNotMatch(listed, /no superagent runs recorded/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a host that loses its subagent service mid-run leaves the run resumable', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  // The first worker runs and reports a provider error; by the time the plugin
  // retries, the host is shutting down and the service is gone. That must not
  // be recorded as two failed attempts — the work never got a chance to run.
  let available = true
  let workers = 0
  const subagents = {
    async startActivation(spec) {
      if (spec.label === 'superagent-plan') {
        return {
          childId: 'child-plan',
          result: Promise.resolve({
            output: [{ type: 'text', text: JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }) }],
            stopReason: 'completed',
          }),
          dispose: async () => {},
        }
      }
      workers += 1
      if (workers === 1) {
        available = false
        return {
          childId: 'child-worker-1',
          result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'provider crashed' }),
          dispose: async () => {},
        }
      }
      return {
        childId: 'child-worker-2',
        result: Promise.resolve({ output: [{ type: 'text', text: 'finished after resume' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: service => {
      if (service === 'subagents') return available ? subagents : undefined
      if (service === 'agents') return { get: () => undefined }
      return undefined
    },
  }
  const tools = new Map()

  try {
    apply(ctx, { stateDir })
    const started = await tools.get('superagent_start').execute({ goal: 'survive a shutdown' }, { agent: { id: 'session-1' } })
    const runId = /run (\S+) —/.exec(started)[1]

    const interrupted = await tools.get('superagent_status').execute({ run_id: runId, wait_seconds: 10 })
    assert.match(interrupted, /— interrupted/)
    assert.match(interrupted, /note: the host shut down while this run was active/)
    assert.match(interrupted, /next: superagent_resume run_id="#{0,1}/)
    assert.doesNotMatch(interrupted, /failed \(attempts 2\)/)

    available = true
    const resumed = await tools.get('superagent_resume').execute(
      { run_id: runId, wait_seconds: 10 },
      { agent: { id: 'session-1' } },
    )
    assert.match(resumed, /— completed/)
    assert.match(resumed, /finished after resume/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('a run that finishes with its session gone says the result was not delivered', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  // Resolved when the plugin actually tries to wake the session. That is the
  // event this test waits for instead of sleeping and polling.
  const notifyAttempted = gate()
  const subagents = {
    async startActivation(spec) {
      const text = spec.label === 'superagent-plan'
        ? JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] })
        : 'the answer'
      return {
        childId: `child-${spec.label}`,
        result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: name => {
      if (name === 'subagents') return subagents
      if (name === 'agents') {
        notifyAttempted.open()
        // No live sessions: the owning session cannot be woken.
        return { get: () => undefined }
      }
      return undefined
    },
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: true })
    const started = await tools.get('superagent_start').execute({ goal: 'notify nobody' }, { agent: { id: 'session-gone' } })
    const runId = /run (\S+) —/.exec(started)[1]

    await notifyAttempted.opened
    // No waiter existed when the run settled, so the wake-up was attempted and
    // its failure must be visible.
    const status = await tools.get('superagent_status').execute({ run_id: runId, wait_seconds: 10 })
    assert.match(status, /— completed/)
    assert.match(status, /notify: not delivered — the owning session session-gone is no longer live/)
    assert.match(status, /report:/)

    const listed = await tools.get('superagent_list').execute({})
    assert.match(listed, /\(result not delivered to the session\)/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})
