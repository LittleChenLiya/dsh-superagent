/**
 * Deterministic, side-effect-light daily brief scheduler.
 *
 * The scheduler owns only its timer and a small delivery journal. Brief data is
 * supplied by the injected builder and delivery by the injected transport; no
 * model, orchestrator, task store, or network client is used here.
 *
 * @module dsh-superagent/brief-scheduler
 */
import { createHash, randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { localToEpoch, zonedParts } from './cron.js'
import { isQuietHours, nextBriefTimeMs } from './notification-center.js'
import { validateNotifyPreferences } from './notify-preferences.js'

const STATE_VERSION = 1
const MAX_TIMER_MS = 2_147_483_647
const DEFAULT_RETRY_DELAY_MS = 60_000
const DELIVERY_HISTORY_LIMIT = 400
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

function epoch(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(new Date(value).getTime()) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function iso(value) {
  return value === null ? null : new Date(value).toISOString()
}

function localDate(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function dateAt(value, timeZone) {
  return localDate(zonedParts(value, timeZone))
}

function nextCivilDay(parts) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

function previousCivilDay(parts) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1))
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

/** Every real instant for a wall-clock minute, including both fall-back instants. */
function localTimeCandidates(parts, hour, minute, timeZone) {
  const wanted = { ...parts, hour, minute }
  const desired = Date.UTC(wanted.year, wanted.month - 1, wanted.day, hour, minute)
  const matches = candidate => {
    const actual = zonedParts(candidate, timeZone)
    return actual.year === wanted.year && actual.month === wanted.month && actual.day === wanted.day
      && actual.hour === hour && actual.minute === minute && actual.second === 0
  }
  const found = new Set()
  const midpoint = localToEpoch(wanted, timeZone)
  if (midpoint !== null && matches(midpoint)) found.add(midpoint)
  const offsets = new Set()
  for (let delta = -30; delta <= 30; delta++) {
    const actual = zonedParts(desired + delta * HOUR_MS, timeZone)
    offsets.add(Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
      - (desired + delta * HOUR_MS))
  }
  for (const offset of offsets) {
    const candidate = desired - offset
    if (matches(candidate)) found.add(candidate)
  }
  return [...found].sort((left, right) => left - right)
}

/** First real instant at/after a missing wall time (spring-forward or date-line gap). */
function firstAfterWallGap(parts, hour, minute, timeZone) {
  const wanted = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute)
  const start = wanted - 36 * HOUR_MS
  for (let cursor = start; cursor <= wanted + 36 * HOUR_MS; cursor += MINUTE_MS) {
    const actual = zonedParts(cursor, timeZone)
    const wall = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    if (wall >= wanted) return cursor
  }
  return null
}

function quietEnd(at, quietHours) {
  if (!isQuietHours(at, quietHours, 'dailyBrief')) return null
  const parts = zonedParts(at, quietHours.timeZone)
  const [startHour, startMinute] = quietHours.start.split(':').map(Number)
  const [endHour, endMinute] = quietHours.end.split(':').map(Number)
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  const minute = parts.hour * 60 + parts.minute
  const endParts = start > end && minute >= start ? nextCivilDay(parts) : parts
  const candidates = localTimeCandidates(endParts, endHour, endMinute, quietHours.timeZone)
    .filter(candidate => candidate > at)
  return candidates[0] ?? firstAfterWallGap(endParts, endHour, endMinute, quietHours.timeZone)
}

function scheduledTime(parts, dailyBrief) {
  const [hour, minute] = dailyBrief.time.split(':').map(Number)
  return localTimeCandidates(parts, hour, minute, dailyBrief.timeZone)
}

/** Latest official brief instant at or before `at`, looking back at most eight dates. */
function latestDue(at, dailyBrief) {
  let parts = zonedParts(at, dailyBrief.timeZone)
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidates = scheduledTime(parts, dailyBrief).filter(candidate => candidate <= at)
    if (candidates.length > 0) {
      const scheduledAt = candidates[candidates.length - 1]
      return { date: localDate(parts), scheduledAt }
    }
    parts = previousCivilDay(parts)
  }
  return null
}

