import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  AGENT_ROLES,
  EXECUTION_ROLES,
  DEFAULT_AGENT_PROFILE,
  DEFAULT_ASSISTANT_ID,
  AgentProfile,
  AgentProfileConflictError,
  AgentProfileStore,
  AgentProfileError,
  createAgentProfileStore,
  initializeAgentProfiles,
  openAgentProfileStore,
  redactAgentProfile,
  validateAgentProfile,
} from '../lib/agent-profiles.js'

const execFileAsync = promisify(execFile)
const MODULE_URL = new URL('../lib/agent-profiles.js', import.meta.url).href

const PROFILE_FIELDS = [
  'id', 'name', 'avatar', 'role', 'model', 'provider', 'tools', 'permissions',
  'memoryScope', 'workspaceScope', 'enabled', 'revision',
]

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-agent-profiles-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'nested', 'agent-profiles.json')
  const store = createAgentProfileStore({ file, ...options })
  return { root, file, store }
}

function hasCode(code, field) {
  return error => error instanceof AgentProfileError && error.code === code && (!field || error.field === field)
}

function worker(id = 'worker-1', extra = {}) {
  return {
    id,
    name: 'Worker One',
    role: 'worker',
    tools: ['read_file'],
    permissions: ['workspace.read'],
    memoryScope: 'project',
    workspaceScope: 'project',
    ...extra,
  }
}

test('AgentProfile has the complete canonical shape and is immutable', () => {
  const profile = new AgentProfile(worker())
  assert.deepEqual(Object.keys(profile), PROFILE_FIELDS)
  assert.equal(profile.revision, 1)
  assert.equal(profile.enabled, true)
  assert.ok(Object.isFrozen(profile))
  assert.ok(Object.isFrozen(profile.tools))
  assert.throws(() => { profile.name = 'changed' }, TypeError)
  const snapshot = profile.snapshot()
  snapshot.tools.push('write_file')
  assert.deepEqual(profile.tools, ['read_file'])
  assert.deepEqual(validateAgentProfile(worker()), profile.toJSON())
  assert.ok(AGENT_ROLES.includes('executor'))
})

test('first operation creates one default global assistant, shared across store instances', async t => {
  const { file, store } = await fixture(t)
  await assert.rejects(fsp.access(path.dirname(file)), { code: 'ENOENT' })
  const profile = await store.getDefault()
  assert.deepEqual(profile, DEFAULT_AGENT_PROFILE)
  assert.deepEqual(Object.keys(profile), PROFILE_FIELDS)
  assert.equal(profile.id, DEFAULT_ASSISTANT_ID)
  assert.equal(profile.workspaceScope, 'global')
  assert.equal(profile.memoryScope, 'global')
  assert.equal(profile.revision, 1)

  const reopened = openAgentProfileStore({ file })
  assert.deepEqual(await reopened.getDefaultAssistant(), profile)
  assert.deepEqual(await reopened.listAssistants(), [profile])
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { version: 1, profiles: [profile] })
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['agent-profiles.json'])
})

test('assistant creation is limited to the existing reserved global assistant', async t => {
  const { file, store } = await fixture(t)
  const initial = await store.getDefault()
  const before = await fsp.readFile(file, 'utf8')

  await assert.rejects(store.create({
    id: 'project-assistant', role: 'assistant', workspaceScope: 'project', memoryScope: 'project',
  }), hasCode('ASSISTANT_EXISTS', 'id'))
  await assert.rejects(store.create({
    id: DEFAULT_ASSISTANT_ID, role: 'assistant', workspaceScope: 'project', memoryScope: 'project',
  }), hasCode('INVALID_PROFILE', 'workspaceScope'))
  await assert.rejects(store.create({
    id: 'second-assistant', role: 'assistant', workspaceScope: 'global', memoryScope: 'global',
  }), hasCode('ASSISTANT_EXISTS', 'id'))
  await assert.rejects(store.create({ name: 'Another Global', role: 'assistant' }), hasCode('ASSISTANT_EXISTS'))

  assert.deepEqual(await store.listAssistants(), [initial])
  assert.deepEqual(await store.listProjectAssistants(), [])
  assert.equal(await fsp.readFile(file, 'utf8'), before)
})

