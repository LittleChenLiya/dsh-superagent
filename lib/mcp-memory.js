/**
 * Opt-in bridge to an already mounted dsh-mcp-manager service.
 *
 * This module never installs a package or spawns a server. The host manager owns
 * the process/connection and its registration disposer owns cleanup.
 *
 * @module dsh-superagent/mcp-memory
 */

export const DEFAULT_MCP_MEMORY_CONFIG = Object.freeze({
  enabled: false,
  serverName: 'superagent-memory',
  transport: 'stdio',
  command: 'npx',
  args: Object.freeze(['-y', '@modelcontextprotocol/server-memory']),
  env: Object.freeze({}),
  url: '',
  headers: Object.freeze({}),
})

const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const OWN = Object.prototype.hasOwnProperty

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(field, expectation) {
  throw new TypeError(`mcpMemory.${field} ${expectation}`)
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) invalid(field, 'must be a non-empty string')
  return value.trim()
}

/** Resolve a credential without ever putting its value in a diagnostic. */
function credential(value, field, env) {
  if (typeof value === 'string') {
    const reference = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value)
    if (reference) {
      const name = reference[1] ?? reference[2]
      const resolved = env[name]
      if (typeof resolved !== 'string') invalid(field, 'references an unset environment variable')
      return resolved
    }
    return value
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    const refKey = keys.length === 1 && (keys[0] === 'env' || keys[0] === '$env') ? keys[0] : null
    if (refKey && typeof value[refKey] === 'string' && ENV_NAME.test(value[refKey])) {
      const resolved = env[value[refKey]]
      if (typeof resolved !== 'string') invalid(field, 'references an unset environment variable')
      return resolved
    }
  }
  invalid(field, 'must be a string or an { env: "NAME" } reference')
}

function credentials(input, field, env, keyPattern) {
  if (!isRecord(input)) invalid(field, 'must be an object')
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (!keyPattern.test(key)) invalid(field, `contains an invalid key ${JSON.stringify(key)}`)
    output[key] = credential(value, `${field}.${key}`, env)
  }
  return output
}

/**
 * Validate and copy a memory-server configuration. Environment references are
 * resolved here, not logged or persisted by the bridge.
 *
 * @param {object} [input]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function normalizeMCPMemoryConfig(input = {}, env = process.env) {
  if (!isRecord(input)) invalid('config', 'must be an object')
  const cfg = {
    enabled: input.enabled === undefined ? DEFAULT_MCP_MEMORY_CONFIG.enabled : input.enabled,
    serverName: input.serverName === undefined ? DEFAULT_MCP_MEMORY_CONFIG.serverName : input.serverName,
    transport: input.transport === undefined ? DEFAULT_MCP_MEMORY_CONFIG.transport : input.transport,
    command: input.command === undefined ? DEFAULT_MCP_MEMORY_CONFIG.command : input.command,
    args: input.args === undefined ? [...DEFAULT_MCP_MEMORY_CONFIG.args] : input.args,
    env: input.env === undefined ? {} : input.env,
    url: input.url === undefined ? DEFAULT_MCP_MEMORY_CONFIG.url : input.url,
    headers: input.headers === undefined ? {} : input.headers,
  }

  if (typeof cfg.enabled !== 'boolean') invalid('enabled', 'must be a boolean')
  if (typeof cfg.serverName !== 'string' || !SERVER_NAME.test(cfg.serverName)) {
    invalid('serverName', 'must match [A-Za-z0-9_-]{1,32}')
  }
  if (typeof cfg.transport !== 'string') invalid('transport', 'must be a string')
  if (cfg.transport === 'http') cfg.transport = 'streamable-http'
  if (cfg.transport !== 'stdio' && cfg.transport !== 'streamable-http') {
    invalid('transport', 'must be "stdio", "http", or "streamable-http"')
  }

  cfg.command = requiredString(cfg.command, 'command')
  if (!Array.isArray(cfg.args) || cfg.args.some(arg => typeof arg !== 'string')) {
    invalid('args', 'must be an array of strings')
  }
  cfg.args = [...cfg.args]
  cfg.env = credentials(cfg.env, 'env', env, ENV_NAME)
  cfg.headers = credentials(cfg.headers, 'headers', env, HEADER_NAME)

  if (cfg.transport === 'streamable-http') {
    cfg.url = requiredString(cfg.url, 'url')
    let parsed
    try {
      parsed = new URL(cfg.url)
    } catch {
      invalid('url', 'must be an absolute HTTP(S) URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalid('url', 'must use http or https')
    }
    if (parsed.username || parsed.password) invalid('url', 'must not contain credentials')
  } else if (typeof cfg.url !== 'string') {
    invalid('url', 'must be a string')
  }

  return cfg
}

function listEntries(value) {
  if (value instanceof Map) {
    return [...value].map(([name, entry]) => (
      isRecord(entry) && entry.serverName === undefined && entry.name === undefined ? { ...entry, serverName: name } : entry
    ))
  }
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.servers)) return value.servers
  if (isRecord(value)) return Object.entries(value).map(([name, entry]) => (
    isRecord(entry) && entry.serverName === undefined && entry.name === undefined ? { ...entry, serverName: name } : entry
  ))
  return []
}

function entryName(entry) {
  if (!isRecord(entry)) return null
  if (typeof entry.serverName === 'string') return entry.serverName
  if (typeof entry.name === 'string') return entry.name
  return typeof entry.id === 'string' ? entry.id : null
}

function publicStatus(value) {
  const status = isRecord(value) ? value.status ?? value.state : value
  return typeof status === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(status)
    ? status
    : 'registered'
}

/**
 * Create a bridge over a host-provided manager. Registration is synchronous when
 * the manager is synchronous; asynchronous managers are observed through ready.
 * An optional Cordis context attaches the returned disposer to its lifecycle.
 *
 * @param {{mcpManager?: object|null, config?: object, log?: Function, ctx?: object|null, env?: NodeJS.ProcessEnv}} [options]
 */
