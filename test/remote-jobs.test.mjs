import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createWorkSpec } from '../lib/cloud-worker.js'
import { acquireFileLock } from '../lib/lock.js'
import { createRemoteJobStore } from '../lib/remote-jobs.js'

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const STORE_URL = pathToFileURL(path.resolve('lib/remote-jobs.js')).href
const WORKER_URL = pathToFileURL(path.resolve('lib/cloud-worker.js')).href

function spec(overrides = {}) {
  return createWorkSpec({
    run: { id: 'run-1' },
    subtask: { id: 'subtask-1' },
    attempt: 1,
    repoSnapshot: { provider: 'git', ref: 'snapshot-abc' },
    prompt: 'Implement the remote worker protocol.',
    model: { provider: 'test', ref: 'model-v1' },
    toolScope: { allow: ['read_file'], deny: ['shell'] },
    approvalScope: { mode: 'manual' },
    budget: { maxTokens: 20_000, maxCostUsd: 1, maxWallSeconds: 300 },
    deadline: '2026-11-26T12:10:00.000Z',
    checkpoint: { ref: 'checkpoint-1', cursor: 0 },
    secrets: { refs: [{ provider: 'vault', ref: 'secret/github-readonly' }] },
    ...overrides,
  })
}

function job(workerId, overrides = {}) {
  return {
    workerId,
    runId: 'run-1',
    subtaskId: 'subtask-1',
    attempt: 1,
    lease: { id: `lease-${workerId}`, fencingToken: 7, expiresAt: '2026-11-26T12:05:00.000Z' },
    fencingToken: 7,
    workSpec: spec(),
    state: 'running',
    terminal: false,
    createdAt: '2026-11-26T12:00:00.000Z',
    updatedAt: '2026-11-26T12:00:00.000Z',
    lastCursor: 0,
    error: null,
    revision: 0,
    ...overrides,
  }
}

async function setup(t, options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-remote-jobs-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'jobs.json')
  const store = createRemoteJobStore({ file, now: () => NOW, lockTimeoutMs: 100, ...options })
  return { dir, file, store }
}

function childSource(source) {
  return `import { createRemoteJobStore } from ${JSON.stringify(STORE_URL)}; import { createWorkSpec } from ${JSON.stringify(WORKER_URL)}; const spec = createWorkSpec({ run: { id: 'run-child' }, subtask: { id: 'subtask-child' }, attempt: 1, repoSnapshot: { ref: 'snapshot' }, prompt: 'child work', model: { ref: 'model' }, toolScope: { allow: [] }, approvalScope: { mode: 'manual' }, budget: {}, deadline: '2026-11-26T13:00:00.000Z', checkpoint: { ref: 'checkpoint' } }); ${source}`
}

function runChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource(source)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`child exited ${code}: ${stderr}`)))
  })
}

test('persists the complete job atomically and recovers non-terminal jobs after restart', async t => {
  const { file, store } = await setup(t)
  await store.init()
  const running = job('worker-running', { lastCursor: 19 })
  const queued = job('worker-queued', { state: 'queued' })
  const cancelling = job('worker-cancelling', { state: 'cancelling' })
  const succeeded = job('worker-succeeded', { state: 'succeeded', terminal: true, error: null })
  const failed = job('worker-failed', { state: 'failed', terminal: true, error: { message: 'provider rejected work' } })
  for (const value of [running, queued, cancelling, succeeded, failed]) await store.put(value.workerId, value)

  const restarted = createRemoteJobStore({ file, now: () => NOW })
  const recovered = await restarted.recover()
  assert.deepEqual(recovered.map(value => value.workerId).sort(), ['worker-cancelling', 'worker-queued', 'worker-running'])
  assert.deepEqual(await restarted.get('worker-running'), { ...running, revision: 1 })
  assert.equal((await restarted.get('worker-succeeded')).state, 'succeeded')
  assert.equal((await restarted.get('worker-failed')).state, 'failed')
  assert.equal((await restarted.list({ includeTerminal: false })).length, 3)
  assert.equal((await restarted.list()).length, 5)
  const disk = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.deepEqual(disk.jobs.find(value => value.workerId === 'worker-running'), { ...running, revision: 1 })
  assert.equal(disk.formatVersion, 1)
})

