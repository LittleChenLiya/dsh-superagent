/**
 * Durable run storage for dsh-superagent.
 *
 * One JSON file per run under `<root>/runs/<runId>.json`. Writes are atomic
 * (temp file + rename) so a host crash mid-write cannot leave a half-written
 * run that blocks recovery.
 *
 * Sibling files carry signals that are safe to write from another process:
 * `<runId>.cancel` asks the owning process to stop the run, `<runId>.lock`
 * claims the right to schedule it so two processes cannot run the same one, and
 * `<runId>.json.corrupt-<ts>` keeps an unparsable state file instead of
 * deleting the evidence.
 *
 * @module dsh-superagent/store
 */
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatCurrencyTally } from './cost.js'
import { acquireFileLock, pidAlive, releaseFileLock } from './lock.js'

const runWrites = new Map()
let writeSeq = 0

/** Format marker written into every exported archive. */
export const ARCHIVE_FORMAT = 'dsh-superagent/run-archive'

/** Archive layout version; `import` refuses a version it cannot read. */
export const ARCHIVE_FORMAT_VERSION = 1

/** Statuses for a run that still owns live work. */
export const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'aggregating'])

/** Statuses after which a run will not change on its own. */
export const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted'])

/**
 * Prefix of a goal guard: the lock a start holds while it decides whether a run
 * for that goal already exists. It is keyed by the goal rather than by a run id,
 * so it has no run file of its own and the mount-time cleanup must leave it
 * alone instead of treating it as a lock left behind by a finished run.
 */
export const GOAL_GUARD_PREFIX = 'goal-'

const RUN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{3,63}$/
const STALE_TMP_MS = 10 * 60 * 1000
const EMBEDDED_ARCHIVE = /<script[^>]*id="superagent-archive"[^>]*>([\s\S]*?)<\/script>/i

/**
 * Turn a `--status` filter into a validated set. A typo must fail loudly:
 * silently matching nothing would make an operator believe a prune ran.
 * @param {string | string[] | undefined | null} value - comma list or array.
 * @returns {Set<string> | null} allowed statuses, or null for "all terminal".
 */
function normalizeStatuses(value) {
  if (value === undefined || value === null) return null
  const list = Array.isArray(value) ? value : String(value).split(',')
  const statuses = [...new Set(list.map(item => String(item).trim().toLowerCase()).filter(Boolean))]
  const terminal = [...TERMINAL_STATUSES].join(', ')
  if (statuses.length === 0) throw new Error(`a status filter needs at least one status (terminal: ${terminal})`)
  const unknown = statuses.filter(status => !TERMINAL_STATUSES.has(status))
  if (unknown.length > 0) {
    throw new Error(`status filter ${unknown.join(', ')} is not terminal; only ${terminal} runs can be pruned`)
  }
  return new Set(statuses)
}

/** Filesystem-safe fragment for a subtask title. */
function slugOf(text, fallback) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || fallback
}

/** One subtask as a standalone markdown page inside an export. */
function renderSubtaskMarkdown(subtask) {
  const lines = [
    `# Subtask ${subtask.index ?? '?'} — ${subtask.title || '(untitled)'}`,
    '',
    `- status: ${subtask.status}`,
    `- attempts: ${subtask.attempts ?? 0}`,
    `- started: ${subtask.startedAt ?? 'unknown'}`,
    `- finished: ${subtask.finishedAt ?? 'not finished'}`,
    `- child: ${subtask.childId ?? 'none'}`,
    `- tokens: ${subtask.usage?.totalTokens ?? 0} across ${subtask.usage?.modelCalls ?? 0} model call(s)`,
  ]
  if (subtask.error) lines.push(`- error: ${subtask.error}`)
  lines.push('', '## Prompt', '', subtask.prompt || '_No prompt recorded._')
  lines.push('', '## Result', '', subtask.result || '_No result recorded._')
  return `${lines.join('\n')}\n`
}

