/**
 * Zero-dependency cron parsing for scheduled runs.
 *
 * The scheduler needs two things from this module: a parse that fails when the
 * plan is created (naming the field, not just "invalid cron"), and the next
 * instant a local clock would reach, in a time zone that may be the caller's and
 * not the host's. Both are computed with the runtime's own `Intl` data, so a
 * plan does not depend on a package being installed next to the plugin.
 *
 * Supported: the standard five fields (minute hour day-of-month month
 * day-of-week), star, star-with-step, ranges `a-b`, ranges with a step, lists
 * `a,b,c`, three-letter month and weekday names, and `0`/`7` for Sunday. When
 * both day-of-month and day-of-week are restricted, a day matching either one
 * is selected, which is what Vixie cron does.
 *
 * Not supported, and refused at create time instead of at 03:00: a seconds
 * field (six fields), `@daily`-style macros, and the Quartz extensions `L`,
 * `W`, `#`, and `?`. A year field (seven fields) is also refused.
 *
 * @module dsh-superagent/cron
 */

/** Fields in order, with the bounds a value must fall inside. */
const FIELDS = [
  { name: 'minute', min: 0, max: 59, aliases: null },
  { name: 'hour', min: 0, max: 23, aliases: null },
  { name: 'day-of-month', min: 1, max: 31, aliases: null },
  { name: 'month', min: 1, max: 12, aliases: { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 } },
  { name: 'day-of-week', min: 0, max: 7, aliases: { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 } },
]

/** A create-time cron problem, carrying which field (1-based) was wrong. */
export class CronError extends Error {
  /**
   * @param {string} message - what is wrong, in one actionable sentence.
   * @param {{ field?: number | null, fieldName?: string | null }} [where] - field position and name.
   */
  constructor(message, { field = null, fieldName = null } = {}) {
    super(message)
    this.name = 'CronError'
    this.field = field
    this.fieldName = fieldName
  }
}

const MAX_SEARCH_DAYS = 366 * 8
const formatters = new Map()

/** Resolve one token (number or three-letter name) to its numeric value. */
function valueOf(token, spec, index) {
  const text = String(token).toUpperCase()
  const field = index
  if (spec.aliases && Object.hasOwn(spec.aliases, text)) return spec.aliases[text]
  if (!/^\d+$/.test(text)) {
    throw new CronError(
      `cron field ${field} (${spec.name}) has "${token}", which is not a number`
      + `${spec.aliases ? ' or a three-letter name' : ''}`,
      { field, fieldName: spec.name },
    )
  }
  const value = Number(text)
  if (value < spec.min || value > spec.max) {
    throw new CronError(
      `cron field ${field} (${spec.name}) "${token}" is out of range ${spec.min}-${spec.max}`,
      { field, fieldName: spec.name },
    )
  }
  return value
}

/** Parse `*`, `a`, `a-b`, or any of those with `/n`, into sorted values. */
function parseItem(item, spec, index) {
  const text = item.trim()
  if (!text) {
    throw new CronError(`cron field ${index} (${spec.name}) has an empty list item`, { field: index, fieldName: spec.name })
  }
  // `?` is Quartz for "no specific value", and `L`/`W`/`#` are Quartz
  // extensions. Refusing them by name is the difference between "your cron is
  // wrong" and "your cron is a different dialect".
  if (text.includes('?')) {
    throw new CronError(`cron field ${index} (${spec.name}) uses "?", which is not supported; use "*" instead`, {
      field: index,
      fieldName: spec.name,
    })
  }
  if (/^[LW]$/i.test(text) || (/[LW#]/i.test(text) && !/^[A-Za-z]+$/.test(text))) {
    throw new CronError(
      `cron field ${index} (${spec.name}) uses "${text}"; L, W and # are not supported. `
      + 'This parser supports only *, lists, ranges and /n steps',
      { field: index, fieldName: spec.name },
    )
  }
  const [base, stepText, extra] = text.split('/')
  if (extra !== undefined) {
    throw new CronError(`cron field ${index} (${spec.name}) has more than one "/" step`, { field: index, fieldName: spec.name })
  }
  let step = 1
  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
      throw new CronError(`cron field ${index} (${spec.name}) has step "${stepText}"; a step must be a number of at least 1`, {
        field: index,
        fieldName: spec.name,
      })
    }
    step = Number(stepText)
  }
  if (base === '*') {
    return { values: expand(spec.min, spec.max, step), restricted: step !== 1 }
  }
  if (base === '' || base.includes('*')) {
    throw new CronError(`cron field ${index} (${spec.name}) has "${text}"; "*" may only be the whole field or "*/n"`, {
      field: index,
      fieldName: spec.name,
    })
  }
  const range = base.split('-')
  if (range.length === 1) {
    const value = valueOf(range[0], spec, index)
    if (stepText !== undefined) {
      // "5/10" is not a range in cron; reject it instead of inventing one.
      throw new CronError(`cron field ${index} (${spec.name}) uses "${text}"; a step needs a range such as "5-20/2"`, {
        field: index,
        fieldName: spec.name,
      })
    }
    return { values: [value], restricted: true }
  }
  if (range.length === 2) {
    const from = valueOf(range[0], spec, index)
    const to = valueOf(range[1], spec, index)
    if (from > to) {
      throw new CronError(`cron field ${index} (${spec.name}) range "${base}" runs backwards`, {
        field: index,
        fieldName: spec.name,
      })
    }
    return { values: expand(from, to, step), restricted: true }
  }
  throw new CronError(`cron field ${index} (${spec.name}) has more than one "-"`, { field: index, fieldName: spec.name })
}

