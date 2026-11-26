import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createBriefScheduler } from '../lib/brief-scheduler.js'
import { DEFAULT_NOTIFY_PREFERENCES } from '../lib/notify-preferences.js'

const at = value => Date.parse(value)
const briefConfig = (overrides = {}) => ({
  enabled: true,
  time: '09:00',
  timeZone: 'UTC',
  channels: ['inbox'],
  ...overrides,
})
const quietConfig = (overrides = {}) => ({
  enabled: true,
  start: '22:00',
  end: '08:00',
  timeZone: 'UTC',
  except: [],
  ...overrides,
})
const preferences = (overrides = {}) => ({
  ...structuredClone(DEFAULT_NOTIFY_PREFERENCES),
  dailyBrief: briefConfig(),
  quietHours: quietConfig({ enabled: false }),
  ...overrides,
})

async function temporaryState(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'brief-scheduler-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return path.join(root, 'nested', 'brief-state.json')
}

async function settle() {
  for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve))
}

function harness(options = {}) {
  let clock = at(options.now ?? '2026-11-14T08:00:00.000Z')
  let prefs = options.preferences ?? preferences()
  const timers = []
  const deliveries = []
  const builds = []
  const cleared = []
  let nextTimer = 1
  let failBuild = options.failBuild ?? 0
  let failDeliver = options.failDeliver ?? 0

  const scheduler = createBriefScheduler({
    stateFile: options.stateFile,
    now: () => clock,
    retryDelayMs: options.retryDelayMs ?? 60_000,
    preferencesStore: {
      async read() {
        options.reads?.push(clock)
        return options.envelope
          ? { preferences: structuredClone(prefs), revision: options.revision ?? 'preferences-revision' }
          : structuredClone(prefs)
      },
    },
    async buildBrief(input) {
      builds.push(structuredClone(input))
      if (failBuild > 0) {
        failBuild -= 1
        throw new Error('brief build failed')
      }
      return options.buildBrief?.(input) ?? {
        id: `daily-brief:${input.date ? new Date(input.date).toISOString() : 'manual'}`,
        date: new Date(input.date).toISOString().slice(0, 10),
        text: 'deterministic brief',
      }
    },
    async deliver(payload) {
      if (failDeliver > 0) {
        failDeliver -= 1
        throw new Error('delivery failed')
      }
      deliveries.push(structuredClone(payload))
      return options.deliver?.(payload)
    },
    setTimer(callback, delay) {
      const timer = {
        id: nextTimer++,
        callback,
        delay,
        due: clock + delay,
        cleared: false,
      }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (!timer) return
      timer.cleared = true
      cleared.push(timer)
    },
  })

  return {
    scheduler,
    timers,
    deliveries,
    builds,
    cleared,
    get clock() { return clock },
    set clock(value) { clock = value },
    get preferences() { return prefs },
    set preferences(value) { prefs = value },
    get failBuild() { return failBuild },
    set failBuild(value) { failBuild = value },
    get failDeliver() { return failDeliver },
    set failDeliver(value) { failDeliver = value },
    activeTimers() { return timers.filter(timer => !timer.cleared) },
    advanceTo(value) { clock = at(value) },
    async fire(index = 0) {
      const timer = this.activeTimers().sort((left, right) => left.due - right.due)[index]
      assert.ok(timer, 'expected a scheduled timer')
      clock = Math.max(clock, timer.due)
      timer.cleared = true
      await timer.callback()
      await settle()
      return timer
    },
  }
}

test('validates injected dependencies and clocks', async t => {
  assert.throws(() => createBriefScheduler({}), /preferencesStore/)
  assert.throws(() => createBriefScheduler({
    preferencesStore: { read() {} }, buildBrief() {}, deliver() {},
  }), /stateFile/)
  const stateFile = await temporaryState(t)
  const h = harness({ stateFile, now: 'not-a-date' })
  await assert.rejects(h.scheduler.start(), /valid date/)
})

