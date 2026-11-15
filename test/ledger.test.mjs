import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyCost } from '../lib/cost.js'
import { createLedger } from '../lib/ledger.js'

const PRICES = {
  'dashscope/qwen-flash': { input: 0.15, output: 1.5, cacheRead: 0.03, currency: 'CNY' },
}

function run({ id, finishedAt, status = 'completed', inputTokens = 1_000_000, model = 'dashscope/qwen-flash', cacheReadTokens = 0, pricing = PRICES }) {
  const record = {
    id,
    status,
    finishedAt,
    usage: {
      modelCalls: 1,
      totalTokens: inputTokens + cacheReadTokens,
      inputTokens,
      outputTokens: 0,
      cacheReadTokens,
      models: { [model]: { inputTokens, outputTokens: 0, cacheReadTokens, calls: 1 } },
    },
    subtasks: [{ index: 1, usage: null }],
  }
  applyCost(record, pricing)
  return record
}

async function ledgerIn(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-ledger-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return createLedger(dir)
}

test('a terminal run is appended once, with its unit prices and amount', async t => {
  const ledger = await ledgerIn(t)
  const first = run({ id: '20261115T010000-aaaa', finishedAt: '2026-11-15T01:00:00.000Z' })

  assert.equal(await ledger.record(first), true)
  assert.equal(await ledger.record(first), false, 'the same snapshot must not be appended twice')
  assert.equal(await ledger.record({ ...first, id: 'active-run', status: 'running' }), false)
  assert.equal(await ledger.record({ id: 'no-cost', status: 'completed', usage: { modelCalls: 1, models: {} } }), false)

  const lines = (await fsp.readFile(ledger.file, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.runId, first.id)
  assert.equal(entry.currency, 'CNY')
  assert.equal(entry.totalMicros, 150_000)
  assert.equal(entry.models[0].inputPrice, 0.15)
  assert.equal(entry.models[0].cachePrice, 0.03)
  assert.equal(entry.models[0].amountMicros, 150_000)
})

test('a mixed-currency run is stored and summarised per currency', async t => {
  const ledger = await ledgerIn(t)
  const record = {
    id: '20261115T020000-bbbb',
    status: 'completed',
    finishedAt: '2026-11-15T02:00:00.000Z',
    usage: {
      modelCalls: 2,
      models: {
        'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
        'haoduo/gpt-6.1-sol': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
      },
    },
    subtasks: [],
  }
  applyCost(record, {
    'dashscope/qwen-flash': { input: 0.0952, output: 0, currency: 'CNY' },
    'haoduo/gpt-6.1-sol': { input: 0.0248, output: 0, currency: 'USD' },
  })

  assert.equal(await ledger.record(record), true)
  const entry = (await ledger.read())[0]
  assert.deepEqual(entry.byCurrency, { CNY: 95_200, USD: 24_800 })
  assert.equal(entry.totalMicros, null)
  assert.equal(entry.currency, null)

  const summary = await ledger.summarize()
  assert.deepEqual(summary.byCurrency, { CNY: 95_200, USD: 24_800 })
  assert.equal(summary.totalMicros, null)
  assert.equal(summary.total, null)
  assert.equal(summary.mixedCurrency, true)
})

test('the summary respects a time range and keeps integer totals', async t => {
  const ledger = await ledgerIn(t)
  await ledger.record(run({ id: 'day-1', finishedAt: '2026-11-14T01:00:00.000Z' }))
  await ledger.record(run({ id: 'day-2', finishedAt: '2026-11-15T01:00:00.000Z', inputTokens: 2_000_000 }))

  const all = await ledger.summarize()
  assert.equal(all.runs, 2)
  assert.equal(all.totalMicros, 450_000)
  assert.equal(all.total, 0.45)
  assert.equal(all.priced, 2)
  assert.equal(all.byModel['dashscope/qwen-flash'].inputTokens, 3_000_000)

  const since = await ledger.summarize({ since: '2026-11-15T00:00:00.000Z' })
  assert.equal(since.runs, 1)
  assert.equal(since.totalMicros, 300_000)
  assert.equal(since.start, Date.parse('2026-11-15T01:00:00.000Z'))

  const until = await ledger.summarize({ until: '2026-11-14T23:59:59.000Z' })
  assert.equal(until.runs, 1)
  assert.equal(until.totalMicros, 150_000)
})

test('history stays readable after the price table is gone', async t => {
  const ledger = await ledgerIn(t)
  await ledger.record(run({ id: 'priced-then-unpriced', finishedAt: '2026-11-15T02:00:00.000Z' }))

  // The ledger API has no pricing parameter at all: a later run priced with an
  // empty table (or a changed table) cannot rewrite what was already spent.
  const repriced = run({ id: 'priced-then-unpriced', finishedAt: '2026-11-15T02:00:00.000Z', pricing: {} })
  assert.equal(repriced.cost.complete, false)
  const summary = await ledger.summarize()
  assert.equal(summary.runs, 1)
  assert.equal(summary.totalMicros, 150_000)
  assert.equal(summary.unpricedRuns, 0)

  const entries = await ledger.read()
  assert.equal(entries[0].models[0].inputPrice, 0.15)
})

test('an unpriced run is recorded but never contributes a fabricated amount', async t => {
  const ledger = await ledgerIn(t)
  await ledger.record(run({
    id: 'mystery',
    finishedAt: '2026-11-15T03:00:00.000Z',
    model: 'mystery/model',
  }))

  const summary = await ledger.summarize()
  assert.equal(summary.runs, 1)
  assert.equal(summary.priced, 0)
  assert.equal(summary.unpricedRuns, 1)
  assert.equal(summary.totalMicros, 0)
  const entry = (await ledger.read())[0]
  assert.deepEqual(entry.unpriced, ['mystery/model'])
  assert.equal(entry.models[0].amountMicros, null)
})

test('a resumed run replaces its earlier line in the summary', async t => {
  const ledger = await ledgerIn(t)
  const before = run({ id: 'resumed', finishedAt: '2026-11-15T04:00:00.000Z' })
  await ledger.record(before)

  const after = run({ id: 'resumed', finishedAt: '2026-11-15T05:00:00.000Z', inputTokens: 3_000_000 })
  assert.equal(await ledger.record(after), true, 'a changed snapshot is appended')

  const summary = await ledger.summarize()
  assert.equal(summary.runs, 1, 'the run is counted once, at its latest figure')
  assert.equal(summary.totalMicros, 450_000)
  assert.equal(summary.start, Date.parse('2026-11-15T05:00:00.000Z'))
})

test('a torn trailing line does not hide the readable history', async t => {
  const ledger = await ledgerIn(t)
  await ledger.record(run({ id: 'good', finishedAt: '2026-11-15T06:00:00.000Z' }))
  await fsp.appendFile(ledger.file, '{"runId":"torn"\n', 'utf8')

  const summary = await ledger.summarize()
  assert.equal(summary.runs, 1)
  assert.equal(summary.totalMicros, 150_000)
})
