import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createControlPlane } from '../lib/control.js'

/**
 * Start a plane on an ephemeral port with recording actions. The port and
 * token from the discovery file are the only way a real client would find it,
 * so the tests use the same path.
 */
async function startPlane(overrides = {}) {
  const stateRoot = overrides.stateRoot ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-control-'))
  const calls = []
  const actions = {
    async health() {
      calls.push(['health'])
      return { runs: 'GET /runs' }
    },
    async list(query) {
      calls.push(['list', query])
      return { data: { runs: [{ id: 'run-1', status: 'completed' }], stats: null }, text: 'one run' }
    },
    async status(runId, waitSeconds) {
      calls.push(['status', runId, waitSeconds])
      if (runId === 'missing') throw new Error('unknown run missing')
      if (runId === 'owned') throw new Error('run owned is still owned by a live process (pid 1 is still running)')
      if (runId === 'boom') throw new Error('something unexpected happened')
      return { data: { run: { id: runId, status: 'completed' } }, text: `run ${runId} — completed` }
    },
    async start(body) {
      calls.push(['start', body])
      return { data: { run: { id: 'run-new', status: 'queued' } }, text: 'started' }
    },
    async cancel(runId) {
      calls.push(['cancel', runId])
      return { data: { run: { id: runId, status: 'cancelled' } }, text: `cancelled ${runId}` }
    },
    async resume(runId, body) {
      calls.push(['resume', runId, body])
      return { data: { run: { id: runId, status: 'running' } }, text: `resumed ${runId}` }
    },
  }
  const plane = createControlPlane({
    port: 0,
    stateRoot,
    version: '9.9.9-test',
    log: overrides.log ?? (() => {}),
    actions: overrides.actions ? { ...actions, ...overrides.actions } : actions,
  })
  const { port } = await plane.start()
  const discovery = JSON.parse(await fsp.readFile(plane.discoveryPath, 'utf8'))
  return { plane, port, token: discovery.token, discovery, calls, stateRoot }
}

