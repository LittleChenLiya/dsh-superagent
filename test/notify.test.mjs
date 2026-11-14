import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createNotifyPolicy } from '../lib/notify.js'

function run(id, status = 'completed') {
  return { id, status, goal: `goal ${id}`, subtasks: [], finishedAt: '2026-11-14T00:00:00.000Z' }
}

async function withState(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-notify-'))
  try {
    return await fn(path.join(root, 'notifications.json'))
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

test('a cancelled run is never announced', async () => {
  await withState(async stateFile => {
    const policy = createNotifyPolicy({ stateFile, maxPerHour: 3 })
    const verdict = await policy.reserve(run('r1', 'cancelled'))
    assert.equal(verdict.allowed, false)
    assert.match(verdict.reason, /not announced/)
    assert.equal((await policy.summary()).count, 0)
  })
})

test('messages above the hourly cap are batched into the next one', async () => {
  await withState(async stateFile => {
    const clock = () => Date.parse('2026-11-14T01:05:00.000Z')
    const policy = createNotifyPolicy({ stateFile, maxPerHour: 2, now: clock })
    assert.equal((await policy.reserve(run('a'))).allowed, true)
    assert.equal((await policy.reserve(run('b'))).allowed, true)

    const third = await policy.reserve(run('c', 'failed'))
    assert.equal(third.allowed, false)
    assert.match(third.reason, /batched/)
    const fourth = await policy.reserve(run('d', 'failed'))
    assert.equal(fourth.allowed, false)

    // The cap is per window, but the first message of the next window carries
    // everything that was held back instead of dropping it.
    const fresh = createNotifyPolicy({ stateFile, maxPerHour: 2, now: () => Date.parse('2026-11-14T03:00:00.000Z') })
    const fifth = await fresh.reserve(run('e'))
    assert.equal(fifth.allowed, true)
    assert.deepEqual(fifth.batch.map(item => item.id), ['c', 'd'])
    assert.equal((await fresh.summary()).pending.length, 0)
  })
})

test('the counter survives a new policy instance in the same window', async () => {
  await withState(async stateFile => {
    const clock = () => Date.parse('2026-11-14T00:10:00.000Z')
    const first = createNotifyPolicy({ stateFile, maxPerHour: 1, now: clock })
    assert.equal((await first.reserve(run('a'))).allowed, true)
    const second = createNotifyPolicy({ stateFile, maxPerHour: 1, now: clock })
    assert.equal((await second.reserve(run('b'))).allowed, false)
  })
})

test('the policy leaves no lock file behind', async () => {
  await withState(async stateFile => {
    const policy = createNotifyPolicy({ stateFile, maxPerHour: 3 })
    await policy.reserve(run('a'))
    await assert.rejects(fsp.access(`${stateFile}.lock`), { code: 'ENOENT' })
  })
})
