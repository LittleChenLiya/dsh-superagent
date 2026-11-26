import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectArtifacts, listArtifacts, parseArtifactId } from '../lib/artifacts.js'
import { apply } from '../lib/index.js'
import { createStore } from '../lib/store.js'

function run(overrides = {}) {
  return {
    id: 'run-1',
    parentSessionId: 'session-a',
    goal: 'Prepare the release',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T01:00:00.000Z',
    workspace: { base: path.join(os.tmpdir(), 'artifact-workspace') },
    artifacts: [],
    report: '',
    ...overrides,
  }
}

test('raw report artifacts survive aggregation and deduplicate their report link', () => {
  const root = path.join(os.tmpdir(), 'artifact-workspace')
  const report = path.join(root, 'report.md')
  const result = listArtifacts([run({
    artifacts: [{ kind: 'report', path: report, bytes: 123, at: '2026-01-01T00:30:00.000Z' }],
    report: '# Release\n\n[Read the report](./report.md)',
  })], { 'session-a': { name: 'Release', cwd: root } })

  assert.equal(result.artifacts.length, 1)
  assert.deepEqual(result.artifacts[0], {
    id: result.artifacts[0].id,
    runId: 'run-1',
    ownerSessionId: 'session-a',
    project: { name: 'Release', cwd: root },
    goal: 'Prepare the release',
    runStatus: 'completed',
    name: 'report.md',
    kind: 'report',
    source: 'declared',
    href: report,
    path: report,
    bytes: 123,
    at: '2026-01-01T00:30:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T01:00:00.000Z',
  })
  assert.equal(result.nextCursor, null)
})

