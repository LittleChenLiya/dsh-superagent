/**
 * Read-only plugin/skill market client and installation handoff.
 *
 * This module deliberately has no package-manager or process-execution code.
 * Registry responses are untrusted: HTTPS and exact host allowlisting happen
 * before fetch, redirects are refused, response bytes are capped, and every
 * item needs a valid name, semver, engine range, commit, digest and Ed25519
 * signature from a caller-pinned key.
 *
 * @module dsh-superagent/market-client
 */

import { createHash, verify as verifySignature } from 'node:crypto'
import { isIP } from 'node:net'

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_MAX_INDEX_BYTES = 1024 * 1024
export const HARD_MAX_INDEX_BYTES = 8 * 1024 * 1024
export const MAX_MARKET_ITEMS = 100
export const MARKET_SIGNATURE_CONTEXT = 'dsh-superagent-market-item-v1'
const VERIFIED_MARKET_ITEMS = new WeakSet()

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const PARTIAL = /^(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?)?$/

export class MarketError extends Error {
  constructor(code, message, status = 400, details = {}, options) {
    super(message, options)
    this.name = 'MarketError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status = 400, details = {}) {
  throw new MarketError(code, message, status, details)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function cleanText(value, field, maxLength, { required = false } = {}) {
  if (typeof value !== 'string') fail('INVALID_MARKET_ITEM', `${field} must be a string`)
  const text = value.trim()
  if ((required && !text) || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail('INVALID_MARKET_ITEM', `${field} is empty, too long, or contains control characters`, 400, { field })
  }
  return text
}

export function validatePackageName(value) {
  const name = cleanText(value, 'package name', 214, { required: true })
  if (!PACKAGE_NAME.test(name) || name.includes('..') || name.length > 214) {
    fail('INVALID_PACKAGE_NAME', 'package name must be a canonical npm-style name', 400, { name })
  }
  return name
}

function parseVersion(value, field = 'version') {
  if (typeof value !== 'string') fail('INVALID_SEMVER', `${field} must be a semantic version`)
  const match = VERSION.exec(value)
  if (!match) fail('INVALID_SEMVER', `${field} is not a valid semantic version`, 400, { field, value })
  const pre = match[4] ? match[4].split('.') : []
  for (const identifier of pre) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      fail('INVALID_SEMVER', `${field} has a numeric prerelease identifier with a leading zero`, 400, { field })
    }
  }
  return {
    core: match.slice(1, 4).map(part => BigInt(part)),
    pre,
    text: value,
  }
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length === right.pre.length) return 0
    return left.pre.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) {
      const ai = BigInt(a)
      const bi = BigInt(b)
      return ai < bi ? -1 : 1
    }
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

function partialVersion(match) {
  const parts = match.slice(1).map(part => part === undefined || /^[xX*]$/.test(part) ? null : BigInt(part))
  let specified = 0
  for (const part of parts) if (part !== null) specified += 1
  // A wildcard ends the meaningful portion: 1.x.2 is not a semver range.
  if (parts[0] === null) specified = 0
  else if (parts[1] === null) specified = 1
  else if (parts[2] === null) specified = 2
  else specified = 3
  if (parts[1] === null && parts[2] !== null) fail('INVALID_ENGINE_RANGE', 'a wildcard cannot precede a fixed version component')
  const lower = {
    core: [parts[0] ?? 0n, parts[1] ?? 0n, parts[2] ?? 0n],
    pre: [],
    text: '',
  }
  return { lower, specified }
}

function upperForPartial(lower, specified) {
  const core = [...lower.core]
  if (specified === 1) {
    core[0] += 1n
    core[1] = 0n
    core[2] = 0n
  } else {
    core[1] += 1n
    core[2] = 0n
  }
  return { core, pre: [], text: '' }
}

