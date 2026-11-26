import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDevicePairingStore, DEVICE_SCOPES } from '../lib/device-pairing.js'

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-device-pairing-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'state', 'devices.json')
  let now = Date.parse('2026-11-26T00:00:00.000Z')
  const store = createDevicePairingStore({ file, now: () => now })
  return { root, file, store, setNow: value => { now = value }, now: () => now }
}

test('pairing returns one plaintext token and persists only its hash and limited scopes', async t => {
  const { file, store } = await fixture(t)
  const paired = await store.pair({ name: 'Pocket phone', scopes: ['chat', 'inbox'], expiresInSeconds: 60 })
  assert.deepEqual(paired.scopes, ['chat', 'inbox'])
  assert.match(paired.token, /^dsm_[A-Za-z0-9_-]{43}$/)
  assert.equal(paired.status, 'active')
  assert.equal(paired.expiresAt, '2026-11-26T00:01:00.000Z')

  const text = await fsp.readFile(file, 'utf8')
  assert.equal(text.includes(paired.token), false)
  const document = JSON.parse(text)
  assert.equal(document.devices.length, 1)
  assert.equal(document.devices[0].tokenHash, createHash('sha256').update(paired.token).digest('hex'))
  assert.equal(document.devices[0].token, undefined)

  const verified = await store.verify(paired.token)
  assert.equal(verified.id, paired.id)
  assert.deepEqual(verified.scopes, ['chat', 'inbox'])
  assert.equal(verified.token, undefined)
  assert.equal(verified.tokenHash, undefined)
  assert.equal(verified.lastUsedAt, '2026-11-26T00:00:00.000Z')
  assert.equal(await store.verify('dsm_not-a-real-token'), null)
})

test('default device scopes exclude control, admin, and share', async t => {
  const { store } = await fixture(t)
  const paired = await store.pair()
  assert.deepEqual(paired.scopes, [...DEVICE_SCOPES])
  for (const scope of ['control', 'admin', 'share']) {
    assert.equal(paired.scopes.includes(scope), false)
    await assert.rejects(store.pair({ scopes: ['chat', scope] }), { status: 400, code: 'INVALID_DEVICE_SCOPES' })
  }
  await assert.rejects(store.pair({ scopes: ['chat', 'chat'] }), { status: 400, code: 'INVALID_DEVICE_SCOPES' })
  await assert.rejects(store.pair({ scopes: [] }), { status: 400, code: 'INVALID_DEVICE_SCOPES' })
})

test('tokens expire at the exact deadline and expired devices are reported explicitly', async t => {
  const { store, setNow, now } = await fixture(t)
  const paired = await store.pair({ expiresInSeconds: 30 })
  setNow(now() + 29_999)
  assert.equal((await store.verify(paired.token)).status, 'active')
  setNow(now() + 1)
  assert.equal(await store.verify(paired.token), null)
  assert.equal((await store.status(paired.id)).status, 'expired')
  assert.equal((await store.status()).find(item => item.id === paired.id).status, 'expired')
})

test('revocation survives reopening the store and is idempotent', async t => {
  const { file, store, setNow, now } = await fixture(t)
  const paired = await store.pair()
  const revoked = await store.revoke(paired.id)
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.revokedAt, '2026-11-26T00:00:00.000Z')
  assert.equal(await store.verify(paired.token), null)
  assert.equal((await store.revoke(paired.id)).revokedAt, revoked.revokedAt)

  setNow(now() + 1000)
  const reopened = createDevicePairingStore({ file, now: () => now() })
  assert.equal((await reopened.status(paired.id)).status, 'revoked')
  assert.equal(await reopened.verify(paired.token), null)
  await assert.rejects(reopened.revoke('missing'), { status: 404, code: 'DEVICE_NOT_FOUND' })
})

test('expiry and device capacity are validated without writing a credential', async t => {
  const { file, store } = await fixture(t)
  for (const expiresInSeconds of [0, -1, 1.5, 31_536_001]) {
    await assert.rejects(store.pair({ expiresInSeconds }), { status: 400, code: 'INVALID_DEVICE_EXPIRY' })
  }
  await assert.rejects(fsp.access(file), { code: 'ENOENT' })
  const limited = createDevicePairingStore({ file, maxDevices: 1 })
  await limited.pair({ name: 'first' })
  await assert.rejects(limited.pair({ name: 'second' }), { status: 409, code: 'DEVICE_LIMIT' })
  assert.equal((await limited.status()).length, 1)
})

test('concurrent pairing writes do not lose devices and dispose drains the store', async t => {
  const { store, file } = await fixture(t)
  const paired = await Promise.all(Array.from({ length: 8 }, (_, index) => store.pair({ name: `phone-${index}` })))
  assert.equal(new Set(paired.map(item => item.id)).size, 8)
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).devices.length, 8)
  await store.dispose()
  await assert.rejects(store.pair(), { status: 503, code: 'DEVICE_STORE_DISPOSED' })
})

test('cleanup removes expired credentials while retaining revocation status', async t => {
  const { store, setNow, now } = await fixture(t)
  const expired = await store.pair({ expiresInSeconds: 10 })
  const revoked = await store.pair()
  await store.revoke(revoked.id)
  setNow(now() + 10_000)
  assert.deepEqual(await store.cleanup(), { removed: 1, remaining: 1 })
  assert.deepEqual((await store.status()).map(item => item.id), [revoked.id])
  assert.equal(await store.verify(expired.token), null)
})

test('a corrupt store fails closed instead of silently forgetting paired devices', async t => {
  const { file, store } = await fixture(t)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, '{broken', 'utf8')
  await assert.rejects(store.status(), { status: 500, code: 'DEVICE_STORE_CORRUPT' })
  await assert.rejects(store.pair(), { status: 500, code: 'DEVICE_STORE_CORRUPT' })
  assert.equal(await fsp.readFile(file, 'utf8'), '{broken')
})
