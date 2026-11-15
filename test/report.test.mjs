import assert from 'node:assert/strict'
import test from 'node:test'

import { assignLanes, buildReport, escapeHtml, phasesOf, prepare, retryChainsOf, workerShares } from '../lib/report.js'

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

test('an empty store still produces a valid, readable page', () => {
  const html = buildReport([], { now: NOW, generatedAt: NOW })
  assert.match(html, /0 runs/)
  assert.match(html, /no priced runs/)
  assert.match(html, /no model calls recorded/)
  assert.match(html, /<\/html>/)
})

test('retries and worker shares have their own sections and say so when empty', () => {
  const html = buildReport([run()], { now: NOW, generatedAt: NOW })
  for (const id of ['retries', 'workers']) {
    assert.match(html, new RegExp(`id="${id}"`), `missing section ${id}`)
  }
  assert.match(html, /Failure &amp; retry chains/)
  assert.match(html, /Worker time share/)
  assert.match(html, /No retries and no failed workers in this window/)
  assert.match(html, /wall 30s · workers busy 28s/)

  const empty = buildReport([], { now: NOW, generatedAt: NOW })
  assert.match(empty, /No retries and no failed workers in this window/)
  assert.match(empty, /No worker timings recorded/)
})

test('a retry chain counts every attempt and states the final outcome', () => {
  const recovered = run({
    status: 'completed',
    limits: { maxModelCalls: 80, attempts: 3 },
    subtasks: [
      { index: 1, title: 'collect pricing', status: 'completed', attempts: 3, startedAt: '2026-11-14T08:00:08.000Z', finishedAt: '2026-11-14T08:00:20.000Z', error: 'rate limited' },
      { index: 2, title: 'benchmark queries', status: 'completed', attempts: 1, startedAt: '2026-11-14T08:00:10.000Z', finishedAt: '2026-11-14T08:00:26.000Z' },
    ],
  })
  const chains = retryChainsOf(recovered)
  assert.equal(chains.length, 1, 'a worker that finished first try is not a chain')
  assert.equal(chains[0].attempts, 3)
  assert.equal(chains[0].recovered, true)

  const html = buildReport([recovered], { now: NOW, generatedAt: NOW })
  assert.match(html, /1 worker · 3 attempts/)
  assert.match(html, /recovered on attempt 3/)
  assert.equal(html.split('class="step').length - 1, 3, 'one step per attempt')
  assert.match(html, /<span class="step bad">1 ✕<\/span><span class="arrow">→<\/span><span class="step bad">2 ✕<\/span><span class="arrow">→<\/span><span class="step ok">3 ✓<\/span>/)
  assert.match(html, /rate limited/)

  const failed = run({
    status: 'failed',
    error: 'no worker produced a report',
    limits: { maxModelCalls: 80, attempts: 2 },
    subtasks: [
      { index: 1, title: 'collect pricing', status: 'failed', attempts: 2, startedAt: '2026-11-14T08:00:08.000Z', finishedAt: '2026-11-14T08:00:20.000Z', error: 'child stopped with reason "refused"' },
    ],
  })
  const failedHtml = buildReport([failed], { now: NOW, generatedAt: NOW })
  assert.match(failedHtml, /failed after 2 attempts/)
  assert.match(failedHtml, /child stopped with reason &quot;refused&quot;/)
})