function parseComparator(token) {
  const match = /^(>=|<=|>|<|=|\^|~>?)?(.+)$/.exec(token)
  if (!match) fail('INVALID_ENGINE_RANGE', `unsupported engine comparator: ${token}`)
  const operator = match[1] ?? '='
  const partial = PARTIAL.exec(match[2])
  if (partial) {
    const { lower, specified } = partialVersion(partial)
    if (specified === 0) return []
    if (operator === '>=') return [{ operator, version: lower }]
    if (operator === '>') {
      if (specified < 3) return [{ operator: '>=', version: upperForPartial(lower, specified) }]
      return [{ operator, version: lower }]
    }
    if (operator === '<') return [{ operator, version: lower }]
    if (operator === '<=') {
      if (specified === 3) return [{ operator, version: lower }]
      return [{ operator: '<', version: upperForPartial(lower, specified) }]
    }
    if (operator === '=' && specified < 3) {
      return [
        { operator: '>=', version: lower },
        { operator: '<', version: upperForPartial(lower, specified) },
      ]
    }
    if (operator === '^') {
      const core = [...lower.core]
      let upper
      if (core[0] > 0n || specified === 1) upper = [core[0] + 1n, 0n, 0n]
      else if (specified === 3) upper = [0n, 0n, core[2] + 1n]
      else upper = [0n, core[1] + 1n, 0n]
      return [
        { operator: '>=', version: lower },
        { operator: '<', version: { core: upper, pre: [], text: '' } },
      ]
    }
    if (operator === '~' || operator === '~>') {
      return [
        { operator: '>=', version: lower },
        { operator: '<', version: upperForPartial(lower, specified) },
      ]
    }
  }
  const version = parseVersion(match[2], 'engine version')
  return [{ operator, version }]
}

function parseRange(range) {
  if (typeof range !== 'string' || range.length > 500 || /[\u0000-\u001f\u007f]/.test(range.trim())) {
    fail('INVALID_ENGINE_RANGE', 'engine ranges must be strings of at most 500 characters')
  }
  const alternatives = range.trim() || '*'
  return alternatives.split('||').map(alternative => {
    const text = alternative.trim()
    if (!text || /[,{}]/.test(text)) fail('INVALID_ENGINE_RANGE', `invalid engine range: ${range}`)
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text)
    if (hyphen) {
      const left = parseComparator(`>=${hyphen[1]}`)
      const rightToken = PARTIAL.exec(hyphen[2])
      const partialRight = rightToken ? partialVersion(rightToken) : null
      const right = partialRight
        ? partialRight.specified === 3
          ? [{ operator: '<=', version: partialRight.lower }]
          : [{ operator: '<', version: upperForPartial(partialRight.lower, partialRight.specified) }]
        : [{ operator: '<=', version: parseVersion(hyphen[2], 'engine version') }]
      return [...left, ...right]
    }
    const tokens = text.replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1').split(/\s+/)
    if (tokens.some(token => !token)) fail('INVALID_ENGINE_RANGE', `invalid engine range: ${range}`)
    return tokens.flatMap(parseComparator)
  })
}

function comparatorMatches(version, comparator) {
  const compared = compareVersions(version, comparator.version)
  switch (comparator.operator) {
    case '=': return compared === 0
    case '>': return compared > 0
    case '>=': return compared >= 0
    case '<': return compared < 0
    case '<=': return compared <= 0
    default: return false
  }
}

export function satisfiesSemver(version, range) {
  const parsed = parseVersion(version)
  const alternatives = parseRange(range)
  return alternatives.some(comparators => {
    if (!comparators.every(comparator => comparatorMatches(parsed, comparator))) return false
    if (parsed.pre.length === 0) return true
    // npm semver excludes prereleases unless a comparator names the same core.
    return comparators.some(comparator =>
      comparator.version.pre.length > 0
      && comparator.version.core.every((part, index) => part === parsed.core[index]))
  })
}

export function validateEngines(value, runtime, { field = 'engines' } = {}) {
  if (value === undefined) return { node: '', dsh: '' }
  if (!isRecord(value)) fail('INVALID_ENGINES', `${field} must be an object`)
  for (const key of Object.keys(value)) {
    if (key !== 'node' && key !== 'dsh') fail('UNSUPPORTED_ENGINE', `${field}.${key} is not supported`, 400, { engine: key })
  }
  const engines = { node: '', dsh: '' }
  for (const key of ['node', 'dsh']) {
    if (!own(value, key)) continue
    const range = value[key]
    parseRange(range)
    engines[key] = range.trim()
    const current = runtime?.[key]
    if (range.trim() && range.trim() !== '*') {
      if (typeof current !== 'string' || !current.trim()) {
        fail('MISSING_HOST_VERSION', `host ${key} version is required to check ${field}.${key}`, 400, { engine: key })
      }
      const normalized = current.trim().replace(/^v/, '')
      if (!satisfiesSemver(normalized, range)) {
        fail('ENGINE_INCOMPATIBLE', `${field}.${key} requires ${range}; host has ${current}`, 400, {
          engine: key,
          required: range,
          actual: current,
        })
      }
    }
  }
  return engines
}

