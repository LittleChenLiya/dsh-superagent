import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createWorkspaceHostManager } from '../lib/workspace-host.js'

const BASE_COMMIT = 'a'.repeat(40)

async function fixture(t) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-host-'))
  t.after(() => fsp.rm(temporary, { recursive: true, force: true }))
  const boundary = path.join(temporary, 'session')
  await fsp.mkdir(boundary)
  const parent = { session: { header: { cwd: boundary } } }
  const calls = { create: [], restore: [], set: [], harvest: [], mergeAll: [], release: [] }
  let cwd = boundary
  let createError = null
  let restoreError = null
  let setError = null
  let createdPath = null
  const worktrees = {
    async create(agent, request) {
      calls.create.push({ agent, request })
      if (createError) throw createError
      const dir = createdPath ?? path.join(boundary, '.agents', 'worktrees', request.name)
      await fsp.mkdir(dir, { recursive: true })
      cwd = dir
      return { path: dir, branch: request.name, baseCommit: BASE_COMMIT, repositoryRoot: boundary }
    },
    async restore(agent, request) {
      calls.restore.push({ agent, request })
      if (restoreError) throw restoreError
      const stat = await fsp.stat(request.path).catch(error => {
        if (error?.code === 'ENOENT') return null
        throw error
      })
      if (stat) throw new Error('worktree path already exists')
      await fsp.mkdir(request.path, { recursive: true })
      return { path: request.path, branchRecreated: false }
    },
  }
  const workingDirectory = {
    defaultDirectory: boundary,
    get() { return cwd },
    async set(agent, dir) {
      calls.set.push({ agent, dir })
      if (setError) throw setError
      cwd = dir
      return dir
    },
  }
  const localManager = {
    async harvest(spec) {
      calls.harvest.push(spec)
      return { status: 'committed', files: ['answer.txt'], commit: 'abc123', detail: null }
    },
    async mergeAll(workers) {
      calls.mergeAll.push(workers)
      return workers.map(worker => ({ ...worker, status: 'merged', files: [], detail: null }))
    },
    async release(spec) { calls.release.push(spec) },
  }
  const stateFile = path.join(temporary, 'state', 'workspaces.json')
  const options = { worktrees, workingDirectory, localManager, stateFile }
  return {
    temporary, boundary, parent, calls, options, worktrees, workingDirectory, localManager, stateFile,
    manager: () => createWorkspaceHostManager(options),
    failCreate(error) { createError = error },
    failRestore(error) { restoreError = error },
    failSet(error) { setError = error },
    returnPath(dir) { createdPath = dir },
    moveCwd(dir) { cwd = dir },
  }
}

const spec = { runId: 'run-1', index: 2, parent: null }

test('probe requires host create, restore and set without falling back to local git', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.manager().probe(), {
    ok: true, base: f.boundary, baseDir: f.boundary, root: null, reason: null,
  })
  for (const options of [
    { ...f.options, worktrees: undefined },
    { ...f.options, worktrees: { create() {} } },
    { ...f.options, workingDirectory: {} },
  ]) {
    const verdict = await createWorkspaceHostManager(options).probe()
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /host .* unavailable/)
  }
  assert.equal(f.calls.create.length, 0)
})

test('late host services are resolved on every probe and prepare', async t => {
  const f = await fixture(t)
  let available = false
  const manager = createWorkspaceHostManager({
    ...f.options,
    worktrees: () => available ? f.worktrees : null,
    workingDirectory: () => available ? f.workingDirectory : null,
  })
  assert.equal((await manager.probe()).ok, false)
  available = true
  assert.equal((await manager.probe()).ok, true)
  const prepared = await manager.prepare({ runId: 'run-late', index: 1, parent: f.parent })
  assert.equal(prepared.ok, true, prepared.reason)
  assert.equal(f.calls.create.length, 1)
})