test('start schedules the exact local boundary and advances across midnight', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-11-14T00:59:59.999Z',
    preferences: preferences({ dailyBrief: briefConfig({ timeZone: 'Asia/Shanghai' }) }),
  })
  await h.scheduler.start()
  assert.equal(h.scheduler.status().running, true)
  assert.equal(h.scheduler.status().nextAt, '2026-11-14T01:00:00.000Z')
  assert.equal(h.activeTimers().length, 1)

  await h.fire()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].date, '2026-11-14')
  assert.equal(h.builds[0].now, at('2026-11-14T01:00:00.000Z'))
  assert.equal(h.builds[0].date, at('2026-11-14T01:00:00.000Z'))
  assert.equal(h.scheduler.status().nextAt, '2026-11-15T01:00:00.000Z')
  assert.equal(h.scheduler.status().lastDeliveredDate, '2026-11-14')
})

test('a local-midnight brief belongs to the new calendar date even when UTC is still yesterday', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-11-14T15:59:59.999Z',
    preferences: preferences({ dailyBrief: briefConfig({ time: '00:10', timeZone: 'Asia/Shanghai' }) }),
  })
  await h.scheduler.runNow()
  await h.scheduler.start()
  assert.equal(h.scheduler.status().nextAt, '2026-11-14T16:10:00.000Z')
  await h.fire()
  assert.equal(h.deliveries.length, 2)
  assert.equal(h.deliveries.at(-1).date, '2026-11-15')
  assert.equal(h.scheduler.status().nextAt, '2026-11-15T16:10:00.000Z')
})

test('runNow delivers once for the local day and the regular timer becomes a no-op', async t => {
  const h = harness({ stateFile: await temporaryState(t) })
  const [first, second] = await Promise.all([h.scheduler.runNow(), h.scheduler.runNow()])
  assert.equal(first.status, 'delivered')
  assert.equal(second.status, 'skipped')
  assert.equal(second.reason, 'already-delivered')
  assert.equal(h.builds.length, 1)
  assert.equal(h.deliveries.length, 1)

  await h.scheduler.start()
  assert.equal(h.scheduler.status().nextAt, '2026-11-15T09:00:00.000Z')
  h.advanceTo('2026-11-14T09:00:00.000Z')
  assert.equal(h.deliveries.length, 1)
})

test('spring-forward skips a missing brief time instead of inventing one', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-03-07T12:00:00.000Z',
    preferences: preferences({ dailyBrief: briefConfig({ time: '02:30', timeZone: 'America/New_York' }) }),
  })
  await h.scheduler.runNow()
  assert.equal(h.scheduler.status().nextAt, null, 'runNow does not start a timer')
  await h.scheduler.start()
  assert.equal(h.scheduler.status().nextAt, '2026-03-09T06:30:00.000Z')
  h.advanceTo('2026-03-09T06:30:00.000Z')
  await h.fire()
  assert.equal(h.deliveries.at(-1).date, '2026-03-09')
})

test('fall-back never schedules a second brief for an already delivered local date', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-11-01T04:00:00.000Z',
    preferences: preferences({ dailyBrief: briefConfig({ time: '01:30', timeZone: 'America/New_York' }) }),
  })
  await h.scheduler.runNow()
  await h.scheduler.start()
  assert.equal(h.scheduler.status().nextAt, '2026-11-02T06:30:00.000Z')
  h.advanceTo('2026-11-01T05:45:00.000Z')
  const result = await h.scheduler.runNow()
  assert.equal(result.reason, 'already-delivered')
  assert.equal(h.scheduler.status().nextAt, '2026-11-02T06:30:00.000Z')
  assert.equal(h.deliveries.length, 1)
})

