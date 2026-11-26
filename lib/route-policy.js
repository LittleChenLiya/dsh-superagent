/**
 * Deterministic, model-free route selection.
 *
 * The policy filters an explicit catalog by role, complexity, capabilities,
 * availability and whitelist, then chooses the cheapest fully priced route.
 * Equal-cost routes are ordered by their provider/model id, so catalog and
 * object insertion order cannot change a decision. No network or LLM calls are
 * made here. Existing per-role run decisions are pinned: fallback is allowed
 * before a role starts, never silently in the middle of that role.
 *
 * @module dsh-superagent/route-policy
 */
import { estimateCost } from './cost-center.js'

const ROLES = new Set(['planner', 'worker', 'reviewer', 'aggregator'])
const COMPLEXITIES = new Set(['low', 'medium', 'high'])
const ROLE_CAPABILITIES = {
  planner: ['planning', 'reasoning'],
  worker: ['coding'],
  reviewer: ['review'],
  aggregator: ['summarization'],
}
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0
const CAPABILITY_ALIASES = {
  code: 'coding', implementation: 'coding', tools: 'tool-use', tool: 'tool-use',
  plan: 'planning', analysis: 'reasoning', summary: 'summarization', aggregation: 'summarization',
}

function capabilitiesOf(value) {
  const values = Array.isArray(value) ? value
    : value && typeof value === 'object' ? Object.keys(value).filter(key => value[key]) : []
  return new Set(values.map(item => String(item).trim().toLowerCase())
    .filter(Boolean).map(item => CAPABILITY_ALIASES[item] ?? item))
}

function complexityOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value <= 3 ? 'low' : value <= 7 ? 'medium' : 'high'
  const text = String(value ?? 'medium').trim().toLowerCase()
  const alias = { simple: 'low', trivial: 'low', moderate: 'medium', normal: 'medium', complex: 'high' }[text]
  const result = alias ?? text
  if (!COMPLEXITIES.has(result)) throw new TypeError('complexity must be low, medium, high, or a finite number')
  return result
}

function routeId(entry) {
  const model = String(entry.model ?? entry.id ?? '').trim()
  if (!model) return null
  const provider = String(entry.provider ?? '').trim()
  return provider ? `${provider}/${model}` : model
}

function bareId(route) {
  const slash = route.indexOf('/')
  return slash < 0 ? route : route.slice(slash + 1)
}

function providerOf(route) {
  const slash = route.indexOf('/')
  return slash < 0 ? null : route.slice(0, slash)
}

function normalizeCatalog(models, pricing) {
  let entries
  if (Array.isArray(models)) entries = models
  else if (models && typeof models === 'object') {
    entries = Object.entries(models).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      // Also accept the nested provider -> model shape used by price tables.
      const rowFields = new Set(['input', 'output', 'cacheRead', 'cache', 'currency', 'capabilities',
        'available', 'provider', 'model', 'maxContextTokens', 'pricing', 'pricingVersion'])
      const nestedProvider = !Object.keys(value).some(key => rowFields.has(key))
        && Object.values(value).some(item => item && typeof item === 'object' && !Array.isArray(item))
      if (nestedProvider) {
        return Object.entries(value).map(([model, config]) => ({ provider: key, model, ...config }))
      }
      const slash = key.indexOf('/')
      return [{ ...(slash > 0 ? { provider: key.slice(0, slash) } : {}), model: slash > 0 ? key.slice(slash + 1) : key, ...value }]
    })
  } else {
    // With no explicit catalog, usable price rows are the available catalog.
    entries = Object.entries(pricing ?? {}).flatMap(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      if (!Number.isFinite(value.input) || !Number.isFinite(value.output)) return []
      const slash = key.indexOf('/')
      return [{ ...value, ...(slash > 0 ? { provider: key.slice(0, slash) } : {}), model: slash > 0 ? key.slice(slash + 1) : key }]
    })
  }
  const unique = new Map()
  for (const entry of entries) {
    const id = routeId(entry)
    if (id) unique.set(id, entry)
  }
  return [...unique.entries()].sort(([a], [b]) => compareText(a, b)).map(([id, entry]) => ({ id, entry }))
}

function whitelistOf(value) {
  if (value == null) return null
  if (!Array.isArray(value) && typeof value !== 'object') throw new TypeError('model whitelist must be an array')
  const items = Array.isArray(value) ? value : Object.keys(value).filter(key => value[key])
  return new Set(items.map(item => typeof item === 'string' ? item : routeId(item)).filter(Boolean))
}