test('the default assistant cannot change its role or global workspace and memory scopes', async t => {
  const { file, store } = await fixture(t)
  const initial = await store.getDefault()
  const before = await fsp.readFile(file, 'utf8')

  await assert.rejects(
    store.update(DEFAULT_ASSISTANT_ID, { role: 'worker' }, { expectedRevision: 1 }),
    hasCode('IMMUTABLE_FIELD', 'role'),
  )
  await assert.rejects(
    store.update(DEFAULT_ASSISTANT_ID, { workspaceScope: 'project' }, { expectedRevision: 1 }),
    hasCode('DEFAULT_PROFILE_IMMUTABLE', 'workspaceScope'),
  )
  await assert.rejects(
    store.update(DEFAULT_ASSISTANT_ID, { memoryScope: 'project' }, { expectedRevision: 1 }),
    hasCode('DEFAULT_PROFILE_IMMUTABLE', 'memoryScope'),
  )

  assert.deepEqual(await store.getDefault(), initial)
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  const renamed = await store.update(DEFAULT_ASSISTANT_ID, { name: 'Renamed Global' }, { expectedRevision: 1 })
  assert.equal(renamed.role, 'assistant')
  assert.equal(renamed.workspaceScope, 'global')
  assert.equal(renamed.memoryScope, 'global')
  assert.equal(renamed.revision, 2)
})

test('execution roles can be created and listed without appearing in either assistant UI feed', async t => {
  const { store } = await fixture(t)
  const profiles = await Promise.all(EXECUTION_ROLES.map(role =>
    store.create({ id: `${role}-1`, name: role, role })))
  assert.deepEqual(profiles.map(profile => profile.role), EXECUTION_ROLES)
  assert.equal((await store.listExecutors()).length, EXECUTION_ROLES.length)
  assert.deepEqual(await store.listProjectAssistants(), [])
  assert.deepEqual((await store.listAssistants()).map(item => item.id), [DEFAULT_ASSISTANT_ID])
  assert.ok((await store.list({ role: 'executor' })).every(item => item.role === 'executor'))
})

test('CRUD increments revisions, supports optimistic patches, and rejects stale updates and deletes', async t => {
  const { file, store } = await fixture(t)
  const created = await store.create(worker('worker-1', { revision: 99 }))
  assert.equal(created.revision, 1)
  assert.deepEqual(await store.get(created.id), created)
  const updated = await store.update(created.id, { name: 'Worker Renamed' }, { expectedRevision: 1 })
  assert.equal(updated.name, 'Worker Renamed')
  assert.equal(updated.revision, 2)
  assert.equal(updated.id, created.id)

  await assert.rejects(
    store.update(created.id, { name: 'Stale' }, { expectedRevision: 1 }),
    error => error instanceof AgentProfileConflictError
      && error.code === 'REVISION_CONFLICT'
      && error.expectedRevision === 1
      && error.currentRevision === 2,
  )
  await assert.rejects(store.remove(created.id, { expectedRevision: 1 }), hasCode('REVISION_CONFLICT'))

  // A previously returned snapshot can itself serve as the optimistic patch.
  const patched = await store.update(created.id, { ...updated, avatar: 'worker' })
  assert.equal(patched.revision, 3)
  assert.equal(patched.avatar, 'worker')
  const removed = await store.remove(created.id, 3)
  assert.equal(removed.revision, 3)
  await assert.rejects(store.get(created.id), hasCode('PROFILE_NOT_FOUND'))
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).profiles.length, 1)
})

