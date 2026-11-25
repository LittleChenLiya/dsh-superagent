/**
 * Workspace isolation tests.
 *
 * These run real git against throwaway repositories instead of mocking it: the
 * feature's whole value is that git owns the merge, so a fake would test the
 * mock rather than the behaviour. Nothing is written outside `os.tmpdir()`.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createWorkspaceManager, describeWorkspace } from '../lib/workspace.js'

const execFileAsync = promisify(execFile)

/** Run git in `cwd`, failing the test on a non-zero exit. */
async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  return stdout
}

/** A committed repository with one tracked file. */
async function makeRepo(files = { 'notes.txt': 'line one\nline two\n' }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ws-'))
  await git(dir, ['init', '-b', 'main'])
  // A machine-wide `core.autocrlf=true` would rewrite every checked-out file to
  // CRLF, so content assertions would test the runner's git config, not the
  // feature. Pin the setting for the fixture repository only.
  await git(dir, ['config', 'core.autocrlf', 'false'])
  for (const [name, body] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, name), body, 'utf8')
  }
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'initial'])
  return dir
}

/** Compare paths the way Windows does: git reports forward slashes and its own casing. */
function normalize(value) {
  return String(value).replace(/\\/g, '/').toLowerCase()
}

/** A manager with the plugin's layout: checkouts inside the repository, where the host sandbox can write. */
function managerFor(baseDir) {
  return createWorkspaceManager({ baseDir, sleep: () => Promise.resolve() })
}

test('a directory that is not a git repository is reported instead of isolated', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ws-plain-'))
  const manager = managerFor(dir)
  const verdict = await manager.probe()
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /not a git working tree/)
  const prepared = await manager.prepare({ runId: 'run-plain', index: 1 })
  assert.equal(prepared.ok, false)
  assert.equal(prepared.dir, null)
  assert.match(prepared.reason, /not a git working tree/)
})

test('two workers get separate checkouts and cannot see each other edits', async () => {
  const repo = await makeRepo()
  const manager = managerFor(repo)
  const one = await manager.prepare({ runId: 'run-a', index: 1 })
  const two = await manager.prepare({ runId: 'run-a', index: 2 })

  assert.equal(one.ok, true, one.reason)
  assert.equal(two.ok, true, two.reason)
  assert.notEqual(one.dir, two.dir)
  assert.notEqual(one.branch, two.branch)

  await fsp.writeFile(path.join(one.dir, 'notes.txt'), 'worker one\n', 'utf8')
  assert.equal(await fsp.readFile(path.join(two.dir, 'notes.txt'), 'utf8'), 'line one\nline two\n')
  assert.equal(await fsp.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'line one\nline two\n')
  // The branch exists as its own ref, not on the main checkout.
  assert.match(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), /main/)
})

