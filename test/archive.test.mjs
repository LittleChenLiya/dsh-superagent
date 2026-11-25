import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createStore } from '../lib/store.js'

const execFileAsync = promisify(execFile)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function tempStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-archive-'))
  const store = createStore(dir)
  await store.init()
  return { store, dir }
}

function daysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString()
}

function runOf(id, status, finishedAt, extra = {}) {
  return {
    id,
    schemaVersion: 1,
    goal: `goal for ${id}`,
    status,
    mode: 'planned',
    parentSessionId: 'session-1',
    createdAt: finishedAt ?? daysAgo(30),
    updatedAt: finishedAt,
    startedAt: finishedAt,
    finishedAt,
    plan: null,
    subtasks: [],
    steps: {},
    report: null,
    attention: null,
    milestones: [],
    artifacts: [],
    memory: null,
    memoryWrite: null,
    selfHeal: null,
    error: null,
    usage: null,
    notified: false,
    counters: { spawns: 0, unreadable: {} },
    usageByChild: {},
    ...extra,
  }
}

function fullRun(overrides = {}) {
  return {
    ...runOf('20260101T000000-full', 'completed', '2026-01-01T00:10:00.000Z'),
    goal: 'Ship the archive feature',
    subtasks: [
      {
        index: 1,
        title: 'Read the store',
        prompt: 'read lib/store.js',
        status: 'completed',
        attempts: 1,
        childId: 'child-a',
        stopReason: 'end_turn',
        error: null,
        result: 'the store writes atomically',
        usage: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 0, totalTokens: 120, modelCalls: 2, models: {} },
        startedAt: '2026-01-01T00:01:00.000Z',
        finishedAt: '2026-01-01T00:04:00.000Z',
      },
      {
        index: 2,
        title: 'Write tests',
        prompt: 'cover prune',
        status: 'failed',
        attempts: 2,
        childId: 'child-b',
        stopReason: null,
        error: 'child timed out',
        result: null,
        usage: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 0, totalTokens: 40, modelCalls: 1, models: {} },
        startedAt: '2026-01-01T00:04:00.000Z',
        finishedAt: '2026-01-01T00:09:00.000Z',
      },
    ],
    report: '# Result\n\nArchives work.',
    attention: {
      at: '2026-01-01T00:05:00.000Z',
      items: [{ source: 'subtask-2', question: 'Retry?', options: ['yes', 'no'], reason: 'child timed out' }],
    },
    usage: {
      inputTokens: 100,
      outputTokens: 60,
      cacheReadTokens: 0,
      totalTokens: 160,
      modelCalls: 3,
      models: { 'test/model': { inputTokens: 100, outputTokens: 60, cacheReadTokens: 0 } },
    },
    cost: { total: 0.0012, currency: 'USD', byModel: { 'test/model': 0.0012 }, unpriced: [], complete: true },
    usageByChild: { 'child-a': { totalTokens: 120, modelCalls: 2 }, 'child-b': { totalTokens: 40, modelCalls: 1 } },
    notified: true,
    counters: { spawns: 3, unreadable: {} },
    ...overrides,
  }
}

