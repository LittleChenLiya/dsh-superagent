/**
 * Append-only spend ledger.
 *
 * One JSON line per run under `<stateDir>/ledger.jsonl`. Each line is
 * self-contained: the unit price that was in effect, the tokens it was applied
 * to, and the resulting amount. A later configuration change — even deleting
 * the whole price table — cannot rewrite history, because reading the ledger
 * never consults the price table.
 *
 * The ledger is not the source of truth for a run's state; run files are. It is
 * a time-series view for "what did the last N days cost", so a missing or
 * unreadable line degrades the view instead of breaking a run.
 *
 * @module dsh-superagent/ledger
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { addCurrencyMicros, currencyTotals } from './cost.js'
import { TERMINAL_STATUSES } from './store.js'

const LEDGER_VERSION = 1

/** Parse a range boundary into epoch milliseconds, or null when unusable. */
function timeOf(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

/** Fingerprint of what a run's ledger line would record, for idempotence. */
function fingerprintOf(run) {
  return [
    run.status ?? '',
    run.finishedAt ?? '',
    run.usage?.modelCalls ?? 0,
    run.cost?.totalMicros ?? JSON.stringify(run.cost?.byCurrency ?? ''),
  ].join('|')
}

/** Total model calls and tokens recorded in one ledger line. */
function lineTotals(entry) {
  let calls = 0
  let tokens = 0
  for (const model of entry.models ?? []) {
    calls += Number(model.calls) || 0
    tokens += (Number(model.inputTokens) || 0)
      + (Number(model.outputTokens) || 0)
      + (Number(model.cacheReadTokens) || 0)
  }
  return { calls, tokens }
}

/**
 * Build a ledger bound to one state root.
 *
 * @param {string} root - absolute state root (the run store's root).
 * @param {{ warn?: (message: string) => void }} [options] - diagnostics sink.
 */
export function createLedger(root, options = {}) {
  const warn = options.warn ?? (() => {})
  const file = path.join(root, 'ledger.jsonl')
  /** runId -> fingerprint of the last written line. Loaded on first use. */
  let written = null

  async function load() {
    if (written) return written
    written = new Map()
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`ledger: cannot read ${file}: ${error?.message ?? error}`)
      return written
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        // A torn tail is what a killed writer leaves behind; the rest of the
        // ledger is still valid and must stay readable.
        continue
      }
      if (!entry || typeof entry !== 'object' || typeof entry.runId !== 'string') continue
      // Older lines may predate the stored fingerprint; reconstructing it from
      // the line itself is enough to avoid appending the same run again.
      written.set(entry.runId, entry.fingerprint ?? [
        entry.status ?? '',
        entry.at ?? '',
        entry.calls ?? lineTotals(entry).calls,
        entry.totalMicros ?? '',
      ].join('|'))
    }
    return written
  }

  /**
   * Append one run's spend if it is terminal, priced, and not already recorded.
   *
   * @param {object} run - run record, as read from the store.
   * @returns {Promise<boolean>} true when a line was appended.
   */
  async function record(run) {
    if (!run || typeof run !== 'object' || typeof run.id !== 'string') return false
    if (!TERMINAL_STATUSES.has(run.status)) return false
    if (!run.usage || !run.usage.modelCalls) return false
    const cost = run.cost
    // A legacy run priced before per-model records existed has no unit prices
    // to store; inventing them would defeat the point of the ledger.
    if (!cost || !Array.isArray(cost.records) || cost.records.length === 0) return false

    const known = await load()
    const fingerprint = fingerprintOf(run)
    if (known.get(run.id) === fingerprint) return false

    const finished = timeOf(run.finishedAt ?? run.updatedAt) ?? Date.now()
    const entry = {
      v: LEDGER_VERSION,
      at: new Date(finished).toISOString(),
      runId: run.id,
      fingerprint,
      status: String(run.status),
      calls: run.usage.modelCalls ?? 0,
      tokens: run.usage.totalTokens
        ?? (run.usage.inputTokens ?? 0) + (run.usage.cacheReadTokens ?? 0) + (run.usage.outputTokens ?? 0),
      currency: cost.currency ?? (cost.mixedCurrency ? null : 'USD'),
      totalMicros: Number.isFinite(cost.totalMicros)
        ? cost.totalMicros
        : (Number.isFinite(cost.total) ? Math.round(cost.total * 1e6) : null),
      total: Number.isFinite(cost.total) ? cost.total : (Number.isFinite(cost.totalMicros) ? cost.totalMicros / 1e6 : null),
      // A mixed-currency run has no single number; the per-currency amounts
      // travel with the line so a later summary can still add them correctly.
      byCurrency: cost.byCurrency && typeof cost.byCurrency === 'object' ? { ...cost.byCurrency } : {},
      complete: cost.complete === true,
      unpriced: Array.isArray(cost.unpriced) ? [...cost.unpriced] : [],
      models: cost.records.map(model => ({
        model: String(model.model),
        calls: Number(model.calls) || 0,
        inputTokens: Number(model.inputTokens) || 0,
        outputTokens: Number(model.outputTokens) || 0,
        cacheReadTokens: Number(model.cacheReadTokens) || 0,
        inputPrice: Number.isFinite(model.inputPrice) ? model.inputPrice : null,
        outputPrice: Number.isFinite(model.outputPrice) ? model.outputPrice : null,
        cachePrice: Number.isFinite(model.cachePrice) ? model.cachePrice : null,
        amountMicros: Number.isFinite(model.amountMicros) ? model.amountMicros : null,
      })),
    }

    try {
      await fsp.mkdir(root, { recursive: true })
      await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      warn(`ledger: cannot append to ${file}: ${error?.message ?? error}`)
      return false
    }
    known.set(run.id, fingerprint)
    return true
  }

  /**
   * Read ledger lines in file order, keeping the last line per run.
   * @param {{ since?: number | string | Date, until?: number | string | Date }} [range] - time window.
   * @returns {Promise<object[]>} entries.
   */
  async function read(range = {}) {
    const since = timeOf(range.since)
    const until = timeOf(range.until)
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`ledger: cannot read ${file}: ${error?.message ?? error}`)
      return []
    }
    const latest = new Map()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (!entry || typeof entry !== 'object' || typeof entry.runId !== 'string') continue
      // Insertion order is preserved on re-set, so the last line for a run is
      // also the one that appears last in the returned list.
      latest.set(entry.runId, entry)
    }
    return [...latest.values()].filter(entry => {
      const at = timeOf(entry.at)
      if (at === null) return false
      if (since !== null && at < since) return false
      if (until !== null && at > until) return false
      return true
    })
  }

  /**
   * Summarise spend over a time range.
   *
   * Totals are integer micro-units; `total` is only a convenience for callers
   * that need a number. `priced` counts runs with at least one priced model,
   * and `unpricedRuns` counts runs whose figure is a lower bound.
   *
   * @param {{ since?: number | string | Date, until?: number | string | Date }} [range] - window.
   * @returns {Promise<object>} summary.
   */
  async function summarize(range = {}) {
    const entries = await read(range)
    const byModel = {}
    const byCurrency = {}
    let calls = 0
    let tokens = 0
    let priced = 0
    let unpricedRuns = 0
    let start = null
    let end = null
    for (const entry of entries) {
      const totals = lineTotals(entry)
      calls += Number(entry.calls) || totals.calls
      tokens += Number(entry.tokens) || totals.tokens
      // New lines carry the per-currency split. A line written before that
      // field existed has one currency and one total, which is still exact.
      const lineByCurrency = entry.byCurrency && typeof entry.byCurrency === 'object'
        && Object.keys(entry.byCurrency).length > 0
        ? entry.byCurrency
        : (entry.currency ? { [entry.currency]: Number(entry.totalMicros) || 0 } : {})
      for (const [code, micros] of Object.entries(lineByCurrency)) {
        addCurrencyMicros(byCurrency, code, Number(micros) || 0)
      }
      const models = Array.isArray(entry.models) ? entry.models : []
      const hasPriced = models.some(model => Number.isFinite(model.amountMicros))
      if (hasPriced) priced += 1
      if (entry.complete !== true) unpricedRuns += 1
      const at = timeOf(entry.at)
      if (at !== null) {
        start = start === null ? at : Math.min(start, at)
        end = end === null ? at : Math.max(end, at)
      }
      for (const model of models) {
        const target = byModel[model.model] ?? (byModel[model.model] = {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          amountMicros: 0,
          priced: false,
        })
        target.calls += Number(model.calls) || 0
        target.inputTokens += Number(model.inputTokens) || 0
        target.outputTokens += Number(model.outputTokens) || 0
        target.cacheReadTokens += Number(model.cacheReadTokens) || 0
        if (Number.isFinite(model.amountMicros)) {
          target.amountMicros += model.amountMicros
          target.priced = true
        }
      }
    }
    const totals = currencyTotals(byCurrency)
    return {
      runs: entries.length,
      priced,
      unpricedRuns,
      calls,
      tokens,
      totalMicros: totals.totalMicros,
      total: totals.total,
      byModel,
      byCurrency,
      currency: totals.currency,
      mixedCurrency: totals.mixedCurrency,
      start,
      end,
    }
  }

  return { file, record, read, summarize }
}