/** Canonical bytes covered by a market item's signature. */
export function createMarketSignaturePayload(item) {
  const payload = [
    MARKET_SIGNATURE_CONTEXT,
    item.kind,
    item.name,
    item.version,
    item.engines.node,
    item.engines.dsh,
    item.commit,
    item.sha256,
    item.registry,
  ]
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

export function verifyMarketSignature(item, trustedPublicKeys) {
  if (!isRecord(item.signature) || item.signature.algorithm !== 'ed25519') {
    fail('INVALID_SIGNATURE', 'only ed25519 market signatures are accepted', 400)
  }
  const keyId = item.signature.keyId
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) fail('INVALID_SIGNATURE', 'signature keyId is invalid')
  let key
  if (trustedPublicKeys instanceof Map) key = trustedPublicKeys.get(keyId)
  else if (isRecord(trustedPublicKeys) && own(trustedPublicKeys, keyId)) key = trustedPublicKeys[keyId]
  if (!key) fail('UNTRUSTED_SIGNATURE_KEY', `no pinned public key for signature keyId ${keyId}`, 400, { keyId })
  if (typeof key === 'string' && key.length > 16_384) fail('INVALID_TRUSTED_KEY', 'trusted public key is too large')
  const encoded = item.signature.value
  if (typeof encoded !== 'string' || encoded.length > 128 || !BASE64.test(encoded)) {
    fail('INVALID_SIGNATURE', 'signature is not canonical base64')
  }
  const signature = Buffer.from(encoded, 'base64')
  if (signature.length !== 64 || signature.toString('base64') !== encoded) {
    fail('INVALID_SIGNATURE', 'signature must be a canonical 64-byte Ed25519 signature')
  }
  let valid = false
  try {
    valid = verifySignature(null, createMarketSignaturePayload(item), key, signature)
  } catch (error) {
    fail('INVALID_SIGNATURE', 'the pinned public key or signature is malformed', 400, {}, { cause: error })
  }
  if (!valid) fail('INVALID_SIGNATURE', 'market item signature verification failed', 400, { keyId })
  return Object.freeze({ algorithm: 'ed25519', keyId, value: encoded, verified: true })
}

function normalizeItem(raw, config) {
  if (!isRecord(raw)) fail('INVALID_MARKET_ITEM', 'each market item must be an object')
  const pack = isRecord(raw.package) ? raw.package : {}
  const kind = raw.kind ?? raw.type ?? 'plugin'
  if (kind !== 'plugin' && kind !== 'skill') fail('INVALID_MARKET_ITEM', 'market item kind must be plugin or skill')
  const name = validatePackageName(raw.name ?? pack.name)
  const version = cleanText(raw.version ?? pack.version, 'version', 100, { required: true })
  parseVersion(version)
  const engines = validateEngines(raw.engines ?? pack.engines, config.runtime)
  const commitValue = raw.commit ?? raw.gitHead ?? pack.gitHead
  const commit = typeof commitValue === 'string' ? commitValue.toLowerCase() : ''
  if (!COMMIT.test(commit)) fail('INVALID_COMMIT', 'commit must be a full 40- or 64-character hexadecimal Git object id')
  const shaValue = raw.sha256 ?? raw.integrity?.sha256
  const sha256 = typeof shaValue === 'string' ? shaValue.toLowerCase() : ''
  if (!SHA256.test(sha256)) fail('INVALID_SHA256', 'sha256 must be 64 lowercase hexadecimal characters')
  const item = {
    kind,
    name,
    displayName: cleanText(raw.displayName ?? raw.display_name ?? name, 'displayName', 120, { required: true }),
    description: cleanText(raw.description ?? pack.description ?? '', 'description', 1000),
    version,
    registry: config.registry,
    engines: Object.freeze(engines),
    commit,
    sha256,
    signature: raw.signature,
    remote: true,
    enabled: false,
    disabledReason: kind === 'skill' ? 'remote-skills-disabled-by-default' : 'installation-requires-host-approval',
  }
  item.signature = verifyMarketSignature(item, config.trustedPublicKeys)
  const verified = Object.freeze(item)
  VERIFIED_MARKET_ITEMS.add(verified)
  return verified
}