function expand(from, to, step) {
  const values = []
  for (let value = from; value <= to; value += step) values.push(value)
  return values
}

/**
 * Parse one five-field cron expression.
 *
 * @param {string} expression - e.g. `"0 9 * * MON-FRI"`.
 * @returns {Readonly<object>} parsed spec, accepted by `nextCronTime`.
 * @throws {CronError} naming the 1-based field that is wrong.
 */
export function parseCron(expression) {
  const text = String(expression ?? '').trim()
  if (!text) {
    throw new CronError('cron is empty; expected 5 fields: minute hour day-of-month month day-of-week', {
      field: 1,
      fieldName: 'minute',
    })
  }
  if (text.startsWith('@')) {
    throw new CronError(
      `cron macro "${text}" is not supported; write the five fields instead (e.g. "0 9 * * *" for 09:00 daily)`,
      { field: 1, fieldName: 'minute' },
    )
  }
  const parts = text.split(/\s+/)
  if (parts.length !== 5) {
    const detail = parts.length === 6
      ? 'got 6; a seconds field is not supported — the first field is minutes'
      : parts.length === 7
        ? 'got 7; a year field is not supported'
        : `got ${parts.length}`
    throw new CronError(`cron needs 5 fields (minute hour day-of-month month day-of-week) but ${detail}`, {
      field: 1,
      fieldName: 'minute',
    })
  }
  const parsed = parts.map((part, index) => {
    const field = index + 1
    const spec = FIELDS[index]
    if (part.includes('?')) {
      throw new CronError(`cron field ${field} (${spec.name}) uses "?", which is not supported; use "*" instead`, {
        field,
        fieldName: spec.name,
      })
    }
    const values = new Set()
    let restricted = false
    for (const item of part.split(',')) {
      const result = parseItem(item, spec, field)
      for (const value of result.values) values.add(value)
      if (result.restricted) restricted = true
    }
    if (values.size === 0) {
      throw new CronError(`cron field ${field} (${spec.name}) matches no value`, { field, fieldName: spec.name })
    }
    const list = [...values].sort((a, b) => a - b)
    // 0 and 7 both mean Sunday; keeping both would make a range look larger than
    // it is and would report two matches for one day.
    if (spec.name === 'day-of-week') {
      if (values.has(7)) {
        values.delete(7)
        values.add(0)
      }
      return { values: [...values].sort((a, b) => a - b), restricted: part !== '*' }
    }
    return { values: list, restricted: part !== '*' }
  })
  return Object.freeze({
    expression: text,
    minutes: Object.freeze(parsed[0].values),
    hours: Object.freeze(parsed[1].values),
    daysOfMonth: Object.freeze(parsed[2].values),
    months: Object.freeze(parsed[3].values),
    daysOfWeek: Object.freeze(parsed[4].values),
    domRestricted: parsed[2].restricted,
    dowRestricted: parsed[4].restricted,
  })
}

/**
 * Refuse an unknown time zone at create time.
 *
 * @param {string} timeZone - IANA name such as `Asia/Shanghai`.
 * @throws {CronError} when the runtime cannot resolve it.
 */