test('numeric and object update options work, while immutable identity fields are protected', async t => {
  const { store } = await fixture(t)
  const created = await store.create(worker())
  const updated = await store.update(created.id, { model: 'model-a', provider: 'route-a' }, 1)
  assert.equal(updated.revision, 2)
  assert.equal(updated.model, 'model-a')
  assert.equal(updated.provider, 'route-a')
  await assert.rejects(store.update(created.id, { id: 'other' }, { expectedRevision: 2 }), hasCode('IMMUTABLE_FIELD', 'id'))
  await assert.rejects(store.update(created.id, { role: 'assistant' }, { expectedRevision: 2 }), hasCode('IMMUTABLE_FIELD', 'role'))
  await assert.rejects(store.update(created.id, { apiKey: 'sk-never-persist-this' }, { expectedRevision: 2 }), hasCode('INVALID_PROFILE', 'patch.apiKey'))
  await assert.rejects(store.update(created.id, { enabled: 'false' }, { expectedRevision: 2 }), hasCode('INVALID_PROFILE', 'enabled'))
  await assert.rejects(store.update(created.id, { revision: undefined }, { expectedRevision: 2 }), hasCode('INVALID_PROFILE', 'expectedRevision'))
  assert.equal((await store.get(created.id)).revision, 2)
})

test('two stores updating the same revision produce exactly one winner and one conflict', async t => {
  const { file } = await fixture(t)
  const left = createAgentProfileStore({ file })
  const right = createAgentProfileStore({ file })
  const created = await left.create(worker())
  const results = await Promise.allSettled([
    left.update(created.id, { name: 'Left Wins' }, { expectedRevision: 1 }),
    right.update(created.id, { name: 'Right Loses' }, { expectedRevision: 1 }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'REVISION_CONFLICT')
  assert.equal(rejected.reason.currentRevision, 2)
  const final = await right.get(created.id)
  assert.equal(final.revision, 2)
  assert.ok(['Left Wins', 'Right Loses'].includes(final.name))
})

test('concurrent creates and unconditional updates are serialized without partial JSON or lost profiles', async t => {
  const { file } = await fixture(t)
  const stores = Array.from({ length: 8 }, () => createAgentProfileStore({ file }))
  await stores[0].initialize()
  const reading = (async () => {
    for (let index = 0; index < 60; index++) {
      const document = JSON.parse(await fsp.readFile(file, 'utf8'))
      assert.equal(document.version, 1)
      assert.ok(Array.isArray(document.profiles))
      assert.ok(document.profiles.some(profile => profile.id === DEFAULT_ASSISTANT_ID))
    }
  })()
  const creates = stores.map((store, index) => store.create(worker(`worker-${index}`)))
  const created = await Promise.all(creates)
  await reading
  assert.equal((await stores[0].list({ includeDisabled: true })).length, 9)

  const target = created[0]
  await Promise.all(stores.map((store, index) => store.update(target.id, {
    ...(index === 0 ? { name: 'Concurrent Name' } : {}),
    ...(index === 1 ? { model: 'concurrent-model' } : {}),
    ...(index === 2 ? { provider: 'concurrent-route' } : {}),
  })))
  const final = await stores[0].get(target.id)
  assert.equal(final.name, 'Concurrent Name')
  assert.equal(final.model, 'concurrent-model')
  assert.equal(final.provider, 'concurrent-route')
  assert.equal(final.revision, 9)
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['agent-profiles.json'])
})

test('cross-process updates use the file lock and produce one revision winner', async t => {
  const { file, store } = await fixture(t)
  const created = await store.create(worker('cross-process'))
  const program = `
    const [file, id, name] = process.argv.slice(1)
    const { createAgentProfileStore } = await import(${JSON.stringify(MODULE_URL)})
    try {
      const profile = await createAgentProfileStore({ file }).update(id, { name }, { expectedRevision: 1 })
      console.log(JSON.stringify({ ok: true, revision: profile.revision }))
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code, current: error.currentRevision ?? null, message: error.message }))
      if (error.code !== 'REVISION_CONFLICT') process.exitCode = 2
    }
  `
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) =>
    execFileAsync(process.execPath, ['--input-type=module', '-e', program, file, created.id, `Process ${index}`])))
  const outcomes = results.map(result => JSON.parse(result.stdout.trim()))
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1)
  assert.equal(outcomes.filter(outcome => !outcome.ok && outcome.code === 'REVISION_CONFLICT').length, 3)
  assert.ok(outcomes.filter(outcome => !outcome.ok).every(outcome => outcome.current === 2))
  assert.equal((await store.get(created.id)).revision, 2)
})

