/**
 * Workspace manager adapter for the host's retained-worktree service.
 *
 * The host owns creation, restoration and Session directory changes. Git is used
 * only through localManager for harvesting and merging; a missing host service is
 * never replaced by a local checkout.
 */
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLock } from './lock.js'

function comparable(value) {
  const resolved = path.resolve(String(value))
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

function within(root, target) {
  const base = comparable(root)
  const child = comparable(target)
  return child === base || child.startsWith(base.endsWith('/') ? base : `${base}/`)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

function resolveService(service) {
  return typeof service === 'function' ? service() : service
}

async function canonicalPath(value) {
  const resolved = path.resolve(value)
  return fsp.realpath(resolved).catch(() => resolved)
}

function failed(reason, extra = {}) {
  return { ok: false, dir: null, branch: null, base: null, reused: false, reason, ...extra }
}

function identity({ runId, index }) {
  const name = `superagent-${runId}-w${index}`
  if (typeof runId !== 'string' || !runId.trim() || /[\\/\0]/.test(runId)
    || !Number.isSafeInteger(index) || index < 0) {
    throw new Error('a workspace needs a non-empty runId without path separators and a non-negative integer index')
  }
  return { name, branch: name }
}

/** Reject links on the path to a host checkout, including the checkout itself. */
async function assertSafePath(target, boundary, { mustExist = true, allowRoot = false } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new Error('the host worktree path must be absolute')
  }
  const rawResolved = path.resolve(target)
  const rawRoot = path.resolve(boundary)
  let rawCursor = rawResolved
  while (within(rawRoot, rawCursor) && rawCursor !== rawRoot) {
    const stat = await fsp.lstat(rawCursor).catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error('the host worktree path contains a symbolic link')
    const parent = path.dirname(rawCursor)
    if (parent === rawCursor) break
    rawCursor = parent
  }
  const resolved = await canonicalPath(target)
  const root = await canonicalPath(boundary)
  if (!within(root, resolved)) throw new Error('the host worktree path is outside the sandbox boundary')
  if (!allowRoot && comparable(root) === comparable(resolved)) {
    throw new Error('the host worktree path must be a checkout inside the sandbox boundary, not the boundary itself')
  }

  const realBoundary = await fsp.realpath(root)
  let cursor = resolved
  while (within(root, cursor) && cursor !== root) {
    const stat = await fsp.lstat(cursor).catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error('the host worktree path contains a symbolic link')
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const rootStat = await fsp.lstat(root)
  if (rootStat.isSymbolicLink()) throw new Error('the sandbox boundary is a symbolic link')

  const real = await fsp.realpath(resolved).catch(error => {
    if (!mustExist && error?.code === 'ENOENT') return null
    throw error
  })
  if (!real) {
    if (mustExist) throw new Error('the host worktree directory does not exist')
    return
  }
  if (!within(realBoundary, real)) throw new Error('the resolved host worktree path is outside the sandbox boundary')
  const stat = await fsp.lstat(resolved)
  if (stat.isSymbolicLink()) throw new Error('the host worktree path is a symbolic link')
  if (!stat.isDirectory()) throw new Error('the host worktree path is not a directory')
}

function validRecord(record) {
  return record && typeof record === 'object'
    && typeof record.name === 'string'
    && typeof record.path === 'string'
    && typeof record.branch === 'string'
    && typeof record.baseCommit === 'string'
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(record.baseCommit)
    && typeof record.repositoryRoot === 'string'
    && typeof record.boundary === 'string'
    && typeof record.parentCwd === 'string'
}

/**
 * @param {object} options host services and durable record location.
 * @returns {object} createWorkspaceManager-compatible manager, plus resume/dispose.
 */
export function createWorkspaceHostManager({ worktrees, workingDirectory, localManager, log = () => {}, stateFile } = {}) {
  const baseDir = path.resolve(localManager?.baseDir || workingDirectory?.defaultDirectory || process.cwd())
  let stateChain = Promise.resolve()
  let hostChain = Promise.resolve()

  function capabilities() {
    const host = resolveService(worktrees)
    const directory = resolveService(workingDirectory)
    if (typeof host?.create !== 'function' || typeof host?.restore !== 'function') {
      return 'the host worktrees service is unavailable; create and restore are required'
    }
    if (typeof directory?.set !== 'function') {
      return 'the host workingDirectory service is unavailable; set is required'
    }
    if (typeof stateFile !== 'string' || !stateFile.trim() || !path.isAbsolute(stateFile)) {
      return 'an absolute workspace-host stateFile is required'
    }
    return null
  }

  function sessionOf(parent) {
    return parent?.session ?? parent ?? null
  }

  function headerCwd(parent) {
    const session = sessionOf(parent)
    const directory = resolveService(workingDirectory)
    const header = session?.header?.cwd
    return path.resolve(typeof header === 'string' && header.trim()
      ? header : directory?.defaultDirectory || process.cwd())
  }

  function currentCwd(parent) {
    const session = sessionOf(parent)
    const directory = resolveService(workingDirectory)
    if (session && typeof directory?.get === 'function') {
      const value = directory.get(session)
      if (typeof value === 'string' && value.trim()) return path.resolve(value)
    }
    return headerCwd(parent)
  }

  async function readState() {
    const stat = await fsp.lstat(stateFile).catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isSymbolicLink()) throw new Error('the workspace-host stateFile is a symbolic link')
    if (!stat) return { version: 1, worktrees: [] }
    const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
    if (state?.version !== 1 || !Array.isArray(state.worktrees)
      || state.worktrees.some(record => !validRecord(record))) {
      throw new Error('the workspace-host stateFile is invalid')
    }
    return state
  }

  function updateState(update) {
    const task = stateChain.then(async () => {
      await fsp.mkdir(path.dirname(stateFile), { recursive: true })
      const release = await acquireFileLock(`${stateFile}.lock`, {
        staleMs: 30_000,
        reclaimDead: true,
        reclaimStale: true,
        retries: 20,
        retryDelayMs: 25,
      })
      if (!release) throw new Error('cannot lock the workspace-host state file')
      try {
        const state = await readState()
        update(state.worktrees)
        const current = await fsp.lstat(stateFile).catch(error => {
          if (error?.code === 'ENOENT') return null
          throw error
        })
        if (current?.isSymbolicLink()) throw new Error('the workspace-host stateFile is a symbolic link')
        const temporary = `${stateFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
        try {
          await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
          await fsp.rename(temporary, stateFile)
        } finally {
          await fsp.unlink(temporary).catch(() => {})
        }
      } finally {
        await release()
      }
    })
    stateChain = task.catch(() => {})
    return task
  }

  async function registered(branch) {
    await stateChain
    const state = await readState()
    return state.worktrees.find(record => record.branch === branch) ?? null
  }

  async function registeredByName(name) {
    await stateChain
    const state = await readState()
    return state.worktrees.find(record => record.name === name) ?? null
  }

  async function restoreParent(parent, cwd) {
    try {
      await resolveService(workingDirectory).set(parent, cwd)
      return null
    } catch (error) {
      return `cannot restore the parent working directory to ${cwd}: ${message(error)}`
    }
  }

  function validateHostRecord(created) {
    for (const field of ['path', 'branch', 'baseCommit', 'repositoryRoot']) {
      if (typeof created?.[field] !== 'string' || !created[field]) {
        throw new Error(`the host worktree result is missing ${field}`)
      }
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(created.baseCommit)) {
      throw new Error('the host worktree result has an invalid baseCommit')
    }
    return created
  }

  async function probe() {
    const reason = capabilities()
    return reason
      ? { ok: false, base: null, baseDir, root: null, reason }
      : { ok: true, base: baseDir, baseDir, root: null, reason: null }
  }

  function serializeHost(operation) {
    const task = hostChain.then(operation)
    hostChain = task.catch(() => {})
    return task
  }

  function prepare({ runId, index, parent } = {}) {
    return serializeHost(() => prepareNow({ runId, index, parent }))
  }

  async function prepareNow({ runId, index, parent } = {}) {
    const reason = capabilities()
    if (reason) return failed(reason)
    let ids
    let boundary
    let cwd
    try {
      ids = identity({ runId, index })
      boundary = headerCwd(parent)
      let existing
      try {
        existing = await registeredByName(ids.name)
      } catch (error) {
        return failed(`cannot persist the host worktree: ${message(error)}`, { branch: ids.branch })
      }
      if (existing) return resumeNow({ runId, index, parent })
      cwd = currentCwd(parent)
      await assertSafePath(cwd, boundary, { allowRoot: true })
    } catch (error) {
      return failed(message(error), { branch: ids?.branch })
    }

    let created
    try {
      created = validateHostRecord(await resolveService(worktrees).create(parent, { name: ids.name }))
      await assertSafePath(created.path, boundary)
    } catch (error) {
      const restoreError = await restoreParent(parent, cwd)
      return failed(`cannot create the host worktree: ${message(error)}${restoreError ? `; ${restoreError}` : ''}`, {
        dir: created?.path ?? null,
        branch: created?.branch ?? ids.branch,
        base: created?.baseCommit ?? null,
      })
    }

    // Save before restoring cwd: if that restoration fails, resume can still
    // find the retained checkout instead of losing its only durable record.
    try {
      await updateState(records => {
        const key = comparable(created.path)
        const existing = records.findIndex(record => record.branch === created.branch || comparable(record.path) === key)
        const record = {
          name: ids.name,
          path: created.path,
          branch: created.branch,
          baseCommit: created.baseCommit,
          repositoryRoot: created.repositoryRoot,
          boundary,
          parentCwd: cwd,
          createdAt: new Date().toISOString(),
        }
        if (existing < 0) records.push(record)
        else records[existing] = record
      })
    } catch (error) {
      const restoreError = await restoreParent(parent, cwd)
      return failed(`cannot persist the host worktree: ${message(error)}${restoreError ? `; ${restoreError}` : ''}`, {
        dir: created.path, branch: created.branch, base: created.baseCommit,
      })
    }

    const restoreError = await restoreParent(parent, cwd)
    if (restoreError) {
      return failed(restoreError, { dir: created.path, branch: created.branch, base: created.baseCommit })
    }
    return { ok: true, dir: created.path, branch: created.branch, base: created.baseCommit, reused: false, reason: null }
  }

  /** Reopen a recorded host checkout, restoring a removed one before restoring cwd. */
  function resume({ runId, index, parent } = {}) {
    return serializeHost(() => resumeNow({ runId, index, parent }))
  }

  async function resumeNow({ runId, index, parent } = {}) {
    const reason = capabilities()
    if (reason) return failed(reason)
    let ids
    let record
    let boundary
    let cwd
    try {
      ids = identity({ runId, index })
      boundary = headerCwd(parent)
      record = await registeredByName(ids.name)
      if (!record) return failed(`no registered host worktree exists for branch ${ids.branch}`)
      cwd = record.parentCwd
      await assertSafePath(cwd, boundary, { allowRoot: true })
      await assertSafePath(record.path, boundary, { mustExist: false })
    } catch (error) {
      return failed(message(error), { branch: ids?.branch })
    }

    let dir = record.path
    try {
      const stat = await fsp.lstat(dir).catch(error => {
        if (error?.code === 'ENOENT') return null
        throw error
      })
      // Host restore intentionally rejects an existing directory. A retained
      // checkout therefore needs no restore; a removed one must go through host.
      if (!stat) {
        const restored = await resolveService(worktrees).restore(parent, {
          path: record.path,
          branch: record.branch,
          baseCommit: record.baseCommit,
          repositoryRoot: record.repositoryRoot,
        })
        if (restored?.path !== record.path) throw new Error('the host restored a different worktree path')
        dir = restored.path
      }
      await assertSafePath(dir, boundary)
    } catch (error) {
      const restoreError = await restoreParent(parent, cwd)
      return failed(`cannot restore host worktree ${record.branch}: ${message(error)}${restoreError ? `; ${restoreError}` : ''}`, {
        dir, branch: record.branch, base: record.baseCommit,
      })
    }

    const restoreError = await restoreParent(parent, cwd)
    if (restoreError) return failed(restoreError, { dir, branch: record.branch, base: record.baseCommit })
    return { ok: true, dir, branch: record.branch, base: record.baseCommit, reused: true, reason: null }
  }

  async function recordFor(spec) {
    if (spec && typeof spec === 'object') {
      const state = await readState()
      return state.worktrees.find(record => spec.branch ? record.branch === spec.branch
        : spec.dir && comparable(record.path) === comparable(spec.dir)) ?? null
    }
    return null
  }

  async function harvest(spec) {
    try {
      const record = await recordFor(spec)
      const boundary = record?.boundary ?? baseDir
      await assertSafePath(spec?.dir, boundary)
      if (typeof localManager?.harvest !== 'function') throw new Error('the local workspace manager cannot harvest')
      return await localManager.harvest(spec)
    } catch (error) {
      return { status: 'failed', files: [], commit: null, detail: message(error) }
    }
  }

  async function mergeAll(workers) {
    if (!Array.isArray(workers)) return []
    try {
      for (const worker of workers) {
        const record = await recordFor(worker)
        await assertSafePath(worker?.dir, record?.boundary ?? baseDir)
      }
      if (typeof localManager?.mergeAll !== 'function') throw new Error('the local workspace manager cannot merge')
      return await localManager.mergeAll(workers)
    } catch (error) {
      return workers.map(worker => ({
        index: worker?.index,
        branch: worker?.branch ?? null,
        dir: worker?.dir ?? null,
        status: 'failed',
        files: [],
        detail: message(error),
      }))
    }
  }

  async function release(spec) {
    try {
      const record = await recordFor(spec)
      await assertSafePath(spec?.dir, record?.boundary ?? baseDir)
      if (typeof localManager?.release !== 'function') throw new Error('the local workspace manager cannot release')
      return await localManager.release(spec)
    } catch (error) {
      log(`cannot release host worktree ${spec?.dir ?? ''}: ${message(error)}`)
      return undefined
    }
  }

  return {
    probe,
    prepare,
    resume,
    harvest,
    mergeAll,
    release,
    root: null,
    baseDir,
    dispose() {},
  }
}