test('put enforces revisions and active fencing/lease ownership', async t => {
  const { store } = await setup(t)
  const original = job('worker-1')
  await store.put(original.workerId, original)
  await assert.rejects(store.put('worker-1', { ...original, revision: 1, fencingToken: 6 }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(store.put('worker-1', { ...original, revision: 1, lease: { ...original.lease, expiresAt: '2026-11-26T12:01:00.000Z' } }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(store.put('worker-1', { ...original, revision: 1, runId: 'run-other' }), { code: 'REMOTE_JOB_INVALID_INPUT' })
  await assert.rejects(store.put('worker-1', { ...original, revision: 1 }, { expectedRevision: 0 }), { code: 'REMOTE_JOB_REVISION_CONFLICT' })

  const renewed = { ...original, revision: 1, lastCursor: 4, lease: { ...original.lease, expiresAt: '2026-11-26T12:10:00.000Z' } }
  await store.put('worker-1', renewed, { expectedRevision: 1 })
  assert.equal((await store.get('worker-1')).lastCursor, 4)
  assert.equal((await store.get('worker-1')).revision, 2)
  assert.equal(await store.get('worker-1', { revision: 0 }), null)
  await assert.rejects(store.put('worker-1', original), { code: 'REMOTE_JOB_REVISION_CONFLICT' })
})

test('concurrent put calls neither lose distinct jobs nor double-create one worker', async t => {
  const { store } = await setup(t, { maxJobs: 40 })
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.put(`worker-${index}`, job(`worker-${index}`))))
  assert.equal((await store.list()).length, 30)

  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => store.put('worker-race', job('worker-race'), { expectedRevision: 0 })))
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter(value => value.status === 'rejected' && value.reason.code === 'REMOTE_JOB_REVISION_CONFLICT').length, 11)
  assert.equal((await store.list()).filter(value => value.workerId === 'worker-race').length, 1)
})

test('separate processes serialize writes through the cross-process lock', async t => {
  const { file, store } = await setup(t, { maxJobs: 10 })
  await store.init()
  const script = `const store = createRemoteJobStore({ file: process.argv[1], maxJobs: 10, now: () => Date.parse('2026-11-26T12:00:00.000Z') }); const value = { workerId: process.argv[2], runId: 'run-child', subtaskId: 'subtask-child', attempt: 1, lease: { id: 'lease-child', fencingToken: 1, expiresAt: '2026-11-26T13:00:00.000Z' }, fencingToken: 1, workSpec: spec, state: 'running', terminal: false, createdAt: '2026-11-26T12:00:00.000Z', updatedAt: '2026-11-26T12:00:00.000Z', lastCursor: 0, error: null }; await store.put(value.workerId, value);`
  // spawn() does not expose argv for -e consistently on every Node version;
  // embed each bounded, generated id instead.
  await Promise.all(Array.from({ length: 6 }, (_, index) => runChild(script.replaceAll('process.argv[1]', JSON.stringify(file)).replaceAll('process.argv[2]', JSON.stringify(`child-${index}`)))))
  assert.equal((await store.list()).length, 6)

  const release = await acquireFileLock(`${file}.lock`, { staleMs: Number.POSITIVE_INFINITY, reclaimStale: false, reclaimDead: false })
  assert.ok(release)
  try {
    await assert.rejects(store.put('blocked', job('blocked')), { code: 'REMOTE_JOB_LOCK_BUSY' })
  } finally {
    await release()
  }
  assert.equal(await store.get('blocked'), null)
  await store.put('blocked', job('blocked'))
  assert.ok(await store.get('blocked'))
})

