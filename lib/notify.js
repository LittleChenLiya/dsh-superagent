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
/** A buffered run is dropped after this many failed deliveries, never sooner. */
const MAX_FOLD_ATTEMPTS = 3
const RETRY_CAP_MS = 60 * 1000

/**
 * A tiny per-key outbox: one task at a time, in order, with bounded retries.
 *
 * The plugin sends exactly one message per finished run, so "ordering" here
 * means a message for a run cannot overtake an earlier message for the same
 * session while that one is still being retried. Tasks for different keys are
 * independent. This is deliberately not a durable queue: the run record is the
 * source of truth, and an undelivered message is reported on the run, not
 * replayed after a restart.
 *
 * @param {object} [options] - retry policy.
 * @param {number} [options.retries] - extra attempts after the first; 0 means one attempt.
 * @param {number} [options.delayMs] - first delay; it doubles per attempt.
 * @param {(ms: number) => Promise<void>} [options.sleep] - clock, injectable for tests.
 */
export function createOutbox({
  retries = 2,
  delayMs = 2000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const tails = new Map()

  function backoff(attempt) {
    const base = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
    return Math.min(RETRY_CAP_MS, base * 2 ** Math.max(0, attempt - 1))
  }

  return {
    /**
     * Run `task` after every earlier task for `key` has settled.
     *
     * @template T
     * @param {string} key - ordering key, normally the parent session id.
     * @param {() => Promise<T>} task - delivery attempt.
     * @returns {Promise<T>} the task result, or the last error after retries.
     */
    enqueue(key, task) {
      const previous = tails.get(key) ?? Promise.resolve()
      const run = previous.catch(() => {}).then(async () => {
        let lastError
        for (let attempt = 1; attempt <= retries + 1; attempt++) {
          try {
            return await task()
          } catch (error) {
            lastError = error
            if (attempt <= retries) await sleep(backoff(attempt))
          }
        }
        throw lastError
      })
      const tail = run.catch(() => {})
      tails.set(key, tail)
      // Drop the chain once it is the newest one, so the map tracks in-flight
      // keys only instead of every session the host ever served.
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return run
    },
  }
}


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
     * Put a folded batch back after the message carrying it could not be sent.
     *
     * `reserve` clears the buffer before the send; without this a failed send
     * would drop those runs forever. The batch is deduplicated by run id,
     * bounded by `MAX_PENDING`, and dropped only after `MAX_FOLD_ATTEMPTS`
     * failed deliveries, so a permanently broken session cannot grow the file.
     *
     * @param {object[]} batch - `verdict.batch` from a failed delivery.
     * @returns {Promise<{ restored: number, dropped: number }>}
     */
    async restore(batch) {
      const items = Array.isArray(batch) ? batch.filter(item => item && typeof item.id === 'string') : []
      if (items.length === 0) return { restored: 0, dropped: 0 }
      const release = await acquireFileLock(`${stateFile}.lock`, { now })
      try {
        const state = await readState()
        const present = new Set(state.pending.map(item => item.id))
        let restored = 0
        let dropped = 0
        for (const item of items) {
          if (present.has(item.id)) continue
          const attempts = (Number(item.attempts) || 0) + 1
          if (attempts > MAX_FOLD_ATTEMPTS) {
            dropped++
            continue
          }
          state.pending.push({ ...item, attempts })
          present.add(item.id)
          restored++
        }
        state.pending = state.pending.slice(-MAX_PENDING)
        await writeState(state)
        return { restored, dropped }
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
