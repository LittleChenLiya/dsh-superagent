import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createConsole } from '../lib/console.js'
import {
  createWizard,
  credentialRefFor,
  maskKey,
  mergeWizardPatch,
  readDefaultModel,
  readProviderRoute,
} from '../lib/wizard.js'

const SECRET = 'sk-wizard-test-1234567890'

async function fixture(patch = '') {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-wizard-'))
  const profileDir = path.join(base, 'profiles', 'web')
  const stateRoot = path.join(base, 'state', 'superagent')
  await fsp.mkdir(profileDir, { recursive: true })
  await fsp.mkdir(stateRoot, { recursive: true })
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (patch) await fsp.writeFile(patchPath, patch, 'utf8')
  return {
    base,
    profileDir,
    stateRoot,
    patchPath,
    profile: { name: 'web', dir: profileDir, patchPath, home: base },
  }
}

function fakeCredentials(seed = {}) {
  const values = new Map(Object.entries(seed))
  return {
    values,
    set: async (ref, value) => { values.set(ref, value) },
    unset: async ref => { values.delete(ref) },
    resolve: async ref => (values.has(ref) ? { value: values.get(ref), source: 'file' } : null),
    describe: async ref => (values.has(ref)
      ? { configured: true, writable: true, source: 'file' }
      : { configured: false, writable: true, source: null }),
  }
}

function startProbeServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise(done => server.close(done)),
      })
    })
  })
}

function modelsHandler(models = ['gpt-6.1-sol'], key = SECRET) {
  return (request, response) => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'bad key' } }))
      return
    }
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: models.map(id => ({ id })) }))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  }
}

async function closedPort() {
  const probe = await startProbeServer((_request, response) => response.end('{}'))
  const baseURL = probe.baseURL
  await probe.close()
  return baseURL
}

function wizardFor(fixtureData, credentials, extra = {}) {
  return createWizard({
    stateRoot: fixtureData.stateRoot,
    version: '0.13.0-test',
    getProfile: () => fixtureData.profile,
    getCredentials: () => credentials,
    getDefaultModel: () => null,
    getSessionController: () => null,
    listTools: async () => [{ name: 'bash' }, { name: 'read' }, { name: 'superagent_start' }],
    log: () => {},
    ...extra,
  })
}

test('mergeWizardPatch preserves unrelated entries and comments', () => {
  const original = [
    '# keep this comment',
    '- id: some-other-plugin',
    '  config:',
    '    keep: true',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: old',
    '    model: old-model',
    '',
  ].join('\n')
  const merged = mergeWizardPatch(original, {
    provider: 'haoduo',
    baseURL: 'https://byte.haoduotoken.com/v1',
    model: 'gpt-6.1-sol',
  })
  assert.match(merged.text, /# keep this comment/)
  assert.match(merged.text, /- id: some-other-plugin/)
  assert.match(merged.text, /keep: true/)
  assert.match(merged.text, /- id: llm-pi-ai/)
  assert.equal(readDefaultModel(merged.text).provider, 'haoduo')
  assert.equal(readDefaultModel(merged.text).model, 'gpt-6.1-sol')
  assert.deepEqual(readProviderRoute(merged.text, 'haoduo'), {
    baseURL: 'https://byte.haoduotoken.com/v1',
    models: ['gpt-6.1-sol'],
  })
  assert.ok(merged.summary.some(line => line.includes('默认模型从 old/old-model 改为 haoduo/gpt-6.1-sol')))
  assert.ok(merged.summary.some(line => line.includes('密钥写入宿主凭据库')))
})

test('mergeWizardPatch adds the model to an existing provider without dropping fields', () => {
  const original = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      haoduo:',
    '        apiKeyEnv: HAODUO_API_KEY',
    '        displayName: Haoduo',
    '        api: openai-completions',
    '        baseURL: https://old.example/v1',
    '        models:',
    '          - id: old-model',
    '            contextWindow: 128000',
    '',
  ].join('\n')
  const merged = mergeWizardPatch(original, {
    provider: 'haoduo',
    baseURL: 'https://new.example/v1',
    model: 'new-model',
  })
  assert.match(merged.text, /displayName: Haoduo/)
  assert.match(merged.text, /contextWindow: 128000/)
  assert.match(merged.text, /- id: old-model/)
  assert.match(merged.text, /- id: new-model/)
  assert.match(merged.text, /baseURL: "https:\/\/new\.example\/v1"/)
  assert.deepEqual(readProviderRoute(merged.text, 'haoduo').models, ['old-model', 'new-model'])
})

