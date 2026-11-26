/**
 * Read-only capability discovery plus the three host-owned MCP controls.
 *
 * The adapter never manufactures a connector registry and never copies manager
 * configuration into its public views. In particular, transport env/headers/URLs
 * and credential or authorization payloads stay inside their host services.
 *
 * @module dsh-superagent/capability-center
 */

const OWN = Object.prototype.hasOwnProperty
const DEFAULT_PLUGIN_SERVERS = new Set(['superagent-memory'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function resolveService(value) {
  return typeof value === 'function' ? value() : value
}

function safeString(value, maxLength = 256) {
  return typeof value === 'string' && value.trim() && value.length <= maxLength ? value : null
}

function revisionOf(value) {
  return Number.isSafeInteger(value) && value >= 0 || safeString(value, 128) ? value : null
}

function statusOf(value) {
  let status = value
  if (isRecord(status)) status = status.status ?? status.state ?? value
  if (isRecord(status)) status = status.state ?? status.status
  return safeString(status, 64)
}

function nameOf(value) {
  if (!isRecord(value)) return null
  return safeString(value.serverName ?? value.name ?? value.id, 128)
}

function entriesOf(value, keys = ['items', 'entries', 'servers', 'skills', 'grants', 'credentials', 'authorizations', 'permissions', 'connectors']) {
  if (Array.isArray(value)) return value
  if (value instanceof Map) {
    return [...value].map(([name, entry]) => (
      isRecord(entry) && nameOf(entry) === null ? { ...entry, name } : entry
    ))
  }
  if (!isRecord(value)) return []
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key]
    if (value[key] instanceof Map || isRecord(value[key])) return entriesOf(value[key], keys)
  }
  if (nameOf(value)) return [value]
  return Object.entries(value).map(([name, entry]) => (
    isRecord(entry) && nameOf(entry) === null ? { ...entry, name } : entry
  ))
}

function copyPublicFields(record, fields, arrayFields = []) {
  const output = {}
  const requestedArrays = new Set(arrayFields)
  for (const field of fields) {
    const value = record?.[field]
    if (typeof value === 'boolean' || Number.isFinite(value)) output[field] = value
    else if (typeof value === 'string' && value.length <= 512) output[field] = value
    else if (requestedArrays.has(field) && Array.isArray(value)) {
      const items = value.filter(item => (
        typeof item === 'boolean' || Number.isFinite(item)
        || typeof item === 'string' && item.length <= 512
      ))
      if (items.length > 0) output[field] = items.slice(0, 100)
    }
  }
  return output
}

/** An error whose message and details are safe to return across the adapter. */
export class CapabilityCenterError extends Error {
  constructor(statusCode, code, details = {}) {
    super(code)
    this.name = 'CapabilityCenterError'
    this.status = statusCode
    this.statusCode = statusCode
    this.code = code
    for (const [key, value] of Object.entries(details)) {
      if (key === 'expectedSettingsRevision' || key === 'actualSettingsRevision') {
        const revision = revisionOf(value)
        if (revision !== null) this[key] = revision
      } else if (typeof value === 'boolean' || Number.isSafeInteger(value) || safeString(value, 128)) {
        this[key] = value
      }
    }
  }
}

function unavailable(code, statusCode = 503) {
  throw new CapabilityCenterError(statusCode, code)
}

function pluginOwned(record) {
  if (!isRecord(record)) return false
  if (record.pluginOwned === true || record.registeredByPlugin === true || record.ownerKind === 'plugin') return true
  const owner = record.owner ?? record.ownedBy ?? record.registrationOwner
  if (isRecord(owner)) {
    return owner.kind === 'plugin' || owner.type === 'plugin' || owner.plugin === true
      || typeof owner.plugin === 'string' && owner.plugin.length > 0
      || typeof owner.name === 'string' && /plugin/i.test(owner.name)
  }
  if (typeof owner === 'string' && /(^|[:._-])plugin($|[:._-])/i.test(owner)) return true
  const source = record.source ?? record.origin
  if (isRecord(source)) return source.kind === 'plugin' || source.type === 'plugin'
  return typeof source === 'string' && /(^|[:._-])plugin($|[:._-])/i.test(source)
}

