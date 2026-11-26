import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  CloudWorkerError,
  createRemoteWorkerProvider,
  createWorkSpec,
  redactSensitiveText,
  redactSensitiveValue,
  verifyArtifactManifest,
} from '../lib/cloud-worker.js'

const TOKEN = 'short-lived-test-token'
const LEASE = { id: 'lease-1', fencingToken: 7, expiresAt: '2026-11-26T12:05:00.000Z' }
const NOW = '2026-11-26T12:00:00.000Z'

function workSpec(overrides = {}) {
  return {
    run: { id: 'run-1' },
    subtask: { id: 'subtask-1' },
    attempt: 1,
    repoSnapshot: { provider: 'git', ref: 'snapshot-abc', commit: 'a'.repeat(40) },
    prompt: 'Implement the remote worker protocol.',
    model: { provider: 'test-model', ref: 'model-v1' },
    toolScope: { allow: ['read_file', 'write_file'], deny: ['shell'] },
    approvalScope: { mode: 'manual', scopes: ['network'] },
    budget: { maxTokens: 20_000, maxCostUsd: 1.5, maxWallSeconds: 300, maxToolCalls: 20 },
    deadline: '2026-11-26T12:10:00.000Z',
    checkpoint: { ref: 'checkpoint-1', cursor: 0 },
    secrets: { refs: [{ provider: 'vault', ref: 'secret/github-readonly' }] },
    ...overrides,
  }
}

function submission(overrides = {}) {
  return {
    workerId: 'worker-1',
    state: 'queued',
    leaseId: LEASE.id,
    fencingToken: LEASE.fencingToken,
    leaseExpiresAt: LEASE.expiresAt,
    ...overrides,
  }
}

function reattachment(overrides = {}) {
  return {
    workerId: 'worker-1',
    state: 'running',
    leaseId: 'lease-2',
    fencingToken: 8,
    leaseExpiresAt: '2026-11-26T12:10:00.000Z',
    nextCursor: 4,
    ...overrides,
  }
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function setup(handler, options = {}) {
  const calls = []
  const provider = createRemoteWorkerProvider({
    baseUrl: 'https://worker.invalid/api',
    timeoutMs: 500,
    retryBaseMs: 0,
    retryMaxMs: 0,
    now: () => Date.parse(NOW),
    fetchImpl: async (url, init) => {
      const call = {
        url: String(url),
        method: init.method,
        headers: new Headers(init.headers),
        body: init.body ? JSON.parse(init.body) : undefined,
        signal: init.signal,
        index: calls.length,
      }
      calls.push(call)
      return handler(call, calls.length - 1)
    },
    ...options,
  })
  return { provider, calls }
}

function leaseOptions(overrides = {}) {
  return { lease: LEASE, ...overrides }
}

function artifact(content = 'verified artifact\n') {
  const bytes = Buffer.from(content)
  return {
    path: 'dist/report.txt',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    encoding: 'base64',
    content: bytes.toString('base64'),
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

function hangingFetch(call) {
  return new Promise((resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(call.signal.reason ?? new DOMException('Aborted', 'AbortError')), { once: true })
  })
}

test('WorkSpec is a frozen JSON document and rejects live objects and credential values', () => {
  const spec = createWorkSpec(workSpec())
  assert.equal(Object.isFrozen(spec), true)
  assert.equal(Object.isFrozen(spec.toolScope.allow), true)
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), workSpec())
  assert.throws(() => createWorkSpec(workSpec({ prompt: () => 'live prompt' })), { code: 'CLOUD_WORKER_INVALID_SPEC' })
  assert.throws(() => createWorkSpec(workSpec({ metadata: { run: () => {} } })), { code: 'CLOUD_WORKER_UNSERIALIZABLE' })
  class LiveAgent { run() {} }
  assert.throws(() => createWorkSpec(workSpec({ liveAgent: new LiveAgent() })), { code: 'CLOUD_WORKER_UNSERIALIZABLE' })
  assert.throws(() => createWorkSpec(workSpec({ secrets: { refs: [], token: TOKEN } })), { code: 'CLOUD_WORKER_SECRET_VALUE' })
  assert.throws(() => createWorkSpec(workSpec({ metadata: { authToken: TOKEN } })), { code: 'CLOUD_WORKER_SECRET_VALUE' })
  assert.throws(() => createWorkSpec(workSpec({ attempt: 0 })), { code: 'CLOUD_WORKER_INVALID_SPEC' })
  const cyclic = workSpec()
  cyclic.checkpoint.self = cyclic.checkpoint
  assert.throws(() => createWorkSpec(cyclic), { code: 'CLOUD_WORKER_UNSERIALIZABLE' })
})

