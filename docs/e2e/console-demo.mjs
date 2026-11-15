#!/usr/bin/env node
/**
 * Preview harness for `public/console.html` — not part of the plugin.
 *
 * It starts the real console server against the real orchestrator and store,
 * and stands in for `sessionController` with a small scripted host so the page
 * can be reviewed and screenshotted without a DSH host running. Every run,
 * subtask, cost, report, and attention item below is produced by
 * `lib/orchestrator.js` and read back through `lib/store.js`; only the Host
 * Session stream is scripted. Do not read this as evidence that a real session
 * works — that path is covered by `test/console.test.mjs`.
 */
import os from 'node:os'
import path from 'node:path'

import { createConsole } from '../../lib/console.js'
import { computeCost, formatMoney } from '../../lib/cost.js'
import { createOrchestrator } from '../../lib/orchestrator.js'
import { createStore } from '../../lib/store.js'

const CONFIG = {
  maxSubtasks: 6,
  maxParallel: 3,
  maxActiveRuns: 2,
  attempts: 2,
  deadlineMinutes: 60,
  resultCapBytes: 32 * 1024,
  maxModelCallsPerRun: 0,
  maxTokensPerRun: 0,
}

const PRICING = {
  'deepseek/deepseek-chat': { input: 0.27, output: 1.1, currency: 'USD' },
}

const SESSION_ID = 'demo-session'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function completed(text) {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

const REPORTS = {
  audit: [
    '## 这周的运行情况',
    '',
    '- 共 7 个 run：5 个完成，1 个部分完成，1 个中断。',
    '- 平均耗时 6 分 12 秒，最慢的那个卡在聚合阶段。',
    '- 失败集中在 npm 安装超时，重试后都成功了。',
    '',
    '## 风险点',
    '',
    '1. 有两个 run 没有记录 usage，成本只能按调用次数估算。',
    '2. 聚合阶段没有超时上限，长报告会拖住整个 run。',
    '3. 沙箱清理依赖进程退出，崩溃重启后会留下目录。',
  ].join('\n'),
  publish: [
    '## 0.13.0 发布检查',
    '',
    '- changelog 已补齐 `console` 一段。',
    '- `files` 已包含 `lib/console.js` 与 `public/console.html`。',
    '- 打包检查通过，没有第三方依赖。',
    '',
    '发布前还差一步：需要确认发到哪个 registry。',
  ].join('\n'),
}

function planFor(goal) {
  if (goal.includes('npm')) {
    return [
      { title: '核对 changelog 与版本号', prompt: 'read the changelog and package.json' },
      { title: '检查 files 与依赖', prompt: 'verify the packed file list' },
      { title: '确认 registry 并发布', prompt: 'publish the package' },
    ]
  }
  return [
    { title: '盘点 run 状态与成本', prompt: 'list the runs of this week' },
    { title: '定位失败与重试', prompt: 'find the failed attempts' },
    { title: '整理风险清单', prompt: 'summarise the risks' },
  ]
}

function runView(run, { detail = false } = {}) {
  const usage = run.usage && typeof run.usage === 'object' ? run.usage : null
  const cost = usage ? computeCost(usage, PRICING) : null
  const report = typeof run.report === 'string' ? run.report : null
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    createdAt: run.createdAt ?? null,
    finishedAt: run.finishedAt ?? null,
    parentSessionId: run.parentSessionId ?? null,
    cost: cost
      ? {
        totalMicros: cost.totalMicros,
        currency: cost.currency,
        text: formatMoney(cost),
        complete: cost.complete === true,
        unpriced: cost.unpriced,
      }
      : null,
    usage: usage
      ? {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        totalTokens: usage.totalTokens ?? null,
        modelCalls: usage.modelCalls ?? null,
      }
      : null,
    subtasks: (run.subtasks ?? []).map(subtask => ({
      index: subtask.index ?? null,
      title: subtask.title ?? null,
      status: subtask.status ?? null,
      childId: subtask.childId ?? null,
    })),
    attention: (run.attention?.items ?? [])
      .filter(item => item && !item.answer)
      .map(item => ({
        id: item.id,
        source: item.source ?? null,
        question: item.question,
        options: Array.isArray(item.options) ? item.options : [],
        reason: item.reason ?? null,
        askedAt: run.attention?.at ?? null,
      })),
    report: report ? report.slice(0, detail ? 40_000 : 4_000) : null,
    reportTruncated: Boolean(report && report.length > (detail ? 40_000 : 4_000)),
  }
}

const stateRoot = process.env.CONSOLE_STATE
  ? path.resolve(process.env.CONSOLE_STATE)
  : path.join(os.tmpdir(), `superagent-console-demo-${process.pid}`)
const store = createStore(stateRoot)
await store.init()

