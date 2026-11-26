import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_NOTIFY_PREFERENCES,
  NotifyPreferencesError,
  createNotifyPreferences,
  readNotifyPreferences,
  updateNotifyPreferences,
  validateNotifyPreferences,
  writeNotifyPreferences,
} from '../lib/notify-preferences.js'

async function tempStore(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-notify-preferences-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return { root, file: path.join(root, 'nested', 'notify-preferences.json') }
}

function invalid(field, value) {
  return error => error instanceof NotifyPreferencesError && error.field === field
}

test('defaults are complete, frozen, and validation returns an independent canonical object', () => {
  assert.deepEqual(validateNotifyPreferences(), DEFAULT_NOTIFY_PREFERENCES)
  const first = validateNotifyPreferences()
  first.events.completed = 'off'
  first.channels.push('push')
  first.quietHours.except.push('failed')
  assert.equal(DEFAULT_NOTIFY_PREFERENCES.events.completed, 'both')
  assert.deepEqual(DEFAULT_NOTIFY_PREFERENCES.channels, ['inbox', 'push'])
  assert.deepEqual(DEFAULT_NOTIFY_PREFERENCES.quietHours.except, [])
  assert.ok(Object.isFrozen(DEFAULT_NOTIFY_PREFERENCES.events))
})

test('all event modes, channels, limits, quiet-hour exceptions, and briefs validate', () => {
  const value = validateNotifyPreferences({
    events: {
      added: 'off', completed: 'inbox', failed: 'push', decision: 'both', approval: 'off', artifact: 'inbox',
    },
    channels: ['push', 'inbox'],
    maxPushPerHour: 0,
    quietHours: {
      enabled: true, start: '23:30', end: '06:15', timeZone: 'America/New_York',
      except: ['approval', 'dailyBrief'],
    },
    dailyBrief: { enabled: false, time: '00:00', timeZone: 'Asia/Shanghai', channels: ['push'] },
  })
  assert.equal(value.events.added, 'off')
  assert.equal(value.events.failed, 'push')
  assert.deepEqual(value.channels, ['push', 'inbox'])
  assert.equal(value.maxPushPerHour, 0)
  assert.deepEqual(value.quietHours.except, ['approval', 'dailyBrief'])
  assert.equal(value.dailyBrief.timeZone, 'Asia/Shanghai')
})

test('strict validation rejects coercible wrong types, unknown fields, and unsafe keys', () => {
  assert.throws(() => validateNotifyPreferences(null), invalid('preferences'))
  assert.throws(() => validateNotifyPreferences([]), invalid('preferences'))
  assert.throws(() => validateNotifyPreferences({ maxPushPerHour: '3' }), invalid('maxPushPerHour'))
  assert.throws(() => validateNotifyPreferences({ maxPushPerHour: null }), invalid('maxPushPerHour'))
  assert.throws(() => validateNotifyPreferences({ events: null }), invalid('events'))
  assert.throws(() => validateNotifyPreferences({ events: { completed: null } }), invalid('events.completed'))
  assert.throws(() => validateNotifyPreferences({ channels: null }), invalid('channels'))
  assert.throws(() => validateNotifyPreferences({ quietHours: null }), invalid('quietHours'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { except: null } }), invalid('quietHours.except'))
  assert.throws(() => validateNotifyPreferences({ dailyBrief: null }), invalid('dailyBrief'))
  assert.throws(() => validateNotifyPreferences({ dailyBrief: { channels: null } }), invalid('dailyBrief.channels'))
  assert.throws(() => validateNotifyPreferences({ maxPushPerHour: 1.5 }), invalid('maxPushPerHour'))
  assert.throws(() => validateNotifyPreferences({ maxPushPerHour: -1 }), invalid('maxPushPerHour'))
  assert.throws(() => validateNotifyPreferences({ maxPushPerHour: 1001 }), invalid('maxPushPerHour'))
  assert.throws(() => validateNotifyPreferences({ events: { completed: 'email' } }), invalid('events.completed'))
  assert.throws(() => validateNotifyPreferences({ events: { unknown: 'off' } }), invalid('events.unknown'))
  assert.throws(() => validateNotifyPreferences({ channels: 'inbox' }), invalid('channels'))
  assert.throws(() => validateNotifyPreferences({ channels: [] }), invalid('channels'))
  assert.throws(() => validateNotifyPreferences({ channels: ['sms'] }), invalid('channels[0]'))
  assert.throws(() => validateNotifyPreferences({ channels: ['inbox', 'inbox'] }), invalid('channels[1]'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { enabled: 1 } }), invalid('quietHours.enabled'))
  assert.throws(() => validateNotifyPreferences({ dailyBrief: { enabled: 'true' } }), invalid('dailyBrief.enabled'))
  assert.throws(() => validateNotifyPreferences({ extra: true }), invalid('preferences.extra'))
  assert.throws(() => validateNotifyPreferences(JSON.parse('{"__proto__":{"polluted":true}}')), error =>
    error instanceof NotifyPreferencesError)
  assert.equal({}.polluted, undefined)
})