test('tool and permission whitelists reject unknown, duplicate, and over-capacity entries', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.create(worker('bad-tool', { tools: ['delete_everything'] })), hasCode('TOOL_NOT_ALLOWED', 'tools[0]'))
  await assert.rejects(store.create(worker('bad-permission', { permissions: ['root'] })), hasCode('PERMISSION_NOT_ALLOWED', 'permissions[0]'))
  await assert.rejects(store.create(worker('duplicate-tool', { tools: ['read_file', 'read_file'] })), hasCode('INVALID_PROFILE', 'tools[1]'))
  await assert.rejects(store.create(worker('duplicate-permission', { permissions: ['workspace.read', 'workspace.read'] })), hasCode('INVALID_PROFILE', 'permissions[1]'))
  await assert.rejects(store.create(worker('too-many', { tools: Array(65).fill('read_file') })), hasCode('INVALID_PROFILE', 'tools'))
  assert.deepEqual((await store.list({ includeDisabled: true })).map(item => item.id), [DEFAULT_ASSISTANT_ID])
})

test('a configured whitelist admits custom capabilities but never broadens it implicitly', async t => {
  const { store } = await fixture(t, {
    allowedTools: ['read_file', 'custom.inspect'],
    allowedPermissions: ['workspace.read', 'custom.audit'],
  })
  const created = await store.create(worker('custom-1', {
    tools: ['custom.inspect'], permissions: ['custom.audit'],
  }))
  assert.deepEqual(created.tools, ['custom.inspect'])
  assert.deepEqual(created.permissions, ['custom.audit'])
  await assert.rejects(store.update(created.id, { tools: ['write_file'] }, { expectedRevision: 1 }), hasCode('TOOL_NOT_ALLOWED'))
  await assert.rejects(store.update(created.id, { permissions: ['memory.global'] }, { expectedRevision: 1 }), hasCode('PERMISSION_NOT_ALLOWED'))

  const narrow = await fixture(t, { allowedTools: [], allowedPermissions: [] })
  const defaultProfile = await narrow.store.getDefault()
  assert.deepEqual(defaultProfile.tools, [])
  assert.deepEqual(defaultProfile.permissions, [])
})

test('execution profiles cannot hold profile-management or agent-spawning capabilities', async t => {
  const { store } = await fixture(t)
  await assert.rejects(store.create(worker('managed', { permissions: ['profiles.manage'] })), hasCode('PERMISSION_NOT_ALLOWED', 'permissions'))
  await assert.rejects(store.create(worker('spawner', { permissions: ['agents.spawn'] })), hasCode('PERMISSION_NOT_ALLOWED', 'permissions'))
  await assert.rejects(store.create(worker('starter', { tools: ['superagent_start'] })), hasCode('TOOL_NOT_ALLOWED', 'tools'))
  await assert.rejects(store.create(worker('manager', { tools: ['profile_create'] })), hasCode('TOOL_NOT_ALLOWED', 'tools'))
})

test('worker principals cannot create, edit, disable, elevate, or delete profiles', async t => {
  const { file, store } = await fixture(t)
  const created = await store.create(worker())
  const before = await fsp.readFile(file, 'utf8')
  const actor = { role: 'worker', profileId: created.id }
  await assert.rejects(store.create(worker('self-created'), { actor }), hasCode('WORKER_FORBIDDEN'))
  await assert.rejects(store.update(created.id, { permissions: ['profiles.manage'] }, { actor, expectedRevision: 1 }), hasCode('WORKER_FORBIDDEN'))
  await assert.rejects(store.update(created.id, { tools: ['write_file'] }, { actor, expectedRevision: 1 }), hasCode('WORKER_FORBIDDEN'))
  await assert.rejects(store.disable(created.id, { actor, expectedRevision: 1 }), hasCode('WORKER_FORBIDDEN'))
  await assert.rejects(store.remove(created.id, { actor, expectedRevision: 1 }), hasCode('WORKER_FORBIDDEN'))
  await assert.rejects(store.create(worker('reviewer-created'), { actor: 'reviewer:self' }), hasCode('WORKER_FORBIDDEN'))
  assert.equal(await fsp.readFile(file, 'utf8'), before)

  // A trusted operator may assign execution capabilities; the restriction is
  // specifically against a worker changing its own authority.
  const elevated = await store.update(created.id, { permissions: ['shell.execute'] }, { actor: 'admin', expectedRevision: 1 })
  assert.deepEqual(elevated.permissions, ['shell.execute'])
})

