import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  activityOf,
  callsOf,
  elapsedOf,
  orderRuns,
  renderFrame,
  signatureOf,
  watch,
} from '../lib/watch.js'
import { createStore } from '../lib/store.js'

const T0 = Date.parse('2026-11-14T08:00:00.000Z')

function run(overrides = {}) {
  return {
    id: '20261114T080000-aaaa',
    status: 'running',
    goal: 'compare three vector databases',
    parentSessionId: 'session-9f04c61f-2c4a-4a1a-9d3f-000000000000',
    createdAt: '2026-11-14T08:00:00.000Z',
    startedAt: '2026-11-14T08:00:00.000Z',
    finishedAt: null,
    limits: { maxModelCalls: 80 },
    usage: { modelCalls: 5, totalTokens: 4800 },
    counters: { spawns: 5 },
    subtasks: [
      { title: 'collect pricing', status: 'running', startedAt: '2026-11-14T08:00:10.000Z' },
      { title: 'benchmark queries', status: 'pending', startedAt: null },
    ],
    ...overrides,
  }
}

/** A writable stream stand-in that records everything and can signal a paint. */
function fakeStream({ isTTY = false, columns = 110 } = {}) {
  const stream = {
    isTTY,
    columns,
    text: '',
    frames: 0,
    on() {},
    write(chunk) {
      stream.text += String(chunk)
      if (String(chunk).includes('dsh-superagent')) stream.frames += 1
      if (stream.onFrame) stream.onFrame(stream.frames)
      return true
    },
  }
  return stream
}

/** Resolve on the first paint, without a fixed sleep. */
function firstFrame(stream) {
  return new Promise(resolve => {
    if (stream.frames > 0) {
      resolve()
      return
    }
    stream.onFrame = frames => {
      if (frames > 0) resolve()
    }
  })
}

test('one line per run carries id, status, calls/cap, elapsed, activity and parent', () => {
  const frame = renderFrame([run()], { now: T0 + 42_000, width: 110, color: false })
  const lines = frame.split('\n')
  const row = lines.find(line => line.includes('20261114T080000-aaaa'))
  assert.ok(row, 'the run id must appear on its own row')
  assert.match(row, /running/)
  assert.match(row, /5\/80/)
  assert.match(row, /42s/)
  assert.match(row, /1 running · collect pricing/)
  assert.match(row, /9f04c61f/)
  assert.equal(lines.filter(line => line.includes('20261114T080000-aaaa')).length, 1)
})

test('a status transition changes the frame', () => {
  const before = renderFrame([run()], { now: T0 + 30_000, width: 110, color: false })
  const after = renderFrame([
    run({
      status: 'completed',
      finishedAt: '2026-11-14T08:01:00.000Z',
      subtasks: [
        { title: 'collect pricing', status: 'completed', startedAt: '2026-11-14T08:00:10.000Z', finishedAt: '2026-11-14T08:00:50.000Z' },
        { title: 'benchmark queries', status: 'completed', startedAt: '2026-11-14T08:00:10.000Z', finishedAt: '2026-11-14T08:00:55.000Z' },
      ],
    }),
  ], { now: T0 + 60_000, width: 110, color: false })

  assert.notEqual(before, after)
  assert.match(after, /completed/)
  assert.match(after, /report ready · 2\/2 subtasks/)
  assert.match(after, /1m00s/)
  assert.equal(signatureOf([run()]) === signatureOf([run({ status: 'completed' })]), false)
})

