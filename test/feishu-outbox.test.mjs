import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { FeishuApiError } from '../lib/sources/feishu-client.js'
import {
  createFeishuOutbox,
  feishuIdempotencyKey,
  validateFeishuSummary,
} from '../lib/sources/feishu-outbox.js'
import { createSourceStore } from '../lib/sources/store.js'

const START = Date.parse('2026-11-25T00:00:00.000Z')

async function withRoot(fn) {
  const root = await fsp.mkdtemp(path.join(process.cwd(), '.feishu-outbox-test-'))
  try {
    return await fn(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

function harness(root, options = {}) {
  let at = START
  const calls = []
  const logs = []
  const client = {
    async replyToMessage(input) {
      calls.push({ ...input })
      if (options.send) return options.send(input, calls.length)
      return { messageId: `om_reply_${calls.length}` }
    },
  }
  const create = extra => createFeishuOutbox({
    stateFile: path.join(root, 'outbox.json'), client, now: () => at,
    leaseMs: 1_000, baseDelayMs: 1_000, maxDelayMs: 30_000,
    log: event => logs.push(event), ...extra,
  })
  return {
    calls, logs, create,
    advance(ms) { at += ms },
    get at() { return at },
  }
}

function input(overrides = {}) {
  return {
    instanceId: 'feishu-main',
    objectId: 'feishu:tenant:message:root_1',
    messageId: 'om_original_1',
    bindingId: 'binding_1',
    summary: '任务已完成，请查看结果。',
    ...overrides,
  }
}

test('pending and sent records survive restart; duplicate key writes the platform message id once', async () => {
  await withRoot(async root => {
    const h = harness(root)
    const first = await h.create().enqueue(input())
    assert.equal(first.status, 'pending')
    assert.equal(first.created, true)
    assert.equal(first.attempts, 0)
    assert.match(first.idempotencyKey, /^feishu-[a-f0-9]{40}$/)

    const restarted = h.create()
    const saved = await restarted.get(first.key)
    assert.equal(saved.status, 'pending')
    assert.equal(saved.platformMessageId, null)
    const duplicate = await restarted.enqueue(input())
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.key, first.key)

    const results = await restarted.recover()
    assert.equal(results[0].status, 'sent')
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].uuid, first.idempotencyKey)
    const delivered = await h.create().get(first.key)
    assert.equal(delivered.status, 'sent')
    assert.equal(delivered.platformMessageId, 'om_reply_1')
    assert.equal(delivered.attempts, 1)
    assert.match(delivered.sentAt, /^2026-11-25/)
    assert.equal((await h.create().snapshot()).counts.sent, 1)
    assert.equal(await fsp.access(path.join(root, 'outbox.json.lock')).then(() => true, () => false), false)
  })
})

test('timeout is retried after backoff with exactly the same idempotency key and message', async () => {
  await withRoot(async root => {
    let attempt = 0
    const h = harness(root, {
      send: () => {
        attempt += 1
        if (attempt === 1) throw new FeishuApiError('timeout', { message: 'timeout', retryable: true })
        return { messageId: 'om_after_timeout' }
      },
    })
    const outbox = h.create()
    const record = await outbox.enqueue(input())
    assert.equal((await outbox.flush())[0].status, 'pending')
    const waiting = await outbox.get(record.key)
    assert.equal(waiting.status, 'pending')
    assert.equal(waiting.attempts, 1)
    assert.equal(waiting.lastError, 'timeout')
    assert.equal(waiting.nextAttemptAt, new Date(START + 1_000).toISOString())

    h.advance(999)
    assert.deepEqual(await h.create().recover(), [])
    assert.equal(h.calls.length, 1)
    h.advance(1)
    assert.equal((await h.create().recover())[0].status, 'sent')
    assert.equal(h.calls.length, 2)
    assert.deepEqual(h.calls[0], h.calls[1])
    assert.equal(h.calls[1].uuid, record.idempotencyKey)
    assert.equal((await outbox.get(record.key)).platformMessageId, 'om_after_timeout')
  })
})

test('429 honors Retry-After beyond exponential backoff', async () => {
  await withRoot(async root => {
    let attempt = 0
    const h = harness(root, {
      send: () => {
        attempt += 1
        if (attempt === 1) throw new FeishuApiError('rate-limited', {
          message: 'busy', status: 429, retryable: true, retryAfterMs: 12_000,
        })
        return { messageId: 'om_after_429' }
      },
    })
    const outbox = h.create({ baseDelayMs: 500 })
    const record = await outbox.enqueue(input())
    await outbox.flush()
    assert.equal((await outbox.get(record.key)).nextAttemptAt, new Date(START + 12_000).toISOString())
    h.advance(11_999)
    await outbox.recover()
    assert.equal(h.calls.length, 1)
    h.advance(1)
    await outbox.recover()
    assert.equal(h.calls.length, 2)
    assert.equal(h.calls[1].uuid, record.idempotencyKey)
  })
})

