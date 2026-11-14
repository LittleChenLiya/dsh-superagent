import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/**
 * Mount the plugin against a fake host: only `tools.register`, `subagents`, and
 * `agents` are provided, which is the whole injected surface.
 */
test('the plugin mounts, registers five tools, and runs a goal end to end', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'longhaul-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'longhaul-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents: {
      async startActivation(spec) {
        const text = spec.label === 'longhaul-plan'
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

    assert.equal(name, 'dsh-longhaul')
    assert.deepEqual(inject, ['tools', 'agents', 'subagents'])
    assert.deepEqual(
      [...tools.keys()].sort(),
      ['longhaul_cancel', 'longhaul_list', 'longhaul_resume', 'longhaul_start', 'longhaul_status'],
    )

    const started = await tools.get('longhaul_start').execute(
      { goal: 'say hi', wait_seconds: 10 },
      { agent: { id: 'session-1' } },
    )
    assert.match(started, /— completed/)
    assert.match(started, /report:/)
    assert.match(started, /the answer/)
    assert.match(started, /usage: not recorded/)
    assert.doesNotMatch(started, /\[error/)

    const listed = await tools.get('longhaul_list').execute({})
    assert.match(listed, /1 run\(s\):/)
    assert.match(listed, /state: \d+ file\(s\), [\d.]+ (B|KB|MB) in /)

    const missing = await tools.get('longhaul_status').execute({ run_id: '20260101T000000-none' })
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

test('a run that finishes with its session gone says the result was not delivered', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'longhaul-plugin-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'longhaul-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    subagents: {
      async startActivation(spec) {
        const text = spec.label === 'longhaul-plan'
          ? JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] })
          : 'the answer'
        return {
          childId: `child-${spec.label}`,
          result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    // No live sessions: the owning session cannot be woken.
    get: () => undefined,
  }

  try {
    apply(ctx, { stateDir, notifyOnComplete: true })
    const started = await tools.get('longhaul_start').execute({ goal: 'notify nobody' }, { agent: { id: 'session-gone' } })
    const runId = /run (\S+) —/.exec(started)[1]

    let status = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await tools.get('longhaul_status').execute({ run_id: runId })
      if (/— (completed|partial|failed)/.test(status)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.match(status, /— completed/)
    assert.match(status, /notify: not delivered — the owning session session-gone is no longer live/)
    assert.match(status, /report:/)

    const listed = await tools.get('longhaul_list').execute({})
    assert.match(listed, /\(result not delivered to the session\)/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await fsp.rm(stateDir, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
})