/** Guard/attention records as markdown; these are the run's interception trail. */
function renderGuardsMarkdown(guards, at) {
  const lines = ['# Guard and attention records', '', `Recorded at: ${at ?? 'unknown'}`, '']
  if (guards.issue) lines.push(`Issue: ${guards.issue}`, '')
  if (guards.items.length === 0 && !guards.issue) lines.push('No worker or aggregator asked for a decision during this run.', '')
  guards.items.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.source ?? 'unknown source'}`, '')
    lines.push(`Question: ${item.question ?? '(none)'}`)
    if (Array.isArray(item.options) && item.options.length > 0) {
      lines.push('', 'Options:', ...item.options.map(option => `- ${option}`))
    }
    if (item.reason) lines.push('', `Reason: ${item.reason}`)
    lines.push('')
  })
  return `${lines.join('\n').trimEnd()}\n`
}

/** Human-readable cost with the unpriced caveat stated, never guessed. */
function renderCost(cost) {
  if (!cost) return 'unpriced (no configured price for these models)'
  const tally = cost.byCurrency && typeof cost.byCurrency === 'object' ? cost.byCurrency : null
  const mixed = tally !== null && Object.keys(tally).length > 1
  if (!mixed && !Number.isFinite(cost.total)) return 'unpriced (no configured price for these models)'
  const amount = mixed ? formatCurrencyTally(tally) : `${cost.currency ?? 'USD'} ${cost.total.toFixed(4)}`
  if (cost.complete === false) {
    return `${amount} (partial; unpriced: ${(cost.unpriced ?? []).join(', ') || 'unknown'})`
  }
  return amount
}

/** One page a reader can open first; the report itself follows inline. */
function renderReadme(archive) {
  const subtasks = archive.subtasks
  const counts = {}
  for (const subtask of subtasks) counts[subtask.status] = (counts[subtask.status] ?? 0) + 1
  const breakdown = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')
  const lines = [
    `# Superagent run ${archive.runId}`,
    '',
    `- goal: ${archive.goal || '(empty)'}`,
    `- status: ${archive.status}`,
    `- created: ${archive.createdAt ?? 'unknown'}`,
    `- finished: ${archive.finishedAt ?? 'not finished'}`,
    `- subtasks: ${subtasks.length}${breakdown ? ` (${breakdown})` : ''}`,
    `- guards: ${archive.guards.items.length} decision request(s)${archive.guards.issue ? '; one attention block was unusable' : ''}`,
    `- tokens: ${archive.usage?.totalTokens ?? 0} across ${archive.usage?.modelCalls ?? 0} model call(s)`,
    `- cost: ${renderCost(archive.cost)}`,
    '',
    '## Report',
    '',
    archive.report || '_No merged report was recorded for this run._',
    '',
    '## Subtasks',
    '',
  ]
  if (subtasks.length === 0) lines.push('_No subtasks recorded._')
  else {
    lines.push('| # | status | title | tokens |', '| --- | --- | --- | --- |')
    for (const subtask of subtasks) {
      const title = String(subtask.title ?? '').replace(/\|/g, '\\|')
      lines.push(`| ${subtask.index ?? '-'} | ${subtask.status} | ${title} | ${subtask.usage?.totalTokens ?? '-'} |`)
    }
  }
  lines.push(
    '',
    '## Files',
    '',
    'Everything in this directory is part of the archive; nothing is fetched from the network.',
    '',
    '- `run.json` — the full durable run record as the store wrote it',
    '- `report.md` — the final merged report',
    '- `subtasks/` — each subtask as markdown (readable) and JSON (structured)',
    '- `guards.json` / `guards.md` — worker and aggregator decisions the run stopped on',
    '- `usage.json` — token totals per child, plus the cost the operator prices produce',
    '- `manifest.json` — archive metadata, file sizes, and SHA-256 checksums',
  )
  return `${lines.join('\n')}\n`
}

/**
 * Resolve the state root. An explicit `stateDir` wins, then `$DSH_HOME`, then
 * the harness default `~/.dsh`.
 * @param {string | undefined} configured - plugin config `stateDir`.
 * @returns {string} absolute state root.
 */
export function resolveStateRoot(configured) {
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim())
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'state', 'superagent')
}

/**
 * Build a store bound to one state root.
 * @param {string} root - absolute state root.
 * @param {{ warn?: (message: string) => void }} [options] - diagnostics sink.
 */
