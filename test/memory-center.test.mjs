import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createMemory } from '../lib/memory.js'
import { createMemoryCenter, MEMORY_CENTER_TYPES, MemoryCenterError } from '../lib/memory-center.js'

const DATE = '2026-11-20T10:00:00.000Z'
const LATER = '2026-11-21T10:00:00.000Z'
const copy = value => JSON.parse(JSON.stringify(value))
const codeOf = code => error => error instanceof MemoryCenterError && error.code === code

function fakeUserMemory(initial = []) {
  const records = copy(initial)
  return {
    records,
    async list({ category }) {
      return { entries: copy(records.filter(record => record.category === category)), path: 'C:\\private\\profile.jsonl' }
    },
    async update(request) {
      const record = records.find(item => item.category === request.category && item.key === request.key)
      if (!record) throw Object.assign(new Error('missing C:\\private\\profile.jsonl'), { code: 'NOT_FOUND' })
      if (request.expectedRevision !== undefined && request.expectedRevision !== record.revision) {
        throw Object.assign(new Error('conflict C:\\private\\profile.jsonl'), { code: 'REVISION_CONFLICT' })
      }
      if (request.patch.body !== undefined) {
        if (record.category === 'decision') record.body = request.patch.body
        else record.text = request.patch.body
      }
      if (request.patch.title !== undefined) record.title = request.patch.title
      if (request.patch.tags !== undefined) record.tags = copy(request.patch.tags)
      record.revision += 1
      record.updatedAt = LATER
      return { entry: copy(record) }
    },
    async record({ category, entry }) {
      const prior = records.find(item => item.category === category && item.key === entry.key)
      if (prior) {
        prior.text = entry.text
        prior.tags = copy(entry.tags)
        prior.revision += 1
        prior.updatedAt = LATER
        return { written: 1 }
      }
      records.push({ id: `${category}-${records.length}`, category, ...copy(entry), revision: 1, ts: DATE })
      return { written: 1 }
    },
    async forget({ category, key, expectedRevision }) {
      const index = records.findIndex(item => item.category === category && item.key === key)
      if (index < 0) return { deleted: 0 }
      if (expectedRevision !== undefined && expectedRevision !== records[index].revision) {
        throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' })
      }
      records.splice(index, 1)
      return { deleted: 1 }
    },
  }
}

function fakeMemory(initial = []) {
  const notes = copy(initial)
  return {
    notes,
    async list() { return { entries: copy(notes), path: '/private/state/memory.jsonl' } },
    async set({ scope, key, text, tags, expectedRevision, kind = 'note' }) {
      const prior = notes.find(item => item.scope === scope && item.key === key && item.status !== 'retracted')
      if (prior && expectedRevision !== undefined && expectedRevision !== prior.revision) {
        throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' })
      }
      if (prior) {
        prior.text = text
        prior.tags = copy(tags)
        prior.revision += 1
        prior.updatedAt = LATER
        return { written: 1 }
      }
      notes.push({ key, scope, kind, text, tags: copy(tags), status: 'active', revision: 1, ts: DATE })
      return { written: 1 }
    },
    async forget({ scope, key, expectedRevision }) {
      const prior = notes.find(item => item.scope === scope && item.key === key && item.status !== 'retracted')
      if (!prior) return { forgotten: false }
      if (expectedRevision !== undefined && expectedRevision !== prior.revision) {
        throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' })
      }
      notes.push({ key, scope, kind: 'note', text: '', tags: [], status: 'retracted', revision: prior.revision + 1, ts: LATER })
      return { forgotten: true, revision: prior.revision + 1 }
    },
  }
}

