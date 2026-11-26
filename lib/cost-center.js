/**
 * Durable cost aggregation and currency-scoped budget reservations.
 *
 * Run files are the current accounting snapshot; ledger lines fill in runs that
 * are no longer present. A run present in both is counted once, from the run.
 * Money stays in integer micro-units and currencies are never converted.
 *
 * @module dsh-superagent/cost-center
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLock } from './lock.js'
import { computeCost, currencyTotals } from './cost.js'
import { createLedger } from './ledger.js'

const STATE_FILE = 'cost-center.json'
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0

function currencyOf(value) {
  const code = String(value ?? 'USD').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currency must be a three-letter code')
  return code
}

function integer(value, name, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`)
  }
  return value
}

function tokenCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function usablePrice(entry) {
  return entry && typeof entry === 'object'
    && Number.isFinite(entry.input) && entry.input >= 0
    && Number.isFinite(entry.output) && entry.output >= 0
}

function priceCurrency(pricing, model) {
  const exact = pricing?.[model]
  if (usablePrice(exact)) return currencyOf(exact.currency ?? 'USD')
  const slash = model.indexOf('/')
  if (slash <= 0) return null
  const provider = model.slice(0, slash)
  const bare = model.slice(slash + 1)
  const nested = pricing?.[provider]?.[bare]
  if (usablePrice(nested)) return currencyOf(nested.currency ?? 'USD')
  const fallback = pricing?.[bare]
  return usablePrice(fallback) ? currencyOf(fallback.currency ?? 'USD') : null
}

function recordCurrency(model, cost, pricing) {
  if (typeof model.currency === 'string' && model.currency.trim()) return currencyOf(model.currency)
  const priced = priceCurrency(pricing, model.model)
  if (priced) return priced
  const codes = Object.keys(cost?.byCurrency ?? {})
  if (codes.length === 1) return currencyOf(codes[0])
  if (typeof cost?.currency === 'string' && cost.currency.trim()) return currencyOf(cost.currency)
  // A mixed-currency historical line without a current usable price cannot be
  // assigned to USD (or any other currency) just to make the arithmetic work.
  if (cost?.mixedCurrency || codes.length > 1) return null
  return 'USD'
}

function emptyModel(model) {
  return {
    model,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    amountMicros: 0,
    byCurrency: {},
    usageByCurrency: {},
    priced: true,
  }
}

function addModel(target, record, currency, amountMicros) {
  const counts = {
    calls: tokenCount(record.calls),
    inputTokens: tokenCount(record.inputTokens),
    outputTokens: tokenCount(record.outputTokens),
    cacheReadTokens: tokenCount(record.cacheReadTokens),
  }
  target.calls += counts.calls
  target.inputTokens += counts.inputTokens
  target.outputTokens += counts.outputTokens
  target.cacheReadTokens += counts.cacheReadTokens
  target.totalTokens = target.inputTokens + target.outputTokens + target.cacheReadTokens
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) {
    target.priced = false
    target.amountMicros = null
    return
  }
  if (target.priced) target.amountMicros += amountMicros
  target.byCurrency[currency] = (target.byCurrency[currency] ?? 0) + amountMicros
  const usage = target.usageByCurrency[currency] ??= { calls: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, totalTokens: 0, amountMicros: 0 }
  usage.calls += counts.calls
  usage.inputTokens += counts.inputTokens
  usage.outputTokens += counts.outputTokens
  usage.cacheReadTokens += counts.cacheReadTokens
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens
  usage.amountMicros += amountMicros
}

/**
 * Price a proposed call without invoking a model.
 *
 * @param {{ provider?: string, model?: string, pricing?: object, inputTokens?: number,
 *   outputTokens?: number, cacheReadTokens?: number }} request - proposed usage.
 * @returns {{ ok: boolean, status: string, reason: string, model: string, currency: string|null,
 *   estimatedMicros: number|null, inputTokens: number, outputTokens: number, cacheReadTokens: number }}
 */
export function estimateCost(request) {
  const model = String(request.model ?? '').trim()
  const route = request.provider ? `${request.provider}/${model}` : model
  const inputTokens = tokenCount(request.inputTokens)
  const outputTokens = tokenCount(request.outputTokens)
  const cacheReadTokens = tokenCount(request.cacheReadTokens)
  if (!model) return { ok: false, status: 'invalid-model', reason: 'model is required', model: route,
    currency: null, estimatedMicros: null, inputTokens, outputTokens, cacheReadTokens }
  const cost = computeCost({ modelCalls: 1, models: {
    [route]: { calls: 1, inputTokens, outputTokens, cacheReadTokens },
  } }, request.pricing)
  const record = cost.records[0]
  const priced = Number.isSafeInteger(record.amountMicros)
  return {
    ok: priced,
    status: priced ? 'priced' : 'missing-price',
    reason: priced ? 'all token classes have a configured price' : `no usable price for ${route}`,
    model: route,
    currency: priced ? priceCurrency(request.pricing, route) : null,
    estimatedMicros: priced ? record.amountMicros : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  }
}