test('a permanent rejection becomes dead immediately and is never scanned again', async () => {
  await withRoot(async root => {
    const h = harness(root, {
      send: () => { throw new FeishuApiError('rejected', { message: 'denied', retryable: false, platformCode: 99991671 }) },
    })
    const outbox = h.create()
    const record = await outbox.enqueue(input())
    assert.equal((await outbox.flush())[0].status, 'dead')
    const dead = await outbox.get(record.key)
    assert.equal(dead.status, 'dead')
    assert.equal(dead.lastError, 'rejected')
    assert.equal(dead.attempts, 1)
    h.advance(1_000_000)
    assert.deepEqual(await h.create().recover(), [])
    assert.equal(h.calls.length, 1)
  })
})

test('retry exhaustion is durable and stops at maxAttempts', async () => {
  await withRoot(async root => {
    const h = harness(root, {
      send: () => { throw new FeishuApiError('server', { message: 'busy', retryable: true }) },
    })
    const outbox = h.create({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10 })
    const record = await outbox.enqueue(input())
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await outbox.recover()
      h.advance(10)
    }
    const dead = await h.create().get(record.key)
    assert.equal(dead.status, 'dead')
    assert.equal(dead.lastError, 'retries-exhausted')
    assert.equal(dead.attempts, 3)
    assert.equal(h.calls.length, 3)
  })
})

test('an expired sending lease is recovered after restart without changing the key', async () => {
  await withRoot(async root => {
    const h = harness(root)
    const outbox = h.create()
    const record = await outbox.enqueue(input())
    const file = path.join(root, 'outbox.json')
    const state = JSON.parse(await fsp.readFile(file, 'utf8'))
    Object.assign(state.records[record.key], {
      status: 'sending', attempts: 1, leaseToken: 'dead-process', leaseExpiresAt: new Date(START + 1_000).toISOString(),
    })
    await fsp.writeFile(file, JSON.stringify(state), 'utf8')

    const restarted = h.create()
    assert.deepEqual(await restarted.recover(), [], 'live lease is not stolen')
    h.advance(1_000)
    assert.equal((await restarted.recover())[0].status, 'sent')
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].uuid, record.idempotencyKey)
    assert.equal((await restarted.get(record.key)).attempts, 2)
  })
})

test('a late worker cannot overwrite state after its lease has been reclaimed', async () => {
  await withRoot(async root => {
    let releaseOld
    const oldSend = new Promise(resolve => { releaseOld = resolve })
    let oldCalls = 0
    const oldClient = { replyToMessage: async () => { oldCalls += 1; return oldSend } }
    const h = harness(root)
    const first = h.create({ client: oldClient })
    const record = await first.enqueue(input())
    const sending = first.flush()
    while ((await first.get(record.key)).status !== 'sending') await new Promise(resolve => setImmediate(resolve))

    h.advance(1_000)
    assert.equal((await h.create().recover())[0].status, 'sent')
    const successor = await first.get(record.key)
    assert.equal(successor.status, 'sent')
    releaseOld({ messageId: 'om_stale_worker' })
    assert.equal((await sending)[0].status, 'superseded')
    assert.equal(oldCalls, 1)
    assert.equal((await first.get(record.key)).platformMessageId, 'om_reply_1')
  })
})

test('revoking the source binding marks queued work dead without sending', async () => {
  await withRoot(async root => {
    const h = harness(root)
    const sources = createSourceStore({ root: path.join(root, 'sources'), now: () => START })
    const binding = await sources.putBinding({
      source: 'feishu', instanceId: 'feishu-main', objectId: 'feishu:tenant:message:root_1',
      project: 'C:\\workspace', taskId: 'task_1', phaseId: null,
    })
    const outbox = h.create({ bindingStore: sources })
    const record = await outbox.enqueue(input({ bindingId: binding.id }))
    await sources.revokeBinding(binding.id)
    assert.equal((await outbox.flush())[0].code, 'binding-revoked')
    assert.equal(h.calls.length, 0)
    assert.equal((await outbox.get(record.key)).lastError, 'binding-revoked')
    h.advance(60_000)
    await h.create({ bindingStore: sources }).recover()
    assert.equal(h.calls.length, 0)
  })
})