test('worker read access is limited to its own identified profile', async t => {
  const { store } = await fixture(t)
  const mine = await store.create(worker('mine'))
  await store.create(worker('theirs'))
  const actor = { type: 'worker', id: mine.id }
  assert.deepEqual(await store.get(mine.id, { actor }), mine)
  await assert.rejects(store.get('theirs', { actor }), hasCode('WORKER_FORBIDDEN'))
  await assert.rejects(store.get(DEFAULT_ASSISTANT_ID, { actor }), hasCode('WORKER_FORBIDDEN'))
  await assert.rejects(store.get(DEFAULT_ASSISTANT_ID, { actor: { role: 'worker', id: DEFAULT_ASSISTANT_ID } }), hasCode('WORKER_FORBIDDEN'))
  assert.deepEqual((await store.list({ actor })).map(item => item.id), ['mine'])
  assert.deepEqual((await store.listExecutors({ actor })).map(item => item.id), ['mine'])
  assert.deepEqual(await store.list({ actor: 'worker' }), [])
  await assert.rejects(store.list({ actor: { role: 'root' } }), hasCode('ACTOR_FORBIDDEN'))
})

test('memory and workspace scopes are strict, filterable, and preserved on restart', async t => {
  const { file, store } = await fixture(t)
  await assert.rejects(store.create(worker('bad-memory', { memoryScope: 'everywhere' })), hasCode('INVALID_PROFILE', 'memoryScope'))
  await assert.rejects(store.create(worker('bad-workspace', { workspaceScope: 1 })), hasCode('INVALID_PROFILE', 'workspaceScope'))
  const scoped = await store.create(worker('scoped', { memoryScope: 'none', workspaceScope: 'none' }))
  assert.equal(scoped.memoryScope, 'none')
  assert.equal(scoped.workspaceScope, 'none')
  assert.deepEqual(await store.list({ memoryScope: 'none', workspaceScope: 'none' }), [scoped])
  assert.deepEqual(await store.list({ memoryScope: 'global' }), [DEFAULT_AGENT_PROFILE])

  const reopened = createAgentProfileStore({ file })
  assert.deepEqual(await reopened.get(scoped.id), scoped)
  await assert.rejects(
    reopened.update(DEFAULT_ASSISTANT_ID, { memoryScope: 'project' }, { expectedRevision: 1 }),
    hasCode('DEFAULT_PROFILE_IMMUTABLE'),
  )
  await assert.rejects(
    reopened.update(DEFAULT_ASSISTANT_ID, { workspaceScope: 'project' }, { expectedRevision: 1 }),
    hasCode('DEFAULT_PROFILE_IMMUTABLE'),
  )
})

test('disabled profiles persist, disappear from default UI feeds, and cannot be resolved for execution', async t => {
  const { file, store } = await fixture(t)
  const created = await store.create(worker('disabled', { enabled: false }))
  assert.deepEqual(await store.list(), [DEFAULT_AGENT_PROFILE])
  assert.deepEqual(await store.listExecutors(), [])
  assert.deepEqual(await store.list({ includeDisabled: true, enabled: false }), [created])
  assert.deepEqual(await store.get(created.id), created)
  await assert.rejects(store.getEnabled(created.id), hasCode('PROFILE_DISABLED'))
  await assert.rejects(store.snapshot(created.id), hasCode('PROFILE_DISABLED'))
  assert.deepEqual(await store.snapshot(created.id, { includeDisabled: true }), created)

  const reopened = createAgentProfileStore({ file })
  assert.equal((await reopened.get(created.id)).enabled, false)
  const enabled = await reopened.enable(created.id, { expectedRevision: 1 })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.revision, 2)
  assert.deepEqual(await reopened.getEnabled(created.id), enabled)
  const disabled = await reopened.disable(created.id, { expectedRevision: 2 })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.revision, 3)
  assert.deepEqual(await reopened.list(), [DEFAULT_AGENT_PROFILE])
})