test('the first fall-back occurrence delivers once and the next timer is the following local day', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-11-01T04:00:00.000Z',
    preferences: preferences({ dailyBrief: briefConfig({ time: '01:30', timeZone: 'America/New_York' }) }),
  })
  await h.scheduler.start()
  assert.equal(h.scheduler.status().nextAt, '2026-11-01T05:30:00.000Z')
  await h.fire()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].date, '2026-11-01')
  assert.equal(h.scheduler.status().nextAt, '2026-11-02T06:30:00.000Z')
})

test('restart catches up at most one latest missed day and never repeats a delivered date', async t => {
  const stateFile = await temporaryState(t)
  const first = harness({ stateFile, now: '2026-11-16T09:00:00.000Z' })
  await first.scheduler.start()
  assert.deepEqual(first.deliveries.map(item => item.date), ['2026-11-16'])
  first.scheduler.stop()

  const sameDay = harness({ stateFile, now: '2026-11-16T10:00:00.000Z' })
  await sameDay.scheduler.start()
  assert.equal(sameDay.deliveries.length, 0)
  assert.equal(sameDay.scheduler.status().nextAt, '2026-11-17T09:00:00.000Z')
  sameDay.scheduler.stop()

  const later = harness({ stateFile, now: '2026-11-18T09:00:00.000Z' })
  await later.scheduler.start()
  assert.deepEqual(later.deliveries.map(item => item.date), ['2026-11-18'])
  const journal = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
  assert.deepEqual(journal.deliveries.map(item => item.date), ['2026-11-16', '2026-11-18'])
})

test('restart resumes one journaled pending delivery with the same idempotency revision', async t => {
  const stateFile = await temporaryState(t)
  const first = harness({ stateFile, failDeliver: 1, envelope: true, revision: 'stable-revision' })
  await assert.rejects(first.scheduler.runNow(), /delivery failed/)
  assert.equal(first.builds.length, 1)
  assert.equal(first.deliveries.length, 0)
  assert.equal(first.scheduler.status().pending.date, '2026-11-14')
  assert.match(await fsp.readFile(stateFile, 'utf8'), /stable-revision/)

  const restarted = harness({ stateFile, now: '2026-11-14T08:05:00.000Z', envelope: true, revision: 'changed-revision' })
  await restarted.scheduler.start()
  assert.equal(restarted.builds.length, 0, 'the persisted brief is reused')
  assert.equal(restarted.deliveries.length, 1)
  assert.equal(restarted.deliveries[0].revision, 'stable-revision')
  assert.equal(restarted.scheduler.status().pending, null)
})

test('a dailyBrief quiet-hours exception delivers at the scheduled time', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-11-14T07:29:00.000Z',
    preferences: preferences({
      dailyBrief: briefConfig({ time: '07:30' }),
      quietHours: quietConfig({ except: ['dailyBrief'] }),
    }),
  })
  await h.scheduler.start()
  h.advanceTo('2026-11-14T07:30:00.000Z')
  await h.fire()
  assert.equal(h.builds.length, 1)
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].date, '2026-11-14')
  assert.equal(h.builds[0].now, at('2026-11-14T07:30:00.000Z'))
  assert.equal(h.scheduler.status().nextAt, '2026-11-15T07:30:00.000Z')
  assert.equal(h.scheduler.status().pending, null)
})

test('quiet hours use their own IANA zone and runNow also defers', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-11-14T01:30:00.000Z',
    preferences: preferences({
      dailyBrief: briefConfig({ time: '09:00', timeZone: 'Asia/Shanghai' }),
      quietHours: quietConfig({ start: '09:00', end: '10:00', timeZone: 'Asia/Shanghai' }),
    }),
  })
  const result = await h.scheduler.runNow()
  assert.equal(result.status, 'deferred')
  assert.equal(result.nextAt, '2026-11-14T02:00:00.000Z')
  assert.equal(h.builds.length, 0)
  assert.equal(h.activeTimers().length, 1)
  await h.fire()
  assert.equal(h.deliveries[0].date, '2026-11-14')
})

