/**
 * Per-worker working-directory isolation for dsh-superagent.
 *
 * Why git worktrees instead of a directory copy: the merge-back step is the
 * hard half of isolation, and git already owns a three-way merge with conflict
 * detection, a durable record of both sides, and one command the user can run
 * to finish by hand. A plain recursive copy would need a diff3 implementation
 * (a dependency) or would silently overwrite the main checkout (the bug this
 * feature exists to fix). A worktree is also cheap: it shares the object
 * database and the ignore rules, so a worker sees the same repository.
 *
 * Isolation has two parts. The host `startActivation` request takes a `cwd`, so
 * each worker starts inside its own worktree and relative writes land there.
 * The prompt names the same absolute path as a second line of defense, and every
 * worker gets a real branch so whatever it wrote is captured and merged back
 * with git rather than trusted. A worker that ignores both still cannot damage a
 * sibling worker's branch; it would edit the main checkout, which the
 * deliverable check reports as `misplaced` instead of silently accepting it.
 *
 * Where the checkouts live is not cosmetic. The host's `workspace-write`
 * sandbox takes its writable boundary from the session's immutable `cwd` — the
 * directory the host was started in — which a delegated child inherits from its
 * parent and a `working-directory` change does not move. A checkout under the
 * state directory, or inside a repository the host was not started in, is
 * outside that boundary: every worker write is denied no matter what `cwd` the
 * activation requests. The pool is therefore anchored to the boundary — the
 * repository when it sits inside the boundary, otherwise the boundary itself —
 * at `<anchor>/.superagent/worktrees/<runId>/w<n>`, mirroring the host's own
 * worktree service (`.agents/worktrees`). The pool carries its own
 * `.gitignore`, so those checkouts never appear as untracked files and never
 * block the merge.
 *
 * Nothing here imports the host: git is spawned directly, so the module is
 * testable against real temporary repositories.
 *
 * @module dsh-superagent/workspace
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Attempts for a git call that lost a race for one of git's own lock files. */
const LOCK_ATTEMPTS = 6
/** First backoff for such a race; each retry doubles it. */
const LOCK_BACKOFF_MS = 120

/**
 * Environment for every git call: never prompt (a worker's terminal is not
 * attached), never page, and keep output parseable.
 */
function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/**
 * Run one git command.
 *
 * A missing binary and a failing command are different problems — the first
 * disables isolation, the second is a repository state the user must see — so
 * the missing-binary case gets its own error code instead of a generic string.
 *
 * @param {string} cwd - directory to run in.
 * @param {string[]} args - git arguments.
 * @param {{ exec?: Function }} [options] - command runner, injectable for tests.
 * @returns {Promise<{ ok: boolean, code: number | string, stdout: string, stderr: string }>}
 */
