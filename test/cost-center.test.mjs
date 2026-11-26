import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyCost } from '../lib/cost.js'
import { createCostCenter, estimateCost } from '../lib/cost-center.js'
import { createLedger } from '../lib/ledger.js'

const PRICES = {
  'local/small': { input: 0.15, output: 1.5, cacheRead: 0.03, currency: 'CNY' },
  'cloud/large': { input: 0.0248, output: 0.1, currency: 'USD' },
}

function pricedRun(id, model = 'local/small', inputTokens = 1_000_000, extra = {}) {
  const run = {
    id,
    status: 'completed',
    createdAt: '2026-11-20T00:00:00.000Z',
    finishedAt: '2026-11-20T00:01:00.000Z',
    usage: { modelCalls: 1, models: { [model]: { calls: 1, inputTokens, outputTokens: 0, cacheReadTokens: 0 } } },
    subtasks: [],
    ...extra,
  }
  applyCost(run, PRICES)
  return run
}

async function centerIn(t, budgets = { CNY: 1_000_000, USD: 1_000_000 }, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-cost-center-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return { root, center: createCostCenter(root, { pricing: PRICES, budgets, lockRetries: 200, ...options }) }
}

async function saveRun(root, run) {
  await fsp.mkdir(path.join(root, 'runs'), { recursive: true })
  await fsp.writeFile(path.join(root, 'runs', `${run.id}.json`), JSON.stringify(run), 'utf8')
}

test('estimates use integer half-up rounding and never turn a missing price into zero', () => {
  const estimate = estimateCost({ provider: 'local', model: 'small', pricing: PRICES,
    inputTokens: 5, outputTokens: 1, cacheReadTokens: 1 })
  // input: .75 -> 1 micro; output: 1.5 -> 2; cache: .03 -> 0.
  assert.equal(estimate.status, 'priced')
  assert.equal(estimate.estimatedMicros, 3)
  assert.equal(estimate.currency, 'CNY')
  assert.ok(Number.isSafeInteger(estimate.estimatedMicros))

  const missing = estimateCost({ provider: 'unknown', model: 'model', pricing: PRICES, inputTokens: 100 })
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 'missing-price')
  assert.equal(missing.estimatedMicros, null)
  assert.equal(missing.currency, null)
})

