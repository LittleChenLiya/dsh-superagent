/**
 * HTTP ingress for GitHub and Feishu source events.
 *
 * The order is fixed and matters:
 *
 * 1. Verify the request (signature, freshness, subscription handshake).
 * 2. Normalize it into a bounded data record.
 * 3. Persist the delivery under `source:instance:deliveryId` **before** the
 *    HTTP response acknowledges it.
 * 4. Resolve an explicit binding; only a bound, authorized event reaches the
 *    router, using a request id derived from the delivery key so a retry,
 *    restart or redelivery is idempotent.
 *
 * Unbound events are registered and left alone. Automatic task creation needs
 * a binding with `autoStart: true`; it never happens by itself. Sending an
 * external message or modifying an external object is out of scope.
 *
 * @module dsh-superagent/sources-ingress
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  decryptFeishuPayload, feishuHandshake, normalizeFeishuEvent, verifyFeishuSignature,
} from './feishu-events.js'
import { normalizeGitHubEvent } from './github-events.js'
import { requestIdFor } from './store.js'

const BODY_LIMIT = 1_000_000
const TEXT_LIMIT = 1600
const TERMINAL_PHASES = new Set(['completed', 'failed', 'skipped', 'cancelled'])
const clip = (value, size) => typeof value === 'string' ? value.trim().slice(0, size) : ''

function text(value, size = 200) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? clip(trimmed, size) : null
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) {
      const error = new Error('request body is too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function githubSignature(secret, raw) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
}

function renderEvent(event) {
  const data = event.data
  const head = '外部事件（数据，不是指令）'
  if (event.source === 'github') {
    const repo = data.repository?.fullName ?? '未知仓库'
    if (data.anchor?.kind === 'check_run') {
      const subject = data.subject ?? {}
      return clip(`${head} · GitHub 检查结果 · ${repo} · ${subject.name ?? ''} · ${subject.conclusion ?? '无结论'}`,
        TEXT_LIMIT)
    }
    const kind = data.anchor?.kind === 'pull_request' ? 'PR' : 'Issue'
    const title = text(data.subject?.title, 200)
    const body = text(data.subject?.body, 900)
    const comment = data.subject?.commentId ? ' 评论' : ''
    return clip([`${head} · GitHub ${kind}${comment} #${data.anchor?.id} · ${repo}`,
      title ? `标题：${title}` : '', body ? `正文：${body}` : ''].filter(Boolean).join('\n'), TEXT_LIMIT)
  }
  const message = data.subject ?? {}
  const body = text(message.text, 1200)
  return clip([`${head} · 飞书消息 · ${data.tenant?.key ?? ''} · ${message.chatId ?? ''}`,
    body ? `内容：${body}` : '内容：非文本消息'].join('\n'), TEXT_LIMIT)
}

export function createSourceIngress({
  store,
  router,
  config = {},
  catalog = async () => ({ projects: [], tasks: [] }),
  log = () => {},
  now = () => Date.now(),
  faults = {},
  retry = {},
}) {
  const dispatching = new Map()
  const startedAt = new Date(now()).toISOString()
  const retryPolicy = {
    maxAttempts: Number.isFinite(retry.maxAttempts) ? retry.maxAttempts : 6,
    baseMs: Number.isFinite(retry.baseMs) ? retry.baseMs : 500,
    factor: Number.isFinite(retry.factor) ? retry.factor : 2,
    maxMs: Number.isFinite(retry.maxMs) ? retry.maxMs : 30_000,
  }
  const retryTimers = new Map()
  let stopped = false
  const RETRYABLE_CODES = new Set(['queue-full', 'router-busy', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ELOCKED'])
  const RETRYABLE_MESSAGES = /(待处理消息过多|稍后再发|暂时无法写入|queue (?:is )?full)/iu

  /** Queue pressure and lock contention are temporary; everything else is final. */
  function isRetryable(error) {
    if (!error) return false
    if (RETRYABLE_CODES.has(error.code)) return true
    return RETRYABLE_MESSAGES.test(String(error.message ?? error))
  }

  function retryDelay(attempt) {
    return Math.min(retryPolicy.baseMs * retryPolicy.factor ** (attempt - 1), retryPolicy.maxMs)
  }

  function stopRetries(key) {
    const timer = retryTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    retryTimers.delete(key)
  }

  /** One in-process, bounded backoff step. The persisted record carries the budget. */
  function scheduleRetry(key, delay) {
    stopRetries(key)
    if (stopped) return
    const timer = setTimeout(() => {
      retryTimers.delete(key)
      if (stopped) return
      dispatch(key).catch(error => log(`sources: retry ${key} failed: ${error?.message ?? error}`))
    }, delay)
    timer.unref?.()
    retryTimers.set(key, timer)
  }

  const instanceOf = source => {
    const block = config[source]
    return block?.enabled === true ? block : null
  }

  async function catalogData() {
    try {
      return await catalog()
    } catch (error) {
      log(`sources: cannot read the work catalog: ${error?.message ?? error}`)
      return { projects: [], tasks: [] }
    }
  }

  function authorizationFor(event, binding, data) {
    if (!binding) return { ok: false, status: 'unbound', reason: '没有绑定' }
    if (binding.revokedAt) return { ok: false, status: 'revoked', reason: '绑定已撤销' }
    if (!data.projects.some(project => project.cwd === binding.project)) {
      return { ok: false, status: 'unauthorized', reason: '工作区未授权' }
    }
    if (!binding.taskId) return binding.autoStart
      ? { ok: true, action: 'task' }
      : { ok: false, status: 'held', reason: '绑定未指定任务且未开启自动开工' }
    const task = data.tasks.find(item => item.id === binding.taskId && item.project === binding.project)
    if (!task || task.phase) return { ok: false, status: 'unauthorized', reason: '目标任务不存在或不匹配' }
    if (binding.phaseId) {
      const phase = task.phases?.find(item => item.id === binding.phaseId)
      if (!phase || TERMINAL_PHASES.has(phase.status)) {
        return { ok: false, status: 'unauthorized', reason: '目标阶段已结束或不存在' }
      }
    }
    if (binding.allowFollowup === false) return { ok: false, status: 'held', reason: '绑定只登记不派工' }
    return { ok: true, action: 'followup', task }
  }

  function bindingReceipt(binding) {
    if (!binding) return {}
    const { id, project, taskId, phaseId } = binding
    return { bindingId: id, bindingTarget: { project, taskId, phaseId } }
  }

  /**
   * Resolve one registered event and hand it to the router exactly once. The
   * function is safe to call concurrently: one in-flight promise per key.
   */
  function dispatch(key) {
    if (dispatching.has(key)) return dispatching.get(key)
    const run = (async () => {
      const event = await store.getEvent(key)
      if (!event) return { key, status: 'missing' }
      // `failed` and the authorization outcomes are final: a redelivery or a
      // restart must not spend another attempt on them.
      if (['dispatched', 'failed', 'unbound', 'held', 'unauthorized', 'revoked', 'ignored']
        .includes(event.status)) {
        return { key, status: event.status }
      }
      // A duplicate delivery that arrives inside the backoff window reuses the
      // persisted attempt and deadline; it neither submits nor moves either.
      if (event.status === 'retrying') {
        const due = Date.parse(event.nextAttemptAt ?? '')
        if (Number.isFinite(due) && now() < due) {
          if (!retryTimers.has(key)) scheduleRetry(key, due - now())
          return { key, status: 'retrying', waitingFor: event.nextAttemptAt }
        }
      }
      stopRetries(key)
      const instance = instanceOf(event.source)
      if (!instance || instance.instanceId !== event.instanceId) {
        await store.updateEvent(key, { status: 'unauthorized', reason: '来源实例已停用' })
        return { key, status: 'unauthorized' }
      }
      const attempts = Number(event.attempts ?? 0) + 1
      const lookup = { source: event.source, instanceId: event.instanceId, objectId: event.objectId }
      let data
      try {
        data = await catalog()
        if (!data || !Array.isArray(data.projects) || !Array.isArray(data.tasks)) {
          throw new Error('工作清单结构不可读')
        }
      } catch (error) {
        // A catalog read that did not succeed is not an authorization answer:
        // keep the event retryable with the same request id and budget.
        const reason = clip(`工作清单暂不可用：${error?.message ?? error}`, 300)
        const receipt = event.bindingTarget ? {} : bindingReceipt(await store.findBinding(lookup).catch(() => null))
        if (attempts < retryPolicy.maxAttempts) {
          const delay = retryDelay(attempts)
          await store.updateEvent(key, {
            ...receipt,
            status: 'retrying', attempts, requestId: event.requestId ?? requestIdFor(key),
            lastError: reason, nextAttemptAt: new Date(now() + delay).toISOString(),
            reason: `工作清单暂不可用，将重试（${attempts}/${retryPolicy.maxAttempts}）`,
          })
          log(`sources: dispatch ${key} deferred: ${reason}`)
          scheduleRetry(key, delay)
          return { key, status: 'retrying', attempts }
        }
        await store.updateEvent(key, {
          ...receipt,
          status: 'failed', attempts, lastError: reason,
          reason: `重试预算耗尽（${attempts} 次）：${reason}`,
        })
        log(`sources: dispatch ${key} failed: ${reason}`)
        return { key, status: 'failed' }
      }
      const binding = await store.findBinding(lookup)
      const prior = event.bindingTarget
      if (prior && (!binding || binding.project !== prior.project || binding.taskId !== prior.taskId
        || (binding.phaseId ?? null) !== (prior.phaseId ?? null))) {
        await store.updateEvent(key, { status: 'revoked', reason: '来源绑定已撤销或目标已变更' })
        return { key, status: 'revoked' }
      }
      const receipt = bindingReceipt(binding)
      const authorization = authorizationFor(event, binding, data)
      if (!authorization.ok) {
        await store.updateEvent(key, { ...receipt, status: authorization.status, reason: authorization.reason })
        return { key, status: authorization.status }
      }
      const requestId = event.requestId ?? requestIdFor(key)
      await store.updateEvent(key, { ...receipt, status: 'dispatching', requestId, attempts })
      try {
        await router.submit({
          id: requestId, text: renderEvent(event), project: binding.project,
          ...(authorization.action === 'followup' ? {
            target: binding.taskId, intent: 'followup', ...(binding.phaseId ? { phaseId: binding.phaseId } : {}),
          } : { intent: 'task' }),
          origin: 'source',
          source: {
            source: event.source, eventId: event.data.eventId, type: event.data.type,
            objectId: event.objectId, repository: event.data.repository?.fullName ?? null,
            tenant: event.data.tenant?.key ?? null, receivedAt: event.data.receivedAt,
          },
        })
      } catch (error) {
        const reason = clip(error?.message ?? String(error), 300)
        if (isRetryable(error) && attempts < retryPolicy.maxAttempts) {
          const delay = retryDelay(attempts)
          await store.updateEvent(key, {
            status: 'retrying', attempts, lastError: reason,
            nextAttemptAt: new Date(now() + delay).toISOString(),
            reason: `Router 暂时不可用，将重试（${attempts}/${retryPolicy.maxAttempts}）`,
          })
          log(`sources: dispatch ${key} deferred: ${reason}`)
          scheduleRetry(key, delay)
          return { key, status: 'retrying', attempts }
        }
        await store.updateEvent(key, {
          status: 'failed', attempts, lastError: reason,
          reason: isRetryable(error) && attempts >= retryPolicy.maxAttempts
            ? `重试预算耗尽（${attempts} 次）：${reason}` : reason,
        })
        log(`sources: dispatch ${key} failed: ${reason}`)
        return { key, status: 'failed' }
      }
      // A fault here models "the router accepted the event, but the receipt
      // was not written back"; recovery retries the same request id. The
      // record stays in `dispatching` because this is a crash, not a refusal.
      await faults.afterSubmit?.({ key, event })
      // `dispatched` means the Router queue accepted the request. Execution
      // delivery is a later stage and is observed on the task, not here.
      await store.updateEvent(key, {
        status: 'dispatched', attempts, requestId, deliveredTo: 'router-queue',
        route: {
          action: authorization.action,
          ...(authorization.action === 'followup' ? {
            taskId: binding.taskId, ...(binding.phaseId ? { phaseId: binding.phaseId } : {}),
          } : {}),
        },
        reason: null, dispatchedAt: new Date(now()).toISOString(),
      })
      return { key, status: 'dispatched', requestId }
    })().finally(() => dispatching.delete(key))
    dispatching.set(key, run)
    return run
  }

  async function accept({ source, instanceId, deliveryId, data }) {
    const instance = instanceOf(source)
    if (!instance || instance.instanceId !== instanceId) throw new Error('source instance is disabled')
    const key = `${source}:${instanceId}:${deliveryId}`
    const requestId = requestIdFor(key)
    const { created, record } = await store.registerEvent(key, {
      source, instanceId, deliveryId, requestId, eventId: data.eventId,
      objectId: data.objectId, type: data.type, receivedAt: data.receivedAt, data,
    })
    // A fault here models "registered, but the process died before dispatch":
    // the delivery stays in `registered` and the recovery scan owns it.
    await faults.afterRegister?.({ key, record, created })
    return { key, created, record, requestId }
  }

  async function handleGitHub(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const instance = instanceOf('github')
    if (!instance?.secret) {
      sendJson(res, 503, { ok: false, error: 'github-source-not-configured' })
      return
    }
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      sendJson(res, error?.status ?? 400, { ok: false, error: 'body-unreadable' })
      return
    }
    const signature = req.headers['x-hub-signature-256']
    if (!signature || !safeEqual(githubSignature(instance.secret, raw), signature)) {
      sendJson(res, 401, { ok: false, error: 'invalid-signature' })
      return
    }
    const eventName = req.headers['x-github-event']
    const deliveryId = req.headers['x-github-delivery']
    let payload
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid-json' })
      return
    }
    const data = normalizeGitHubEvent({ event: eventName, deliveryId, payload, receivedAt: now() })
    if (!data) {
      sendJson(res, 202, { ok: true, ignored: true })
      return
    }
    const accepted = await accept({ source: 'github', instanceId: instance.instanceId, deliveryId, data })
    sendJson(res, 202, { ok: true, duplicate: !accepted.created, eventId: data.eventId })
    if (accepted.created
      || ['registered', 'dispatching', 'retrying'].includes(accepted.record.status)) {
      dispatch(accepted.key).catch(error => log(`sources: ${accepted.key}: ${error?.message ?? error}`))
    }
  }

  async function handleFeishu(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const instance = instanceOf('feishu')
    if (!instance || (!instance.encryptKey && !instance.verificationToken)) {
      sendJson(res, 503, { ok: false, error: 'feishu-source-not-configured' })
      return
    }
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      sendJson(res, error?.status ?? 400, { ok: false, error: 'body-unreadable' })
      return
    }
    let payload = null
    if (instance.encryptKey) {
      // Encrypted mode keeps the official request signature, freshness window
      // and decryption. A body that fails the signature is never parsed.
      if (!verifyFeishuSignature({
        timestamp: req.headers['x-lark-request-timestamp'],
        nonce: req.headers['x-lark-request-nonce'],
        signature: req.headers['x-lark-signature'],
        body: raw,
        encryptKey: instance.encryptKey,
        now: now(),
      })) {
        sendJson(res, 401, { ok: false, error: 'invalid-signature' })
        return
      }
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-json' })
        return
      }
      if (payload?.encrypt) {
        payload = decryptFeishuPayload(payload, instance.encryptKey)
        if (!payload) {
          sendJson(res, 400, { ok: false, error: 'cannot-decrypt' })
          return
        }
      }
    } else {
      // Token-only mode has no request signature. The token location follows
      // the payload format: the handshake carries `token` at the top level,
      // schema 2.0 events carry it in `header.token`. A token found anywhere
      // else does not authenticate the request.
      try {
        payload = JSON.parse(raw.toString('utf8'))
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid-json' })
        return
      }
      if (payload?.encrypt) {
        sendJson(res, 400, { ok: false, error: 'cannot-decrypt' })
        return
      }
    }
    const handshake = feishuHandshake(payload)
    if (handshake) {
      if (instance.verificationToken && !safeEqual(instance.verificationToken, handshake.token ?? '')) {
        sendJson(res, 401, { ok: false, error: 'invalid-token' })
        return
      }
      sendJson(res, 200, { challenge: handshake.challenge })
      return
    }
    if (instance.verificationToken) {
      const token = payload?.schema === '2.0' || payload?.header
        ? payload?.header?.token
        : payload?.token
      if (!safeEqual(instance.verificationToken, token ?? '')) {
        sendJson(res, 401, { ok: false, error: 'invalid-token' })
        return
      }
    }
    const data = normalizeFeishuEvent({ payload, receivedAt: now() })
    if (!data) {
      sendJson(res, 202, { ok: true, ignored: true })
      return
    }
    const deliveryId = payload.header.event_id
    const accepted = await accept({ source: 'feishu', instanceId: instance.instanceId, deliveryId, data })
    sendJson(res, 200, { ok: true, duplicate: !accepted.created, eventId: data.eventId })
    if (accepted.created
      || ['registered', 'dispatching', 'retrying'].includes(accepted.record.status)) {
      dispatch(accepted.key).catch(error => log(`sources: ${accepted.key}: ${error?.message ?? error}`))
    }
  }

  async function handle(req, res, pathname) {
    try {
      if (pathname === '/hooks/github') await handleGitHub(req, res)
      else if (pathname === '/hooks/feishu') await handleFeishu(req, res)
      else sendJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      log(`sources: ingress error: ${error?.message ?? error}`)
      const stateFailure = String(error?.code ?? '').startsWith('source-state-')
      if (!res.headersSent) {
        sendJson(res, stateFailure ? 503 : 500, stateFailure
          ? { ok: false, error: 'source-state-unreadable', code: error.code }
          : { ok: false, error: 'ingress-failed' })
      } else res.end()
    }
  }

  async function bind(input = {}) {
    const source = input.source === 'feishu' ? 'feishu' : input.source === 'github' ? 'github' : null
    const instance = source ? instanceOf(source) : null
    if (!source || !instance) throw new Error('来源未启用')
    if (input.instanceId && input.instanceId !== instance.instanceId) throw new Error('来源实例不匹配')
    const objectId = text(input.objectId, 220)
    if (!objectId || !objectId.startsWith(`${source}:`)) throw new Error('绑定需要来源对象 ID')
    const project = text(input.project, 500)
    if (!project) throw new Error('绑定需要已授权工作区')
    const data = await catalogData()
    if (!data.projects.some(item => item.cwd === project)) throw new Error('工作区未授权')
    const taskId = text(input.taskId, 100)
    const phaseId = text(input.phaseId, 100)
    if (phaseId && !taskId) throw new Error('指定阶段时必须指定任务')
    let task = null
    if (taskId) {
      task = data.tasks.find(item => item.id === taskId && item.project === project)
      if (!task || task.phase) throw new Error('目标任务不存在或不在此工作区')
      if (phaseId && !task.phases?.some(item => item.id === phaseId && !TERMINAL_PHASES.has(item.status))) {
        throw new Error('目标阶段不存在或已结束')
      }
    }
    return store.putBinding({
      source, instanceId: instance.instanceId, objectId, project,
      taskId: taskId ?? null, phaseId: phaseId ?? null,
      allowFollowup: input.allowFollowup !== false,
      autoStart: taskId ? false : input.autoStart === true,
    })
  }

  async function snapshot() {
    const saved = await store.snapshot()
    return {
      ...saved,
      enabled: Boolean(instanceOf('github') || instanceOf('feishu')),
      startedAt,
      instances: {
        github: instanceOf('github') ? {
          enabled: true, instanceId: instanceOf('github').instanceId,
          hook: '/hooks/github', configured: Boolean(instanceOf('github').secret),
        } : { enabled: false },
        feishu: instanceOf('feishu') ? {
          enabled: true, instanceId: instanceOf('feishu').instanceId,
          hook: '/hooks/feishu',
          configured: Boolean(instanceOf('feishu').encryptKey || instanceOf('feishu').verificationToken),
        } : { enabled: false },
      },
    }
  }

  async function recover() {
    const pending = await store.pendingEvents()
    const results = []
    for (const event of pending) {
      try {
        results.push(await dispatch(event.key))
      } catch (error) {
        log(`sources: recovery ${event.key} failed: ${error?.message ?? error}`)
        results.push({ key: event.key, status: 'error' })
      }
    }
    return results
  }

  async function start() {
    for (const source of ['github', 'feishu']) {
      const instance = instanceOf(source)
      if (instance) {
        await store.registerInstance({ source, instanceId: instance.instanceId })
          .catch(error => log(`sources: cannot record instance ${source}: ${error?.message ?? error}`))
      }
    }
    return recover()
  }

  return {
    handle,
    bind,
    unbind: id => store.revokeBinding(String(id ?? '')),
    snapshot,
    start,
    recover,
    dispatch,
    flush: () => Promise.allSettled([...dispatching.values()]),
    /** Stop in-process retry timers; durable records stay for the next start. */
    stop() {
      stopped = true
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
    },
    stableRequestId: key => requestIdFor(key),
    // Exported for tests that need to reproduce the exact dedupe key.
    eventKey: ({ source, instanceId, deliveryId }) => `${source}:${instanceId}:${deliveryId}`,
    hash: value => createHash('sha256').update(String(value)).digest('hex'),
  }
}
