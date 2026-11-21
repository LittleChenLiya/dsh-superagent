/**
 * Reproducible acceptance run for the total design.
 *
 * Everything here is synthetic:
 * - the classifier and executor are explicit local fixtures, not a model;
 * - GitHub/Feishu requests are signed with local test secrets and sent to a
 *   real loopback HTTP server, but no live GitHub or Feishu tenant is called;
 * - state and reports stay under `total-design/acceptance`, never the repo or
 *   the user's profile.
 *
 * Run: node scripts/demo-acceptance.mjs
 * Optional: DSH_ACCEPTANCE_DIR=<dir> overrides the output directory.
 */

import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRouter } from '../lib/router.js'
import { createSourceIngress } from '../lib/sources/ingress.js'
import { createSourceStore, requestIdFor } from '../lib/sources/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = process.env.DSH_ACCEPTANCE_DIR ?? path.resolve(ROOT, '..', 'acceptance')
const SCRATCH = path.join(OUT, 'scratch')
const NOW = () => Date.now()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const projects = [
  { name: '发布', cwd: 'workspace/release-a' },
  { name: '发布备份', cwd: 'workspace/release-b' },
]
const tasks = [
  {
    id: 'goal-a', project: 'workspace/release-a', title: '发布说明', status: 'running', routed: true,
    phases: [
      { id: 'p1', title: '兼容性核查', status: 'running' },
      { id: 'p2', title: '发布说明复核', status: 'pending' },
    ],
  },
  { id: 'goal-b', project: 'workspace/release-b', title: '发布说明', status: 'running', routed: true },
  {
    id: 'goal-done', project: 'workspace/release-a', title: '旧版整理', status: 'completed', routed: true,
    finishedAt: '2026-11-21T03:30:00.000Z',
  },
]

const checks = []
function check(name, fn) {
  return Promise.resolve().then(fn).then(detail => {
    checks.push({ name, passed: true, detail: detail ?? null })
    return true
  }, error => {
    checks.push({ name, passed: false, detail: error?.message ?? String(error) })
    return false
  })
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

async function fresh(label) {
  const dir = path.join(SCRATCH, label)
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

async function drain(router, timeoutMs = 5000) {
  const deadline = NOW() + timeoutMs
  for (;;) {
    const snapshot = await router.snapshot()
    if (snapshot.pending === 0) return snapshot
    if (NOW() > deadline) throw new Error('router queue did not drain')
    await sleep(10)
  }
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = NOW() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (NOW() > deadline) throw new Error('timed out')
    await sleep(10)
  }
}

function fixtureRouter({ root, taskRows = tasks, classifyCalls = { value: 0 }, execute }) {
  const router = createRouter({
    root,
    log: message => console.error(`[acceptance] ${message}`),
    catalog: async () => ({ projects, tasks: taskRows }),
    classify: async () => {
      classifyCalls.value += 1
      return { action: 'reply', text: '模拟模型：收到。' }
    },
    execute: execute ?? (async decision => {
      if (decision.action === 'task') return { text: '已接下这项任务。', taskId: 'goal-a', receipt: 'registered' }
      return { text: '已写入执行记录。', taskId: decision.target, receipt: 'delivered' }
    }),
  })
  router.start()
  return router
}

const githubConfig = { github: { enabled: true, instanceId: 'gh-acceptance', secret: 'acceptance-github-secret' } }
const feishuConfig = {
  feishu: {
    enabled: true, instanceId: 'fs-acceptance',
    encryptKey: 'acceptance-feishu-key', verificationToken: 'acceptance-token',
  },
}

function issuePayload({ repoId = 101, number = 7, title = '补充兼容性段落', body = '旧版本仍需说明。' } = {}) {
  return {
    action: 'opened',
    repository: { id: repoId, full_name: repoId === 101 ? 'acme/widget' : 'acme/other' },
    issue: { number, title, body, pull_request: false },
    sender: { login: 'fixture' },
  }
}

function githubHeaders(deliveryId, body) {
  return {
    'content-type': 'application/json',
    'x-github-event': 'issues',
    'x-github-delivery': deliveryId,
    'x-hub-signature-256': `sha256=${createHmac('sha256', 'acceptance-github-secret').update(body).digest('hex')}`,
  }
}

function feishuPayload({ tenant = 'tenant-a', messageId = 'om_1', eventId = 'evt-1', text = '补一句兼容性' } = {}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId, event_type: 'im.message.receive_v1', tenant_key: tenant,
      token: 'acceptance-token',
    },
    event: {
      sender: { sender_id: { open_id: 'ou_fixture' } },
      message: {
        message_id: messageId, chat_id: 'oc_fixture', message_type: 'text',
        create_time: String(NOW()), content: JSON.stringify({ text }),
      },
    },
  }
}

