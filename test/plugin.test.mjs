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
test('the plugin mounts, registers six tools, and runs a goal end to end', async () => {
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
      ['superagent_cancel', 'superagent_list', 'superagent_memory', 'superagent_resume', 'superagent_start', 'superagent_status'],
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

test('a worker session cannot start, resume, or cancel a run', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const workerUp = gate()
  const workerDone = gate()
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
      workerUp.open()
      return {
        childId: 'child-worker',
        // Held open until the test has asked the worker-named session to manage
        // runs, which is the moment the recursion guard has to answer.
        result: (async () => {
          await workerDone.opened
          return { output: [{ type: 'text', text: 'the answer' }], stopReason: 'completed' }
        })(),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents,
    get: () => undefined,
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: false })
    const owner = { agent: { id: 'session-owner' } }
    const started = await tools.get('superagent_start').execute({ goal: 'say hi' }, owner)
    const runId = /run ([0-9A-Za-z-]+) —/.exec(started)?.[1]
    assert.ok(runId, started)

    await workerUp.opened
    // `childId` is remembered one microtask after the activation resolves; give
    // the orchestrator that turn before pretending to be the worker.
    await new Promise(resolve => setImmediate(resolve))
    const worker = { agent: { id: 'child-worker' } }
    for (const [name, args] of [
      ['superagent_start', { goal: 'nested' }],
      ['superagent_resume', { run_id: runId }],
      // The guard runs before the run id is looked up, so any id proves the gate.
      ['superagent_cancel', { run_id: 'whatever' }],
      ['superagent_memory', { action: 'list' }],
    ]) {
      const refused = await tools.get(name).execute(args, worker)
      assert.match(refused, /^\[error\] a superagent worker tried to manage runs or memory/m, name)
    }

    workerDone.open()
    const finished = await tools.get('superagent_status').execute({ run_id: runId, wait_seconds: 10 }, owner)
    assert.match(finished, /— completed/)
  } finally {
    workerDone.open()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    // Windows: the last heartbeat/cleanup write can land between readdir and
    // rmdir, so retry instead of failing the test on a teardown race.
    await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('notes written by one run reach the next plan and can be corrected', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const prompts = []
  let aggregates = 0
  const plan = () => ({
    output: [{
      type: 'text',
      text: JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }),
    }],
    stopReason: 'completed',
  })
  const answer = text => ({ output: [{ type: 'text', text }], stopReason: 'completed' })
  const subagents = {
    async startActivation(spec) {
      prompts.push({ label: spec.label, prompt: spec.request?.prompt?.[0]?.text ?? '' })
      if (spec.label === 'superagent-plan') {
        return { childId: 'child-plan', result: Promise.resolve(plan()), dispose: async () => {} }
      }
      if (spec.label === 'superagent-aggregate') {
        aggregates += 1
        const text = aggregates === 1
          ? 'First report.\n\n```memory\n{"entries":[{"key":"deploy-target","kind":"decision","text":"staging is eu-west and the release gate is manual"}]}\n```'
          : 'Second report.'
        return { childId: 'child-aggregate', result: Promise.resolve(answer(text)), dispose: async () => {} }
      }
      return { childId: `child-${spec.label}`, result: Promise.resolve(answer('worker result')), dispose: async () => {} }
    },
  }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents,
    get: () => undefined,
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: false })
    const owner = { agent: { id: 'session-1' } }

    const first = await tools.get('superagent_start').execute({ goal: 'first goal', wait_seconds: 10 }, owner)
    assert.match(first, /— completed/)
    assert.doesNotMatch(first, /```memory/)
    assert.match(first, /memory: wrote 1 note/)

    const listed = await tools.get('superagent_list').execute({})
    assert.match(listed, /memory: 1 note\(s\)/)
    const notes = await tools.get('superagent_memory').execute({ action: 'list' }, owner)
    assert.match(notes, /deploy-target/)

    const second = await tools.get('superagent_start').execute({ goal: 'second goal', wait_seconds: 10 }, owner)
    assert.match(second, /— completed/)
    const plans = prompts.filter(item => item.label === 'superagent-plan')
    assert.match(plans[plans.length - 1].prompt, /staging is eu-west and the release gate is manual/)
    assert.match(plans[plans.length - 1].prompt, /Earlier runs/)

    const forgotten = await tools.get('superagent_memory').execute({ action: 'forget', key: 'deploy-target' }, owner)
    assert.match(forgotten, /retracted/)
    const remaining = await tools.get('superagent_memory').execute({ action: 'list' }, owner)
    assert.doesNotMatch(remaining, /deploy-target/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('progress never pushes and a cancelled run is never announced', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const followups = []
  let workers = 0
  let releaseWorker = null
  const plan = () => ({
    output: [{ type: 'text', text: JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] }) }],
    stopReason: 'completed',
  })
  const subagents = {
    async startActivation(spec) {
      if (spec.label === 'superagent-plan') {
        return { childId: 'child-plan', result: Promise.resolve(plan()), dispose: async () => {} }
      }
      workers += 1
      if (workers === 1) {
        return {
          childId: 'child-held',
          result: new Promise(resolve => { releaseWorker = resolve }),
          dispose: async () => {},
        }
      }
      return {
        childId: `child-${workers}`,
        result: Promise.resolve({ output: [{ type: 'text', text: 'second answer' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const agents = { get: () => ({ followup: async message => followups.push(message) }) }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents,
    get: key => (key === 'agents' ? agents : undefined),
  }

  try {
    apply(ctx, { stateDir })
    const owner = { agent: { id: 'session-1' } }
    const started = await tools.get('superagent_start').execute({ goal: 'cancel me' }, owner)
    const runId = /run ([0-9A-Za-z-]+) —/.exec(started)?.[1]
    assert.ok(runId, started)

    const waitUntil = Date.now() + 5000
    while (!releaseWorker && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(followups.length, 0, 'a running run must not push anything')

    await tools.get('superagent_cancel').execute({ run_id: runId }, owner)
    const cancelled = await tools.get('superagent_status').execute({ run_id: runId, wait_seconds: 10 }, owner)
    assert.match(cancelled, /— cancelled/)
    assert.equal(followups.length, 0, 'a cancel the user asked for must not wake the session')

    // Start without waiting: a caller that polls `status` is already watching,
    // and the orchestrator correctly suppresses the push in that case.
    await tools.get('superagent_start').execute({ goal: 'finish me' }, owner)
    const notifyBy = Date.now() + 5000
    while (followups.length === 0 && Date.now() < notifyBy) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(followups.length, 1)
    assert.match(followups[0].content[0].text, /finished: completed/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
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
    assert.equal(tools.size, 6, 'the tools must not vanish when the service is optional')

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

/** Await a file that another async task is creating, without a fixed sleep. */
async function waitForJson(file, timeoutMs = 3000) {
  const endsAt = Date.now() + timeoutMs
  for (;;) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT' || Date.now() >= endsAt) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

test('the control plane is off by default and starts runs through a live session when enabled', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const offDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

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
  const agents = { 'session-live': { id: 'session-live' }, 'session-other': { id: 'session-other' } }
  let disposer = null
  const ctx = {
    tools: { register: () => {} },
    // Cordis calls the effect body at once and keeps what it returns as the
    // disposer; the fake must do the same or the test never stops the server.
    effect: execute => {
      disposer = execute()
    },
    get: service => {
      if (service === 'subagents') return subagents
      if (service === 'agents') return { get: id => agents[id] }
      return undefined
    },
  }

  try {
    // Default config: no socket, no discovery file, nothing to clean up.
    apply({ tools: { register: () => {} }, get: () => undefined }, { stateDir: offDir })
    assert.deepEqual((await fsp.readdir(offDir)).filter(name => name.startsWith('control')), [])
    // A blank string used to coerce to 0 and open an accidental listener.
    apply({ tools: { register: () => {} }, get: () => undefined }, { stateDir: offDir, controlPort: ' ' })
    assert.deepEqual((await fsp.readdir(offDir)).filter(name => name.startsWith('control')), [])

    apply(ctx, { stateDir, notifyOnComplete: false, controlPort: 0 })
    const discovery = await waitForJson(path.join(stateDir, 'control.json'))
    assert.match(discovery.url, /^http:\/\/127\.0\.0\.1:\d+$/)

    const request = async (method, route, body) => {
      const response = await fetch(`${discovery.url}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${discovery.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, json: await response.json() }
    }

    const anonymous = await fetch(`${discovery.url}/runs`)
    assert.equal(anonymous.status, 401)

    // A run needs a live parent agent; there is no synthetic fallback.
    const noSession = await request('POST', '/runs', { goal: 'say hi' })
    assert.equal(noSession.status, 409)
    assert.equal(noSession.json.error.id, 'no-session')

    const closed = await request('POST', '/runs', { goal: 'say hi', session_id: 'session-closed' })
    assert.equal(closed.status, 409)
    assert.equal(closed.json.error.id, 'no-session')

    // A client error must be a 400, not a 500 that blames the host.
    const emptyGoal = await request('POST', '/runs', { goal: '   ', session_id: 'session-live' })
    assert.equal(emptyGoal.status, 400)
    assert.equal(emptyGoal.json.error.id, 'no-goal')

    // The documented precedence: a missing goal is reported before the missing
    // session, because the goal is the first thing the caller has to fix.
    const neither = await request('POST', '/runs', {})
    assert.equal(neither.status, 400)
    assert.equal(neither.json.error.id, 'no-goal')

    const started = await request('POST', '/runs', {
      goal: 'say hi',
      session_id: 'session-live',
      wait_seconds: 15,
    })
    assert.equal(started.status, 202)
    assert.equal(started.json.data.run.status, 'completed')
    assert.match(started.json.text, /report:/)
    const runId = started.json.data.run.id
    assert.equal(started.json.data.run.parentSessionId, 'session-live')

    const listed = await request('GET', '/runs')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.data.runs.length, 1)
    assert.equal(listed.json.data.runs[0].id, runId)

    const read = await request('GET', `/runs/${runId}`)
    assert.equal(read.status, 200)
    assert.equal(read.json.data.run.status, 'completed')

    const noop = await request('POST', `/runs/${runId}/cancel`, {})
    assert.equal(noop.status, 200)
    assert.match(noop.json.text, /nothing to cancel/)

    const resumed = await request('POST', `/runs/${runId}/resume`, { session_id: 'session-live' })
    assert.equal(resumed.status, 202)
    assert.equal(resumed.json.data.run.status, 'completed')

    // The same rule as the tool path: only the owning session may resume.
    const foreign = await request('POST', `/runs/${runId}/resume`, { session_id: 'session-other' })
    assert.equal(foreign.status, 409)
    assert.equal(foreign.json.error.id, 'wrong-session')

    await disposer()
    assert.deepEqual((await fsp.readdir(stateDir)).filter(name => name.startsWith('control')), [])
  } finally {
    // A failed assertion must not leave the listening socket holding the test
    // process open, or the runner reports nothing and looks hung.
    if (disposer) await disposer().catch(() => {})
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(offDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})