export function createStore(root, options = {}) {
  const runsDir = path.join(root, 'runs')
  const warn = options.warn ?? (() => {})
  // Two saves of the same run can land in the same millisecond, so the temp
  // name needs a counter as well as a clock.
  /** runId -> quarantine path, so status can explain a run it cannot parse. */
  const corrupt = new Map()
  const heldLocks = new Map()

  const runFile = runId => path.join(runsDir, `${runId}.json`)
  const cancelFile = runId => path.join(runsDir, `${runId}.cancel`)
  const lockFile = runId => path.join(runsDir, `${runId}.lock`)
  const reportFile = runId => path.join(root, 'reports', `${runId}.md`)
  const ownerFile = path.join(root, '.owner')

  /** File size, or null when the file does not exist (or is not a file). */
  const sizeOf = async file => {
    try {
      const stat = await fsp.stat(file)
      return stat.isFile() ? stat.size : null
    } catch {
      return null
    }
  }

  /**
   * A lock file is the cross-process claim on a run. Even a terminal run must
   * be left alone while one exists: another process may be mid-write.
   */
  const isHeld = async runId => (await sizeOf(lockFile(runId))) !== null

  /** The report text, preferring the run record and falling back to its artifact. */
  const reportTextOf = async run => {
    if (typeof run.report === 'string' && run.report.trim()) return run.report.trim()
    try {
      const text = await fsp.readFile(reportFile(run.id), 'utf8')
      return text.trim() ? text.trim() : null
    } catch {
      return null
    }
  }

  return {
    root,
    runsDir,
    ownerFile,
    corrupt,

    async init() {
      await fsp.mkdir(runsDir, { recursive: true })
      await this.cleanup()
    },

    /**
     * Remove temp files left by a killed process and sibling markers whose run
     * already reached a terminal state, so none of them can affect later runs.
     */
    async cleanup() {
      let names
      try {
        names = await fsp.readdir(runsDir)
      } catch {
        return
      }
      for (const name of names) {
        const file = path.join(runsDir, name)
        if (name.startsWith('.') && name.endsWith('.tmp')) {
          try {
            const stat = await fsp.stat(file)
            if (Date.now() - stat.mtimeMs > STALE_TMP_MS) await fsp.unlink(file)
          } catch {
            // Already gone; nothing to clean.
          }
          continue
        }
        const marker = ['.cancel', '.lock'].find(suffix => name.endsWith(suffix))
        if (!marker) continue
        // A goal guard is not a run lock and has no run file to read; its
        // holder releases it, or a later start breaks a dead holder's guard.
        if (name.startsWith(GOAL_GUARD_PREFIX) && marker === '.lock') continue
        let run = null
        let readable = true
        try {
          run = await this.read(name.slice(0, -marker.length))
        } catch {
          // An unreadable run file is not a reason to drop its control files.
          readable = false
        }
        if (!readable) continue
        if (!run || TERMINAL_STATUSES.has(run.status)) {
          try {
            const id = name.slice(0, -marker.length)
            const holder = marker === '.lock' ? await this.readLock(id) : null
            if (marker === '.lock') {
              // A terminal record is published before the owner releases its
              // lock. Another mount must not steal that still-live claim.
              if (holder?.hostname !== os.hostname() || pidAlive(holder?.pid) !== false) continue
            }
            if (marker === '.lock') await this.releaseLock(id, holder)
            else await fsp.unlink(file)
          } catch {
            // Nothing to clean.
          }
        }
      }
    },

    /**
     * Read every readable run, newest first. A corrupt file is quarantined and
     * skipped rather than failing the whole listing; a file that cannot be read
     * at all is reported and skipped for the same reason.
     */
    async list() {
      let names
      try {
        names = await fsp.readdir(runsDir)
      } catch (error) {
        // A missing runs directory means initialization did not happen; saying
        // "no runs recorded" would hide that. Only an empty directory is empty.
        const code = error?.code ? `${error.code}: ` : ''
        throw new Error(
          `cannot read the run state directory ${runsDir} (${code}${error?.message ?? error}); `
          + 'the plugin could not initialize it, so no run can be listed or resumed',
        )
      }
      const runs = []
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue
        try {
          const run = await this.read(name.slice(0, -'.json'.length))
          if (run) runs.push(run)
        } catch (error) {
          warn(`skipping run file ${name}: ${error?.message ?? error}`)
        }
      }
      runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      return runs
    },

    /**
     * @param {string} runId - run identity.
     * @returns {Promise<object | null>} parsed run, or null when missing/invalid.
     * @throws when the file exists but cannot be read (EPERM, EMFILE, ENOSPC...).
     *   Reporting that as "unknown run" would hide a real filesystem problem.
     */
    async read(runId) {
      if (!RUN_ID_PATTERN.test(String(runId))) return null
      // Windows can fail a read with EBUSY/EACCES for a moment while another
      // process replaces the file. Those are transient for a reader, so retry
      // before turning a poll into a hard error; real permission errors still
      // surface after the retries.
      for (let attempt = 1; ; attempt++) {
        try {
          const text = await fsp.readFile(runFile(runId), 'utf8')
          const run = JSON.parse(text)
          if (!run || typeof run !== 'object') {
            await this.quarantine(runId)
            return null
          }
          return run
        } catch (error) {
          if (error?.code === 'ENOENT') return null
          if (error instanceof SyntaxError) {
            const moved = await this.quarantine(runId)
            warn(`state file for run ${runId} was not valid JSON; kept at ${moved ?? 'the runs directory'}`)
            return null
          }
          const transient = ['EPERM', 'EACCES', 'EBUSY', 'EMFILE'].includes(error?.code)
          if (transient && attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 15 * attempt))
            continue
          }
          const code = error?.code ? `${error.code}: ` : ''
          throw new Error(`cannot read state for run ${runId} (${code}${error?.message ?? error})`)
        }
      }
    },

    /**
     * Move an unparsable state file aside so it neither blocks recovery nor
     * gets overwritten by the next save of the same id.
     * @param {string} runId - run identity.
     * @returns {Promise<string | null>} new path, or null when nothing moved.
     */
    async quarantine(runId) {
      const target = `${runFile(runId)}.corrupt-${Date.now()}`
      try {
        await fsp.rename(runFile(runId), target)
        corrupt.set(runId, target)
        return target
      } catch {
        return null
      }
    },

    /**
     * Atomically persist one run.
     * @param {object} run - run record with an `id`.
     */
    async write(run) {
      const file = runFile(run.id)
      const tmp = path.join(runsDir, `.${run.id}.${process.pid}.${++writeSeq}.tmp`)
      const body = `${JSON.stringify(run, null, 2)}\n`
      const prior = runWrites.get(file) ?? Promise.resolve()
      const write = prior.catch(() => {}).then(async () => {
        try {
          await fsp.writeFile(tmp, body, 'utf8')
          for (let attempt = 1; ; attempt++) {
            try {
              await fsp.rename(tmp, file)
              return
            } catch (error) {
              // Windows can briefly refuse a replace while a reader holds the file.
              if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
              await new Promise(resolve => setTimeout(resolve, 20 * attempt))
            }
          }
        } catch (error) {
          await fsp.unlink(tmp).catch(() => {})
          throw error
        }
      })
      runWrites.set(file, write)
      try {
        await write
      } finally {
        if (runWrites.get(file) === write) runWrites.delete(file)
      }
    },

    /**
     * Ask whichever process owns a run to stop it. This is a file, not IPC, so
     * it works across processes and survives a restart.
     * @param {string} runId - run identity.
     */
    async requestCancel(runId) {
      if (!RUN_ID_PATTERN.test(String(runId))) return false
      await fsp.writeFile(cancelFile(runId), `${JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid })}\n`, 'utf8')
      return true
    },

    /**
     * @param {string} runId - run identity.
     * @returns {Promise<boolean>} true when a cancel was requested by any process.
     */
    async hasCancelRequest(runId) {
      try {
        await fsp.access(cancelFile(runId))
        return true
      } catch {
        return false
      }
    },

    /**
     * @param {string} runId - run identity.
     */
    async clearCancel(runId) {
      try {
        await fsp.unlink(cancelFile(runId))
      } catch {
        // Nothing to clear.
      }
    },

    cancelFile,

    /**
     * Claim the right to schedule one run. The lock is created with `wx`, so
     * exactly one process wins even when two profiles point at the same state
     * directory; the loser gets the holder instead of a second copy of the run.
     * @param {string} runId - run identity.
     * @param {{ pid: number, hostname: string, at: string }} holder - claimant.
     * @returns {Promise<{ acquired: boolean, holder: object | null }>}
     */
    async acquireLock(runId, holder) {
      if (!RUN_ID_PATTERN.test(String(runId))) return { acquired: false, holder: null }
      const release = await acquireFileLock(lockFile(runId), {
        staleMs: Number.POSITIVE_INFINITY,
        reclaimDead: false,
        reclaimStale: false,
        holder,
      })
      if (!release) return { acquired: false, holder: await this.readLock(runId) }
      heldLocks.set(runId, release)
      return { acquired: true, holder }
    },

    /**
     * @param {string} runId - run identity.
     * @returns {Promise<object | null>} recorded holder, or null.
     */
    async readLock(runId) {
      if (!RUN_ID_PATTERN.test(String(runId))) return null
      try {
        const parsed = JSON.parse(await fsp.readFile(lockFile(runId), 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    },

    /**
     * @param {string} runId - run identity.
     */
    async releaseLock(runId, holder = null) {
      const release = heldLocks.get(runId)
      if (release) {
        await release()
        heldLocks.delete(runId)
        return
      }
      if (holder?.token) await releaseFileLock(lockFile(runId), holder.token)
      else if (holder) await releaseFileLock(lockFile(runId), null, { expected: holder })
    },

    /**
     * Machine identity of the state directory, written once by the first
     * process that mounts it. Its presence tells later processes whether a pid
     * in a run file belongs to this machine (local) or possibly to another one
     * sharing the directory, where the pid is meaningless.
     * @returns {Promise<{ hostname?: string, createdAt?: string } | null>}
     */
    async readOwner() {
      try {
        const parsed = JSON.parse(await fsp.readFile(ownerFile, 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    },

    /**
     * @param {{ hostname: string, createdAt?: string }} owner - identity to record.
     */
    async writeOwner(owner) {
      try {
        await fsp.writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, 'utf8')
      } catch (error) {
        warn(`cannot record the state directory owner in ${ownerFile}: ${error?.message ?? error}`)
      }
    },

    /**
     * Decide which runs a prune would remove, without touching anything.
     *
     * A run qualifies only when it is terminal, inside the age window, inside
     * the optional status filter, and not claimed by a lock file. Active runs
     * are never candidates, so the plan is safe to show before deleting.
     *
     * @param {{ olderThanDays?: number, statuses?: string[] | string }} [options] - window and filter.
     * @returns {Promise<{
     *   candidates: { id: string, status: string, goal: string, finishedAt: string, bytes: number, files: { kind: string, path: string, bytes: number }[] }[],
     *   skipped: { id: string, status: string, reason: string }[],
     *   removed: string[], dryRun: boolean, bytes: number, files: number,
     * }>} the plan; `removed` is always empty here.
     */
    async planPrune(options = {}) {
      const days = Number(options.olderThanDays)
      if (!Number.isFinite(days) || days <= 0) {
        throw new Error('olderThanDays must be a positive number of days')
      }
      const wanted = normalizeStatuses(options.statuses)
      const cutoff = Date.now() - days * 86400000
      const candidates = []
      const skipped = []
      for (const run of await this.list()) {
        if (!TERMINAL_STATUSES.has(run.status)) continue
        if (wanted && !wanted.has(run.status)) continue
        const finished = Date.parse(run.finishedAt ?? run.updatedAt ?? run.createdAt)
        if (!Number.isFinite(finished) || finished > cutoff) continue
        if (await isHeld(run.id)) {
          skipped.push({ id: run.id, status: String(run.status), reason: 'held by another process' })
          continue
        }
        const files = []
        for (const [kind, file] of [['run', runFile(run.id)], ['cancel', cancelFile(run.id)], ['report', reportFile(run.id)]]) {
          const bytes = await sizeOf(file)
          if (bytes !== null) files.push({ kind, path: file, bytes })
        }
        candidates.push({
          id: run.id,
          status: String(run.status),
          goal: String(run.goal ?? ''),
          finishedAt: new Date(finished).toISOString(),
          bytes: files.reduce((sum, file) => sum + file.bytes, 0),
          files,
        })
      }
      return {
        candidates,
        skipped,
        removed: [],
        dryRun: true,
        bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
        files: candidates.reduce((sum, candidate) => sum + candidate.files.length, 0),
      }
    },

    /**
     * Delete terminal runs older than `olderThanDays`, so an install that runs
     * for months does not accumulate state forever.
     *
     * The CLI prune defaults to `dryRun: true`; the mount-time `keepRuns` call
     * passes `dryRun: false` because the operator already opted in through the
     * config. A locked or live run is never deleted.
     *
     * @param {{ olderThanDays: number, statuses?: string[] | string, dryRun?: boolean }} options - window, filter, and mode.
     * @returns {Promise<object>} the plan plus `removed`, `failed`, and `deletedBytes`.
     */
    async prune({ olderThanDays, statuses, dryRun = false } = {}) {
      const days = Number(olderThanDays)
      if (!Number.isFinite(days) || days <= 0) {
        return { candidates: [], skipped: [], removed: [], failed: [], dryRun, bytes: 0, deletedBytes: 0, files: 0 }
      }
      const plan = await this.planPrune({ olderThanDays: days, statuses })
      if (dryRun) return { ...plan, failed: [], deletedBytes: 0 }
      const wanted = normalizeStatuses(statuses)
      const cutoff = Date.now() - days * 86400000
      const removed = []
      const failed = []
      const skipped = [...plan.skipped]
      let deletedBytes = 0
      for (const candidate of plan.candidates) {
        const holder = { pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() }
        let claimed = false
        try {
          const claim = await this.acquireLock(candidate.id, holder)
          if (!claim.acquired) {
            skipped.push({ id: candidate.id, status: candidate.status, reason: 'held by another process' })
            continue
          }
          claimed = true
          const current = await this.read(candidate.id)
          const finished = current ? Date.parse(current.finishedAt ?? current.updatedAt ?? current.createdAt) : Number.NaN
          if (!current || !TERMINAL_STATUSES.has(current.status)
            || (wanted && !wanted.has(current.status)) || !Number.isFinite(finished) || finished > cutoff) {
            skipped.push({ id: candidate.id, status: current?.status ?? candidate.status, reason: 'run changed before deletion' })
            continue
          }
          // Auxiliary files first: a failure then leaves the run record that
          // names what could not be cleaned up, instead of an orphan report.
          for (const file of candidate.files) {
            if (file.kind === 'run') continue
            await fsp.unlink(file.path).catch(error => {
              if (error?.code !== 'ENOENT') throw error
            })
          }
          await fsp.unlink(runFile(candidate.id)).catch(error => {
            if (error?.code !== 'ENOENT') throw error
          })
          removed.push(candidate.id)
          deletedBytes += candidate.bytes
        } catch (error) {
          failed.push({ id: candidate.id, error: String(error?.message ?? error) })
          warn(`cannot prune run ${candidate.id}: ${error?.message ?? error}`)
        } finally {
          if (claimed) await this.releaseLock(candidate.id)
        }
      }
      return { ...plan, skipped, dryRun: false, removed, failed, deletedBytes }
    },

    /**
     * Build the portable form of one run: metadata, the full record, the final
     * report, structured subtask results, guard records, and usage/cost.
     * @param {string} runId - run identity.
     * @param {{ exportedAt?: string }} [options] - timestamp override for tests.
     * @returns {Promise<object>} the archive payload.
     * @throws when the run does not exist.
     */
    async buildArchive(runId, options = {}) {
      const run = await this.read(runId)
      if (!run) throw new Error(`no run ${runId} in ${this.root}`)
      const report = await reportTextOf(run)
      const subtasks = (Array.isArray(run.subtasks) ? run.subtasks : []).map(subtask => ({
        index: subtask.index ?? null,
        title: subtask.title ?? '',
        status: subtask.status ?? 'unknown',
        prompt: subtask.prompt ?? '',
        result: subtask.result ?? null,
        error: subtask.error ?? null,
        attempts: subtask.attempts ?? 0,
        childId: subtask.childId ?? null,
        startedAt: subtask.startedAt ?? null,
        finishedAt: subtask.finishedAt ?? null,
        usage: subtask.usage ?? null,
      }))
      return {
        format: ARCHIVE_FORMAT,
        formatVersion: ARCHIVE_FORMAT_VERSION,
        exportedAt: options.exportedAt ?? new Date().toISOString(),
        generator: 'dsh-superagent',
        runId: run.id,
        goal: String(run.goal ?? ''),
        status: String(run.status ?? 'unknown'),
        createdAt: run.createdAt ?? null,
        finishedAt: run.finishedAt ?? null,
        usage: run.usage ?? null,
        cost: run.cost ?? null,
        guards: {
          at: run.attention?.at ?? null,
          issue: run.attention?.issue ?? null,
          items: Array.isArray(run.attention?.items) ? run.attention.items : [],
        },
        report,
        subtasks,
        run,
      }
    },

    /**
     * Write one run as a self-contained archive.
     *
     * `dir` writes a readable directory (README, markdown report, per-subtask
     * pages, guard and usage files, manifest with checksums). `bundle` writes a
     * single JSON file, and `html` writes one self-contained page with the same
     * bundle embedded so it can be read and imported offline.
     *
     * @param {string} runId - run identity.
     * @param {string} target - directory for `dir`, file path otherwise.
     * @param {{ format?: 'dir' | 'bundle' | 'html', exportedAt?: string }} [options] - layout.
     * @returns {Promise<{ runId: string, format: string, out: string, bytes: number, files: { path: string, bytes: number }[] }>}
     */
    async exportRun(runId, target, options = {}) {
      const format = options.format ?? 'dir'
      if (!['dir', 'bundle', 'html'].includes(format)) {
        throw new Error(`unknown archive format ${JSON.stringify(format)}; use dir, bundle, or html`)
      }
      const archive = await this.buildArchive(runId, options)
      const out = path.resolve(String(target))

      if (format === 'dir') {
        // A stale file from a previous export must not be mistaken for part of
        // this archive, and an unrelated directory must not be written into.
        const existing = await fsp.readdir(out).catch(() => null)
        if (existing && existing.length > 0) {
          throw new Error(`refusing to overwrite ${out}: it already exists and is not empty; choose another --out`)
        }
        await fsp.mkdir(out, { recursive: true })
        const files = []
        const put = async (relative, body) => {
          const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
          const file = path.join(out, relative)
          await fsp.mkdir(path.dirname(file), { recursive: true })
          await fsp.writeFile(file, buffer)
          files.push({ path: relative, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') })
        }
        await put('run.json', `${JSON.stringify(archive.run, null, 2)}\n`)
        if (archive.report) await put('report.md', `${archive.report.trimEnd()}\n`)
        for (const subtask of archive.subtasks) {
          const index = String(subtask.index ?? 0).padStart(2, '0')
          const base = `subtasks/${index}-${slugOf(subtask.title, 'subtask')}`
          await put(`${base}.md`, renderSubtaskMarkdown(subtask))
          await put(`${base}.json`, `${JSON.stringify(subtask, null, 2)}\n`)
        }
        await put('guards.json', `${JSON.stringify(archive.guards, null, 2)}\n`)
        await put('guards.md', renderGuardsMarkdown(archive.guards, archive.guards.at))
        await put('usage.json', `${JSON.stringify({
          total: archive.usage,
          byChild: archive.run.usageByChild ?? {},
          cost: archive.cost,
        }, null, 2)}\n`)
        await put('README.md', renderReadme(archive))
        const manifest = {
          format: ARCHIVE_FORMAT,
          formatVersion: ARCHIVE_FORMAT_VERSION,
          exportedAt: archive.exportedAt,
          generator: archive.generator,
          runId: archive.runId,
          goal: archive.goal,
          status: archive.status,
          createdAt: archive.createdAt,
          finishedAt: archive.finishedAt,
          counts: { subtasks: archive.subtasks.length, guards: archive.guards.items.length },
          totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
          files,
        }
        const body = `${JSON.stringify(manifest, null, 2)}\n`
        await fsp.writeFile(path.join(out, 'manifest.json'), body, 'utf8')
        const all = [...files, { path: 'manifest.json', bytes: Buffer.byteLength(body) }]
        return { runId: archive.runId, format, out, bytes: all.reduce((sum, file) => sum + file.bytes, 0), files: all }
      }

      await fsp.mkdir(path.dirname(out), { recursive: true })
      let body
      if (format === 'bundle') {
        body = `${JSON.stringify(archive, null, 2)}\n`
      } else {
        // Dynamic import keeps store.js independent of the renderer at load
        // time; report.js already imports this module.
        const { buildReport } = await import('./report.js')
        const html = buildReport([archive.run], {
          title: `Superagent run ${archive.runId}`,
          generatedAt: Date.now(),
        })
        // `<` is escaped so a report containing "</script>" cannot end the tag.
        const payload = JSON.stringify(archive).replace(/</g, '\\u003c')
        body = html.replace(
          '</body>',
          `<script type="application/json" id="superagent-archive">${payload}</script>\n</body>`,
        )
      }
      await fsp.writeFile(out, body, 'utf8')
      const bytes = Buffer.byteLength(body, 'utf8')
      return { runId: archive.runId, format, out, bytes, files: [{ path: path.basename(out), bytes }] }
    },

    /**
     * Read an archive back into this store for review.
     *
     * Import never overwrites: a local run with the same id makes this throw
     * before anything is written. The run record is restored with read-only
     * import provenance so archived prompts can never be resumed as new work.
     *
     * @param {string} source - archive directory, bundle JSON, or html file.
     * @returns {Promise<{ run: object, out: string, source: string, format: string }>}
     * @throws when the archive is unreadable, incomplete, or collides locally.
     */
    async importRun(source) {
      const origin = path.resolve(String(source))
      const stat = await fsp.stat(origin).catch(error => {
        throw new Error(`cannot read archive ${origin}: ${error?.message ?? error}`)
      })
      let archive
      let format
      if (stat.isDirectory()) {
        format = 'dir'
        const manifest = JSON.parse(await fsp.readFile(path.join(origin, 'manifest.json'), 'utf8').catch(error => {
          throw new Error(`archive directory ${origin} has no readable manifest.json: ${error?.message ?? error}`)
        }))
        if (manifest?.format !== ARCHIVE_FORMAT) {
          throw new Error(`${path.join(origin, 'manifest.json')} is not a ${ARCHIVE_FORMAT} archive`)
        }
        if (manifest.formatVersion !== ARCHIVE_FORMAT_VERSION) {
          throw new Error(`archive format version ${manifest.formatVersion} is not supported (expected ${ARCHIVE_FORMAT_VERSION})`)
        }
        const run = JSON.parse(await fsp.readFile(path.join(origin, 'run.json'), 'utf8').catch(error => {
          throw new Error(`archive ${origin} has no readable run.json: ${error?.message ?? error}`)
        }))
        // Verify the parts the manifest records, so a truncated copy is caught
        // instead of silently imported as a different run.
        for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
          const buffer = await fsp.readFile(path.join(origin, entry.path)).catch(() => null)
          if (!buffer) throw new Error(`archive ${origin} is missing ${entry.path}`)
          if (typeof entry.sha256 === 'string') {
            const digest = createHash('sha256').update(buffer).digest('hex')
            if (digest !== entry.sha256) throw new Error(`archive file ${entry.path} does not match its manifest checksum`)
          }
        }
        let report = null
        try {
          report = (await fsp.readFile(path.join(origin, 'report.md'), 'utf8')).trim() || null
        } catch {
          report = null
        }
        archive = { ...manifest, run, report }
      } else {
        const text = await fsp.readFile(origin, 'utf8')
        if (/\.html?$/i.test(origin)) {
          format = 'html'
          const match = text.match(EMBEDDED_ARCHIVE)
          if (!match) throw new Error(`${origin} has no embedded ${ARCHIVE_FORMAT} payload`)
          archive = JSON.parse(match[1])
        } else {
          format = 'bundle'
          try {
            archive = JSON.parse(text)
          } catch (error) {
            throw new Error(`${origin} is not valid JSON: ${error?.message ?? error}`)
          }
        }
        if (archive?.format !== ARCHIVE_FORMAT) throw new Error(`${origin} is not a ${ARCHIVE_FORMAT} archive`)
        if (archive.formatVersion !== ARCHIVE_FORMAT_VERSION) {
          throw new Error(`archive format version ${archive.formatVersion} is not supported (expected ${ARCHIVE_FORMAT_VERSION})`)
        }
      }

      const run = archive.run
      if (!run || typeof run !== 'object') throw new Error(`archive ${origin} carries no run record`)
      if (!TERMINAL_STATUSES.has(run.status)) {
        throw new Error(`archive ${origin} contains non-terminal run status ${JSON.stringify(run.status)}; only finished runs can be imported`)
      }
      const id = String(run.id ?? '')
      if (!RUN_ID_PATTERN.test(id)) throw new Error(`archive ${origin} has no usable run id (got ${JSON.stringify(run.id)})`)
      if (archive.runId && archive.runId !== id) {
        throw new Error(`archive ${origin} names run ${archive.runId} but run.json is ${id}`)
      }
      if (await sizeOf(runFile(id)) !== null) {
        throw new Error(
          `run ${id} already exists in ${this.root}; import never overwrites — `
          + 'remove it first, or import into another state directory',
        )
      }
      if (typeof archive.report === 'string' && archive.report.trim() && !run.report) {
        run.report = archive.report.trim()
      }
      run.importedReadOnly = true
      await this.write(run)
      if (typeof run.report === 'string' && run.report.trim()) {
        // The report is also inside run.json, so a failed artifact write is a
        // warning: the imported record is already complete without it.
        try {
          await fsp.mkdir(path.dirname(reportFile(id)), { recursive: true })
          await fsp.writeFile(reportFile(id), `${run.report.trimEnd()}\n`, 'utf8')
        } catch (error) {
          warn(`imported run ${id} but could not write ${reportFile(id)}: ${error?.message ?? error}`)
        }
      }
      return { run, out: runFile(id), source: origin, format }
    },

    /**
     * Size of the state directory, for `superagent_list`.
     * @returns {Promise<{ bytes: number, files: number, corrupt: number }>} totals.
     */
    async stats() {
      const totals = { bytes: 0, files: 0, corrupt: 0 }
      let names
      try {
        names = await fsp.readdir(runsDir)
      } catch {
        return totals
      }
      for (const name of names) {
        try {
          const stat = await fsp.stat(path.join(runsDir, name))
          if (!stat.isFile()) continue
          totals.files++
          totals.bytes += stat.size
          if (name.includes('.corrupt-')) totals.corrupt++
        } catch {
          // A file removed mid-scan does not change the answer.
        }
      }
      return totals
    },
  }
}