function emptyState() {
  return {
    version: STATE_VERSION,
    deliveries: [],
    pending: null,
  }
}

function validDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('daily brief scheduler state must be an object')
  }
  const byDate = new Map()
  const rows = [
    ...(Array.isArray(raw.deliveries) ? raw.deliveries : []),
    ...(Array.isArray(raw.deliveredDates) ? raw.deliveredDates : []),
  ]
  for (const row of rows) {
    const date = typeof row === 'string' ? row : row?.date
    if (!validDateKey(date)) continue
    const scheduledAt = typeof row === 'string' ? null : epoch(row?.scheduledAt)
    const deliveredAt = typeof row === 'string' ? null : epoch(row?.deliveredAt)
    byDate.set(date, {
      date,
      scheduledAt: iso(scheduledAt),
      deliveredAt: iso(deliveredAt),
      revision: typeof row === 'string' ? null : row?.revision ?? null,
    })
  }
  for (const key of ['lastDeliveredDate', 'lastDate']) {
    if (validDateKey(raw[key]) && !byDate.has(raw[key])) {
      byDate.set(raw[key], { date: raw[key], scheduledAt: null, deliveredAt: null, revision: null })
    }
  }
  const deliveries = [...byDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-DELIVERY_HISTORY_LIMIT)

  let pending = null
  if (raw.pending && typeof raw.pending === 'object' && validDateKey(raw.pending.date)) {
    const scheduledAt = epoch(raw.pending.scheduledAt)
    const retryAt = epoch(raw.pending.nextRetryAt)
    if (scheduledAt !== null) {
      pending = {
        date: raw.pending.date,
        scheduledAt: iso(scheduledAt),
        revision: raw.pending.revision ?? null,
        brief: raw.pending.brief ?? null,
        attempts: Number.isSafeInteger(raw.pending.attempts) && raw.pending.attempts >= 0 ? raw.pending.attempts : 0,
        nextRetryAt: iso(retryAt),
      }
    }
  }
  return { version: STATE_VERSION, deliveries, pending }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function revisionFor(preferences, supplied) {
  if (typeof supplied === 'string' && supplied) return supplied
  if (Number.isSafeInteger(supplied) && supplied >= 0) return supplied
  return createHash('sha256').update(JSON.stringify(preferences)).digest('hex').slice(0, 24)
}

function publicPending(pending) {
  if (!pending) return null
  return {
    date: pending.date,
    scheduledAt: pending.scheduledAt,
    revision: pending.revision,
    attempts: pending.attempts,
    nextRetryAt: pending.nextRetryAt,
  }
}

/**
 * Create a daily brief timer.
 *
 * `preferencesStore.read()` may return canonical preferences or
 * `{ preferences, revision }`. `buildBrief({ date, now, preferences })` receives
 * the scheduled instant (not wall-clock delivery time), making catch-up and
 * quiet-hour delivery deterministic. `deliver({ brief, date, revision })` is
 * idempotency-aware: retries and restarts reuse the same date and revision.
 *
 * @param {object} options
 * @param {{read: Function}|Function} options.preferencesStore
 * @param {Function} options.buildBrief
 * @param {Function} options.deliver
 * @param {string} options.stateFile durable delivery journal
 * @param {Function|number|string|Date} [options.now]
 * @param {Function} [options.setTimer]
 * @param {Function} [options.clearTimer]
 * @param {number} [options.retryDelayMs]
 * @returns {{start: Function, stop: Function, runNow: Function, status: Function, stateFile: string}}
 */
