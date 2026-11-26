import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createCostCenter } from '../lib/cost-center.js'
import { createRoutePolicy } from '../lib/route-policy.js'

const PRICING = {
  'p/cheap': { input: 1, output: 1, currency: 'CNY' },
  'p/balanced': { input: 2, output: 1, currency: 'CNY' },
  'p/review': { input: 3, output: 1, currency: 'CNY' },
  'p/plan': { input: 4, output: 1, currency: 'CNY' },
  'p/summary': { input: 5, output: 1, currency: 'CNY' },
  'p/vision': { input: 1.5, output: 1, currency: 'CNY' },
}
const MODELS = [
  { provider: 'p', model: 'cheap', capabilities: ['coding'] },
  { provider: 'p', model: 'balanced', capabilities: ['coding', 'reasoning'] },
  { provider: 'p', model: 'review', capabilities: ['review', 'reasoning'] },
  { provider: 'p', model: 'plan', capabilities: ['planning', 'reasoning'] },
  { provider: 'p', model: 'summary', capabilities: ['summarization', 'reasoning'] },
  { provider: 'p', model: 'vision', capabilities: ['coding', 'vision'] },
]

const policy = () => createRoutePolicy({ pricing: PRICING, models: MODELS, pricingVersion: '2026-11-26.1' })
const work = { role: 'worker', complexity: 'low', estimatedTokens: { inputTokens: 1_000_000, outputTokens: 0 } }

test('role and complexity rules select the cheapest capable route with a stable estimate', async () => {
  const route = await policy().route(work)
  assert.equal(route.ok, true)
  assert.equal(route.provider, 'p')
  assert.equal(route.model, 'cheap')
  assert.equal(route.reason, 'cheapest eligible fully priced route; ties use provider/model order')
  assert.equal(route.pricingVersion, '2026-11-26.1')
  assert.equal(route.estimatedMicros, 1_000_000)
  assert.equal(route.currency, 'CNY')
  assert.equal(route.locked, false)

  const high = await policy().route({ ...work, complexity: 'high' })
  assert.equal(high.model, 'balanced', 'high complexity also requires reasoning')
  assert.equal((await policy().route({ ...work, role: 'planner', complexity: 'medium' })).model, 'plan')
  assert.equal((await policy().route({ ...work, role: 'reviewer', complexity: 'medium' })).model, 'review')
  assert.equal((await policy().route({ ...work, role: 'aggregator', complexity: 'medium' })).model, 'summary')
  assert.equal((await policy().route({ ...work, role: 'unknown' })).status, 'invalid-role')
})

test('required capabilities and context limits cannot be bypassed by a lower price', async () => {
  const vision = await policy().route({ ...work, requiredCapabilities: ['vision'] })
  assert.equal(vision.model, 'vision')
  assert.equal(vision.estimatedMicros, 1_500_000)

  const overflow = await createRoutePolicy({ pricing: PRICING, models: [
    { provider: 'p', model: 'cheap', capabilities: ['coding'], maxContextTokens: 10 },
    ...MODELS.filter(model => model.model !== 'cheap'),
  ] }).route({ ...work, allowedModels: ['p/cheap', 'p/balanced'] })
  assert.equal(overflow.model, 'balanced')
  assert.ok(overflow.rejected.some(item => item.route === 'p/cheap' && item.status === 'context-overflow'))

  const incapable = await policy().route({ ...work, requiredCapabilities: ['vision', 'reasoning'] })
  assert.equal(incapable.status, 'insufficient-capability')
  assert.equal(incapable.estimatedMicros, null)
})

test('whitelists filter both providers and models before fallback', async () => {
  const selected = await policy().route({ ...work,
    preferredModel: 'p/plan', allowedModels: ['p/balanced', 'p/cheap'] })
  assert.equal(selected.model, 'cheap')
  assert.ok(selected.rejected.some(item => item.route === 'p/plan' && item.status === 'not-whitelisted'))

  const provider = await policy().route({ ...work, allowedProviders: ['p'] })
  assert.equal(provider.ok, true)
  const empty = await policy().route({ ...work, allowedProviders: ['other'] })
  assert.equal(empty.status, 'not-whitelisted')
  assert.equal(empty.route, null)
})

test('fallback is explicit, optional, and never chooses an unavailable model', async () => {
  const fallback = await policy().route({ ...work, preferredModel: 'p/plan' })
  assert.equal(fallback.model, 'cheap')
  assert.ok(fallback.rejected.some(item => item.route === 'p/plan' && item.status === 'insufficient-capability'))

  const disabled = await createRoutePolicy({ pricing: PRICING, models: MODELS, allowFallback: false })
    .route({ ...work, preferredModel: 'p/plan' })
  assert.equal(disabled.status, 'insufficient-capability')
  assert.equal(disabled.provider, null)

  const unavailable = await createRoutePolicy({ pricing: PRICING, models: [
    { ...MODELS[0], available: false }, ...MODELS.slice(1),
  ] }).route(work)
  assert.equal(unavailable.model, 'vision')
  assert.ok(unavailable.rejected.some(item => item.route === 'p/cheap' && item.status === 'model-unavailable'))

  const providerDown = await createRoutePolicy({ pricing: PRICING, models: MODELS, providers: { p: { available: false } } }).route(work)
  assert.equal(providerDown.status, 'model-unavailable')
})