function encryptFeishu(payload) {
  const key = createHash('sha256').update('acceptance-feishu-key').digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return JSON.stringify({ encrypt: Buffer.concat([iv, body]).toString('base64') })
}

function feishuHeaders(body) {
  const timestamp = Math.floor(NOW() / 1000)
  const nonce = 'acceptance-nonce'
  return {
    'content-type': 'application/json',
    'x-lark-request-timestamp': String(timestamp),
    'x-lark-request-nonce': nonce,
    'x-lark-signature': createHash('sha256')
      .update(`${timestamp}${nonce}acceptance-feishu-key${body}`).digest('hex'),
  }
}

async function serve(ingress) {
  const server = http.createServer((req, res) => {
    ingress.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function run() {
  await fsp.rm(SCRATCH, { recursive: true, force: true })
  await fsp.mkdir(SCRATCH, { recursive: true })
  const startedAt = new Date().toISOString()

  // ---------------------------------------------------------------- work graph
  const graphRoot = await fresh('work-graph')
  const classifyCalls = { value: 0 }
  let router = fixtureRouter({ root: graphRoot, classifyCalls })
  try {
    await router.submit({ id: 'acc-alias-a', project: 'workspace/release-a', text: '把发布说明叫做发版' })
    await router.submit({ id: 'acc-alias-b', project: 'workspace/release-b', text: '把发布说明叫做发版' })
    await router.submit({ id: 'acc-decision-a', project: 'workspace/release-a', text: '记下发版的兼容性策略：先查旧版' })
    await router.submit({ id: 'acc-phase', project: 'workspace/release-a', text: '/决定 发版 | 兼容性核查 策略 | 旧版优先 | 7天' })
    let snapshot = await drain(router)
    await router.submit({ id: 'acc-read-a', project: 'workspace/release-a', text: '/方案 发版' })
    snapshot = await drain(router)
    await check('当前方案是跨工作区隔离的，且读取不调用分类器', async () => {
      assert(/先查旧版/.test(snapshot.messages.at(-1).text), 'release-a 没有读到自己的方案')
      assert(snapshot.metrics.classifyCalls === 0, '确定性读取调用了分类器')
      assert(classifyCalls.value === 0, '分类器被调用')
      const factsA = await router.taskFacts(tasks[0])
      const factsB = await router.taskFacts(tasks[1])
      assert(factsA.length === 2, `工作区 A 应有 2 条决定，实际 ${factsA.length}`)
      assert(factsB.length === 0, '工作区 B 混入了 A 的决定')
      return '工作区 A 读到「先查旧版」；工作区 B 无决定'
    })

    await router.stop()
    router = fixtureRouter({ root: graphRoot, classifyCalls })
    await router.submit({ id: 'acc-read-restart', project: 'workspace/release-a', text: '/方案 发版' })
    snapshot = await drain(router)
    await check('重启后当前方案仍然可读', () => {
      assert(/先查旧版/.test(snapshot.messages.at(-1).text), '重启后丢失了方案')
      assert(snapshot.metrics.classifyCalls === 0, '重启后的读取进行了分类')
      return '重启后的确定性读取仍命中同一事实'
    })

    const p1 = await router.taskFacts(tasks[0], 'p1')
    const p2 = await router.taskFacts(tasks[0], 'p2')
    await check('阶段内的决定不会泄漏到其他阶段', () => {
      assert(p1.length === 2, `p1 应有任务级与阶段级两条决定，实际 ${p1.length}`)
      assert(p2.length === 1 && p2[0].phaseId === null, 'p2 收到了只属于 p1 的决定')
      return 'p1 收到任务级+阶段级；p2 只收到任务级'
    })

    await router.submit({ id: 'acc-revoke', project: 'workspace/release-a', text: '/撤销决定 发版 | 兼容性核查 策略' })
    await drain(router)
    await check('撤回会移除阶段决定', async () => {
      const after = await router.taskFacts(tasks[0], 'p1')
      assert(after.length === 1 && after[0].phaseId === null, '阶段决定在撤回后仍然存在')
      return '撤回后 p1 只剩任务级决定'
    })

    const receipt = await waitFor(async () => (await router.snapshot()).messages
      .find(message => message.id.startsWith('result-goal-done-')))
    await check('完成回执是稳定且可识别的「已验收」', () => {
      assert(receipt.receipt === 'accepted', `回执状态为 ${receipt.receipt}`)
      return '终态回执 receipt=accepted'
    })
    await router.submit({ id: 'acc-evidence', project: 'workspace/release-a', text: '/证据 旧版整理' })
    snapshot = await drain(router)
    await check('运行结果作为证据可被确定性查询', () => {
      assert(/交付结论/.test(snapshot.messages.at(-1).text), '证据查询没有返回终态证据')
      const evidence = snapshot.facts.filter(fact => fact.kind === 'evidence')
      assert(evidence.length >= 1 && evidence[0].origin === 'run', '证据缺少运行来源')
      assert(snapshot.metrics.classifyCalls === 0, '证据查询进行了分类')
      return `${evidence.length} 条运行证据，origin=run`
    })

    // Legacy migration in a separate state root.
    const legacyRoot = await fresh('legacy')
    const legacyAt = NOW() - 60_000
    await fsp.writeFile(path.join(legacyRoot, 'router.json'), JSON.stringify({
      revision: 1, messages: [], commands: [], memory: [], outcomes: {},
      facts: [{
        id: 'legacy-1', project: 'workspace/release-a', taskId: 'goal-a', kind: 'decision', key: '兼容性',
        subject: '兼容性', value: '旧状态里的方案', confirmedAt: legacyAt, source: 'user-message',
      }],
    }))
    const legacyRouter = fixtureRouter({ root: legacyRoot, classifyCalls })
    await check('旧状态可直接加载并完成幂等迁移', async () => {
      const loaded = await legacyRouter.snapshot()
      assert(loaded.facts[0].value === '旧状态里的方案', '旧事实没有加载')
      assert(loaded.facts[0].origin === 'user' && loaded.facts[0].validFrom === legacyAt, '旧事实未迁移')
      await legacyRouter.submit({ id: 'acc-legacy-write', project: 'workspace/release-a', text: '/决定 发布说明 | 兼容性 | 新方案' })
      await drain(legacyRouter)
      const file = JSON.parse(await fsp.readFile(path.join(legacyRoot, 'router.json'), 'utf8'))
      assert(file.version === 2 && file.facts.every(fact => fact.origin), '迁移结果没有持久化')
      return '旧文件加载成功，写入时持久化 version=2'
    })
    await legacyRouter.stop()
  } finally {
    await router.stop()
  }

  // ------------------------------------------------------------------- sources
  const sourceRoot = await fresh('sources')
  const sourceStore = createSourceStore({ root: sourceRoot })
  const sourceRouter = fixtureRouter({ root: await fresh('sources-router'), classifyCalls: { value: 0 } })
  const ingress = createSourceIngress({
    store: sourceStore, router: sourceRouter, config: { ...githubConfig, ...feishuConfig },
    catalog: async () => ({ projects, tasks }),
  })
  const server = await serve(ingress)
  try {
    await ingress.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace/release-a',
      taskId: 'goal-a', phaseId: 'p1' })
    await ingress.bind({ source: 'feishu', objectId: 'feishu:tenant-a:message:om_1', project: 'workspace/release-a',
      taskId: 'goal-a', phaseId: 'p1' })

    const beforeMessages = (await sourceRouter.snapshot()).messages.length
    const githubBody = JSON.stringify(issuePayload())
    const githubResponse = await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('acc-delivery-1', githubBody), body: githubBody,
    })
    await ingress.flush()
    await drain(sourceRouter)
    await check('签名的 GitHub 事件只在绑定阶段更新，不进入对话', async () => {
      assert(githubResponse.status === 202, `HTTP ${githubResponse.status}`)
      const snapshot = await sourceRouter.snapshot()
      assert(snapshot.messages.length === beforeMessages, '来源事件写入了对话')
      assert(snapshot.metrics.sourceEvents === 1, '来源事件没有进入任务图')
      assert(snapshot.metrics.classifyCalls === 0, '来源事件调用了分类器')
      const recorded = snapshot.facts.find(fact => fact.kind === 'source')
      assert(recorded?.phaseId === 'p1', '来源事实丢失了绑定阶段')
      const context = await sourceRouter.taskContext(tasks[0])
      assert(context.sources.length === 1, '任务卡没有来源记录')
      return 'HTTP 202；对话不变；source 事实 1 条且归属 p1；classifyCalls=0'
    })

    const replay = await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('acc-delivery-1', githubBody), body: githubBody,
    })
    await ingress.flush()
    await check('同一投递 ID 重投不会重复派工', async () => {
      assert((await replay.json()).duplicate === true, '重投未被识别为重复')
      const snapshot = await sourceRouter.snapshot()
      assert(snapshot.metrics.sourceEvents === 1, '重投让来源事件数量增加')
      return '重投返回 duplicate=true；sourceEvents 仍为 1'
    })

    const unboundBody = JSON.stringify(issuePayload({ number: 8 }))
    await fetch(`${server.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('acc-delivery-8', unboundBody), body: unboundBody,
    })
    await ingress.flush()
    await check('未绑定对象只登记、不派工', async () => {
      const snapshot = await ingress.snapshot()
      assert(snapshot.counts.unbound >= 1, '未绑定事件没有登记为 unbound')
      const routerSnapshot = await sourceRouter.snapshot()
      assert(routerSnapshot.metrics.sourceEvents === 1, '未绑定事件进入了执行线')
      return 'unbound=1；未进入执行线'
    })

    const challengeBody = JSON.stringify({ type: 'url_verification', challenge: 'acc-challenge', token: 'acceptance-token' })
    const challenge = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(challengeBody), body: challengeBody,
    })
    const encrypted = encryptFeishu(feishuPayload())
    const event = await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(encrypted), body: encrypted,
    })
    await ingress.flush()
    await drain(sourceRouter)
    await check('飞书签名、握手与加密事件走真实入站路径', async () => {
      assert(challenge.status === 200, `握手 HTTP ${challenge.status}`)
      assert((await challenge.json()).challenge === 'acc-challenge', '握手 challenge 不匹配')
      assert(event.status === 200, `加密事件 HTTP ${event.status}`)
      const snapshot = await sourceRouter.snapshot()
      assert(snapshot.metrics.sourceEvents === 2, '飞书事件没有进入任务图')
      const context = await sourceRouter.taskContext(tasks[0])
      assert(context.sources.some(item => item.value.includes('补一句兼容性')), '飞书正文没有落到任务卡')
      return '握手 200；AES 解密后 sourceEvents=2'
    })

    const otherTenant = encryptFeishu(feishuPayload({ tenant: 'tenant-b', eventId: 'evt-b', text: '未绑定租户' }))
    await fetch(`${server.url}/hooks/feishu`, {
      method: 'POST', headers: feishuHeaders(otherTenant), body: otherTenant,
    })
    await ingress.flush()
    await check('跨租户同名消息不会命中他人绑定', async () => {
      const snapshot = await ingress.snapshot()
      assert(snapshot.counts.unbound >= 2, '跨租户事件没有保持未绑定')
      return 'tenant-b 保持 unbound'
    })
  } finally {
    await server.close()
    await sourceRouter.stop()
  }

  // ---------------------------------------------------------- crash/recovery
  const recoveryRoot = await fresh('recovery')
  const recoveryStore = createSourceStore({ root: recoveryRoot })
  let failOnce = true
  const submitted = []
  const stubRouter = {
    async submit(input) {
      submitted.push(input)
      return { accepted: true, id: input.id }
    },
  }
  const flaky = createSourceIngress({
    store: recoveryStore, router: stubRouter, config: githubConfig,
    catalog: async () => ({ projects, tasks }),
    faults: { afterRegister: () => { if (failOnce) { failOnce = false; throw new Error('injected crash') } } },
  })
  const recoveryServer = await serve(flaky)
  try {
    await flaky.bind({ source: 'github', objectId: 'github:101:issue:7', project: 'workspace/release-a', taskId: 'goal-a' })
    const body = JSON.stringify(issuePayload())
    const response = await fetch(`${recoveryServer.url}/hooks/github`, {
      method: 'POST', headers: githubHeaders('acc-crash-1', body), body,
    })
    await check('登记后崩溃不会丢事件，恢复时复用同一请求 ID', async () => {
      assert(response.status === 500, `注入崩溃后返回 HTTP ${response.status}`)
      assert(submitted.length === 0, '崩溃前已经派工')
      const restarted = createSourceIngress({
        store: recoveryStore, router: stubRouter, config: githubConfig,
        catalog: async () => ({ projects, tasks }),
      })
      const recovered = await restarted.recover()
      assert(recovered.length === 1 && recovered[0].status === 'dispatched', '恢复扫描没有派工')
      assert(submitted.length === 1, '恢复后派工次数不为 1')
      assert(submitted[0].id === requestIdFor('github:gh-acceptance:acc-crash-1'), '恢复没有复用稳定请求 ID')
      return 'HTTP 500 保留登记；恢复后 1 次派工，ID 稳定'
    })
  } finally {
    await recoveryServer.close()
  }

  // ------------------------------------------------------------------ attention
  const attentionRoot = await fresh('attention')
  const attentionRouter = fixtureRouter({ root: attentionRoot, classifyCalls: { value: 0 } })
  try {
    await attentionRouter.submit({ id: 'acc-attn-clarify', text: '/方案 发布说明' })
    await attentionRouter.submit({ id: 'acc-attn-alias', project: 'workspace/release-a', text: '把发布说明叫做发版' })
    await attentionRouter.submit({ id: 'acc-attn-followup', project: 'workspace/release-a', target: 'goal-a',
      intent: 'followup', text: '放在开头' })
    const snapshot = await drain(attentionRouter)
    await check('回执区分需用户动作、已登记与已送达', () => {
      const replies = snapshot.messages.filter(message => message.receipt)
      const states = new Set(replies.map(message => message.receipt))
      assert(states.has('action-required'), '缺少需用户动作的回执')
      assert(states.has('registered'), '缺少已登记的回执')
      assert(states.has('delivered'), '缺少已送达的回执')
      assert(snapshot.metrics.classifyCalls === 0, '这些路径调用了分类器')
      return `回执状态：${[...states].join(', ')}；classifyCalls=0`
    })
  } finally {
    await attentionRouter.stop()
  }

  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const base = execFileSync('git', ['rev-parse', '45f6923'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const report = {
    generatedAt: new Date().toISOString(),
    startedAt,
    branch,
    baseCommit: base,
    headCommit: head,
    model: 'simulated deterministic classify/execute fixtures; no external model calls',
    liveConnections: {
      github: 'not connected — local HMAC fixtures only; no real tenant credentials',
      feishu: 'not connected — local signature/AES fixtures only; no real app credentials',
    },
    passed: checks.filter(item => item.passed).length,
    failed: checks.filter(item => !item.passed).length,
    checks,
  }
  await fsp.writeFile(path.join(OUT, 'acceptance-report.json'), JSON.stringify(report, null, 2))
  const markdown = [
    '# 超级智能体总设计 · 验收记录', '',
    `- 分支：\`${branch}\``, `- 基准提交：\`${base}\``, `- 当前提交：\`${head}\``,
    `- 生成时间：${report.generatedAt}`, `- 模型：${report.model}`, '',
    '> GitHub / 飞书为本地签名夹具，**未连接真实账号**。见文末。', '',
    '> 真实 DSH 宿主演示（隔离 profile、模拟模型）另见 `host-demo-report.md`。', '',
    '## 结果', '', `${report.passed} 通过 / ${report.failed} 失败`, '',
    '| 检查 | 结果 | 证据 |', '| --- | --- | --- |',
    ...checks.map(item => `| ${item.name} | ${item.passed ? '通过' : '失败'} | ${String(item.detail ?? '').replace(/\|/gu, '\\|')} |`),
    '',
  ].join('\n')
  await fsp.writeFile(path.join(OUT, 'acceptance-report.md'), markdown)
  console.log(markdown)
  if (report.failed) process.exitCode = 1
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