function ownerLabel(record) {
  const owner = record?.owner ?? record?.ownedBy ?? record?.registrationOwner
  if (typeof owner === 'string') return safeString(owner, 128)
  if (isRecord(owner)) return safeString(owner.kind ?? owner.type ?? owner.name, 128)
  return null
}

function publicSkill(record) {
  if (!isRecord(record)) return null
  const name = nameOf(record)
  if (!name) return null
  const status = statusOf(record)
  return {
    name,
    ...copyPublicFields(record, ['id', 'description', 'version', 'scope', 'enabled']),
    ...(safeString(record.source, 128) ? { source: record.source } : {}),
    ...(status ? { status } : {}),
    ...(ownerLabel(record) ? { owner: ownerLabel(record) } : {}),
    pluginOwned: pluginOwned(record),
  }
}

function publicGrant(record, source) {
  if (!isRecord(record)) return null
  const fields = source === 'permissions'
    ? ['id', 'name', 'resource', 'action', 'effect', 'scope', 'createdAt', 'updatedAt']
    : ['id', 'name', 'provider', 'kind', 'type', 'clientId', 'scopes', 'createdAt', 'updatedAt', 'expiresAt', 'lastUsedAt', 'configured']
  const output = { source, ...copyPublicFields(record, fields, source === 'permissions' ? [] : ['scopes']) }
  const status = statusOf(record)
  if (status) output.status = status
  return Object.keys(output).length > 1 ? output : null
}

function publicConnector(record) {
  if (!isRecord(record)) return null
  const name = nameOf(record)
  if (!name) return null
  const status = statusOf(record)
  return {
    name,
    ...copyPublicFields(record, ['id', 'kind', 'type', 'provider', 'enabled']),
    ...(status ? { status } : {}),
    ...(ownerLabel(record) ? { owner: ownerLabel(record) } : {}),
  }
}

function unwrapSetting(value) {
  if (isRecord(value) && OWN.call(value, 'value')) {
    return { value: value.value, revision: revisionOf(value.revision ?? value.settingsRevision) }
  }
  return { value, revision: null }
}

function serversFromSettings(value) {
  const unwrapped = unwrapSetting(value).value
  if (isRecord(unwrapped) && OWN.call(unwrapped, 'servers')) return unwrapped.servers
  if (isRecord(unwrapped) && isRecord(unwrapped.mcp)) return unwrapped.mcp.servers
  if (isRecord(unwrapped) && OWN.call(unwrapped, 'mcpServers')) return unwrapped.mcpServers
  if (isRecord(unwrapped) && OWN.call(unwrapped, 'mcp.servers')) return unwrapped['mcp.servers']
  return unwrapped
}

function rawSettings(value) {
  return isRecord(value) && (isRecord(value.mcp) || OWN.call(value, 'mcpServers') || OWN.call(value, 'mcp.servers'))
}