function normalizeHostname(value) {
  if (typeof value !== 'string') fail('INVALID_REGISTRY', 'registry hosts must be strings')
  let hostname = value.trim().toLowerCase()
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
  if (!hostname || hostname.length > 253 || /[\s/@?#%\u0000-\u001f]/.test(hostname)) {
    fail('INVALID_REGISTRY', 'registry host is invalid')
  }
  return hostname
}

function privateAddress(address) {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = isIP(value) === 4
  if (ipv4) {
    const [a, b] = value.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 51))
      || (a === 203 && b === 0)
  }
  if (isIP(value) === 6) {
    return value === '::' || value === '::1' || value.startsWith('::ffff:')
      || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value)
  }
  return false
}

function assertRegistryUrl(value, allowedHosts) {
  let url
  try {
    url = new URL(value)
  } catch (error) {
    fail('INVALID_REGISTRY', 'registry must be an absolute HTTPS URL', 400, {}, { cause: error })
  }
  const hostname = normalizeHostname(url.hostname)
  if (url.protocol !== 'https:' || url.port !== '' && url.port !== '443') {
    fail('HTTPS_REQUIRED', 'registry must use HTTPS on port 443', 400, { registry: value })
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('INVALID_REGISTRY', 'registry URL must not contain credentials, a path, query, or fragment')
  }
  if (!allowedHosts.has(hostname)) fail('REGISTRY_NOT_ALLOWED', `registry host ${hostname} is not allowlisted`, 403, { hostname })
  if (privateAddress(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.startsWith('metadata.')) {
    fail('SSRF_BLOCKED', 'registry host resolves to a local, link-local, or private address category', 403, { hostname })
  }
  return `https://${hostname}`
}

function byteLimit(value, fallback, hardMaximum, label) {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > hardMaximum) {
    fail('INVALID_LIMIT', `${label} must be an integer between 1 and ${hardMaximum}`)
  }
  return limit
}

function responseUrlIsExpected(response, expected) {
  if (!response.url) return
  let actual
  try {
    actual = new URL(response.url)
  } catch {
    fail('REDIRECT_FORBIDDEN', 'registry returned an invalid final URL')
  }
  if (actual.origin !== expected || response.redirected) {
    fail('REDIRECT_FORBIDDEN', 'registry redirects are forbidden')
  }
}

async function readLimitedResponse(response, maxBytes) {
  const declared = response.headers?.get?.('content-length')
  if (declared !== null && declared !== undefined) {
    if (!/^\d+$/.test(String(declared))) fail('INVALID_INDEX', 'registry returned an invalid Content-Length')
    if (Number(declared) > maxBytes) fail('INDEX_TOO_LARGE', `registry index exceeds ${maxBytes} bytes`, 413, { maxBytes })
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxBytes) fail('INDEX_TOO_LARGE', `registry index exceeds ${maxBytes} bytes`, 413, { maxBytes })
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => {})
        fail('INDEX_TOO_LARGE', `registry index exceeds ${maxBytes} bytes`, 413, { maxBytes })
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, length)
}

function permissionsPreview(item) {
  return Object.freeze({
    requested: Object.freeze([]),
    effective: Object.freeze([]),
    filesystem: Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) }),
    network: 'not-granted',
    commands: Object.freeze([]),
    execution: 'never-automatic',
    requiresReview: true,
  })
}

export function createInstallHandoff(item, { enabled = false, hostInstallApi = null, permissions = permissionsPreview(item) } = {}) {
  if (!isRecord(item) || item.signature?.verified !== true || !VERIFIED_MARKET_ITEMS.has(item)) {
    fail('UNVERIFIED_MARKET_ITEM', 'install handoff requires a verified MarketItem')
  }
  if (typeof enabled !== 'boolean') fail('INVALID_HANDOFF', 'enabled must be a boolean')
  const handoff = {
    schemaVersion: 1,
    type: 'market-install-handoff',
    status: enabled ? 'pending-host-install' : 'disabled',
    installed: false,
    executed: false,
    package: Object.freeze({ kind: item.kind, name: item.name, version: item.version }),
    registry: item.registry,
    commit: item.commit,
    sha256: item.sha256,
    signature: Object.freeze({ ...item.signature }),
    engines: Object.freeze({ ...item.engines }),
    enabled,
    remote: true,
    disabledReason: enabled ? null : 'disabled-by-default',
    installApi: hostInstallApi || null,
    nextAction: enabled ? 'host-must-review-and-install' : 'review-permissions-before-enabling',
    permissions,
  }
  return Object.freeze(handoff)
}

