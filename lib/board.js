/**
 * dsh-superagent — the task board.
 *
 * One loopback page that answers three questions a person actually has:
 * what is each subtask doing right now, what needs me, and how do I start the
 * common kinds of work without writing a prompt.
 *
 * The board is an observer and a remote control, not a second orchestrator:
 * every action goes through the host adapter, which owns the live agents.
 * A broken connection costs nothing because each new stream opens with a full
 * snapshot, and the snapshot is rebuilt from durable run records.
 *
 * @module dsh-superagent/board
 */
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { ACTIVE_STATUSES } from './store.js'
import { formatMoney } from './cost.js'
import {
  errorPayload,
  readJson,
  sameToken,
  send,
  sendText,
  statusFor,
  WorkbenchError,
} from './workbench.js'
import {
  explainFailure,
  explainRun,
  parameterCopy,
  runStatusLabel,
  skipReason,
  subtaskStatusLabel,
  templateCopy,
} from './board-messages.js'

const DISCOVERY_FILE = 'board.json'
const MAX_CLIENTS = 16
const MAX_RUNS = 30
const MAX_RESULT_CHARS = 24_000
const MAX_AUDIT_ROWS = 120
const POLL_MS = 1_000
const HEARTBEAT_MS = 15_000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024
const ROUTE_HINT = 'GET / serves the board; the JSON API is under /api/board.'

const ACTIVE_SUBTASK = new Set(['pending', 'waiting', 'running'])

/** @param {unknown} value @returns {string} */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}

function trimText(value, limit) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function durationMs(from, to) {
  const start = Date.parse(from ?? '')
  if (!Number.isFinite(start)) return null
  const end = to ? Date.parse(to) : Date.now()
  return Number.isFinite(end) ? Math.max(0, end - start) : null
}

/**
 * Shape one subtask for a card: enough to decide whether to stop it, rerun it,
 * or ask why it never started, and no full output (that is a detail request).
 */
function subtaskCard(run, subtask, { now = Date.now() } = {}) {
  const failure = explainFailure(run, subtask)
  const active = ACTIVE_STATUSES.has(run.status)
  const usage = subtask.usage && typeof subtask.usage === 'object' ? subtask.usage : null
  const cost = subtask.cost ?? null
  const finishedAt = subtask.finishedAt ?? null
  const elapsed = durationMs(subtask.startedAt, finishedAt ?? new Date(now).toISOString())
  return {
    key: subtask.key ?? `w${subtask.index}`,
    index: subtask.index ?? null,
    title: subtask.title ?? '(未命名子任务)',
    status: subtask.status ?? 'pending',
    statusLabel: subtaskStatusLabel(subtask.status),
    attempts: subtask.attempts ?? 0,
    startedAt: subtask.startedAt ?? null,
    finishedAt,
    elapsedMs: elapsed,
    childId: subtask.childId ?? null,
    dependsOn: Array.isArray(subtask.dependsOn) ? subtask.dependsOn : [],
    waitingOn: Array.isArray(subtask.waitingOn) ? subtask.waitingOn : [],
    requires: Array.isArray(subtask.requires) ? subtask.requires : [],
    missingCapabilities: Array.isArray(subtask.missingCapabilities) ? subtask.missingCapabilities : [],
    skipReason: skipReason(subtask, run),
    blockedReason: subtask.blockedReason ?? null,
    unverifiedReason: subtask.unverifiedReason ?? null,
    tokens: usage?.totalTokens ?? null,
    cost: cost ? { text: formatMoney(cost), currency: cost.currency ?? null, unpriced: cost.unpriced ?? [] } : null,
    explanation: failure && (subtask.status === 'failed' || subtask.status === 'blocked'
      || subtask.status === 'unverified' || subtask.status === 'cancelled') ? failure : null,
    hasResult: typeof subtask.result === 'string' && subtask.result.length > 0,
    canCancel: active && ACTIVE_SUBTASK.has(subtask.status),
    canRerun: !active && subtask.status !== 'pending' && subtask.status !== 'waiting',
  }
}

