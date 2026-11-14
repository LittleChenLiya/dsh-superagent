import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createNotifyPolicy, createOutbox } from '../lib/notify.js'

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

test('a folded batch is retried in the next message when its send fails', async () => {
  await withState(async stateFile => {
    let clock = Date.parse('2026-11-14T01:05:00.000Z')
    const policy = createNotifyPolicy({ stateFile, maxPerHour: 1, now: () => clock })
    assert.equal((await policy.reserve(run('a'))).allowed, true)

    const held = await policy.reserve(run('b', 'failed'))
    assert.equal(held.allowed, false)
    assert.match(held.reason, /batched/)

    // Next window: the first message carries `b`, but its delivery fails.
    clock += 60 * 60 * 1000 + 1
    const next = await policy.reserve(run('c'))
    assert.equal(next.allowed, true)
    assert.deepEqual(next.batch.map(item => item.id), ['b'])
    await policy.restore(next.batch)
    assert.deepEqual((await policy.summary()).pending.map(item => item.id), ['b'])

    // The following message must still carry it instead of losing the run.
    clock += 60 * 60 * 1000 + 1
    const retry = await policy.reserve(run('d'))
    assert.equal(retry.allowed, true)
    assert.deepEqual(retry.batch.map(item => item.id), ['b'])
    assert.equal((await policy.summary()).pending.length, 0)
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

test('a rejected delivery is retried with the same message', async () => {
  const attempts = []
  const outbox = createOutbox({
    retries: 2,
    delayMs: 0,
    sleep: async () => {},
  })
  const result = await outbox.enqueue('session-a', async () => {
    attempts.push(`try ${attempts.length + 1}`)
    if (attempts.length < 3) throw new Error('session busy')
    return 'delivered'
  })

  assert.equal(result, 'delivered')
  assert.equal(attempts.length, 3)
})

test('a delivery that keeps failing reports the last error after its retries', async () => {
  let calls = 0
  const outbox = createOutbox({ retries: 1, delayMs: 0, sleep: async () => {} })
  await assert.rejects(
    () => outbox.enqueue('session-b', async () => {
      calls++
      throw new Error(`refused ${calls}`)
    }),
    /refused 2/,
  )
  assert.equal(calls, 2)
})

test('messages for one session stay in order even while an earlier one retries', async () => {
  const order = []
  const outbox = createOutbox({ retries: 1, delayMs: 0, sleep: async () => {} })

  const first = outbox.enqueue('session-c', async () => {
    order.push('first-start')
    await new Promise(resolve => setTimeout(resolve, 10))
    order.push('first-end')
    return 'first'
  })
  const second = outbox.enqueue('session-c', async () => {
    order.push('second')
    return 'second'
  })

  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.deepEqual(order, ['first-start', 'first-end', 'second'])
})