test('declared artifacts win over normalised Markdown links and ids stay stable and URL-safe', () => {
  const root = path.join(os.tmpdir(), 'artifact-workspace')
  const declared = path.join(root, 'declared.md')
  const record = run({
    id: 'run-dedupe-1',
    artifacts: [{ kind: 'report', name: 'Declared title', path: declared, bytes: 88, at: '2026-01-01T00:20:00.000Z' }],
    report: [
      '[Declared](./declared.md)',
      '[Extra spreadsheet](extra.pdf)',
      '[Reference][sheet]',
      '[sheet]: ./reference.csv',
      '[Encoded](my%20file.md)',
      '[Unsafe](javascript:alert(1))',
      '[Anchor](#section)',
    ].join('\n'),
  })
  const projects = { 'session-a': { name: 'Release', cwd: root } }
  const first = listArtifacts([record], projects)
  const second = listArtifacts([record], projects)
  assert.deepEqual(first, second)
  assert.equal(first.artifacts.length, 4)
  const item = first.artifacts.find(artifact => artifact.name === 'Declared title')
  assert.equal(item.source, 'declared')
  assert.equal(item.kind, 'report')
  assert.equal(item.bytes, 88)
  assert.equal(item.path, declared)
  assert.equal(first.artifacts.filter(artifact => artifact.path === declared).length, 1)
  assert.equal(first.artifacts.find(artifact => artifact.name === 'Extra spreadsheet').source, 'report')
  assert.equal(first.artifacts.find(artifact => artifact.name === 'Extra spreadsheet').kind, 'pdf')
  assert.equal(first.artifacts.find(artifact => artifact.name === 'Reference').path, path.join(root, 'reference.csv'))
  assert.equal(first.artifacts.find(artifact => artifact.name === 'Encoded').path, path.join(root, 'my file.md'))
  assert.match(item.id, /^art_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(parseArtifactId(item.id), { runId: record.id, digest: item.id.split('.')[1] })
  assert.equal(parseArtifactId('../../secret'), null)
  const posix = listArtifacts([run({
    workspace: { base: '/work/project' },
    artifacts: [{ kind: 'md', path: '/work/project/a.md' }],
    report: '[A](./a.md)',
  })], {})
  assert.equal(posix.artifacts.length, 1)
  assert.equal(posix.artifacts[0].path, '/work/project/a.md')
  const escaped = listArtifacts([run({
    workspace: { base: '/work/project' },
    artifacts: [],
    report: '[Escape](../outside.txt)',
  })], {})
  assert.deepEqual(escaped.artifacts, [], 'relative report links cannot list files outside the run workspace')
})

test('global aggregation scopes projects, filters, sorts, and paginates deterministically', () => {
  const root = path.join(os.tmpdir(), 'artifact-projects')
  const alpha = { name: 'Alpha', cwd: path.join(root, 'alpha') }
  const beta = { name: 'Beta', cwd: path.join(root, 'beta') }
  const projects = {
    'session-alpha': alpha,
    'session-beta': beta,
    'session-default': null,
  }
  const records = [
    run({
      id: 'run-alpha-1', parentSessionId: 'session-alpha', goal: 'Alpha notes',
      finishedAt: '2026-01-02T00:00:00.000Z',
      artifacts: [{ kind: 'md', path: path.join(alpha.cwd, 'notes.md'), bytes: 10, at: '2026-01-03T00:00:00.000Z' }],
    }),
    run({
      id: 'run-alpha-2', parentSessionId: 'session-alpha', goal: 'Alpha data',
      finishedAt: null, createdAt: '2026-01-01T12:00:00.000Z',
      artifacts: [{ kind: 'csv', path: path.join(alpha.cwd, 'data.csv'), bytes: 20, at: '2026-01-01T13:00:00.000Z' }],
    }),
    run({
      id: 'run-beta-1', parentSessionId: 'session-beta', goal: 'Beta report',
      finishedAt: '2026-01-04T00:00:00.000Z',
      artifacts: [{ kind: 'pdf', path: path.join(beta.cwd, 'report.pdf'), bytes: 30, at: '2026-01-01T00:00:00.000Z' }],
    }),
    run({
      id: 'run-default-1', parentSessionId: 'session-default', goal: 'Default inbox',
      finishedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
      artifacts: [{ kind: 'txt', path: path.join(root, 'inbox.txt'), bytes: 40, at: '2026-01-01T01:00:00.000Z' }],
    }),
  ]
  const all = listArtifacts(records, projects)
  assert.deepEqual(all.artifacts.map(item => item.runId), ['run-beta-1', 'run-alpha-1', 'run-alpha-2', 'run-default-1'])
  assert.equal(all.artifacts.find(item => item.runId === 'run-default-1').project, null)
  assert.deepEqual(listArtifacts(records, projects, { project: 'Alpha' }).artifacts.map(item => item.runId), ['run-alpha-1', 'run-alpha-2'])
  assert.deepEqual(listArtifacts(records, projects, { project: alpha.cwd }).artifacts.map(item => item.runId), ['run-alpha-1', 'run-alpha-2'])
  assert.deepEqual(listArtifacts(records, projects, { kind: 'pdf' }).artifacts.map(item => item.runId), ['run-beta-1'])
  assert.deepEqual(listArtifacts(records, projects, { q: 'alpha NOTES' }).artifacts.map(item => item.runId), ['run-alpha-1'])
  assert.deepEqual(listArtifacts(records, projects, { from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' }).artifacts.map(item => item.runId), ['run-alpha-1'])

  const paged = []
  let cursor
  do {
    const page = listArtifacts(records, projects, { limit: 1, ...(cursor ? { cursor } : {}) })
    assert.equal(page.artifacts.length, 1)
    paged.push(...page.artifacts)
    cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(paged, all.artifacts)
  assert.throws(() => listArtifacts(records, projects, { cursor: 'art_missing.invalid' }), error => error.status === 400 && error.id === 'invalid-artifact-cursor')
  assert.throws(() => listArtifacts(records, projects, { limit: 0 }), error => error.status === 400 && error.id === 'invalid-artifact-limit')
  assert.throws(() => listArtifacts(records, projects, { from: 'not-a-date' }), error => error.status === 400 && error.id === 'invalid-artifact-date')
})

test('repeated file artifacts retain a cross-run version record', () => {
  const project = { name: 'Alpha', cwd: path.join(os.tmpdir(), 'artifact-versions', 'alpha') }
  const file = path.join(project.cwd, 'report.md')
  const records = [
    run({ id: 'run-new', parentSessionId: 'session-alpha', finishedAt: '2026-01-03T00:00:00.000Z',
      artifacts: [{ kind: 'md', path: file, at: '2026-01-03T00:00:00.000Z' }] }),
    run({ id: 'run-old', parentSessionId: 'session-alpha', finishedAt: '2026-01-02T00:00:00.000Z',
      artifacts: [{ kind: 'md', path: file, at: '2026-01-02T00:00:00.000Z' }] }),
  ]
  const items = collectArtifacts(records, { 'session-alpha': project })
  assert.equal(items.length, 2)
  assert.equal(items[0].versionCount, 2)
  assert.deepEqual(items[0].versions.map(version => version.runId), ['run-new', 'run-old'])
  assert.equal(items[0].versions.some(version => version.versions), false)
})

test('the real console host aggregates only visible workspace sessions and re-reads artifact detail', { timeout: 15_000 }, async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-artifacts-'))
  const state = path.join(base, 'state')
  const consoleRoot = path.join(base, 'console')
  const alphaRoot = path.join(base, 'alpha')
  const betaRoot = path.join(base, 'beta')
  const foreignRoot = path.join(base, 'foreign')
  await Promise.all([state, consoleRoot, alphaRoot, betaRoot, foreignRoot].map(dir => fsp.mkdir(dir)))
  await fsp.writeFile(path.join(state, 'console-workbench.json'), JSON.stringify({
    name: 'Global assistant',
    sessions: { 'session-alpha': alphaRoot, 'session-beta': betaRoot },
    projects: [alphaRoot, betaRoot],
    taskOwners: {},
  }))

  const store = createStore(state)
  await store.init()
  const alphaPath = path.join(alphaRoot, 'report.md')
  const betaPath = path.join(betaRoot, 'deliverable.pdf')
  const defaultPath = path.join(consoleRoot, 'inbox.txt')
  const foreignPath = path.join(foreignRoot, 'secret.txt')
  const makeRun = (id, owner, goal, artifact, extra = {}) => ({
    id, parentSessionId: owner, goal, status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T01:00:00.000Z',
    workspace: { base: owner === 'session-alpha' ? alphaRoot : owner === 'session-beta' ? betaRoot : consoleRoot },
    artifacts: [artifact], report: '', ...extra,
  })
  const alphaRun = makeRun('run-alpha-1', 'session-alpha', 'Alpha release', { kind: 'report', path: alphaPath, bytes: 12 })
  const betaRun = makeRun('run-beta-1', 'session-beta', 'Beta delivery', { kind: 'pdf', path: betaPath, bytes: 34 })
  const defaultRun = makeRun('run-default-1', 'session-default', 'Default note', { kind: 'txt', path: defaultPath, bytes: 56 })
  const foreignRun = makeRun('run-foreign-1', 'session-foreign', 'Foreign secret', { kind: 'txt', path: foreignPath, bytes: 78 })
  const childRun = makeRun('run-child-1', 'session-child', 'Child secret', { kind: 'txt', path: foreignPath, bytes: 90 })
  const decomposeRun = makeRun('run-decompose-1', 'session-alpha', 'Internal planner', { kind: 'json', path: alphaPath, bytes: 1 }, { origin: { role: 'decompose' } })
  const ownerOnlyRun = makeRun('run-owner-only', 'session-alpha', 'Owner fallback', null)
  delete ownerOnlyRun.parentSessionId
  ownerOnlyRun.ownerSessionId = 'session-alpha'
  const scheduledRun = makeRun('run-scheduled-1', 'session-alpha', 'Scheduled check', null, {
    origin: { kind: 'scheduled', scheduleId: 'schedule-1', scheduleName: '每日检查' },
  })
  const today = new Date().toISOString()
  const todayRuns = Array.from({ length: 25 }, (_, index) => makeRun(`run-today-${index}`, 'session-alpha', `Today ${index}`, null, {
    createdAt: today, finishedAt: today,
  }))
  const phaseRuns = Array.from({ length: 3 }, (_, index) => makeRun(`run-phase-${index}`, 'session-alpha', `Phase ${index}`, null, {
    createdAt: today, finishedAt: today, origin: { kind: 'long-goal', goalId: 'g-test-summary', phaseId: `p${index}` },
  }))
  await fsp.mkdir(path.join(state, 'goals'), { recursive: true })
  await fsp.writeFile(path.join(state, 'goals', 'g-test-summary.json'), JSON.stringify({
    id: 'g-test-summary', goal: 'Long goal', title: 'Long goal', ownerSessionId: 'session-alpha',
    createdAt: today, finishedAt: today, status: 'completed', phases: [], decisions: [],
  }))
  for (const record of [alphaRun, betaRun, defaultRun, foreignRun, childRun, decomposeRun, ownerOnlyRun, scheduledRun, ...todayRuns, ...phaseRuns]) await store.write(record)

  const sessions = [
    { sessionId: 'session-default', cwd: consoleRoot, updatedAt: 4 },
    { sessionId: 'session-alpha', cwd: alphaRoot, updatedAt: 3 },
    { sessionId: 'session-beta', cwd: betaRoot, updatedAt: 2 },
    { sessionId: 'session-foreign', cwd: foreignRoot, updatedAt: 5 },
    { sessionId: 'session-child', cwd: alphaRoot, parentSessionId: 'session-alpha', updatedAt: 6 },
  ]
  const controller = {
    list: async () => ({ items: sessions }),
    create: async () => { throw new Error('not used') },
    prompt: async () => { throw new Error('not used') },
    follow: async () => { throw new Error('not used') },
  }
  const disposers = []
  const ctx = {
    tools: { register: () => {} },
    get: service => service === 'sessionController' ? controller : undefined,
    effect: execute => {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  let discovery
  try {
    apply(ctx, { stateDir: state, consoleRoot, consolePort: 0, notifyOnComplete: false })
    discovery = await waitForJson(path.join(state, 'console.json'))
    const request = async (route, options = {}) => {
      const response = await fetch(`${discovery.url}/api/console${route}`, {
        ...options,
        headers: { authorization: `Bearer ${discovery.token}`, ...(options.headers ?? {}) },
      })
      const json = await response.json()
      return { status: response.status, json }
    }

    const listed = await request('/artifacts')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.json.data.artifacts.map(item => item.runId).sort(), ['run-alpha-1', 'run-beta-1', 'run-default-1'])
    assert.equal(listed.json.data.nextCursor, null)
    assert.equal(listed.json.data.artifacts.find(item => item.runId === 'run-default-1').project, null)
    assert.deepEqual(listed.json.data.artifacts.find(item => item.runId === 'run-alpha-1').project, { name: 'alpha', cwd: alphaRoot })
    assert.equal((await request('/artifacts?project=alpha')).json.data.artifacts.length, 1)
    const globalWorkbench = await request('/workbench?scope=global')
    assert.equal(globalWorkbench.status, 200)
    assert.ok(globalWorkbench.json.data.runs.some(item => item.id === 'run-alpha-1'))
    assert.ok(globalWorkbench.json.data.runs.some(item => item.id === 'run-beta-1'))
    assert.ok(globalWorkbench.json.data.runs.some(item => item.id === 'run-default-1'))
    assert.equal(globalWorkbench.json.data.summary.completed, 26, 'today summary counts all runs and goals without double-counting goal phases')
    const ownerDetail = await request('/runs/run-owner-only?owner=session-alpha')
    assert.equal(ownerDetail.status, 200)
    assert.equal(ownerDetail.json.data.parentSessionId, 'session-alpha')
    const schedules = await request('/schedules')
    const scheduled = schedules.json.data.sessions.flatMap(session => session.rows ?? []).find(item => item.id === 'run-scheduled-1')
    assert.equal(scheduled?.origin?.kind, 'scheduled')
    assert.equal((await request('/artifacts?limit=0')).status, 400)
    assert.equal((await request('/artifacts', { method: 'POST' })).status, 405)
    assert.equal((await request('/artifacts', { headers: { authorization: 'Bearer wrong' } })).status, 401)

    const alpha = listed.json.data.artifacts.find(item => item.runId === 'run-alpha-1')
    const detail = await request(`/artifacts/${encodeURIComponent(alpha.id)}`)
    assert.equal(detail.status, 200)
    assert.deepEqual(detail.json.data.artifact, alpha)
    assert.equal(detail.json.data.run.artifacts[0].kind, 'report')
    assert.equal(detail.json.data.run.artifacts[0].path, alphaPath)

    const changed = await store.read(alphaRun.id)
    changed.artifacts[0].bytes = 999
    changed.goal = 'Alpha release updated on disk'
    await store.write(changed)
    const reread = await request(`/artifacts/${encodeURIComponent(alpha.id)}`)
    assert.equal(reread.json.data.artifact.bytes, 999)
    assert.equal(reread.json.data.run.goal, 'Alpha release updated on disk')

    const foreignId = listArtifacts([foreignRun], { 'session-foreign': { name: 'foreign', cwd: foreignRoot } }).artifacts[0].id
    assert.equal((await request(`/artifacts/${encodeURIComponent(foreignId)}`)).status, 404)
    assert.equal((await request('/artifacts/not-an-artifact-id')).status, 404)
    assert.equal((await request('/artifacts/%E0%A4%A')).status, 400)
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

async function waitForJson(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}