test('state and terminal transitions are revision checked and terminal writes are idempotent', async t => {
  const { file, store } = await setup(t)
  await store.put('worker-1', job('worker-1'))
  await assert.rejects(store.markState('worker-1', 'cancelling', { expectedRevision: 0 }), { code: 'REMOTE_JOB_REVISION_CONFLICT' })
  await assert.rejects(store.markState('worker-1', 'cancelling', { fencingToken: 6 }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(store.markState('worker-1', 'succeeded'), { code: 'REMOTE_JOB_INVALID_INPUT' })

  const changed = await store.markState('worker-1', 'cancelling', { expectedRevision: 1, now: () => NOW + 1000 })
  assert.equal(changed.changed, true)
  assert.equal(changed.job.state, 'cancelling')
  assert.equal(changed.job.updatedAt, '2026-11-26T12:00:01.000Z')
  assert.equal((await store.markState('worker-1', 'cancelling', { now: () => NOW + 2000 })).changed, false)
  assert.equal((await store.get('worker-1')).updatedAt, '2026-11-26T12:00:01.000Z')

  const terminal = await store.markTerminal('worker-1', 'stopped', { error: { message: 'cancelled' }, now: () => NOW + 3000 })
  assert.equal(terminal.changed, true)
  assert.equal(terminal.job.terminal, true)
  const bytes = (await fsp.stat(file)).size
  const mtime = (await fsp.stat(file)).mtimeMs
  const repeated = await store.markTerminal('worker-1', 'failed', { expectedRevision: 3, fencingToken: 7, now: () => NOW + 4000 })
  assert.equal(repeated.changed, false)
  assert.equal(repeated.job.state, 'stopped')
  assert.equal((await fsp.stat(file)).size, bytes)
  assert.equal((await fsp.stat(file)).mtimeMs, mtime)
  assert.equal((await store.markState('worker-1', 'running')).changed, false)
  await assert.rejects(store.markTerminal('worker-1', 'failed', { expectedRevision: 2 }), { code: 'REMOTE_JOB_REVISION_CONFLICT' })
  await assert.rejects(store.markTerminal('worker-1', 'failed', { expectedFencingToken: 6 }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(store.put('worker-1', { ...terminal.job, state: 'running', terminal: false }), { code: 'REMOTE_JOB_TERMINAL' })
  assert.equal((await store.recover()).length, 0)
})

test('expired leases reject mutations until a fresh lease takes ownership', async t => {
  const { store } = await setup(t)
  await store.put('worker-1', job('worker-1'))
  await assert.rejects(store.markState('worker-1', 'cancelling', { now: () => NOW + 300_001 }), { code: 'REMOTE_JOB_LEASE_EXPIRED' })
  await assert.rejects(store.markTerminal('worker-1', 'failed', { now: () => NOW + 300_001 }), { code: 'REMOTE_JOB_LEASE_EXPIRED' })
  await assert.rejects(store.put('worker-1', { ...job('worker-1'), lastCursor: 2 }, { now: () => NOW + 300_001 }), { code: 'REMOTE_JOB_LEASE_EXPIRED' })
  await assert.rejects(store.remove('worker-1', { now: () => NOW + 300_001 }), { code: 'REMOTE_JOB_LEASE_EXPIRED' })

  const renewed = job('worker-1', {
    revision: 1,
    lastCursor: 2,
    lease: { id: 'lease-2', fencingToken: 8, expiresAt: '2026-11-26T12:10:00.000Z' },
    fencingToken: 8,
  })
  await store.put('worker-1', renewed, { now: () => NOW + 300_001 })
  await assert.rejects(store.markState('worker-1', 'cancelling', { fencingToken: 7, now: () => NOW + 300_002 }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  assert.equal((await store.markState('worker-1', 'cancelling', { fencingToken: 8, now: () => NOW + 300_002 })).changed, true)
})

test('expired recovered jobs renew a same-fence lease before state mutations and survive restart', async t => {
  const { file, store } = await setup(t)
  const original = job('worker-recovered', { lastCursor: 11 })
  await store.put(original.workerId, original)
  const expiredAt = NOW + 300_001
  const restarted = createRemoteJobStore({ file, now: () => expiredAt })
  const recovered = await restarted.recover()
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].revision, 1)
  assert.deepEqual(recovered[0].lease, original.lease)
  const before = await fsp.readFile(file, 'utf8')
  const freshLease = { id: 'lease-recovered', fencingToken: 7, expiresAt: '2026-11-26T12:10:00.000Z' }

  await assert.rejects(restarted.markState('worker-recovered', 'running', {
    expectedRevision: 0, lease: freshLease, now: () => expiredAt,
  }), { code: 'REMOTE_JOB_REVISION_CONFLICT' })
  await assert.rejects(restarted.markState('worker-recovered', 'running', {
    expectedRevision: 1, lease: { ...freshLease, fencingToken: 6 }, now: () => expiredAt,
  }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(restarted.markState('worker-recovered', 'running', {
    expectedRevision: 1, lease: { ...freshLease, fencingToken: 8 }, now: () => expiredAt,
  }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(restarted.markState('worker-recovered', 'running', {
    expectedRevision: 1, lease: original.lease, now: () => expiredAt,
  }), { code: 'REMOTE_JOB_LEASE_EXPIRED' })
  assert.equal(await fsp.readFile(file, 'utf8'), before)

  const renewed = await restarted.markState('worker-recovered', 'running', {
    expectedRevision: 1, lease: freshLease, now: () => expiredAt,
  })
  assert.equal(renewed.changed, true, 'renewing the lease is a change even when state is unchanged')
  assert.equal(renewed.job.revision, 2)
  assert.equal(renewed.job.lastCursor, 11)
  assert.deepEqual(renewed.job.lease, freshLease)
  assert.equal(renewed.job.updatedAt, new Date(expiredAt).toISOString())
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')).jobs[0], renewed.job)

  const restartedAgain = createRemoteJobStore({ file, now: () => expiredAt + 1 })
  assert.deepEqual(await restartedAgain.get('worker-recovered'), renewed.job)
  await assert.rejects(restartedAgain.markState('worker-recovered', 'cancelling', {
    expectedRevision: 2, lease: original.lease, now: () => expiredAt + 1,
  }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  const changed = await restartedAgain.markState('worker-recovered', 'cancelling', {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 1,
  })
  assert.equal(changed.changed, true)
  assert.equal(changed.job.revision, 3)
})

test('expired jobs can finish with a same-fence renewal while terminal jobs stay immutable', async t => {
  const { file, store } = await setup(t)
  await store.put('worker-terminal', job('worker-terminal', { lastCursor: 3 }))
  const expiredAt = NOW + 300_001
  const freshLease = { id: 'lease-terminal', fencingToken: 7, expiresAt: '2026-11-26T12:10:00.000Z' }
  await assert.rejects(store.markTerminal('worker-terminal', 'failed', {
    expectedRevision: 1, fencingToken: 8, lease: { ...freshLease, fencingToken: 8 }, now: () => expiredAt,
  }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(store.markTerminal('worker-terminal', 'failed', {
    expectedRevision: 1, fencingToken: 6, lease: { ...freshLease, fencingToken: 6 }, now: () => expiredAt,
  }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })

  const terminal = await store.markTerminal('worker-terminal', 'failed', {
    expectedRevision: 1, lease: freshLease, error: { message: 'worker failed' }, now: () => expiredAt,
  })
  assert.equal(terminal.changed, true)
  assert.equal(terminal.job.revision, 2)
  assert.equal(terminal.job.state, 'failed')
  assert.deepEqual(terminal.job.lease, freshLease)
  const before = await fsp.readFile(file, 'utf8')
  const repeated = await store.markTerminal('worker-terminal', 'stopped', {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 1,
  })
  assert.equal(repeated.changed, false)
  assert.equal(repeated.job.state, 'failed')
  assert.equal((await store.markState('worker-terminal', 'running', {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 1,
  })).changed, false)
  await assert.rejects(store.advanceCursor('worker-terminal', 4, {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 1,
  }), { code: 'REMOTE_JOB_TERMINAL' })
  await assert.rejects(store.put('worker-terminal', { ...terminal.job, state: 'running', terminal: false }), { code: 'REMOTE_JOB_TERMINAL' })
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  assert.deepEqual(await store.recover(), [])
})

test('advanceCursor atomically persists monotonic cursors and renews expired leases', async t => {
  const { file, store } = await setup(t)
  await store.put('worker-cursor', job('worker-cursor', { lastCursor: 4 }))
  const expiredAt = NOW + 300_001
  const restarted = createRemoteJobStore({ file, now: () => expiredAt })
  const freshLease = { id: 'lease-cursor', fencingToken: 7, expiresAt: '2026-11-26T12:10:00.000Z' }
  const advanced = await restarted.advanceCursor('worker-cursor', 12, {
    expectedRevision: 1, expectedFencingToken: 7, lease: freshLease, now: () => expiredAt,
  })
  assert.equal(advanced.changed, true)
  assert.equal(advanced.job.revision, 2)
  assert.equal(advanced.job.lastCursor, 12)
  assert.deepEqual(advanced.job.lease, freshLease)
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).jobs[0].lastCursor, 12)

  const before = await fsp.readFile(file, 'utf8')
  const repeated = await restarted.advanceCursor('worker-cursor', 12, {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 1,
  })
  assert.equal(repeated.changed, false)
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  await assert.rejects(restarted.advanceCursor('worker-cursor', 11, {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 1,
  }), { code: 'REMOTE_JOB_CURSOR_REGRESSION' })
  await assert.rejects(restarted.advanceCursor('worker-cursor', 13, {
    expectedRevision: 1, lease: freshLease, now: () => expiredAt + 1,
  }), { code: 'REMOTE_JOB_REVISION_CONFLICT' })
  await assert.rejects(restarted.advanceCursor('worker-cursor', 13, {
    expectedRevision: 2, expectedFencingToken: 6, lease: freshLease, now: () => expiredAt + 1,
  }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  await assert.rejects(restarted.advanceCursor('worker-cursor', -1, {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 1,
  }), { code: 'REMOTE_JOB_INVALID_INPUT' })
  assert.equal(await fsp.readFile(file, 'utf8'), before)

  const restartedAgain = createRemoteJobStore({ file, now: () => expiredAt + 2 })
  assert.deepEqual(await restartedAgain.get('worker-cursor'), advanced.job)
  const next = await restartedAgain.advanceCursor('worker-cursor', 15, {
    expectedRevision: 2, lease: freshLease, now: () => expiredAt + 2,
  })
  assert.equal(next.changed, true)
  assert.equal(next.job.lastCursor, 15)
  assert.equal(next.job.revision, 3)
})

test('remove checks revision/fence and leaves terminal history until explicitly removed', async t => {
  const { store } = await setup(t)
  const original = job('worker-1')
  await store.put('worker-1', original)
  await assert.rejects(store.remove('worker-1', { revision: 2 }), { code: 'REMOTE_JOB_REVISION_CONFLICT' })
  await assert.rejects(store.remove('worker-1', { expectedFencingToken: 6 }), { code: 'REMOTE_JOB_LEASE_CONFLICT' })
  assert.equal(await store.remove('missing'), false)
  assert.equal(await store.remove('worker-1', { revision: 1, expectedFencingToken: 7 }), true)
  assert.equal(await store.get('worker-1'), null)

  await store.put('worker-terminal', job('worker-terminal', { state: 'failed', terminal: true, error: 'failed' }))
  assert.equal((await store.recover()).length, 0)
  assert.equal((await store.list()).length, 1)
  assert.equal(await store.remove('worker-terminal', { revision: 1 }), true)
})

test('workSpec and errors are redacted and live or credential-shaped specs are rejected', async t => {
  const { file, store } = await setup(t)
  const credential = 'short-lived-test-token'
  const value = job('worker-1', {
    error: {
      message: `request failed token=${credential}`,
      authorization: `Bearer ${credential}`,
      retry: { apiKey: credential, attempt: 2 },
    },
  })
  await store.put('worker-1', value)
  const saved = await store.get('worker-1')
  assert.equal(saved.error.message, 'request failed [REDACTED]')
  assert.equal(saved.error.authorization, '[REDACTED]')
  assert.equal(saved.error.retry.apiKey, '[REDACTED]')
  assert.deepEqual(saved.workSpec.secrets, { refs: [{ provider: 'vault', ref: 'secret/github-readonly' }] })
  const text = await fsp.readFile(file, 'utf8')
  assert.equal(text.includes(credential), false)
  assert.equal(text.includes('short-lived'), false)
  assert.equal(text.includes('secret/github-readonly'), true)
  assert.equal(Object.isFrozen(saved), false, 'callers receive detached JSON values')

  await assert.rejects(store.put('bad-spec', job('bad-spec', { workSpec: { ...spec(), metadata: { authToken: credential } } })), { code: 'CLOUD_WORKER_SECRET_VALUE' })
  await assert.rejects(store.put('live-spec', job('live-spec', { workSpec: { ...spec(), agent: { run() {} } } })), { code: 'CLOUD_WORKER_UNSERIALIZABLE' })
  await assert.rejects(store.put('bad-shape', job('bad-shape', { workSpec: { ...spec(), attempt: 0 } })), { code: 'CLOUD_WORKER_INVALID_SPEC' })
})

test('capacity limits reject new jobs without overwriting the state file', async t => {
  const { file, store } = await setup(t, { maxJobs: 2 })
  await store.put('worker-1', job('worker-1'))
  await store.put('worker-2', job('worker-2'))
  const before = await fsp.readFile(file, 'utf8')
  await assert.rejects(store.put('worker-3', job('worker-3')), { code: 'REMOTE_JOB_CAPACITY' })
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  await store.remove('worker-1')
  await store.put('worker-3', job('worker-3'))
  assert.deepEqual((await store.list()).map(value => value.workerId).sort(), ['worker-2', 'worker-3'])
})

test('invalid JSON is quarantined byte-for-byte and an empty store can be rebuilt', async t => {
  const { dir, file, store } = await setup(t)
  await fsp.mkdir(dir, { recursive: true })
  const damaged = Buffer.from('{"format":"dsh.superagent.remote-jobs","jobs":[{"workerId":')
  await fsp.writeFile(file, damaged)
  assert.deepEqual(await store.recover(), [])
  const preserved = [...store.corrupt.values()]
  assert.equal(preserved.length, 1)
  assert.deepEqual(await fsp.readFile(preserved[0]), damaged)
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).jobs.length, 0)
  await store.put('worker-1', job('worker-1'))
  assert.ok(await store.get('worker-1'))
  assert.deepEqual(await fsp.readFile(preserved[0]), damaged)
})

test('structurally corrupt state is preserved and operations fail closed', async t => {
  const { file, store } = await setup(t)
  await store.init()
  const invalid = JSON.stringify({ format: 'dsh.superagent.remote-jobs', formatVersion: 1, jobs: [{ ...job('worker-1'), revision: -1 }] })
  await fsp.writeFile(file, invalid)
  const recovered = await store.recover()
  assert.deepEqual(recovered, [])
  assert.equal(store.corrupt.size, 1)
  assert.equal(await fsp.readFile([...store.corrupt.values()][0], 'utf8'), invalid)

  const valid = JSON.stringify({ format: 'dsh.superagent.remote-jobs', formatVersion: 1, jobs: [{ ...job('worker-1'), revision: 0 }] })
  await fsp.writeFile(file, valid)
  await assert.rejects(store.put('worker-1', { ...job('worker-1'), revision: 1, lastCursor: 3 }), { code: 'REMOTE_JOB_REVISION_CONFLICT' })
  assert.equal(await fsp.readFile(file, 'utf8'), valid, 'a conflicting put must not quarantine valid state')
})

test('a valid file above a newly lowered capacity is reported, never quarantined', async t => {
  const { file, store } = await setup(t)
  await store.put('worker-1', job('worker-1'))
  await store.put('worker-2', job('worker-2'))
  const before = await fsp.readFile(file, 'utf8')
  const smaller = createRemoteJobStore({ file, now: () => NOW, maxJobs: 1 })
  await assert.rejects(smaller.list(), { code: 'REMOTE_JOB_CAPACITY' })
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  assert.equal(smaller.corrupt.size, 0)
})
