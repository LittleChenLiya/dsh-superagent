import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import {
  DEFAULT_REGISTRY,
  MarketClient,
  MarketError,
  createMarketSignaturePayload,
  satisfiesSemver,
} from '../lib/market-client.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const RUNTIME = { node: 'v24.14.1', dsh: '0.2.2' }

function signedItem(overrides = {}) {
  const item = {
    kind: 'skill',
    name: 'review-skill',
    displayName: 'Review Skill',
    description: 'Reviews a change without executing it.',
    version: '1.2.3',
    engines: { node: '>=24.9.0 <25', dsh: '>=0.2.2-rc.1 <0.3.0-0' },
    commit: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    registry: DEFAULT_REGISTRY,
    ...overrides,
  }
  item.signature = {
    algorithm: 'ed25519',
    keyId: 'test-market',
    value: sign(null, createMarketSignaturePayload(item), privateKey).toString('base64'),
  }
  return item
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function client(fetchImpl, options = {}) {
  return new MarketClient({
    fetchImpl,
    trustedPublicKeys: { 'test-market': PUBLIC_KEY },
    nodeVersion: RUNTIME.node,
    dshVersion: RUNTIME.dsh,
    ...options,
  })
}

async function rejectsCode(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof MarketError)
    assert.equal(error.code, code)
    return true
  })
}