export function validateTimeZone(timeZone) {
  const name = String(timeZone ?? '').trim()
  if (!name) throw new CronError('timeZone is empty; use an IANA name such as "Asia/Shanghai" or "UTC"')
  try {
    formatterFor(name)
  } catch {
    throw new CronError(
      `timeZone "${name}" is not known to this Node runtime; use an IANA name such as "Asia/Shanghai"`,
    )
  }
  return name
}

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Local calendar parts of one instant in a time zone.
 *
 * @param {number} ms - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 */
export function zonedParts(ms, timeZone) {
  const parts = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const year = Number(parts.year)
  const month = Number(parts.month)
  const day = Number(parts.day)
  const hour = Number(parts.hour)
  const minute = Number(parts.minute)
  const second = Number(parts.second)
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  }
}

/**
 * Epoch of one local wall-clock time, or null when that time does not exist.
 *
 * A time can be missing on the spring-forward day. Cron semantics run the job
 * at the next existing minute, so null is the honest answer and the caller
 * moves on instead of inventing a shifted time. Ambiguous times on the fall-back
 * day resolve to the earlier offset, which is what a "next run" should pick.
 *
 * @param {{ year: number, month: number, day: number, hour: number, minute: number }} wanted - local parts.
 * @param {string} timeZone - IANA zone.
 * @returns {number | null} epoch milliseconds, or null for a non-existent local time.
 */
export function localToEpoch(wanted, timeZone) {
  const desired = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute)
  let guess = desired
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = zonedParts(guess, timeZone)
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    const delta = desired - actualMs
    if (delta === 0) break
    guess += delta
  }
  const final = zonedParts(guess, timeZone)
  if (final.year !== wanted.year || final.month !== wanted.month || final.day !== wanted.day
    || final.hour !== wanted.hour || final.minute !== wanted.minute) {
    return null
  }
  return guess
}

function matchesDay(spec, parts) {
  if (!spec.months.includes(parts.month)) return false
  const dom = spec.daysOfMonth.includes(parts.day)
  const dow = spec.daysOfWeek.includes(parts.weekday)
  if (spec.domRestricted && spec.dowRestricted) return dom || dow
  if (spec.domRestricted) return dom
  if (spec.dowRestricted) return dow
  return true
}

function nextLocalDay(parts, timeZone) {
  const midnight = Date.UTC(parts.year, parts.month - 1, parts.day)
  const next = new Date(midnight)
  next.setUTCDate(next.getUTCDate() + 1)
  const wanted = {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
  }
  // Some zones skip midnight itself. Falling back to +24h keeps the search
  // moving; the next iteration reads the real local parts from the clock.
  return localToEpoch(wanted, timeZone) ?? localToEpoch({ ...wanted, hour: 1 }, timeZone) ?? Date.UTC(
    wanted.year,
    wanted.month - 1,
    wanted.day,
    0,
    0,
  )
}

/**
 * The first instant strictly after `afterMs` that matches the expression.
 *
 * @param {object} spec - result of `parseCron`.
 * @param {number} afterMs - epoch milliseconds; the boundary is exclusive.
 * @param {string} timeZone - IANA zone the expression is written in.
 * @returns {number} epoch milliseconds of the next match.
 * @throws {CronError} when nothing matches within eight years (impossible dates such as 30 February).
 */
export function nextCronTime(spec, afterMs, timeZone) {
  validateTimeZone(timeZone)
  if (!Number.isFinite(afterMs)) throw new CronError('nextCronTime needs a finite epoch millisecond value')
  let cursor = Math.floor(afterMs / 60000) * 60000
  if (cursor <= afterMs) cursor += 60000
  let day = zonedParts(cursor, timeZone)
  for (let days = 0; days <= MAX_SEARCH_DAYS; days++) {
    if (!matchesDay(spec, day)) {
      cursor = nextLocalDay(day, timeZone)
      day = zonedParts(cursor, timeZone)
      continue
    }
    for (const hour of spec.hours) {
      if (hour < day.hour) continue
      for (const minute of spec.minutes) {
        if (hour === day.hour && minute < day.minute) continue
        const at = localToEpoch({ year: day.year, month: day.month, day: day.day, hour, minute }, timeZone)
        if (at !== null && at > afterMs) return at
      }
    }
    cursor = nextLocalDay(day, timeZone)
    day = zonedParts(cursor, timeZone)
  }
  throw new CronError(
    `cron "${spec.expression}" has no matching time within 8 years; check the day-of-month and month combination`,
  )
}
