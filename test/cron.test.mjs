import assert from 'node:assert/strict'
import test from 'node:test'

import { CronError, nextCronTime, parseCron, validateTimeZone } from '../lib/cron.js'

function next(expression, from, timeZone = 'UTC') {
  return new Date(nextCronTime(parseCron(expression), Date.parse(from), timeZone)).toISOString()
}

test('a five-field expression expands stars, steps, ranges, lists and names', () => {
  const every = parseCron('* * * * *')
  assert.equal(every.minutes.length, 60)
  assert.equal(every.hours.length, 24)
  assert.equal(every.daysOfMonth.length, 31)
  assert.equal(every.months.length, 12)
  assert.equal(every.daysOfWeek.length, 7)

  const spec = parseCron('*/15 9-17 * * MON-FRI')
  assert.deepEqual(spec.minutes, [0, 15, 30, 45])
  assert.deepEqual(spec.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual(spec.daysOfWeek, [1, 2, 3, 4, 5])
  assert.deepEqual(spec.daysOfMonth, Array.from({ length: 31 }, (_, index) => index + 1))

  const list = parseCron('0,30 8,20 1-3 JAN,JUL *')
  assert.deepEqual(list.minutes, [0, 30])
  assert.deepEqual(list.hours, [8, 20])
  assert.deepEqual(list.daysOfMonth, [1, 2, 3])
  assert.deepEqual(list.months, [1, 7])

  assert.deepEqual(parseCron('0 0 * * 7').daysOfWeek, [0], '7 is Sunday, and must not also appear as 7')
  assert.deepEqual(parseCron('0 0 * * 0').daysOfWeek, [0])
})

test('a field error names the 1-based position and the field', () => {
  assert.throws(() => parseCron('0 25 * * *'), error => {
    assert.ok(error instanceof CronError)
    assert.equal(error.field, 2)
    assert.equal(error.fieldName, 'hour')
    assert.match(error.message, /cron field 2 \(hour\) "25" is out of range 0-23/)
    return true
  })
  assert.throws(() => parseCron('60 * * * *'), /cron field 1 \(minute\) "60" is out of range 0-59/)
  assert.throws(() => parseCron('* * 32 * *'), /cron field 3 \(day-of-month\) "32" is out of range 1-31/)
  assert.throws(() => parseCron('* * * 13 *'), /cron field 4 \(month\) "13" is out of range 1-12/)
  assert.throws(() => parseCron('* * * * 8'), /cron field 5 \(day-of-week\) "8" is out of range 0-7/)
  assert.throws(() => parseCron('*/0 * * * *'), /step must be a number of at least 1/)
  assert.throws(() => parseCron('5-1 * * * *'), /range "5-1" runs backwards/)
})

test('unsupported dialects are refused at parse time, not at fire time', () => {
  assert.throws(() => parseCron('0 0 * * * *'), /got 6; a seconds field is not supported/)
  assert.throws(() => parseCron('0 0 * * * * 2026'), /got 7; a year field is not supported/)
  assert.throws(() => parseCron('@daily'), /cron macro "@daily" is not supported/)
  assert.throws(() => parseCron('0 0 L * *'), /L, W and # are not supported/)
  assert.throws(() => parseCron('0 0 15W * *'), /L, W and # are not supported/)
  assert.throws(() => parseCron('0 0 * * 5#2'), /L, W and # are not supported/)
  assert.throws(() => parseCron('0 0 ? * MON'), /uses "\?", which is not supported/)
  assert.throws(() => parseCron(''), /cron is empty/)
  assert.throws(() => validateTimeZone('Mars/Olympus'), /timeZone "Mars\/Olympus" is not known/)
})

test('next time is strict, follows the calendar, and respects day-of-month OR day-of-week', () => {
  assert.equal(next('*/15 * * * *', '2026-11-15T10:07:30Z'), '2026-11-15T10:15:00.000Z')
  // The boundary is exclusive: at 10:15:00 the next run is 10:30, not now.
  assert.equal(next('*/15 * * * *', '2026-11-15T10:15:00Z'), '2026-11-15T10:30:00.000Z')
  assert.equal(next('0 9 * * *', '2026-11-15T09:00:00Z'), '2026-11-16T09:00:00.000Z')
  // 15 Nov 2026 is a Sunday; the next Friday wins over the next 13th.
  assert.equal(next('0 0 13 * 5', '2026-11-15T00:00:00Z'), '2026-11-20T00:00:00.000Z')
  // 30 February never happens, so this must be reported instead of silently
  // finding some other day eight years later.
  assert.throws(() => next('0 0 30 2 *', '2026-11-15T00:00:00Z'), /has no matching time within 8 years/)
})

test('the expression is evaluated in its own zone, not the host zone', () => {
  // 09:00 in Shanghai is 01:00 UTC.
  assert.equal(next('0 9 * * *', '2026-11-15T00:00:00Z', 'Asia/Shanghai'), '2026-11-15T01:00:00.000Z')
  // 23:30 in Shanghai is 15:30 UTC the same day.
  assert.equal(next('30 23 * * *', '2026-11-15T00:00:00Z', 'Asia/Shanghai'), '2026-11-15T15:30:00.000Z')
  // 02:30 in New York on the spring-forward day does not exist; the next real
  // occurrence is the following day at 02:30 EDT.
  assert.equal(next('30 2 * * *', '2026-03-08T00:00:00Z', 'America/New_York'), '2026-03-09T06:30:00.000Z')
  // 01:30 on the fall-back day happens twice; the earlier offset is chosen.
  assert.equal(next('30 1 * * *', '2026-11-01T00:00:00Z', 'America/New_York'), '2026-11-01T05:30:00.000Z')
})