test('prepare creates the named host worktree, restores cwd and atomically persists it', async t => {
  const f = await fixture(t)
  const result = await f.manager().prepare({ ...spec, parent: f.parent })
  const name = 'superagent-run-1-w2'
  assert.deepEqual(result, {
    ok: true,
    dir: path.join(f.boundary, '.agents', 'worktrees', name),
    branch: name,
    base: BASE_COMMIT,
    reused: false,
    reason: null,
  })
  assert.deepEqual(f.calls.create, [{ agent: f.parent, request: { name } }])
  assert.deepEqual(f.calls.set, [{ agent: f.parent, dir: f.boundary }])
  const state = JSON.parse(await fsp.readFile(f.stateFile, 'utf8'))
  assert.equal(state.version, 1)
  assert.equal(state.worktrees.length, 1)
  assert.equal(state.worktrees[0].branch, name)
  assert.equal(state.worktrees[0].baseCommit, BASE_COMMIT)
  assert.equal(state.worktrees[0].parentCwd, f.boundary)
  assert.deepEqual(await fsp.readdir(path.dirname(f.stateFile)), ['workspaces.json'])
})

test('two manager instances persist concurrent creations without losing a record', async t => {
  const f = await fixture(t)
  const first = f.manager()
  const second = createWorkspaceHostManager(f.options)
  const results = await Promise.all([
    first.prepare({ runId: 'run-a', index: 1, parent: f.parent }),
    second.prepare({ runId: 'run-b', index: 1, parent: f.parent }),
  ])
  assert.ok(results.every(result => result.ok), JSON.stringify(results))
  const state = JSON.parse(await fsp.readFile(f.stateFile, 'utf8'))
  assert.deepEqual(state.worktrees.map(record => record.name).sort(), ['superagent-run-a-w1', 'superagent-run-b-w1'])
})

test('resume restores a removed registered branch through the host, then restores parent cwd', async t => {
  const f = await fixture(t)
  const created = await f.manager().prepare({ ...spec, parent: f.parent })
  await fsp.rm(created.dir, { recursive: true })
  f.moveCwd(path.join(f.temporary, 'elsewhere'))
  const resumed = await createWorkspaceHostManager(f.options).resume({ ...spec, parent: f.parent })
  assert.equal(resumed.ok, true, resumed.reason)
  assert.equal(resumed.reused, true)
  assert.equal(resumed.dir, created.dir)
  assert.deepEqual(f.calls.restore, [{
    agent: f.parent,
    request: {
      path: created.dir,
      branch: created.branch,
      baseCommit: BASE_COMMIT,
      repositoryRoot: f.boundary,
    },
  }])
  assert.equal(f.workingDirectory.get(f.parent.session), f.boundary)
  assert.equal(f.calls.create.length, 1)
})

test('resume keeps an existing retained checkout and rejects an unregistered branch', async t => {
  const f = await fixture(t)
  const created = await f.manager().prepare({ ...spec, parent: f.parent })
  f.moveCwd(created.dir)
  const resumed = await f.manager().resume({ ...spec, parent: f.parent })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.reused, true)
  assert.equal(f.calls.restore.length, 0)
  assert.equal(f.workingDirectory.get(f.parent.session), f.boundary)
  const missing = await f.manager().resume({ runId: 'other', index: 2, parent: f.parent })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /no registered host worktree/)
})

test('create and host restore failures return reasons instead of throwing', async t => {
  const f = await fixture(t)
  f.failCreate(new Error('host create denied'))
  const created = await f.manager().prepare({ ...spec, parent: f.parent })
  assert.equal(created.ok, false)
  assert.match(created.reason, /cannot create the host worktree: host create denied/)
  await fsp.stat(f.stateFile).catch(error => assert.equal(error.code, 'ENOENT'))

  const g = await fixture(t)
  const first = await g.manager().prepare({ ...spec, parent: g.parent })
  await fsp.rm(first.dir, { recursive: true })
  g.failRestore(new Error('host restore denied'))
  const resumed = await g.manager().resume({ ...spec, parent: g.parent })
  assert.equal(resumed.ok, false)
  assert.match(resumed.reason, /cannot restore host worktree .*host restore denied/)
  assert.equal(g.workingDirectory.get(g.parent.session), g.boundary)
})

