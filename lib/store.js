/**
 * Durable run storage for dsh-longhaul.
 *
 * One JSON file per run under `<root>/runs/<runId>.json`. Writes are atomic
 * (temp file + rename) so a host crash mid-write cannot leave a half-written
 * run that blocks recovery.
 *
 * Two sibling files carry control signals that are safe to write from another
 * process: `<runId>.cancel` asks the owning process to stop the run, and
 * `<runId>.json.corrupt-<ts>` keeps an unparsable state file instead of
 * deleting the evidence.
 *
 * @module dsh-longhaul/store
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Statuses for a run that still owns live work. */
export const ACTIVE_STATUSES = new Set(['queued', 'planning', 'running', 'aggregating'])

/** Statuses after which a run will not change on its own. */
export const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted'])

const RUN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{3,63}$/
const STALE_TMP_MS = 10 * 60 * 1000

/**
 * Resolve the state root. An explicit `stateDir` wins, then `$DSH_HOME`, then
 * the harness default `~/.dsh`.
 * @param {string | undefined} configured - plugin config `stateDir`.
 * @returns {string} absolute state root.
 */
export function resolveStateRoot(configured) {
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim())
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, 'state', 'longhaul')
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
  let writeSeq = 0
  /** runId -> quarantine path, so status can explain a run it cannot parse. */
  const corrupt = new Map()

  const runFile = runId => path.join(runsDir, `${runId}.json`)
  const cancelFile = runId => path.join(runsDir, `${runId}.cancel`)
  const ownerFile = path.join(root, '.owner')

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
     * Remove temp files left by a killed process and cancel markers whose run
     * already reached a terminal state, so neither can affect later runs.
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
        if (name.endsWith('.cancel')) {
          const run = await this.read(name.slice(0, -'.cancel'.length))
          if (!run || TERMINAL_STATUSES.has(run.status)) await this.clearCancel(name.slice(0, -'.cancel'.length))
        }
      }
    },

    /**
     * Read every readable run, newest first. A corrupt file is quarantined and
     * skipped rather than failing the whole listing.
     */
    async list() {
      let names
      try {
        names = await fsp.readdir(runsDir)
      } catch (error) {
        if (error?.code === 'ENOENT') return []
        throw error
      }
      const runs = []
      for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue
        const run = await this.read(name.slice(0, -'.json'.length))
        if (run) runs.push(run)
      }
      runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      return runs
    },

    /**
     * @param {string} runId - run identity.
     * @returns {Promise<object | null>} parsed run, or null when missing/invalid.
     */
    async read(runId) {
      if (!RUN_ID_PATTERN.test(String(runId))) return null
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
        warn(`cannot read run ${runId}: ${error?.message ?? error}`)
        return null
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
      await fsp.writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
      for (let attempt = 1; ; attempt++) {
        try {
          await fsp.rename(tmp, file)
          return
        } catch (error) {
          // A reader holding the destination open can fail the replace on Windows.
          if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
          await new Promise(resolve => setTimeout(resolve, 20 * attempt))
        }
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
     * Delete terminal runs older than `olderThanDays`, so an install that runs
     * for months does not accumulate state forever. Opt-in: called with a
     * positive number only when the user configured `keepRuns`.
     * @param {{ olderThanDays: number }} options - retention window.
     * @returns {Promise<{ removed: string[] }>} removed run ids.
     */
    async prune({ olderThanDays }) {
      const days = Number(olderThanDays)
      const removed = []
      if (!Number.isFinite(days) || days <= 0) return { removed }
      const cutoff = Date.now() - days * 86400000
      for (const run of await this.list()) {
        if (!TERMINAL_STATUSES.has(run.status)) continue
        const finished = Date.parse(run.finishedAt ?? run.updatedAt ?? run.createdAt)
        if (!Number.isFinite(finished) || finished > cutoff) continue
        try {
          await fsp.unlink(runFile(run.id))
          await this.clearCancel(run.id)
          removed.push(run.id)
        } catch (error) {
          warn(`cannot prune run ${run.id}: ${error?.message ?? error}`)
        }
      }
      return { removed }
    },

    /**
     * Size of the state directory, for `longhaul_list`.
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

