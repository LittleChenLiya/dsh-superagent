import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  activityOf,
  callsOf,
  elapsedOf,
  groupingOf,
  orderRuns,
  overlapGroups,
  renderFrame,
  signatureOf,
  waitingOf,
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

test('a mixed-currency footer keeps each currency separate', () => {
  const mixed = run({
    status: 'completed',
    finishedAt: '2026-11-14T08:00:40.000Z',
    cost: {
      totalMicros: null,
      total: null,
      currency: null,
      mixedCurrency: true,
      byCurrency: { CNY: 95_200, USD: 24_800 },
      byModel: { 'dashscope/qwen-flash': 0.0952, 'haoduo/gpt-6.1-sol': 0.0248 },
      unpriced: [],
      complete: true,
    },
  })
  const footer = renderFrame([mixed], { now: T0 + 60_000, width: 140, color: false }).split('\n').at(-1)
  assert.match(footer, /cost ¥0\.0952 \+ \$0\.0248/)
  assert.doesNotMatch(footer, /\$0\.1200/, 'no summed cross-currency figure')
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

/** Every line of a frame, painted or not, must fit the terminal. */
function widthsOf(frame) {
  return frame.split('\n').map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').length)
}

function assertFits(frame, width, label) {
  const widest = Math.max(...widthsOf(frame))
  assert.ok(widest <= width, `${label}: widest line is ${widest} > ${width}`)
}

test('runs alive at the same moment share a gutter group; sequential runs do not', () => {
  const first = run({ id: '20261114T080000-aaaa', createdAt: '2026-11-14T08:00:00.000Z' })
  const second = run({ id: '20261114T080010-bbbb', createdAt: '2026-11-14T08:00:10.000Z' })
  const earlier = run({
    id: '20261114T070000-cccc',
    status: 'completed',
    createdAt: '2026-11-14T07:00:00.000Z',
    startedAt: '2026-11-14T07:00:00.000Z',
    finishedAt: '2026-11-14T07:10:00.000Z',
  })
  const groups = overlapGroups([earlier, first, second], T0 + 60_000)
  assert.deepEqual(groups.map(group => group.map(entry => entry.id)), [
    ['20261114T070000-cccc'],
    ['20261114T080000-aaaa', '20261114T080010-bbbb'],
  ], 'the two live runs overlap; the finished one is alone')

  const labels = groupingOf([earlier, first, second], T0 + 60_000)
  assert.equal(labels.get(first.id).label, labels.get(second.id).label)
  assert.equal(labels.get(first.id).size, 2)
  assert.equal(labels.has(earlier.id), false, 'a lone run wastes no gutter cells')

  const frame = renderFrame([first, second, earlier], { now: T0 + 60_000, width: 110, color: false })
  assert.equal(frame.split('▐1').length - 1, 2, 'both members of the group carry the same marker')
  assert.match(frame, /overlapping/)
})

test('a queued run names the slot holders, its queue position, and nothing it cannot see', () => {
  const holderA = run({ id: '20261114T080000-aaaa' })
  const holderB = run({ id: '20261114T080020-bbbb', createdAt: '2026-11-14T08:00:20.000Z' })
  const waitingOne = run({
    id: '20261114T080040-cccc',
    status: 'queued',
    createdAt: '2026-11-14T08:00:40.000Z',
    startedAt: '2026-11-14T08:00:40.000Z',
    subtasks: [],
  })
  const waitingTwo = run({
    id: '20261114T080050-dddd',
    status: 'queued',
    createdAt: '2026-11-14T08:00:50.000Z',
    startedAt: '2026-11-14T08:00:50.000Z',
    subtasks: [],
  })
  const runs = [holderA, holderB, waitingOne, waitingTwo]
  const first = waitingOf(waitingOne, { runs, now: T0 + 60_000 })
  const second = waitingOf(waitingTwo, { runs, now: T0 + 60_000 })
  assert.equal(first.kind, 'slot')
  assert.match(first.text, /2 active/)
  assert.match(first.text, /aaaa,bbbb/)
  assert.equal(first.text.includes('#1'), false, 'the head of the queue is not given a position number')
  assert.match(second.text, /#2/)

  const frame = renderFrame(runs, { now: T0 + 60_000, width: 130, color: false })
  const row = frame.split('\n').find(line => line.includes('20261114T080050-dddd'))
  assert.match(row, /slot ← aaaa,bbbb/)
  assert.match(row, /2 active/)
  assert.match(row, /#2/)

  const alone = waitingOf(waitingOne, { runs: [waitingOne], now: T0 + 60_000 })
  assert.equal(alone.text, 'waiting on a slot', 'with no active run there is nobody to blame')
  assert.equal(waitingOf(holderA, { runs, now: T0 + 60_000 }), null, 'a running run with a free pool is not blocked')
})

test('the panel separates a retry backoff from a full worker pool', () => {
  const backingOff = run({
    limits: { maxModelCalls: 80, maxParallel: 2, attempts: 3 },
    subtasks: [
      { title: 'collect pricing', status: 'pending', attempts: 2 },
      { title: 'benchmark queries', status: 'running', attempts: 1 },
    ],
  })
  assert.deepEqual(waitingOf(backingOff, { now: T0 }), { kind: 'retry', text: 'retry 2/3 backoff' })

  const poolFull = run({
    limits: { maxModelCalls: 80, maxParallel: 1, attempts: 3 },
    subtasks: [
      { title: 'collect pricing', status: 'running', attempts: 1 },
      { title: 'benchmark queries', status: 'pending', attempts: 0 },
    ],
  })
  const reason = waitingOf(poolFull, { now: T0 })
  assert.equal(reason.kind, 'parallel')
  assert.match(reason.text, /1\/1/)
  assert.match(reason.text, /1 waiting/)

  const frame = renderFrame([poolFull], { now: T0 + 30_000, width: 160, color: false })
  const row = frame.split('\n').find(line => line.includes('20261114T080000-aaaa'))
  assert.match(row, /worker pool full 1\/1 · 1 waiting · 1 running · collect pricing/)
})

test('no run, one run, and many runs all fit a narrow terminal', () => {
  const many = Array.from({ length: 60 }, (_, index) => run({
    id: `20261114T08${String(index).padStart(4, '0')}-m${String(index).padStart(3, '0')}`,
    status: index % 9 === 0 ? 'failed' : index % 5 === 0 ? 'queued' : 'completed',
    createdAt: new Date(T0 + index * 1000).toISOString(),
    startedAt: new Date(T0 + index * 1000).toISOString(),
    finishedAt: new Date(T0 + index * 1000 + 4000).toISOString(),
    error: index % 9 === 0 ? 'child stopped with reason "refused"' : null,
    subtasks: [{ title: `worker ${index} with a deliberately long title`, status: 'completed' }],
  }))

  const cases = [
    ['no runs', []],
    ['one run', [run()]],
    ['many runs', many],
  ]
  for (const [label, runs] of cases) {
    for (const width of [24, 32, 40, 48, 60, 72, 88, 96, 100, 120, 160]) {
      for (const color of [false, true]) {
        assertFits(renderFrame(runs, { now: T0 + 300_000, width, color }), width, `${label} at ${width}`)
      }
    }
  }
})

test('a terminal too narrow for a table stacks activity under each run', () => {
  const frame = renderFrame([run()], { now: T0 + 42_000, width: 30, color: false })
  const lines = frame.split('\n')
  assert.equal(lines.some(line => line.includes('ACTIVITY')), false, 'no header survives at 30 cells')
  assert.ok(lines.some(line => /└ 1 running · collect/.test(line)), 'the reason sits on its own line')
  assert.ok(lines.some(line => /aaaa/.test(line)), 'the id tail survives, so rows stay distinguishable')
  assertFits(frame, 30, 'single run at 30')
})

test('a live panel stops at the terminal height while a one-shot frame keeps every row', () => {
  const many = Array.from({ length: 80 }, (_, index) => run({
    id: `20261114T0800${String(index).padStart(2, '0')}-x${String(index).padStart(3, '0')}`,
    status: 'completed',
    createdAt: new Date(T0 + index * 1000).toISOString(),
    finishedAt: new Date(T0 + index * 1000 + 500).toISOString(),
  }))
  const capped = renderFrame(many, { now: T0 + 300_000, width: 100, rows: 20, color: false })
  assert.ok(capped.split('\n').length <= 20, `live frame is ${capped.split('\n').length} lines`)
  assert.match(capped, /more run\(s\)/)
  assert.match(capped, /66 more/, 'six lines of chrome leave 14 of the 80 runs')

  const full = renderFrame(many, { now: T0 + 300_000, width: 100, color: false })
  assert.equal(full.includes('more run(s)'), false)
  assert.equal(full.split('\n').filter(line => line.includes('20261114T0800')).length, 80)
})

test('the empty panel and its state path are clipped, not wrapped', () => {
  const frame = renderFrame([], {
    now: T0,
    width: 34,
    color: false,
    stateRoot: 'C:\\Users\\someone-with-a-long-name\\.dsh\\state\\superagent',
  })
  assertFits(frame, 34, 'empty state at 34')
  assert.match(frame, /no runs recorded yet/)
  assert.match(frame, /state: C:/)
  assert.equal(frame.endsWith('\n'), false)
})
