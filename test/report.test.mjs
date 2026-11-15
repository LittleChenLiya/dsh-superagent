import assert from 'node:assert/strict'
import test from 'node:test'

import { applyCost } from '../lib/cost.js'
import { assignLanes, buildReport, escapeHtml, phasesOf, prepare } from '../lib/report.js'

function run(overrides = {}) {
  return {
    id: '20261114T080000-aaaa',
    status: 'completed',
    goal: 'compare three vector databases',
    parentSessionId: 'session-9f04c61f-2c4a-4a1a-9d3f-000000000000',
    createdAt: '2026-11-14T08:00:00.000Z',
    startedAt: '2026-11-14T08:00:00.000Z',
    finishedAt: '2026-11-14T08:00:30.000Z',
    limits: { maxModelCalls: 80 },
    usage: { modelCalls: 4, totalTokens: 1770, inputTokens: 1420, outputTokens: 350 },
    cost: { total: 0.02248, currency: 'USD', byModel: {}, unpriced: [], complete: true },
    subtasks: [
      { title: 'collect pricing', status: 'completed', startedAt: '2026-11-14T08:00:08.000Z', finishedAt: '2026-11-14T08:00:20.000Z' },
      { title: 'benchmark queries', status: 'completed', startedAt: '2026-11-14T08:00:10.000Z', finishedAt: '2026-11-14T08:00:26.000Z' },
    ],
    ...overrides,
  }
}

const RUNS = [
  run(),
  run({
    id: '20261114T080010-bbbb',
    status: 'completed',
    startedAt: '2026-11-14T08:00:10.000Z',
    createdAt: '2026-11-14T08:00:10.000Z',
    finishedAt: '2026-11-14T08:00:40.000Z',
    usage: { modelCalls: 5, totalTokens: 2200 },
    cost: { total: 0.031, currency: 'USD', byModel: {}, unpriced: [], complete: true },
  }),
  run({
    id: '20261114T080100-cccc',
    status: 'failed',
    startedAt: '2026-11-14T08:01:00.000Z',
    createdAt: '2026-11-14T08:01:00.000Z',
    finishedAt: '2026-11-14T08:01:02.000Z',
    usage: { modelCalls: 1, totalTokens: 150 },
    cost: { total: 0.0018, currency: 'USD', byModel: {}, unpriced: [], complete: true },
    error: 'planner returned no JSON: <script>alert(1)</script>',
    subtasks: [],
  }),
  run({
    id: '20261114T080110-dddd',
    status: 'cancelled',
    startedAt: '2026-11-14T08:01:10.000Z',
    createdAt: '2026-11-14T08:01:10.000Z',
    finishedAt: '2026-11-14T08:02:00.000Z',
    usage: { modelCalls: 2, totalTokens: 650 },
    cost: { total: 0.00844, currency: 'USD', byModel: {}, unpriced: [], complete: true },
  }),
  run({
    id: '20261114T080210-eeee',
    status: 'interrupted',
    startedAt: '2026-11-14T08:02:10.000Z',
    createdAt: '2026-11-14T08:02:10.000Z',
    finishedAt: '2026-11-14T08:02:30.000Z',
    usage: { modelCalls: 3, totalTokens: 900 },
    cost: { total: 0, currency: 'USD', byModel: {}, unpriced: ['stub/model'], complete: false },
  }),
]

const NOW = Date.parse('2026-11-14T09:00:00.000Z')

test('the report is one file with no external references', () => {
  const html = buildReport(RUNS, { now: NOW, generatedAt: NOW })
  for (const forbidden of ['http://', 'https://', '<script', '<link', 'src=', '@import', 'url(', '<iframe']) {
    assert.equal(html.includes(forbidden), false, `must not reference ${forbidden}`)
  }
  assert.match(html, /<style>/, 'CSS is inline')
  assert.match(html, /<svg /, 'charts are inline SVG')
  assert.match(html, /^<!doctype html>/)
})