export function createBriefScheduler({
  preferencesStore,
  buildBrief,
  deliver,
  stateFile,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}) {
  if (!preferencesStore || (typeof preferencesStore.read !== 'function' && typeof preferencesStore !== 'function')) {
    throw new TypeError('createBriefScheduler needs preferencesStore with read()')
  }
  if (typeof buildBrief !== 'function') throw new TypeError('createBriefScheduler needs buildBrief()')
  if (typeof deliver !== 'function') throw new TypeError('createBriefScheduler needs deliver()')
  if (typeof stateFile !== 'string' || !stateFile.trim()) throw new TypeError('createBriefScheduler needs a stateFile')
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('createBriefScheduler setTimer and clearTimer must be functions')
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError('createBriefScheduler retryDelayMs must be a non-negative integer')
  }

  const file = path.resolve(stateFile.trim())
  let state = emptyState()
  let loaded = false
  let stateExists = false
  let loading = null
  let running = false
  let generation = 0
  let timer = null
  let timerTarget = null
  let timerReason = null
  let preferences = null
  let lastError = null
  let gate = Promise.resolve()

  function clock() {
    const value = epoch(typeof now === 'function' ? now() : now)
    if (value === null) throw new TypeError('daily brief scheduler now must be a valid date or epoch millisecond value')
    return value
  }

  function serialize(task) {
    const result = gate.then(task, task)
    gate = result.catch(() => {})
    return result
  }

  async function load() {
    if (loaded) return state
    if (loading) return loading
    loading = (async () => {
      let raw
      try {
        raw = await fsp.readFile(file, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        state = emptyState()
        loaded = true
        return state
      }
      state = normalizeState(JSON.parse(raw))
      stateExists = true
      loaded = true
      return state
    })()
    try {
      return await loading
    } finally {
      loading = null
    }
  }

  async function readPreferences() {
    const result = typeof preferencesStore === 'function'
      ? await preferencesStore()
      : await preferencesStore.read()
    const enveloped = result && typeof result === 'object'
      && result.preferences && typeof result.preferences === 'object'
    const value = enveloped ? result.preferences : result
    preferences = validateNotifyPreferences(value)
    return { preferences, revision: revisionFor(preferences, enveloped ? result.revision : undefined) }
  }

  async function writeState(draft) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fsp.writeFile(temporary, `${JSON.stringify({ ...draft, savedAt: iso(clock()) }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      await fsp.rename(temporary, file)
      state = draft
    } catch (error) {
      await fsp.unlink(temporary).catch(() => {})
      throw error
    }
  }

  async function commit(change) {
    const draft = clone(state)
    change(draft)
    await writeState(draft)
  }

  function clearScheduledTimer() {
    if (timer !== null) clearTimer(timer)
    timer = null
    timerTarget = null
    timerReason = null
  }

  function arm(at, reason, expected = null) {
    clearScheduledTimer()
    if ((!running && reason !== 'retry') || at === null) return
    const target = Math.max(0, at)
    const token = generation
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, target - clock()))
    const handle = setTimer(() => Promise.resolve().then(() => {
      if (timer !== handle) return
      timer = null
      timerTarget = null
      timerReason = null
      if ((!running && reason !== 'retry') || token !== generation) return
      return serialize(() => activate(token, reason, expected)).catch(async error => {
        if ((!running && reason !== 'retry') || token !== generation) return
        lastError = error?.message ?? String(error)
        try {
          await serialize(async () => {
            if ((!running && reason !== 'retry') || token !== generation) return
            arm(clock() + retryDelayMs, 'retry')
          })
        } catch {
          // A stopped scheduler must never be revived by error recovery.
        }
      })
    }), delay)
    timer = handle
    timerTarget = iso(target)
    timerReason = reason
  }

  function delivered(date) {
    return state.deliveries.some(row => row.date === date)
  }

  function nextFuture(currentPreferences, token, deliveredDate = null) {
    if (!running || token !== generation) return null
    let at = nextBriefTimeMs(clock(), currentPreferences.dailyBrief)
    while (at !== null && deliveredDate && dateAt(at, currentPreferences.dailyBrief.timeZone) === deliveredDate) {
      at = nextBriefTimeMs(at, currentPreferences.dailyBrief)
    }
    if (at === null) {
      clearScheduledTimer()
      return null
    }
    arm(at, 'brief', { date: dateAt(at, currentPreferences.dailyBrief.timeZone), scheduledAt: at })
    return at
  }

  function defer(pending, currentPreferences, token, allowStopped = false) {
    const at = clock()
    const end = quietEnd(at, currentPreferences.quietHours)
    if (end === null) return null
    const draft = clone(state)
    draft.pending = {
      ...(draft.pending ?? pending),
      nextRetryAt: iso(end),
    }
    // Quiet deferral is journaled before arming so a restart keeps the due date.
    return writeState(draft).then(() => {
      if (token !== generation || (!running && !allowStopped)) return end
      arm(end, 'retry')
      return end
    })
  }

  async function tryPending(token, current, suppliedRevision, allowStopped = false) {
    let pending = clone(state.pending)
    if (!pending) throw new Error('daily brief pending delivery is missing')
    if (delivered(pending.date)) {
      await commit(draft => { draft.pending = null })
      nextFuture(current.preferences, token, pending.date)
      return { status: 'skipped', delivered: false, reason: 'already-delivered', date: pending.date }
    }

    const at = clock()
    const quietUntil = quietEnd(at, current.preferences.quietHours)
    if (quietUntil !== null) {
      await defer(pending, current.preferences, token, allowStopped)
      return { status: 'deferred', delivered: false, date: pending.date, nextAt: iso(quietUntil) }
    }
    if (token !== generation || (!running && !allowStopped)) return { status: 'skipped', delivered: false, reason: 'stopped' }

    try {
      if (!pending.brief) {
        pending.revision = suppliedRevision
        const brief = await buildBrief({
          date: epoch(pending.scheduledAt),
          now: epoch(pending.scheduledAt),
          preferences: current.preferences,
        })
        if (token !== generation || (!running && !allowStopped)) return { status: 'skipped', delivered: false, reason: 'stopped' }
        if (brief === null || brief === undefined) {
          await commit(draft => { draft.pending = null })
          lastError = null
          nextFuture(current.preferences, token, pending.date)
          return { status: 'skipped', delivered: false, reason: 'disabled', date: pending.date }
        }
        pending.brief = clone(brief)
        pending.nextRetryAt = null
        await commit(draft => { draft.pending = pending })
      }

      const deliveredAt = clock()
      await deliver({ brief: clone(pending.brief), date: pending.date, revision: pending.revision })
      await commit(draft => {
        draft.deliveries = draft.deliveries.filter(row => row.date !== pending.date)
        draft.deliveries.push({
          date: pending.date,
          scheduledAt: pending.scheduledAt,
          deliveredAt: iso(deliveredAt),
          revision: pending.revision,
        })
        draft.deliveries = draft.deliveries
          .sort((left, right) => left.date.localeCompare(right.date))
          .slice(-DELIVERY_HISTORY_LIMIT)
        draft.pending = null
      })
      lastError = null
      nextFuture(current.preferences, token, pending.date)
      return {
        status: 'delivered',
        delivered: true,
        brief: clone(pending.brief),
        date: pending.date,
        revision: pending.revision,
        scheduledAt: pending.scheduledAt,
        deliveredAt: iso(deliveredAt),
      }
    } catch (error) {
      lastError = error?.message ?? String(error)
      const failed = clone(state.pending ?? pending)
      failed.attempts += 1
      const quietUntil = quietEnd(clock(), current.preferences.quietHours)
      const retryAt = quietUntil === null ? clock() + retryDelayMs : quietUntil
      failed.nextRetryAt = iso(retryAt)
      await commit(draft => { draft.pending = failed })
      if (token === generation && (running || allowStopped)) arm(retryAt, 'retry')
      return { status: 'failed', delivered: false, date: pending.date, error, nextAt: iso(retryAt) }
    }
  }

  async function activate(token, reason, expected = null) {
    if (token !== generation) return { status: 'skipped', delivered: false, reason: 'stopped' }
    await load()
    const current = await readPreferences()
    if (token !== generation) return { status: 'skipped', delivered: false, reason: 'stopped' }
    const at = clock()

    if (!current.preferences.dailyBrief.enabled) {
      clearScheduledTimer()
      if (state.pending) await commit(draft => { draft.pending = null })
      lastError = null
      return { status: 'skipped', delivered: false, reason: 'disabled', date: dateAt(at, current.preferences.dailyBrief.timeZone) }
    }

    if (state.pending) {
      const pending = state.pending
      const retryAt = epoch(pending.nextRetryAt)
      if (!pending.brief && reason === 'retry' && retryAt !== null && retryAt > at) {
        arm(retryAt, 'retry')
        return { status: 'deferred', delivered: false, date: pending.date, nextAt: iso(retryAt) }
      }
      return tryPending(token, current, current.revision, !running)
    }

    let due = null
    if (reason === 'now') {
      due = { date: dateAt(at, current.preferences.dailyBrief.timeZone), scheduledAt: at }
    } else {
      const today = dateAt(at, current.preferences.dailyBrief.timeZone)
      due = delivered(today) ? null : latestDue(at, current.preferences.dailyBrief)
      if (!stateExists && due && due.date !== today) due = null
      if (reason === 'brief' && expected && due?.date !== expected.date) {
        nextFuture(current.preferences, token)
        return { status: 'skipped', delivered: false, reason: 'not-due', date: expected.date }
      }
    }

    if (!due || delivered(due.date)) {
      const today = dateAt(at, current.preferences.dailyBrief.timeZone)
      const skipDate = due?.date ?? (delivered(today) ? today : null)
      const nextAt = nextFuture(current.preferences, token, skipDate)
      return {
        status: 'skipped',
        delivered: false,
        reason: due ? 'already-delivered' : 'not-due',
        date: due?.date ?? null,
        nextAt: iso(nextAt),
      }
    }

    const quietUntil = quietEnd(at, current.preferences.quietHours)
    if (quietUntil !== null) {
      await commit(draft => {
        draft.pending = {
          date: due.date,
          scheduledAt: iso(due.scheduledAt),
          revision: null,
          brief: null,
          attempts: 0,
          nextRetryAt: iso(quietUntil),
        }
      })
      if (token === generation && (running || reason === 'now' || reason === 'retry')) arm(quietUntil, 'retry')
      return { status: 'deferred', delivered: false, date: due.date, nextAt: iso(quietUntil) }
    }

    await commit(draft => {
      draft.pending = {
        date: due.date,
        scheduledAt: iso(due.scheduledAt),
        revision: null,
        brief: null,
        attempts: 0,
        nextRetryAt: null,
      }
    })
    return tryPending(token, current, current.revision, reason === 'now')
  }

  function status() {
    const lastDelivery = state.deliveries[state.deliveries.length - 1] ?? null
    return {
      running,
      enabled: preferences?.dailyBrief.enabled ?? null,
      nextAt: timerTarget,
      timerReason,
      timerScheduled: timer !== null,
      pending: publicPending(state.pending),
      lastDelivery: clone(lastDelivery),
      lastDeliveredDate: lastDelivery?.date ?? null,
      lastError,
      stateFile: file,
    }
  }

  function start() {
    running = true
    generation += 1
    clearScheduledTimer()
    const token = generation
    return serialize(async () => {
      try {
        const result = await activate(token, 'startup')
        if (!running && result.status === 'delivered') {
          // Delivery already crossed the stop boundary; never re-arm afterwards.
          clearScheduledTimer()
        }
        return status()
      } catch (error) {
        lastError = error?.message ?? String(error)
        if (token === generation) {
          running = false
          clearScheduledTimer()
        }
        throw error
      }
    })
  }

  function stop() {
    running = false
    generation += 1
    clearScheduledTimer()
    return status()
  }

  function runNow() {
    const token = generation
    return serialize(async () => {
      const result = await activate(token, 'now')
      if (result.status === 'failed') throw result.error
      return result
    })
  }

  return { start, stop, runNow, status, stateFile: file }
}
