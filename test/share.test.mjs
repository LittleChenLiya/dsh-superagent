import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createShareStore,
  DEFAULT_MAX_COMMENT_LENGTH,
  SHARE_CAPABILITIES,
  SHARE_ROLES,
} from '../lib/share.js'

const AT = Date.parse('2026-11-26T10:00:00.000Z')
const hasCode = code => error => error?.code === code

async function fixture(t, options = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-share-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  let clock = options.at ?? AT
  let actor = options.actor ?? 'owner'
  const store = createShareStore({ ...options, dir, now: () => clock, actor: () => actor })
  return {
    dir,
    store,
    get clock() { return clock },
    setClock(value) { clock = value },
    setActor(value) { actor = value },
  }
}

async function makeShare(fx, overrides = {}) {
  return fx.store.createShare({
    artifactIds: ['artifact-a', 'artifact-b'],
    role: 'commenter',
    expiresAt: new Date(fx.clock + 60_000).toISOString(),
    ...overrides,
  })
}

function commentInput(overrides = {}) {
  return {
    artifactId: 'artifact-a',
    text: 'Please clarify this result.',
    idempotencyKey: 'comment-request-1',
    ...overrides,
  }
}

test('create persists only the Share hash and returns the bearer token once', async t => {
  const fx = await fixture(t)
  const created = await makeShare(fx)
  const rawText = await fsp.readFile(fx.store.file, 'utf8')
  const state = JSON.parse(rawText)
  const saved = state.shares[0]

  assert.match(created.token, /^shr_[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(Object.keys(saved).sort(), [
    'artifactIds', 'createdBy', 'expiresAt', 'id', 'revokedAt', 'role', 'tokenHash',
  ])
  assert.equal(saved.tokenHash, createHash('sha256').update(created.token).digest('hex'))
  assert.equal(saved.createdBy, 'owner')
  assert.equal(saved.revokedAt, null)
  assert.equal(saved.role, 'commenter')
  assert.deepEqual(saved.artifactIds, ['artifact-a', 'artifact-b'])
  assert.equal(rawText.includes(created.token), false, 'the clear token must never reach disk')
  assert.equal(created.share.token, undefined)
  assert.equal(created.share.tokenHash, undefined)

  const listed = await fx.store.listShares()
  assert.equal(listed.length, 1)
  assert.equal(JSON.stringify(listed).includes(created.token), false)
  assert.equal(JSON.stringify(listed).includes(saved.tokenHash), false)
  const another = await makeShare(fx, { artifactIds: ['artifact-c'] })
  assert.notEqual(another.token, created.token, 'each share gets an independent token')
})

test('read enforces token, expiry, revocation and exact artifact scope with read/comment-only capabilities', async t => {
  const fx = await fixture(t)
  const { token } = await makeShare(fx)
  const read = await fx.store.readShare(token)
  assert.deepEqual(read.capabilities, [...SHARE_CAPABILITIES])
  assert.deepEqual(SHARE_CAPABILITIES, ['share.read', 'share.comment'])
  assert.equal((await fx.store.readShare(token, 'artifact-a')).id, read.id)
  assert.deepEqual((await fx.store.readShare(token, { artifactIds: ['artifact-a', 'artifact-b'] })).artifactIds,
    ['artifact-a', 'artifact-b'])

  await assert.rejects(fx.store.readShare(token, 'artifact-secret'), hasCode('resource-out-of-scope'))
  await assert.rejects(fx.store.readShare(token, { artifactIds: ['artifact-a', 'artifact-secret'] }),
    hasCode('resource-out-of-scope'))
  await assert.rejects(fx.store.readShare(`shr_${'x'.repeat(43)}`), hasCode('share-token-invalid'))
  await assert.rejects(fx.store.readShare(undefined), hasCode('share-token-invalid'))
  await assert.rejects(fx.store.createShare({ artifactIds: ['*'] }), hasCode('invalid-input'))

  for (const capability of ['message', 'messages', 'approval', 'approvals', 'run', 'runs', 'control']) {
    assert.equal(read.capabilities.includes(capability), false)
    assert.equal(fx.store[capability], undefined, 'a share token has no control-plane method')
  }

  const viewer = await makeShare(fx, { role: 'viewer', artifactIds: ['artifact-a'] })
  assert.deepEqual((await fx.store.readShare(viewer.token)).capabilities, ['share.read'])
  await assert.rejects(fx.store.createComment(viewer.token, commentInput()), hasCode('commenter-required'))
  assert.deepEqual(await fx.store.listComments(viewer.token), [])
})

test('a share expires at the exact expiresAt boundary for reads, comment reads and comment writes', async t => {
  const fx = await fixture(t)
  const { token } = await makeShare(fx, { expiresAt: new Date(AT + 1000).toISOString() })
  fx.setClock(AT + 999)
  assert.equal((await fx.store.readShare(token)).id.startsWith('share_'), true)
  fx.setClock(AT + 1000)
  await assert.rejects(fx.store.readShare(token), hasCode('share-expired'))
  await assert.rejects(fx.store.listComments(token), hasCode('share-expired'))
  await assert.rejects(fx.store.createComment(token, commentInput()), hasCode('share-expired'))
})

test('revocation is durable and idempotent, blocks every token operation, and is owner-only', async t => {
  const fx = await fixture(t)
  const { token, share } = await makeShare(fx)
  const revoked = await fx.store.revokeShare(share.id)
  assert.equal(revoked.revokedAt, new Date(AT).toISOString())
  assert.deepEqual(await fx.store.revokeShare(share.id), revoked)

  fx.setActor('stranger')
  await assert.rejects(fx.store.revokeShare(share.id), hasCode('share-not-found'))
  assert.deepEqual(await fx.store.listShares(), [])
  fx.setActor('owner')
  assert.equal((await fx.store.listShares())[0].revokedAt, revoked.revokedAt)

  await assert.rejects(fx.store.readShare(token), hasCode('share-revoked'))
  await assert.rejects(fx.store.listComments(token), hasCode('share-revoked'))
  await assert.rejects(fx.store.createComment(token, commentInput()), hasCode('share-revoked'))
})

test('comments use the server actor, reject actor forgery, and stay inside the shared artifact scope', async t => {
  const fx = await fixture(t)
  const { token } = await makeShare(fx)
  fx.setActor('reviewer')
  await assert.rejects(fx.store.createComment(token, commentInput({ actor: 'admin' })), hasCode('actor-forbidden'))
  await assert.rejects(fx.store.createComment(token, commentInput({ author: 'admin' })), hasCode('actor-forbidden'))
  await assert.rejects(fx.store.createComment(token, commentInput({ artifactId: 'artifact-secret' })),
    hasCode('resource-out-of-scope'))

  const created = await fx.store.createComment(token, commentInput())
  assert.equal(created.actor, 'reviewer')
  assert.equal(created.replayed, false)
  const { replayed, ...stored } = created
  assert.deepEqual(await fx.store.listComments(token), [stored])
  assert.deepEqual(await fx.store.listComments(token, { artifactId: 'artifact-b' }), [])
  await assert.rejects(fx.store.listComments(token, { artifactId: 'artifact-secret' }), hasCode('resource-out-of-scope'))
})

test('comment idempotency survives sequential and concurrent retries and rejects key reuse with different text', async t => {
  const fx = await fixture(t)
  const { token } = await makeShare(fx)
  fx.setActor('reviewer')
  const input = commentInput()
  const first = await fx.store.createComment(token, input)
  const replay = await fx.store.createComment(token, input)
  assert.equal(replay.id, first.id)
  assert.equal(replay.replayed, true)
  await assert.rejects(fx.store.createComment(token, { ...input, text: 'Different text.' }), hasCode('idempotency-conflict'))

  const concurrentInput = commentInput({ text: 'Concurrent retry.', idempotencyKey: 'concurrent-request' })
  const attempts = await Promise.all(Array.from({ length: 8 }, () => fx.store.createComment(token, concurrentInput)))
  assert.equal(new Set(attempts.map(item => item.id)).size, 1)
  assert.equal(attempts.filter(item => item.replayed === false).length, 1)
  assert.equal(attempts.filter(item => item.replayed === true).length, 7)
  assert.equal((await fx.store.listComments(token)).length, 2)
})

test('comments enforce Unicode length and preserve XSS-looking text as unescaped plain text', async t => {
  const fx = await fixture(t, { maxCommentLength: 200 })
  const { token } = await makeShare(fx)
  fx.setActor('reviewer')
  await assert.rejects(fx.store.createComment(token, commentInput({ text: '😀'.repeat(201) })),
    hasCode('comment-too-long'))
  await assert.rejects(fx.store.createComment(token, commentInput({ text: '   ' })), hasCode('invalid-input'))
  await assert.rejects(fx.store.createComment(token, commentInput({ text: 'bad\u0000text' })), hasCode('invalid-input'))

  const text = '<img src=x onerror="alert(1)"> & <script>alert(\'x\')</script>\nsecond line'
  const created = await fx.store.createComment(token, commentInput({ text }))
  assert.equal(created.text, text)
  assert.equal((await fx.store.listComments(token))[0].text, text)
  const rawText = await fsp.readFile(fx.store.file, 'utf8')
  assert.equal(JSON.parse(rawText).comments[0].text, text)
  assert.equal(rawText.includes('&lt;'), false, 'server-side HTML escaping belongs to the renderer')
  assert.equal(DEFAULT_MAX_COMMENT_LENGTH, 2000)
})

test('shares, comments and idempotency records survive store restarts', async t => {
  const fx = await fixture(t)
  const { token, share } = await makeShare(fx)
  fx.setActor('reviewer')
  const input = commentInput({ text: 'Persist this comment.' })
  const created = await fx.store.createComment(token, input)
  const { replayed, ...stored } = created

  const restarted = createShareStore({ dir: fx.dir, now: () => fx.clock, actor: () => 'reviewer' })
  assert.equal((await restarted.readShare(token)).id, share.id)
  assert.deepEqual(await restarted.listComments(token), [stored])
  const replay = await restarted.createComment(token, input)
  assert.equal(replay.id, created.id)
  assert.equal(replay.replayed, true)
  assert.equal((await restarted.listComments(token)).length, 1)

  fx.setActor('owner')
  const restartedOwner = createShareStore({ dir: fx.dir, now: () => fx.clock, actor: () => 'owner' })
  await restartedOwner.revokeShare(share.id)
  const afterRevoke = createShareStore({ dir: fx.dir, now: () => fx.clock, actor: () => 'owner' })
  await assert.rejects(afterRevoke.readShare(token), hasCode('share-revoked'))
})

test('share and comment capacity limits fail closed without breaking existing records or idempotent replays', async t => {
  const shares = await fixture(t, { maxShares: 1 })
  const firstShare = await makeShare(shares)
  await assert.rejects(makeShare(shares), hasCode('share-capacity-reached'))
  assert.equal((await shares.store.readShare(firstShare.token)).id, firstShare.share.id)

  const comments = await fixture(t, { maxComments: 1, maxCommentsPerShare: 1 })
  const { token } = await makeShare(comments)
  comments.setActor('reviewer')
  const input = commentInput()
  const first = await comments.store.createComment(token, input)
  const replay = await comments.store.createComment(token, input)
  assert.equal(replay.id, first.id)
  assert.equal(replay.replayed, true)
  await assert.rejects(comments.store.createComment(token, commentInput({ idempotencyKey: 'one-too-many' })),
    hasCode('comment-capacity-reached'))
  const { replayed, ...stored } = first
  assert.deepEqual(await comments.store.listComments(token), [stored])
})

test('public results and errors do not leak the token, while malformed roles and expiries are rejected', async t => {
  const fx = await fixture(t)
  const { token, share } = await makeShare(fx)
  const presented = `shr_${'z'.repeat(43)}`
  const denied = await fx.store.readShare(presented).catch(error => error)
  assert.equal(denied.code, 'share-token-invalid')
  assert.equal(denied.message.includes(presented), false)

  const outputs = [
    await fx.store.listShares(),
    await fx.store.readShare(token),
    await fx.store.revokeShare(share.id),
  ]
  for (const output of outputs) assert.equal(JSON.stringify(output).includes(token), false)
  const rawText = await fsp.readFile(fx.store.file, 'utf8')
  assert.equal(rawText.includes(token), false)
  assert.match(JSON.parse(rawText).shares[0].tokenHash, /^[0-9a-f]{64}$/)

  await assert.rejects(fx.store.createShare({ artifactIds: ['artifact-a'], role: 'admin' }), hasCode('invalid-input'))
  await assert.rejects(fx.store.createShare({ artifactIds: ['artifact-a'], expiresAt: new Date(AT).toISOString() }),
    hasCode('invalid-input'))
  await assert.rejects(fx.store.createShare({ artifactIds: ['artifact-a', 'artifact-a'] }), hasCode('invalid-input'))
  assert.deepEqual(SHARE_ROLES, ['viewer', 'commenter'])
})