test('mask and credential reference never expose the value', () => {
  assert.equal(credentialRefFor('haoduo'), 'HAODUO_API_KEY')
  assert.equal(credentialRefFor('My Gateway'), 'MY_GATEWAY_API_KEY')
  const masked = maskKey(SECRET)
  assert.notEqual(masked, SECRET)
  assert.ok(!masked.includes(SECRET))
  assert.equal(maskKey('short'), '••••')
})

test('preview rejects a wrong key with a plain-language hint and no secret', async () => {
  const data = await fixture('- id: agent-default-model\n  config:\n    provider: haoduo\n    model: gpt-6.1-sol\n')
  const credentials = fakeCredentials()
  const server = await startProbeServer(modelsHandler())
  try {
    const wizard = wizardFor(data, credentials)
    await assert.rejects(
      wizard.preview({ provider: 'haoduo', baseURL: server.baseURL, model: 'gpt-6.1-sol', apiKey: 'wrong-key' }),
      error => {
        assert.equal(error.id, 'key-rejected')
        assert.match(error.message, /API key/)
        assert.ok(error.hint)
        assert.ok(!error.message.includes('wrong-key'))
        assert.ok(!String(error.hint).includes('wrong-key'))
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('preview reports a missing model with available examples', async () => {
  const data = await fixture('')
  const credentials = fakeCredentials()
  const server = await startProbeServer(modelsHandler(['model-a', 'model-b']))
  try {
    const wizard = wizardFor(data, credentials)
    await assert.rejects(
      wizard.preview({ provider: 'haoduo', baseURL: server.baseURL, model: 'nope', apiKey: SECRET }),
      error => {
        assert.equal(error.id, 'model-missing')
        assert.match(error.message, /nope/)
        assert.match(error.hint, /model-a/)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('preview reports an unreachable baseURL as a Chinese message', async () => {
  const data = await fixture('')
  const wizard = wizardFor(data, fakeCredentials())
  const baseURL = await closedPort()
  await assert.rejects(
    wizard.preview({ provider: 'haoduo', baseURL, model: 'gpt-6.1-sol', apiKey: SECRET }),
    error => {
      assert.equal(error.id, 'base-unreachable')
      assert.match(error.message, /拒绝|连不上/)
      assert.ok(error.hint)
      return true
    },
  )
})

test('save writes the credential, merges the patch, and rollback restores it', async () => {
  const original = [
    '# profile patch',
    '- id: other',
    '  config:',
    '    keep: 1',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: old',
    '    model: old-model',
    '',
  ].join('\n')
  const data = await fixture(original)
  const credentials = fakeCredentials()
  const server = await startProbeServer(modelsHandler())
  try {
    const wizard = wizardFor(data, credentials)
    const preview = await wizard.preview({
      provider: 'haoduo',
      baseURL: server.baseURL,
      model: 'gpt-6.1-sol',
      apiKey: SECRET,
    })
    assert.ok(preview.summary.length > 0)
    assert.equal(preview.key.verified, true)
    assert.equal(preview.key.mask, maskKey(SECRET))
    assert.ok(!JSON.stringify(preview).includes(SECRET))
    assert.equal(await fsp.readFile(data.patchPath, 'utf8'), original)

    const saved = await wizard.save({
      provider: 'haoduo',
      baseURL: server.baseURL,
      model: 'gpt-6.1-sol',
      apiKey: SECRET,
    })
    assert.equal(saved.saved, true)
    assert.ok(saved.backup?.id)
    assert.equal(credentials.values.get('HAODUO_API_KEY'), SECRET)
    assert.ok(!JSON.stringify(saved).includes(SECRET))

    const written = await fsp.readFile(data.patchPath, 'utf8')
    assert.match(written, /# profile patch/)
    assert.match(written, /keep: 1/)
    assert.match(written, /apiKeyEnv: HAODUO_API_KEY/)
    assert.match(written, /- id: gpt-6\.1-sol/)
    assert.ok(!written.includes(SECRET))
    assert.equal(readDefaultModel(written).provider, 'haoduo')

    const meta = await fsp.readFile(path.join(data.stateRoot, 'wizard.json'), 'utf8')
    assert.ok(!meta.includes(SECRET))

    const status = await wizard.status({ sessionId: 's1' })
    assert.equal(status.needsSetup, false)
    assert.equal(status.key.configured, true)
    assert.equal(status.key.verified, true)
    assert.equal(status.key.mask, maskKey(SECRET))
    assert.ok(!JSON.stringify(status).includes(SECRET))
    assert.ok(status.environment.find(item => item.id === 'tools').ok)

    const rolled = await wizard.rollback(saved.backup.id)
    assert.equal(rolled.restored, true)
    assert.equal(await fsp.readFile(data.patchPath, 'utf8'), original)
  } finally {
    await server.close()
  }
})

test('trial runs in a temp directory and reports subtasks, tokens, and cost', async () => {
  const data = await fixture('')
  const credentials = fakeCredentials()
  const server = await startProbeServer(modelsHandler())
  const usage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }
  let trialCwd = null
  const queue = []
  let wake = null
  const push = event => {
    queue.push(event)
    const next = wake
    wake = null
    next?.()
  }
  const session = {
    create: async options => {
      trialCwd = options.cwd
      return { sessionId: 'trial-session' }
    },
    prompt: async () => {
      await fsp.writeFile(path.join(trialCwd, 'wizard-trial.txt'), 'ok')
      push({ type: 'turn/start', data: {} })
      push({ type: 'tool/call', data: { callId: 'call-1', name: 'write', arguments: { path: 'wizard-trial.txt' } } })
      push({ type: 'tool/result', data: { callId: 'call-1', message: { content: [{ type: 'text', text: 'written' }] } } })
      push({
        type: 'assistant/message',
        data: {
          message: {
            content: [{ type: 'text', text: '已完成' }],
            source: { kind: 'model', provider: 'haoduo', model: 'gpt-6.1-sol' },
          },
          usage,
        },
      })
      push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      push(null)
    },
    follow: async function* () {
      for (;;) {
        if (queue.length === 0) await new Promise(resolve => { wake = resolve })
        const next = queue.shift()
        if (next === null) return
        yield { type: 'event', event: next }
      }
    },
  }
  try {
    const wizard = wizardFor(data, credentials, {
      getSessionController: () => session,
      pricing: { 'haoduo/gpt-6.1-sol': { input: 2, output: 10, currency: 'CNY' } },
    })
    const result = await wizard.trial()
    assert.equal(result.ok, true)
    assert.equal(result.file.verified, true)
    assert.equal(result.file.bytes, 2)
    assert.equal(result.usage.totalTokens, 1500)
    assert.equal(result.usage.modelCalls, 1)
    assert.equal(result.subtasks.length, 1)
    assert.equal(result.subtasks[0].status, 'completed')
    assert.equal(result.subtasks[0].title, 'write')
    assert.equal(result.cost.text, '¥0.0070')
    assert.ok(trialCwd.startsWith(os.tmpdir()))
    await assert.rejects(fsp.stat(trialCwd), error => error.code === 'ENOENT')

    const status = await wizard.status({ sessionId: 'trial-session' })
    assert.equal(status.lastTrial.ok, true)
    assert.equal(status.lastTrial.tokens, 1500)
  } finally {
    await server.close()
  }
})

test('wizard routes require the console token and delegate to the host', async () => {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-wizard-route-'))
  const calls = []
  const panel = createConsole({
    port: 0,
    stateRoot,
    version: 'test',
    log: () => {},
    host: {
      capabilities: () => ({ chat: false, reason: 'test' }),
      wizardStatus: async options => ({ needsSetup: true, options }),
      wizardPreview: async body => ({ summary: ['ok'], body }),
      wizardTrial: async () => ({ ok: true, subtasks: [] }),
    },
  })
  await panel.start()
  try {
    const unauthorized = await fetch(`${panel.url}/api/console/wizard/status`)
    assert.equal(unauthorized.status, 401)

    const headers = { authorization: `Bearer ${panel.token}`, 'content-type': 'application/json' }
    const status = await fetch(`${panel.url}/api/console/wizard/status?probe=1`, { headers })
    assert.equal(status.status, 200)
    const statusJson = await status.json()
    assert.equal(statusJson.data.needsSetup, true)
    assert.equal(statusJson.data.options.probe, true)

    const preview = await fetch(`${panel.url}/api/console/wizard/preview`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'x' }),
    })
    assert.equal(preview.status, 200)
    assert.equal((await preview.json()).data.body.provider, 'x')

    const trial = await fetch(`${panel.url}/api/console/wizard/trial`, { method: 'POST', headers })
    assert.equal(trial.status, 200)
    assert.equal((await trial.json()).data.ok, true)
    calls.push('done')
    assert.deepEqual(calls, ['done'])
  } finally {
    await panel.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})
