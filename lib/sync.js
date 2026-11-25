/**
 * Approximate multi-device sync for the state directory, carried by a git
 * repository. There is no server: the remote is whatever git remote the user
 * already has, and `git` itself is the only dependency.
 *
 * What the state directory actually looks like decides the conflict surface,
 * so the layout matters here:
 *
 * - `runs/<runId>.json` is one whole file per run (see store.js), rewritten in
 *   place on every save. Two machines only touch the same file when they work
 *   on the same run id, so the per-run split — not one shared JSONL — is what
 *   keeps ordinary concurrent runs from colliding at all.
 * - `memory/<scope>.jsonl` is append-only per scope. Two machines appending to
 *   one scope are the realistic conflict: git sees two different lines added at
 *   the same tail position.
 * - `<runId>.lock`, `<runId>.cancel`, `.owner`, `control.json` and
 *   `notifications.json` describe one machine or one process. They are ignored,
 *   and `control.json` is a bearer token, so it must never be committed.
 *
 * A conflict is never resolved automatically: the merge is left in place with
 * both sides, the paths are returned, and the caller reports them.
 *
 * @module dsh-superagent/sync
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Patterns kept out of the synced repository. Each one either names a secret,
 * a per-machine identity, or a side file that is meaningless on another host.
 */
export const IGNORE_PATTERNS = [
  '.owner',
  'control.json',
  'workbench.json',
  'console.json',
  'console-workbench.json',
  'board.json',
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.lock',
  '*.cancel',
  '*.corrupt-*',
  '*.tmp',
  'notifications.json',
  '*.log',
]

/** Markers that let a later `sync init` refresh only its own block. */
export const IGNORE_START = '# >>> dsh-superagent sync — machine-local files below (managed block)'
export const IGNORE_END = '# <<< dsh-superagent sync'

/** Why the ignored files are ignored, printed by `sync init`. */
export const IGNORE_REASONS = {
  '.owner': 'hostname of the machine that mounted the directory',
  'control.json': 'bearer token for the loopback control plane',
  'workbench.json': 'bearer token for the loopback workbench',
  'console.json': 'bearer token for the loopback conversation console',
  'console-workbench.json': 'machine-local console sessions and projects',
  'board.json': 'bearer token for the loopback task board',
  '.env': 'environment files can hold credentials',
  '.env.*': 'environment files can hold credentials',
  '*.key': 'private keys',
  '*.pem': 'certificates and keys',
  '*.lock': 'a run lock names one live process on one machine',
  '*.cancel': 'a cancel request is consumed by the owner and is not history',
  '*.corrupt-*': 'quarantined bytes from one machine, kept locally',
  '*.tmp': 'half-written temp file from an interrupted save',
  'notifications.json': 'rolling-hour notification counter for this machine',
  '*.log': 'logs describe this machine only',
}

/**
 * @returns {string} the managed block, including its markers and a trailing newline.
 */
export function buildIgnoreBlock() {
  return `${IGNORE_START}\n${IGNORE_PATTERNS.join('\n')}\n${IGNORE_END}\n`
}

/**
 * Add or refresh the managed block without touching anything outside it, so a
 * user's own entries in `.gitignore` survive a second `sync init`.
 * @param {string} [existing] - current `.gitignore` contents.
 * @returns {{ text: string, changed: boolean }} new contents and whether they differ.
 */
export function mergeIgnore(existing = '') {
  const text = String(existing)
  const block = buildIgnoreBlock()
  const start = text.indexOf(IGNORE_START)
  const end = text.indexOf(IGNORE_END)
  let next
  if (start !== -1 && end > start) {
    next = `${text.slice(0, start)}${block}${text.slice(end + IGNORE_END.length).replace(/^\r?\n/, '')}`
  } else {
    const base = text.replace(/\s+$/, '')
    next = base ? `${base}\n\n${block}` : block
  }
  const normalize = value => value.replace(/\s+$/, '')
  return { text: next, changed: normalize(next) !== normalize(text) }
}

const TOKEN_FILES = ['control.json', 'workbench.json', 'console.json', 'board.json']
const isTokenFile = name => {
  const normalized = String(name).replace(/\\/g, '/')
  return TOKEN_FILES.includes(path.posix.basename(normalized).toLowerCase())
}

/** Message prefix for a command that could not run at all. */
function gitFailure(args, result) {
  const output = `${result.stderr}${result.stdout}`.trim()
  return new Error(`git ${args[0]} failed${output ? `: ${output.split('\n').slice(0, 3).join(' ')}` : ''}`)
}