test('a self-heal round is named, with its model and recovery count', () => {
  const healed = run({
    status: 'partial',
    selfHeal: { rounds: 1, retried: 2, recovered: 1, model: 'fallback/model-x' },
    limits: { maxModelCalls: 80, attempts: 2 },
    subtasks: [
      { index: 1, title: 'collect pricing', status: 'completed', attempts: 1, startedAt: '2026-11-14T08:00:08.000Z', finishedAt: '2026-11-14T08:00:20.000Z' },
      { index: 2, title: 'benchmark queries', status: 'failed', attempts: 2, startedAt: '2026-11-14T08:00:10.000Z', finishedAt: '2026-11-14T08:00:26.000Z', error: '429 quota' },
    ],
  })
  const html = buildReport([healed], { now: NOW, generatedAt: NOW })
  assert.match(html, /self-heal round 1 · retried 2 · recovered 1 · on <code>fallback\/model-x<\/code>/)
  assert.match(html, /429 quota/)
  assert.match(html, /resets a worker's attempt counter/)
})

test('worker shares are measured against the run wall clock, not against each other', () => {
  const item = prepare([run()], NOW)[0]
  const shares = workerShares(item, NOW)
  assert.equal(shares.wall, 30_000)
  assert.equal(shares.workers.length, 2)
  assert.equal(shares.workers[0].span, 12_000)
  assert.equal(shares.workers[1].span, 16_000)
  assert.equal(shares.busy, 28_000)
  assert.equal(shares.parallelism.toFixed(2), '0.93')

  const html = buildReport([run()], { now: NOW, generatedAt: NOW })
  assert.match(html, /40%/)
  assert.match(html, /53%/)
  assert.match(html, /0\.93× parallel/)
  assert.match(html, /wall 30s · workers busy 28s/)
})

test('worker shares use every subtask and cap the list without losing the bar', () => {
  const busy = run({
    id: '20261114T080100-busy',
    status: 'running',
    finishedAt: null,
    startedAt: '2026-11-14T08:01:00.000Z',
    createdAt: '2026-11-14T08:01:00.000Z',
    limits: { maxModelCalls: 80, attempts: 2 },
    subtasks: Array.from({ length: 8 }, (_, index) => ({
      index: index + 1,
      title: `worker ${index + 1}`,
      status: index < 6 ? 'completed' : index === 6 ? 'running' : 'failed',
      attempts: 1,
      startedAt: new Date(NOW - 100_000 + index * 1000).toISOString(),
      finishedAt: index < 7 ? new Date(NOW - 20_000 + index * 1000).toISOString() : new Date(NOW - 5_000).toISOString(),
    })),
  })
  const item = prepare([busy], NOW)[0]
  const shares = workerShares(item, NOW)
  assert.equal(shares.workers.length, 8)
  assert.ok(shares.workers.every(worker => worker.span > 0))

  const html = buildReport([busy], { now: NOW, generatedAt: NOW })
  assert.match(html, /\+2 more workers in the bar above/)
  assert.equal(html.split('<rect x="').length - 1 >= 6, true, 'the bar still carries every segment')
})

test('a long window with many retries is capped and labelled', () => {
  const many = Array.from({ length: 15 }, (_, index) => run({
    id: `20261114T08${String(index).padStart(4, '0')}-r${String(index).padStart(3, '0')}`,
    status: 'failed',
    startedAt: new Date(Date.parse('2026-11-14T08:00:00.000Z') + index * 60_000).toISOString(),
    createdAt: new Date(Date.parse('2026-11-14T08:00:00.000Z') + index * 60_000).toISOString(),
    finishedAt: new Date(Date.parse('2026-11-14T08:00:30.000Z') + index * 60_000).toISOString(),
    limits: { maxModelCalls: 80, attempts: 2 },
    subtasks: [{ index: 1, title: 'collect pricing', status: 'failed', attempts: 2, error: 'boom' }],
  }))
  const html = buildReport(many, { now: NOW, generatedAt: NOW })
  assert.match(html, /Showing the 12 most recent runs with retries or failures/)
  assert.equal(html.split('class="retry"').length - 1, 12, 'the chain list is bounded')
})

test('worker titles and errors are escaped in the new sections', () => {
  const hostile = run({
    status: 'failed',
    limits: { maxModelCalls: 80, attempts: 2 },
    subtasks: [{
      index: 1,
      title: '<img src=x onerror=alert(1)>',
      status: 'failed',
      attempts: 2,
      startedAt: '2026-11-14T08:00:08.000Z',
      finishedAt: '2026-11-14T08:00:20.000Z',
      error: '<script>alert(2)</script>',
    }],
  })
  const html = buildReport([hostile], { now: NOW, generatedAt: NOW })
  assert.equal(html.includes('<img'), false)
  assert.equal(html.includes('<script'), false)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/)
})