function operationResult(value, name) {
  if (!isRecord(value)) return { name, ok: true }
  const status = statusOf(value)
  return {
    name,
    ok: value.ok !== false,
    ...copyPublicFields(value, ['latencyMs', 'durationMs', 'toolCount', 'serverCount']),
    ...(status ? { status } : {}),
    ...(value.ok === false ? { error: 'MCP_OPERATION_FAILED' } : {}),
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.ctx] Cordis context used for lazy host service lookup.
 * @param {object} [options.services] Explicit host services (also accepted at top level).
 * @returns {{snapshot: Function, watch: Function, probe: Function, restart: Function, setEnabled: Function, execute: Function, dispose: Function}}
 */
export function createCapabilityCenterAdapter(options = {}) {
  if (!isRecord(options)) throw new TypeError('capability center options must be an object')
  const services = isRecord(options.services) ? options.services : {}
  const log = typeof options.log === 'function' ? options.log : () => {}

  function getService(name) {
    for (const source of [options, services]) {
      if (OWN.call(source, name)) return resolveService(source[name])
    }
    if (typeof options.ctx?.get === 'function') {
      try {
        const service = options.ctx.get(name)
        if (service) return resolveService(service)
      } catch { /* try the direct-context fallback */ }
    }
    try {
      return resolveService(options.ctx?.[name])
    } catch {
      return null
    }
  }

  const skillService = () => getService('skills')
  const managerService = () => getService('mcpManager')
  const settingsService = () => getService('settings')
  const credentialService = () => getService('credentials') ?? getService('credentials/authorization')
  const authorizationService = () => getService('authorization')
  const permissionService = () => getService('permissions')
  const connectorService = () => getService('connectorRegistry') ?? getService('connectors')
  const configuredPluginServers = new Set([
    ...DEFAULT_PLUGIN_SERVERS,
    ...(Array.isArray(options.pluginServerNames) ? options.pluginServerNames : []),
    ...(Array.isArray(options.ownedServers) ? options.ownedServers : []),
  ])

  let localRevision = revisionOf(options.settingsRevision) ?? 0
  let lastHostRevision = null
  let preferLocalRevision = false
  let disposed = false
  let hostWatchDisposer = null
  let watchSubscribed = false
  let watchStarting = false
  let watchChain = Promise.resolve()
  const watchers = new Set()

  function diagnostic(code) {
    try { log(code) } catch { /* diagnostics are best effort */ }
  }

  async function readCollection(service, methodNames) {
    for (const method of methodNames) {
      if (typeof service?.[method] === 'function') return await service[method]()
    }
    return null
  }

  async function readSkills() {
    const service = skillService()
    if (typeof service?.snapshot !== 'function') return { supported: false, items: [], duplicates: [] }
    try {
      const records = entriesOf(await service.snapshot(), ['skills', 'items', 'entries'])
      const items = records.map(publicSkill).filter(Boolean)
      const counts = new Map()
      for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1)
      const duplicates = [...counts].filter(([, count]) => count > 1).map(([name, count]) => ({ name, count }))
      return { supported: true, items, duplicates }
    } catch {
      diagnostic('capability center: skills snapshot failed')
      return { supported: false, items: [], duplicates: [], error: 'SERVICE_UNAVAILABLE' }
    }
  }

  async function readSettingsState() {
    let service = settingsService()
    let wrapped = { value: undefined, revision: null }
    let supported = OWN.call(options, 'mcpServers') || service !== null && service !== undefined
    try {
      if (OWN.call(options, 'mcpServers')) wrapped = { value: options.mcpServers, revision: null }
      else if (typeof service?.get === 'function') {
        wrapped = unwrapSetting(await service.get('mcp.servers'))
        if (wrapped.value === undefined && typeof service.getRevision !== 'function') {
          const mcp = unwrapSetting(await service.get('mcp'))
          if (mcp.value !== undefined) wrapped = mcp
        }
      } else if (typeof service?.snapshot === 'function') {
        wrapped = unwrapSetting(await service.snapshot())
      } else if (typeof service?.getAll === 'function') {
        wrapped = unwrapSetting(await service.getAll())
      } else if (rawSettings(service)) wrapped = { value: service, revision: null }

      let hostRevision = wrapped.revision
      if (hostRevision === null && typeof service?.getRevision === 'function') hostRevision = revisionOf(await service.getRevision())
      if (hostRevision === null && typeof service?.revision === 'function') hostRevision = revisionOf(await service.revision())
      if (hostRevision === null && service !== null && service !== undefined) hostRevision = revisionOf(service.revision ?? service.settingsRevision)
      if (hostRevision === null && isRecord(wrapped.value)) hostRevision = revisionOf(wrapped.value.revision ?? wrapped.value.settingsRevision)

      if (hostRevision !== null && hostRevision !== lastHostRevision) {
        lastHostRevision = hostRevision
        localRevision = hostRevision
        preferLocalRevision = false
      }
      return {
        supported,
        service,
        servers: serversFromSettings(wrapped.value),
        revision: preferLocalRevision ? localRevision : hostRevision ?? localRevision,
      }
    } catch {
      diagnostic('capability center: settings read failed')
      return { supported: false, service, servers: undefined, revision: localRevision, error: 'SERVICE_UNAVAILABLE' }
    }
  }

  async function readManagerEntries() {
    const manager = managerService()
    if (!manager) return { manager, supported: false, entries: [] }
    if (typeof manager.list !== 'function') return { manager, supported: false, entries: [] }
    try {
      return { manager, supported: true, entries: entriesOf(await manager.list(), ['servers', 'items', 'entries']) }
    } catch {
      diagnostic('capability center: MCP list failed')
      return { manager, supported: false, entries: [], error: 'SERVICE_UNAVAILABLE' }
    }
  }

  function serverView(name, configuredEntry, registeredEntry) {
    const configured = isRecord(configuredEntry)
    const registered = isRecord(registeredEntry) && registeredEntry.registered !== false
    const settingsEnabled = configured ? configuredEntry.enabled !== false && configuredEntry.disabled !== true : null
    const managerEnabled = registered ? registeredEntry.enabled !== false && registeredEntry.disabled !== true : null
    const enabled = settingsEnabled ?? managerEnabled ?? true
    const owned = pluginOwned(registeredEntry) || pluginOwned(configuredEntry)
      || configuredPluginServers.has(name) && registered
    const status = registered
      ? statusOf(registeredEntry) ?? (enabled ? 'registered' : 'disabled')
      : enabled ? 'configured' : 'disabled'
    const transport = safeString(configuredEntry?.transport ?? registeredEntry?.transport, 64)
    const owner = ownerLabel(registeredEntry) ?? ownerLabel(configuredEntry)
    return {
      name,
      configured,
      registered,
      enabled,
      status,
      manageable: configured && !owned,
      pluginOwned: owned,
      ...(transport ? { transport } : {}),
      ...(owner ? { owner } : {}),
    }
  }

  function mergeServers(settingsServers, managerEntries) {
    const configured = new Map()
    for (const entry of entriesOf(settingsServers, ['servers', 'items', 'entries'])) {
      const name = nameOf(entry)
      if (name && isRecord(entry)) configured.set(name, entry)
    }
    const registered = new Map()
    for (const entry of managerEntries) {
      const name = nameOf(entry)
      if (name && isRecord(entry)) registered.set(name, entry)
    }
    const names = new Set([...configured.keys(), ...registered.keys()])
    return [...names].sort().map(name => serverView(name, configured.get(name), registered.get(name)))
  }

  async function readGrantSource(service, source) {
    if (!service) return { supported: false, items: [] }
    try {
      const value = await readCollection(service, ['list', 'snapshot', 'getAll'])
      if (value === null) return { supported: false, items: [] }
      const records = entriesOf(value, [source === 'credentials' ? 'credentials' : source === 'authorization' ? 'authorizations' : 'permissions', 'items', 'entries', 'grants'])
      const items = records.map(record => publicGrant(record, source)).filter(Boolean)
      return { supported: true, items }
    } catch {
      diagnostic(`capability center: ${source} read failed`)
      return { supported: false, items: [], error: 'SERVICE_UNAVAILABLE' }
    }
  }

  async function readGrants() {
    const [credentials, authorization, permissions] = await Promise.all([
      readGrantSource(credentialService(), 'credentials'),
      readGrantSource(authorizationService(), 'authorization'),
      readGrantSource(permissionService(), 'permissions'),
    ])
    const sources = { credentials, authorization, permissions }
    return {
      supported: Object.values(sources).some(source => source.supported),
      items: Object.values(sources).flatMap(source => source.items),
      sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, {
        supported: source.supported,
        ...(source.error ? { error: source.error } : {}),
      }])),
    }
  }

  async function readConnectors() {
    const service = connectorService()
    if (!service || typeof service.list !== 'function' && typeof service.snapshot !== 'function') {
      return { supported: false, items: [] }
    }
    try {
      const records = entriesOf(await readCollection(service, ['list', 'snapshot']), ['connectors', 'items', 'entries'])
      return { supported: true, items: records.map(publicConnector).filter(Boolean) }
    } catch {
      diagnostic('capability center: connector registry read failed')
      return { supported: false, items: [], error: 'SERVICE_UNAVAILABLE' }
    }
  }

  async function snapshot() {
    const [skills, managerState, settingsState, grants, connectors] = await Promise.all([
      readSkills(),
      readManagerEntries(),
      readSettingsState(),
      readGrants(),
      readConnectors(),
    ])
    const manager = managerState.manager
    return {
      schemaVersion: 1,
      settingsRevision: settingsState.revision,
      skills,
      mcp: {
        supported: Boolean(manager) || settingsState.supported,
        servers: mergeServers(settingsState.servers, managerState.entries),
        watching: watchers.size > 0,
        operations: {
          list: typeof manager?.list === 'function',
          watch: typeof manager?.watch === 'function',
          probe: typeof manager?.probe === 'function',
          restart: typeof manager?.restart === 'function',
          add: canWriteSettings(settingsState),
          setEnabled: canWriteSettings(settingsState),
        },
        ...(managerState.error ? { error: managerState.error } : {}),
        ...(settingsState.error ? { settingsError: settingsState.error } : {}),
      },
      grants,
      connectors,
    }
  }

  function targetOf(input) {
    const request = typeof input === 'string' ? { name: input } : input
    if (!isRecord(request)) unavailable('INVALID_MCP_TARGET', 400)
    const name = safeString(request.name ?? request.serverName ?? request.target, 128)
    if (!name) unavailable('INVALID_MCP_TARGET', 400)
    return { request, name }
  }

  async function currentServer(name) {
    const [managerState, settingsState] = await Promise.all([readManagerEntries(), readSettingsState()])
    if (managerState.error || settingsState.error) unavailable('CAPABILITY_STATE_UNAVAILABLE', 503)
    const server = mergeServers(settingsState.servers, managerState.entries).find(item => item.name === name)
    if (!server) throw new CapabilityCenterError(404, 'MCP_SERVER_NOT_FOUND', { name })
    return { server, manager: managerState.manager, settings: settingsState }
  }

  async function enabledTarget(input) {
    const { name } = targetOf(input)
    const current = await currentServer(name)
    if (!current.server.enabled || current.server.status === 'disabled') {
      throw new CapabilityCenterError(409, 'MCP_SERVER_DISABLED', { name })
    }
    return { ...current, name }
  }

  async function probe(input) {
    const manager = managerService()
    if (typeof manager?.probe !== 'function') unavailable('MCP_PROBE_UNSUPPORTED')
    const { name } = await enabledTarget(input)
    try {
      return operationResult(await manager.probe(name), name)
    } catch {
      diagnostic('capability center: MCP probe failed')
      throw new CapabilityCenterError(502, 'MCP_PROBE_FAILED', { name })
    }
  }

  async function restart(input) {
    const manager = managerService()
    if (typeof manager?.restart !== 'function') unavailable('MCP_RESTART_UNSUPPORTED')
    const { name } = await enabledTarget(input)
    try {
      return operationResult(await manager.restart(name), name)
    } catch {
      diagnostic('capability center: MCP restart failed')
      throw new CapabilityCenterError(502, 'MCP_RESTART_FAILED', { name })
    }
  }

  function canWriteSettings(state) {
    return Boolean(state.service && (typeof state.service.set === 'function'
      || typeof state.service.update === 'function' || typeof state.service.patch === 'function'))
      || OWN.call(options, 'mcpServers') || rawSettings(state.service)
  }

  function updatedServers(container, name, enabled) {
    if (container instanceof Map) {
      const entry = container.get(name)
      if (!isRecord(entry)) return null
      const next = new Map(container)
      next.set(name, { ...entry, enabled })
      return next
    }
    if (Array.isArray(container)) {
      let found = false
      const next = container.map(entry => {
        if (!isRecord(entry) || nameOf(entry) !== name) return entry
        found = true
        return { ...entry, enabled }
      })
      return found ? next : null
    }
    if (isRecord(container)) {
      if (!isRecord(container[name])) return null
      return { ...container, [name]: { ...container[name], enabled } }
    }
    return null
  }

  async function writeServers(state, servers, expectedSettingsRevision) {
    const expected = { expectedSettingsRevision }
    let result
    if (typeof state.service?.set === 'function') result = await state.service.set('mcp.servers', servers, expected)
    else if (typeof state.service?.update === 'function') result = await state.service.update('mcp.servers', servers, expected)
    else if (typeof state.service?.patch === 'function') result = await state.service.patch({ 'mcp.servers': servers }, expected)
    else if (OWN.call(options, 'mcpServers')) options.mcpServers = servers
    else if (rawSettings(state.service)) {
      if (OWN.call(state.service, 'mcpServers')) state.service.mcpServers = servers
      else if (OWN.call(state.service, 'mcp.servers')) state.service['mcp.servers'] = servers
      else state.service.mcp.servers = servers
      if (revisionOf(state.service.revision) !== null) state.service.revision = state.revision + 1
    } else unavailable('SETTINGS_WRITE_UNSUPPORTED')

    const returnedRevision = revisionOf(isRecord(result) ? result.revision ?? result.settingsRevision : result)
    const after = await readSettingsState()
    if (returnedRevision !== null) {
      localRevision = returnedRevision
      lastHostRevision = returnedRevision
      preferLocalRevision = false
      return returnedRevision
    }
    if (after.revision === state.revision && typeof state.revision === 'number') {
      localRevision = state.revision + 1
      preferLocalRevision = true
      return localRevision
    }
    return after.revision
  }

  function normalizeMcpServer(input) {
    if (!isRecord(input)) unavailable('INVALID_MCP_ACTION', 400)
    const allowed = new Set(['transport', 'command', 'args', 'url', 'env', 'headers', 'enabled', 'timeoutMs'])
    for (const key of Object.keys(input)) if (!allowed.has(key)) unavailable('INVALID_MCP_SERVER', 400)
    const transport = input.transport === undefined ? (input.url ? 'http' : 'stdio') : input.transport
    if (!['stdio', 'http', 'sse'].includes(transport)) unavailable('INVALID_MCP_SERVER', 400)
    const server = { transport, enabled: input.enabled !== false }
    if (transport === 'stdio') {
      if (safeString(input.command, 512) !== input.command || !input.command || /[\u0000-\u001f\u007f]/.test(input.command)) {
        unavailable('INVALID_MCP_SERVER', 400)
      }
      server.command = input.command
      if (input.args !== undefined) {
        if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(arg => typeof arg !== 'string' || arg.length > 2000 || /[\u0000-\u001f\u007f]/.test(arg))) {
          unavailable('INVALID_MCP_SERVER', 400)
        }
        server.args = [...input.args]
      }
    } else {
      let url
      try { url = new URL(input.url) } catch { unavailable('INVALID_MCP_SERVER', 400) }
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)
        || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        unavailable('INVALID_MCP_SERVER', 400)
      }
      for (const key of url.searchParams.keys()) {
        if (/token|secret|password|key|credential/i.test(key)) unavailable('MCP_CREDENTIAL_FORBIDDEN', 400)
      }
      server.url = url.toString()
    }
    for (const field of ['env', 'headers']) {
      if (input[field] === undefined) continue
      if (!isRecord(input[field]) || Object.keys(input[field]).length > 100) unavailable('INVALID_MCP_SERVER', 400)
      const values = {}
      for (const [key, value] of Object.entries(input[field])) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string'
          || !/^\$\{[A-Z][A-Z0-9_]*\}$/.test(value)) unavailable('MCP_CREDENTIAL_FORBIDDEN', 400)
        values[key] = value
      }
      server[field] = values
    }
    if (input.timeoutMs !== undefined) {
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 600_000) unavailable('INVALID_MCP_SERVER', 400)
      server.timeoutMs = input.timeoutMs
    }
    return server
  }

  function addedServer(container, name, server) {
    if (container instanceof Map) {
      if (container.has(name)) return null
      const next = new Map(container)
      next.set(name, server)
      return next
    }
    if (Array.isArray(container)) {
      if (container.some(entry => isRecord(entry) && nameOf(entry) === name)) return null
      return [...container, { name, ...server }]
    }
    if (isRecord(container)) {
      if (OWN.call(container, name)) return null
      return { ...container, [name]: server }
    }
    return null
  }

  async function addServer(input) {
    const task = mutationChain.then(async () => {
      if (!isRecord(input)) unavailable('INVALID_MCP_ACTION', 400)
      const { name } = targetOf(input)
      if (configuredPluginServers.has(name)) throw new CapabilityCenterError(409, 'PLUGIN_OWNED_MCP_SERVER', { name })
      const expected = revisionOf(input.expectedSettingsRevision)
      if (expected === null) unavailable('INVALID_SETTINGS_REVISION', 400)
      const server = normalizeMcpServer(input.server)
      const state = await readSettingsState()
      if (expected !== state.revision) {
        throw new CapabilityCenterError(409, 'SETTINGS_REVISION_CONFLICT', {
          name, expectedSettingsRevision: expected, actualSettingsRevision: state.revision,
        })
      }
      if (!canWriteSettings(state)) unavailable('SETTINGS_WRITE_UNSUPPORTED')
      const servers = addedServer(state.servers, name, server)
      if (!servers) throw new CapabilityCenterError(409, 'MCP_SERVER_EXISTS', { name })
      let settingsRevision
      try {
        settingsRevision = await writeServers(state, servers, expected)
      } catch (error) {
        if (error instanceof CapabilityCenterError) throw error
        if (error?.status === 409 || error?.statusCode === 409) {
          const actual = (await readSettingsState()).revision
          throw new CapabilityCenterError(409, 'SETTINGS_REVISION_CONFLICT', {
            name, expectedSettingsRevision: expected, actualSettingsRevision: actual,
          })
        }
        diagnostic('capability center: settings write failed')
        throw new CapabilityCenterError(502, 'SETTINGS_WRITE_FAILED', { name })
      }
      return { ok: true, name, settingsRevision, restartRequired: typeof managerService()?.restart === 'function' }
    })
    mutationChain = task.catch(() => {})
    return task
  }

  let mutationChain = Promise.resolve()
  function setEnabled(input, enabled, expectedSettingsRevision) {
    const request = typeof input === 'string'
      ? { name: input, enabled, expectedSettingsRevision }
      : input
    const task = mutationChain.then(async () => {
      if (!isRecord(request)) unavailable('INVALID_MCP_ACTION', 400)
      const { name } = targetOf(request)
      if (typeof request.enabled !== 'boolean') unavailable('INVALID_MCP_ENABLED', 400)
      const expected = revisionOf(request.expectedSettingsRevision)
      if (expected === null) unavailable('INVALID_SETTINGS_REVISION', 400)
      const current = await currentServer(name)
      if (current.server.pluginOwned) {
        throw new CapabilityCenterError(409, 'PLUGIN_OWNED_MCP_SERVER', { name })
      }
      if (!current.server.configured) {
        throw new CapabilityCenterError(409, 'MCP_SERVER_NOT_SETTINGS_OWNED', { name })
      }
      if (expected !== current.settings.revision) {
        throw new CapabilityCenterError(409, 'SETTINGS_REVISION_CONFLICT', {
          name,
          expectedSettingsRevision: expected,
          actualSettingsRevision: current.settings.revision,
        })
      }
      if (!canWriteSettings(current.settings)) unavailable('SETTINGS_WRITE_UNSUPPORTED')
      const servers = updatedServers(current.settings.servers, name, request.enabled)
      if (!servers) throw new CapabilityCenterError(409, 'MCP_SERVER_NOT_SETTINGS_OWNED', { name })
      let settingsRevision
      try {
        settingsRevision = await writeServers(current.settings, servers, expected)
      } catch (error) {
        if (error instanceof CapabilityCenterError) throw error
        if (error?.status === 409 || error?.statusCode === 409) {
          const actual = (await readSettingsState()).revision
          throw new CapabilityCenterError(409, 'SETTINGS_REVISION_CONFLICT', {
            name,
            expectedSettingsRevision: expected,
            actualSettingsRevision: actual,
          })
        }
        diagnostic('capability center: settings write failed')
        throw new CapabilityCenterError(502, 'SETTINGS_WRITE_FAILED', { name })
      }
      return { ok: true, name, enabled: request.enabled, settingsRevision }
    })
    mutationChain = task.catch(() => {})
    return task
  }

  async function execute(input, args = {}) {
    const request = typeof input === 'string' ? { action: input, ...args } : input
    if (!isRecord(request)) unavailable('INVALID_MCP_ACTION', 400)
    if (request.action === 'probe') return probe(request)
    if (request.action === 'restart') return restart(request)
    if (request.action === 'add') return addServer(request)
    if (request.action === 'setEnabled') return setEnabled(request)
    throw new CapabilityCenterError(400, 'UNSUPPORTED_MCP_ACTION')
  }

  async function releaseHostWatch(release = hostWatchDisposer) {
    hostWatchDisposer = null
    watchSubscribed = false
    if (typeof release === 'function') await release()
    else if (typeof release?.dispose === 'function') await release.dispose()
    else if (typeof release?.unsubscribe === 'function') await release.unsubscribe()
  }

  async function emitSnapshot() {
    if (watchers.size === 0) return
    const value = await snapshot()
    for (const listener of [...watchers]) {
      try { listener({ type: 'snapshot', snapshot: value }) } catch { /* a viewer cannot break the host watch */ }
    }
  }

  function startWatch() {
    const manager = managerService()
    if (typeof manager?.watch !== 'function' || watchSubscribed || watchStarting) return
    watchStarting = true
    watchSubscribed = true
    try {
      const starting = manager.watch(() => {
        watchChain = watchChain.then(() => emitSnapshot(), () => emitSnapshot())
      })
      if (starting && typeof starting.then === 'function') {
        Promise.resolve(starting).then(release => {
          if (watchers.size === 0) void releaseHostWatch(release)
          else hostWatchDisposer = release
        }).catch(() => {
          watchSubscribed = false
          diagnostic('capability center: MCP watch failed')
        }).finally(() => { watchStarting = false })
      } else {
        hostWatchDisposer = starting
        watchStarting = false
      }
    } catch {
      watchSubscribed = false
      watchStarting = false
      diagnostic('capability center: MCP watch failed')
    }
  }

  function watch(listener) {
    if (typeof listener !== 'function') throw new TypeError('capability center watcher must be a function')
    if (disposed || typeof managerService()?.watch !== 'function') {
      const unsubscribe = () => {}
      unsubscribe.supported = false
      unsubscribe.unsubscribe = unsubscribe
      return unsubscribe
    }
    watchers.add(listener)
    startWatch()
    let active = true
    const unsubscribe = () => {
      if (!active) return
      active = false
      watchers.delete(listener)
      if (watchers.size === 0) void releaseHostWatch().catch(() => diagnostic('capability center: MCP watch cleanup failed'))
    }
    unsubscribe.supported = true
    unsubscribe.unsubscribe = unsubscribe
    unsubscribe.dispose = unsubscribe
    return unsubscribe
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    watchers.clear()
    await releaseHostWatch()
    await mutationChain
  }

  return { snapshot, watch, probe, restart, addServer, setEnabled, execute, perform: execute, dispose }
}

export const createCapabilityCenter = createCapabilityCenterAdapter
