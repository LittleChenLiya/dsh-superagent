/**
 * Cost accounting for recorded token usage.
 *
 * Prices are list prices per 1M tokens, supplied by the operator as
 * `pricing: { "provider/model": { input, output, cacheRead, currency } }`.
 * A bare model id is accepted as a fallback, and an exact `provider/model`
 * key always wins, so usage logged as `dashscope/qwen-flash` can be priced by
 * `"qwen-flash"` without guessing the provider.
 *
 * Money is accumulated as integer micro-units (1e-6 of the currency), never as
 * floating point. Each model line is rounded once to the nearest micro-unit,
 * the total is a plain integer sum, and presentation rounds that integer once
 * more. A model absent from the table is reported as unpriced — it is never
 * silently priced at zero, because "we do not know" and "it was free" are
 * different answers.
 *
 * Currencies never add. A run that used a USD route and a CNY route has one
 * subtotal per currency; a cross-currency "total" would be a number whose unit
 * is undefined. Single-currency runs keep the flat `currency` / `totalMicros` /
 * `total` fields callers already read.
 *
 * @module dsh-superagent/cost
 */

/** Micro-units per currency unit. */
const MICRO = 1_000_000
/** Tokens per price unit: the table is quoted per million tokens. */
const TOKENS_PER_PRICE = 1_000_000
/** The smallest amount the report will print instead of "less than". */
const SMALLEST_SHOWN_MICROS = 100

/**
 * Currency symbol for a three-letter code.
 * @param {string} code - ISO currency code.
 * @returns {string} symbol, or the code plus a space when unknown.
 */
export function currencySymbol(code) {
  if (code === 'CNY' || code === 'RMB') return '¥'
  if (code === 'USD') return '$'
  if (code === 'EUR') return '€'
  return `${code ?? ''} `
}

/**
 * Add one amount to a currency-keyed tally of integer micro-units.
 * @param {Record<string, number>} tally - currency code -> micro-units.
 * @param {string | null | undefined} currency - ISO currency code.
 * @param {number} micros - integer micro-units in that currency.
 * @returns {Record<string, number>} the same tally.
 */
export function addCurrencyMicros(tally, currency, micros) {
  if (!Number.isFinite(micros)) return tally
  const code = currency || 'USD'
  tally[code] = (tally[code] ?? 0) + micros
  return tally
}

/**
 * Reduce a currency tally to the flat fields callers already use.
 *
 * One currency keeps `currency` / `totalMicros` / `total` exactly as before.
 * More than one yields null for the scalar fields: there is no meaningful sum
 * of ¥ and $, so callers must render `byCurrency` instead of adding.
 *
 * @param {Record<string, number>} tally - currency code -> micro-units.
 * @returns {{ currency: string | null, totalMicros: number | null, total: number | null, mixedCurrency: boolean }}
 */
export function currencyTotals(tally) {
  const codes = Object.keys(tally ?? {})
  if (codes.length === 0) return { currency: 'USD', totalMicros: 0, total: 0, mixedCurrency: false }
  if (codes.length === 1) {
    const totalMicros = tally[codes[0]]
    return { currency: codes[0], totalMicros, total: totalMicros / MICRO, mixedCurrency: false }
  }
  return { currency: null, totalMicros: null, total: null, mixedCurrency: true }
}

/**
 * Render a currency tally. One currency reads exactly like `formatMoney`;
 * several are joined with `+`, each under its own symbol.
 * @param {Record<string, number>} tally - currency code -> integer micro-units.
 * @returns {string} e.g. `¥0.0952 + $0.0248`.
 */
export function formatCurrencyTally(tally) {
  const codes = Object.keys(tally ?? {}).sort()
  if (codes.length === 0) return '—'
  return codes.map(code => moneyOfMicros(tally[code], code)).join(' + ')
}

/**
 * Convert one configured price to integer micro-units per million tokens.
 * @param {unknown} rate - price quoted per 1M tokens.
 * @returns {number | null} micro-units, or null when the value is unusable.
 */
function rateMicros(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return null
  return Math.round(rate * MICRO)
}