test('quiet hours reject malformed times, ambiguous equal boundaries, bad zones, and bad exceptions', () => {
  assert.throws(() => validateNotifyPreferences({ quietHours: { start: '9:00' } }), invalid('quietHours.start'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { end: '24:00' } }), invalid('quietHours.end'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { start: '08:00', end: '08:00' } }), invalid('quietHours.start'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { timeZone: '+08:00' } }), invalid('quietHours.timeZone'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { timeZone: 'Mars/Olympus' } }), invalid('quietHours.timeZone'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { except: 'failed' } }), invalid('quietHours.except'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { except: ['email'] } }), invalid('quietHours.except[0]'))
  assert.throws(() => validateNotifyPreferences({ quietHours: { except: ['failed', 'failed'] } }), invalid('quietHours.except[1]'))
})

test('daily brief validates its independent clock and channel selection', () => {
  assert.throws(() => validateNotifyPreferences({ dailyBrief: { time: '09:60' } }), invalid('dailyBrief.time'))
  assert.throws(() => validateNotifyPreferences({ dailyBrief: { timeZone: 'EST' } }), invalid('dailyBrief.timeZone'))
  assert.throws(() => validateNotifyPreferences({ dailyBrief: { channels: [] } }), invalid('dailyBrief.channels'))
  assert.throws(() => validateNotifyPreferences({ dailyBrief: { channels: ['inbox', 'push', 'push'] } }), invalid('dailyBrief.channels[2]'))
  assert.throws(() => validateNotifyPreferences({ dailyBrief: { days: [1] } }), invalid('dailyBrief.days'))
})

test('missing files read defaults without creating anything; save and convenience writers round-trip', async t => {
  const { root, file } = await tempStore(t)
  const store = createNotifyPreferences({ file })
  assert.deepEqual(await store.read(), DEFAULT_NOTIFY_PREFERENCES)
  assert.equal((await store.readDetailed()).exists, false)
  await assert.rejects(fsp.access(path.dirname(file)), { code: 'ENOENT' })

  const saved = await writeNotifyPreferences(file, { events: { completed: 'off' }, maxPushPerHour: 7 })
  assert.equal(saved.events.completed, 'off')
  assert.deepEqual(await readNotifyPreferences(file), saved)
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), saved)
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['notify-preferences.json'])
  assert.equal((await fsp.stat(path.join(root, 'nested'))).isDirectory(), true)
})