test('a quiet-hour end inside a spring-forward gap resolves to the first real instant after the gap', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-03-08T06:29:00.000Z',
    preferences: preferences({
      dailyBrief: briefConfig({ time: '01:30', timeZone: 'America/New_York' }),
      quietHours: quietConfig({ start: '01:00', end: '02:30', timeZone: 'America/New_York' }),
    }),
  })
  await h.scheduler.start()
  h.advanceTo('2026-03-08T06:30:00.000Z')
  await h.fire()
  assert.equal(h.scheduler.status().nextAt, '2026-03-08T07:00:00.000Z')
  await h.fire()
  assert.equal(h.deliveries[0].date, '2026-03-08')
})

test('quiet deferral survives restart without changing the due date', async t => {
  const stateFile = await temporaryState(t)
  const first = harness({
    stateFile,
    now: '2026-11-14T07:30:00.000Z',
    preferences: preferences({
      dailyBrief: briefConfig({ time: '07:30' }),
      quietHours: quietConfig(),
    }),
  })
  const result = await first.scheduler.runNow()
  assert.equal(result.status, 'deferred')
  first.scheduler.stop()

  const restarted = harness({
    stateFile,
    now: '2026-11-14T07:45:00.000Z',
    preferences: preferences({
      dailyBrief: briefConfig({ time: '07:30' }),
      quietHours: quietConfig(),
    }),
  })
  await restarted.scheduler.start()
  assert.equal(restarted.scheduler.status().nextAt, '2026-11-14T08:00:00.000Z')
  await restarted.fire()
  assert.equal(restarted.deliveries[0].date, '2026-11-14')
  assert.equal(restarted.builds[0].now, at('2026-11-14T07:30:00.000Z'))
})

test('disabled briefs create no timer, state file, build, or delivery', async t => {
  const stateFile = await temporaryState(t)
  const h = harness({
    stateFile,
    preferences: preferences({ dailyBrief: briefConfig({ enabled: false }) }),
  })
  await h.scheduler.start()
  const result = await h.scheduler.runNow()
  assert.equal(result.reason, 'disabled')
  assert.equal(h.scheduler.status().enabled, false)
  assert.equal(h.scheduler.status().nextAt, null)
  assert.equal(h.activeTimers().length, 0)
  assert.equal(h.builds.length, 0)
  assert.equal(h.deliveries.length, 0)
  await assert.rejects(fsp.access(stateFile), { code: 'ENOENT' })
})

test('disabling a deferred brief cancels its journaled pending delivery', async t => {
  const stateFile = await temporaryState(t)
  const h = harness({
    stateFile,
    now: '2026-11-14T07:30:00.000Z',
    preferences: preferences({
      dailyBrief: briefConfig({ time: '07:30' }),
      quietHours: quietConfig(),
    }),
  })
  await h.scheduler.runNow()
  h.preferences = preferences({ dailyBrief: briefConfig({ enabled: false }) })
  h.advanceTo('2026-11-14T08:00:00.000Z')
  await h.fire()
  assert.equal(h.builds.length, 0)
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.scheduler.status().pending, null)
  assert.equal(h.activeTimers().length, 0)
})

test('stop clears the active timer and stale callbacks cannot deliver', async t => {
  const h = harness({ stateFile: await temporaryState(t) })
  await h.scheduler.start()
  const timer = h.activeTimers()[0]
  const callback = timer.callback
  const stopped = h.scheduler.stop()
  assert.equal(stopped.running, false)
  assert.equal(stopped.timerScheduled, false)
  assert.equal(timer.cleared, true)
  assert.equal(h.cleared.length, 1)
  h.scheduler.stop()
  assert.equal(h.cleared.length, 1, 'stop is idempotent')

  h.advanceTo('2026-11-14T09:00:00.000Z')
  await callback()
  await settle()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.activeTimers().length, 0)
})

