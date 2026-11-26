import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEISHU_API_ORIGIN,
  FeishuApiError,
  createFeishuClient,
} from '../lib/sources/feishu-client.js'

const APP_ID = 'cli_test_app'
const APP_SECRET = 'test-app-secret-never-log'
const MESSAGE = 'om_original_message'
const UUID = 'feishu-0123456789abcdef0123456789abcdef01'

function response(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json', ...headers },
  })
}

function token(payload = {}) {
  return response(200, {
    code: 0, msg: 'ok', tenant_access_token: 't-test-token', expire: 7200, ...payload,
  })
}

function sent(payload = {}) {
  return response(200, { code: 0, msg: 'ok', data: { message_id: 'om_platform_reply' }, ...payload })
}

function reply() {
  return { messageId: MESSAGE, text: '任务已完成', uuid: UUID }
}

test('tenant token is cached, refreshed near expiry, and concurrent calls share one request', async () => {
  let at = Date.parse('2026-11-25T00:00:00.000Z')
  let calls = 0
  const requests = []
  const client = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    now: () => at,
    tokenSkewMs: 60_000,
    fetchImpl: async (url, options) => {
      calls += 1
      requests.push({ url, options })
      return url.endsWith('/tenant_access_token/internal') ? token() : sent()
    },
  })

  const [first, second] = await Promise.all([
    client.replyToMessage(reply()), client.replyToMessage(reply()),
  ])
  assert.equal(first.messageId, 'om_platform_reply')
  assert.equal(second.messageId, 'om_platform_reply')
  assert.equal(calls, 3)
  assert.equal(requests[0].url, `${FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`)
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), { app_id: APP_ID, app_secret: APP_SECRET })
  assert.equal(requests[1].options.headers.authorization, 'Bearer t-test-token')

  at += 7_140_000
  await client.replyToMessage(reply())
  assert.equal(calls, 5, 'a new token is fetched once after the skew window')
})

test('reply uses the original message endpoint, text content, and stable uuid', async () => {
  const requests = []
  const client = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return requests.length === 1 ? token() : sent()
    },
  })
  const result = await client.replyToMessage(reply())
  assert.deepEqual(result, { messageId: 'om_platform_reply' })
  const request = requests[1]
  assert.equal(request.url, `${FEISHU_API_ORIGIN}/open-apis/im/v1/messages/${MESSAGE}/reply`)
  assert.equal(request.options.method, 'POST')
  assert.deepEqual(JSON.parse(request.options.body), {
    msg_type: 'text', content: JSON.stringify({ text: '任务已完成' }), uuid: UUID,
  })
})

test('timeout is normalized and aborts the fake request without exposing its message', async () => {
  let caught
  const client = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error(`transport at C:\\private\\${APP_SECRET}`)
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }),
  })
  try {
    await client.getTenantAccessToken()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof FeishuApiError)
  assert.equal(caught.code, 'timeout')
  assert.equal(caught.retryable, true)
  assert.doesNotMatch(JSON.stringify(caught), new RegExp(APP_SECRET))
  assert.doesNotMatch(caught.stack, /C:\\private|transport at/)
})

test('429 and 5xx are retryable normalized errors and Retry-After is retained', async () => {
  for (const [status, code, header, expected] of [
    [429, 'rate-limited', '7', 7_000],
    [503, 'server', '2.5', 2_500],
  ]) {
    const client = createFeishuClient({
      credentials: { appId: APP_ID, appSecret: APP_SECRET },
      fetchImpl: async () => status === 429 ? response(status, { code: 99991400, msg: APP_SECRET }, { 'retry-after': header }) : response(status, { msg: APP_SECRET }, { 'retry-after': header }),
    })
    await assert.rejects(() => client.getTenantAccessToken(), error => {
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      assert.equal(error.retryable, true)
      assert.equal(error.retryAfterMs, expected)
      assert.doesNotMatch(JSON.stringify(error), new RegExp(APP_SECRET))
      return true
    })
  }
})