test('checkouts live inside the repository, the host sandbox writable boundary', async () => {
  const repo = await makeRepo()
  const manager = managerFor(repo)
  const work = await manager.prepare({ runId: 'run-pool', index: 1 })
  assert.equal(work.ok, true, work.reason)
  const canonicalRepo = await fsp.realpath(repo)
  const relative = path.relative(canonicalRepo, work.dir)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${work.dir} is outside ${repo}`)
  assert.equal(normalize(manager.root), normalize(path.join(canonicalRepo, '.superagent', 'worktrees')))
  // The pool ignores itself, so a waiting merge does not see a dirty checkout.
  assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '')
})

test('a repository outside the sandbox boundary gets a pool inside the boundary', async () => {
  const repo = await makeRepo()
  const boundary = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-boundary-'))
  const manager = createWorkspaceManager({ baseDir: repo, boundary, sleep: () => Promise.resolve() })
  const work = await manager.prepare({ runId: 'run-out', index: 1 })
  assert.equal(work.ok, true, work.reason)
  // The host only lets the worker write inside the session directory, so the
  // checkout must live there even though its repository does not.
  assert.ok(normalize(work.dir).startsWith(`${normalize(await fsp.realpath(boundary))}/`), `${work.dir} is outside ${boundary}`)
  assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '')
})

test('a linked worktree pool cannot redirect writes outside the sandbox', async () => {
  const repo = await makeRepo()
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-ws-outside-'))
  const link = path.join(repo, 'linked-pool')
  await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const manager = createWorkspaceManager({ root: 'linked-pool', baseDir: repo, sleep: () => Promise.resolve() })

  const verdict = await manager.probe()
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /symbolic link|outside the sandbox boundary/)
  assert.deepEqual(await fsp.readdir(outside), [], 'probing must not write through the link')
  const work = await manager.prepare({ runId: 'run-link', index: 1 })
  assert.equal(work.ok, false)
  assert.deepEqual(await fsp.readdir(outside), [])
})

test('a linked worker directory cannot redirect a checkout outside the sandbox', async () => {
  const repo = await makeRepo()
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-worker-outside-'))
  const manager = managerFor(repo)
  assert.equal((await manager.probe()).ok, true)
  await fsp.symlink(outside, path.join(manager.root, 'run-deep'), process.platform === 'win32' ? 'junction' : 'dir')

  const work = await manager.prepare({ runId: 'run-deep', index: 1 })
  assert.equal(work.ok, false)
  assert.match(work.reason, /symbolic link|outside the sandbox boundary/)
  assert.deepEqual(await fsp.readdir(outside), [], 'no checkout may be created through the linked worker directory')
})

test('a resume keeps a checkout recorded under the previous pool location', async () => {
  const repo = await makeRepo()
  const legacyRoot = path.join(repo, '.old-worktrees')
  const legacy = await createWorkspaceManager({ root: legacyRoot, baseDir: repo, sleep: () => Promise.resolve() })
    .prepare({ runId: 'run-old', index: 1 })
  assert.equal(legacy.ok, true, legacy.reason)
  const resumed = await managerFor(repo).prepare({ runId: 'run-old', index: 1 })
  assert.equal(resumed.ok, true, resumed.reason)
  assert.equal(resumed.reused, true)
  assert.equal(normalize(await fsp.realpath(resumed.dir)), normalize(await fsp.realpath(legacy.dir)))
})

test('preparing the same worker twice reuses its checkout instead of failing', async () => {
  const repo = await makeRepo()
  const manager = managerFor(repo)
  const first = await manager.prepare({ runId: 'run-b', index: 1 })
  await fsp.writeFile(path.join(first.dir, 'notes.txt'), 'kept\n', 'utf8')
  const again = await manager.prepare({ runId: 'run-b', index: 1 })
  assert.equal(again.ok, true, again.reason)
  assert.equal(again.reused, true)
  assert.equal(again.dir, first.dir)
  assert.equal(await fsp.readFile(path.join(again.dir, 'notes.txt'), 'utf8'), 'kept\n')
})

test('a clean worker branch merges back into the main checkout', async () => {
  const repo = await makeRepo()
  const manager = managerFor(repo)
  const work = await manager.prepare({ runId: 'run-c', index: 1 })
  await fsp.writeFile(path.join(work.dir, 'notes.txt'), 'worker one\n', 'utf8')
  await fsp.writeFile(path.join(work.dir, 'added.txt'), 'new file\n', 'utf8')

  const harvested = await manager.harvest({ dir: work.dir, branch: work.branch, index: 1, title: 'A' })
  assert.equal(harvested.status, 'committed')
  assert.deepEqual(harvested.files.sort(), ['added.txt', 'notes.txt'])

  const outcomes = await manager.mergeAll([{ index: 1, dir: work.dir, branch: work.branch }])
  assert.equal(outcomes[0].status, 'merged')
  assert.equal(await fsp.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'worker one\n')
  assert.equal(await fsp.readFile(path.join(repo, 'added.txt'), 'utf8'), 'new file\n')
  // The merged checkout is removed so a finished run leaves no debris.
  const worktrees = await git(repo, ['worktree', 'list', '--porcelain'])
  assert.doesNotMatch(worktrees, new RegExp(path.basename(work.dir)))
})

test('a worker that changed nothing is reported and its checkout is dropped', async () => {
  const repo = await makeRepo()
  const manager = managerFor(repo)
  const work = await manager.prepare({ runId: 'run-d', index: 1 })
  const harvested = await manager.harvest({ dir: work.dir, branch: work.branch, index: 1 })
  assert.equal(harvested.status, 'no-changes')
  assert.deepEqual(harvested.files, [])
})

test('a conflicting edit is exposed with its files and the main checkout is restored', async () => {
  const repo = await makeRepo()
  const manager = managerFor(repo)
  const work = await manager.prepare({ runId: 'run-e', index: 1 })
  await fsp.writeFile(path.join(work.dir, 'notes.txt'), 'line one worker\nline two\n', 'utf8')
  await manager.harvest({ dir: work.dir, branch: work.branch, index: 1 })

  // A human (or another process) edits the same line in the main checkout.
  await fsp.writeFile(path.join(repo, 'notes.txt'), 'line one main\nline two\n', 'utf8')
  await git(repo, ['commit', '-am', 'main edit'])
  const before = await git(repo, ['rev-parse', 'HEAD'])

  const outcomes = await manager.mergeAll([{ index: 1, dir: work.dir, branch: work.branch }])
  assert.equal(outcomes[0].status, 'conflict')
  assert.deepEqual(outcomes[0].files, ['notes.txt'])
  // Nothing was merged and nothing was left half-merged.
  assert.equal((await git(repo, ['rev-parse', 'HEAD'])).trim(), before.trim())
  assert.equal(await fsp.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'line one main\nline two\n')
  assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '')
  // The worker's side survives: its branch and checkout are still there.
  assert.match(await git(repo, ['branch', '--list', work.branch]), new RegExp(`\\b${work.branch}$`, 'm'))
  assert.equal(await fsp.readFile(path.join(work.dir, 'notes.txt'), 'utf8'), 'line one worker\nline two\n')
})

test('an uncommitted main checkout holds the merge instead of mixing edits', async () => {
  const repo = await makeRepo()
  const manager = managerFor(repo)
  const work = await manager.prepare({ runId: 'run-f', index: 1 })
  await fsp.writeFile(path.join(work.dir, 'notes.txt'), 'worker\n', 'utf8')
  await manager.harvest({ dir: work.dir, branch: work.branch, index: 1 })

  await fsp.writeFile(path.join(repo, 'uncommitted.txt'), 'local\n', 'utf8')
  const outcomes = await manager.mergeAll([{ index: 1, dir: work.dir, branch: work.branch }])
  assert.equal(outcomes[0].status, 'skipped')
  assert.match(outcomes[0].detail, /uncommitted changes/)
  assert.equal(await fsp.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'line one\nline two\n')
  assert.equal(await fsp.readFile(path.join(work.dir, 'notes.txt'), 'utf8'), 'worker\n')
})

test('describeWorkspace turns merge outcomes into lines a user can act on', () => {
  const lines = describeWorkspace({
    mode: 'git-worktree',
    base: 'C:\\repo',
    root: 'C:\\state\\workspaces',
    merges: [
      { index: 1, status: 'merged', branch: 'superagent/r-w1' },
      { index: 2, status: 'no-changes' },
      { index: 3, status: 'conflict', branch: 'superagent/r-w3', dir: 'C:\\state\\workspaces\\r\\w3', files: ['a.js', 'b.js'] },
      { index: 4, status: 'skipped', branch: 'superagent/r-w4', detail: 'the main working directory has uncommitted changes' },
    ],
  })
  const text = lines.join('\n')
  assert.match(text, /each worker ran in its own git worktree/)
  assert.match(text, /\[1\] merged back/)
  assert.match(text, /\[2\] changed no files/)
  assert.match(text, /workspace conflict: \[3\] a\.js, b\.js/)
  assert.match(text, /git -C "C:\\repo" merge superagent\/r-w3/)
  assert.match(text, /\[4\] not merged \(skipped\)/)
  // A held-back merge is still finishable by hand, so the line says how.
  assert.match(text, /branch superagent\/r-w4 kept/)
  assert.match(text, /Finish with: git -C "C:\\repo" merge --no-ff superagent\/r-w4/)
})

test('describeWorkspace repeats a workspace base warning instead of hiding it', () => {
  const text = describeWorkspace({
    mode: 'git-worktree',
    base: 'D:\\DSH测试',
    root: 'D:\\DSH测试\\.superagent\\worktrees',
    baseNote: 'workspaceRoot D:/dsh/work/smoke-repo is not this session\'s directory (D:\\DSH测试), '
      + "so isolation used the session directory; set workspaceBase: 'config' to keep the configured one",
    merges: [],
  }).join('\n')
  assert.match(text, /workspace warning: workspaceRoot D:\/dsh\/work\/smoke-repo is not this session's directory/)
  assert.match(text, /workspaceBase: 'config'/)
})

test('describeWorkspace explains an unavailable environment and an empty record', () => {
  assert.deepEqual(describeWorkspace(null), [])
  assert.deepEqual(describeWorkspace({ mode: 'off' }), [])
  const text = describeWorkspace({
    mode: 'unavailable',
    base: '/repo',
    reason: '/repo is not a git working tree, so a per-worker worktree cannot be created',
  }).join('\n')
  assert.match(text, /isolation was requested but is unavailable/)
  assert.match(text, /workers shared \/repo/)
  assert.match(
    describeWorkspace({ mode: 'git-worktree', base: '/repo', deferred: 'the run stopped before merging' }).join('\n'),
    /not merged — the run stopped before merging/,
  )
})
