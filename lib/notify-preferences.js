/**
 * Durable notification preferences.
 *
 * The file contains one canonical preference object. Reads never modify it and
 * fall back to defaults when it is missing or damaged; the original bytes are
 * kept for inspection. Updates take the same cross-process lock used by the
 * notification counter and replace the file atomically, so concurrent readers
 * see either the old object or the new one, never a partial JSON document.
 *
 * @module dsh-superagent/notify-preferences
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireFileLock } from './lock.js'
import { validateTimeZone } from './cron.js'

export const NOTIFICATION_EVENTS = Object.freeze([
  'added', 'completed', 'failed', 'decision', 'approval', 'artifact',
])
export const EVENT_MODES = Object.freeze(['off', 'inbox', 'push', 'both'])
export const NOTIFICATION_CHANNELS = Object.freeze(['inbox', 'push'])
const QUIET_EXCEPT_EVENTS = new Set([...NOTIFICATION_EVENTS, 'dailyBrief'])
const MODE_SET = new Set(EVENT_MODES)
const CHANNEL_SET = new Set(NOTIFICATION_CHANNELS)
const EVENT_SET = new Set(NOTIFICATION_EVENTS)
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const IANA_PATTERN = /^(?:UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/

export const DEFAULT_NOTIFY_PREFERENCES = Object.freeze({
  events: Object.freeze({
    added: 'inbox',
    completed: 'both',
    failed: 'both',
    decision: 'both',
    approval: 'both',
    artifact: 'inbox',
  }),
  channels: Object.freeze(['inbox', 'push']),
  maxPushPerHour: 3,
  quietHours: Object.freeze({
    enabled: false,
    start: '22:00',
    end: '08:00',
    timeZone: 'UTC',
    except: Object.freeze([]),
  }),
  dailyBrief: Object.freeze({
    enabled: true,
    time: '09:00',
    timeZone: 'UTC',
    channels: Object.freeze(['inbox']),
  }),
})

/** A validation error names the exact field that must be fixed. */
export class NotifyPreferencesError extends Error {
  constructor(message, field = null) {
    super(message)
    this.name = 'NotifyPreferencesError'
    this.field = field
  }
}

function fail(field, message) {
  throw new NotifyPreferencesError(`${field}: ${message}`, field)
}

function ifMissing(value, fallback) {
  return value === undefined ? fallback : value
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertObject(value, field, allowed) {
  if (!isPlainObject(value)) fail(field, 'must be an object')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(`${field}.${String(key)}`, 'is not a known setting')
  }
}

function booleanValue(value, field) {
  if (typeof value !== 'boolean') fail(field, 'must be a boolean')
  return value
}

function timeValue(value, field) {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    fail(field, 'must be a 24-hour time in HH:mm form')
  }
  return value
}

function timeZoneValue(value, field) {
  if (typeof value !== 'string' || !IANA_PATTERN.test(value)) {
    fail(field, 'must be an IANA time zone such as "Asia/Shanghai" or "UTC"')
  }
  try {
    return validateTimeZone(value)
  } catch {
    fail(field, `unknown IANA time zone ${JSON.stringify(value)}`)
  }
}

function channelsValue(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) fail(field, 'must be an array of "inbox" and/or "push"')
  if (!allowEmpty && value.length === 0) fail(field, 'must enable at least one channel')
  const seen = new Set()
  const result = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || !CHANNEL_SET.has(item)) {
      fail(`${field}[${index}]`, 'must be "inbox" or "push"')
    }
    if (seen.has(item)) fail(`${field}[${index}]`, `duplicates "${item}"`)
    seen.add(item)
    result.push(item)
  }
  return result
}

function eventsValue(value) {
  assertObject(value, 'events', EVENT_SET)
  const result = {}
  for (const event of NOTIFICATION_EVENTS) {
    const mode = ifMissing(value[event], DEFAULT_NOTIFY_PREFERENCES.events[event])
    if (typeof mode !== 'string' || !MODE_SET.has(mode)) {
      fail(`events.${event}`, 'must be "off", "inbox", "push", or "both"')
    }
    result[event] = mode
  }
  return result
}