/** Shape one run for the board's left column and its detail cards. */
function runCard(run, { now = Date.now() } = {}) {
  const subtasks = Array.isArray(run.subtasks) ? run.subtasks : []
  const counts = { total: subtasks.length }
  for (const subtask of subtasks) {
    const key = subtask.status ?? 'pending'
    counts[key] = (counts[key] ?? 0) + 1
  }
  const usage = run.usage && typeof run.usage === 'object' ? run.usage : null
  const cost = run.cost ?? null
  const openAttention = Array.isArray(run.attention?.items)
    ? run.attention.items.filter(item => item && !item.answer)
    : []
  const failure = explainRun(run)
  return {
    id: run.id,
    goal: trimText(run.goal, 300) ?? '(没有目标文本)',
    status: run.status ?? 'unknown',
    statusLabel: runStatusLabel(run.status),
    mode: run.mode ?? 'planned',
    createdAt: run.createdAt ?? null,
    finishedAt: run.finishedAt ?? null,
    elapsedMs: durationMs(run.createdAt, run.finishedAt ?? new Date(now).toISOString()),
    active: ACTIVE_STATUSES.has(run.status),
    cancelPending: run.cancelPending === true,
    tokens: usage?.totalTokens ?? null,
    cost: cost ? { text: formatMoney(cost), currency: cost.currency ?? null, unpriced: cost.unpriced ?? [] } : null,
    counts,
    attentionCount: openAttention.length,
    error: run.error ? trimText(String(run.error), 500) : null,
    explanation: failure,
    preflight: run.preflight ?? null,
    planNeedsInput: Array.isArray(run.plan?.needsInput) ? run.plan.needsInput.length : 0,
    subtasks: subtasks.map(subtask => subtaskCard(run, subtask, { now })),
  }
}

function optionList(item) {
  return Array.isArray(item?.options) ? item.options.filter(option => typeof option === 'string' && option.trim()) : []
}

/**
 * Collect everything that actually waits for a person.
 *
 * The id is the routing key for the answer endpoint, so it names the kind and
 * the exact object; nothing is answered by array position.
 */
function buildInbox(runs, extras = []) {
  const items = []
  for (const run of runs) {
    const goal = trimText(run.goal, 160) ?? run.id
    const open = Array.isArray(run.attention?.items)
      ? run.attention.items.filter(item => item && !item.answer)
      : []
    for (const [position, item] of open.entries()) {
      const id = item.id ?? `q${position + 1}`
      items.push({
        id: `question:${run.id}:${id}`,
        kind: 'question',
        kindLabel: '需要你回答',
        runId: run.id,
        runGoal: goal,
        title: trimText(item.question, 300) ?? '运行需要你的一个决定',
        what: `运行「${goal}」停在这里，等你回答：${trimText(item.question, 200) ?? '一个执行者无法自行决定的问题'}`,
        why: trimText(item.reason, 300)
          ?? (item.source === 'planner'
            ? '规划器无法从目标里推断出这一点，凭猜测开工会把整次运行带偏。'
            : '执行者遇到了只有你能做的判断，停下比自行假设更安全。'),
        options: optionList(item),
        impact: '回答会作为一条明确指令交给这次运行，未完成的部分会继续；不会新开一次运行。',
        input: 'choice-or-text',
        canAnswer: true,
      })
    }
    for (const subtask of run.subtasks ?? []) {
      if (subtask.status === 'unverified') {
        items.push({
          id: `review:${run.id}:${subtask.key}`,
          kind: 'review',
          kindLabel: '需要你验收',
          runId: run.id,
          runGoal: goal,
          subtaskKey: subtask.key,
          title: `验收「${subtask.title || subtask.key}」的交付物`,
          what: `${subtask.unverifiedReason || '当前会话没有能力判断这个交付物是否正确。'}`,
          why: '模型自己说完成不算数；这一票需要人看一眼。通过后它会进入最终报告，重做则会重新执行这一条。',
          options: ['确认通过', '要求重做'],
          impact: '「确认通过」把这条件任务计为完成并重新汇总报告；「要求重做」只重跑这一条。',
          input: 'choice-or-text',
          canAnswer: true,
        })
      }
      if (subtask.status === 'blocked') {
        const missing = Array.isArray(subtask.missingCapabilities) ? subtask.missingCapabilities : []
        items.push({
          id: `blocked:${run.id}:${subtask.key}`,
          kind: 'capability',
          kindLabel: '缺少能力',
          runId: run.id,
          runGoal: goal,
          subtaskKey: subtask.key,
          title: `「${subtask.title || subtask.key}」缺少 ${missing.join('、') || '所需工具'}，没有启动`,
          what: `规划里这条子任务声明需要 ${missing.join('、') || '一个当前会话没有的工具'}，预检时被拦下，零 token 消耗。`,
          why: '没有对应工具就开工，模型只会编造结果；所以这里选择不启动。',
          options: ['我已补上能力，重跑这条'],
          impact: '会先检查当前会话是否真的有这个工具，然后只重跑这一条子任务。',
          input: 'choice',
          canAnswer: true,
        })
      }
    }
    if (run.status === 'interrupted') {
      items.push({
        id: `resume:${run.id}`,
        kind: 'resume',
        kindLabel: '需要你继续',
        runId: run.id,
        runGoal: goal,
        title: `运行「${goal}」被中断`,
        what: '宿主或会话在运行途中退出，未完成的工作还留在状态目录里。',
        why: '中断不是失败，已完成的部分不需要重做。',
        options: ['继续未完成的工作'],
        impact: '只重新执行未完成的子任务，已完成的会保留。',
        input: 'choice',
        canAnswer: true,
      })
    }
  }
  for (const extra of extras) {
    if (!extra || !extra.id) continue
    items.push({
      kindLabel: '需要你处理',
      input: 'choice-or-text',
      canAnswer: true,
      ...extra,
    })
  }
  items.sort((left, right) => String(left.kind).localeCompare(String(right.kind)))
  return items
}