/**
 * Validate and normalise one pricing row.
 * @param {unknown} entry - configured `{ input, output, cacheRead?, cache?, currency? }`.
 * @returns {{ input: number, output: number, cacheRead: number, currency: string,
 *   inputMicros: number, outputMicros: number, cacheMicros: number } | null}
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const inputMicros = rateMicros(entry.input)
  const outputMicros = rateMicros(entry.output)
  if (inputMicros === null || outputMicros === null) return null
  // A separate cache rate is optional. Without one, cache reads are priced as
  // ordinary input, which over-reports rather than under-reports the spend.
  const configuredCache = rateMicros(entry.cacheRead ?? entry.cache)
  const cacheRead = configuredCache === null ? entry.input : (entry.cacheRead ?? entry.cache)
  return {
    input: entry.input,
    output: entry.output,
    cacheRead,
    currency: typeof entry.currency === 'string' && entry.currency.trim()
      ? entry.currency.trim().toUpperCase()
      : 'USD',
    inputMicros,
    outputMicros,
    cacheMicros: configuredCache ?? inputMicros,
  }
}

/**
 * Find the price row for one usage model key.
 *
 * Lookup order: exact `provider/model`, nested `provider: { model: {...} }`,
 * then the bare model id. The first usable row wins.
 *
 * @param {object} table - configured pricing map.
 * @param {string} model - usage model key, usually `provider/model`.
 * @returns {object | null} normalised price row.
 */
function priceFor(table, model) {
  const exact = normalizeEntry(table[model])
  if (exact) return exact
  const slash = model.indexOf('/')
  if (slash > 0) {
    const provider = model.slice(0, slash)
    const bare = model.slice(slash + 1)
    const nested = table[provider]
    const nestedEntry = nested && typeof nested === 'object' && !Array.isArray(nested)
      ? normalizeEntry(nested[bare])
      : null
    if (nestedEntry) return nestedEntry
    const bareEntry = normalizeEntry(table[bare])
    if (bareEntry) return bareEntry
  }
  return null
}

/**
 * Billed micro-units for one token count at one price.
 *
 * Integer arithmetic with a single half-up rounding keeps a long bill free of
 * the drift that accumulates when fractional currency is added in floats.
 *
 * @param {number} tokens - token count.
 * @param {number} priceMicros - micro-currency per 1M tokens.
 * @returns {number} micro-units, rounded half-up.
 */
function amountMicros(tokens, priceMicros) {
  const count = Math.max(0, Math.trunc(Number(tokens) || 0))
  if (count === 0 || priceMicros <= 0) return 0
  const numerator = BigInt(count) * BigInt(priceMicros)
  const denominator = BigInt(TOKENS_PER_PRICE)
  const whole = numerator / denominator
  const rest = numerator % denominator
  const rounded = rest * 2n >= denominator ? whole + 1n : whole
  return Number(rounded)
}

/**
 * Price recorded usage with an explicit per-model table.
 *
 * @param {object | null} usage - summed usage for one run (or subtask).
 * @param {Record<string, object> | undefined} pricing - configured price table.
 * @returns {{
 *   currency: string | null,
 *   totalMicros: number | null,
 *   total: number | null,
 *   mixedCurrency: boolean,
 *   byCurrency: Record<string, number>,
 *   byModel: Record<string, number>,
 *   byModelMicros: Record<string, number>,
 *   records: object[],
 *   unpriced: string[],
 *   complete: boolean,
 * } | null} cost, or null when there is nothing to price.
 */
