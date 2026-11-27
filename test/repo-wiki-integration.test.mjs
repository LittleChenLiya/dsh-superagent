import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { createConsole } from '../lib/console.js'

async function mount(options = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-repo-wiki-'))
  const tools = new Map()
  const prompts = []
  const ctx = {
    tools: { register: (tool, registration) => tools.set(tool.name, { tool, registration }) },
    subagents: {
      async startActivation(spec) {
        prompts.push(spec)
        const text = spec.label === 'superagent-plan'
          ? JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] })
          : 'done'
        return {
          childId: `child-${spec.label}`,
          result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    },
    get: () => undefined,
  }
  apply(ctx, { stateDir, notifyOnComplete: false, ...options })
  return { stateDir, tools, prompts, cleanup: () => fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
}

test('superagent_repo_wiki generates, queries and reads source-backed ontology', async () => {
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-repo-fixture-'))
  const host = await mount()
  try {
    await fsp.mkdir(path.join(project, 'src'), { recursive: true })
    await fsp.mkdir(path.join(project, 'lib'), { recursive: true })
    await fsp.writeFile(path.join(project, 'package.json'), JSON.stringify({
      name: 'ontology-fixture', version: '1.0.0', description: 'Repository ontology fixture',
      scripts: { test: 'node --test', build: 'node build.js' },
      dependencies: { left: '1.0.0' },
    }, null, 2))
    await fsp.writeFile(path.join(project, 'README.md'), '# Ontology Fixture\n\nA small repository for ontology tests.\n')
    await fsp.writeFile(path.join(project, 'src', 'index.js'), "import { helper } from '../lib/helper.js'\nexport const value = helper()\n")
    await fsp.writeFile(path.join(project, 'lib', 'helper.js'), 'export function helper() { return 1 }\n')

    const tool = host.tools.get('superagent_repo_wiki').tool
    const exec = { agent: { id: 'repo-session', session: { cwd: project } } }
    const generated = JSON.parse(await tool.execute({ action: 'generate' }, exec))
    assert.equal(generated.projectPath.toLowerCase(), (await fsp.realpath(project)).toLowerCase())
    assert.ok(generated.stats.modules >= 2)
    assert.ok(generated.stats.files >= 4)

    const queried = JSON.parse(await tool.execute({ action: 'query', query: 'helper architecture' }, exec))
    assert.ok(queried.matches.length > 0)
    assert.ok(queried.matches.some(match => match.sources?.some(source => source.path === 'lib/helper.js')))

    const card = JSON.parse(await tool.execute({ action: 'read', path: '/src/overview' }, exec))
    assert.equal(card.cardType, 'overview')
    assert.match(card.body, /src|模块|源码/)
    assert.ok(card.sources?.some(source => source.path === 'src/index.js'))

    const started = await host.tools.get('superagent_start').tool.execute(
      { goal: 'explain the helper module', mode: 'direct', wait_seconds: 10 }, exec,
    )
    assert.match(started, /done/)
    assert.match(JSON.stringify(host.prompts), /ontology-fixture|lib\/helper\.js/)
  } finally {
    await host.cleanup()
    await fsp.rm(project, { recursive: true, force: true })
  }
})

test('repository ontology can be disabled without removing the rest of the plugin', async () => {
  const host = await mount({ repoWiki: { enabled: false } })
  try {
    const tool = host.tools.get('superagent_repo_wiki').tool
    const reply = await tool.execute({ action: 'status', project_path: process.cwd() }, { agent: { id: 'session' } })
    assert.match(reply, /未启用/)
  } finally {
    await host.cleanup()
  }
})

test('the console exposes repository ontology reads and guarded mutations', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-repo-console-'))
  const calls = []
  const host = {
    capabilities: () => ({ chat: true, reason: null }),
    authorizeConsoleAction: async () => true,
    repoWiki: async (action, payload) => {
      calls.push({ action, payload })
      return { action, projectPath: payload.projectPath }
    },
  }
  const panel = createConsole({ port: 0, stateRoot: stateDir, host, version: 'test', log: () => {} })
  await panel.start()
  try {
    const read = await fetch(`${panel.url}/api/console/repo-wiki?action=query&project=D%3A%5Crepo&query=router`, {
      headers: { authorization: `Bearer ${panel.token}` },
    })
    assert.equal(read.status, 200)
    assert.deepEqual(await read.json(), { ok: true, data: { action: 'query', projectPath: 'D:\\repo' } })

    const generated = await fetch(`${panel.url}/api/console/repo-wiki`, {
      method: 'POST',
      headers: { authorization: `Bearer ${panel.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'generate', projectPath: 'D:\\repo', force: true }),
    })
    assert.equal(generated.status, 200)
    assert.equal((await generated.json()).data.action, 'generate')
    assert.deepEqual(calls.map(call => call.action), ['query', 'generate'])
  } finally {
    await panel.stop()
    await fsp.rm(stateDir, { recursive: true, force: true })
  }
})