test('missing prices are a named refusal, not free or zero-cost routes', async () => {
  const missing = await createRoutePolicy({ pricing: {}, models: [
    { provider: 'p', model: 'mystery', capabilities: ['coding'] },
  ], pricingVersion: 'v1' }).route(work)
  assert.equal(missing.status, 'missing-price')
  assert.equal(missing.estimatedMicros, null)
  assert.equal(missing.pricingVersion, 'v1')
  assert.match(missing.rejected[0].reason, /no usable price/)

  const partial = await createRoutePolicy({ pricing: PRICING, models: [
    { provider: 'p', model: 'mystery', capabilities: ['coding'] }, ...MODELS,
  ] }).route(work)
  assert.equal(partial.model, 'cheap')
  assert.ok(partial.rejected.some(item => item.status === 'missing-price'))
})

test('static budget and cost-center reservations can reject or redirect a route', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-route-budget-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const center = createCostCenter(root, { budgets: { CNY: 3_000_000 }, lockRetries: 100 })
  const routed = createRoutePolicy({ pricing: PRICING, models: MODELS, costCenter: center })
  await center.reserve({ reservationId: 'existing', currency: 'CNY', amountMicros: 1_000_000 })

  const exact = await routed.route({ ...work, role: 'worker', complexity: 'high' })
  assert.equal(exact.model, 'balanced')
  assert.equal(exact.estimatedMicros, 2_000_000)

  await center.reserve({ reservationId: 'extra', currency: 'CNY', amountMicros: 1 })
  const denied = await routed.route({ ...work, role: 'worker', complexity: 'high' })
  assert.equal(denied.status, 'insufficient-budget')
  assert.equal(denied.estimatedMicros, 2_000_000)

  const local = await createRoutePolicy({ pricing: PRICING, models: MODELS, budgets: { CNY: 500_000 } }).route(work)
  assert.equal(local.status, 'insufficient-budget')
  const noCurrency = await createRoutePolicy({ pricing: PRICING, models: MODELS, budgets: { USD: 10 } }).route(work)
  assert.equal(noCurrency.status, 'budget-not-configured')
})

test('an existing role decision is pinned and is never silently replaced mid-run', async () => {
  const original = await policy().route(work)
  const changedPrices = { ...PRICING, 'p/cheap': { input: 99, output: 1, currency: 'CNY' },
    'p/balanced': { input: 0.01, output: 1, currency: 'CNY' } }
  const changed = createRoutePolicy({ pricing: changedPrices, models: MODELS, pricingVersion: 'new-prices' })
  const retained = await changed.route({ ...work, run: { routes: { worker: original } } })
  assert.equal(retained.ok, true)
  assert.equal(retained.model, 'cheap')
  assert.equal(retained.locked, true)
  assert.equal(retained.pricingVersion, 'new-prices')
  assert.equal(retained.estimatedMicros, 99_000_000)
  assert.match(retained.reason, /no mid-run switch/)

  const unavailable = await createRoutePolicy({ pricing: PRICING, models: [
    { ...MODELS[0], available: false }, ...MODELS.slice(1),
  ] }).route({ ...work, run: { routeDecision: original } })
  assert.equal(unavailable.status, 'model-unavailable')
  assert.equal(unavailable.locked, true)
  assert.equal(unavailable.model, null, 'a blocked result cannot be mistaken for a fallback route')
})

test('bare model preferences resolve uniquely and an over-budget preference can fall back', async () => {
  const planner = await policy().route({ ...work, role: 'planner', preferredModel: 'plan' })
  assert.equal(planner.model, 'plan')
  assert.match(planner.reason, /preferred route selected/)

  const constrained = createRoutePolicy({ pricing: PRICING, models: MODELS, budgets: { CNY: 1_500_000 } })
  const fallback = await constrained.route({ ...work, preferredModel: 'balanced' })
  assert.equal(fallback.model, 'cheap')
  assert.equal(fallback.rejected.some(item => item.route === 'p/balanced'), false,
    'an eligible but over-budget preference is not a catalog rejection')
})

test('a pinned route is budget-checked without silently falling back', async () => {
  const original = await policy().route(work)
  const constrained = createRoutePolicy({ pricing: PRICING, models: MODELS, budgets: { CNY: 500_000 } })
  const denied = await constrained.route({ ...work, run: { routes: { worker: original } } })
  assert.equal(denied.status, 'insufficient-budget')
  assert.equal(denied.locked, true)
  assert.equal(denied.model, null)
  assert.equal(denied.estimatedMicros, 1_000_000)
})

test('the same inputs produce deeply equal decisions regardless of catalog insertion order', async () => {
  const first = createRoutePolicy({ pricing: PRICING, models: MODELS, pricingVersion: 'stable' })
  const second = createRoutePolicy({ pricing: Object.fromEntries(Object.entries(PRICING).reverse()),
    models: [...MODELS].reverse(), pricingVersion: 'stable' })
  for (const role of ['planner', 'worker', 'reviewer', 'aggregator']) {
    for (const complexity of ['low', 'medium', 'high']) {
      const request = { role, complexity, estimatedTokens: { inputTokens: 1234, outputTokens: 321 } }
      assert.deepEqual(await first.route(request), await second.route(request))
      assert.deepEqual(await first.route(request), await first.route(request))
    }
  }
})

test('route selection is model-free and preserves exact integer rounding', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('network access is forbidden') }
  try {
    const rounded = await createRoutePolicy({ pricing: {
      'p/cheap': { input: 0.15, output: 0, currency: 'CNY' },
    }, models: [MODELS[0]] }).route({ ...work, estimatedTokens: { inputTokens: 5, outputTokens: 0 } })
    assert.equal(rounded.estimatedMicros, 1)
    assert.ok(Number.isSafeInteger(rounded.estimatedMicros))
  } finally {
    globalThis.fetch = originalFetch
  }
})