test('capabilities describe reattach, cursor events, SHA-256 artifacts, and asynchronous cancellation without I/O', () => {
  const { provider, calls } = setup(() => { throw new Error('must not fetch') })
  assert.ok(provider.capabilities.operations.includes('reattach'))
  assert.equal(provider.capabilities.eventDelivery, 'cursor')
  assert.equal(provider.capabilities.artifactDigest, 'sha256')
  assert.equal(provider.capabilities.cancellation, 'asynchronous')
  assert.equal(calls.length, 0)
})

test('submit is idempotent across retries and repeated calls with the same key', async () => {
  const accepted = new Map()
  const { provider, calls } = setup((call) => {
    if (call.method !== 'POST' || !call.url.endsWith('/v1/workers')) throw new Error('unexpected request')
    const key = call.headers.get('Idempotency-Key')
    if (!accepted.has(key)) {
      accepted.set(key, call.body)
      return response({ code: 'TEMPORARY' }, 503)
    }
    assert.deepEqual(accepted.get(key), call.body)
    return response(submission({ state: 'running' }))
  }, { credentials: { token: TOKEN } })
  const options = { idempotencyKey: 'submit-stable-key' }
  const first = await provider.submit(workSpec(), options)
  const second = await provider.submit(workSpec(), options)
  assert.equal(first.workerId, 'worker-1')
  assert.equal(second.workerId, first.workerId)
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.headers.get('Idempotency-Key') === 'submit-stable-key'))
  assert.deepEqual(calls[0].body, calls[2].body)
  assert.ok(calls.every(call => call.headers.get('Authorization') === `Bearer ${TOKEN}`))
  assert.equal(calls[0].body.workSpec.prompt, workSpec().prompt)
  assert.equal(calls[0].body.workSpec.secrets.refs[0].ref, 'secret/github-readonly')
})

test('default submit idempotency key is stable for run/subtask/attempt', async () => {
  const { provider, calls } = setup(() => response(submission()))
  await provider.submit(workSpec())
  await provider.submit(workSpec())
  assert.equal(calls[0].headers.get('Idempotency-Key'), 'dsh:run-1:subtask-1:1')
  assert.equal(calls[1].headers.get('Idempotency-Key'), calls[0].headers.get('Idempotency-Key'))
})

test('no credentials means no Authorization header, while provider secret references still travel', async () => {
  const { provider, calls } = setup(() => response(submission()), { credentials: async () => null })
  await provider.submit(workSpec())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.has('Authorization'), false)
  assert.deepEqual(calls[0].body.workSpec.secrets.refs, [{ provider: 'vault', ref: 'secret/github-readonly' }])
  assert.equal(JSON.stringify(calls[0].body).includes(TOKEN), false)
})

test('401 and 403 fail immediately without retries or leaking credentials into errors/logs', async (t) => {
  for (const status of [401, 403]) {
    await t.test(`HTTP ${status}`, async () => {
      const logs = []
      const { provider, calls } = setup(() => response({
        code: 'AUTH_DENIED',
        message: `denied Bearer ${TOKEN}; retry token=${TOKEN}`,
      }, status), {
        credentials: () => ({ token: TOKEN }),
        logger: (entry) => logs.push(entry),
      })
      await assert.rejects(provider.submit(workSpec()), error => {
        assert.ok(error instanceof CloudWorkerError)
        assert.equal(error.code, status === 401 ? 'CLOUD_WORKER_UNAUTHORIZED' : 'CLOUD_WORKER_FORBIDDEN')
        assert.equal(error.status, status)
        assert.equal(error.retryable, false)
        assert.equal(String(error).includes(TOKEN), false)
        return true
      })
      assert.equal(calls.length, 1)
      assert.equal(JSON.stringify(logs).includes(TOKEN), false)
      assert.ok(logs.every(entry => !('headers' in entry)))
    })
  }
})

