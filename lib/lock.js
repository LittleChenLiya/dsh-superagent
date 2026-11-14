/**
 * Best-effort cross-process lock for the small shared files that have no run id
 * of their own (memory lines, notification counters).
 *
 * The lock is advisory: every writer in this package takes it, but a process
 * that ignores it can still append. That is acceptable because the protected
 * operations either append one short line (atomic enough on a local filesystem)
 * or replace a whole file from a temp file. The lock exists to keep compaction
 * and the notification counter from racing, not to protect a critical section
 * that a hostile process honours.
 *
 * A lock whose holder is provably dead on this machine, or whose file is older
 * than `staleMs`, is removed once. Operations under the lock are expected to be
 * short; `staleMs` exists for a process killed mid-write, not for long work.
 *
 * @module dsh-superagent/lock
 */
import fsp from 'node:fs/promises'
import os from 'node:os'

export const DEFAULT_STALE_MS = 30 * 1000

/**
 * @param {unknown} pid - pid recorded by the lock holder.
 * @returns {boolean | null} true when alive, false when gone, null when unknown.
 */
export function pidAlive(pid) {
  const number = Number(pid)
  if (!Number.isInteger(number) || number <= 0) return null
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM'
  }
}

/**
 * Try to create `file` exclusively.
 *
 * @param {string} file - absolute path of the lock file.
 * @param {object} [options] - lock options.
 * @param {number} [options.staleMs] - age after which the lock is considered abandoned.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {number} [options.retries] - extra attempts after a held lock is seen.
 * @param {number} [options.retryDelayMs] - wait between attempts.
 * @param {(ms: number) => Promise<void>} [options.sleep] - wait function, injectable for tests.
 * @returns {Promise<(() => Promise<void>) | null>} release function, or null when the lock is held.
 */
export async function acquireFileLock(
  file,
  {
    staleMs = DEFAULT_STALE_MS,
    now = () => Date.now(),
    retries = 0,
    retryDelayMs = 50,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {},
) {
  for (let round = 0; round <= retries; round++) {
    if (round > 0) await sleep(retryDelayMs)
    let contended = false
    const payload = {
      pid: process.pid,
      hostname: os.hostname(),
      at: new Date(now()).toISOString(),
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fsp.writeFile(file, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx' })
        return async () => {
          try {
            await fsp.unlink(file)
          } catch {
            // Already gone; releasing twice is not an error.
          }
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') return null
        let existing = null
        try {
          existing = JSON.parse(await fsp.readFile(file, 'utf8'))
        } catch {
          // Unreadable lock content is treated as stale below.
        }
        const age = now() - Date.parse(existing?.at ?? '')
        const deadHere = existing?.hostname === os.hostname() && pidAlive(existing.pid) === false
        const expired = !Number.isFinite(age) || age > staleMs
        // A live holder on this machine wins regardless of age: an operation may
        // legitimately take longer than staleMs on a slow disk.
        const aliveHere = existing?.hostname === os.hostname() && pidAlive(existing.pid) === true
        if (!deadHere && (aliveHere || !expired)) {
          contended = true
          break
        }
        try {
          await fsp.unlink(file)
        } catch {
          // Someone else removed it; the next attempt can try to claim it.
        }
      }
    }
    if (!contended) return null
  }
  return null
}
