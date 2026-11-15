import assert from 'node:assert/strict'
import test from 'node:test'

import { applyCost, computeCost, formatMoney, moneyOfMicros } from '../lib/cost.js'

function usage(models, modelCalls = 1) {
  return { modelCalls, models }
}

test('a known model is priced from input, output, and cache rates', () => {
  const cost = computeCost(usage({
    'dashscope/qwen-flash': {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      calls: 1,
    },
  }), {
    'dashscope/qwen-flash': { input: 0.15, output: 1.5, cacheRead: 0.03, currency: 'CNY' },
  })

  // 1M × 0.15 + 2M × 0.03 + 0.1M × 1.5 = 0.36 CNY.
  assert.equal(cost.totalMicros, 360_000)
  assert.equal(cost.total, 0.36)
  assert.equal(cost.currency, 'CNY')
  assert.equal(cost.complete, true)
  assert.deepEqual(cost.unpriced, [])
  assert.equal(formatMoney(cost), '¥0.3600')
  assert.deepEqual(cost.records[0], {
    model: 'dashscope/qwen-flash',
    calls: 1,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 2_000_000,
    inputPrice: 0.15,
    outputPrice: 1.5,
    cachePrice: 0.03,
    amountMicros: 360_000,
  })
})

test('cache reads fall back to the input rate when no cache price is set', () => {
  const cost = computeCost(usage({
    'qwen-flash': { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, calls: 1 },
  }), { 'qwen-flash': { input: 0.15, output: 1.5, currency: 'CNY' } })

  assert.equal(cost.totalMicros, 150_000)
  assert.equal(cost.records[0].cachePrice, 0.15)
})

test('an unknown model is named as unpriced and never counted as zero', () => {
  const cost = computeCost(usage({
    'qwen-flash': { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 0, calls: 2 },
    'haoduo/gpt-6.1-sol': { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 },
  }, 3), { 'qwen-flash': { input: 0.15, output: 1.5, currency: 'CNY' } })

  assert.equal(cost.complete, false)
  assert.deepEqual(cost.unpriced, ['haoduo/gpt-6.1-sol'])
  assert.equal(cost.byModel['haoduo/gpt-6.1-sol'], undefined)
  const unknown = cost.records.find(record => record.model === 'haoduo/gpt-6.1-sol')
  assert.equal(unknown.amountMicros, null)
  assert.equal(unknown.inputPrice, null)
  assert.equal(formatMoney(cost), '¥0.4500')
})

test('a single currency keeps the flat total and also reports its subtotal', () => {
  const cost = computeCost(usage({
    'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
  }), { 'dashscope/qwen-flash': { input: 0.0952, output: 0, currency: 'CNY' } })

  assert.equal(cost.currency, 'CNY')
  assert.equal(cost.totalMicros, 95_200)
  assert.equal(cost.total, 0.0952)
  assert.equal(cost.mixedCurrency, false)
  assert.deepEqual(cost.byCurrency, { CNY: 95_200 })
  assert.equal(formatMoney(cost), '¥0.0952')
})

test('two currencies get separate subtotals and no cross-currency total', () => {
  const cost = computeCost(usage({
    'haoduo/gpt-6.1-sol': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
    'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
  }, 2), {
    'haoduo/gpt-6.1-sol': { input: 0.0248, output: 0, currency: 'USD' },
    'dashscope/qwen-flash': { input: 0.0952, output: 0, currency: 'CNY' },
  })

  // The measured run B2 spent ¥0.0952 + $0.0248. Adding those micro-units
  // would claim a single amount whose unit does not exist.
  assert.deepEqual(cost.byCurrency, { USD: 24_800, CNY: 95_200 })
  assert.equal(cost.totalMicros, null)
  assert.equal(cost.total, null)
  assert.equal(cost.currency, null)
  assert.equal(cost.mixedCurrency, true)
  assert.equal(cost.byModel['haoduo/gpt-6.1-sol'], 0.0248)
  assert.equal(cost.byModel['dashscope/qwen-flash'], 0.0952)
  assert.equal(formatMoney(cost), '¥0.0952 + $0.0248')
})

test('a mixed-currency cost keeps its unpriced model unpriced', () => {
  const cost = computeCost(usage({
    'haoduo/gpt-6.1-sol': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
    'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
    'mystery/model': { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, calls: 1 },
  }, 3), {
    'haoduo/gpt-6.1-sol': { input: 0.0248, output: 0, currency: 'USD' },
    'dashscope/qwen-flash': { input: 0.0952, output: 0, currency: 'CNY' },
  })

  assert.deepEqual(cost.unpriced, ['mystery/model'])
  assert.equal(cost.complete, false)
  assert.deepEqual(cost.byCurrency, { USD: 24_800, CNY: 95_200 })
  assert.equal(cost.byModel['mystery/model'], undefined)
  assert.equal(cost.records.find(record => record.model === 'mystery/model').amountMicros, null)
  assert.equal(formatMoney(cost), '¥0.0952 + $0.0248', 'unpriced is not folded in as zero')
})