test('429 honors Retry-After and retries; exhausted 5xx reports a retryable typed error', async () => {
  const rateLimited = setup((call) => call.index === 0
    ? response({ code: 'BUSY' }, 429, { 'Retry-After': '0.03' })
    : response(submission()))
  const started = Date.now()
  await rateLimited.provider.submit(workSpec())
  assert.equal(rateLimited.calls.length, 2)
  assert.ok(Date.now() - started >= 20, 'Retry-After must delay the retry')

  const unavailable = setup(() => response({ code: 'DOWN' }, 500), { maxRetries: 1 })
  await assert.rejects(unavailable.provider.submit(workSpec()), {
    code: 'CLOUD_WORKER_HTTP', status: 500, retryable: true,
  })
  assert.equal(unavailable.calls.length, 2)
})

test('AbortSignal cancels in-flight requests and timeout produces CLOUD_WORKER_TIMEOUT', async () => {
  const controller = new AbortController()
  const entered = deferred()
  const aborted = setup((call) => {
    entered.resolve()
    return hangingFetch(call)
  })
  const pending = aborted.provider.submit(workSpec(), { signal: controller.signal })
  await entered.promise
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })

  const timeout = setup(hangingFetch, { timeoutMs: 10, maxRetries: 0 })
  await assert.rejects(timeout.provider.submit(workSpec()), { code: 'CLOUD_WORKER_TIMEOUT' })
  assert.equal(timeout.calls.length, 1)
})

test('events reconnect after a dropped connection and resume from the last committed cursor', async () => {
  const { provider, calls } = setup((call) => {
    if (call.index === 0) throw new TypeError('socket closed')
    if (call.url.endsWith('cursor=3')) return response({
      workerId: 'worker-1', fencingToken: 7,
      events: [
        { sequence: 4, type: 'progress', cursor: 3 },
        { sequence: 5, type: 'progress' },
      ],
      nextCursor: 5, hasMore: true, state: 'running',
    })
    assert.ok(call.url.endsWith('cursor=5'))
    return response({
      workerId: 'worker-1', fencingToken: 7,
      events: [{ sequence: 6, type: 'completed' }],
      nextCursor: 6, hasMore: false, state: 'succeeded',
    })
  }, { maxRetries: 0, eventMaxReconnects: 2, pollIntervalMs: 0 })
  const events = await collect(provider.events('worker-1', leaseOptions({ cursor: 3 })))
  assert.deepEqual(events.map(event => [event.sequence, event.cursor]), [[4, 4], [5, 5], [6, 6]])
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('cursor')), ['3', '3', '5'])
  assert.ok(calls.every(call => call.headers.get('X-Worker-Lease-Id') === LEASE.id))
  assert.ok(calls.every(call => call.headers.get('X-Worker-Fencing-Token') === '7'))
})

test('events reject duplicate/backward cursors and propagate non-retryable authentication errors', async () => {
  const invalid = setup(() => response({
    events: [{ sequence: 2 }], nextCursor: 1, hasMore: true, state: 'running',
  }))
  await assert.rejects(collect(invalid.provider.events('worker-1', leaseOptions({ cursor: 2 }))), { code: 'CLOUD_WORKER_EVENT_CURSOR' })
  assert.equal(invalid.calls.length, 1)

  const forbidden = setup(() => response({ code: 'DENIED' }, 403))
  await assert.rejects(collect(forbidden.provider.events('worker-1', leaseOptions())), { code: 'CLOUD_WORKER_FORBIDDEN' })
  assert.equal(forbidden.calls.length, 1)
})

test('close disconnects subscriptions without cancelling the remote worker', async () => {
  const firstCall = deferred()
  const { provider, calls } = setup((call) => {
    firstCall.resolve()
    return response({ events: [], nextCursor: 0, hasMore: false, state: 'running' })
  }, { pollIntervalMs: 60_000 })
  const iterator = provider.events('worker-1', leaseOptions())[Symbol.asyncIterator]()
  const next = iterator.next()
  await firstCall.promise
  provider.close()
  provider.close()
  assert.deepEqual(await next, { value: undefined, done: true })
  assert.equal(calls.length, 1)
  assert.ok(calls.every(call => call.method === 'GET'))
  await assert.rejects(provider.snapshot('worker-1', leaseOptions()), { code: 'CLOUD_WORKER_CLOSED' })
})