test('a signed search returns verified MarketItems, disabled remote Skills, and inert handoffs', async () => {
  const calls = []
  const market = client(async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse({ schemaVersion: 1, items: [signedItem()] })
  })
  const result = await market.search({ query: 'review' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${DEFAULT_REGISTRY}/-/v1/search?text=review&size=100`)
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].signature.verified, true)
  assert.equal(result.items[0].remote, true)
  assert.equal(result.items[0].enabled, false)
  assert.equal(result.items[0].disabledReason, 'remote-skills-disabled-by-default')
  assert.equal(result.installHandoffs[0].enabled, false)
  assert.equal(result.installHandoffs[0].installed, false)
  assert.equal(result.installHandoffs[0].executed, false)
  assert.deepEqual(result.installHandoffs[0].permissions.effective, [])
  assert.equal(result.installHandoffs[0].permissions.execution, 'never-automatic')
  assert.ok(Object.isFrozen(result.items[0]))
  assert.ok(Object.isFrozen(result.items[0].engines))
})

test('SSRF targets, non-HTTPS URLs, credentials, suffix hosts and private DNS answers are blocked before fetch', async () => {
  const blocked = [
    'http://registry.npmjs.org',
    'https://127.0.0.1',
    'https://localhost',
    'https://169.254.169.254',
    'https://[::1]',
    'https://registry.npmjs.org.evil.example',
    'https://user:pass@registry.npmjs.org',
    'https://registry.npmjs.org:8443',
    'https://registry.npmjs.org/path',
  ]
  for (const registry of blocked) {
    let fetched = false
    assert.throws(() => client(async () => {
      fetched = true
      return jsonResponse({ items: [] })
    }, { registry }), MarketError)
    assert.equal(fetched, false, registry)
  }

  let fetched = false
  assert.throws(() => client(async () => {
    fetched = true
    return jsonResponse({ items: [] })
  }, { registry: 'https://public.example', allowedHosts: ['registry.npmjs.org'] }), { code: 'REGISTRY_NOT_ALLOWED' })
  assert.equal(fetched, false)

  const privateDns = client(async () => {
    fetched = true
    return jsonResponse({ items: [] })
  }, {
    registry: 'https://public.example',
    allowedHosts: ['public.example'],
    lookup: async () => [{ address: '10.0.0.8' }],
  })
  await rejectsCode(() => privateDns.search(), 'SSRF_BLOCKED')
  assert.equal(fetched, false)
})

test('every redirect status and a followed cross-origin response are forbidden', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0
    const market = client(async () => {
      calls += 1
      return new Response(null, { status, headers: { location: 'https://evil.example/index.json' } })
    })
    await rejectsCode(() => market.search(), 'REDIRECT_FORBIDDEN')
    assert.equal(calls, 1)
  }

  const followed = client(async () => ({
    status: 200,
    url: 'https://evil.example/index.json',
    redirected: true,
    headers: new Headers(),
    arrayBuffer: async () => Buffer.from('{"items":[]}'),
  }))
  await rejectsCode(() => followed.search(), 'REDIRECT_FORBIDDEN')
})

test('declared and streamed index sizes are capped while reading, not only after JSON parsing', async () => {
  const declared = client(async () => jsonResponse({ items: [] }, { headers: { 'content-length': '65' } }), { maxIndexBytes: 64 })
  await rejectsCode(() => declared.search(), 'INDEX_TOO_LARGE')

  let cancelled = false
  const streamed = client(async () => ({
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        let index = 0
        return {
          async read() {
            const chunks = [Buffer.alloc(32, 0x20), Buffer.alloc(64, 0x20)]
            return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }
          },
          async cancel() {
            cancelled = true
          },
          releaseLock() {},
        }
      },
    },
  }), { maxIndexBytes: 64 })
  await rejectsCode(() => streamed.search(), 'INDEX_TOO_LARGE')
  assert.equal(cancelled, true)

  assert.throws(
    () => client(async () => jsonResponse({ items: [] }), { maxIndexBytes: 9 * 1024 * 1024 }),
    { code: 'INVALID_LIMIT' },
  )
})

test('invalid registry indexes and duplicate items fail closed', async () => {
  const malformed = client(async () => new Response('{not json', { status: 200 }))
  await rejectsCode(() => malformed.search(), 'INVALID_INDEX')

  const wrongShape = client(async () => jsonResponse({ objects: null }))
  await rejectsCode(() => wrongShape.search(), 'INVALID_INDEX')

  const duplicate = client(async () => jsonResponse({ items: [signedItem(), signedItem()] }))
  await rejectsCode(() => duplicate.search(), 'DUPLICATE_MARKET_ITEM')
})

test('package names, semver, commits and sha256 fields are strictly validated', async () => {
  const cases = [
    [{ name: '../../escape' }, 'INVALID_PACKAGE_NAME'],
    [{ name: 'Review-Skill' }, 'INVALID_PACKAGE_NAME'],
    [{ name: '@scope' }, 'INVALID_PACKAGE_NAME'],
    [{ version: '1.2' }, 'INVALID_SEMVER'],
    [{ version: '01.2.3' }, 'INVALID_SEMVER'],
    [{ version: '1.2.3-01' }, 'INVALID_SEMVER'],
    [{ commit: 'abc123' }, 'INVALID_COMMIT'],
    [{ commit: 'g'.repeat(40) }, 'INVALID_COMMIT'],
    [{ sha256: 'a'.repeat(63) }, 'INVALID_SHA256'],
    [{ sha256: 'z'.repeat(64) }, 'INVALID_SHA256'],
  ]
  for (const [override, code] of cases) {
    const market = client(async () => jsonResponse({ items: [signedItem(override)] }))
    await rejectsCode(() => market.search(), code)
  }
})

test('pseudo-signatures, unknown keys, tampered signed fields and malformed keys are rejected', async () => {
  const base = signedItem()
  const invalidCases = [
    [{ ...base, signature: { ...base.signature, value: Buffer.alloc(64).toString('base64') } }, 'INVALID_SIGNATURE'],
    [{ ...base, signature: { ...base.signature, keyId: 'unknown' } }, 'UNTRUSTED_SIGNATURE_KEY'],
    [{ ...base, signature: { ...base.signature, algorithm: 'rsa' } }, 'INVALID_SIGNATURE'],
    [{ ...base, signature: { ...base.signature, value: 'not base64!' } }, 'INVALID_SIGNATURE'],
    [{ ...base, sha256: 'c'.repeat(64) }, 'INVALID_SIGNATURE'],
    [{ ...base, commit: 'd'.repeat(40) }, 'INVALID_SIGNATURE'],
  ]
  for (const [item, code] of invalidCases) {
    const market = client(async () => jsonResponse({ items: [item] }))
    await rejectsCode(() => market.search(), code)
  }

  const malformedKey = client(async () => jsonResponse({ items: [base] }), {
    trustedPublicKeys: { 'test-market': 'not a public key' },
  })
  await rejectsCode(() => malformedKey.search(), 'INVALID_SIGNATURE')

  const noKeys = () => new MarketClient({ fetchImpl: async () => jsonResponse({ items: [] }) })
  assert.throws(noKeys, { code: 'MISSING_TRUSTED_KEYS' })
})

test('engine ranges are parsed as semver and incompatible or unavailable hosts are explicit errors', async () => {
  assert.equal(satisfiesSemver('0.2.2', '>=0.2.2-rc.1 <0.3.0-0'), true)
  assert.equal(satisfiesSemver('0.3.0-0', '>=0.2.2-rc.1 <0.3.0-0'), false)
  assert.equal(satisfiesSemver('1.5.0', '^1.2.3'), true)
  assert.equal(satisfiesSemver('2.0.0', '^1.2.3'), false)
  assert.equal(satisfiesSemver('0.0.9', '^0.0'), true)
  assert.equal(satisfiesSemver('0.1.0', '^0.0'), false)
  assert.equal(satisfiesSemver('2.3.9', '1.2.3 - 2.3'), true)
  assert.equal(satisfiesSemver('2.4.0', '1.2.3 - 2.3'), false)
  assert.equal(satisfiesSemver('1.3.0-beta.1', '>=1.3.0-beta.0 <1.3.0'), true)
  assert.equal(satisfiesSemver('1.3.0-beta.1', '*'), false)
  assert.throws(() => satisfiesSemver('1.0.0', '>=1.0.0 ||'), { code: 'INVALID_ENGINE_RANGE' })

  const incompatibleItem = signedItem({ engines: { node: '>=26', dsh: '*' } })
  const incompatible = client(async () => jsonResponse({ items: [incompatibleItem] }))
  await rejectsCode(() => incompatible.search(), 'ENGINE_INCOMPATIBLE')

  const missingHost = client(async () => jsonResponse({ items: [signedItem()] }), { dshVersion: null })
  await rejectsCode(() => missingHost.search(), 'MISSING_HOST_VERSION')

  const unsupported = client(async () => jsonResponse({ items: [signedItem({ engines: { npm: '*' } })] }))
  await rejectsCode(() => unsupported.search(), 'UNSUPPORTED_ENGINE')
})

test('artifact hash mismatch is detected against the signed digest', async () => {
  const bytes = Buffer.from('verified package bytes')
  const item = signedItem({ sha256: createHash('sha256').update(bytes).digest('hex') })
  const market = client(async () => jsonResponse({ items: [item] }))
  const { items } = await market.search()
  assert.deepEqual(market.verifyArtifact(items[0], bytes), {
    verified: true,
    sha256: item.sha256,
    bytes: bytes.length,
  })
  await rejectsCode(async () => market.verifyArtifact(items[0], Buffer.from('tampered')), 'HASH_MISMATCH')
  await rejectsCode(async () => market.verifyArtifact({ ...items[0], signature: { verified: true } }, bytes), 'UNVERIFIED_MARKET_ITEM')
})

test('installation returns explicit 501 without a host API and never invokes a host installer or npm', async () => {
  const item = signedItem()
  const market = client(async () => jsonResponse({ items: [item] }))
  const { items } = await market.search()
  const result = await market.install(items[0])
  assert.equal(result.status, 501)
  assert.equal(result.statusCode, 501)
  assert.equal(result.code, 'MARKET_INSTALL_NOT_IMPLEMENTED')
  assert.equal(result.installed, false)
  assert.equal(result.executed, false)
  assert.match(result.message, /no installation API/)

  let invoked = false
  const withHost = client(async () => jsonResponse({ items: [item] }), {
    host: {
      installPlugin() {
        invoked = true
        throw new Error('must not be invoked by this client')
      },
    },
  })
  const hosted = await withHost.install((await withHost.search()).items[0], { enabled: true })
  assert.equal(hosted.status, 202)
  assert.equal(hosted.code, 'MARKET_HOST_INSTALL_REQUIRED')
  assert.equal(hosted.installApi, 'host.installPlugin')
  assert.equal(hosted.installed, false)
  assert.equal(hosted.executed, false)
  assert.equal(invoked, false)
})

test('handoffs cannot be forged from unverified objects and unsafe limits are rejected', async () => {
  const market = client(async () => jsonResponse({ items: [] }))
  assert.throws(() => market.createInstallHandoff({ ...signedItem(), signature: { verified: true } }), { code: 'INVALID_SIGNATURE' })
  assert.throws(() => market.createInstallHandoff(signedItem(), { enabled: 'yes' }), { code: 'INVALID_HANDOFF' })
  assert.throws(() => client(async () => jsonResponse({ items: [] }), { maxIndexBytes: 0 }), { code: 'INVALID_LIMIT' })
  assert.throws(() => client(async () => jsonResponse({ items: [] }), { allowedHosts: [] }), { code: 'INVALID_REGISTRY' })
  assert.throws(() => client(async () => jsonResponse({ items: [] }), { registry: 'not a url' }), { code: 'INVALID_REGISTRY' })
})