let childSeq = 0
// The orchestrator's spawn spec carries a prompt, not the parent goal, so the
// demo keeps the goal it is seeding around for label/report selection.
let activeGoal = ''
const spawnChild = async spec => {
  childSeq += 1
  const childId = `demo-child-${childSeq}`
  const goal = activeGoal
  let text
  if (spec.label === 'superagent-plan') {
    text = JSON.stringify({ subtasks: planFor(goal) })
  } else if (spec.label === 'superagent-3' && goal.includes('npm')) {
    text = 'registry 在本地和 npmjs 之间没有定论。\n\n'
      + '```attention\n{"question":"0.13.0 发到哪个 registry？","options":["npmjs","私有镜像"],"reason":"两种配置都出现在仓库里"}\n```'
  } else if (spec.label.includes('aggregate')) {
    text = goal.includes('npm') ? REPORTS.publish : REPORTS.audit
  } else {
    text = `已完成：${spec.label}。`
  }
  await sleep(120)
  return { childId, result: Promise.resolve(completed(text)), dispose: async () => {} }
}

const orchestrator = createOrchestrator({
  store,
  config: CONFIG,
  spawnChild,
  readUsage: async () => ({
    inputTokens: 18_240,
    outputTokens: 2_180,
    totalTokens: 20_420,
    modelCalls: 3,
    models: {
      'deepseek/deepseek-chat': { inputTokens: 18_240, outputTokens: 2_180, calls: 3 },
    },
  }),
  log: () => {},
})

console.error('[demo] seeding runs…')
activeGoal = '盘点这周 superagent 的运行情况，整理风险点'
const auditRun = await orchestrator.start({
  goal: activeGoal,
  parentSessionId: SESSION_ID,
  parent: { id: SESSION_ID },
})
await orchestrator.status(auditRun.id, 30)
activeGoal = '发布 superagent 0.13.0 到 npm，先检查 changelog'
const publishRun = await orchestrator.start({
  goal: activeGoal,
  parentSessionId: SESSION_ID,
  parent: { id: SESSION_ID },
})
await orchestrator.status(publishRun.id, 30)

// A scripted Host Session journal so the page has a history to replay.
const records = []
const record = event => {
  records.push({ type: 'event', event: { seq: records.length + 1, time: Date.now(), ...event } })
}
record({
  type: 'user/message',
  data: { content: [{ type: 'text', text: '早上好，帮我看看这周 superagent 的运行情况。' }], source: { kind: 'user' } },
})
record({ type: 'turn/start', data: {} })
record({
  type: 'assistant/message',
  data: {
    message: {
      content: [
        { type: 'text', text: '我先拉一遍 run 列表和成本，再把失败重试单独看一眼。' },
        { type: 'tool-call', id: 'call-1', name: 'superagent_list', arguments: { limit: 20 } },
      ],
    },
  },
})
record({ type: 'turn/end', data: {} })
record({
  type: 'user/message',
  data: { content: [{ type: 'text', text: '顺便把 npm 发布那条也推进一下，但要先停下来让我确认。' }], source: { kind: 'user' } },
})
record({ type: 'turn/start', data: {} })
record({
  type: 'assistant/message',
  data: {
    message: {
      content: [{
        type: 'text',
        text: '两个 run 都起来了。右侧能看到子任务进度和成本；发布那条卡在一个待确认的问题上，直接在卡片里选就行。',
      }],
    },
  },
})
record({ type: 'turn/end', data: {} })

let listener = null
let closed = false
const emit = frame => {
  if (!closed && listener) listener(frame)
}

const host = {
  capabilities: () => ({ chat: true, reason: null }),
  createSession: async () => ({ sessionId: SESSION_ID }),
  listRuns: async sessionId => {
    const runs = await store.list()
    return runs.filter(run => run.parentSessionId === sessionId).slice(0, 20).map(run => runView(run))
  },
  readRun: async (sessionId, runId) => {
    const run = await store.read(runId)
    if (!run || run.parentSessionId !== sessionId) return null
    return runView(run, { detail: true })
  },
  async answer({ sessionId, runId, attentionId, answer }) {
    const result = await orchestrator.answer(runId, attentionId, answer, { id: sessionId }, 'Asia/Shanghai')
    return {
      runId: result?.run?.id ?? runId,
      attentionId: result?.attentionId ?? attentionId,
      status: result?.run?.status ?? null,
      resumed: result?.resumed === true,
      effect: result?.effect?.detail ?? null,
    }
  },
  subscribe(sessionId, next) {
    listener = next
    emit({ type: 'stream.snapshot', header: { id: sessionId }, cursor: records.length, records })
    return () => {
      listener = null
    }
  },
}

const panel = createConsole({
  port: Number(process.env.CONSOLE_PORT ?? 0),
  stateRoot: store.root,
  host,
  version: 'demo',
  log: message => console.error(`[console] ${message}`),
})

const { url } = await panel.start()
console.log(`demo console ${url}`)
console.log(`open         ${url}/?token=${panel.token}`)
console.log(`discovery    ${panel.discoveryPath}`)
console.log('press Ctrl-C to stop')

let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  closed = true
  await panel.stop()
  await store.dispose?.()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