test('reattach renews a lease with cursor and lease headers and normalizes either expiry field', async () => {
  const renewedLease = { id: 'lease-2', fencingToken: 8, expiresAt: '2026-11-26T12:10:00.000Z' }
  const { provider, calls } = setup((call) => {
    assert.equal(call.url, 'https://worker.invalid/api/v1/workers/worker-1/reattach')
    assert.equal(call.method, 'POST')
    assert.equal(call.headers.get('Content-Type'), 'application/json')
    if (call.index === 0) {
      assert.deepEqual(call.body, { cursor: 3 })
      assert.equal(call.headers.get('X-Worker-Lease-Id'), LEASE.id)
      assert.equal(call.headers.get('X-Worker-Fencing-Token'), String(LEASE.fencingToken))
      return response(reattachment())
    }
    assert.deepEqual(call.body, { cursor: 4 })
    assert.equal(call.headers.get('X-Worker-Lease-Id'), renewedLease.id)
    assert.equal(call.headers.get('X-Worker-Fencing-Token'), String(renewedLease.fencingToken))
    const { leaseExpiresAt, ...payload } = reattachment({ nextCursor: 4 })
    return response({ ...payload, lease: { expiresAt: leaseExpiresAt } })
  }, { credentials: { token: TOKEN } })

  const first = await provider.reattach('worker-1', leaseOptions({ cursor: 3 }))
  assert.deepEqual(first, {
    workerId: 'worker-1',
    state: 'running',
    lease: renewedLease,
    leaseId: renewedLease.id,
    fencingToken: renewedLease.fencingToken,
    leaseExpiresAt: renewedLease.expiresAt,
    nextCursor: 4,
  })
  const second = await provider.reattach('worker-1', { lease: first.lease, cursor: first.nextCursor })
  assert.deepEqual(second, first)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.headers.get('Authorization') === `Bearer ${TOKEN}`))
})

test('reattach defaults to cursor zero and rejects invalid cursors without I/O', async () => {
  const valid = setup(() => response(reattachment({ nextCursor: 0 })))
  assert.equal((await valid.provider.reattach('worker-1', leaseOptions())).nextCursor, 0)
  assert.deepEqual(valid.calls[0].body, { cursor: 0 })

  const invalid = setup(() => { throw new Error('must not fetch') })
  for (const cursor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    await assert.rejects(invalid.provider.reattach('worker-1', leaseOptions({ cursor })), {
      code: 'CLOUD_WORKER_INVALID_CURSOR',
    })
  }
  assert.equal(invalid.calls.length, 0)
})

test('reattach rejects missing, invalid, or regressing nextCursor responses', async () => {
  for (const nextCursor of [undefined, 2, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, '4']) {
    const { provider, calls } = setup(() => response(reattachment({ nextCursor })))
    await assert.rejects(provider.reattach('worker-1', leaseOptions({ cursor: 3 })), {
      code: 'CLOUD_WORKER_EVENT_CURSOR',
    })
    assert.equal(calls.length, 1)
  }
})

test('reattach rejects a missing or mismatched workerId and invalid state', async () => {
  for (const overrides of [{ workerId: 'worker-2' }, { workerId: undefined }, { state: 'unknown' }, { state: undefined }]) {
    const { provider } = setup(() => response(reattachment(overrides)))
    await assert.rejects(provider.reattach('worker-1', leaseOptions()), { code: 'CLOUD_WORKER_PROTOCOL' })
  }
})

test('reattach rejects stale request and response fencing tokens', async () => {
  const { provider, calls } = setup((call) => response(reattachment({
    fencingToken: call.index === 0 ? 8 : 7,
  })))
  await provider.reattach('worker-1', leaseOptions())
  await assert.rejects(provider.reattach('worker-1', leaseOptions()), { code: 'CLOUD_WORKER_STALE_FENCE' })
  assert.equal(calls.length, 1)
  const currentLease = { ...LEASE, fencingToken: 8 }
  await assert.rejects(provider.reattach('worker-1', { lease: currentLease }), { code: 'CLOUD_WORKER_STALE_FENCE' })
  assert.equal(calls.length, 2)
})

test('reattach requires leaseId and a valid lease expiry instead of returning a partial lease', async () => {
  const missingId = reattachment()
  delete missingId.leaseId
  const missingExpiry = reattachment()
  delete missingExpiry.leaseExpiresAt
  const invalidExpiry = reattachment({ leaseExpiresAt: 'not-a-timestamp' })
  const numericExpiry = reattachment({ leaseExpiresAt: Date.parse(NOW) })
  for (const payload of [missingId, missingExpiry, invalidExpiry, numericExpiry]) {
    const { provider } = setup(() => response(payload))
    await assert.rejects(provider.reattach('worker-1', leaseOptions()), { code: 'CLOUD_WORKER_PROTOCOL' })
  }
})