test('an all-unpriced usage reports no total at all', () => {  const cost = computeCost(usage({
    'mystery/model': { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, calls: 1 },
  }), {})

  assert.equal(cost.totalMicros, 0)
  assert.equal(cost.complete, false)
  assert.deepEqual(cost.unpriced, ['mystery/model'])
  assert.deepEqual(cost.byModel, {})
})

test('line amounts are rounded half-up once, then summed as integers', () => {
  // 5 tokens at 0.15 per 1M = 0.75 micro-units, which must round to 1.
  const smallest = computeCost(usage({
    'tiny/model': { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
  }), { 'tiny/model': { input: 0.15, output: 0, currency: 'CNY' } })
  assert.equal(smallest.totalMicros, 1)

  // Three lines that each land on .3 micro-units: a float sum drifts to
  // 0.099999…; integer micro-units stay at 99999 and round once for display.
  const three = computeCost(usage({
    'p/m1': { inputTokens: 333_333, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
    'p/m2': { inputTokens: 333_333, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
    'p/m3': { inputTokens: 333_333, outputTokens: 0, cacheReadTokens: 0, calls: 1 },
  }, 3), {
    'p/m1': { input: 0.1, output: 0, currency: 'CNY' },
    'p/m2': { input: 0.1, output: 0, currency: 'CNY' },
    'p/m3': { input: 0.1, output: 0, currency: 'CNY' },
  })
  assert.equal(three.totalMicros, 99_999)
  assert.equal(moneyOfMicros(three.totalMicros, 'CNY'), '¥0.1000')
})

test('prices match an exact route, a nested provider table, or a bare model id', () => {
  const line = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 }

  const exact = computeCost(usage({ 'dashscope/qwen-flash': line }), {
    'dashscope/qwen-flash': { input: 1, output: 1, currency: 'USD' },
    'qwen-flash': { input: 9, output: 9, currency: 'USD' },
  })
  assert.equal(exact.totalMicros, 1_000_000)

  const nested = computeCost(usage({ 'dashscope/qwen-flash': line }), {
    dashscope: { 'qwen-flash': { input: 0.15, output: 1.5, currency: 'CNY' } },
  })
  assert.equal(nested.totalMicros, 150_000)

  const bare = computeCost(usage({ 'dashscope/qwen-flash': line }), {
    'qwen-flash': { input: 0.15, output: 1.5, currency: 'CNY' },
  })
  assert.equal(bare.totalMicros, 150_000)
})

test('a malformed price row counts as unpriced instead of pricing at zero', () => {
  const cost = computeCost(usage({
    'a/b': { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, calls: 1 },
  }), { 'a/b': { input: 'free', output: 1 } })

  assert.equal(cost.complete, false)
  assert.deepEqual(cost.unpriced, ['a/b'])
})

test('applyCost prices each subtask and leaves unreadable ones null', () => {
  const run = {
    id: 'run-1',
    usage: {
      modelCalls: 3,
      models: {
        'dashscope/qwen-flash': { inputTokens: 3_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 3 },
      },
    },
    subtasks: [
      {
        index: 1,
        usage: { modelCalls: 1, models: { 'dashscope/qwen-flash': { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, calls: 1 } } },
      },
      {
        index: 2,
        usage: { modelCalls: 1, models: { 'haoduo/gpt-6.1-sol': { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 } } },
      },
      { index: 3, usage: null },
    ],
  }
  applyCost(run, { 'dashscope/qwen-flash': { input: 0.15, output: 1.5, currency: 'CNY' } })

  assert.equal(run.cost.totalMicros, 450_000)
  assert.equal(run.subtasks[0].cost.totalMicros, 150_000)
  assert.equal(run.subtasks[1].cost.complete, false)
  assert.deepEqual(run.subtasks[1].cost.unpriced, ['haoduo/gpt-6.1-sol'])
  assert.equal(run.subtasks[2].cost, null)
})

test('the formatter marks too-small amounts and zero distinctly', () => {
  assert.equal(moneyOfMicros(0, 'CNY'), '¥0')
  assert.equal(moneyOfMicros(50, 'CNY'), '<¥0.0001')
  assert.equal(moneyOfMicros(100, 'CNY'), '¥0.0001')
  assert.equal(moneyOfMicros(1_500_000, 'USD'), '$1.50')
  assert.equal(formatMoney(null), '—')
})