export function createMCPMemoryBridge({ mcpManager = null, config = {}, log = () => {}, ctx = null, env = process.env } = {}) {
  const writeLog = message => {
    try { log(message) } catch { /* diagnostics must not break the plugin */ }
  }
  let cfg
  try {
    cfg = normalizeMCPMemoryConfig(config, env)
  } catch (error) {
    const reason = `invalid configuration: ${error.message}`
    writeLog(`mcp memory: ${reason}`)
    return {
      status: () => ({ status: 'error', reason }),
      ready: Promise.resolve(),
      dispose: () => Promise.resolve(),
    }
  }

  let state = cfg.enabled ? 'registered' : 'disabled'
  let reason = cfg.enabled ? null : 'disabled by configuration'
  let release = null
  let ready = Promise.resolve()
  let disposal = null
  let disposed = false
  let observed = null
  let retryTimer = null
  let retries = 0
  const identity = { serverName: cfg.serverName, transport: cfg.transport }
  const manager = () => typeof mcpManager === 'function' ? mcpManager() : mcpManager

  function status() {
    if (disposed) return { ...identity, status: 'disabled', reason: 'disposed' }
    if (!cfg.enabled) return { ...identity, status: 'disabled', reason }
    if (state === 'error' || state === 'disabled') return { ...identity, status: state, reason }

    // The manager is authoritative. A missing entry still means this bridge
    // successfully handed it a registration; it does not invent a connection.
    const currentManager = manager()
    if (typeof currentManager?.list === 'function') {
      try {
        const listed = currentManager.list()
        if (listed && typeof listed.then === 'function') {
          listed.then(value => { observed = value }, () => {})
        } else {
          const entry = listEntries(listed).find(item => entryName(item) === cfg.serverName)
          if (entry) return { ...identity, status: publicStatus(entry) }
        }
      } catch {
        // A status-read failure must not turn a successful registration into an error.
      }
    }
    if (observed !== null) {
      const entry = listEntries(observed).find(item => entryName(item) === cfg.serverName)
      if (entry) return { ...identity, status: publicStatus(entry) }
    }
    return { ...identity, status: state, ...(reason ? { reason } : {}) }
  }

  function dispose() {
    if (disposal) return disposal
    disposed = true
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    disposal = (async () => {
      await ready
      const current = release
      release = null
      if (typeof current === 'function') await current()
      else if (typeof current?.dispose === 'function') await current.dispose()
    })().catch(() => {
      writeLog(`mcp memory: disposal failed for ${cfg.serverName}`)
    })
    return disposal
  }

  if (!cfg.enabled) return { status, ready, dispose }

  // Only manager-native fields are forwarded. No installer, shell, or child
  // process is invoked by this bridge.
  const registration = cfg.transport === 'stdio'
    ? { transport: 'stdio', command: cfg.command, args: [...cfg.args], env: { ...cfg.env } }
    : { transport: 'streamable-http', url: cfg.url, headers: { ...cfg.headers } }

  function attemptRegistration() {
    if (disposed) return
    const currentManager = manager()
    if (!currentManager || typeof currentManager.register !== 'function') {
      state = 'disabled'
      reason = 'mcp manager is unavailable'
      if (retries < 100) {
        retries += 1
        retryTimer = setTimeout(attemptRegistration, 50)
        retryTimer.unref?.()
      }
      return
    }
    try {
      const result = currentManager.register(cfg.serverName, registration)
      if (result && typeof result.then === 'function') {
        state = 'registering'
        ready = Promise.resolve(result).then(value => {
          release = value
          state = 'registered'
          reason = null
        }, () => {
          state = 'error'
          reason = 'mcp manager registration failed'
          writeLog(`mcp memory: registration failed for ${cfg.serverName}`)
        })
      } else {
        release = result
        state = 'registered'
        reason = null
      }
    } catch {
      state = 'error'
      reason = 'mcp manager registration failed'
      writeLog(`mcp memory: registration failed for ${cfg.serverName}`)
    }
  }

  attemptRegistration()
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'dsh-superagent MCP memory')
    } catch {
      state = 'error'
      reason = 'could not attach the registration to the plugin lifecycle'
      writeLog(`mcp memory: lifecycle registration failed for ${cfg.serverName}`)
      void dispose()
    }
  }
  return { status, ready, dispose }
}