function fakeRouter(initial = []) {
  const facts = copy(initial)
  return {
    facts,
    async snapshot() { return { revision: 9, facts: copy(facts), path: 'C:\\private\\router.json' } },
    async update(request) {
      const fact = facts.find(item => item.id === request.recordId)
      if (!fact) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
      if (request.expectedRevision !== undefined && request.expectedRevision !== fact.revision) {
        throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' })
      }
      if (request.operation === 'forget') {
        fact.revoked = true
        fact.status = 'revoked'
      } else {
        if (request.patch.body !== undefined) fact.value = request.patch.body
        if (request.patch.title !== undefined) fact.subject = request.patch.title
        if (request.patch.tags !== undefined) fact.tags = copy(request.patch.tags)
      }
      fact.revision += 1
      fact.updatedAt = LATER
      return { entry: copy(fact) }
    },
  }
}

function fakeLongGoal(goals) {
  return { async list() { return { goals: copy(goals), path: '/private/goals' } } }
}

function fixture() {
  const userMemory = fakeUserMemory([
    { key: 'runtime', category: 'fact', text: 'Runtime is Node 24', tags: ['stack'], revision: 1, ts: DATE },
    { key: 'brevity', category: 'preference', text: 'Prefer concise Chinese answers', tags: ['style', 'language'], revision: 2, ts: DATE },
    { key: 'storage', category: 'decision', choice: 'SQLite', rejected: 'JSON files', reason: 'Transactional updates',
      rollback: 'Export first', tags: ['storage'], origin: 'user', project: 'release', taskId: 'task-a', phaseId: 'p1',
      revision: 1, ts: DATE },
    { key: 'unsafe-user-decision', category: 'decision', choice: 'Guess', reason: 'No scope', origin: 'run', revision: 1, ts: DATE },
  ])
  const memory = fakeMemory([
    { key: 'windows-lock', scope: 'default', kind: 'pitfall', text: 'Windows rename can fail while a file is open',
      tags: ['windows', 'release'], revision: 4, ts: DATE, payload: { secret: 'do not expose' } },
  ])
  const router = fakeRouter([
    { id: 'decision-a', kind: 'decision', key: 'channel', subject: '发布渠道', value: 'stable',
      tags: ['release'], origin: 'user', source: 'user-message', project: 'release', taskId: 'task-a', phaseId: 'p1',
      revision: 3, confirmedAt: DATE, payload: { token: 'private' } },
    { id: 'decision-b', kind: 'decision', key: 'channel', subject: '发布渠道', value: 'beta',
      tags: ['release'], origin: 'user', source: 'user-message', project: 'release', taskId: 'task-a', phaseId: 'p2',
      revision: 1, confirmedAt: LATER },
    { id: 'decision-foreign', kind: 'decision', key: 'channel', subject: '发布渠道', value: 'foreign',
      origin: 'user', project: 'other', taskId: 'task-b', phaseId: 'p1', revision: 1, confirmedAt: LATER },
    { id: 'decision-run', kind: 'decision', key: 'generated', subject: '生成决定', value: 'not user approved',
      origin: 'run', project: 'release', taskId: 'task-a', phaseId: 'p1', revision: 1, confirmedAt: DATE },
    { id: 'evidence-a', kind: 'evidence', subject: 'Tests', value: '42 passed', origin: 'run', source: 'run',
      project: 'release', taskId: 'task-a', phaseId: 'p1', revision: 1, observedAt: DATE,
      payload: { command: 'C:\\secret\\test.exe' }, absolutePath: 'C:\\secret\\test.exe' },
    { id: 'source-a', kind: 'source', subject: 'Repository', value: 'upstream', origin: 'external', source: 'github',
      project: 'release', taskId: 'task-a', phaseId: 'p1', revision: 1, observedAt: DATE, payload: { webhook: 'private' } },
    { id: 'alias-a', kind: 'alias', subject: 'Alias', value: '发版', origin: 'user', source: 'user-message',
      project: 'release', taskId: 'task-a', phaseId: null, revision: 1, confirmedAt: DATE },
  ])
  const longGoal = fakeLongGoal([
    { id: 'g-release', project: 'release', cwd: 'C:\\Users\\alice\\workspace', projectRules: [
      'Never edit D:\\Users\\alice\\generated directly or /etc/superagent/private',
      { id: 'rule-2', body: 'Keep relative repository paths', tags: ['paths'] },
    ], decisions: [
      { id: 'd1', phaseId: 'p2', question: 'Retry the failed phase?', answer: 'retry', answeredAt: LATER,
        source: { runId: 'run-1', payload: 'private' } },
    ] },
    { id: 'g-other', project: 'other', projectRules: ['Other project only'], decisions: [] },
  ])
  const center = createMemoryCenter({ memory, userMemory, router, longGoal })
  return { center, memory, userMemory, router, longGoal }
}