test('the page carries every promised section', () => {
  const html = buildReport(RUNS, { now: NOW, generatedAt: NOW })
  for (const id of ['timeline', 'lanes', 'calls', 'cost', 'failures', 'runs']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing section ${id}`)
  }
  assert.match(html, /Run timeline/)
  assert.match(html, /Concurrency swimlanes/)
  assert.match(html, /Failures &amp; cancellations/)
})

test('every run appears in the timeline and the table', () => {
  const html = buildReport(RUNS, { now: NOW, generatedAt: NOW })
  for (const entry of RUNS) {
    const occurrences = html.split(entry.id).length - 1
    assert.ok(occurrences >= 2, `${entry.id} should appear in the timeline and the table`)
  }
})

test('failure, cancellation and interruption are annotated, not just coloured', () => {
  const html = buildReport(RUNS, { now: NOW, generatedAt: NOW })
  assert.match(html, /✕ failed/)
  assert.match(html, /⊘ cancelled/)
  assert.match(html, /! interrupted/)
  assert.match(html, /planner returned no JSON: &lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /Cancelled after 50s, 2 call\(s\) spent\./)
  assert.match(html, /superagent_resume/)
})

test('host text is escaped everywhere it is inserted', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;')
  const html = buildReport([run({ goal: '<img src=x onerror=alert(1)>' })], { now: NOW, generatedAt: NOW })
  assert.equal(html.includes('<img'), false)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('cost totals exclude runs the plugin could not price, and say so', () => {
  const html = buildReport(RUNS, { now: NOW, generatedAt: NOW })
  assert.match(html, /Cost covers 4 of 5 runs/)
  assert.match(html, /\$0\.0637/, 'the priced total is 0.02248 + 0.031 + 0.0018 + 0.00844')
})

test('phases are derived from subtask timestamps', () => {
  const phases = phasesOf(run(), NOW)
  assert.deepEqual(phases.map(phase => phase.kind), ['plan', 'work', 'merge'])
  assert.equal(phases[0].start, Date.parse('2026-11-14T08:00:00.000Z'))
  assert.equal(phases[0].end, Date.parse('2026-11-14T08:00:08.000Z'), 'planning ends at the first worker start')
  assert.equal(phases[1].end, Date.parse('2026-11-14T08:00:26.000Z'), 'work ends at the last worker finish')
  assert.equal(phases[2].end, Date.parse('2026-11-14T08:00:30.000Z'), 'merge runs to the run finish')
})

test('lanes are the peak concurrency: overlapping runs never share one', () => {
  const items = prepare(RUNS, NOW)
  const lanes = assignLanes(items)
  assert.equal(lanes, 2, 'runs 1 and 2 overlap; the rest are sequential')
  const first = items.find(item => item.id === '20261114T080000-aaaa')
  const second = items.find(item => item.id === '20261114T080010-bbbb')
  const third = items.find(item => item.id === '20261114T080100-cccc')
  assert.notEqual(first.lane, second.lane)
  assert.equal(first.lane, third.lane, 'a lane is reused once the earlier run has ended')
})

test('subtask spend is shown per subtask, and an unpriced one is named', () => {
  const withSubtasks = run({
    usage: {
      modelCalls: 2,
      totalTokens: 1_010_000,
      inputTokens: 1_000_000,
      outputTokens: 10_000,
      models: {
        'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
        'mystery/model': { inputTokens: 0, outputTokens: 10_000, cacheReadTokens: 0, calls: 1 },
      },
    },
    subtasks: [
      {
        index: 1,
        title: 'worker A',
        status: 'completed',
        startedAt: '2026-11-14T08:00:08.000Z',
        finishedAt: '2026-11-14T08:00:20.000Z',
        usage: {
          modelCalls: 1,
          models: { 'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 } },
        },
      },
      {
        index: 2,
        title: 'worker B',
        status: 'completed',
        startedAt: '2026-11-14T08:00:10.000Z',
        finishedAt: '2026-11-14T08:00:26.000Z',
        usage: {
          modelCalls: 1,
          models: { 'mystery/model': { inputTokens: 0, outputTokens: 10_000, cacheReadTokens: 0, calls: 1 } },
        },
      },
    ],
  })
  applyCost(withSubtasks, {
    'dashscope/qwen-flash': { input: 0.15, output: 1.5, cacheRead: 0.03, currency: 'CNY' },
  })
  const html = buildReport([withSubtasks], { now: NOW, generatedAt: NOW })

  assert.match(html, /id="subtasks"/)
  assert.match(html, /worker A/)
  assert.match(html, /worker B/)
  assert.match(html, /¥0\.1500/, 'the priced worker shows its own amount')
  assert.match(html, /unpriced/, 'the unpriced worker is named, not shown as zero')
})

test('an empty store still produces a valid, readable page', () => {
  const html = buildReport([], { now: NOW, generatedAt: NOW })
  assert.match(html, /0 runs/)
  assert.match(html, /no priced runs/)
  assert.match(html, /no model calls recorded/)
  assert.match(html, /<\/html>/)
})