test('the default assistant may be disabled but not deleted and remains unique while disabled', async t => {
  const { store } = await fixture(t)
  const disabled = await store.disable(DEFAULT_ASSISTANT_ID, { expectedRevision: 1 })
  assert.equal(disabled.enabled, false)
  assert.deepEqual(await store.listAssistants(), [])
  assert.deepEqual(await store.listAssistants({ includeDisabled: true }), [disabled])
  await assert.rejects(store.remove(DEFAULT_ASSISTANT_ID, { expectedRevision: 2 }), hasCode('DEFAULT_PROFILE_IMMUTABLE'))
  await assert.rejects(store.create({ role: 'assistant' }), hasCode('ASSISTANT_EXISTS'))
  assert.deepEqual(await store.getDefault(), disabled)
})

test('profile snapshots are canonical, detached, redacted, and persistence rejects credentials', async t => {
  const { file, store } = await fixture(t)
  const secret = 'sk-live-1234567890abcdef'
  await assert.rejects(store.create({ ...worker(), apiKey: secret }), hasCode('INVALID_PROFILE', 'profile.apiKey'))
  await assert.rejects(store.create({ ...worker(), provider: { apiKey: secret } }), hasCode('INVALID_PROFILE', 'provider'))
  await assert.rejects(store.create({ ...worker(), name: secret }), hasCode('SECRET_REJECTED', 'name'))
  await assert.rejects(store.create({ ...worker(), avatar: 'https://example.test/a.png?api_key=abc' }), hasCode('SECRET_REJECTED', 'avatar'))

  const created = await store.create(worker('safe', { model: 'model-a', provider: 'route-a' }))
  const snapshot = await store.snapshot(created.id)
  assert.deepEqual(Object.keys(snapshot), PROFILE_FIELDS)
  assert.equal(snapshot.apiKey, undefined)
  snapshot.tools.push('write_file')
  snapshot.permissions.push('profiles.manage')
  assert.deepEqual((await store.get(created.id)).tools, ['read_file'])
  assert.equal((await store.get(created.id)).revision, 1)

  const raw = await fsp.readFile(file, 'utf8')
  assert.equal(raw.includes(secret), false)
  assert.match(raw, /"provider": "route-a"/)
  const redacted = redactAgentProfile({
    ...created,
    apiKey: secret,
    credentials: { token: 'Bearer abcdefghijk' },
    note: `provider token=${secret}`,
    harmless: { label: 'visible' },
  })
  assert.equal(redacted.apiKey, '[REDACTED]')
  assert.equal(redacted.credentials, '[REDACTED]')
  assert.equal(redacted.note, '[REDACTED]')
  assert.deepEqual(redacted.harmless, { label: 'visible' })
  assert.equal(redactAgentProfile(null), null)
})

test('restart preserves all profile data and revisions without relying on process memory', async t => {
  const { file, store } = await fixture(t)
  const initialized = await initializeAgentProfiles({ file })
  assert.ok(initialized instanceof AgentProfileStore)
  const created = await store.create(worker('restart', {
    name: 'Before Restart', model: 'model-z', provider: 'route-z', enabled: false,
  }))
  const updated = await store.update(created.id, { name: 'After Restart' }, { expectedRevision: 1 })
  const reopened = createAgentProfileStore({ file })
  assert.deepEqual(await reopened.get(created.id), updated)
  assert.deepEqual(await reopened.getDefault(), DEFAULT_AGENT_PROFILE)
  assert.deepEqual(await reopened.list({ includeDisabled: true }), [DEFAULT_AGENT_PROFILE, updated])
  assert.equal(updated.revision, 2)
})