async function call(url, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

/** `fetch` refuses to set Host, so the rebinding check needs a raw request. */
function rawRequest({ port, method = 'GET', path: requestPath = '/health', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the control plane refuses requests without the discovery token', async () => {
  const { plane, port, token, stateRoot } = await startPlane()
  try {
    const anonymous = await call(`http://127.0.0.1:${port}/runs`)
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.ok, false)
    // A transport refusal must not be reported as an unclassified host error:
    // the caller needs to know it is the token, not the run, that is wrong.
    assert.equal(anonymous.json.error.id, 'unauthorized')
    assert.match(anonymous.json.error.hint, /control\.json/)

    const wrong = await call(`http://127.0.0.1:${port}/runs`, { token: `${token}x` })
    assert.equal(wrong.status, 401)

    const ok = await call(`http://127.0.0.1:${port}/runs`, { token })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.text, 'one run')
  } finally {
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a browser-style Host header is rejected even with a valid token', async () => {
  const { plane, port, token, stateRoot } = await startPlane()
  try {
    const rebinding = await rawRequest({
      port,
      headers: { host: `attacker.example:${port}`, authorization: `Bearer ${token}` },
    })
    assert.equal(rebinding.status, 403)
    assert.match(rebinding.text, /unexpected Host header/)
    assert.match(rebinding.text, /"id":"forbidden-host"/)

    const normal = await rawRequest({ port, headers: { authorization: `Bearer ${token}` } })
    assert.equal(normal.status, 200)
  } finally {
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('the discovery file names the bound port and is removed on stop', async () => {
  const { plane, port, discovery, stateRoot } = await startPlane()
  assert.equal(discovery.url, `http://127.0.0.1:${port}`)
  assert.equal(discovery.service, 'dsh-superagent')
  assert.equal(discovery.pid, process.pid)
  // A pid alone cannot tell two planes in one process apart (a host that
  // reloads the plugin), so the file carries a per-plane id.
  assert.match(discovery.instanceId, /^[0-9a-f]{12}$/)
  assert.equal(discovery.token.length, 43)
  assert.equal(plane.url, `http://127.0.0.1:${port}`)
  await plane.stop()
  assert.equal(plane.url, null)
  const remaining = await fsp.readdir(stateRoot).catch(() => [])
  assert.deepEqual(remaining.filter(name => name.startsWith('control.json')), [])
  await fsp.rm(stateRoot, { recursive: true, force: true })
})

test('a plane does not delete a discovery file published by a newer plane', async () => {
  const { plane, discovery, stateRoot } = await startPlane()
  try {
    // Simulate a reload: a second plane in the same process replaced the file.
    await fsp.writeFile(plane.discoveryPath, `${JSON.stringify({ ...discovery, instanceId: 'aaaaaaaaaaaa' })}\n`)
    await plane.stop()
    const current = JSON.parse(await fsp.readFile(plane.discoveryPath, 'utf8'))
    assert.equal(current.instanceId, 'aaaaaaaaaaaa')
  } finally {
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('two starts in one mount share the same listener', async () => {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-control-'))
  const plane = createControlPlane({ port: 0, stateRoot, version: '0.0.0', log: () => {}, actions: {} })
  try {
    const [first, second] = await Promise.all([plane.start(), plane.start()])
    assert.equal(first.port, second.port)
    assert.equal(plane.port, first.port)
  } finally {
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('routes map to the plugin actions and pass their arguments through', async () => {
  const { plane, port, token, calls, stateRoot } = await startPlane()
  const base = `http://127.0.0.1:${port}`
  try {
    const created = await call(`${base}/runs`, {
      token,
      method: 'POST',
      body: { goal: 'compare X and Y', session_id: 'session-1', wait_seconds: 5 },
    })
    assert.equal(created.status, 202)
    assert.deepEqual(calls.at(-1), ['start', { goal: 'compare X and Y', session_id: 'session-1', wait_seconds: 5 }])
    assert.equal(created.json.data.run.id, 'run-new')

    const listed = await call(`${base}/runs?limit=3`, { token })
    assert.equal(listed.status, 200)
    assert.deepEqual(calls.at(-1), ['list', { limit: '3' }])

    const read = await call(`${base}/runs/run-1?wait=30`, { token })
    assert.equal(read.status, 200)
    assert.deepEqual(calls.at(-1), ['status', 'run-1', 30])

    // An absurd wait is capped, so one caller cannot hold a socket for an hour.
    await call(`${base}/runs/run-1?wait=999999`, { token })
    assert.deepEqual(calls.at(-1), ['status', 'run-1', 300])

    const cancelled = await call(`${base}/runs/run-1/cancel`, { token, method: 'POST', body: {} })
    assert.equal(cancelled.status, 200)
    assert.deepEqual(calls.at(-1), ['cancel', 'run-1'])

    const resumed = await call(`${base}/runs/run-1/resume`, {
      token,
      method: 'POST',
      body: { session_id: 'session-1' },
    })
    assert.equal(resumed.status, 202)
    assert.deepEqual(calls.at(-1), ['resume', 'run-1', { session_id: 'session-1' }])

    const health = await call(`${base}/health`, { token })
    assert.equal(health.status, 200)
    assert.equal(health.json.data.runs, 'GET /runs')
    assert.equal(health.json.data.version, '9.9.9-test')

    const index = await call(`${base}/`, { token })
    assert.equal(index.status, 200)
    assert.ok(index.json.data.endpoints.includes('POST /runs/:id/cancel'))
  } finally {
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('errors keep the readable classifier and a matching status code', async () => {
  const { plane, port, token, stateRoot } = await startPlane()
  const base = `http://127.0.0.1:${port}`
  try {
    const missing = await call(`${base}/runs/missing`, { token })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.id, 'unknown-run')
    assert.ok(missing.json.error.hint)

    const owned = await call(`${base}/runs/owned`, { token })
    assert.equal(owned.status, 409)
    assert.equal(owned.json.error.id, 'run-owned')

    const boom = await call(`${base}/runs/boom`, { token })
    assert.equal(boom.status, 500)

    const badJson = await call(`${base}/runs`, { token, method: 'POST', body: '{"goal":' })
    assert.equal(badJson.status, 400)
    assert.match(badJson.json.error.detail, /not a JSON object/)

    const arrayBody = await call(`${base}/runs`, { token, method: 'POST', body: '[]' })
    assert.equal(arrayBody.status, 400)

    const wrongMethod = await call(`${base}/runs/run-1/cancel`, { token })
    assert.equal(wrongMethod.status, 405)

    const unknownPath = await call(`${base}/volumes`, { token })
    assert.equal(unknownPath.status, 404)

    // `/health` is a single route, not a prefix.
    const healthChild = await call(`${base}/health/anything`, { token })
    assert.equal(healthChild.status, 404)

    // A bad escape is the caller's mistake; it must not surface as a 500.
    const badEncoding = await call(`${base}/runs/%zz`, { token })
    assert.equal(badEncoding.status, 400)
    assert.equal(badEncoding.json.error.id, 'bad-run-id')
  } finally {
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('an oversized body is refused with 413 instead of being buffered', async () => {
  const { plane, port, token, stateRoot } = await startPlane({
    actions: {
      async start() {
        assert.fail('an oversized body must never reach the action')
      },
    },
  })
  try {
    const response = await call(`http://127.0.0.1:${port}/runs`, {
      token,
      method: 'POST',
      body: JSON.stringify({ goal: 'x'.repeat(80 * 1024) }),
    })
    assert.equal(response.status, 413)
    assert.equal(response.json.ok, false)
  } finally {
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a stop that races a start never leaves a listener or a discovery file', async () => {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-control-'))
  const plane = createControlPlane({
    port: 0,
    stateRoot,
    version: '0.0.0',
    log: () => {},
    actions: {},
  })
  try {
    const starting = plane.start()
    const stopping = plane.stop()
    const results = await Promise.allSettled([starting, stopping])
    // Whatever the ordering, the end state is the same: not listening, nothing
    // published. A dispose during mount must not leave an orphaned socket.
    assert.equal(plane.url, null)
    assert.deepEqual((await fsp.readdir(stateRoot)).filter(name => name.startsWith('control')), [])
    assert.equal(results[1].status, 'fulfilled')
  } finally {
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('a plane stopped before it started refuses to bind', async () => {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-control-'))
  const plane = createControlPlane({ port: 0, stateRoot, version: '0.0.0', log: () => {}, actions: {} })
  try {
    await plane.stop()
    await assert.rejects(plane.start(), /has been stopped/)
    assert.deepEqual((await fsp.readdir(stateRoot)).filter(name => name.startsWith('control')), [])
  } finally {
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})

test('stop is idempotent and a failed start leaves no discovery file', async () => {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-control-'))
  const blocker = http.createServer((_req, res) => res.end())
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const port = blocker.address().port
  const plane = createControlPlane({
    port,
    stateRoot,
    version: '0.0.0',
    log: () => {},
    actions: {},
  })
  try {
    await assert.rejects(plane.start(), /EADDRINUSE/)
    assert.deepEqual(await fsp.readdir(stateRoot), [])
  } finally {
    await new Promise(resolve => blocker.close(resolve))
    await plane.stop()
    await plane.stop()
    await fsp.rm(stateRoot, { recursive: true, force: true })
  }
})