function readState(file) {
  return fsp.readFile(file, 'utf8').then(text => {
    const state = JSON.parse(text)
    if (!state || typeof state !== 'object' || state.v !== 1) throw new Error('unsupported cost-center state')
    return { v: 1, budgets: state.budgets ?? {}, reservations: state.reservations ?? {} }
  }, error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
}

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 10 * attempt))
    }
  }
}

async function acquireHeld(file, options) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await acquireFileLock(file, options)
    } catch (error) {
      // A newly created lock can be observed before its JSON write completes.
      // The shared lock correctly refuses to race the active breaker; retry
      // acquisition rather than deleting or bypassing that breaker.
      if (attempt >= 100 || !/stale lock breaker/.test(error?.message ?? '')) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

async function releaseHeld(release) {
  // The shared lock's breaker has a short internal retry window. Under a burst
  // of cross-process releases it can legitimately still be busy; our lock token
  // remains owned by this operation, so retry the same guarded release.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await release()
      return
    } catch (error) {
      if (attempt >= 50 || !/lock breaker is busy|stale lock breaker/.test(error?.message ?? '')) throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

/**
 * Create a cost center bound to a state root.
 *
 * `reserve` and `release` use the reservation id as an idempotency key. Budgets
 * are configured in integer micro-units, e.g. `{ CNY: 100_000_000 }`.
 *
 * @param {string} root - state root containing `runs/` and `ledger.jsonl`.
 * @param {{ pricing?: object, budgets?: Record<string, number>, lockRetries?: number,
 *   warn?: (message: string) => void }} [options] - prices, budgets, lock settings.
 */
export function createCostCenter(root, options = {}) {
  const pricing = options.pricing ?? {}
  const file = path.join(root, STATE_FILE)
  const lockOptions = { retries: options.lockRetries ?? 50, retryDelayMs: 10 }

  async function aggregate(query = {}) {
    let runs = query.runs
    if (runs === undefined) {
      const runsDir = path.join(root, 'runs')
      let names
      try {
        names = await fsp.readdir(runsDir)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        names = []
      }
      runs = (await Promise.all(names.filter(name => name.endsWith('.json') && !name.startsWith('.'))
        .sort().map(async name => {
          try {
            return JSON.parse(await fsp.readFile(path.join(runsDir, name), 'utf8'))
          } catch (error) {
            if (error instanceof SyntaxError) {
              options.warn?.(`cost-center: skipping invalid run ${name}: ${error.message}`)
              return null
            }
            throw error
          }
        }))).filter(run => run && typeof run === 'object')
    }
    if (!Array.isArray(runs)) throw new TypeError('runs must be an array')
    let ledger = query.ledger
    if (ledger === undefined) ledger = await createLedger(root, { warn: options.warn }).read(query.range ?? {})
    else if (ledger === null) ledger = []
    if (ledger && typeof ledger.read === 'function') ledger = await ledger.read(query.range ?? {})
    if (!Array.isArray(ledger)) throw new TypeError('ledger must be an array or a ledger reader')

    // Current run files win over older ledger snapshots. This also includes
    // active-run spend, which the terminal-only ledger cannot know yet.
    const runIds = new Set(runs.map(run => run?.id).filter(Boolean))
    const sources = [
      ...runs.filter(run => run && typeof run === 'object').map(run => ({ kind: 'run', value: run })),
      ...ledger.filter(entry => entry && typeof entry === 'object' && !runIds.has(entry.runId))
        .map(entry => ({ kind: 'ledger', value: entry })),
    ].sort((a, b) => compareText(String(a.value.id ?? a.value.runId), String(b.value.id ?? b.value.runId)))

    const byModel = {}
    const unpricedItems = []
    const byCurrency = {}
    let records = 0
    // An empty store has no unknown spend. Unattributed non-zero usage below
    // changes this to false; a genuinely empty budget starts at zero.
    let complete = true
    for (const { kind, value } of sources) {
      const cost = kind === 'run'
        ? (Array.isArray(value.cost?.records) ? value.cost : computeCost(value.usage, pricing))
        : value
      const models = kind === 'run' ? (cost?.records ?? []) : (Array.isArray(value.models) ? value.models : [])
      if (!models.length) {
        if (value.usage?.modelCalls || value.calls) {
          complete = false
          unpricedItems.push({ model: null, runId: value.id ?? value.runId, reason: 'usage has no model attribution' })
        }
        continue
      }
      records += models.length
      for (const record of models) {
        const model = String(record.model ?? '')
        if (!model) {
          complete = false
          unpricedItems.push({ model: null, runId: value.id ?? value.runId, reason: 'model name is missing' })
          continue
        }
        let amount = record.amountMicros
        if (!Number.isSafeInteger(amount) || amount < 0) {
          // Old ledger lines may have unit prices but no precomputed amount.
          const computed = computeCost({ modelCalls: 1, models: { [model]: record } }, pricing)
          amount = computed?.records?.[0]?.amountMicros ?? null
        }
        const target = byModel[model] ??= emptyModel(model)
        const known = Number.isSafeInteger(amount) && amount >= 0
        const currency = known ? recordCurrency(record, cost, pricing) : null
        if (known && !currency) {
          addModel(target, record, null, null)
          complete = false
          unpricedItems.push({ model, runId: value.id ?? value.runId ?? null,
            reason: `cost is known but the currency for ${model} is ambiguous` })
          continue
        }
        addModel(target, record, currency, amount)
        if (!known) {
          complete = false
          unpricedItems.push({ model, runId: value.id ?? value.runId ?? null,
            reason: `no usable price for ${model}` })
        } else {
          byCurrency[currency] = (byCurrency[currency] ?? 0) + amount
        }
      }
    }

    const sortedModels = Object.fromEntries(Object.keys(byModel).sort().map(model => [model, byModel[model]]))
    const byModelCurrency = Object.fromEntries(Object.keys(byModel).sort().map(model => [model,
      Object.fromEntries(Object.entries(byModel[model].usageByCurrency).sort(([a], [b]) => compareText(a, b))),
    ]))
    const totals = currencyTotals(byCurrency)
    return {
      runs: sources.length,
      records,
      complete,
      byModel: sortedModels,
      byModelCurrency,
      byCurrency: Object.fromEntries(Object.entries(byCurrency).sort(([a], [b]) => compareText(a, b))),
      runIds: sources.map(source => String(source.value.id ?? source.value.runId)).sort(compareText),
      currency: complete && records > 0 ? totals.currency : null,
      totalMicros: complete ? (Object.keys(byCurrency).length ? totals.totalMicros : 0) : null,
      total: complete ? (Object.keys(byCurrency).length ? totals.total : 0) : null,
      mixedCurrency: totals.mixedCurrency,
      unpriced: [...new Set(unpricedItems.map(item => item.model).filter(Boolean))].sort(),
      unpricedItems,
    }
  }

  async function mutate(operation) {
    await fsp.mkdir(root, { recursive: true })
    const release = await acquireHeld(`${file}.lock`, lockOptions)
    if (!release) return { ok: false, status: 'busy', reason: 'cost-center state is locked by another process' }
    try {
      const state = (await readState(file)) ?? { v: 1, budgets: { ...options.budgets }, reservations: {} }
      const result = await operation(state)
      if (result.changed !== false) {
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
        try {
          await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
          await renameWithRetry(temporary, file)
        } finally {
          await fsp.unlink(temporary).catch(() => {})
        }
      }
      const { changed, ...payload } = result
      return payload
    } finally {
      await releaseHeld(release)
    }
  }

  function evaluate(state, summary, currency, amountMicros) {
    const code = currencyOf(currency)
    integer(amountMicros, 'amountMicros')
    if (!summary.complete) return { ok: false, status: 'unpriced', reason: 'recorded usage contains missing prices',
      currency: code, estimatedMicros: amountMicros, spentMicros: null, reservedMicros: null, remainingMicros: null }
    const budget = state.budgets[code]
    const representedRuns = new Set(summary.runIds)
    const settledMicros = Object.values(state.reservations)
      .filter(item => item.status === 'released' && item.currency === code
        && !representedRuns.has(item.runId))
      .reduce((sum, item) => sum + (item.consumedMicros ?? 0), 0)
    const spentMicros = (summary.byCurrency[code] ?? 0) + settledMicros
    if (!Number.isSafeInteger(budget) || budget < 0) return { ok: false, status: 'budget-not-configured',
      reason: `no budget configured for ${code}`, currency: code, estimatedMicros: amountMicros,
      spentMicros, settledMicros, reservedMicros: 0, remainingMicros: null }
    const reservedMicros = Object.values(state.reservations)
      .filter(item => item.status === 'active' && item.currency === code)
      .reduce((sum, item) => sum + item.amountMicros, 0)
    const remainingMicros = budget - spentMicros - reservedMicros
    const status = spentMicros > budget ? 'over-budget'
      : remainingMicros < amountMicros ? 'insufficient-budget' : 'ok'
    return { ok: status === 'ok', status, reason: status === 'ok' ? 'within budget'
      : status === 'over-budget' ? `recorded ${code} spend exceeds the budget` : 'requested reservation exceeds the remaining budget',
      currency: code, estimatedMicros: amountMicros, budgetMicros: budget, spentMicros, settledMicros,
      reservedMicros, remainingMicros }
  }

  return {
    file,
    aggregate,

    /** Merge configured currency budgets, in micro-units. */
    setBudgets(budgets) {
      if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) throw new TypeError('budgets must be an object')
      const updates = Object.fromEntries(Object.entries(budgets).map(([code, value]) => [currencyOf(code), integer(value, 'budget')]))
      return mutate(state => {
        state.budgets = { ...state.budgets, ...updates }
        return { changed: true, ok: true, status: 'configured', budgets: { ...state.budgets } }
      })
    },

    /** Check actual spend plus active reservations, atomically with respect to reserves. */
    async check(request) {
      const code = currencyOf(request.currency)
      const amount = integer(request.amountMicros ?? request.estimatedMicros ?? 0, 'amountMicros')
      const result = await mutate(async state => {
        const summary = await aggregate(request)
        return { changed: false, ...evaluate(state, summary, code, amount), summary }
      })
      if (result.summary) {
        const { summary, ...payload } = result
        return { ...payload, aggregate: summary }
      }
      return result
    },

    /** Reserve estimated spend; replaying the same id is idempotent. */
    reserve(request) {
      const id = String(request.reservationId ?? request.id ?? '')
      if (!id) throw new TypeError('reservationId is required')
      const code = currencyOf(request.currency)
      const amount = integer(request.amountMicros ?? request.estimatedMicros, 'amountMicros')
      const runId = request.runId == null ? null : String(request.runId)
      return mutate(async state => {
        const prior = state.reservations[id]
        if (prior) {
          const same = prior.currency === code && prior.amountMicros === amount && prior.runId === runId
          if (!same && prior.status === 'active') return { changed: false, ok: false, status: 'reservation-conflict',
            reason: 'reservation id is already active with different terms', reservation: prior }
          return { changed: false, ok: true, status: prior.status, reservation: prior, replayed: true }
        }
        const summary = await aggregate(request)
        const verdict = evaluate(state, summary, code, amount)
        if (!verdict.ok) return { changed: false, ...verdict }
        const reservation = { id, runId, currency: code, amountMicros: amount, status: 'active',
          pricingVersion: request.pricingVersion ?? null, at: new Date().toISOString() }
        state.reservations[id] = reservation
        return { changed: true, ...verdict, ok: true, status: 'reserved', reservation: { ...reservation },
          remainingMicros: verdict.remainingMicros - amount }
      })
    },

    /**
     * Release a reservation. With no consumed amount this is a full cancellation
     * refund. Completed work passes its actual integer cost as `consumedMicros`.
     */
    release(request) {
      const id = String(typeof request === 'object' ? request.reservationId ?? request.id : request)
      if (!id) throw new TypeError('reservationId is required')
      const consumed = integer(typeof request === 'object' ? request.consumedMicros ?? 0 : 0, 'consumedMicros')
      return mutate(state => {
        const prior = state.reservations[id]
        if (!prior) return { changed: false, ok: false, status: 'not-found', reason: 'unknown reservation id', refundMicros: 0 }
        if (prior.status !== 'active') return { changed: false, ok: true, status: 'released', refundMicros: 0, reservation: prior, replayed: true }
        if (consumed > prior.amountMicros) return { changed: false, ok: false, status: 'invalid-consumption',
          reason: 'consumedMicros exceeds the reservation', refundMicros: 0 }
        const refundMicros = prior.amountMicros - consumed
        prior.status = 'released'
        prior.consumedMicros = consumed
        prior.refundMicros = refundMicros
        prior.releasedAt = new Date().toISOString()
        return { changed: true, ok: true, status: 'released', refundMicros, consumedMicros: consumed,
          reservation: { ...prior } }
      })
    },
  }
}