test('corrupt stores fail closed and are preserved byte-for-byte', async t => {
  const { file } = await fixture(t)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const broken = '{"version":1,"profiles":['
  await fsp.writeFile(file, broken)
  const store = createAgentProfileStore({ file })
  await assert.rejects(store.getDefault(), hasCode('CORRUPT_STORE'))
  await assert.rejects(store.create(worker()), hasCode('CORRUPT_STORE'))
  assert.equal(await fsp.readFile(file, 'utf8'), broken)
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['agent-profiles.json'])

  const withSecret = JSON.stringify({ version: 1, apiKey: 'sk-live-1234567890', profiles: [] })
  await fsp.writeFile(file, withSecret)
  await assert.rejects(createAgentProfileStore({ file }).list(), hasCode('CORRUPT_STORE'))
  assert.equal(await fsp.readFile(file, 'utf8'), withSecret)
})

test('capacity includes the default and disabled profiles, survives restart, and is released only by delete', async t => {
  const { file, store } = await fixture(t, { maxProfiles: 3 })
  await store.getDefault()
  const first = await store.create(worker('first'))
  const second = await store.create(worker('second', { enabled: false }))
  await assert.rejects(store.create(worker('overflow')), hasCode('CAPACITY_EXCEEDED'))
  assert.equal((await store.update(first.id, { name: 'Still Full' }, { expectedRevision: 1 })).name, 'Still Full')

  const reopened = createAgentProfileStore({ file, capacity: 3 })
  await assert.rejects(reopened.create(worker('restart-overflow')), hasCode('CAPACITY_EXCEEDED'))
  await assert.rejects(createAgentProfileStore({ file, capacity: 2 }).list(), hasCode('CAPACITY_EXCEEDED'))
  await reopened.remove(second.id, { expectedRevision: 1 })
  const replacement = await reopened.create(worker('replacement'))
  assert.equal(replacement.revision, 1)
  assert.equal((await reopened.list({ includeDisabled: true })).length, 3)
  assert.deepEqual((await reopened.list()).map(item => item.id).sort(), [DEFAULT_ASSISTANT_ID, 'first', 'replacement'].sort())
})

test('invalid options and malformed values are rejected before they can reach persistence', async t => {
  assert.throws(() => createAgentProfileStore({}), hasCode('INVALID_OPTIONS', 'file'))
  assert.throws(() => createAgentProfileStore({ file: 'x', maxProfiles: 0 }), hasCode('INVALID_OPTIONS', 'maxProfiles'))
  assert.throws(() => createAgentProfileStore({ file: 'x', allowedTools: 'read_file' }), hasCode('INVALID_PROFILE', 'allowedTools'))
  assert.throws(() => validateAgentProfile(null), hasCode('INVALID_PROFILE', 'profile'))
  assert.throws(() => validateAgentProfile({ role: 'root' }), hasCode('INVALID_PROFILE', 'role'))
  assert.throws(() => validateAgentProfile({ id: '../escape' }), hasCode('INVALID_PROFILE', 'id'))
  assert.throws(() => validateAgentProfile({ revision: 0 }), hasCode('INVALID_PROFILE', 'revision'))
  assert.throws(() => validateAgentProfile({ enabled: 1 }), hasCode('INVALID_PROFILE', 'enabled'))
  assert.throws(() => validateAgentProfile({ extra: true }), hasCode('INVALID_PROFILE', 'profile.extra'))
  assert.throws(() => validateAgentProfile(JSON.parse('{"__proto__":{"polluted":true}}')), hasCode('INVALID_PROFILE'))
  assert.equal({}.polluted, undefined)

  const { store } = await fixture(t)
  await assert.rejects(store.update('missing', { name: 'Nope' }), hasCode('PROFILE_NOT_FOUND'))
  await assert.rejects(store.remove('missing'), hasCode('PROFILE_NOT_FOUND'))
  assert.deepEqual(await store.list(), [DEFAULT_AGENT_PROFILE])
})