test('binding removal or target mismatch also fails closed', async () => {
  await withRoot(async root => {
    for (const mode of ['missing', 'mismatch']) {
      const rootForCase = path.join(root, mode)
      const h = harness(rootForCase)
      const sources = createSourceStore({ root: path.join(rootForCase, 'sources'), now: () => START })
      if (mode === 'mismatch') await sources.putBinding({
        source: 'feishu', instanceId: 'feishu-main', objectId: 'feishu:tenant:message:root_1',
        project: 'C:\\workspace', taskId: 'task_1', phaseId: null,
      })
      const outbox = h.create({ bindingStore: sources })
      const record = await outbox.enqueue(input(mode === 'mismatch' ? {} : { bindingId: null }))
      await outbox.flush()
      assert.equal((await outbox.get(record.key)).status, 'dead')
      assert.equal(h.calls.length, 0)
    }
  })
})

test('summary template accepts short text and rejects credentials, paths, stacks, reports, and overflow', async () => {
  assert.deepEqual(validateFeishuSummary({ title: '任务', status: '完成', summary: '已生成简短结果。' }), {
    ok: true, text: '[任务] [完成] 已生成简短结果。',
  })
  assert.equal(validateFeishuSummary('x'.repeat(800)).ok, true)
  assert.deepEqual(validateFeishuSummary({ summary: 'ok', title: 'x'.repeat(81) }), {
    ok: false, code: 'summary-template-invalid',
  })
  const rejected = [
    ['appSecret=super-secret-value', 'summary-credential'],
    ['tenant_access_token: t-secret', 'summary-credential'],
    ['Authorization: Bearer abc', 'summary-credential'],
    ['结果位于 C:\\workspace\\private\\report.json', 'summary-absolute-path'],
    ['结果位于 /home/alice/report.json', 'summary-absolute-path'],
    ['Error: broken\n    at run (/tmp/file.js:1:2)', 'summary-stack'],
    ['调用栈：main -> send', 'summary-stack'],
    ['这是完整报告：所有执行细节见正文', 'summary-full-report'],
    ['# 执行报告\n全部细节', 'summary-full-report'],
    ['x'.repeat(801), 'summary-too-long'],
    ['bad\u0000text', 'summary-control-characters'],
  ]
  for (const [text, code] of rejected) {
    assert.deepEqual(validateFeishuSummary(text), { ok: false, code }, text)
  }
})

test('unsafe summaries are rejected before persistence or dispatch', async () => {
  await withRoot(async root => {
    const h = harness(root)
    const outbox = h.create()
    for (const [summary, code] of [
      ['appSecret=do-not-store', 'summary-credential'],
      ['/absolute/report', 'summary-absolute-path'],
      ['完整报告', 'summary-full-report'],
    ]) {
      await assert.rejects(() => outbox.enqueue(input({ summary })), error => error.code === code)
    }
    assert.equal((await outbox.snapshot()).total, 0)
    assert.equal(h.calls.length, 0)
    assert.equal(await fsp.access(path.join(root, 'outbox.json')).then(() => true, () => false), false)
  })
})

test('persisted state and logs redact provider exceptions, credentials, absolute paths, and stacks', async () => {
  await withRoot(async root => {
    const secret = 'app-secret-that-must-not-persist'
    const h = harness(root, {
      send: () => { throw new Error(`failed ${secret} at C:\\private\\worker.js\n at send (C:\\private\\worker.js:1:2)`) },
    })
    const outbox = h.create()
    const record = await outbox.enqueue(input())
    await outbox.flush()
    const raw = await fsp.readFile(path.join(root, 'outbox.json'), 'utf8')
    const observable = `${raw}\n${JSON.stringify(h.logs)}\n${JSON.stringify(await outbox.get(record.key))}`
    assert.equal((await outbox.get(record.key)).lastError, 'delivery-failed')
    for (const value of [secret, 'C:\\private', 'worker.js', ' at send', `failed ${secret}`]) {
      assert.equal(observable.includes(value), false, value)
    }
    assert.deepEqual(h.logs, [{ event: 'feishu-outbox-dead', key: record.key, code: 'delivery-failed' }])
  })
})

test('idempotency identity separates targets and notification kinds', () => {
  const base = { source: 'feishu', instanceId: 'one', objectId: 'object', messageId: 'message' }
  const key = feishuIdempotencyKey(base)
  assert.equal(key, feishuIdempotencyKey(base))
  assert.notEqual(key, feishuIdempotencyKey({ ...base, messageId: 'other' }))
  assert.notEqual(key, feishuIdempotencyKey({ ...base, kind: 'completion' }))
})

test('corrupt outbox state is preserved rather than reset and overwritten', async () => {
  await withRoot(async root => {
    const h = harness(root)
    const file = path.join(root, 'outbox.json')
    await fsp.writeFile(file, '{broken', 'utf8')
    await assert.rejects(() => h.create().enqueue(input()), { code: 'outbox-state-invalid' })
    assert.equal(await fsp.readFile(file, 'utf8'), '{broken')
  })
})
