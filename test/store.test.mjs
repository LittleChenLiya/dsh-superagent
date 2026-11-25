import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStore, resolveStateRoot } from '../lib/store.js'

async function tempStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-store-'))
  const store = createStore(dir)
  await store.init()
  return { store, dir }
}

test('concurrent writes to one run leave a valid file and no temp files', async () => {
  const { store, dir } = await tempStore()
  const another = createStore(dir)
  const run = { id: '20260101T000000-abcd', status: 'running', subtasks: [] }

  await Promise.all(Array.from({ length: 40 }, (_, index) =>
    (index % 2 ? another : store).write({ ...run, tick: index })))

  const stored = await store.read(run.id)
  assert.equal(stored.id, run.id)
  assert.equal(stored.tick, 39)
  const leftovers = (await fsp.readdir(store.runsDir)).filter(name => name.startsWith('.'))
  assert.deepEqual(leftovers, [])
  await fsp.rm(dir, { recursive: true, force: true })
})

test('run ids that could escape the runs directory are ignored', async () => {
  const { store, dir } = await tempStore()
  assert.equal(await store.read('../../etc/passwd'), null)
  assert.equal(await store.read('..'), null)
  assert.equal(await store.read(''), null)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('a corrupt run file is skipped instead of breaking the listing', async () => {
  const { store, dir } = await tempStore()
  await store.write({ id: '20260101T000000-good', createdAt: '2026-01-01T00:00:00.000Z', status: 'completed' })
  await fsp.writeFile(path.join(store.runsDir, '20260101T000001-bad.json'), '{not json', 'utf8')

  const runs = await store.list()
  assert.deepEqual(runs.map(run => run.id), ['20260101T000000-good'])
  const kept = (await fsp.readdir(store.runsDir)).filter(name => name.includes('.corrupt-'))
  assert.equal(kept.length, 1)
  const text = await fsp.readFile(path.join(store.runsDir, kept[0]), 'utf8')
  assert.equal(text, '{not json', 'the damaged bytes must be kept, not deleted')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('a cancel marker can be written, seen and cleared from any process', async () => {
  const { store, dir } = await tempStore()
  assert.equal(await store.hasCancelRequest('20260101T000000-abcd'), false)

  assert.equal(await store.requestCancel('20260101T000000-abcd'), true)
  assert.equal(await store.hasCancelRequest('20260101T000000-abcd'), true)
  assert.equal(await store.requestCancel('../../etc/passwd'), false)

  await store.clearCancel('20260101T000000-abcd')
  assert.equal(await store.hasCancelRequest('20260101T000000-abcd'), false)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('mount cleanup drops stale temp files and markers for finished runs', async () => {
  const { store, dir } = await tempStore()
  await store.write({ id: '20260101T000000-done', createdAt: '2026-01-01T00:00:00.000Z', status: 'completed' })
  await store.requestCancel('20260101T000000-done')

  const stale = path.join(store.runsDir, '.20260101T000000-done.111.1.tmp')
  await fsp.writeFile(stale, 'partial write', 'utf8')
  const old = new Date(Date.now() - 11 * 60 * 1000)
  await fsp.utimes(stale, old, old)
  const fresh = path.join(store.runsDir, '.20260101T000000-done.111.2.tmp')
  await fsp.writeFile(fresh, 'write in progress', 'utf8')

  await store.cleanup()

  const names = await fsp.readdir(store.runsDir)
  assert.equal(names.includes(path.basename(stale)), false)
  assert.equal(names.includes(path.basename(fresh)), true, 'a recent temp file may belong to a live writer')
  assert.equal(names.includes('20260101T000000-done.cancel'), false)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('state root follows DSH_HOME and prefers an explicit path', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-home-test')
  try {
    assert.equal(resolveStateRoot(), path.join(process.env.DSH_HOME, 'state', 'superagent'))
    assert.equal(resolveStateRoot(path.join(os.tmpdir(), 'custom')), path.join(os.tmpdir(), 'custom'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('prune deletes only terminal runs older than the window', async () => {
  const { store, dir } = await tempStore()
  const old = new Date(Date.now() - 30 * 86400000).toISOString()
  const recent = new Date().toISOString()
  await store.write({ id: '20260101T000000-old1', status: 'completed', createdAt: old, finishedAt: old })
  await store.write({ id: '20260101T000000-new1', status: 'completed', createdAt: recent, finishedAt: recent })
  await store.write({ id: '20260101T000000-run1', status: 'running', createdAt: old, finishedAt: null })
  await store.requestCancel('20260101T000000-old1')
  // A terminal run also leaves a report behind; prune must remove both, or
  // `keepRuns` bounds the state directory only for the run records.
  const reports = path.join(dir, 'reports')
  await fsp.mkdir(reports, { recursive: true })
  const oldReport = path.join(reports, '20260101T000000-old1.md')
  const newReport = path.join(reports, '20260101T000000-new1.md')
  await fsp.writeFile(oldReport, 'old\n', 'utf8')
  await fsp.writeFile(newReport, 'new\n', 'utf8')

  assert.deepEqual((await store.prune({ olderThanDays: 7 })).removed, ['20260101T000000-old1'])
  assert.deepEqual((await store.list()).map(run => run.id).sort(), ['20260101T000000-new1', '20260101T000000-run1'])
  assert.equal((await fsp.readdir(store.runsDir)).includes('20260101T000000-old1.cancel'), false)
  await assert.rejects(fsp.access(oldReport), { code: 'ENOENT' })
  await fsp.access(newReport)
  assert.deepEqual((await store.prune({ olderThanDays: 0 })).removed, [], 'keepRuns 0 means keep everything')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('stats counts files, bytes and quarantined evidence', async () => {
  const { store, dir } = await tempStore()
  await store.write({ id: '20260101T000000-good', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' })
  await fsp.writeFile(path.join(store.runsDir, '20260101T000000-bad.json'), '{not json', 'utf8')
  await store.read('20260101T000000-bad')

  const stats = await store.stats()
  assert.equal(stats.files, 2)
  assert.ok(stats.bytes > 0)
  assert.equal(stats.corrupt, 1)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('the state directory remembers the hostname that created it', async () => {
  const { store, dir } = await tempStore()
  assert.equal(await store.readOwner(), null)
  await store.writeOwner({ hostname: 'machine-a', createdAt: '2026-01-01T00:00:00.000Z' })
  assert.equal((await store.readOwner()).hostname, 'machine-a')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('a run lock lets exactly one process win', async () => {
  const { store, dir } = await tempStore()
  const first = { pid: 1111, hostname: 'machine-a', at: new Date().toISOString() }

  assert.deepEqual(await store.acquireLock('20260101T000000-lock', first), { acquired: true, holder: first })
  const second = await store.acquireLock('20260101T000000-lock', { pid: 2222, hostname: 'machine-b', at: 'now' })
  assert.equal(second.acquired, false)
  assert.equal(second.holder.pid, 1111)

  await store.releaseLock('20260101T000000-lock')
  assert.equal((await store.acquireLock('20260101T000000-lock', first)).acquired, true)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('a stale release cannot remove a replacement run lock', async () => {
  const { store, dir } = await tempStore()
  const id = '20260101T000000-lock'
  const first = { pid: 1111, hostname: 'machine-a', at: new Date().toISOString() }
  assert.equal((await store.acquireLock(id, first)).acquired, true)
  const replacement = { pid: 2222, hostname: 'machine-b', at: new Date().toISOString(), token: 'replacement' }
  await fsp.writeFile(path.join(store.runsDir, `${id}.lock`), `${JSON.stringify(replacement)}\n`)

  await store.releaseLock(id, first)

  assert.deepEqual(await store.readLock(id), replacement)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('a legacy lock holder can still be released without token metadata', async () => {
  const { store, dir } = await tempStore()
  const id = '20260101T000000-legacy'
  const holder = { pid: 4321, hostname: 'machine-b', at: new Date().toISOString() }
  await fsp.writeFile(path.join(store.runsDir, `${id}.lock`), `${JSON.stringify(holder)}\n`)

  await store.releaseLock(id, holder)

  assert.equal(await store.readLock(id), null)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('mount cleanup drops locks of finished runs', async () => {
  const { store, dir } = await tempStore()
  await store.write({ id: '20260101T000000-done', createdAt: '2026-01-01T00:00:00.000Z', status: 'completed' })
  await store.acquireLock('20260101T000000-done', { pid: 1, hostname: 'machine-a', at: 'now' })

  await store.cleanup()

  const names = await fsp.readdir(store.runsDir)
  assert.equal(names.includes('20260101T000000-done.lock'), false)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('a missing runs directory is reported instead of looking empty', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-store-'))
  const store = createStore(path.join(dir, 'vanished'))
  await assert.rejects(() => store.list(), /cannot read the run state directory.*ENOENT/)
  await fsp.rm(dir, { recursive: true, force: true })
})