async function git(cwd, args, { exec = execFileAsync } = {}) {
  try {
    const { stdout, stderr } = await exec('git', args, {
      cwd,
      env: gitEnv(),
      windowsHide: true,
      timeout: 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ok: true, code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
  } catch (error) {
    if (typeof error?.code === 'string' && ['ENOENT', 'EACCES'].includes(error.code)) {
      const missing = new Error('git is not available on PATH, so a per-worker worktree cannot be created')
      missing.code = 'git-missing'
      throw missing
    }
    return {
      ok: false,
      code: error?.code ?? 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? error),
    }
  }
}

/** First non-empty line of a git error, collapsed for a status line. */
function firstLine(text) {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  // git prints progress ("Preparing worktree ...") before the line that says
  // what actually went wrong, so prefer an explicit fatal/error line.
  return lines.find(line => /fatal:|error:/i.test(line)) ?? lines[0] ?? ''
}

// Expand Git for Windows 8.3 short names before persisting workspace paths.
async function canonicalPath(value) {
  const resolved = path.resolve(value)
  return fsp.realpath(resolved).catch(() => resolved)
}

/**
 * Compare filesystem paths the way the OS does. git reports worktree paths with
 * forward slashes on Windows, which never equals a native `path.resolve`.
 */
function samePath(value) {
  const resolved = path.resolve(String(value))
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

/** True when `child` is `parent` or lives under it, compared the OS way. */
function within(parent, child) {
  const base = samePath(parent)
  const target = samePath(child)
  return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/** A quoted path, so a directory with spaces can be pasted into a shell. */
function quote(value) {
  return `"${String(value).replace(/"/g, '')}"`
}

/** True when a failed git call lost a race for a lock instead of failing. */
function looksLikeLockRace(result) {
  return /index\.lock|locked|another git process|Unable to create|already exists|cannot lock/i
    .test(`${result.stderr} ${result.stdout}`)
}

/**
 * Build a workspace manager bound to one repository.
 *
 * @param {object} options - manager settings.
 * @param {string} [options.root] - worktree pool, relative to the anchor
 *   (default `.superagent/worktrees`) so the host sandbox covers it; an absolute
 *   path is used as-is and is only correct inside the sandbox boundary.
 * @param {string} options.baseDir - the main checkout workers are isolated from.
 * @param {string} [options.boundary] - the host sandbox's writable root, i.e.
 *   the session cwd. Defaults to `baseDir`.
 * @param {string | null} [options.branchPrefix] - branch namespace for workers.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 * @param {(ms: number) => Promise<void>} [options.sleep] - backoff, injectable.
 * @param {Function} [options.exec] - command runner, injectable for tests.
 */
export function createWorkspaceManager({
  root = path.join('.superagent', 'worktrees'),
  baseDir,
  boundary = baseDir,
  branchPrefix = 'superagent',
  log = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  exec = execFileAsync,
}) {
  // Two workers starting at the same moment both call `prepare`, and git's
  // own worktree bookkeeping is not safe under concurrent writers. A promise
  // chain costs nothing here (prepare is one fast command) and removes a
  // flake that retries alone would only make rarer.
  let prepareChain = Promise.resolve()
  let probed = null
  let resolvedRoot = null

  const run = (cwd, args) => git(cwd, args, { exec })

  /**
   * Decide once whether this directory can host worker worktrees.
   *
   * Only a usable answer is cached: a failure is cheap to re-check, and caching
   * it would keep reporting yesterday's missing repository after the user fixed
   * it in the same host process.
   *
   * @returns {Promise<{ ok: boolean, base: string, baseDir: string, root: string | null, reason: string | null }>}
   */
  async function probe() {
    if (probed) return probed
    const unavailable = reason => ({ ok: false, base: null, baseDir, root: null, reason })
    if (typeof baseDir !== 'string' || !baseDir.trim()) {
      return unavailable('no workspace directory is configured (open the session inside the repository, or set workspaceRoot with workspaceBase: \'config\')')
    }
    let inside
    try {
      inside = await run(baseDir, ['rev-parse', '--is-inside-work-tree'])
    } catch (error) {
      return unavailable(error?.message ?? String(error))
    }
    if (!inside.ok || inside.stdout.trim() !== 'true') {
      return unavailable(`${baseDir} is not a git working tree, so a per-worker worktree cannot be created (open the session inside a git repository, or set workspaceRoot with workspaceBase: 'config')`)
    }
    const toplevel = await run(baseDir, ['rev-parse', '--show-toplevel'])
    if (!toplevel.ok) {
      return unavailable(`cannot resolve the repository root of ${baseDir}: ${firstLine(toplevel.stderr)}`)
    }
    const base = await canonicalPath(toplevel.stdout.trim() || baseDir)
    // `worktree add` checks out a commit; a repository with no commit has none.
    const head = await run(base, ['rev-parse', '--verify', 'HEAD'])
    if (!head.ok) {
      return unavailable(`the repository at ${base} has no commit yet, so there is no revision to branch a worker from`)
    }
    // The pool must live inside the host sandbox boundary, or every worker
    // write is denied. Prefer the repository itself when the boundary contains
    // it; otherwise the boundary directory is the only writable choice, and a
    // git worktree is legal outside its repository.
    const canonicalBoundary = await canonicalPath(boundary)
    const anchor = within(canonicalBoundary, base) ? base : canonicalBoundary
    const pool = path.isAbsolute(root) ? path.resolve(root) : path.join(anchor, root)
    try {
      await fsp.mkdir(pool, { recursive: true })
      // The ignore file here keeps a worker's checkout out of the user's next
      // `git add -A` and out of the `git status` gate that holds the merge.
      const ignore = path.join(pool, '.gitignore')
      await fsp.writeFile(ignore, '*\n', { flag: 'wx' }).catch(error => {
        if (error?.code !== 'EEXIST') throw error
      })
    } catch (error) {
      return unavailable(`cannot create the worktree root ${pool}: ${error?.message ?? error}`)
    }
    resolvedRoot = pool
    probed = { ok: true, base, baseDir: base, root: pool, reason: null }
    return probed
  }

  /**
   * Checkouts git already has, so a resume reuses its worktree. The branch is
   * read too: a run recorded before the pool moved inside the repository still
   * owns its branch at the old path, and a resume must land in that checkout
   * instead of failing on a branch git already has checked out.
   *
   * @returns {Promise<Array<{ path: string, key: string, branch: string | null }>>}
   */
  async function registeredWorktrees() {
    const listed = await run(baseDir, ['worktree', 'list', '--porcelain'])
    if (!listed.ok) return []
    const trees = []
    let current = null
    for (const line of listed.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        const dir = line.slice('worktree '.length).trim()
        current = { path: dir, key: samePath(dir), branch: null }
        trees.push(current)
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      }
    }
    return trees
  }

  /**
   * Create (or reuse) one worker's isolated checkout.
   *
   * @param {{ runId: string, index: number, title?: string }} spec - worker identity.
   * @returns {Promise<{ ok: boolean, dir: string, branch: string, base: string, reused: boolean, reason: string | null }>}
   */
  function prepare({ runId, index }) {
    const task = prepareChain.then(() => prepareNow({ runId, index }))
    prepareChain = task.catch(() => {})
    return task
  }

  async function prepareNow({ runId, index }) {
    const verdict = await probe()
    if (!verdict.ok) {
      return { ok: false, dir: null, branch: null, base: verdict.baseDir ?? null, reused: false, reason: verdict.reason }
    }
    const dir = path.join(verdict.root, runId, `w${index}`)
    const branch = `${branchPrefix}/${runId}-w${index}`
    const existing = await registeredWorktrees()
    if (existing.some(tree => tree.key === samePath(dir))) {
      // A resumed run must not throw away what an earlier attempt wrote.
      return { ok: true, dir, branch, base: verdict.base, reused: true, reason: null }
    }
    const elsewhere = existing.find(tree => tree.branch === branch)
    if (elsewhere) {
      // Same branch, different pool: keep the checkout that owns it.
      return { ok: true, dir: await canonicalPath(elsewhere.path), branch, base: verdict.base, reused: true, reason: null }
    }
    let last = null
    for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt++) {
      const added = await run(verdict.base, ['worktree', 'add', '-b', branch, dir, 'HEAD'])
      if (added.ok) {
        return { ok: true, dir, branch, base: verdict.base, reused: false, reason: null }
      }
      last = added
      if (!looksLikeLockRace(added) || attempt === LOCK_ATTEMPTS) break
      log(`worktree add for subtask ${index} lost a git lock race (attempt ${attempt}); retrying`)
      await sleep(LOCK_BACKOFF_MS * attempt)
    }
    const branchExists = await run(verdict.base, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (branchExists.ok && /already exists/.test(last?.stderr ?? '')) {
      // The branch survived an earlier run but its directory is gone: re-attach
      // it instead of refusing to isolate this worker at all.
      const attached = await run(verdict.base, ['worktree', 'add', dir, branch])
      if (attached.ok) {
        return { ok: true, dir, branch, base: verdict.base, reused: true, reason: null }
      }
      last = attached
    }
    return {
      ok: false,
      dir,
      branch,
      base: verdict.base,
      reused: false,
      reason: `cannot create a worktree for worker ${index}: ${firstLine(last?.stderr) || 'git worktree add failed'}`,
    }
  }

  /**
   * Commit what a worker left in its checkout so the branch holds the work.
   *
   * Workers are not asked to commit: a model that forgets would otherwise lose
   * its work. Hooks are skipped so a repository's pre-commit hook cannot block
   * the merge-back (or rewrite files behind the worker's back).
   *
   * @param {{ dir: string, branch: string, index: number, title?: string }} spec - worker workspace.
   * @returns {Promise<{ status: 'committed'|'no-changes'|'failed', files: string[], commit: string | null, detail: string | null }>}
   */
  async function harvest({ dir, branch, index, title = '' }) {
    const status = await run(dir, ['status', '--porcelain'])
    if (!status.ok) {
      return { status: 'failed', files: [], commit: null, detail: `cannot read the worker checkout: ${firstLine(status.stderr)}` }
    }
    const changed = status.stdout.split('\n').map(line => line.slice(3).trim()).filter(Boolean)
    if (changed.length === 0) return { status: 'no-changes', files: [], commit: null, detail: null }
    const staged = await run(dir, ['add', '-A'])
    if (!staged.ok) {
      return { status: 'failed', files: changed, commit: null, detail: `cannot stage the worker changes: ${firstLine(staged.stderr)}` }
    }
    const message = `superagent: worker ${index}${title ? ` — ${title}` : ''}`
    const committed = await run(dir, [
      '-c', 'user.name=dsh-superagent',
      '-c', 'user.email=superagent@localhost',
      'commit', '--no-verify', '-m', message,
    ])
    if (!committed.ok) {
      return { status: 'failed', files: changed, commit: null, detail: `cannot commit the worker changes: ${firstLine(committed.stderr)}` }
    }
    const sha = await run(dir, ['rev-parse', '--short', 'HEAD'])
    return { status: 'committed', files: changed, commit: sha.ok ? sha.stdout.trim() : null, detail: null }
  }

  /** Remove one worker checkout and, when its branch is already merged, the branch. */
  async function release({ dir, branch }) {
    await run(baseDir, ['worktree', 'remove', '--force', dir])
    if (branch) await run(baseDir, ['branch', '-d', branch])
  }

  /**
   * Merge every harvested worker branch into the main checkout, one at a time.
   *
   * A conflict is never resolved by the plugin and never discarded: the merge is
   * aborted (so the main checkout is exactly as it was), the file list is
   * recorded, and the worker's branch and checkout are kept so the user can run
   * the printed `git merge` themselves. That is the difference between a visible
   * conflict and a lost subtask.
   *
   * @param {Array<{ index: number, title?: string, dir: string, branch: string }>} workers - ready branches.
   * @returns {Promise<Array<object>>} one outcome per worker.
   */
  async function mergeAll(workers) {
    const outcomes = []
    if (workers.length === 0) return outcomes
    const verdict = await probe()
    if (!verdict.ok) {
      return workers.map(worker => ({
        index: worker.index,
        branch: worker.branch,
        dir: worker.dir,
        status: 'unavailable',
        files: [],
        detail: verdict.reason,
      }))
    }
    const dirty = await run(verdict.base, ['status', '--porcelain'])
    if (!dirty.ok) {
      return workers.map(worker => ({
        index: worker.index,
        branch: worker.branch,
        dir: worker.dir,
        status: 'skipped',
        files: [],
        detail: `cannot read the main checkout: ${firstLine(dirty.stderr)}`,
      }))
    }
    if (dirty.stdout.trim()) {
      // Merging into a checkout with uncommitted work would mix the user's edits
      // with the workers' and make an abort restore the wrong state, so leave
      // both sides untouched and say what to do.
      const detail = 'the main working directory has uncommitted changes, so its state is left exactly as it was; '
        + 'commit or stash them, then merge the kept branch'
      return workers.map(worker => ({
        index: worker.index,
        branch: worker.branch,
        dir: worker.dir,
        status: 'skipped',
        files: [],
        detail,
      }))
    }

    for (const worker of workers) {
      const merged = await run(verdict.base, [
        // The merge commit needs an identity; a host that never configured git
        // user.name must not turn a clean merge into a failure.
        '-c', 'user.name=dsh-superagent',
        '-c', 'user.email=superagent@localhost',
        'merge', '--no-ff', '--no-edit', '-m', `superagent: merge worker ${worker.index}`, worker.branch,
      ])
      if (merged.ok) {
        await release(worker)
        outcomes.push({ index: worker.index, branch: worker.branch, dir: null, status: 'merged', files: [], detail: null })
        continue
      }
      const conflicted = await run(verdict.base, ['diff', '--name-only', '--diff-filter=U'])
      const files = conflicted.stdout.split('\n').map(line => line.trim()).filter(Boolean)
      const aborted = await run(verdict.base, ['merge', '--abort'])
      if (!aborted.ok) {
        log(`cannot abort the failed merge of ${worker.branch}: ${firstLine(aborted.stderr)}`)
      }
      outcomes.push({
        index: worker.index,
        branch: worker.branch,
        dir: worker.dir,
        status: files.length > 0 ? 'conflict' : 'failed',
        files,
        detail: files.length > 0
          ? `the change conflicts with work already in ${verdict.base}; the main checkout was restored and the branch kept`
          : firstLine(merged.stderr) || 'git merge failed',
      })
    }
    return outcomes
  }

  return {
    probe,
    prepare,
    harvest,
    mergeAll,
    release,
    /** The resolved pool; available once `probe()` has found the repository. */
    get root() {
      return resolvedRoot
    },
    baseDir,
  }
}

/**
 * Render the workspace section of a run for `superagent_status` and the
 * notification. Kept here, next to the outcomes it describes, so the wording
 * cannot drift from what mergeAll actually recorded.
 *
 * @param {object | null} workspace - `run.workspace`.
 * @returns {string[]} zero or more lines.
 */
export function describeWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object') return []
  if (workspace.mode === 'unavailable') {
    return [
      `workspace: isolation was requested but is unavailable — ${workspace.reason}; `
      + `workers shared ${workspace.base ?? 'the main directory'}, so their edits can overwrite each other`,
    ]
  }
  if (workspace.mode !== 'git-worktree') return []
  const merges = Array.isArray(workspace.merges) ? workspace.merges : []
  const lines = [
    `workspace: each worker ran in its own git worktree under ${workspace.root ?? workspace.base} `
    + `(main checkout ${workspace.base})`,
  ]
  if (workspace.deferred) {
    lines.push(`workspace: not merged — ${workspace.deferred}`)
  }
  if (workspace.baseNote) {
    lines.push(`workspace warning: ${workspace.baseNote}`)
  }
  for (const failure of Array.isArray(workspace.failures) ? workspace.failures : []) {
    lines.push(`workspace: [${failure.index}] could not get its own checkout — ${failure.reason}; it ran in the shared directory`)
  }
  for (const merge of merges) {
    if (merge.status === 'merged') {
      lines.push(`workspace: [${merge.index}] merged back (${merge.branch})`)
    } else if (merge.status === 'no-changes') {
      lines.push(`workspace: [${merge.index}] changed no files`)
    } else if (merge.status === 'conflict') {
      lines.push(
        `workspace conflict: [${merge.index}] ${merge.files?.join(', ') || 'unmerged files'} — `
        + `branch ${merge.branch} kept at ${merge.dir}; the main checkout was restored, so nothing was lost. `
        + `Resolve with: git -C ${quote(workspace.base)} merge ${merge.branch}`,
      )
    } else {
      lines.push(
        `workspace: [${merge.index}] not merged (${merge.status}) — ${merge.detail ?? 'no detail'}`
        + `${merge.branch ? `; branch ${merge.branch} kept${merge.dir ? ` at ${merge.dir}` : ''}` : ''}`
        + `${merge.branch ? `. Finish with: git -C ${quote(workspace.base)} merge --no-ff ${merge.branch}` : ''}`,
      )
    }
  }
  return lines
}