test('reattach surfaces unsupported 404 and 405 endpoints as explicit non-retryable HTTP errors', async () => {
  for (const status of [404, 405]) {
    const { provider, calls } = setup(() => response({ code: 'UNSUPPORTED_ENDPOINT', message: 'unsupported' }, status))
    await assert.rejects(provider.reattach('worker-1', leaseOptions()), error => {
      assert.ok(error instanceof CloudWorkerError)
      assert.equal(error.code, 'CLOUD_WORKER_HTTP')
      assert.equal(error.status, status)
      assert.equal(error.retryable, false)
      assert.equal(error.workerId, 'worker-1')
      assert.equal(error.serverCode, 'UNSUPPORTED_ENDPOINT')
      assert.equal(error.message, 'Cloud worker request failed: unsupported')
      return true
    })
    assert.equal(calls.length, 1)
  }
})

test('cancel reports cancelling, never claims stopped, and snapshot reports observed terminal state', async () => {
  let state = 'running'
  const { provider, calls } = setup((call) => {
    if (call.url.endsWith('/cancel')) {
      state = 'stopped'
      assert.equal(call.body.expectedFencingToken, 7)
      assert.equal(call.headers.get('Idempotency-Key'), 'cancel-1')
      return response({ workerId: 'worker-1', state, fencingToken: 7 })
    }
    return response({ workerId: 'worker-1', state, fencingToken: 7 })
  })
  const cancelled = await provider.cancel('worker-1', leaseOptions({ idempotencyKey: 'cancel-1' }))
  assert.equal(cancelled.status, 'cancelling')
  assert.equal(cancelled.state, 'cancelling')
  const snapshot = await provider.snapshot('worker-1', leaseOptions())
  assert.equal(snapshot.state, 'stopped')
  assert.equal(calls.filter(call => call.url.endsWith('/cancel')).length, 1)
})

test('fencing rejects old workers locally and on server 409, then accepts the current fence', async () => {
  const { provider, calls } = setup((call) => {
    if (call.url.endsWith('/cancel')) {
      if (call.headers.get('X-Worker-Fencing-Token') === '7') {
        return response({ code: 'STALE_FENCE', currentFencingToken: 9 }, 409)
      }
      return response({ workerId: 'worker-1', state: 'cancelling', fencingToken: 9 })
    }
    return response(submission())
  })
  await provider.submit(workSpec())
  const stale = LEASE
  await assert.rejects(provider.cancel('worker-1', { lease: { ...stale, fencingToken: 6 } }), { code: 'CLOUD_WORKER_STALE_FENCE' })
  assert.equal(calls.length, 1)
  await assert.rejects(provider.cancel('worker-1', leaseOptions()), { code: 'CLOUD_WORKER_STALE_FENCE' })
  assert.equal(calls.length, 2)
  const current = { ...LEASE, fencingToken: 9 }
  assert.equal((await provider.cancel('worker-1', { lease: current })).state, 'cancelling')
  assert.equal(calls.length, 3)
})

test('snapshot rejects a response regressing the known fencing token', async () => {
  const { provider } = setup((call) => call.index === 0
    ? response(submission({ state: 'running', fencingToken: 8 }))
    : response({ workerId: 'worker-1', state: 'running', fencingToken: 7 }))
  const submitted = await provider.submit(workSpec())
  await assert.rejects(provider.snapshot('worker-1', leaseOptions({ lease: submitted.lease })), { code: 'CLOUD_WORKER_STALE_FENCE' })
})

test('finalizeArtifacts checks manifest size and SHA-256 before returning content', async () => {
  const entry = artifact()
  const { provider, calls } = setup(() => response({
    workerId: 'worker-1', state: 'succeeded', artifactId: 'artifact-1', finalizedAt: NOW,
    manifest: { version: 1, algorithm: 'sha256', entries: [entry] },
  }))
  const result = await provider.finalizeArtifacts('worker-1', leaseOptions({ idempotencyKey: 'finalize-1' }))
  assert.equal(result.artifactId, 'artifact-1')
  assert.equal(result.manifest.entries[0].sha256, entry.sha256)
  assert.equal(result.manifest.entries[0].content, entry.content)
  assert.equal(calls[0].body.expectedFencingToken, 7)
  assert.equal(calls[0].headers.get('X-Worker-Fencing-Token'), '7')
})