function quietHoursValue(value) {
  const allowed = new Set(['enabled', 'start', 'end', 'timeZone', 'except'])
  assertObject(value, 'quietHours', allowed)
  const defaults = DEFAULT_NOTIFY_PREFERENCES.quietHours
  const enabled = booleanValue(ifMissing(value.enabled, defaults.enabled), 'quietHours.enabled')
  const start = timeValue(ifMissing(value.start, defaults.start), 'quietHours.start')
  const end = timeValue(ifMissing(value.end, defaults.end), 'quietHours.end')
  if (start === end) fail('quietHours.start', 'must differ from quietHours.end; equal times are ambiguous')
  const timeZone = timeZoneValue(ifMissing(value.timeZone, defaults.timeZone), 'quietHours.timeZone')
  const except = ifMissing(value.except, defaults.except)
  if (!Array.isArray(except)) fail('quietHours.except', 'must be an array of event names')
  const seen = new Set()
  const exceptions = except.map((item, index) => {
    if (typeof item !== 'string' || !QUIET_EXCEPT_EVENTS.has(item)) {
      fail(`quietHours.except[${index}]`, 'must be a notification event name or "dailyBrief"')
    }
    if (seen.has(item)) fail(`quietHours.except[${index}]`, `duplicates "${item}"`)
    seen.add(item)
    return item
  })
  return { enabled, start, end, timeZone, except: exceptions }
}

function dailyBriefValue(value) {
  const allowed = new Set(['enabled', 'time', 'timeZone', 'channels'])
  assertObject(value, 'dailyBrief', allowed)
  const defaults = DEFAULT_NOTIFY_PREFERENCES.dailyBrief
  return {
    enabled: booleanValue(ifMissing(value.enabled, defaults.enabled), 'dailyBrief.enabled'),
    time: timeValue(ifMissing(value.time, defaults.time), 'dailyBrief.time'),
    timeZone: timeZoneValue(ifMissing(value.timeZone, defaults.timeZone), 'dailyBrief.timeZone'),
    channels: channelsValue(ifMissing(value.channels, defaults.channels), 'dailyBrief.channels'),
  }
}

/**
 * Validate and canonicalise preferences. Omitted settings receive defaults;
 * unknown settings and coercible-but-wrong types are rejected rather than
 * silently repaired. A fresh object is always returned.
 *
 * @param {object} [input]
 * @returns {object} canonical preferences
 */
export function validateNotifyPreferences(input = {}) {
  assertObject(input, 'preferences', new Set(['events', 'channels', 'maxPushPerHour', 'quietHours', 'dailyBrief']))
  const maxPushPerHour = ifMissing(input.maxPushPerHour, DEFAULT_NOTIFY_PREFERENCES.maxPushPerHour)
  if (!Number.isInteger(maxPushPerHour) || maxPushPerHour < 0 || maxPushPerHour > 1000) {
    fail('maxPushPerHour', 'must be an integer from 0 to 1000')
  }
  return {
    events: eventsValue(ifMissing(input.events, DEFAULT_NOTIFY_PREFERENCES.events)),
    channels: channelsValue(ifMissing(input.channels, DEFAULT_NOTIFY_PREFERENCES.channels), 'channels'),
    maxPushPerHour,
    quietHours: quietHoursValue(ifMissing(input.quietHours, DEFAULT_NOTIFY_PREFERENCES.quietHours)),
    dailyBrief: dailyBriefValue(ifMissing(input.dailyBrief, DEFAULT_NOTIFY_PREFERENCES.dailyBrief)),
  }
}

/** Alias for callers that describe the validation step as normalisation. */
export const normalizeNotifyPreferences = validateNotifyPreferences

function mergePatch(current, patch) {
  if (!isPlainObject(patch)) fail('preferences', 'must be an object')
  const result = { ...current }
  for (const key of ['events', 'quietHours', 'dailyBrief']) {
    if (Object.hasOwn(patch, key)) {
      if (!isPlainObject(patch[key])) fail(key, 'must be an object')
      result[key] = { ...result[key], ...patch[key] }
    }
  }
  for (const key of ['channels', 'maxPushPerHour']) {
    if (Object.hasOwn(patch, key)) result[key] = patch[key]
  }
  // Validation below reports unknown top-level keys, including __proto__.
  for (const key of Object.keys(patch)) {
    if (!['events', 'channels', 'maxPushPerHour', 'quietHours', 'dailyBrief'].includes(key)) result[key] = patch[key]
  }
  return result
}

async function replaceFile(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(tmp, file)
        return
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * attempt))
      }
    }
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * Create a preference store bound to one JSON file.
 *
 * @param {object} options
 * @param {string} options.file preference file (`stateFile` is accepted as an alias)
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.warn]
 * @returns {object} read/save/update/reset store
 */