test('damaged JSON and invalid shapes fall back to defaults without overwriting evidence', async t => {
  const { file } = await tempStore(t)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const warnings = []
  const store = createNotifyPreferences({ file, warn: message => warnings.push(message) })
  const broken = '{"events":{"completed":'
  await fsp.writeFile(file, broken)
  const detail = await store.readDetailed()
  assert.deepEqual(detail.preferences, DEFAULT_NOTIFY_PREFERENCES)
  assert.equal(detail.exists, true)
  assert.equal(detail.recovered, true)
  assert.ok(detail.error instanceof SyntaxError)
  assert.equal(await fsp.readFile(file, 'utf8'), broken)
  assert.match(warnings[0], /using defaults/)

  await fsp.writeFile(file, '{"events":{"completed":"sms"}}')
  assert.deepEqual(await store.read(), DEFAULT_NOTIFY_PREFERENCES)
  assert.equal(await fsp.readFile(file, 'utf8'), '{"events":{"completed":"sms"}}')

  await store.update({ maxPushPerHour: 8 })
  assert.equal((await store.read()).maxPushPerHour, 8)
  const backups = (await fsp.readdir(path.dirname(file))).filter(name => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, 'only the damaged file present at write time is backed up')
  assert.equal(await fsp.readFile(path.join(path.dirname(file), backups[0]), 'utf8'), '{"events":{"completed":"sms"}}')
})

test('invalid writes and failed updaters leave the prior file byte-for-byte intact', async t => {
  const { file } = await tempStore(t)
  const store = createNotifyPreferences({ file })
  await store.save({ maxPushPerHour: 4 })
  const before = await fsp.readFile(file, 'utf8')
  await assert.rejects(store.save({ maxPushPerHour: '9' }), invalid('maxPushPerHour'))
  await assert.rejects(store.update({ events: { completed: 'telepathy' } }), invalid('events.completed'))
  await assert.rejects(store.update(() => { throw new Error('updater stopped') }), /updater stopped/)
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['notify-preferences.json'])
})

test('concurrent read-modify-write updates do not lose fields or expose partial JSON', async t => {
  const { file } = await tempStore(t)
  const stores = Array.from({ length: 12 }, () => createNotifyPreferences({ file }))
  await stores[0].save({ events: { added: 'off', completed: 'off', failed: 'off' } })

  const reading = (async () => {
    for (let index = 0; index < 80; index++) {
      const value = JSON.parse(await fsp.readFile(file, 'utf8'))
      assert.equal(value.events.added, 'off')
      assert.equal(typeof value.maxPushPerHour, 'number')
    }
  })()
  const updates = stores.map((store, index) => store.update({
    events: { completed: index % 2 ? 'push' : 'inbox' },
    ...(index === 0 ? { maxPushPerHour: 11 } : {}),
    ...(index === 1 ? { quietHours: { start: '23:00' } } : {}),
    ...(index === 2 ? { dailyBrief: { time: '08:45' } } : {}),
  }))
  await Promise.all([reading, Promise.all(updates)])
  const final = await stores[0].read()
  assert.ok(['inbox', 'push'].includes(final.events.completed))
  assert.equal(final.events.added, 'off')
  assert.equal(final.events.failed, 'off')
  assert.equal(final.maxPushPerHour, 11)
  assert.equal(final.quietHours.start, '23:00')
  assert.equal(final.dailyBrief.time, '08:45')
  assert.deepEqual(await fsp.readdir(path.dirname(file)), ['notify-preferences.json'])
})

test('function updaters run inside the lock and reset restores defaults', async t => {
  const { file } = await tempStore(t)
  const store = createNotifyPreferences({ file })
  await store.save({ events: { completed: 'off' } })
  const changed = await store.update(current => {
    current.events.completed = 'both'
    current.maxPushPerHour = 2
  })
  assert.equal(changed.events.completed, 'both')
  assert.equal(changed.maxPushPerHour, 2)
  assert.deepEqual(await updateNotifyPreferences(file, { dailyBrief: { time: '10:30' } }), {
    ...changed, dailyBrief: { ...changed.dailyBrief, time: '10:30' },
  })
  assert.deepEqual(await store.reset(), DEFAULT_NOTIFY_PREFERENCES)
})