test('aggregation reports tokens and integer costs by model and currency without adding currencies', async t => {
  const { center } = await centerIn(t)
  const mixed = pricedRun('mixed', 'local/small', 1_000_000)
  mixed.usage.modelCalls = 2
  mixed.usage.models['cloud/large'] = { calls: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
  applyCost(mixed, PRICES)
  const summary = await center.aggregate({ runs: [mixed, pricedRun('other', 'local/small', 2_000_000)] })

  assert.equal(summary.complete, true)
  assert.equal(summary.mixedCurrency, true)
  assert.equal(summary.totalMicros, null, 'there is no cross-currency total')
  assert.deepEqual(summary.byCurrency, { CNY: 450_000, USD: 24_800 })
  assert.deepEqual(summary.byModelCurrency['local/small'], { CNY: {
    calls: 2, inputTokens: 3_000_000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 3_000_000, amountMicros: 450_000,
  } })
  assert.deepEqual(summary.byModelCurrency['cloud/large'], { USD: {
    calls: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1_000_000, amountMicros: 24_800,
  } })
  assert.equal(summary.byModel['local/small'].inputTokens, 3_000_000)
  assert.equal(summary.byModel['local/small'].calls, 2)
  assert.deepEqual(summary.unpriced, [])
})

test('unknown model tokens remain visible while the known subtotal is only a lower bound', async t => {
  const { center } = await centerIn(t)
  const run = pricedRun('partial')
  run.usage.modelCalls = 2
  run.usage.models['mystery/model'] = { calls: 1, inputTokens: 11, outputTokens: 7, cacheReadTokens: 3 }
  applyCost(run, PRICES)
  const summary = await center.aggregate({ runs: [run] })

  assert.equal(summary.complete, false)
  assert.equal(summary.totalMicros, null)
  assert.deepEqual(summary.byCurrency, { CNY: 150_000 })
  assert.equal(summary.byModel['mystery/model'].amountMicros, null)
  assert.equal(summary.byModel['mystery/model'].totalTokens, 21)
  assert.deepEqual(summary.unpriced, ['mystery/model'])
  assert.match(summary.unpricedItems[0].reason, /no usable price/)
})

test('ledger fills archived runs but a current run is never counted twice', async t => {
  const { root, center } = await centerIn(t)
  const ledger = createLedger(root)
  const archived = pricedRun('archived', 'cloud/large', 1_000_000)
  assert.equal(await ledger.record(archived), true)
  const current = pricedRun('current', 'local/small', 2_000_000)
  assert.equal(await ledger.record(current), true)

  const summary = await center.aggregate({ runs: [current], ledger })
  assert.equal(summary.runs, 2)
  assert.equal(summary.byModel['local/small'].inputTokens, 2_000_000)
  assert.equal(summary.byModel['cloud/large'].amountMicros, 24_800)
  assert.deepEqual(summary.byCurrency, { CNY: 300_000, USD: 24_800 })
})

test('budget reserve, check and cancellation release use exact micro-units', async t => {
  const { center } = await centerIn(t, { CNY: 100 })
  const reserved = await center.reserve({ reservationId: 'r1', currency: 'CNY', amountMicros: 60 })
  assert.equal(reserved.status, 'reserved')
  assert.equal(reserved.remainingMicros, 40)

  const replay = await center.reserve({ reservationId: 'r1', currency: 'CNY', amountMicros: 60 })
  assert.equal(replay.replayed, true)
  assert.equal(replay.reservation.amountMicros, 60)
  const conflict = await center.reserve({ reservationId: 'r1', currency: 'CNY', amountMicros: 61 })
  assert.equal(conflict.status, 'reservation-conflict')

  const checked = await center.check({ currency: 'CNY', amountMicros: 40 })
  assert.equal(checked.ok, true)
  assert.equal(checked.spentMicros, 0)
  assert.equal(checked.reservedMicros, 60)
  const denied = await center.check({ currency: 'CNY', amountMicros: 41 })
  assert.equal(denied.status, 'insufficient-budget')

  const released = await center.release({ reservationId: 'r1' })
  assert.equal(released.refundMicros, 60)
  assert.equal((await center.check({ currency: 'CNY', amountMicros: 100 })).ok, true)
  assert.equal((await center.release('r1')).replayed, true)
  assert.equal((await center.release('r1')).refundMicros, 0)
})

test('concurrent callers cannot over-reserve the same budget', async t => {
  const { center } = await centerIn(t, { CNY: 100 })
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    center.reserve({ reservationId: `reserve-${index}`, currency: 'CNY', amountMicros: 60 })))

  assert.equal(results.filter(result => result.status === 'reserved').length, 1)
  assert.equal(results.filter(result => result.status === 'insufficient-budget').length, 11)
  const checked = await center.check({ currency: 'CNY', amountMicros: 0 })
  assert.equal(checked.reservedMicros, 60)
  assert.equal(checked.remainingMicros, 40)
})