test('colour is opt-in, so a piped frame stays plain text', () => {
  const plain = renderFrame([run()], { now: T0 + 5_000, width: 110, color: false })
  const painted = renderFrame([run()], { now: T0 + 5_000, width: 110, color: true })
  assert.equal(plain.includes('\u001b['), false)
  assert.equal(painted.includes('\u001b['), true)
  assert.equal(painted.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').includes('20261114T080000-aaaa'), true)
})

test('rows never exceed the requested width', () => {
  const longGoal = 'x'.repeat(400)
  const frame = renderFrame([
    run({ subtasks: [{ title: longGoal, status: 'running' }, { title: 'b', status: 'pending' }] }),
  ], { now: T0 + 90_000, width: 96, color: false })
  for (const line of frame.split('\n')) {
    assert.ok(line.length <= 96, `line is ${line.length} cells: ${line}`)
  }
})

test('elapsed stops at finishedAt for a finished run and follows now for a live one', () => {
  const finished = run({ status: 'failed', finishedAt: '2026-11-14T08:00:20.000Z' })
  assert.equal(elapsedOf(finished, T0 + 10_000_000), 20_000)
  assert.equal(elapsedOf(run(), T0 + 30_000), 30_000)
})

test('measured usage wins over the spawn counter, and the counter covers unreadable usage', () => {
  assert.equal(callsOf({ usage: { modelCalls: 7 }, counters: { spawns: 3 } }), 7)
  assert.equal(callsOf({ usage: null, counters: { spawns: 4 } }), 4)
})

test('live runs sort before finished ones without reordering among themselves', () => {
  const a = run({ id: '20261114T080000-aaaa', status: 'running' })
  const b = run({ id: '20261114T080001-bbbb', status: 'running', createdAt: '2026-11-14T08:00:01.000Z' })
  const done = run({ id: '20261114T075900-cccc', status: 'completed', finishedAt: '2026-11-14T08:00:05.000Z' })
  assert.deepEqual(orderRuns([done, b, a]).map(entry => entry.id), [a.id, b.id, done.id])
})

test('activities answer "is it stuck?" in one phrase per status', () => {
  assert.match(activityOf(run({ status: 'queued', subtasks: [] })), /slot/)
  assert.match(activityOf(run({ status: 'planning', subtasks: [] })), /planner/)
  assert.match(activityOf(run({ status: 'aggregating' })), /merging 2 report/)
  assert.match(activityOf(run({ status: 'cancelled' })), /cancelled/)
  assert.match(activityOf(run({ status: 'interrupted' })), /resume/)
  assert.match(activityOf(run({ status: 'failed', error: 'boom\nstack line' })), /^boom$/)
})

test('the footer says unpriced instead of claiming a zero spend', () => {
  const frame = renderFrame([run()], { now: T0 + 42_000, width: 110, color: false })
  const footer = frame.split('\n').at(-1)
  assert.match(footer, /cost unpriced/)
  assert.doesNotMatch(footer, /0\.0000/)
})

test('the footer prints the configured currency and keeps its total additive', () => {
  const priced = run({
    status: 'completed',
    finishedAt: '2026-11-14T08:00:40.000Z',
    cost: {
      totalMicros: 101_600,
      total: 0.1016,
      currency: 'CNY',
      byModel: { 'dashscope/qwen-flash': 0.1016 },
      unpriced: [],
      complete: true,
    },
  })
  const footer = renderFrame([priced], { now: T0 + 60_000, width: 110, color: false }).split('\n').at(-1)
  assert.match(footer, /cost ¥0\.1016( |·)/)

  const partial = run({
    status: 'completed',
    finishedAt: '2026-11-14T08:00:40.000Z',
    cost: {
      totalMicros: 101_600,
      total: 0.1016,
      currency: 'CNY',
      byModel: { 'dashscope/qwen-flash': 0.1016 },
      unpriced: ['other/model'],
      complete: false,
    },
  })
  const partialFooter = renderFrame([partial], { now: T0 + 60_000, width: 110, color: false }).split('\n').at(-1)
  assert.match(partialFooter, /cost ¥0\.1016\+/)
})

test('watch --once prints one plain frame and never takes over the screen', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-watch-'))
  const store = createStore(dir)
  await store.init()
  await store.write(run({ createdAt: '2026-11-14T08:00:00.000Z' }))

  const out = fakeStream({ isTTY: true, columns: 110 })
  await watch({ stateDir: dir, out, once: true, intervalMs: 50 })

  assert.equal(out.text.includes('\u001b[?1049h'), false, 'a one-shot frame must not enter the alternate screen')
  assert.equal(out.text.includes('\u001b[?25l'), false, 'a one-shot frame must not hide the cursor')
  assert.match(out.text, /20261114T080000-aaaa/)
  // The frame is left on the normal screen, so the output survives the exit.
  assert.match(out.text, /\n$/)
  await fsp.rm(dir, { recursive: true, force: true })
})

test('Ctrl-C ends a live panel and still restores the terminal', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-watch-'))
  const store = createStore(dir)
  await store.init()
  await store.write(run())

  const out = fakeStream({ isTTY: true, columns: 110 })
  const running = watch({ stateDir: dir, out, intervalMs: 5000 })
  await firstFrame(out)
  process.emit('SIGINT')
  await running
  assert.match(out.text, /\u001b\[\?25h\u001b\[\?1049l$/, 'cleanup is the last write')
  assert.equal(out.frames > 0, true)
  await fsp.rm(dir, { recursive: true, force: true })
})