export class MarketClient {
  constructor(options = {}) {
    if (!isRecord(options)) fail('INVALID_OPTIONS', 'market client options must be an object')
    const registryInput = options.registry ?? options.registryUrl ?? DEFAULT_REGISTRY
    const hosts = options.allowedHosts ?? options.registryHosts
    if (hosts !== undefined && !Array.isArray(hosts) && !(hosts instanceof Set)) {
      fail('INVALID_REGISTRY', 'allowedHosts must be an array or Set of exact hostnames')
    }
    const hostList = hosts === undefined ? [new URL(DEFAULT_REGISTRY).hostname] : [...hosts]
    if (!Array.isArray(hostList) || hostList.length === 0 || hostList.length > 32) {
      fail('INVALID_REGISTRY', 'allowedHosts must contain between 1 and 32 exact hostnames')
    }
    this.allowedHosts = new Set(hostList.map(normalizeHostname))
    this.registry = assertRegistryUrl(registryInput, this.allowedHosts)
    this.fetch = options.fetchImpl ?? options.fetch ?? globalThis.fetch
    if (typeof this.fetch !== 'function') fail('INVALID_OPTIONS', 'fetchImpl must be a function')
    this.trustedPublicKeys = options.trustedPublicKeys ?? options.publicKeys
    if (!(this.trustedPublicKeys instanceof Map) && !isRecord(this.trustedPublicKeys)) {
      fail('MISSING_TRUSTED_KEYS', 'caller-pinned trustedPublicKeys are required')
    }
    if (this.trustedPublicKeys instanceof Map ? this.trustedPublicKeys.size === 0 : Object.keys(this.trustedPublicKeys).length === 0) {
      fail('MISSING_TRUSTED_KEYS', 'at least one caller-pinned public key is required')
    }
    this.runtime = Object.freeze({
      node: options.nodeVersion ?? options.runtime?.node ?? process.version,
      dsh: options.dshVersion ?? options.runtime?.dsh ?? null,
    })
    this.maxIndexBytes = byteLimit(options.maxIndexBytes, DEFAULT_MAX_INDEX_BYTES, HARD_MAX_INDEX_BYTES, 'maxIndexBytes')
    this.timeoutMs = byteLimit(options.timeoutMs, 15_000, 120_000, 'timeoutMs')
    this.maxPackageBytes = byteLimit(options.maxPackageBytes, 64 * 1024 * 1024, 128 * 1024 * 1024, 'maxPackageBytes')
    this.lookup = options.lookup ?? null
    if (this.lookup !== null && typeof this.lookup !== 'function') fail('INVALID_OPTIONS', 'lookup must be a function')
    this.hostInstallApi = typeof options.host?.installPlugin === 'function' ? 'host.installPlugin'
      : typeof options.host?.install === 'function' ? 'host.install' : null
  }