test('separate processes share the reservation lock and budget', async t => {
  const { root } = await centerIn(t, { CNY: 100 })
  const moduleUrl = new URL('../lib/cost-center.js', import.meta.url).href
  const script = `
    import { createCostCenter } from ${JSON.stringify(moduleUrl)};
    const center = createCostCenter(${JSON.stringify(root)}, { budgets: { CNY: 100 }, lockRetries: 500 });
    const result = await center.reserve({ reservationId: process.argv[1], currency: 'CNY', amountMicros: 60 });
    process.stdout.write(result.status);
  `
  const statuses = await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, `child-${index}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error || `child exited ${code}`)))
  })))

  assert.equal(statuses.filter(status => status === 'reserved').length, 1, JSON.stringify(statuses))
  assert.equal(statuses.filter(status => status === 'insufficient-budget').length, 5)
})

test('settlement keeps consumed spend reserved and refunds only the unused part', async t => {
  const { root, center } = await centerIn(t, { CNY: 100 })
  await center.reserve({ reservationId: 'work', runId: 'actual', currency: 'CNY', amountMicros: 80 })
  await saveRun(root, pricedRun('actual', 'local/small', 400)) // 60 micros
  const released = await center.release({ reservationId: 'work', consumedMicros: 60 })
  assert.equal(released.consumedMicros, 60)
  assert.equal(released.refundMicros, 20)

  const checked = await center.check({ currency: 'CNY', amountMicros: 40 })
  assert.equal(checked.ok, true)
  assert.equal(checked.spentMicros, 60)
  assert.equal(checked.reservedMicros, 0)
  assert.equal(checked.remainingMicros, 40)
  assert.equal((await center.check({ currency: 'CNY', amountMicros: 41 })).status, 'insufficient-budget')
})

test('missing prices block budget checks instead of approving an unknown amount', async t => {
  const { center } = await centerIn(t, { CNY: 100 })
  const unknown = pricedRun('unknown', 'mystery/model', 100)
  const checked = await center.check({ currency: 'CNY', amountMicros: 1, runs: [unknown] })
  assert.equal(checked.status, 'unpriced')
  assert.equal(checked.spentMicros, null)
  assert.equal((await center.reserve({ reservationId: 'no', currency: 'CNY', amountMicros: 1, runs: [unknown] })).status, 'unpriced')
})

test('missing budget, overspend and mixed currencies have distinct explicit results', async t => {
  const { center } = await centerIn(t, { CNY: 10 })
  assert.equal((await center.check({ currency: 'USD', amountMicros: 1 })).status, 'budget-not-configured')
  const { center: another } = await centerIn(t, { CNY: 10 })
  const over = await another.check({ currency: 'CNY', amountMicros: 0,
    runs: [pricedRun('over', 'local/small', 100_000)] })
  assert.equal(over.status, 'over-budget')
  assert.equal(over.spentMicros, 15_000)
})

test('a mixed-currency archived line cannot invent per-model currencies after prices disappear', async t => {
  const { root } = await centerIn(t)
  const ledger = createLedger(root)
  const mixed = pricedRun('old-mixed')
  mixed.usage.modelCalls = 2
  mixed.usage.models['cloud/large'] = { calls: 1, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
  applyCost(mixed, PRICES)
  assert.equal(await ledger.record(mixed), true)

  const summary = await createCostCenter(root, { pricing: {} }).aggregate()
  assert.equal(summary.complete, false)
  assert.equal(summary.totalMicros, null)
  assert.deepEqual(summary.byCurrency, {})
  assert.deepEqual(summary.unpriced, ['cloud/large', 'local/small'])
  assert.ok(summary.unpricedItems.every(item => /currency.*ambiguous/.test(item.reason)))
})

test('settled consumption remains budgeted even before the run or ledger is written', async t => {
  const { center } = await centerIn(t, { CNY: 100 })
  await center.reserve({ reservationId: 'settled', currency: 'CNY', amountMicros: 80 })
  assert.equal((await center.release({ reservationId: 'settled', consumedMicros: 60 })).refundMicros, 20)
  const checked = await center.check({ currency: 'CNY', amountMicros: 40 })
  assert.equal(checked.ok, true)
  assert.equal(checked.spentMicros, 60)
  assert.equal(checked.settledMicros, 60)
  assert.equal(checked.remainingMicros, 40)
  assert.equal((await center.check({ currency: 'CNY', amountMicros: 41 })).status, 'insufficient-budget')
})

test('invalid money inputs are rejected rather than truncated or rounded', async t => {
  const { center } = await centerIn(t)
  assert.throws(() => center.reserve({ reservationId: 'bad', currency: 'CNY', amountMicros: 1.5 }), /safe integer/)
  assert.throws(() => center.reserve({ reservationId: 'bad', currency: 'CNY', amountMicros: -1 }), /safe integer/)
  assert.throws(() => center.setBudgets({ CNY: 0.1 }), /safe integer/)
  await assert.rejects(center.check({ currency: 'NOT-A-CURRENCY', amountMicros: 1 }), /three-letter/)
})