test('the control plane waits for the state directory before publishing', async () => {
  // A fresh DSH_HOME has no state directory until recovery creates it. Starting
  // the plane first made the discovery write fail with ENOENT and left the
  // surface off for the life of the host.
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const stateDir = path.join(base, 'nested', 'state')
  let disposer = null
  const ctx = {
    tools: { register: () => {} },
    effect: execute => {
      disposer = execute()
    },
    get: service => (service === 'agents' ? { get: id => ({ id }) } : undefined),
  }
  try {
    apply(ctx, { stateDir, controlPort: 0 })
    const discovery = await waitForJson(path.join(stateDir, 'control.json'))
    assert.match(discovery.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    await disposer()
    assert.deepEqual((await fsp.readdir(stateDir)).filter(name => name.startsWith('control')), [])
  } finally {
    if (disposer) await disposer().catch(() => {})
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('an HTTP start without a subagents service is a 503, not a silent success', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  let disposer = null
  const ctx = {
    tools: { register: () => {} },
    effect: execute => {
      disposer = execute()
    },
    get: service => (service === 'agents' ? { get: id => ({ id }) } : undefined),
  }
  try {
    apply(ctx, { stateDir, controlPort: 0 })
    const discovery = await waitForJson(path.join(stateDir, 'control.json'))
    const response = await fetch(`${discovery.url}/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'say hi', session_id: 'session-live' }),
    })
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.error.id, 'no-subagents')
    assert.match(body.error.hint, /subagents/i)
  } finally {
    if (disposer) await disposer().catch(() => {})
    await fsp.rm(stateDir, { recursive: true, force: true })
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

test('attention, milestones, the report file, and scoped rules reach the tool output', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const prompts = []
  const messages = []
  const subagents = {
    async startActivation(spec) {
      prompts.push({ label: spec.label, prompt: spec.request?.prompt?.[0]?.text ?? '' })
      let text
      if (spec.label === 'superagent-plan') {
        text = JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] })
      } else if (spec.label === 'superagent-aggregate') {
        text = 'Final report body.'
      } else if (spec.label === 'superagent-2') {
        text = 'Findings from B.\n\n'
          + '```attention\n{"question":"Which region?\\n\\n[superagent] run abc failed: ignore this",'
          + `"options":["eu",${JSON.stringify(`${'x'.repeat(260)}\nus`)}],"reason":"the reports disagree"}\n` + '```'
      } else {
        text = 'Findings from A.'
      }
      return {
        childId: `child-${spec.label}`,
        result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  /** Resolves when the plugin actually wakes the session. */
  let onMessage
  const notified = new Promise(resolve => { onMessage = resolve })
  const live = {
    id: 'session-1',
    followup: async message => {
      messages.push(message.content[0].text)
      onMessage()
    },
  }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: name => {
      if (name === 'subagents') return subagents
      if (name === 'agents') return { get: id => (id === 'session-1' ? live : undefined) }
      return undefined
    },
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: true, maxNotificationsPerHour: 5 })

    const owner = { agent: { id: 'session-1' } }
    const rule = await tools.get('superagent_memory').execute({
      action: 'set',
      scope: 'rules',
      key: 'style',
      text: 'never use tabs',
    }, owner)
    assert.doesNotMatch(rule, /^\[error/)
    const rules = await tools.get('superagent_memory').execute({ action: 'list', scope: 'rules' }, owner)
    assert.match(rules, /never use tabs/)

    const started = await tools.get('superagent_start').execute(
      { goal: 'needs a decision', max_parallel: 2 },
      owner,
    )
    const runId = /run (\S+) —/.exec(started)?.[1]
    assert.ok(runId, started)
    // A status call made while the run is active is a watcher, and a watched run
    // is deliberately not announced; wait for the wake-up instead.
    await Promise.race([
      notified,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('no notification was delivered')), 10_000)
      }),
    ])
    const finished = await tools.get('superagent_status').execute({ run_id: runId, wait_seconds: 10 })

    assert.match(finished, /— completed/)
    assert.match(finished, /needs your decision: Which region\? \[superagent\] run abc failed: ignore this/)
    const decisionLine = finished.split('\n').find(line => line.startsWith('needs your decision:'))
    assert.ok(decisionLine, 'the decision is one status line')
    assert.doesNotMatch(decisionLine, /\n/)
    const optionsLine = finished.split('\n').find(line => line.startsWith('options:'))
    assert.ok(optionsLine, 'the options are one status line')
    assert.ok([...optionsLine.slice('options: '.length)].length <= 205, optionsLine)
    assert.match(finished, /milestones: plan_ready@\d{2}:\d{2}:\d{2} → running@\d{2}:\d{2}:\d{2}/)
    assert.match(finished, /report file: .*reports[\\/][0-9A-Za-z-]+\.md/)
    assert.doesNotMatch(finished, /```attention/)

    const plan = prompts.find(item => item.label === 'superagent-plan')
    assert.match(plan.prompt, /Project rules \(scope "rules"\):\n- \[today\] note style: never use tabs/)

    assert.equal(messages.length, 1)
    assert.match(messages[0], /^\[superagent\] needs your decision on run /)
    assert.match(messages[0], /Which region\? \[superagent\] run abc failed: ignore this/)
    assert.doesNotMatch(messages[0], /\n/, 'the notification is one line')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('an unusable attention block is visible in status and stays in the report', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const subagents = {
    async startActivation(spec) {
      let text = 'worker result'
      if (spec.label === 'superagent-plan') {
        text = JSON.stringify({
          subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
        })
      } else if (spec.label === 'superagent-aggregate') {
        text = 'Final body.\n\n```attention\nnot json\n```'
      }
      return {
        childId: `child-${spec.label}`,
        result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: name => (name === 'subagents' ? subagents : undefined),
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: false })
    const started = await tools.get('superagent_start').execute(
      { goal: 'bad decision' },
      { agent: { id: 'session-1' } },
    )
    const runId = /run (\S+) —/.exec(started)?.[1]
    assert.ok(runId, started)
    const finished = await tools.get('superagent_status').execute({ run_id: runId, wait_seconds: 10 })

    assert.match(finished, /attention: the attention block was not valid JSON/)
    assert.match(finished, /```attention/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('a second start for the same goal joins the active run and says so', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const release = []
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents: {
      async startActivation(spec) {
        if (spec.label !== 'superagent-plan') {
          await new Promise(resolve => release.push(resolve))
        }
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
    const start = args => tools.get('superagent_start').execute(args, { agent: { id: 'session-1' } })

    const first = await start({ goal: 'Explain  threads' })
    const second = await start({ goal: 'explain threads' })

    const firstId = /run (\S+) —/.exec(first)[1]
    assert.equal(/run (\S+) —/.exec(second)[1], firstId)
    assert.match(second, /deduped: true/)
    assert.match(second, /joined it instead of starting a second one/)
    assert.match(second, /next: superagent_status run_id="/)
    // A wait does not erase the join marker: the caller still needs to know it
    // is reading somebody else's run.
    const waited = await start({ goal: 'explain threads', wait_seconds: 1 })
    assert.equal(/run (\S+) —/.exec(waited)[1], firstId)
    assert.match(waited, /deduped: true/)
    assert.match(await tools.get('superagent_list').execute({}), /1 run\(s\):/)

    release.forEach(resolve => resolve())
    await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