  async #assertResolvedHost() {
    if (!this.lookup) return
    const hostname = new URL(this.registry).hostname
    let addresses
    try {
      addresses = await this.lookup(hostname, { all: true, verbatim: true })
    } catch (error) {
      fail('REGISTRY_LOOKUP_FAILED', 'registry hostname lookup failed', 502, { hostname }, { cause: error })
    }
    if (typeof addresses === 'string') addresses = [{ address: addresses }]
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 16) {
      fail('REGISTRY_LOOKUP_FAILED', 'registry hostname lookup returned no usable addresses')
    }
    for (const entry of addresses) {
      const address = typeof entry === 'string' ? entry : entry?.address
      if (typeof address !== 'string' || isIP(address.replace(/^\[|\]$/g, '')) === 0 || privateAddress(address)) {
        fail('SSRF_BLOCKED', 'registry hostname resolved to a local, link-local, private, or invalid address', 403, { hostname })
      }
    }
  }

  async search({ query = '', signal } = {}) {
    if (typeof query !== 'string' || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) {
      fail('INVALID_QUERY', 'query must be a string of at most 200 characters without controls')
    }
    await this.#assertResolvedHost()
    const url = new URL('/-/v1/search', this.registry)
    url.searchParams.set('text', query)
    url.searchParams.set('size', String(MAX_MARKET_ITEMS))
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await this.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: requestSignal,
        headers: { accept: 'application/json', 'user-agent': 'dsh-superagent-market-client/1' },
      })
    } catch (error) {
      if (signal?.aborted) throw error
      fail('REGISTRY_REQUEST_FAILED', 'registry request failed or timed out', 502, {}, { cause: error })
    }
    if (response.status >= 300 && response.status < 400) {
      fail('REDIRECT_FORBIDDEN', 'registry redirects are forbidden', 502, { location: response.headers?.get?.('location') ?? null })
    }
    responseUrlIsExpected(response, this.registry)
    if (response.status !== 200) fail('REGISTRY_HTTP_ERROR', `registry returned HTTP ${response.status}`, 502, { status: response.status })
    const bytes = await readLimitedResponse(response, this.maxIndexBytes)
    let payload
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      fail('INVALID_INDEX', 'registry index is not valid UTF-8 JSON', 502, {}, { cause: error })
    }
    let rows
    if (Array.isArray(payload)) rows = payload
    else if (isRecord(payload) && Array.isArray(payload.items)) rows = payload.items
    else if (isRecord(payload) && Array.isArray(payload.objects)) rows = payload.objects.map(row => isRecord(row) && isRecord(row.package) ? { ...row.package, ...row } : row)
    else fail('INVALID_INDEX', 'registry index must contain an items array')
    if (rows.length > MAX_MARKET_ITEMS) fail('INDEX_TOO_LARGE', `registry index contains more than ${MAX_MARKET_ITEMS} items`, 413)
    const seen = new Set()
    const items = rows.map(raw => {
      const item = normalizeItem(raw, this)
      const identity = `${item.kind}:${item.name}@${item.version}`
      if (seen.has(identity)) fail('DUPLICATE_MARKET_ITEM', `duplicate market item ${identity}`)
      seen.add(identity)
      return item
    })
    const installHandoffs = items.map(item => this.createInstallHandoff(item))
    return Object.freeze({ schemaVersion: 1, registry: this.registry, items: Object.freeze(items), installHandoffs: Object.freeze(installHandoffs) })
  }

  fetchIndex(options) {
    return this.search(options)
  }

  createInstallHandoff(item, options = {}) {
    // Re-normalize so a handoff cannot be made from an unverified plain object.
    const verified = normalizeItem(item, this)
    return createInstallHandoff(verified, {
      enabled: options.enabled ?? false,
      hostInstallApi: options.hostInstallApi ?? this.hostInstallApi,
      permissions: options.permissions ?? permissionsPreview(verified),
    })
  }

  verifyArtifact(item, bytes) {
    if (!isRecord(item) || item.signature?.verified !== true || !VERIFIED_MARKET_ITEMS.has(item)) {
      fail('UNVERIFIED_MARKET_ITEM', 'artifact verification requires a verified MarketItem')
    }
    if (!(bytes instanceof Uint8Array)) fail('INVALID_ARTIFACT', 'artifact must be bytes')
    if (bytes.byteLength > this.maxPackageBytes) fail('PACKAGE_TOO_LARGE', `package exceeds ${this.maxPackageBytes} bytes`, 413)
    const actual = createHash('sha256').update(bytes).digest('hex')
    const expected = item.sha256
    if (typeof expected !== 'string' || !SHA256.test(expected) || actual !== expected) {
      fail('HASH_MISMATCH', 'package sha256 does not match the signed market item', 400, { expected, actual })
    }
    return Object.freeze({ verified: true, sha256: actual, bytes: bytes.byteLength })
  }

  async install(item, options = {}) {
    const handoff = this.createInstallHandoff(item, options)
    if (!handoff.installApi) {
      return Object.freeze({
        status: 501,
        statusCode: 501,
        code: 'MARKET_INSTALL_NOT_IMPLEMENTED',
        installed: false,
        executed: false,
        message: 'The host exposes no installation API. Nothing was downloaded, installed, or executed.',
        handoff,
      })
    }
    // Even a host API is only described, never invoked. The host owns review,
    // installation and any execution decision outside this read-only client.
    return Object.freeze({
      status: 202,
      statusCode: 202,
      code: 'MARKET_HOST_INSTALL_REQUIRED',
      installed: false,
      executed: false,
      installApi: handoff.installApi,
      message: 'Installation handoff is ready; the host must review and perform it.',
      handoff,
    })
  }
}

export function createMarketClient(options) {
  return new MarketClient(options)
}