test('business-level rate limit and permanent rejection are distinguished', async () => {
  const limited = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    fetchImpl: async () => token({ code: 99991400, msg: 'busy' }),
  })
  await assert.rejects(() => limited.getTenantAccessToken(), { code: 'rate-limited', retryable: true })

  const denied = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    fetchImpl: async () => token({ code: 99991661, msg: 'invalid app secret' }),
  })
  await assert.rejects(() => denied.getTenantAccessToken(), error => {
    assert.equal(error.code, 'rejected')
    assert.equal(error.retryable, false)
    assert.equal(error.platformCode, 99991661)
    assert.doesNotMatch(error.message, /invalid app secret/)
    return true
  })
})

test('a rejected token is refreshed once and the same uuid is retried', async () => {
  const requests = []
  const client = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    fetchImpl: async (url, options) => {
      requests.push({ url, body: options.body })
      if (url.endsWith('/tenant_access_token/internal')) return token({ tenant_access_token: `token-${requests.length}` })
      if (requests.length === 2) return response(200, { code: 99991663, msg: 'token expired' })
      return sent()
    },
  })
  assert.deepEqual(await client.replyToMessage(reply()), { messageId: 'om_platform_reply' })
  assert.equal(requests.length, 4)
  assert.deepEqual(requests.filter(item => item.url.endsWith('/reply')).map(item => JSON.parse(item.body).uuid), [UUID, UUID])
})

test('malformed and oversized provider responses fail closed', async () => {
  for (const fetchImpl of [
    async () => new Response('not-json', { status: 200 }),
    async () => response(200, { code: 0, msg: 'ok' }),
    async () => new Response('x'.repeat(70_000), { status: 200 }),
  ]) {
    const client = createFeishuClient({ credentials: { appId: APP_ID, appSecret: APP_SECRET }, fetchImpl })
    await assert.rejects(() => client.getTenantAccessToken(), { code: 'invalid-response', retryable: false })
  }
  let calls = 0
  const client = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    fetchImpl: async () => ++calls === 1 ? token() : response(200, { code: 0, data: {} }),
  })
  await assert.rejects(() => client.replyToMessage(reply()), { code: 'invalid-response' })
})

test('only appId/appSecret authentication and bounded reply input are accepted', async () => {
  assert.throws(() => createFeishuClient({ credentials: { tenantAccessToken: 'already-a-token' }, fetchImpl: async () => sent() }), /appId/)
  assert.throws(() => createFeishuClient({ credentials: { appId: '', appSecret: APP_SECRET }, fetchImpl: async () => sent() }), /appId/)
  const client = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    fetchImpl: async () => { throw new Error('must not fetch') },
  })
  await assert.rejects(() => client.replyToMessage({ ...reply(), messageId: '../escape' }), /messageId/)
  await assert.rejects(() => client.replyToMessage({ ...reply(), uuid: 'short' }), /uuid/)
  await assert.rejects(() => client.replyToMessage({ ...reply(), text: 'x'.repeat(801) }), /summary rejected/)
  for (const [text, code] of [
    ['appSecret=hidden', 'summary-credential'],
    ['C:\\private\\report.json', 'summary-absolute-path'],
    ['Error: x\n at run (/tmp/x.js:1:2)', 'summary-stack'],
    ['完整报告', 'summary-full-report'],
  ]) {
    await assert.rejects(() => client.replyToMessage({ ...reply(), text }), error => error.code === code)
  }
})

test('logs and errors contain metadata only, never credentials, response bodies, paths, or stacks', async () => {
  const logs = []
  let caught
  const client = createFeishuClient({
    credentials: { appId: APP_ID, appSecret: APP_SECRET },
    log: event => logs.push(event),
    fetchImpl: async (_url, options) => {
      if (options.headers.authorization) {
        return response(200, {
          code: 230001, msg: `denied ${APP_SECRET}`,
          data: { stack: `at run (C:\\secret\\file.js:1:2) ${APP_ID}` },
        })
      }
      return token()
    },
  })
  try {
    await client.replyToMessage(reply())
  } catch (error) {
    caught = error
  }
  assert.equal(caught?.code, 'rejected')
  const observable = JSON.stringify({ logs, error: caught })
  for (const secret of [APP_ID, APP_SECRET, 'denied', 'C:\\secret', 'at run']) {
    assert.equal(observable.includes(secret), false, secret)
  }
  assert.deepEqual(logs, [{ event: 'feishu-token-request' }])
})