async function one(result) {
  const view = await result
  assert.equal(view.entries.length, 1)
  return view.entries[0]
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, codeOf(code))
}

test('snapshot classifies every owner into an allow-listed descriptor without paths or payloads', async () => {
  const { center } = fixture()
  const view = await center.snapshot()
  assert.equal(view.enabled, true)
  assert.equal(view.disabled, false)
  assert.equal(view.total, 16)
  assert.deepEqual(new Set(view.entries.map(entry => entry.type)), new Set(MEMORY_CENTER_TYPES))
  assert.deepEqual(Object.keys(view.sources), ['project-rules', 'user-memory', 'memory', 'router', 'long-goal'])
  assert.ok(Object.values(view.sources).every(source => source.status === 'ready'))

  const fields = ['id', 'type', 'title', 'body', 'tags', 'scope', 'project', 'task', 'phase', 'origin', 'source',
    'createdAt', 'updatedAt', 'status', 'editable', 'forgettable', 'revision']
  for (const entry of view.entries) assert.deepEqual(Object.keys(entry).sort(), [...fields].sort())
  const serialised = JSON.stringify(view)
  assert.doesNotMatch(serialised, /alice|do not expose|webhook|private|absolutePath|payload|C:\\\\Users|\/etc\/|file:\/\//i)
  assert.match(serialised, /redacted-path/)
  assert.equal(view.facets.types['run-note'], 1)
  assert.equal(view.facets.types['goal-decision'], 1)
  assert.equal((await one(center.query({ type: 'goal-decision' }))).status, 'answered')
})

test('query isolates project, task, and phase and supports search, tags, and pagination', async () => {
  const { center } = fixture()
  const scoped = await center.snapshot({ type: 'work-decision', project: 'release', taskId: 'task-a', phaseId: 'p1', origin: 'user' })
  assert.deepEqual(scoped.entries.map(entry => entry.id), scoped.entries.filter(entry => entry.project === 'release'
    && entry.task === 'task-a' && entry.phase === 'p1' && entry.origin === 'user').map(entry => entry.id))
  assert.equal(scoped.total, 1)
  assert.equal(scoped.entries[0].body, 'stable')
  assert.equal((await center.query({ type: 'work-decision', project: 'release', task: 'task-a', phase: 'p2', origin: 'user' })).entries[0].body, 'beta')
  assert.equal((await center.query({ type: 'work-decision', project: 'other', task: 'task-b', phase: 'p1', origin: 'user' })).entries[0].body, 'foreign')

  const searched = await center.query({ search: 'WINDOWS rename', tags: ['windows'], type: 'run-note' })
  assert.equal(searched.total, 1)
  assert.equal(searched.entries[0].key, undefined)
  assert.equal(searched.entries[0].revision, 4)

  const first = await center.snapshot({ page: 1, pageSize: 4 })
  const second = await center.snapshot({ page: 2, pageSize: 4 })
  assert.equal(first.entries.length, 4)
  assert.equal(first.hasMore, true)
  assert.equal(first.pageCount, 4)
  assert.equal(second.page, 2)
  assert.ok(first.entries.every(entry => !second.entries.some(other => other.id === entry.id)))
  assert.equal((await center.snapshot({ page: 99, pageSize: 4 })).entries.length, 0)
  await rejectsCode(center.snapshot({ page: 0 }), 'INVALID_QUERY')
  await rejectsCode(center.snapshot({ type: 'payload' }), 'INVALID_QUERY')
})

test('only explicit writable types can change; user decisions need user origin and full scope', async () => {
  const { center, router } = fixture()
  for (const type of ['project-rule', 'evidence', 'source', 'alias', 'goal-decision']) {
    const entry = (await center.query({ type })).entries[0]
    assert.equal(entry.editable, false)
    assert.equal(entry.forgettable, false)
    await rejectsCode(center.update(entry.id, { body: 'tampered' }), 'READ_ONLY')
    await rejectsCode(center.forget(entry.id), 'READ_ONLY')
  }

  const userDecision = await one(center.query({ type: 'user-decision', search: 'SQLite' }))
  assert.equal(userDecision.editable, true)
  const updated = await center.update(userDecision.id, { body: 'choice: PostgreSQL; reason: Concurrency' }, { expectedRevision: 1 })
  assert.equal(updated.revision, 2)
  assert.match(updated.body, /PostgreSQL/)

  const runDecision = await one(center.query({ type: 'work-decision', search: 'not user approved' }))
  assert.equal(runDecision.editable, false)
  assert.equal(runDecision.forgettable, false)
  await rejectsCode(center.update(runDecision.id, { body: 'approved' }), 'READ_ONLY')
  await rejectsCode(center.forget(runDecision.id), 'READ_ONLY')

  const unscoped = await one(center.query({ type: 'user-decision', search: 'No scope' }))
  assert.equal(unscoped.editable, false)
  await rejectsCode(center.update(unscoped.id, { body: 'changed' }), 'READ_ONLY')
  await rejectsCode(center.update(userDecision.id, { origin: 'run', body: 'changed' }), 'INVALID_UPDATE')
  delete router.facts.find(fact => fact.id === 'decision-a').origin
  const unconfirmed = await one(center.query({ type: 'work-decision', search: 'stable' }))
  assert.equal(unconfirmed.origin, 'run')
  assert.equal(unconfirmed.editable, false)
  await rejectsCode(center.update(unconfirmed.id, { body: 'approved' }), 'READ_ONLY')
  assert.equal(router.facts.find(fact => fact.id === 'decision-run').value, 'not user approved')
})

test('corrections are versioned, stale writes conflict, and work decisions can be revoked', async () => {
  const { center, userMemory, router } = fixture()
  const preference = await one(center.query({ type: 'user-preference', search: 'concise Chinese' }))
  const corrected = await center.update({ id: preference.id, expectedRevision: preference.revision,
    patch: { body: 'Prefer concise English answers', tags: ['style', 'english'], title: 'Answer style' } })
  assert.equal(corrected.revision, preference.revision + 1)
  assert.equal(corrected.body, 'Prefer concise English answers')
  assert.deepEqual(corrected.tags, ['style', 'english'])
  assert.equal(userMemory.records.find(record => record.key === 'brevity').text, corrected.body)
  await rejectsCode(center.update(preference.id, { body: 'stale' }, { expectedRevision: preference.revision }), 'REVISION_CONFLICT')

  const decision = await one(center.query({ type: 'work-decision', project: 'release', task: 'task-a', phase: 'p1', origin: 'user' }))
  const changed = await center.update(decision.id, { body: 'canary' }, { expectedRevision: decision.revision })
  assert.equal(changed.body, 'canary')
  assert.equal(changed.revision, decision.revision + 1)
  const revoked = await center.forget(decision.id, { expectedRevision: changed.revision })
  assert.equal(revoked.mode, 'tombstone')
  assert.equal(revoked.status, 'revoked')
  assert.equal(router.facts.find(fact => fact.id === 'decision-a').revoked, true)
  assert.equal((await center.query({ id: decision.id })).total, 0)
  const withdrawn = await one(center.query({ id: decision.id, includeRetracted: true }))
  assert.equal(withdrawn.status, 'revoked')
  assert.equal(withdrawn.body, '')
})

test('user forgetting physically deletes while run forgetting leaves a content-free tombstone', async () => {
  const { center, userMemory, memory } = fixture()
  const fact = await one(center.query({ type: 'user-fact', search: 'Node 24' }))
  const removed = await center.forget({ id: fact.id, expectedRevision: fact.revision })
  assert.equal(removed.mode, 'physical')
  assert.equal(removed.status, 'deleted')
  assert.equal(userMemory.records.some(record => record.key === 'runtime'), false)
  assert.equal((await center.query({ id: fact.id, includeRetracted: true })).total, 0)

  const note = await one(center.query({ type: 'run-note', search: 'Windows rename' }))
  const forgotten = await center.forget(note.id, { expectedRevision: note.revision })
  assert.equal(forgotten.mode, 'tombstone')
  assert.equal(forgotten.status, 'retracted')
  assert.equal(forgotten.descriptor.body, '')
  assert.equal(memory.notes.filter(item => item.key === 'windows-lock').length, 2)
  assert.equal(memory.notes.at(-1).status, 'retracted')
  assert.equal(memory.notes.at(-1).text, '')
  assert.equal((await center.query({ id: note.id })).total, 0)
  assert.equal((await center.query({ id: note.id, status: 'retracted' })).total, 1)
})

test('run-note corrections keep one effective value and advance its revision', async () => {
  const { center, memory } = fixture()
  const note = await one(center.query({ type: 'run-note', search: 'Windows rename' }))
  const corrected = await center.update(note.id, { body: 'Windows rename retries with backoff', tags: ['windows', 'fixed'] },
    { expectedRevision: note.revision })
  assert.equal(corrected.revision, note.revision + 1)
  assert.equal(corrected.body, 'Windows rename retries with backoff')
  const all = await center.query({ type: 'run-note', includeRetracted: true })
  assert.equal(all.total, 1)
  assert.equal(memory.notes.length, 1)
})

test('concurrent updates to one descriptor serialize and the stale writer gets a revision conflict', async () => {
  const { center, userMemory } = fixture()
  const preference = await one(center.query({ type: 'user-preference', search: 'concise Chinese' }))
  const results = await Promise.allSettled([
    center.update(preference.id, { body: 'first correction' }, { expectedRevision: preference.revision }),
    center.update(preference.id, { body: 'second correction' }, { expectedRevision: preference.revision }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT')
  assert.equal(userMemory.records.find(record => record.key === 'brevity').revision, preference.revision + 1)
  assert.equal(userMemory.records.filter(record => record.key === 'brevity').length, 1)
})

test('independent facades still detect conflicts through the adapter revision', async () => {
  const userMemory = fakeUserMemory([
    { key: 'brevity', category: 'preference', text: 'short', tags: [], revision: 7, ts: DATE },
  ])
  const first = createMemoryCenter({ userMemory })
  const second = createMemoryCenter({ userMemory })
  const entry = await one(first.query({ type: 'user-preference' }))
  await first.update(entry.id, { body: 'new' }, { expectedRevision: 7 })
  await rejectsCode(second.update(entry.id, { body: 'stale' }, { expectedRevision: 7 }), 'REVISION_CONFLICT')
  assert.equal(userMemory.records[0].text, 'new')
})

test('independent centers reject a stale run-note edit through the real notebook store', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-memory-center-'))
  try {
    const memory = createMemory(root)
    await memory.set({ key: 'deploy', kind: 'decision', text: 'staging' })
    const first = createMemoryCenter({ memory })
    const second = createMemoryCenter({ memory })
    const firstView = await one(first.query({ type: 'run-note' }))
    const secondView = await one(second.query({ type: 'run-note' }))
    assert.equal(firstView.id, secondView.id)
    assert.equal(firstView.revision, 1)
    assert.equal(secondView.revision, 1)

    const updated = await first.update(firstView.id, { body: 'first center edit' }, { expectedRevision: 1 })
    assert.equal(updated.revision, 2)
    await rejectsCode(second.update(secondView.id, { body: 'stale center edit' }, { expectedRevision: 1 }), 'REVISION_CONFLICT')
    await rejectsCode(second.forget(secondView.id, { expectedRevision: 1 }), 'REVISION_CONFLICT')

    const stored = await memory.read()
    assert.equal(stored.entries.length, 1)
    assert.equal(stored.entries[0].text, 'first center edit')
    assert.equal(stored.entries[0].revision, 2)
    const refreshed = await one(second.query({ type: 'run-note' }))
    assert.equal(refreshed.body, 'first center edit')
    assert.equal(refreshed.revision, 2)
    const forgotten = await second.forget(refreshed.id, { expectedRevision: 2 })
    assert.equal(forgotten.revision, 3)
    assert.equal((await memory.read()).entries.length, 0)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('concurrent centers cannot both accept the same real notebook revision', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-memory-center-race-'))
  try {
    const memory = createMemory(root)
    await memory.set({ key: 'deploy', text: 'staging' })
    const first = createMemoryCenter({ memory })
    const second = createMemoryCenter({ memory })
    const firstView = await one(first.query({ type: 'run-note' }))
    const secondView = await one(second.query({ type: 'run-note' }))
    const results = await Promise.allSettled([
      first.update(firstView.id, { body: 'winning edit' }, { expectedRevision: 1 }),
      second.update(secondView.id, { body: 'stale edit' }, { expectedRevision: 1 }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = results.find(result => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'REVISION_CONFLICT')
    const accepted = results.find(result => result.status === 'fulfilled')
    const stored = await memory.read()
    assert.equal(stored.entries.length, 1)
    assert.equal(stored.entries[0].revision, 2)
    assert.equal(stored.entries[0].text, accepted.value.body)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('disabled and failing adapters are explicit and never leak adapter diagnostics', async () => {
  let calls = 0
  const adapter = { async list() { calls += 1; throw new Error('failed at C:\\secret\\payload.json') } }
  const disabled = createMemoryCenter({ userMemory: adapter, enabled: false })
  const off = await disabled.snapshot()
  assert.equal(calls, 0)
  assert.equal(off.enabled, false)
  assert.equal(off.disabled, true)
  assert.equal(off.reason, 'disabled')
  assert.ok(Object.values(off.sources).every(source => source.status === 'disabled'))

  const partial = createMemoryCenter({ userMemory: adapter, enabled: { 'user-memory': false } })
  assert.equal((await partial.snapshot()).sources['user-memory'].status, 'disabled')
  assert.equal(calls, 0)

  const { memory: notebook } = fixture()
  const selective = createMemoryCenter({ userMemory: fixture().userMemory, memory: notebook,
    enabled: { 'user-memory': false } })
  const selectiveView = await selective.snapshot()
  assert.equal(selectiveView.sources['user-memory'].status, 'disabled')
  assert.equal(selectiveView.sources.memory.status, 'ready')
  assert.deepEqual(new Set(selectiveView.entries.map(entry => entry.type)), new Set(['run-note']))

  const broken = createMemoryCenter({ userMemory: adapter })
  const view = await broken.snapshot()
  assert.equal(view.sources['user-memory'].status, 'error')
  assert.doesNotMatch(JSON.stringify(view), /secret|payload|C:\\/)
  await rejectsCode(broken.update('mc_user_prereference_missing', { body: 'x' }), 'NOT_FOUND')
})

test('adapter conflict messages are reduced to a stable public error', async () => {
  const userMemory = fakeUserMemory([
    { key: 'brevity', category: 'preference', text: 'short', tags: [], revision: 1, ts: DATE },
  ])
  userMemory.update = async () => {
    throw Object.assign(new Error('conflict in C:\\secret\\profile.jsonl; payload=private'), { code: 'REVISION_CONFLICT' })
  }
  const center = createMemoryCenter({ userMemory })
  const entry = await one(center.query({ type: 'user-preference' }))
  await assert.rejects(center.update(entry.id, { body: 'new' }, { expectedRevision: 1 }), error => {
    assert.equal(error.code, 'REVISION_CONFLICT')
    assert.doesNotMatch(error.message, /secret|profile|payload|C:\\/)
    return true
  })
})