/**
 * Build a sync handle bound to one state directory.
 * @param {string} root - absolute state root (the directory that becomes a repository).
 * @param {object} [options] - overrides.
 * @param {string} [options.gitBin] - git executable; defaults to `git` on PATH.
 * @param {string} [options.hostname] - machine name recorded in commit messages.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @returns {object} `init`, `pull`, `push`, `status`.
 */
export function createSync(root, options = {}) {
  const stateRoot = path.resolve(root)
  const gitBin = options.gitBin ?? 'git'
  const hostname = options.hostname ?? os.hostname()
  const now = options.now ?? (() => Date.now())
  const stamp = () => new Date(now()).toISOString()

  /**
   * Run git once. A non-zero exit is returned rather than thrown, because
   * merge and push rejections are answers, not crashes.
   */
  function exec(args) {
    return new Promise(resolve => {
      execFile(gitBin, args, {
        cwd: stateRoot,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
        if (error.code === 'ENOENT') {
          return resolve({ code: 127, stdout: '', stderr: 'git is not installed or not on PATH' })
        }
        const code = typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? error.message })
      })
    })
  }

  /** Same as `exec`, but a non-zero exit throws with git's own first lines. */
  async function must(args) {
    const result = await exec(args)
    if (result.code !== 0) throw gitFailure(args, result)
    return result
  }

  const repoDir = path.join(stateRoot, '.git')

  async function exists(file) {
    try {
      await fsp.access(file)
      return true
    } catch {
      return false
    }
  }

  async function ensureRepo() {
    if (!(await exists(repoDir))) {
      throw new Error(`${stateRoot} is not a git repository; run "sync init <git-remote>" there first`)
    }
  }

  async function remoteUrl() {
    const result = await exec(['remote', 'get-url', 'origin'])
    return result.code === 0 ? result.stdout.trim() || null : null
  }

  /** @returns {Promise<string | null>} short branch name, or null on detached HEAD. */
  async function branchName() {
    const result = await exec(['symbolic-ref', '--short', 'HEAD'])
    return result.code === 0 ? result.stdout.trim() || null : null
  }

  /** @returns {Promise<string | null>} e.g. `origin/main`, when an upstream is configured. */
  async function upstreamRef() {
    const result = await exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    return result.code === 0 ? result.stdout.trim() || null : null
  }

  async function refExists(ref) {
    return (await exec(['rev-parse', '--verify', '--quiet', ref])).code === 0
  }

  /** @returns {Promise<string[]>} paths git left with conflict markers. */
  async function conflictFiles() {
    const result = await exec(['diff', '--name-only', '--diff-filter=U'])
    if (result.code !== 0) return []
    return result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  }

  async function stashEntries() {
    const result = await exec(['stash', 'list', '--format=%gd%x09%s'])
    if (result.code !== 0) return []
    return result.stdout.split('\n').filter(Boolean).map(line => {
      const [ref, subject = ''] = line.split('\t')
      return { ref, subject }
    })
  }

  /**
   * Stage everything and commit if anything changed.
   * @param {string} message - commit subject.
   * @returns {Promise<string | null>} commit sha, or null when nothing was staged.
   */
  async function commitAll(message) {
    const trackedTokens = await exec(['ls-files', '-z'])
    if (trackedTokens.code !== 0) throw gitFailure(['ls-files'], trackedTokens)
    const trackedNames = trackedTokens.stdout.split('\0').filter(Boolean)
    const secrets = trackedNames.filter(isTokenFile)
    if (secrets.length > 0) {
      throw new Error(`refusing to sync tracked token file(s): ${secrets.join(', ')}; remove them from the index and rotate any exposed token`)
    }
    await must(['add', '-A'])
    const staged = await must(['diff', '--cached', '--name-only', '-z'])
    const names = staged.stdout.split('\0').filter(Boolean)
    const stagedSecrets = names.filter(isTokenFile)
    if (stagedSecrets.length > 0) {
      throw new Error(`refusing to commit token file(s): ${stagedSecrets.join(', ')}`)
    }
    if (names.length === 0) return null
    await must(['commit', '-m', message])
    return (await must(['rev-parse', 'HEAD'])).stdout.trim()
  }

  /** Write the managed block into `<root>/.gitignore`. */
  async function writeIgnoreFile() {
    const file = path.join(stateRoot, '.gitignore')
    let current = ''
    try {
      current = await fsp.readFile(file, 'utf8')
    } catch {
      // No file yet: the block becomes the whole file.
    }
    const merged = mergeIgnore(current)
    if (merged.changed) await fsp.writeFile(file, merged.text, 'utf8')
    return { file, changed: merged.changed, patterns: IGNORE_PATTERNS }
  }

  /**
   * The notebook directory ships a nested `.gitignore` containing `*`, which
   * would keep every note out of this repository too. Inside a state directory
   * that is its own repository the notes are the point, so the default is
   * replaced; a file the user customized is left alone.
   * @returns {Promise<boolean>} whether notes will be synced.
   */
  async function enableMemorySync() {
    const dir = path.join(stateRoot, 'memory')
    const file = path.join(dir, '.gitignore')
    let current = null
    try {
      current = await fsp.readFile(file, 'utf8')
    } catch {
      // Created below.
    }
    if (current !== null && current.replace(/\s+/g, '') !== '*') return false
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(
      file,
      '# managed by dsh-superagent sync: the notebook is what crosses machines\n*\n!.gitignore\n!*.jsonl\n',
      'utf8',
    )
    return true
  }

  return {
    root: stateRoot,

    /**
     * Turn the state directory into a repository, write the ignore rules, and
     * make the first commit. Safe to run again: it refreshes the remote URL and
     * the managed ignore block instead of failing.
     * @param {{ remote: string }} params - remote URL or path for `origin`.
     */
    async init({ remote }) {
      const value = typeof remote === 'string' ? remote.trim() : ''
      if (!value) throw new Error('sync init needs a git remote (an HTTPS URL, an SSH URL, or a path to a bare repository)')
      await fsp.mkdir(stateRoot, { recursive: true })
      const created = !(await exists(repoDir))
      if (created) await must(['init'])
      // A machine with no ~/.gitconfig cannot commit; a repository-local
      // fallback identity keeps the first commit from failing on that alone.
      const hasEmail = (await exec(['config', '--get', 'user.email'])).code === 0
      const hasName = (await exec(['config', '--get', 'user.name'])).code === 0
      if (!hasEmail) await must(['config', 'user.email', 'dsh-superagent-sync@localhost'])
      if (!hasName) await must(['config', 'user.name', 'dsh-superagent sync'])

      const existing = await remoteUrl()
      let remoteAction = 'unchanged'
      if (!existing) {
        await must(['remote', 'add', 'origin', value])
        remoteAction = 'added'
      } else if (existing !== value) {
        await must(['remote', 'set-url', 'origin', value])
        remoteAction = 'updated'
      }

      const ignore = await writeIgnoreFile()
      const memorySynced = await enableMemorySync()
      const commit = await commitAll(`sync init: ${hostname} ${stamp()}`)
      const branch = await branchName()
      return {
        root: stateRoot,
        created,
        branch,
        remote: value,
        remoteAction,
        ignoreChanged: ignore.changed,
        ignoredPatterns: IGNORE_PATTERNS,
        memorySynced,
        commit,
      }
    },

    /**
     * Fetch the remote and merge it. Uncommitted local work is stashed first and
     * reapplied afterwards, so a pull never silently discards an edit. A real
     * conflict is left in the working tree with both sides; nothing is chosen.
     */
    async pull() {
      await ensureRepo()
      // A second pull before the first merge was resolved would fail inside
      // `stash`; report the same conflicts again instead.
      const pending = await conflictFiles()
      if (pending.length > 0) {
        return { stash: null, merged: false, conflicts: pending, ref: await upstreamRef(), output: 'a merge is already in progress' }
      }
      const remote = await remoteUrl()
      if (!remote) throw new Error('this repository has no origin remote; run "sync init <git-remote>" to set one')

      const fetched = await exec(['fetch', '--quiet', 'origin'])
      if (fetched.code !== 0) throw gitFailure(['fetch', 'origin'], fetched)

      let ref = await upstreamRef()
      if (!ref) {
        const branch = await branchName()
        if (!branch) throw new Error('HEAD is detached, so there is no branch to pull into')
        const candidate = `origin/${branch}`
        if (await refExists(candidate)) ref = candidate
      }
      if (!ref) return { stash: null, merged: false, conflicts: [], note: 'the remote has no branch for this repository yet' }

      // Only stash after the fetch succeeded: a failed fetch must leave the
      // working tree exactly as it was.
      const status = await must(['status', '--porcelain'])
      let stash = null
      if (status.stdout.trim()) {
        const message = `dsh-sync auto-stash ${stamp()} on ${hostname}`
        const pushed = await exec(['stash', 'push', '-u', '-m', message])
        if (pushed.code !== 0) throw gitFailure(['stash', 'push'], pushed)
        const entries = await stashEntries()
        const entry = entries.find(item => item.subject === message) ?? entries[0]
        stash = {
          ref: entry?.ref ?? 'stash@{0}',
          message,
          files: status.stdout.split('\n').filter(Boolean).length,
          reapplied: false,
        }
      }

      const merge = await exec(['merge', '--no-edit', '--allow-unrelated-histories', ref])
      const conflicts = await conflictFiles()
      if (conflicts.length > 0) {
        // Both sides stay in the tree. The stash is deliberately not reapplied
        // on top of a half-merged tree: that would only add conflicts to review.
        return { stash, merged: false, conflicts, ref, output: `${merge.stdout}${merge.stderr}`.trim() }
      }
      if (merge.code !== 0) throw gitFailure(['merge', ref], merge)

      if (!(await upstreamRef())) await exec(['branch', `--set-upstream-to=${ref}`])

      if (stash) {
        const pop = await exec(['stash', 'pop'])
        stash.reapplied = pop.code === 0
        if (!stash.reapplied) {
          stash.kept = true
          stash.popError = `${pop.stdout}${pop.stderr}`.trim()
        }
      }
      return {
        stash,
        merged: !/Already up to date/i.test(merge.stdout),
        conflicts: [],
        ref,
        output: merge.stdout.trim(),
      }
    },

    /**
     * Commit local state and push it. A rejection is reported, not merged: the
     * two halves stay separate commands so the user sees the merge.
     * @param {{ message?: string }} [params] - optional commit subject.
     */
    async push({ message } = {}) {
      await ensureRepo()
      const remote = await remoteUrl()
      if (!remote) throw new Error('this repository has no origin remote; run "sync init <git-remote>" to set one')
      const branch = await branchName()
      if (!branch) throw new Error('HEAD is detached, so there is no branch to push')
      const pending = await conflictFiles()
      if (pending.length > 0) {
        const error = new Error(`the state directory still has ${pending.length} unresolved conflict(s): ${pending.join(', ')}`)
        error.conflicts = pending
        throw error
      }

      const commit = await commitAll(message ?? `sync: ${hostname} ${stamp()}`)
      const pushed = await exec(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`])
      if (pushed.code !== 0) {
        const output = `${pushed.stdout}${pushed.stderr}`.trim()
        const rejected = /rejected|non-fast-forward|fetch first/i.test(output)
        return { commit, pushed: false, rejected, branch, output }
      }
      const upstream = await upstreamRef()
      return { commit, pushed: true, branch, upstream, output: `${pushed.stdout}${pushed.stderr}`.trim() }
    },

    /**
     * Local vs remote position and unfinished business.
     * @param {{ fetch?: boolean }} [params] - set `fetch: false` to read last-known refs offline.
     */
    async status({ fetch = true } = {}) {
      await ensureRepo()
      const remote = await remoteUrl()
      const branch = await branchName()
      let fetched = false
      let fetchError = null
      if (fetch && remote) {
        const result = await exec(['fetch', '--quiet', 'origin'])
        fetched = result.code === 0
        if (!fetched) fetchError = `${result.stderr}${result.stdout}`.trim()
      }
      const upstream = await upstreamRef()
      let ahead = null
      let behind = null
      if (upstream) {
        // --left-right --count prints "<upstream only>\t<HEAD only>".
        const counts = await exec(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
        if (counts.code === 0) {
          const [left, right] = counts.stdout.trim().split(/\s+/).map(Number)
          behind = Number.isFinite(left) ? left : null
          ahead = Number.isFinite(right) ? right : null
        }
      }
      const dirty = await must(['status', '--porcelain'])
      const conflicts = await conflictFiles()
      const stashes = await stashEntries()
      const head = await exec(['log', '-1', '--format=%h %s'])
      return {
        root: stateRoot,
        remote,
        branch,
        upstream,
        ahead,
        behind,
        dirty: dirty.stdout.split('\n').filter(Boolean).length,
        conflicts,
        stashes,
        head: head.code === 0 ? head.stdout.trim() : null,
        fetched,
        fetchError,
      }
    },
  }
}