export function createNotifyPreferences({ file, stateFile, now = () => Date.now(), warn = () => {} } = {}) {
  const target = file ?? stateFile
  if (typeof target !== 'string' || !target.trim()) throw new Error('createNotifyPreferences requires a file')
  const preferenceFile = path.resolve(target.trim())

  async function readDetailed() {
    let text
    for (let attempt = 1; ; attempt++) {
      try {
        text = await fsp.readFile(preferenceFile, 'utf8')
        break
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return { preferences: validateNotifyPreferences(), exists: false, recovered: false, error: null }
        }
        // Windows can briefly refuse a read while another process renames the
        // replacement over this path. Retry only known transient failures.
        if (attempt < 3 && ['EPERM', 'EACCES', 'EBUSY', 'EMFILE'].includes(error?.code)) {
          await new Promise(resolve => setTimeout(resolve, 15 * attempt))
          continue
        }
        throw error
      }
    }
    try {
      return {
        preferences: validateNotifyPreferences(JSON.parse(text)),
        exists: true,
        recovered: false,
        error: null,
      }
    } catch (error) {
      const message = `cannot read notification preferences ${preferenceFile}; using defaults: ${error?.message ?? error}`
      warn(message)
      return { preferences: validateNotifyPreferences(), exists: true, recovered: true, error }
    }
  }

  async function withLock(action) {
    // The lock file lives beside the preference file, so its parent must exist
    // before the first atomic wx acquisition (not only before the data write).
    await fsp.mkdir(path.dirname(preferenceFile), { recursive: true })
    const release = await acquireFileLock(`${preferenceFile}.lock`, {
      now,
      staleMs: 30_000,
      retries: 100,
      retryDelayMs: 10,
    })
    if (!release) throw new Error(`cannot lock notification preferences ${preferenceFile}; try again shortly`)
    try {
      return await action()
    } finally {
      await release()
    }
  }

  async function preserveDamaged(detail) {
    if (!detail.recovered) return
    const backup = `${preferenceFile}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    await fsp.copyFile(preferenceFile, backup, fsp.constants.COPYFILE_EXCL)
    warn(`damaged notification preferences kept at ${backup}`)
  }

  const store = {
    file: preferenceFile,
    stateFile: preferenceFile,

    /** Canonical preferences, or defaults for a missing/damaged file. */
    async read() {
      return (await readDetailed()).preferences
    },

    /** Preferences plus recovery diagnostics; does not write or quarantine. */
    readDetailed,

    /** Atomically replace the complete preference object under the file lock. */
    async save(preferences = {}) {
      const next = validateNotifyPreferences(preferences)
      return withLock(async () => {
        await preserveDamaged(await readDetailed())
        await fsp.mkdir(path.dirname(preferenceFile), { recursive: true })
        await replaceFile(preferenceFile, next)
        return next
      })
    },

    /** Locked read-modify-write; nested objects merge, arrays replace. */
    async update(patch) {
      if (typeof patch !== 'function' && !isPlainObject(patch)) fail('preferences', 'must be an object or updater function')
      return withLock(async () => {
        const detail = await readDetailed()
        const draft = typeof patch === 'function'
          ? ifMissing(patch(detail.preferences), detail.preferences)
          : mergePatch(detail.preferences, patch)
        const next = validateNotifyPreferences(draft)
        await preserveDamaged(detail)
        await fsp.mkdir(path.dirname(preferenceFile), { recursive: true })
        await replaceFile(preferenceFile, next)
        return next
      })
    },

    async reset() {
      return store.save(validateNotifyPreferences())
    },
  }
  return store
}

/** Convenience aliases for integrations that do not need a long-lived store. */
export const createNotifyPreferenceStore = createNotifyPreferences
export const readNotifyPreferences = async (file, options) => createNotifyPreferences({ file, ...options }).read()
export const writeNotifyPreferences = async (file, preferences, options) => createNotifyPreferences({ file, ...options }).save(preferences)
export const updateNotifyPreferences = async (file, patch, options) => createNotifyPreferences({ file, ...options }).update(patch)

export default {
  DEFAULT_NOTIFY_PREFERENCES,
  NOTIFICATION_EVENTS,
  EVENT_MODES,
  NOTIFICATION_CHANNELS,
  NotifyPreferencesError,
  validateNotifyPreferences,
  normalizeNotifyPreferences,
  createNotifyPreferences,
  createNotifyPreferenceStore,
  readNotifyPreferences,
  writeNotifyPreferences,
  updateNotifyPreferences,
}