test('a cwd restoration failure is explicit and leaves a resumable durable record', async t => {
  const f = await fixture(t)
  f.failSet(new Error('directory service offline'))
  const result = await f.manager().prepare({ ...spec, parent: f.parent })
  assert.equal(result.ok, false)
  assert.match(result.reason, /cannot restore the parent working directory/)
  const state = JSON.parse(await fsp.readFile(f.stateFile, 'utf8'))
  assert.equal(state.worktrees[0].branch, result.branch)
  f.failSet(null)
  const resumed = await f.manager().resume({ ...spec, parent: f.parent })
  assert.equal(resumed.ok, true, resumed.reason)
  assert.equal(f.workingDirectory.get(f.parent.session), f.boundary)
})

test('host paths outside the boundary or through a symbolic link are refused', async t => {
  const outside = await fixture(t)
  const other = path.join(outside.temporary, 'outside')
  await fsp.mkdir(other)
  outside.returnPath(other)
  const escaped = await outside.manager().prepare({ ...spec, parent: outside.parent })
  assert.equal(escaped.ok, false)
  assert.match(escaped.reason, /outside the sandbox boundary/)
  assert.equal(outside.workingDirectory.get(outside.parent.session), outside.boundary)
  await fsp.stat(outside.stateFile).catch(error => assert.equal(error.code, 'ENOENT'))

  const linked = await fixture(t)
  const target = path.join(linked.temporary, 'linked-target')
  await fsp.mkdir(target)
  const link = path.join(linked.boundary, 'linked-worktree')
  await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  linked.returnPath(link)
  const symlinked = await linked.manager().prepare({ ...spec, parent: linked.parent })
  assert.equal(symlinked.ok, false)
  assert.match(symlinked.reason, /symbolic link/)
  assert.equal(linked.workingDirectory.get(linked.parent.session), linked.boundary)
})

test('harvest and mergeAll delegate only boundary-safe non-link host paths', async t => {
  const f = await fixture(t)
  const created = await f.manager().prepare({ ...spec, parent: f.parent })
  const worker = { dir: created.dir, branch: created.branch, index: 2, title: 'answer' }
  assert.equal((await f.manager().harvest(worker)).status, 'committed')
  assert.deepEqual(f.calls.harvest, [worker])
  assert.deepEqual(await f.manager().mergeAll([worker]), [{ ...worker, status: 'merged', files: [], detail: null }])
  assert.deepEqual(f.calls.mergeAll, [[worker]])

  const escaped = { ...worker, dir: path.join(f.temporary, 'outside') }
  assert.equal((await f.manager().harvest(escaped)).status, 'failed')
  assert.match((await f.manager().mergeAll([escaped]))[0].detail, /outside the sandbox boundary/)
  assert.equal(f.calls.harvest.length, 1)
  assert.equal(f.calls.mergeAll.length, 1)

  const target = path.join(f.temporary, 'merge-target')
  await fsp.mkdir(target)
  const link = path.join(f.boundary, 'merge-link')
  await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.match((await f.manager().harvest({ ...worker, dir: link })).detail, /symbolic link/)
  assert.equal(f.calls.harvest.length, 1)
})

test('persistence failure restores cwd and does not report a usable workspace', async t => {
  const f = await fixture(t)
  await fsp.writeFile(path.dirname(f.stateFile), 'not a directory')
  const result = await f.manager().prepare({ ...spec, parent: f.parent })
  assert.equal(result.ok, false)
  assert.match(result.reason, /cannot persist the host worktree/)
  assert.equal(f.workingDirectory.get(f.parent.session), f.boundary)
})

test('invalid state fails closed and dispose performs no host operation', async t => {
  const f = await fixture(t)
  await fsp.mkdir(path.dirname(f.stateFile), { recursive: true })
  await fsp.writeFile(f.stateFile, '{broken')
  const result = await f.manager().resume({ ...spec, parent: f.parent })
  assert.equal(result.ok, false)
  assert.match(result.reason, /workspace-host stateFile is invalid|Unexpected end|Expected property/)
  assert.equal(await fsp.readFile(f.stateFile, 'utf8'), '{broken')
  const manager = f.manager()
  assert.equal(manager.root, null)
  assert.equal(manager.baseDir, f.boundary)
  assert.equal(manager.dispose(), undefined)
  assert.equal(f.calls.create.length + f.calls.restore.length + f.calls.set.length, 0)
})