export function computeCost(usage, pricing) {
  if (!usage || !usage.modelCalls) return null
  const table = pricing && typeof pricing === 'object' ? pricing : {}
  const byModel = {}
  const byModelMicros = {}
  const byCurrency = {}
  const records = []
  const unpriced = []

  for (const [model, entry] of Object.entries(usage.models ?? {})) {
    const record = {
      model,
      calls: entry.calls ?? 0,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      cacheReadTokens: entry.cacheReadTokens ?? 0,
      inputPrice: null,
      outputPrice: null,
      cachePrice: null,
      amountMicros: null,
    }
    const price = priceFor(table, model)
    if (!price) {
      // Named, not zero: a caller can see exactly which route has no price.
      unpriced.push(model)
      records.push(record)
      continue
    }
    record.inputPrice = price.input
    record.outputPrice = price.output
    record.cachePrice = price.cacheRead
    const amount = amountMicros(record.inputTokens, price.inputMicros)
      + amountMicros(record.cacheReadTokens, price.cacheMicros)
      + amountMicros(record.outputTokens, price.outputMicros)
    record.amountMicros = amount
    byModelMicros[model] = amount
    byModel[model] = amount / MICRO
    addCurrencyMicros(byCurrency, price.currency, amount)
    records.push(record)
  }

  const totals = currencyTotals(byCurrency)
  return {
    currency: totals.currency,
    totalMicros: totals.totalMicros,
    total: totals.total,
    mixedCurrency: totals.mixedCurrency,
    byCurrency,
    byModel,
    byModelMicros,
    records,
    unpriced,
    // "Complete" means every recorded model has a price. A usage record with no
    // model attribution at all also cannot be called complete.
    complete: unpriced.length === 0 && records.length > 0,
  }
}

/**
 * Price a run and each of its subtasks.
 *
 * Subtask costs cover only the worker children; planner and aggregator calls
 * are part of the run total but belong to no subtask. A subtask without a
 * readable usage log keeps `cost: null` rather than a fabricated zero.
 *
 * @param {object} run - run record with `usage`, `subtasks`.
 * @param {object | undefined} pricing - configured price table.
 * @returns {object | null} the run cost.
 */
export function applyCost(run, pricing) {
  if (!run || typeof run !== 'object') return null
  run.cost = computeCost(run.usage, pricing)
  for (const subtask of run.subtasks ?? []) {
    subtask.cost = computeCost(subtask?.usage, pricing)
  }
  return run.cost
}

/**
 * Integer micro-units for a cost object, accepting a legacy `total` number.
 * @param {{ totalMicros?: number, total?: number } | number} cost - cost record.
 * @returns {number} micro-units, or NaN.
 */
function microsOf(cost) {
  if (typeof cost === 'number') {
    return Number.isFinite(cost) ? Math.round(cost * MICRO) : Number.NaN
  }
  if (cost && Number.isFinite(cost.totalMicros)) return Math.trunc(cost.totalMicros)
  if (cost && Number.isFinite(cost.total)) return Math.round(cost.total * MICRO)
  return Number.NaN
}

/**
 * Render integer micro-units with one rounding, half-up, at the shown precision.
 *
 * Four decimals below one currency unit, two above it; a positive amount
 * smaller than the smallest shown value is marked as such instead of printed
 * as zero.
 *
 * @param {number} micros - integer micro-units.
 * @param {string} [currency] - ISO currency code.
 * @returns {string} e.g. `¥0.1016`, `$1.24`, `<¥0.0001`, `—`.
 */
export function moneyOfMicros(micros, currency = 'USD') {
  const symbol = currencySymbol(currency)
  if (!Number.isFinite(micros)) return '—'
  if (micros === 0) return `${symbol}0`
  const value = Math.abs(micros)
  if (value < SMALLEST_SHOWN_MICROS) return `<${symbol}0.0001`
  const digits = value < MICRO ? 4 : 2
  const step = 10 ** (6 - digits)
  const rounded = Math.floor((value + step / 2) / step) * step
  const whole = Math.floor(rounded / MICRO)
  const fraction = String(rounded % MICRO).padStart(6, '0').slice(0, digits)
  return `${micros < 0 ? '-' : ''}${symbol}${whole}.${fraction}`
}

/**
 * Format a cost record (or a bare amount) for display.
 *
 * A cost that holds more than one currency is shown as one amount per
 * currency; it is never collapsed into a single cross-currency number.
 *
 * @param {{ totalMicros?: number, total?: number, currency?: string, byCurrency?: Record<string, number> } | number | null} cost - cost.
 * @param {string} [currency] - fallback currency code.
 * @returns {string} formatted money, or `—` when unknown.
 */
export function formatMoney(cost, currency) {
  const tally = cost && typeof cost === 'object' ? cost.byCurrency : null
  if (tally && typeof tally === 'object' && Object.keys(tally).length > 1) return formatCurrencyTally(tally)
  const code = (cost && typeof cost === 'object' && cost.currency) || currency || 'USD'
  return moneyOfMicros(microsOf(cost), code)
}
