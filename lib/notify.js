/**
 * Proactive-notification policy: quiet unless the user needs to hear it.
 *
 * A long-horizon run is allowed to interrupt the session only when it finished
 * work (delivered), failed, or stopped half-way (partial/interrupted). A run the
 * user cancelled is never announced — the caller already knows. Progress is not
 * announced at all: it lives in the run record, `superagent_status`, the watch
 * panel, and the report page.
 *
 * A fixed hourly window caps how many messages can be sent. Runs that arrive
 * after the cap are buffered and folded into the next message as one summary,
 * so a burst of six failures does not become six wake-ups.
 *
 * The counter is a small JSON file under the state directory, changed under a
 * file lock and written through a temp file. Two hosts sharing a state
 * directory therefore count into the same bucket. If the lock cannot be taken
 * the decision is still made without it: a duplicated message is preferable to
 * silently dropping the only notification.
 *
 * @module dsh-superagent/notify
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLock } from './lock.js'

/** Statuses worth waking a session for. `cancelled` is deliberately absent. */
export const NOTIFY_STATUSES = new Set(['completed', 'failed', 'partial', 'interrupted'])

const WINDOW_MS = 60 * 60 * 1000
const MAX_PENDING = 20

function emptyState(now) {
  return { windowStart: new Date(now).toISOString(), count: 0, pending: [] }
}

/**
 * One-line description kept for a buffered run. Bounded so the state file
 * cannot grow with the goal text of every run.
 * @param {object} run - finished run.
 */
function summaryOf(run) {
  const goal = String(run.goal ?? '').replace(/\s+/g, ' ').trim()
  return {
    id: run.id,
    status: run.status,
    goal: [...goal].slice(0, 80).join(''),
    finishedAt: run.finishedAt ?? null,
  }
}

/**
 * Build the policy bound to one state directory.
 *
 * @param {object} options - configuration.
 * @param {string} options.stateFile - path of the counter file.
 * @param {number} [options.maxPerHour] - cap per hourly window; 0 disables it.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 */
export function createNotifyPolicy({ stateFile, maxPerHour = 3, now = () => Date.now(), warn = () => {} }) {
  async function readState() {
    try {
      const parsed = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return emptyState(now())
      return {
        windowStart: typeof parsed.windowStart === 'string' ? parsed.windowStart : new Date(now()).toISOString(),
        count: Number.isFinite(parsed.count) ? parsed.count : 0,
        pending: Array.isArray(parsed.pending) ? parsed.pending.filter(item => item && typeof item.id === 'string') : [],
      }
    } catch {
      return emptyState(now())
    }
  }

  async function writeState(state) {
    const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`
    try {
      await fsp.mkdir(path.dirname(stateFile), { recursive: true })
      await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await fsp.rename(tmp, stateFile)
    } catch (error) {
      warn(`cannot persist the notification counter ${stateFile}: ${error?.message ?? error}`)
      try {
        await fsp.unlink(tmp)
      } catch {
        // Nothing to remove.
      }
    }
  }

  return {
    stateFile,

    /**
     * Decide whether this run may wake the session, and reserve the slot if so.
     *
     * Reserving before the send means a failed send still consumes budget: the
     * policy errs toward fewer interruptions, never toward a retry storm.
     *
     * @param {object} run - terminal run.
     * @returns {Promise<{ allowed: boolean, reason: string | null, batch: object[] }>}
     */
    async reserve(run) {
      if (!NOTIFY_STATUSES.has(run.status)) {
        return {
          allowed: false,
          reason: `suppressed: a ${run.status} run is not announced; read it with superagent_status or superagent_list`,
          batch: [],
        }
      }
      const release = await acquireFileLock(`${stateFile}.lock`, { now })
      try {
        const state = await readState()
        const started = Date.parse(state.windowStart)
        if (!Number.isFinite(started) || now() - started >= WINDOW_MS) {
          state.windowStart = new Date(now()).toISOString()
          state.count = 0
        }
        if (maxPerHour > 0 && state.count >= maxPerHour) {
          state.pending = [...state.pending, summaryOf(run)].slice(-MAX_PENDING)
          await writeState(state)
          return {
            allowed: false,
            reason: `batched: the limit of ${maxPerHour} proactive message(s) per hour is reached; `
              + `${state.pending.length} run(s) will be folded into the next summary`,
            batch: [],
          }
        }
        state.count += 1
        const batch = state.pending
        state.pending = []
        await writeState(state)
        return { allowed: true, reason: null, batch }
      } finally {
        if (release) await release()
      }
    },

    /**
     * Buffered runs, for `superagent_list`. Reads without reserving anything.
     * @returns {Promise<{ count: number, pending: object[] }>}
     */
    async summary() {
      const state = await readState()
      const started = Date.parse(state.windowStart)
      return {
        count: Number.isFinite(started) && now() - started < WINDOW_MS ? state.count : 0,
        pending: state.pending,
      }
    },
  }
}