function pinnedRoute(request) {
  const explicit = request.currentRoute
  if (explicit) return typeof explicit === 'string' ? explicit : routeId(explicit)
  const routes = request.run?.routes ?? request.run?.routeDecisions
  const pinned = routes?.[request.role]
  if (pinned) return typeof pinned === 'string' ? pinned : routeId(pinned)
  const legacy = request.run?.route ?? request.run?.routeDecision
  if (legacy && (!legacy.role || legacy.role === request.role)) return typeof legacy === 'string' ? legacy : routeId(legacy)
  return null
}

function blocked(status, reason, extra = {}) {
  return { ok: false, status, reason, provider: null, model: null, route: null,
    pricingVersion: extra.pricingVersion ?? null, estimatedMicros: null, ...extra }
}

/**
 * Build a reusable deterministic policy.
 *
 * @param {{ pricing?: object, pricingVersion?: string, models?: object[]|object,
 *   providers?: object, budgets?: Record<string, number>, costCenter?: object,
 *   allowFallback?: boolean, roleRules?: object }} [options] - catalog and policy.
 */
export function createRoutePolicy(options = {}) {
  const pricing = options.pricing ?? {}
  const pricingVersion = String(options.pricingVersion ?? pricing.pricingVersion ?? 'unversioned')
  const catalog = normalizeCatalog(options.models, pricing)
  const providers = options.providers ?? {}
  const allowFallback = options.allowFallback !== false

  async function budgetVerdict(candidate, request) {
    const budget = candidate.estimate.currency
    if (options.costCenter) {
      const verdict = await options.costCenter.check({ ...request, currency: budget,
        amountMicros: candidate.estimate.estimatedMicros })
      return verdict.ok ? null : verdict
    }
    if (request.budgets ?? options.budgets) {
      const configured = (request.budgets ?? options.budgets)?.[budget]
      if (!Number.isSafeInteger(configured) || configured < 0) {
        return { status: 'budget-not-configured', reason: `no budget configured for ${budget}` }
      }
      if (candidate.estimate.estimatedMicros > configured) {
        return { status: 'insufficient-budget', reason: 'estimated route cost exceeds the configured budget' }
      }
    }
    return null
  }

  /** Select one route for a role at the start of that role's work. */
  async function route(request) {
    const role = String(request.role ?? '').trim().toLowerCase()
    if (!ROLES.has(role)) return blocked('invalid-role', 'role must be planner, worker, reviewer, or aggregator', { pricingVersion })
    const complexity = complexityOf(request.complexity)
    const required = new Set([
      ...capabilitiesOf(ROLE_CAPABILITIES[role]),
      ...capabilitiesOf(options.roleRules?.[role]?.[complexity]),
      ...capabilitiesOf(request.requiredCapabilities ?? request.capabilities),
    ])
    if (complexity === 'high') required.add('reasoning')
    const allowedModels = whitelistOf(request.allowedModels)
    const allowedProviders = whitelistOf(request.allowedProviders)
    const resolveId = value => {
      if (!value) return null
      const id = typeof value === 'string' ? value : routeId(value)
      if (!id || id.includes('/')) return id
      const matches = catalog.filter(candidate => bareId(candidate.id) === id)
      return matches.length === 1 ? matches[0].id : id
    }
    const preferred = resolveId(request.preferredModel)
    const pinned = resolveId(pinnedRoute(request))
    const estimates = request.estimatedTokens ?? {}
    const tokens = typeof estimates === 'number'
      ? { inputTokens: estimates }
      : { inputTokens: estimates.inputTokens ?? request.inputTokens ?? 0,
        outputTokens: estimates.outputTokens ?? request.outputTokens ?? 0,
        cacheReadTokens: estimates.cacheReadTokens ?? request.cacheReadTokens ?? 0 }
    const rejected = []
    const candidates = []

    for (const { id, entry } of catalog) {
      const provider = providerOf(id)
      const model = bareId(id)
      const providerAvailable = !provider || providers[provider]?.available !== false
      if (entry.available === false || providerAvailable === false) {
        rejected.push({ route: id, status: 'model-unavailable', reason: 'provider or model is unavailable' })
        continue
      }
      if (allowedModels && !allowedModels.has(id) && !allowedModels.has(model)) {
        rejected.push({ route: id, status: 'not-whitelisted', reason: 'route is not in allowedModels' })
        continue
      }
      if (allowedProviders && !allowedProviders.has(provider)) {
        rejected.push({ route: id, status: 'not-whitelisted', reason: 'provider is not in allowedProviders' })
        continue
      }
      const capabilities = capabilitiesOf(entry.capabilities)
      const missing = [...required].filter(capability => !capabilities.has(capability)).sort()
      if (missing.length) {
        rejected.push({ route: id, status: 'insufficient-capability', reason: `missing capabilities: ${missing.join(', ')}`, missing })
        continue
      }
      const contextTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens
      if (Number.isFinite(entry.maxContextTokens) && contextTokens > entry.maxContextTokens) {
        rejected.push({ route: id, status: 'context-overflow', reason: 'estimated tokens exceed the model context window' })
        continue
      }
      const estimate = estimateCost({ provider: provider ?? undefined, model, pricing: entry.pricing ?? pricing, ...tokens })
      if (!estimate.ok) {
        rejected.push({ route: id, status: 'missing-price', reason: estimate.reason })
        continue
      }
      candidates.push({ id, provider, model, entry, estimate })
    }

    // A pinned decision is checked, never replaced. Report its unavailability
    // or missing price instead of quietly routing the same role elsewhere.
    if (pinned) {
      const current = candidates.find(candidate => candidate.id === pinned)
      if (!current) {
        const failure = rejected.find(item => item.route === pinned)
        return blocked(failure?.status ?? 'model-unavailable', failure?.reason ?? 'pinned route is not selectable',
          { pricingVersion, pinnedRoute: pinned, locked: true, rejected })
      }
      const pinnedBudget = await budgetVerdict(current, request)
      if (pinnedBudget) return blocked(pinnedBudget.status, pinnedBudget.reason,
        { pricingVersion, pinnedRoute: pinned, locked: true, currency: current.estimate.currency,
          estimatedMicros: current.estimate.estimatedMicros, rejected })
      return { ok: true, status: 'selected', provider: current.provider, model: current.model, route: current.id,
        pricingVersion: current.entry.pricingVersion ?? pricingVersion, estimatedMicros: current.estimate.estimatedMicros,
        currency: current.estimate.currency, role, complexity, requiredCapabilities: [...required].sort(),
        reason: 'pinned route retained for this run role; no mid-run switch', locked: true, candidates: candidates.length, rejected }
    }

    if (!candidates.length) {
      const statuses = new Set(rejected.map(item => item.status))
      const status = statuses.has('missing-price') ? 'missing-price'
        : statuses.has('model-unavailable') ? 'model-unavailable'
          : statuses.has('not-whitelisted') ? 'not-whitelisted'
            : statuses.has('context-overflow') ? 'context-overflow'
              : statuses.has('insufficient-capability') ? 'insufficient-capability' : 'no-candidate'
      return blocked(status, `no eligible fully priced route for ${role}/${complexity}`,
        { pricingVersion, role, complexity, requiredCapabilities: [...required].sort(), rejected })
    }

    const preferredCandidate = candidates.find(candidate => candidate.id === preferred)
    candidates.sort((a, b) => (preferredCandidate && allowFallback
      ? Number(b.id === preferred) - Number(a.id === preferred) : 0)
      || a.estimate.estimatedMicros - b.estimate.estimatedMicros || compareText(a.id, b.id))
    if (preferred && !preferredCandidate) {
      const failure = rejected.find(item => item.route === preferred)
      if (!allowFallback) return blocked(failure?.status ?? 'fallback-disabled',
        failure?.reason ?? 'preferred route cannot be selected and fallback is disabled',
        { pricingVersion, role, complexity, preferredRoute: preferred, rejected })
    }

    let budgetFailure = null
    for (const candidate of candidates) {
      const failure = await budgetVerdict(candidate, request)
      if (failure) {
        budgetFailure ??= failure
        continue
      }
      const chosen = candidate
      return { ok: true, status: 'selected', provider: chosen.provider, model: chosen.model, route: chosen.id,
        pricingVersion: chosen.entry.pricingVersion ?? pricingVersion,
        estimatedMicros: chosen.estimate.estimatedMicros, currency: chosen.estimate.currency,
        role, complexity, requiredCapabilities: [...required].sort(), locked: false,
        reason: preferredCandidate && preferredCandidate.id === candidate.id
          ? 'preferred route selected within capability, availability and budget constraints'
          : candidates.length > 1 ? 'cheapest eligible fully priced route; ties use provider/model order'
            : 'only eligible fully priced route',
        candidates: candidates.length, rejected }
    }

    return blocked(budgetFailure?.status ?? 'insufficient-budget',
      budgetFailure?.reason ?? 'all eligible routes exceed the available budget',
      { pricingVersion, role, complexity, currency: candidates[0].estimate.currency,
        estimatedMicros: candidates[0].estimate.estimatedMicros, rejected })
  }

  return { route, decide: route, pricingVersion }
}