function templateCard(template) {
  const copy = templateCopy(template.id)
  return {
    id: template.id,
    title: template.title,
    purpose: copy.purpose,
    bestFor: copy.bestFor,
    estimate: copy.estimate,
    whenToUse: template.whenToUse,
    whenNotToUse: Array.isArray(template.whenNotToUse) ? template.whenNotToUse : [],
    params: (template.variables ?? []).map(variable => ({
      name: variable.name,
      label: parameterCopy(variable.name).label,
      hint: parameterCopy(variable.name).hint,
      description: variable.description ?? null,
    })),
  }
}

/**
 * Create one loopback board.
 *
 * @param {object} options - dependencies.
 * @param {number} options.port - port, or 0 for an ephemeral one.
 * @param {string} options.stateRoot - where `board.json` is written.
 * @param {string} options.version - plugin version.
 * @param {object} options.host - host adapter (see README "Board").
 * @param {object} [options.pricing] - price table for live cost estimates.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 */
export function createBoard({ port, stateRoot, version, host, pricing, log = () => {} }) {
  if (!host || typeof host !== 'object') throw new Error('createBoard needs a host adapter')
  const token = randomBytes(32).toString('base64url')
  const instanceId = randomBytes(6).toString('hex')
  const discoveryPath = path.join(stateRoot, DISCOVERY_FILE)
  const startedAt = new Date().toISOString()
  const clients = new Set()
  let boundPort = null
  let server = null
  let page = null
  let starting = null
  let closing = null
  let stopRequested = false
  let poller = null
  let lastSnapshotJson = ''
  let seq = 0

  const url = () => `http://127.0.0.1:${boundPort}`
  const allowedHosts = () => new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  ])

  function capabilities() {
    try {
      const value = host.capabilities()
      if (!value || typeof value !== 'object') {
        return { start: false, answer: false, reason: '宿主没有提供看板能力信息' }
      }
      return {
        start: value.start === true,
        answer: value.answer === true,
        reason: typeof value.reason === 'string' && value.reason.trim() ? value.reason.trim() : null,
      }
    } catch (error) {
      return { start: false, answer: false, reason: `读取宿主能力失败：${messageOf(error)}` }
    }
  }

  function authorize(req, { allowQuery = false } = {}) {
    if (!boundPort) {
      throw new WorkbenchError(503, '看板还没有开始监听', { id: 'not-ready' })
    }
    const hostHeader = String(req.headers.host ?? '').toLowerCase()
    if (!allowedHosts().has(hostHeader)) {
      throw new WorkbenchError(403, `只接受本机访问，收到 Host "${hostHeader}"`, {
        id: 'forbidden-host',
        hint: `请直接打开 ${url()}`,
      })
    }
    const header = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    let given = match?.[1] ?? ''
    if (!given && allowQuery) {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
      if (query) given = query
    }
    if (!given || !sameToken(given, token)) {
      throw new WorkbenchError(401, '缺少访问口令或口令不正确', {
        id: 'unauthorized',
        hint: `打开 ${discoveryPath}，把其中的 token 填进来；口令每次随宿主启动重新生成。`,
      })
    }
  }

  function nextSeq() {
    seq += 1
    return seq
  }

  function writeFrame(res, frame) {
    if (res.destroyed || res.writableEnded) return false
    res.write(`event: board\ndata: ${JSON.stringify(frame)}\n\n`)
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      log(`board: dropping a stream that stopped reading (${res.writableLength} bytes buffered)`)
      res.destroy()
      clients.delete(res)
      return false
    }
    return true
  }

  function broadcast(frame) {
    const withSeq = { ...frame, seq: nextSeq(), at: new Date().toISOString() }
    for (const res of clients) {
      try {
        writeFrame(res, withSeq)
      } catch {
        clients.delete(res)
      }
    }
    return withSeq
  }

  async function listRuns() {
    const value = await host.listRuns()
    if (!Array.isArray(value)) return []
    return value
      .filter(run => run && typeof run === 'object' && run.id)
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
      .slice(0, MAX_RUNS)
  }

  async function extras() {
    if (typeof host.extraInbox !== 'function') return []
    try {
      const value = await host.extraInbox()
      return Array.isArray(value) ? value : []
    } catch (error) {
      log(`board: cannot read extra inbox items: ${messageOf(error)}`)
      return []
    }
  }

  async function snapshot() {
    const runs = await listRuns()
    const cards = runs.map(run => runCard(run))
    const inbox = buildInbox(runs, await extras())
    const templateList = typeof host.templates === 'function' ? await host.templates() : []
    return {
      service: 'dsh-superagent-board',
      version,
      at: new Date().toISOString(),
      capabilities: capabilities(),
      runs: cards,
      inbox,
      templates: (Array.isArray(templateList) ? templateList : []).map(templateCard),
      summary: {
        runs: cards.length,
        active: cards.filter(card => card.active).length,
        inbox: inbox.length,
      },
    }
  }

  async function runDetail(runId) {
    const run = await host.readRun(runId)
    if (!run) throw new WorkbenchError(404, `找不到运行 ${runId}`, { id: 'unknown-run' })
    const card = runCard(run)
    const subtasks = (run.subtasks ?? []).map(subtask => {
      const item = subtaskCard(run, subtask)
      return {
        ...item,
        prompt: trimText(subtask.prompt, 4_000),
        result: trimText(subtask.result, MAX_RESULT_CHARS),
        error: trimText(subtask.error, 4_000),
        stopReason: subtask.stopReason ?? null,
        deliverables: Array.isArray(subtask.deliverables) ? subtask.deliverables : [],
        deliverableCheck: subtask.deliverableCheck ?? null,
        audit: [],
      }
    })
    const runAudit = []
    if (typeof host.auditFor === 'function') {
      try {
        const rows = await host.auditFor({ runId, limit: 400 })
        for (const row of rows) {
          const entry = {
            id: row.id ?? null,
            at: row.at ?? null,
            kind: row.kind ?? null,
            action: row.action ?? null,
            subtaskId: row.subtaskId ?? null,
            actor: row.actor ?? null,
            decision: row.decision ?? null,
            result: row.result ?? null,
            target: trimText(row.target, 300),
            rule: row.rule ?? null,
            reason: trimText(row.meta?.reason, 300),
          }
          runAudit.push(entry)
          if (entry.subtaskId) {
            const target = subtasks.find(subtask => entry.subtaskId === `subtask-${subtask.index}`)
            if (target) target.audit.push(entry)
          }
        }
      } catch (error) {
        log(`board: cannot read audit for ${runId}: ${messageOf(error)}`)
      }
    }
    return {
      run: card,
      goal: run.goal,
      report: trimText(run.report, 60_000),
      recovery: run.recovery ?? null,
      limits: run.limits ?? null,
      usage: run.usage ?? null,
      audit: runAudit.slice(-MAX_AUDIT_ROWS),
      subtasks,
    }
  }

  function openStream(req, res) {
    if (clients.size >= MAX_CLIENTS) {
      throw new WorkbenchError(503, '同时打开的看板标签页太多，请关掉几个再试', { id: 'too-many-streams' })
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    })
    res.flushHeaders?.()
    clients.add(res)
    snapshot()
      .then(data => {
        writeFrame(res, { type: 'snapshot', data, seq: nextSeq(), at: new Date().toISOString() })
      })
      .catch(error => {
        writeFrame(res, {
          type: 'error',
          code: 'snapshot-failed',
          message: messageOf(error),
          seq: nextSeq(),
          at: new Date().toISOString(),
        })
      })
    const heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) return
      try {
        res.write(': ping\n\n')
      } catch {
        // The close handler removes the client.
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
    const cleanup = () => {
      clearInterval(heartbeat)
      clients.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  async function pollOnce() {
    const data = await snapshot()
    const text = JSON.stringify(data)
    if (text === lastSnapshotJson) return
    lastSnapshotJson = text
    if (clients.size > 0) broadcast({ type: 'snapshot', data })
  }

  function startPolling() {
    if (poller || clients.size === 0) return
    poller = setInterval(() => {
      if (clients.size === 0) {
        clearInterval(poller)
        poller = null
        return
      }
      pollOnce().catch(error => log(`board poll failed: ${messageOf(error)}`))
    }, POLL_MS)
    poller.unref?.()
  }

  /** Map an inbox id to the host call that answers it. */
  async function answerInbox(itemId, answer) {
    const [kind, runId, extra] = String(itemId).split(':')
    if (!kind || !runId) {
      throw new WorkbenchError(400, '这条待办缺少可执行的标识，请刷新页面后重试', { id: 'bad-inbox-id' })
    }
    if (kind === 'question') {
      if (typeof host.answer !== 'function') {
        throw new WorkbenchError(503, '当前宿主不能回答运行中的问题', { id: 'answer-unavailable' })
      }
      return host.answer({ runId, attentionId: extra || null, answer })
    }
    if (kind === 'review') {
      if (typeof host.reviewSubtask !== 'function') {
        throw new WorkbenchError(503, '当前宿主不能验收子任务', { id: 'review-unavailable' })
      }
      const verdict = /重做|reject|不通过/i.test(answer) ? 'reject' : 'accept'
      return host.reviewSubtask({ runId, subtask: extra, verdict, note: answer })
    }
    if (kind === 'blocked') {
      if (typeof host.rerunSubtask !== 'function') {
        throw new WorkbenchError(503, '当前宿主不能重跑子任务', { id: 'rerun-unavailable' })
      }
      return host.rerunSubtask({ runId, subtask: extra })
    }
    if (kind === 'resume') {
      if (typeof host.resumeRun !== 'function') {
        throw new WorkbenchError(503, '当前宿主不能继续运行', { id: 'resume-unavailable' })
      }
      return host.resumeRun({ runId })
    }
    if (typeof host.answerInbox !== 'function') {
      throw new WorkbenchError(404, '这条待办已经失效，请刷新页面', { id: 'unknown-inbox-item' })
    }
    return host.answerInbox({ id: itemId, answer })
  }

  async function handle(req, res) {
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      const pathname = parsed.pathname

      if (pathname === '/' || pathname === '/board' || pathname === '/index.html') {
        if (method !== 'GET') throw new WorkbenchError(405, '这里只接受 GET', { id: 'method-not-allowed' })
        authorize(req, { allowQuery: true })
        sendText(res, 200, page, 'text/html; charset=utf-8', {
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        return
      }

      authorize(req)
      const parts = pathname.split('/').filter(Boolean)
      if (parts[0] !== 'api' || parts[1] !== 'board') {
        throw new WorkbenchError(404, `没有这个地址：${method} ${pathname}`, { id: 'not-found', hint: ROUTE_HINT })
      }
      const leaf = parts[2] ?? ''

      if (leaf === 'health' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, '这里只接受 GET', { id: 'method-not-allowed' })
        send(res, 200, {
          ok: true,
          data: {
            service: 'dsh-superagent-board',
            version,
            pid: process.pid,
            startedAt,
            capabilities: capabilities(),
          },
        })
        return
      }

      if (leaf === 'state' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, '这里只接受 GET', { id: 'method-not-allowed' })
        send(res, 200, { ok: true, data: await snapshot() })
        return
      }

      if (leaf === 'events' && parts.length === 3) {
        if (method !== 'GET') throw new WorkbenchError(405, '这里只接受 GET', { id: 'method-not-allowed' })
        openStream(req, res)
        startPolling()
        return
      }

      if (leaf === 'inbox' && parts.length === 5 && parts[4] === 'answer') {
        if (method !== 'POST') throw new WorkbenchError(405, '这里只接受 POST', { id: 'method-not-allowed' })
        const itemId = decodeURIComponent(parts[3])
        const body = await readJson(req)
        const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
        if (!answer) throw new WorkbenchError(400, '请先填写或选择一个答案', { id: 'missing-answer' })
        const result = await answerInbox(itemId, answer)
        lastSnapshotJson = ''
        await pollOnce().catch(() => {})
        send(res, 200, {
          ok: true,
          data: {
            itemId,
            answer,
            runId: result?.id ?? result?.runId ?? null,
            status: result?.status ?? null,
            resumed: result?.resumed === true,
            message: result?.message ?? '已记录你的回答，运行会从这里继续。',
          },
        })
        return
      }

      if (leaf === 'templates' && parts.length === 5 && parts[4] === 'start') {
        if (method !== 'POST') throw new WorkbenchError(405, '这里只接受 POST', { id: 'method-not-allowed' })
        if (typeof host.startTemplate !== 'function') {
          throw new WorkbenchError(503, '当前宿主不能发起运行', { id: 'start-unavailable' })
        }
        const templateId = decodeURIComponent(parts[3])
        const body = await readJson(req)
        const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values)
          ? body.values
          : {}
        const run = await host.startTemplate({ templateId, values })
        lastSnapshotJson = ''
        await pollOnce().catch(() => {})
        send(res, 200, { ok: true, data: { runId: run?.id ?? null, status: run?.status ?? null } })
        return
      }

      if (leaf === 'runs' && parts.length >= 4) {
        const runId = decodeURIComponent(parts[3])
        if (parts.length === 4) {
          if (method !== 'GET') throw new WorkbenchError(405, '这里只接受 GET', { id: 'method-not-allowed' })
          send(res, 200, { ok: true, data: await runDetail(runId) })
          return
        }
        if (parts[4] === 'resume' && parts.length === 5) {
          if (method !== 'POST') throw new WorkbenchError(405, '这里只接受 POST', { id: 'method-not-allowed' })
          if (typeof host.resumeRun !== 'function') {
            throw new WorkbenchError(503, '当前宿主不能继续运行', { id: 'resume-unavailable' })
          }
          const run = await host.resumeRun({ runId })
          lastSnapshotJson = ''
          await pollOnce().catch(() => {})
          send(res, 200, { ok: true, data: { runId: run?.id ?? runId, status: run?.status ?? null } })
          return
        }
        if (parts[4] === 'subtasks' && parts.length >= 7) {
          const subtask = decodeURIComponent(parts[5])
          const action = parts[6]
          if (method !== 'POST') throw new WorkbenchError(405, '这里只接受 POST', { id: 'method-not-allowed' })
          if (action === 'cancel') {
            if (typeof host.cancelSubtask !== 'function') {
              throw new WorkbenchError(503, '当前宿主不能取消子任务', { id: 'cancel-unavailable' })
            }
            const run = await host.cancelSubtask({ runId, subtask })
            lastSnapshotJson = ''
            await pollOnce().catch(() => {})
            send(res, 200, { ok: true, data: { runId, subtask, status: 'cancelled', runStatus: run?.status ?? null } })
            return
          }
          if (action === 'rerun') {
            if (typeof host.rerunSubtask !== 'function') {
              throw new WorkbenchError(503, '当前宿主不能重跑子任务', { id: 'rerun-unavailable' })
            }
            const run = await host.rerunSubtask({ runId, subtask })
            lastSnapshotJson = ''
            await pollOnce().catch(() => {})
            send(res, 200, { ok: true, data: { runId, subtask, status: run?.status ?? 'queued' } })
            return
          }
        }
      }

      throw new WorkbenchError(404, `没有这个地址：${method} ${pathname}`, { id: 'not-found', hint: ROUTE_HINT })
    } catch (error) {
      if (statusFor(error) >= 500) log(`board request failed: ${messageOf(error)}`)
      send(res, statusFor(error), errorPayload(error))
    }
  }

  async function writeDiscovery() {
    const caps = capabilities()
    const doc = {
      service: 'dsh-superagent-board',
      version,
      url: url(),
      token,
      pid: process.pid,
      instanceId,
      startedAt,
      mode: caps.start ? 'ready' : 'observe-only',
    }
    const tmp = `${discoveryPath}.${process.pid}.${instanceId}.tmp`
    const handle = await fsp.open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await fsp.rename(tmp, discoveryPath)
    try {
      await fsp.chmod(discoveryPath, 0o600)
    } catch {
      // Windows ignores most mode bits; the file's ACL still applies.
    }
  }

  async function removeDiscovery() {
    try {
      const current = JSON.parse(await fsp.readFile(discoveryPath, 'utf8'))
      if (current?.instanceId !== instanceId) return
      await fsp.unlink(discoveryPath)
    } catch {
      // Already gone, or replaced by another instance.
    }
    await fsp.unlink(`${discoveryPath}.${process.pid}.${instanceId}.tmp`).catch(() => {})
  }

  async function closeServer() {
    if (!server) return
    const instance = server
    server = null
    boundPort = null
    await new Promise(resolve => {
      instance.close(() => resolve())
      instance.closeAllConnections?.()
    })
  }

  return {
    discoveryPath,
    get token() {
      return token
    },
    get port() {
      return boundPort
    },
    get url() {
      return boundPort ? url() : null
    },

    /** Bind loopback, load the page, and publish the discovery file. */
    async start() {
      if (server) return { port: boundPort, url: url() }
      if (starting) return starting
      if (stopRequested) throw new Error('看板已经停止，需要重新创建一个实例')
      const run = (async () => {
        page = await fsp.readFile(new URL('../public/board.html', import.meta.url), 'utf8')
        const instance = createServer((req, res) => {
          handle(req, res).catch(error => {
            log(`board handler crashed: ${messageOf(error)}`)
            send(res, 500, errorPayload(error))
          })
        })
        instance.requestTimeout = REQUEST_TIMEOUT_MS
        instance.headersTimeout = 10_000
        instance.keepAliveTimeout = 5_000
        instance.maxConnections = 64
        await new Promise((resolve, reject) => {
          instance.once('error', reject)
          instance.listen(port, '127.0.0.1', () => {
            instance.off('error', reject)
            resolve()
          })
        })
        const address = instance.address()
        if (!address || typeof address === 'string') throw new Error('看板监听没有拿到 TCP 地址')
        boundPort = address.port
        server = instance
        await writeDiscovery()
        return { port: boundPort, url: url() }
      })()
      starting = run
      try {
        return await run
      } finally {
        starting = null
      }
    },

    /** Close the socket, stop polling, and remove the discovery file. */
    async stop() {
      if (closing) return closing
      stopRequested = true
      closing = (async () => {
        if (poller) {
          clearInterval(poller)
          poller = null
        }
        for (const res of clients) {
          try {
            writeFrame(res, { type: 'closed', seq: nextSeq(), at: new Date().toISOString() })
            res.end()
          } catch {
            // The socket is already gone.
          }
        }
        clients.clear()
        await closeServer()
        await removeDiscovery()
      })()
      try {
        await closing
      } finally {
        closing = null
      }
    },
  }
}