async function writeReport(store, runId, text) {
  const dir = path.join(store.root, 'reports')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${runId}.md`), text, 'utf8')
}

async function listFiles(root) {
  const found = []
  const walk = async current => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else found.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  await walk(root)
  return found.sort()
}

test('prune dry run lists candidates and their bytes without deleting anything', async () => {
  const { store, dir } = await tempStore()
  await store.write(runOf('20260101T000000-old1', 'completed', daysAgo(30)))
  await store.write(runOf('20260101T000000-old2', 'failed', daysAgo(20)))
  await store.write(runOf('20260101T000000-new1', 'completed', daysAgo(1)))
  await store.write(runOf('20260101T000000-run1', 'running', daysAgo(30)))
  await writeReport(store, '20260101T000000-old1', 'old report')

  const plan = await store.prune({ olderThanDays: 7, dryRun: true })

  assert.deepEqual(plan.candidates.map(candidate => candidate.id).sort(), [
    '20260101T000000-old1',
    '20260101T000000-old2',
  ])
  assert.ok(plan.bytes > 0, 'the plan must report the bytes it would free')
  assert.ok(plan.files >= 2, 'the plan must count the run files it would remove')
  assert.deepEqual(plan.removed, [])
  assert.equal(plan.dryRun, true)
  assert.equal((await store.list()).length, 4, 'a dry run deletes nothing')
  await fsp.access(path.join(store.runsDir, '20260101T000000-old1.json'))
  await fsp.access(path.join(store.root, 'reports', '20260101T000000-old1.md'))
  await fsp.rm(dir, { recursive: true, force: true })
})

test('prune deletes terminal runs past the window only', async () => {
  const { store, dir } = await tempStore()
  await store.write(runOf('20260101T000000-old1', 'completed', daysAgo(30)))
  await store.write(runOf('20260101T000000-old2', 'cancelled', daysAgo(20)))
  await store.write(runOf('20260101T000000-new1', 'completed', daysAgo(1)))
  await store.write(runOf('20260101T000000-run1', 'running', daysAgo(30)))
  await writeReport(store, '20260101T000000-old1', 'old report\n')
  await writeReport(store, '20260101T000000-new1', 'new report\n')

  const result = await store.prune({ olderThanDays: 7 })

  assert.deepEqual(result.removed.sort(), ['20260101T000000-old1', '20260101T000000-old2'])
  assert.ok(result.deletedBytes > 0)
  assert.deepEqual((await store.list()).map(run => run.id).sort(), [
    '20260101T000000-new1',
    '20260101T000000-run1',
  ])
  await assert.rejects(fsp.access(path.join(store.root, 'reports', '20260101T000000-old1.md')), { code: 'ENOENT' })
  await fsp.access(path.join(store.root, 'reports', '20260101T000000-new1.md'))
  await fsp.rm(dir, { recursive: true, force: true })
})

test('prune honours a status filter and rejects a non-terminal one', async () => {
  const { store, dir } = await tempStore()
  await store.write(runOf('20260101T000000-old1', 'completed', daysAgo(30)))
  await store.write(runOf('20260101T000000-old2', 'failed', daysAgo(20)))

  const onlyFailed = await store.prune({ olderThanDays: 7, statuses: 'failed' })
  assert.deepEqual(onlyFailed.removed, ['20260101T000000-old2'])
  assert.deepEqual((await store.list()).map(run => run.id), ['20260101T000000-old1'])
  await assert.rejects(
    () => store.prune({ olderThanDays: 7, statuses: 'running' }),
    /not terminal/,
  )
  await fsp.rm(dir, { recursive: true, force: true })
})

test('prune leaves a terminal run locked by another process alone', async () => {
  const { store, dir } = await tempStore()
  await store.write(runOf('20260101T000000-held', 'completed', daysAgo(30)))
  await store.write(runOf('20260101T000000-old1', 'completed', daysAgo(30)))
  await store.acquireLock('20260101T000000-held', { pid: 4321, hostname: 'machine-b', at: daysAgo(30) })

  const plan = await store.prune({ olderThanDays: 7, dryRun: true })
  assert.deepEqual(plan.candidates.map(candidate => candidate.id), ['20260101T000000-old1'])
  assert.deepEqual(plan.skipped.map(entry => entry.id), ['20260101T000000-held'])

  const result = await store.prune({ olderThanDays: 7 })
  assert.deepEqual(result.removed, ['20260101T000000-old1'])
  assert.deepEqual((await store.list()).map(run => run.id), ['20260101T000000-held'])
  assert.ok(await store.readLock('20260101T000000-held'), 'the lock must survive the prune')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('prune rechecks a candidate under the run lock before deleting it', async () => {
  const { store, dir } = await tempStore()
  const id = '20260101T000000-raced'
  await store.write(runOf(id, 'completed', daysAgo(30)))
  await writeReport(store, id, 'still needed\n')
  const planPrune = store.planPrune.bind(store)
  store.planPrune = async options => {
    const plan = await planPrune(options)
    const holder = { pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }
    assert.equal((await store.acquireLock(id, holder)).acquired, true)
    const resumed = await store.read(id)
    resumed.status = 'running'
    resumed.finishedAt = null
    await store.write(resumed)
    return plan
  }

  const result = await store.prune({ olderThanDays: 7 })

  assert.deepEqual(result.removed, [])
  assert.ok(result.skipped.some(entry => entry.id === id))
  assert.equal((await store.read(id)).status, 'running')
  assert.ok(await store.readLock(id), 'the resumed run must keep its claim')
  await fsp.access(path.join(store.root, 'reports', `${id}.md`))
  await store.releaseLock(id)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('export writes a self-contained directory that import restores as read-only', async () => {
  const { store, dir } = await tempStore()
  const run = fullRun()
  await store.write(run)
  const out = path.join(dir, 'archive')

  const exported = await store.exportRun(run.id, out, { exportedAt: '2026-02-01T00:00:00.000Z' })
  assert.equal(exported.format, 'dir')
  assert.ok(exported.bytes > 0)
  const files = await listFiles(out)
  for (const expected of [
    'manifest.json',
    'README.md',
    'run.json',
    'report.md',
    'usage.json',
    'guards.json',
    'guards.md',
    'subtasks/01-read-the-store.md',
    'subtasks/01-read-the-store.json',
    'subtasks/02-write-tests.md',
    'subtasks/02-write-tests.json',
  ]) {
    assert.ok(files.includes(expected), `export is missing ${expected}`)
  }

  const target = await tempStore()
  const imported = await target.store.importRun(out)
  assert.equal(imported.run.id, run.id)
  assert.deepEqual(imported.run, { ...run, importedReadOnly: true }, 'import preserves the record and adds read-only provenance')
  assert.equal(await fsp.readFile(path.join(target.store.root, 'reports', `${run.id}.md`), 'utf8'), '# Result\n\nArchives work.\n')

  await assert.rejects(() => target.store.importRun(out), /already exists.*never overwrites/)
  assert.deepEqual(await target.store.read(run.id), { ...run, importedReadOnly: true }, 'a refused import must not change the local run')

  await fsp.rm(target.dir, { recursive: true, force: true })
  await fsp.rm(dir, { recursive: true, force: true })
})

test('single-file bundle and html archives both import back', async () => {
  const { store, dir } = await tempStore()
  const run = fullRun()
  await store.write(run)

  const bundle = path.join(dir, 'run.json')
  await store.exportRun(run.id, bundle, { format: 'bundle' })
  const fromBundle = await tempStore()
  const importedBundle = await fromBundle.store.importRun(bundle)
  assert.deepEqual(importedBundle.run, { ...run, importedReadOnly: true })

  const html = path.join(dir, 'run.html')
  await store.exportRun(run.id, html, { format: 'html' })
  const text = await fsp.readFile(html, 'utf8')
  assert.match(text, /^<!doctype html>/i)
  assert.ok(text.includes('id="superagent-archive"'), 'the page must embed the importable bundle')
  const fromHtml = await tempStore()
  const importedHtml = await fromHtml.store.importRun(html)
  assert.deepEqual(importedHtml.run, { ...run, importedReadOnly: true })

  await fsp.rm(fromBundle.dir, { recursive: true, force: true })
  await fsp.rm(fromHtml.dir, { recursive: true, force: true })
  await fsp.rm(dir, { recursive: true, force: true })
})

test('an active archive is rejected before it can be imported and resumed', async () => {
  const { store, dir } = await tempStore()
  const run = { ...fullRun({ status: 'running', parentSessionId: null }), goal: 'attacker controlled task' }
  await store.write(run)
  const bundle = path.join(dir, 'active.json')
  await store.exportRun(run.id, bundle, { format: 'bundle' })
  const target = await tempStore()

  await assert.rejects(() => target.store.importRun(bundle), /non-terminal run status.*only finished runs/)
  assert.equal(await target.store.read(run.id), null)
  await fsp.rm(target.dir, { recursive: true, force: true })
  await fsp.rm(dir, { recursive: true, force: true })
})

test('the prune CLI defaults to a dry run and deletes only with --confirm', async () => {
  const { store, dir } = await tempStore()
  await store.write(runOf('20260101T000000-old1', 'completed', daysAgo(30)))
  await store.write(runOf('20260101T000000-run1', 'running', daysAgo(30)))

  const { stdout } = await execFileAsync(process.execPath, [
    path.join(REPO, 'bin/archive.js'), 'prune', '--state-dir', dir, '--older-than', '7',
  ])
  assert.match(stdout, /dry run: nothing deleted/)
  assert.match(stdout, /20260101T000000-old1/)
  assert.equal((await store.list()).length, 2)

  const confirmed = await execFileAsync(process.execPath, [
    path.join(REPO, 'bin/archive.js'), 'prune', '--state-dir', dir, '--older-than', '7', '--confirm',
  ])
  assert.match(confirmed.stdout, /deleted 1 run\(s\)/)
  assert.deepEqual((await store.list()).map(run => run.id), ['20260101T000000-run1'])
  await fsp.rm(dir, { recursive: true, force: true })
})