test('delivery failure retries the identical persisted brief, date, and revision', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    failDeliver: 1,
    envelope: true,
    revision: 'revision-1',
    retryDelayMs: 5_000,
  })
  await assert.rejects(h.scheduler.runNow(), /delivery failed/)
  assert.equal(h.builds.length, 1)
  assert.equal(h.scheduler.status().pending.attempts, 1)
  assert.equal(h.scheduler.status().nextAt, '2026-11-14T08:00:05.000Z')
  assert.match(h.scheduler.status().lastError, /delivery failed/)

  await h.fire()
  assert.equal(h.builds.length, 1, 'retry does not regenerate the brief')
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.deliveries[0].revision, 'revision-1')
  assert.equal(h.scheduler.status().pending, null)
  assert.equal(h.scheduler.status().lastError, null)
})

test('build failure is retried and does not mark the day delivered', async t => {
  const h = harness({ stateFile: await temporaryState(t), failBuild: 1, retryDelayMs: 1_000 })
  await assert.rejects(h.scheduler.runNow(), /brief build failed/)
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.scheduler.status().lastDeliveredDate, null)
  await h.fire()
  assert.equal(h.builds.length, 2)
  assert.equal(h.deliveries.length, 1)
})

test('a failed delivery entering quiet hours waits for silence to end', async t => {
  const h = harness({
    stateFile: await temporaryState(t),
    now: '2026-11-14T21:59:30.000Z',
    failDeliver: 1,
    retryDelayMs: 60_000,
    preferences: preferences({ quietHours: quietConfig({ except: [] }) }),
  })
  await assert.rejects(h.scheduler.runNow(), /delivery failed/)
  assert.equal(h.scheduler.status().nextAt, '2026-11-14T22:00:30.000Z')
  await h.fire()
  assert.equal(h.scheduler.status().nextAt, '2026-11-15T08:00:00.000Z')
  await h.fire()
  assert.equal(h.deliveries.length, 1)
})

test('preference changes cannot make an old timer deliver before the new daily time', async t => {
  const h = harness({ stateFile: await temporaryState(t) })
  await h.scheduler.start()
  h.preferences = preferences({ dailyBrief: briefConfig({ time: '10:00' }) })
  h.advanceTo('2026-11-14T09:00:00.000Z')
  await h.fire()
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.scheduler.status().nextAt, '2026-11-14T10:00:00.000Z')
})

test('delivery revision is deterministic from canonical preferences when the store supplies none', async t => {
  const stateFile = await temporaryState(t)
  const first = harness({ stateFile })
  await first.scheduler.runNow()
  const second = harness({ stateFile, now: '2026-11-15T08:00:00.000Z' })
  await second.scheduler.runNow()
  assert.equal(first.deliveries[0].revision, second.deliveries[0].revision)
  assert.match(first.deliveries[0].revision, /^[a-f0-9]{24}$/)
})

test('corrupt state is rejected and preserved rather than silently duplicating delivery', async t => {
  const stateFile = await temporaryState(t)
  await fsp.mkdir(path.dirname(stateFile), { recursive: true })
  await fsp.writeFile(stateFile, '{broken', 'utf8')
  const h = harness({ stateFile })
  await assert.rejects(h.scheduler.start(), SyntaxError)
  assert.equal(await fsp.readFile(stateFile, 'utf8'), '{broken')
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.activeTimers().length, 0)
})

test('scheduler uses only injected builder and delivery and never starts tasks or calls a model', async t => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { calls.push('fetch'); throw new Error('network forbidden') }
  try {
    const h = harness({ stateFile: await temporaryState(t) })
    await h.scheduler.runNow()
    assert.deepEqual(calls, [])
    assert.deepEqual(Object.keys(h.builds[0]).sort(), ['date', 'now', 'preferences'])
    assert.deepEqual(Object.keys(h.deliveries[0]).sort(), ['brief', 'date', 'revision'])
  } finally {
    globalThis.fetch = originalFetch
  }
})
