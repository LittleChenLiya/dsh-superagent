// The plugin's own fixed cost is paid on every request of every session, so it
// is bounded here: the tools a fresh session is shown, plus the one guidance
// notice, may not exceed the caps below. Task work is not measured — only the
// declarations and the notice that ride along whether or not the plugin is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

// ASCII at 4 chars/token, CJK at 1.5 chars/token: a deliberate upper bound of
// what a BPE tokenizer charges, so a cap built on it never under-counts.
const estimate = text => {
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 128) ascii += 1
    else wide += 1
  }
  return Math.ceil(ascii / 4 + wide / 1.5)
}

// Caps for one request's fixed payload. The first pair is what a fresh session
// actually has declared; the second pair is a backstop on the whole registered
// set, so a broken or unsupported gate cannot silently push the cost back up
// without failing this file. Both are estimates, deliberately conservative.
const ALWAYS_ON_CHARS_MAX = 7000
const ALWAYS_ON_TOKENS_MAX = 1750
const ALL_TOOLS_CHARS_MAX = 30000
const ALL_TOOLS_TOKENS_MAX = 7500
const GUIDANCE_CHARS_MAX = 320
const GUIDANCE_TOKENS_MAX = 150

async function mount() {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-overhead-'))
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-overhead-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const tools = new Map()
  const listeners = new Map()
  const ctx = {
    tools: { register: (tool, options) => tools.set(tool.name, { tool, options }) },
    on(event, handler) { listeners.set(event, handler) },
    get: () => undefined,
  }
  apply(ctx, { stateDir, notifyOnComplete: false })
  return {
    tools,
    listeners,
    async cleanup() {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {})
      await fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {})
    },
  }
}

const headerFor = id => ({ id, delegationDepth: 0 })

// The host calls the condition as `when({ agent, modelSelection, signal })`,
// where `agent` carries the session id as `agent.id`. Anything registered under
// a different key (e.g. `active`) is never consulted, so this helper only reads
// `when` — a wrong option name shows up as "still declared" here.
const isDeclared = (entry, sessionId) => {
  const when = entry.options?.when
  if (typeof when !== 'function') return true
  return when({ agent: { id: sessionId }, signal: new AbortController().signal }) !== false
}

const sizeOf = entries => {
  const definitions = entries.map(entry => JSON.stringify({
    name: entry.tool.name,
    description: entry.tool.description,
    parameters: entry.tool.parameters,
  }))
  return {
    chars: definitions.reduce((total, text) => total + text.length, 0),
    tokens: definitions.reduce((total, text) => total + estimate(text), 0),
    names: entries.map(entry => entry.tool.name),
  }
}

test('the declarations a fresh session carries stay under the fixed-overhead cap', async () => {
  const host = await mount()
  try {
    const sessionId = 'session-overhead'
    const all = [...host.tools.values()]
    const declared = all.filter(entry => isDeclared(entry, sessionId))
    const live = sizeOf(declared)
    assert.ok(
      live.chars <= ALWAYS_ON_CHARS_MAX,
      `${declared.length} always-on tool definitions cost ${live.chars} chars, over the ${ALWAYS_ON_CHARS_MAX} cap: `
      + live.names.join(', '),
    )
    assert.ok(
      live.tokens <= ALWAYS_ON_TOKENS_MAX,
      `${declared.length} always-on tool definitions cost ~${live.tokens} tokens, over the ${ALWAYS_ON_TOKENS_MAX} cap`,
    )

    // Backstop: if a host stops consulting `when`, every registered tool is
    // declared again. The whole set is still bounded, so that regression cannot
    // pass unnoticed.
    const every = sizeOf(all)
    assert.ok(
      every.chars <= ALL_TOOLS_CHARS_MAX,
      `all ${all.length} tool definitions cost ${every.chars} chars, over the ${ALL_TOOLS_CHARS_MAX} cap`,
    )
    assert.ok(
      every.tokens <= ALL_TOOLS_TOKENS_MAX,
      `all ${all.length} tool definitions cost ~${every.tokens} tokens, over the ${ALL_TOOLS_TOKENS_MAX} cap`,
    )
  } finally {
    await host.cleanup()
  }
})

test('the guidance notice is injected once per session, not once per turn', async () => {
  const host = await mount()
  try {
    const preStep = host.listeners.get('agent/pre-step')
    assert.equal(typeof preStep, 'function')
    const agent = { session: { header: headerFor('session-guidance') } }
    const empty = { kind: 'proceed', messages: [] }

    const first = await preStep({ agent, step: 1 }, async () => empty)
    assert.equal(first.messages.length, 1)
    assert.equal(first.messages[0].source.kind, 'superagent-guidance')
    const text = first.messages[0].content[0].text
    assert.ok(text.length <= GUIDANCE_CHARS_MAX, `guidance is ${text.length} chars, over the ${GUIDANCE_CHARS_MAX} cap`)
    assert.ok(estimate(text) <= GUIDANCE_TOKENS_MAX, `guidance is ~${estimate(text)} tokens, over the ${GUIDANCE_TOKENS_MAX} cap`)

    // A later turn of the same session must not pay for a second copy.
    const second = await preStep({ agent, step: 1 }, async () => empty)
    assert.equal(second.messages.length, 0, 'the guidance was injected again in a later turn')

    // A different session still gets its own copy.
    const other = await preStep({ agent: { session: { header: headerFor('session-other') } }, step: 1 }, async () => empty)
    assert.equal(other.messages.length, 1)
  } finally {
    await host.cleanup()
  }
})

test('the gated tools stay out of the prompt until superagent_help turns them on', async () => {
  const host = await mount()
  try {
    const sessionId = 'session-expand'
    const gated = ['superagent_goal', 'superagent_schedule', 'superagent_memory', 'superagent_repo_wiki', 'superagent_template', 'superagent_audit', 'superagent_inject']
    for (const name of gated) {
      assert.equal(host.tools.has(name), true, `${name} must still be registered`)
      assert.equal(
        typeof host.tools.get(name).options?.when,
        'function',
        `${name} must use the host's when option; any other key is never consulted`,
      )
      assert.equal(isDeclared(host.tools.get(name), sessionId), false, `${name} must not be declared before help`)
    }

    const help = host.tools.get('superagent_help')
    assert.ok(help, 'superagent_help must be registered')
    const reply = await help.tool.execute({}, {
      agent: { id: sessionId, session: { header: headerFor(sessionId) } },
    })
    for (const name of gated) assert.ok(reply.includes(name), `help must name ${name}`)

    for (const name of gated) {
      assert.equal(isDeclared(host.tools.get(name), sessionId), true, `${name} must be declared after help`)
    }
    // Expanding is per session: another session keeps the lean tool list.
    assert.equal(isDeclared(host.tools.get('superagent_schedule'), 'session-untouched'), false)
  } finally {
    await host.cleanup()
  }
})