test('artifact digest, size, encoding, path, and missing-content failures are closed', () => {
  const valid = artifact()
  assert.equal(verifyArtifactManifest({ entries: [valid] }).entries[0].sha256, valid.sha256)
  assert.throws(() => verifyArtifactManifest({ entries: [{ ...valid, sha256: '0'.repeat(64) }] }), { code: 'CLOUD_WORKER_ARTIFACT_DIGEST' })
  assert.throws(() => verifyArtifactManifest({ entries: [{ ...valid, size: valid.size + 1 }] }), { code: 'CLOUD_WORKER_ARTIFACT_SIZE' })
  assert.throws(() => verifyArtifactManifest({ entries: [{ ...valid, content: 'not base64!' }] }), { code: 'CLOUD_WORKER_ARTIFACT_ENCODING' })
  assert.throws(() => verifyArtifactManifest({ entries: [{ ...valid, path: '../escape' }] }), { code: 'CLOUD_WORKER_ARTIFACT_PATH' })
  const { content, ...withoutContent } = valid
  assert.throws(() => verifyArtifactManifest({ entries: [withoutContent] }), { code: 'CLOUD_WORKER_ARTIFACT_CONTENT' })
  assert.throws(() => verifyArtifactManifest({ algorithm: 'md5', entries: [valid] }), { code: 'CLOUD_WORKER_ARTIFACT_ALGORITHM' })
})

test('finalizeArtifacts never returns tampered server content', async () => {
  const entry = artifact()
  const { provider } = setup(() => response({
    artifactId: 'artifact-bad',
    manifest: { algorithm: 'sha256', entries: [{ ...entry, content: Buffer.alloc(entry.size, 120).toString('base64') }] },
  }))
  await assert.rejects(provider.finalizeArtifacts('worker-1', leaseOptions()), { code: 'CLOUD_WORKER_ARTIFACT_DIGEST' })
})

test('credentials are resolved per retry and expired tokens are not sent', async () => {
  let token = TOKEN
  const { provider, calls } = setup((call) => call.index === 0 ? response({}, 503) : response(submission()), {
    credentials: () => ({ token }),
  })
  await provider.submit(workSpec())
  assert.equal(calls.length, 2)
  token = 'rotated-short-lived-token'
  await provider.submit(workSpec())
  assert.equal(calls[2].headers.get('Authorization'), 'Bearer rotated-short-lived-token')

  const expiredCalls = []
  const expired = createRemoteWorkerProvider({
    baseUrl: 'https://worker.invalid', credentials: { token: TOKEN, expiresAt: NOW },
    now: () => Date.parse(NOW), fetchImpl: async (...args) => { expiredCalls.push(args) },
  })
  await assert.rejects(expired.submit(workSpec()), { code: 'CLOUD_WORKER_AUTH_EXPIRED' })
  assert.equal(expiredCalls.length, 0)

  const resolverFailure = setup(() => { throw new Error('must not fetch') }, {
    credentials: async () => { throw new Error(`resolver failed with token=${TOKEN}`) },
  })
  await assert.rejects(resolverFailure.provider.submit(workSpec()), error => {
    assert.equal(error.code, 'CLOUD_WORKER_AUTH')
    assert.equal(String(error).includes(TOKEN), false)
    return true
  })
  assert.equal(resolverFailure.calls.length, 0)
})

test('redaction helpers remove bearer tokens, secret assignments, and sensitive object fields', () => {
  const text = `Bearer ${TOKEN} token=abc123&x=1`
  assert.equal(redactSensitiveText(text).includes(TOKEN), false)
  assert.equal(redactSensitiveText(text).includes('abc123'), false)
  assert.deepEqual(redactSensitiveValue({ token: TOKEN, nested: { clientSecret: 'hide' }, safe: 'ok' }), {
    token: '[REDACTED]', nested: { clientSecret: '[REDACTED]' }, safe: 'ok',
  })
})

test('configuration rejects insecure remote HTTP and artifact URLs are never fetched', async () => {
  assert.throws(() => createRemoteWorkerProvider({ baseUrl: 'http://worker.invalid' }), { code: 'CLOUD_WORKER_CONFIG' })
  const { provider, calls } = setup(() => response({
    manifest: { entries: [{ ...artifact(), content: undefined, downloadUrl: 'https://other.invalid/secret' }] },
  }))
  await assert.rejects(provider.finalizeArtifacts('worker-1', leaseOptions()), { code: 'CLOUD_WORKER_ARTIFACT_CONTENT' })
  assert.equal(calls.length, 1)
})
