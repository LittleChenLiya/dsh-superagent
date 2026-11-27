import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(packageRoot, 'lib', 'client.js')
const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))

/**
 * Materialize lib/client.js the way the host does: provide a module loader on
 * `window`, import the file, and hand its factory a minimal `require`.
 * @returns {Promise<object>} the module exports the host would see.
 */
async function materialize(overrides = null, hooks = {}) {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load: descriptor => {
        captured = descriptor
      },
    },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    cloneElement: (node, props) => ({ ...node, props: { ...node.props, ...props } }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: value => ({ current: value }),
    ...hooks,
  }
  // The host hands plugin clients its own component library (route A). The
  // stub keeps the module resolvable without a browser; it deliberately ships
  // no icons so the entry glyph falls back to the inline mark.
  const primitives = {
    Button: props => ({ type: 'button', props, children: [] }),
    FishLogo: props => ({ type: 'svg', props, children: [] }),
    ...overrides,
  }
  await import(`${pathToFileURL(clientPath).href}?t=${Date.now()}`)
  assert.ok(captured, 'the client bundle must call window.__ModuleLoader__.load')
  return {
    descriptor: captured,
    exports: captured.factory(specifier => {
      if (specifier === 'react') return react
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      throw new Error(`unexpected specifier ${specifier}`)
    }),
  }
}

test('second-batch payload builders preserve the backend contracts', async () => {
  const { exports } = await materialize()
  const cron = exports.automationRuleFromDraft({
    name: ' 日报 ', description: ' summary ', triggerType: 'cron', cron: ' 0 9 * * * ', timeZone: 'UTC',
    everyMs: '', source: '', eventTypes: '', prompt: ' 汇总项目 ', relativePath: ' artifacts/daily.md ',
    events: ['completed', 'failed', 'completed'], maxRuns: '10', maxModelCalls: '', maxTokens: '2000', maxCost: '100',
  })
  assert.deepEqual(cron, {
    name: '日报', description: 'summary', trigger: { type: 'cron', cron: '0 9 * * *', timeZone: 'UTC' },
    action: { type: 'run', prompt: '汇总项目' }, output: { relativePath: 'artifacts/daily.md' },
    notify: { events: ['completed', 'failed', 'completed'] },
    budget: { maxRuns: 10, maxModelCalls: null, maxTokens: 2000, maxCost: 100 },
  })
  const source = exports.automationRuleFromDraft({
    triggerType: 'source', source: ' github ', eventTypes: ' push, pull_request, ', prompt: 'review', relativePath: 'out/review.md',
  })
  assert.deepEqual(source.trigger, { type: 'source', source: 'github', eventTypes: ['push', 'pull_request'] })
  const every = exports.automationRuleFromDraft({ triggerType: 'every', everyMs: '60000', prompt: 'tick', relativePath: 'out/tick.md' })
  assert.deepEqual(every.trigger, { type: 'every', everyMs: 60000 })
  assert.equal(exports.automationRuleFromDraft({ triggerType: 'every', everyMs: '1.5', prompt: 'x', relativePath: 'x.md' }).trigger.everyMs, 1.5,
    'invalid numeric input is not silently converted into an unlimited budget')
  assert.equal(exports.automationTriggerLabel({ trigger: { type: 'every', everyMs: 120000 } }), '每 2 分钟')

  const model = {
    project: { cwd: '/work/a' }, detail: { id: 'run-1', goal: '发布', model: 'test/model' },
    more: { cloudWorker: { provider: 'remote', model: 'cloud/model' } },
  }
  const spec = exports.cloudWorkSpecFromDraft(model, {
    runId: 'run-1', subtaskId: 'release', attempt: '2', repoSnapshot: '/work/a', prompt: ' 构建 ',
    modelProvider: 'remote', modelRef: 'cloud/model', toolAllow: ' read_file, write_file, ', approvalMode: 'manual',
    maxTokens: '1000', maxCostUsd: '0.5', maxWallSeconds: '600', maxToolCalls: '8',
    deadline: '2026-12-01T09:30', checkpointRef: 'checkpoint/release',
  })
  assert.deepEqual(spec.run, { id: 'run-1' })
  assert.deepEqual(spec.subtask, { id: 'release' })
  assert.equal(spec.attempt, 2)
  assert.equal(spec.prompt, '构建')
  assert.deepEqual(spec.toolScope, { allow: ['read_file', 'write_file'] })
  assert.deepEqual(spec.budget, { maxTokens: 1000, maxCostUsd: 0.5, maxWallSeconds: 600, maxToolCalls: 8 })
  assert.equal(spec.deadline, new Date('2026-12-01T09:30').toISOString())
  assert.deepEqual(spec.checkpoint, { ref: 'checkpoint/release' })
  assert.equal(Object.keys(spec).some(key => /secret|password|credential|token/i.test(key)), false)

  const handoff = { registry: 'https://registry.npmjs.org', package: { name: '@scope/review-skill', version: '1.2.3' }, installed: false, executed: false }
  const command = exports.marketInstallCommand(handoff)
  assert.match(command, /^npm install --ignore-scripts --registry https:\/\/registry\.npmjs\.org '@scope\/review-skill@1\.2\.3'$/)
  assert.equal(exports.shareUrlOf({ token: 'shr_abc' }), '/superagent/api/share/shr_abc')
  const stableA = `art_cnVuLUE.${'A'.repeat(43)}`
  const stableB = `art_cnVuLTI.${'B'.repeat(43)}`
  assert.deepEqual(exports.availableArtifacts({ artifacts: [{ id: stableA, name: 'one' }, { id: stableA, name: 'duplicate' }],
    runs: [{ id: 'run-1', artifacts: [{ href: '/tmp/report.md', name: 'raw' }] }],
    workbench: { runs: [{ artifacts: [{ id: stableB, name: 'two' }] }] } }).map(item => item.shareId), [stableA, stableB])
})

test('global assistant saves carry immutable identity, fixed scopes and optimistic revisions', async () => {
  const { exports } = await materialize()
  const draft = exports.assistantDraftFromProfile({ name: 'Old', avatar: 'assistant', role: 'assistant',
    id: 'global-assistant', revision: 7, tools: ['read_file'], permissions: ['workspace.read'] })
  Object.assign(draft, { name: ' Release Assistant ', avatar: 'bot', provider: ' local ', model: ' test/model ',
    tools: 'read_file, write_file, read_file', permissions: 'workspace.read, memory.global', expectedRevision: 7 })
  const update = exports.assistantProfilePayload(draft, [{ id: 'global-assistant', role: 'assistant', revision: 7 }])
  assert.deepEqual(update, { action: 'update', id: 'global-assistant', expectedRevision: 7, patch: {
    name: 'Release Assistant', avatar: 'bot', provider: 'local', model: 'test/model',
    tools: ['read_file', 'write_file'], permissions: ['workspace.read', 'memory.global'],
    memoryScope: 'global', workspaceScope: 'global',
  } })
  assert.equal(Object.hasOwn(update.patch, 'id'), false)
  assert.equal(Object.hasOwn(update.patch, 'role'), false)
  const create = exports.assistantProfilePayload(draft, [])
  assert.equal(create.action, 'create')
  assert.equal(create.profile.id, 'global-assistant')
  assert.equal(create.profile.role, 'assistant')
  assert.equal(Object.hasOwn(create.profile, 'expectedRevision'), false)
  assert.throws(() => exports.assistantProfilePayload(draft, [
    { id: 'global-assistant', role: 'assistant' }, { id: 'another', role: 'assistant' },
  ]), /多个助理/)
})

test('approval risk is translated first and raw tool details stay collapsed', async () => {
  const { exports } = await materialize()
  const translated = exports.approvalRiskView({ toolName: 'shell.execute', callArguments: '{"cmd":"rm -rf build"}',
    riskSummary: '可能删除构建目录。', recommendation: '请确认目录后允许。' })
  assert.equal(translated.impact, '可能删除构建目录。')
  assert.equal(translated.recommendation, '请确认目录后允许。')
  assert.deepEqual(translated.details[0], ['工具', 'shell.execute'])
  assert.match(exports.approvalRiskView({ toolName: 'shell.execute' }).impact, /可能修改文件/)
  assert.match(exports.approvalRiskView({ toolName: 'shell.execute', callArguments: '{"cmd":"rm -rf build"}' }).impact, /cmd/)
  assert.match(exports.approvalRiskView({ toolName: 'read_file' }).impact, /预计读取信息/)

  const approval = { id: 'approval-1', kind: 'approval', toolName: 'shell.execute', callArguments: '{"cmd":"rm -rf build"}',
    riskSummary: '可能删除构建目录。', recommendation: '请确认目录后允许。', ownerSessionId: 'chat-a' }
  const card = await panelHarness({ approvals: [approval], workbench: { projects: [], runs: [], goals: [],
    inbox: [{ id: 'inbox-1', kind: 'approval', item: approval, project: { cwd: '/work/a', name: 'A' } }] } })
  card.model().more = { panel: 'inbox', loading: false, busy: {}, confirming: {} }
  let nodes = card.render()
  nodes.find(node => node.props?.role === 'tab' && node.children.includes('更多')).props.onClick()
  nodes = card.render()
  const detail = nodes.find(node => node.type === 'details' && node.props?.className === 'dsa-approval-details')
  assert.ok(detail, textOf(nodes))
  assert.equal(detail.props.open, undefined, 'raw tool name and arguments are collapsed by default')
  assert.ok(textOf(nodes).includes('影响'))
  assert.ok(textOf(nodes).includes('可能删除构建目录。'))
  assert.ok(textOf(nodes).includes('建议'))
  assert.ok(buttonIn(nodes, '允许一次'))
  assert.ok(buttonIn(nodes, '本会话都放行'))
  assert.ok(buttonIn(nodes, '拒绝'))
})

test('assistant next steps and blockers render inline without another panel', async () => {
  const card = await panelHarness({ messages: [{ id: 'm1', role: 'assistant', text: '已完成初稿。',
    nextSteps: ['复核证据', '提交评审'], blockers: ['缺少定价'] }] })
  const nodes = card.render()
  const status = nodes.find(node => node.props?.className === 'dsa-message-status')
  assert.ok(status)
  assert.ok(textOf(status).includes('下一步'))
  assert.ok(textOf(status).includes('复核证据'))
  assert.ok(textOf(status).includes('阻塞'))
  assert.ok(textOf(status).includes('缺少定价'))
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '下一步' || node.props?.['aria-label'] === '阻塞'), false)
})

test('the client bundle parses as JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', clientPath], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('reloading the client refreshes an existing stylesheet without appending another one', async () => {
  const { exports } = await materialize()
  const id = 'dsh-superagent-native-style'
  const previous = { id, textContent: '.dsa-task-receipt{display:block}' }
  const originalDocument = globalThis.document
  const appended = []
  globalThis.document = {
    getElementById: requested => requested === id ? previous : null,
    head: { appendChild: element => appended.push(element) },
    createElement: () => ({}),
  }
  try {
    const ctx = { slots: { inject() {} } }
    exports.apply(ctx)
    assert.match(previous.textContent, /\.dsa-header\{[^}]*justify-content:flex-end/)
    assert.match(previous.textContent, /\.dsa-receipt-copy\{display:grid/)
    exports.apply(ctx)
    assert.equal(appended.length, 0)
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('the package declares its browser half consistently', () => {
  assert.deepEqual(pkg.dsh.client, { platform: 'web' })
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.ok(pkg.files.includes('lib/client.js'), 'lib/client.js must be packed')
})

test('the bundle registers under the package id and exports apply/inject', async () => {
  const { descriptor, exports } = await materialize()
  assert.equal(descriptor.id, pkg.name)
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply seats the 超级智能体 entry between 插件 and 自动化任务', async () => {
  const { exports } = await materialize()
  const registered = []
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (props, component) => {
        registered.push({ props, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  const main = registered.find(entry => entry.props.name === 'main')
  const row = registered.find(entry => entry.props.name === 'sidebar.panellist')
  assert.equal(main?.props.key, 'superagent')
  assert.equal(row?.props.id, 'superagent')
  assert.equal(row?.props.label, '超级智能体')
  assert.ok(row.props.order > 0 && row.props.order < 10, 'the row sorts between 插件 (0) and 自动化任务 (10)')
  assert.equal(typeof row.component, 'function')
})

test('a failing seat never throws out of apply', async () => {
  const { exports } = await materialize()
  const ctx = {
    slots: {
      inject: () => {
        throw new Error('no slots here')
      },
      register: () => {
        throw new Error('unreachable')
      },
    },
  }
  assert.doesNotThrow(() => exports.apply(ctx))
})

test('a missing react still yields a plugin face the host accepts', async () => {
  const { descriptor } = await materialize()
  const exports = descriptor.factory(() => {
    throw new Error('react is not in the module table')
  })
  // The loader refuses the whole composition when `apply` is absent.
  assert.equal(typeof exports.apply, 'function')
  assert.doesNotThrow(() => exports.apply({ slots: { inject: () => {}, register: () => {} } }))
})

test('the main panel renders its own loading seat, without a frame', async () => {
  const { exports } = await materialize()
  const registered = []
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (props, component) => {
        registered.push({ props, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  const panel = registered.find(entry => entry.props.name === 'main')
  const shell = panel.component({})
  // Panel is the hook-owned shell; Seat is pure, so one call renders it.
  const tree = typeof shell.type === 'function' ? shell.type(shell.props) : shell
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dsa-root')
  const note = tree.children[0].children[0]
  assert.equal(note.props.className, 'dsa-note')
  assert.equal(note.children[0], '正在连接超级智能体…')

  const row = registered.find(entry => entry.props.name === 'sidebar.panellist')
  const icon = row.component({ size: 16, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 16)
})

test('memo/forwardRef host components are not mistaken for missing exports', async () => {
  // Regression: `typeof ui.MarkdownText === 'function'` rejected React.memo
  // objects, so assistant prose silently fell back to raw markdown text.
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    await materialize({
      Button: { $$typeof: Symbol.for('react.forward_ref'), render: () => null },
      MarkdownText: { $$typeof: Symbol.for('react.memo'), type: () => null },
      UserMessageBubble: () => null,
      StateDot: () => null,
      Menu: () => null,
      Tooltip: () => null,
    })
  } finally {
    console.warn = originalWarn
  }
  const text = warnings.join('\n')
  assert.ok(!text.includes('MarkdownText'), text)
  assert.ok(!text.includes('Button'), text)
})

test('the ready panel links a task receipt, a scoped follow-up, and a direct artifact preview', async () => {
  const seatState = []
  let seatHook = null
  const { exports } = await materialize(null, {
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      if (seatHook === null) return [value, () => {}]
      const index = seatHook++
      if (seatState[index] === undefined) seatState[index] = value
      return [seatState[index], next => {
        seatState[index] = typeof next === 'function' ? next(seatState[index]) : next
      }]
    },
  })
  let panel
  exports.apply({ slots: {
    inject: (name, callback) => callback(),
    register: (props, component) => { if (props.name === 'main') panel = component },
  } })
  const shell = panel()
  const actions = []
  const first = { id: 'a', goal: 'Release notes', status: 'running', parentSessionId: 'chat-a' }
  const second = { id: 'b', goal: 'Feedback', status: 'completed', parentSessionId: 'chat-b', artifacts: [{ name: 'Feedback.md', href: 'feedback.md' }] }
  const goal = {
    id: 'g1', goal: first.goal, ownerSessionId: 'chat-a', status: 'running', decisions: [],
    phases: [
      { id: 'p1', title: 'Draft', status: 'running', runId: first.id },
      { id: 'p2', title: 'Review', status: 'pending', dependsOn: ['p1'] },
    ],
  }
  const model = {
    ...shell.props.model, phase: 'ready', sessionId: 'chat-a', selectedGoalId: goal.id,
    messages: [
      { id: 'receipt', role: 'assistant', text: '已接下任务', taskId: goal.id, at: Date.now() },
      { id: 'phase-receipt', role: 'assistant', text: '阶段 p1 已通过验收', taskId: goal.id,
        phaseId: 'p1', runId: first.id, at: Date.now() },
    ],
    workbench: { sessionId: 'chat-a', runs: [first, second], goals: [goal] },
  }
  function* elements(tree) {
    if (Array.isArray(tree)) {
      for (const child of tree) yield* elements(child)
    } else if (tree && typeof tree === 'object') {
      if (typeof tree.type === 'function') {
        yield* elements(tree.type({ ...tree.props, children: tree.children }))
      } else {
        yield tree
        yield* elements(tree.children)
      }
    }
  }
  const render = overrides => {
    seatHook = 0
    const seat = shell.type({ model: { ...model, ...overrides }, dispatch: action => actions.push(action) })
    seatHook = null
    return [...elements(seat)]
  }
  const button = (nodes, label) => nodes.find(node => node.type === 'button'
    && (node.children.includes(label) || node.props.title === label || node.props['aria-label'] === label))
  const initial = render()
  assert.equal(initial.some(node => node.type === 'aside'), false, 'the workbench stays out of the way until requested')
  assert.ok(initial.some(node => node.type === 'h1' && node.props.className === 'dsa-sr-only'
    && node.children.includes('超级智能体')), 'the assistant keeps one accessible heading')
  assert.equal(initial.some(node => node.props?.className === 'dsa-hero'), false, 'the empty state has no duplicate brand block')
  button(initial, '侧栏').props.onClick()
  const nodes = render()
  button(nodes, first.goal).props.onClick()
  button(nodes, '补充要求').props.onClick()
  button(nodes, 'feedback.md').props.onClick()
  assert.equal(actions[0].taskId, goal.id)
  assert.equal(actions[1].run.id, goal.id)
  assert.equal(actions[2].run.parentSessionId, 'chat-b')
  assert.equal(actions[2].item.href, 'feedback.md')
  assert.ok(nodes.some(node => node.children.includes('等待 Draft')))
  button(nodes, '补充阶段要求 Review').props.onClick()
  assert.equal(actions.at(-1).run.id, goal.id)
  assert.equal(actions.at(-1).phase.id, 'p2')
  // Phase receipts update the single task card instead of adding another card.
  const withPhase = render()
  const phaseButton = withPhase.find(node => node.type === 'button'
    && node.props?.title === '打开阶段 p1 的执行证据')
  assert.equal(phaseButton, undefined, 'phase receipts do not add a duplicate task card')
})

test('assistant replies use bubbles and task receipts collapse into one card', async () => {
  const card = await panelHarness({
    messages: [
      { id: 'plain-reply', role: 'assistant', text: '普通回复', at: Date.now() },
      { id: 'task-reply', role: 'assistant', text: '已接下这项任务。我会在后台推进。',
        receipt: 'registered', taskId: 'goal-1', at: Date.now() },
      { id: 'phase-reply', role: 'assistant', text: '阶段已完成。',
        receipt: 'accepted', taskId: 'goal-1', phaseId: 'p2', runId: 'run-phase', at: Date.now() },
    ],
    workbench: { name: '测试工作台', projects: [], runs: [], inbox: [], goals: [
      { id: 'goal-1', title: '处理任务', goal: '处理任务', status: 'running', phases: [
        { id: 'p1', status: 'completed' }, { id: 'p2', status: 'running' },
      ] },
    ] },
  })
  const nodes = card.render()
  const bubble = nodes.find(node => String(node.props?.className ?? '').includes('dsa-assistant-bubble'))
  assert.ok(bubble, 'plain assistant replies are wrapped in a bubble')
  assert.ok(textOf(bubble).includes('普通回复'))
  const cards = nodes.filter(node => String(node.props?.className ?? '').includes('dsa-task-receipt-card'))
  assert.equal(cards.length, 1, 'task state, title and progress share one card')
  assert.ok(textOf(cards[0]).includes('处理任务'))
  assert.equal(cards[0].props['data-receipt'], 'registered')
  assert.ok(textOf(cards[0]).includes('进行中'))
  assert.ok(textOf(cards[0]).includes('已完成 1/2 阶段'))
  assert.equal(textOf(nodes).includes('已接下这项任务'), false, 'generic receipt prose is not duplicated')
  assert.equal(textOf(nodes).includes('阶段已完成。'), false, 'phase receipts do not add duplicate cards')
})

test('assistant markdown keeps paragraphs and renders markdown, bare, and autolinks', async () => {
  const card = await panelHarness({
    messages: [{
      id: 'markdown-reply', role: 'assistant', at: Date.now(),
      text: '第一段。\n\n第二行\n继续第二段。\n\n- [PR #8204](https://github.com/trpc/trpc/pull/8204)\n- https://example.com/report\n- <https://example.org/query>\n\n**重点**和 `代码`。\n\n[直接评审请求查询]\n(https://api.github.com/search/issues?q=test)',
    }],
  })
  const nodes = card.render()
  assert.equal(nodes.filter(node => node.props?.className === 'dsa-md-paragraph').length, 4)
  assert.equal(nodes.filter(node => node.type === 'br').length, 1)
  assert.equal(nodes.filter(node => node.type === 'li').length, 3)
  assert.deepEqual(nodes.filter(node => node.type === 'a').map(node => node.props.href), [
    'https://github.com/trpc/trpc/pull/8204',
    'https://example.com/report',
    'https://example.org/query',
    'https://api.github.com/search/issues?q=test',
  ])
  assert.equal(textOf(nodes).includes('[直接评审请求查询]'), false)
  assert.ok(nodes.some(node => node.type === 'strong' && textOf(node).includes('重点')))
  assert.ok(nodes.some(node => node.type === 'code' && textOf(node).includes('代码')))
})

/** Hook storage that keeps component state across explicit re-renders. */
function hookCache() {
  const values = []
  let cursor = null
  return {
    hooks: {
      useState(initial) {
        const value = typeof initial === 'function' ? initial() : initial
        if (cursor === null) return [value, () => {}]
        const index = cursor++
        if (values[index] === undefined) values[index] = value
        return [values[index], next => {
          values[index] = typeof next === 'function' ? next(values[index]) : next
        }]
      },
      useRef(initial) {
        if (cursor === null) return { current: initial }
        const index = cursor++
        if (values[index] === undefined) values[index] = { current: initial }
        return values[index]
      },
    },
    begin() { cursor = 0 },
    end() { cursor = null },
  }
}

/** Depth-first walk over a stub element tree, rendering function components. */
function* walkTree(tree) {
  if (Array.isArray(tree)) {
    for (const child of tree) yield* walkTree(child)
  } else if (tree && typeof tree === 'object') {
    if (typeof tree.type === 'function') {
      yield* walkTree(tree.type({ ...tree.props, children: tree.children }))
    } else {
      yield tree
      yield* walkTree(tree.children)
    }
  }
}

/** Mount the stateful panel without a browser; effects remain inert. */
async function panelHarness(patch = {}, options = {}) {
  const cache = hookCache()
  let currentModel = {
    phase: 'ready', sessionId: 'chat-a', project: { cwd: '/work/a', name: '工作区 A' },
    capabilities: { chat: true }, messages: [], runs: [], goals: [], approvals: [], typing: false,
    workbench: { name: '测试工作台', projects: [{ cwd: '/work/a', name: '工作区 A' }], runs: [], goals: [], inbox: [] },
    ...patch,
  }
  let shell
  let firstPanelHook = true
  let panelAttemptHook = true
  let firstSeatHook = true
  let renderedModel = null
  const { exports } = await materialize(null, {
    ...cache.hooks,
    useState(initial) {
      if (firstPanelHook) {
        firstPanelHook = false
        return [currentModel, updater => { currentModel = updater(currentModel) }]
      }
      if (panelAttemptHook) {
        panelAttemptHook = false
        return cache.hooks.useState(initial)
      }
      if (firstSeatHook) {
        firstSeatHook = false
        if (options.defaultRailOpen !== false && initial === false) return cache.hooks.useState(true)
      }
      return cache.hooks.useState(initial)
    },
    useCallback: callback => callback,
  })
  exports.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (props, component) => { if (props.name === 'main') shell = component },
    },
  })
  const render = () => {
    cache.begin()
    firstPanelHook = true
    const seat = shell()
    renderedModel = seat.props.model
    const nodes = [...walkTree(seat)]
    cache.end()
    return nodes
  }
  return {
    render,
    model: () => currentModel,
    renderedModel: () => renderedModel,
    dispatch: action => {
      firstPanelHook = true
      cache.begin()
      const seat = shell()
      cache.end()
      return seat.props.dispatch(action)
    },
  }
}

test('the workbench stays closed by default, switches tabs, and reopens after the narrow drawer closes', async () => {
  const card = await panelHarness({}, { defaultRailOpen: false })
  let nodes = card.render()
  const tab = (label) => nodes.find(node => node.props?.role === 'tab' && (node.children ?? []).includes(label))
  assert.equal(nodes.some(node => node.type === 'aside'), false, 'the default view keeps only the conversation')
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '侧栏').props.onClick()
  nodes = card.render()
  assert.ok(nodes.some(node => node.type === 'aside'))
  assert.ok(nodes.some(node => (node.children ?? []).includes('超级智能体')))
  assert.equal(nodes.some(node => (node.children ?? []).includes('模型：')), false, 'technical identity metadata is not repeated')
  assert.equal(nodes.some(node => (node.children ?? []).includes('当前工作区：')), false, 'the rail does not repeat composer context')
  assert.equal(tab('概览').props['aria-selected'], true)
  assert.equal(tab('概览').props.id, 'dsa-tab-overview')
  assert.equal(nodes.find(node => node.props?.id === 'dsa-rail-overview')?.props['aria-labelledby'], 'dsa-tab-overview')

  tab('任务').props.onClick()
  nodes = card.render()
  assert.equal(tab('任务').props['aria-selected'], true)
  assert.equal(nodes.find(node => node.props?.['aria-label'] === '任务列表')?.props.hidden, false)
  assert.ok(nodes.some(node => node.props?.className === 'dsa-rail-scrim'), 'the same rail can become the narrow drawer scrim')

  nodes.find(node => node.props?.['aria-label'] === '侧栏').props.onClick()
  nodes = card.render()
  assert.equal(nodes.some(node => node.type === 'aside'), false)
  nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '侧栏').props.onClick()
  nodes = card.render()
  assert.equal(nodes.some(node => node.type === 'aside'), true, 'the header reopens the current view')
  assert.equal(tab('概览').props['aria-selected'], true)
})

test('a workspace suggestion offers one recommended choice and a change path', async () => {
  const card = await panelHarness({ workspaceSuggestion: { cwd: '/work/b', name: '项目 B', reason: '当前任务引用这个目录。' } })
  let nodes = card.render()
  const suggestion = nodes.find(node => node.props?.['aria-label'] === '工作区建议')
  assert.ok(suggestion)
  assert.ok(textOf(suggestion).includes('项目 B'))
  assert.ok(textOf(suggestion).includes('当前任务引用这个目录。'))
  await buttonIn(suggestion, '使用推荐').props.onClick()
  assert.equal(card.model().project.cwd, '/work/b')
  nodes = card.render()
  assert.ok(buttonIn(nodes.find(node => node.props?.['aria-label'] === '工作区建议'), '更改'))

  const plain = await panelHarness()
  assert.equal(plain.render().some(node => node.props?.['aria-label'] === '工作区建议'), false)
})

test('the empty composer keeps one primary path and discloses secondary input tools', async () => {
  const card = await panelHarness({
    project: { cwd: null, name: '默认工作区' },
    workbench: { name: '测试工作台', projects: [], runs: [], goals: [], inbox: [{ id: 'new', read: false }, { id: 'old', read: true }] },
  }, { defaultRailOpen: false })
  let nodes = card.render()
  assert.equal(nodes.some(node => node.type === 'aside'), false)
  assert.equal(nodes.some(node => node.props?.className === 'dsa-hero'), false)
  assert.ok(nodes.some(node => node.type === 'h1' && node.props.className === 'dsa-empty-title'
    && node.children.includes('超级智能体')), 'the empty state names the assistant above the composer')
  assert.ok(nodes.some(node => node.type === 'textarea' && node.props.placeholder === '给超级智能体发消息…'))
  assert.ok(nodes.some(node => node.props?.['aria-label'] === '发送给超级智能体'))
  assert.ok(nodes.some(node => node.props?.['aria-label'] === '语音输入'))
  const voiceIndex = nodes.findIndex(node => node.props?.['aria-label'] === '语音输入')
  const sendIndex = nodes.findIndex(node => node.props?.['aria-label'] === '发送给超级智能体')
  assert.ok(voiceIndex >= 0 && voiceIndex < sendIndex, 'voice sits immediately before send')
  assert.ok(nodes.some(node => node.props?.['aria-label'] === '更多输入选项'))
  assert.equal(nodes.filter(node => node.props?.className === 'dsa-header-action').length, 1, 'the header permanently keeps only the sidebar button')
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '待办 1 项'), false, 'the header has no secondary inbox button')
  for (const label of ['添加文件', '切换工作区', '沿用最近对话', '插入批量清单']) {
    assert.equal(nodes.some(node => node.props?.['aria-label'] === label), false, `${label} is not in the default toolbar`)
  }
  assert.equal(nodes.some(node => String(node.props?.['aria-label'] ?? '').startsWith('工作区，')), false,
    'the default workspace does not need a persistent chip')

  nodes.find(node => node.props?.['aria-label'] === '更多输入选项').props.onClick()
  nodes = card.render()
  assert.ok(nodes.some(node => node.props?.id === 'dsa-compose-menu'))
  for (const label of ['添加文件', '切换工作区']) {
    assert.ok(nodes.some(node => node.props?.['aria-label'] === label), `${label} remains available on demand`)
  }
  const menu = nodes.find(node => node.props?.id === 'dsa-compose-menu')
  assert.ok(menu)
  const menuNodes = [...walkTree(menu)]
  for (const label of ['语音输入', '沿用最近对话', '插入批量清单']) {
    assert.equal(menuNodes.some(node => node.props?.['aria-label'] === label), false, `${label} is not duplicated in the menu`)
  }
  assert.equal(nodes.filter(node => node.props?.['aria-label'] === '语音输入').length, 1)
  nodes.find(node => node.props?.['aria-label'] === '切换工作区').props.onClick()
  nodes = card.render()
  assert.ok(nodes.some(node => node.props?.role === 'dialog' && node.props['aria-label'] === '工作区'),
    'the default workspace still has a reachable switcher')
})

test('today summary is deterministic and the overview makes no model request', async () => {
  const { exports } = await materialize()
  const now = new Date(2026, 10, 25, 12)
  const iso = (year, month, day) => new Date(year, month, day, 9).toISOString()
  const model = {
    sessionId: 'chat-a',
    workbench: {
      goals: [
        { id: 'new', status: 'running', createdAt: iso(2026, 10, 25), phases: [] },
        { id: 'done', status: 'completed', createdAt: iso(2026, 10, 24), finishedAt: iso(2026, 10, 25), phases: [] },
        { id: 'failed', status: 'failed', createdAt: iso(2026, 10, 25), finishedAt: iso(2026, 10, 25), phases: [] },
        { id: 'decision', status: 'needs-decision', createdAt: iso(2026, 10, 25), phases: [] },
      ],
      runs: [{ id: 'run-old', goalId: 'done', status: 'completed', createdAt: iso(2026, 10, 20),
        finishedAt: iso(2026, 10, 25), artifacts: [{ name: '报告.md', href: 'report.md' }] }],
      inbox: [],
    },
  }
  assert.deepEqual(exports.todaySummary(model, now), {
    added: 3, active: 1, completed: 1, failed: 1, decisions: 1, artifacts: 1,
  })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('overview must not fetch a model') }
  try {
    const card = await panelHarness({ workbench: model.workbench })
    const nodes = card.render()
    const overview = nodes.find(node => node.props?.['aria-label'] === '概览')
    assert.equal([...walkTree(overview)].filter(node => node.props?.className === 'dsa-overview-task').length, 1)
    const text = nodes.map(node => node.children?.join?.(' ') ?? '').join(' ')
    assert.equal(text.includes('需要关注'), false)
    assert.equal(text.includes('今日摘要'), false)
    assert.equal(text.includes('按本地日期确定性统计'), false)
    assert.equal(text.includes('待办摘要'), false)
    assert.equal(text.includes('暂无待处理事项'), false)
    assert.equal(calls, 0)
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('an empty overview keeps only a compact status and no duplicate action', async () => {
  const card = await panelHarness()
  const nodes = card.render()
  const overview = nodes.find(node => node.props?.['aria-label'] === '概览')
  assert.ok(overview)
  assert.equal([...walkTree(overview)].filter(node => node.props?.className === 'dsa-overview-status').length, 1)
  assert.equal([...walkTree(overview)].filter(node => node.props?.className === 'dsa-overview-task').length, 0)
  assert.equal(buttonIn(nodes, '发起任务'), undefined)
  assert.equal(textOf(overview).includes('今日摘要'), false)
  assert.equal(textOf(overview).includes('暂无产物'), false)
})

test('overview shows one current task and suppresses duplicate inbox demand', async () => {
  const at = minutes => new Date(Date.now() - minutes * 60_000).toISOString()
  const goals = [
    { id: 'done-new', goal: '最新完成', status: 'completed', createdAt: at(1), finishedAt: at(1), phases: [] },
    { id: 'done-old', goal: '较早完成', status: 'completed', createdAt: at(2), finishedAt: at(2), phases: [] },
    { id: 'active', goal: '正在执行', status: 'running', createdAt: at(30), phases: [] },
    { id: 'decision', goal: '等待决定', status: 'needs-decision', createdAt: at(40), phases: [] },
    { id: 'done-oldest', goal: '最久完成', status: 'completed', createdAt: at(50), finishedAt: at(50), phases: [] },
  ]
  const runs = [{ id: 'run-artifacts', goal: '产物任务', status: 'completed', createdAt: at(60), finishedAt: at(60),
    artifacts: [1, 2, 3, 4].map(index => ({ name: `产物 ${index}.md`, href: `artifact-${index}.md`, at: at(index) })) }]
  const inbox = [1, 2, 3].map(index => ({ id: `inbox-${index}`, goalId: 'decision', title: `待办 ${index}`, read: false }))
  const card = await panelHarness({ workbench: { goals, runs, inbox } })
  const nodes = card.render()
  const overview = nodes.find(node => node.props?.['aria-label'] === '概览')
  const preview = [...walkTree(overview)]
  const text = preview.map(node => node.children?.join?.(' ') ?? '').join(' ')
  const tasks = preview.filter(node => node.props?.className === 'dsa-overview-task')
  assert.equal(tasks.length, 1)
  assert.deepEqual(tasks.map(node => node.props.title), ['等待决定'])
  assert.equal(preview.filter(node => String(node.props?.className ?? '').includes('dsa-overview-row')).length, 0)
  assert.equal(preview.filter(node => node.props?.className === 'dsa-detail-label').length, 0)
  assert.equal(preview.filter(node => node.props?.className === 'dsa-inbox-summary').length, 0, 'the task card already carries the decision demand')
  assert.equal(text.includes('待办 1'), false)
  assert.equal(text.includes('产物 4.md'), false)
  assert.equal(text.includes('今日摘要'), false)
  assert.equal(preview.some(node => node.type === 'button' && node.props.variant === 'primary'), false)

  const mixed = await panelHarness({ workbench: { goals, runs, inbox: [
    { id: 'same', goalId: 'decision', title: '当前任务待办', read: false },
    { id: 'other', goalId: 'other', title: '其它任务待办', read: false },
  ] } })
  const mixedOverview = mixed.render().find(node => node.props?.['aria-label'] === '概览')
  const mixedPreview = [...walkTree(mixedOverview)]
  assert.equal(mixedPreview.filter(node => node.props?.className === 'dsa-inbox-summary').length, 1)
  assert.ok(textOf(mixedOverview).includes('1 项待处理'), 'unrelated pending work remains visible')
})

test('long-goal phase runs do not duplicate the goal task card', async () => {
  const { exports } = await materialize()
  const goal = { id: 'goal-1', goal: '发布插件', status: 'running' }
  const tasks = exports.workbenchTasks({ workbench: {
    goals: [goal],
    runs: [
      { id: 'phase-1', goalId: null, origin: { kind: 'long-goal', goalId: 'goal-1' }, goal: '发布插件' },
      { id: 'phase-2', goalId: null, origin: { kind: 'long-goal', goalId: 'goal-1' }, goal: '发布插件' },
      { id: 'standalone', goalId: null, origin: { kind: 'scheduled' }, goal: '每日检查' },
    ],
  } })
  assert.deepEqual(tasks.map(task => task.id), ['goal-1', 'standalone'])
})

/** Mount the panel and open one task card with an empty 工作上下文. */
async function taskCardHarness(goalPatch = {}, modelPatch = {}, benchPatch = {}) {
  const cache = hookCache()
  const { exports } = await materialize(null, cache.hooks)
  let panel
  exports.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (props, component) => { if (props.name === 'main') panel = component },
    },
  })
  const shell = panel()
  const actions = []
  const goal = {
    id: 'goal-empty', goal: '空任务', title: '空任务', ownerSessionId: 'chat-a',
    status: 'completed', decisions: [], phases: [], ...goalPatch,
  }
  const model = {
    ...shell.props.model, phase: 'ready', sessionId: 'chat-a', selectedGoalId: goal.id, messages: [],
    workbench: { sessionId: 'chat-a', runs: [], goals: [goal], ...benchPatch },
    ...modelPatch,
  }
  const render = extra => {
    cache.begin()
    const seat = shell.type({ model: { ...model, ...extra }, dispatch: action => actions.push(action) })
    const nodes = [...walkTree(seat)]
    cache.end()
    return nodes
  }
  const openRail = () => {
    const tasks = render().find(node => node.type === 'button' && node.props?.['aria-label'] === '侧栏')
    assert.ok(tasks, 'the header offers the task view')
    tasks.props.onClick()
    return render()
  }
  const button = (nodes, label) => nodes.find(node => node.type === 'button' && (node.children ?? []).includes(label))
  const composer = nodes => nodes.find(node => node.type === 'textarea')
  const hint = (nodes, name) => nodes.find(node => String(node.props?.className ?? '').includes(name))?.children?.[0]
  return { render, openRail, actions, goal, model, button, composer, hint }
}

test('a phase decision shows one conclusion and hides raw failure detail by default', async () => {
  const decision = {
    id: 'd1', kind: 'phase-exhausted', phaseId: 'p3',
    question: '阶段 p3「实现结算后再来一局」失败：已用尽 2 次尝试。下游阶段 p4 依赖它。可以换一种做法重试、跳过该阶段，或停止整个目标。',
    summary: '阶段 p3「实现结算后再来一局」自动重试已结束，仍未通过验收。',
    impact: '下游阶段 p4 正在等待；已经完成的部分会保留。',
    reason: '已用尽 2 次尝试',
    detail: '# Goal not reached — stopped: no progress: the same acceptance condition failed again',
    options: ['retry', 'skip', 'stop'], source: { runId: 'run-1', failed: ['a1'] },
  }
  const card = await taskCardHarness({}, {}, {
    inbox: [{ id: 'goal:goal-empty:d1', kind: 'decision', title: '阶段失败', goalId: 'goal-empty',
      sessionId: 'chat-a', project: null, read: false, item: decision }],
  })
  card.openRail().find(node => node.props?.role === 'tab' && node.children.includes('更多')).props.onClick()
  const nodes = card.render({ more: { ...card.model.more, panel: 'inbox', loading: false } })
  const attention = nodes.find(node => node.props?.className === 'dsa-attention-card')
  assert.ok(attention, 'the decision card is present in the inbox')
  const inner = [...walkTree(attention)]
  assert.ok(inner.some(node => (node.children ?? []).includes(decision.summary)))
  assert.ok(inner.some(node => (node.children ?? []).includes(decision.impact)))
  assert.equal(inner.some(node => node.type === 'input'), false, 'retry/skip/stop must not show a note field')
  const details = inner.find(node => node.type === 'details')
  assert.ok(details, 'technical detail is available on demand')
  assert.notEqual(details.props.open, true, 'technical detail starts collapsed')
  assert.ok(inner.some(node => node.type === 'button' && (node.children ?? []).includes('换做法重试')))
  card.button(inner, '换做法重试').props.onClick()
  assert.deepEqual(card.actions.at(-1), {
    type: 'goalAction', goalId: 'goal-empty', action: 'answer', owner: 'chat-a',
    body: { decisionId: 'd1', answer: 'retry', note: '' },
  })
})

test('a router upload inserts its path when the default project has no cwd', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (route, options) => {
    requests.push({ route, options })
    return jsonResponse({ path: '/work/.superagent/uploads/session/context.md' })
  }
  try {
    const card = await panelHarness({ project: { cwd: null, name: '默认工作区' } })
    await card.dispatch({ type: 'upload', file: { name: 'context.md', data: 'Y29udGV4dA==' }, project: undefined })
    assert.equal(requests.length, 1, JSON.stringify(requests))
    assert.equal(card.model().uploadInsert, '/work/.superagent/uploads/session/context.md', JSON.stringify(card.model()))
    assert.equal(card.model().uploading, false)
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('the embedded composer uploads pasted images and dropped files in order', async () => {
  const originalReader = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type || 'application/octet-stream'};base64,${file.data || 'ZGF0YQ=='}`
      this.onload?.()
    }
  }
  try {
    const card = await taskCardHarness()
    const nodes = card.render()
    const composer = nodes.find(node => node.props?.className === 'dsa-composer')
    const input = nodes.find(node => node.type === 'textarea')
    assert.ok(composer?.props.onDrop, 'the composer accepts file drops')
    assert.ok(input?.props.onPaste, 'the textarea accepts clipboard files')
    let prevented = false
    input.props.onPaste({
      clipboardData: { files: [{ name: '', type: 'image/png', data: 'aW1hZ2U=' }] },
      preventDefault: () => { prevented = true },
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(prevented, true)
    assert.match(card.actions[0].file.name, /^pasted-image-\d+-\d+\.png$/)
    assert.equal(card.actions[0].file.data, 'aW1hZ2U=')

    input.props.onPaste({
      clipboardData: { files: [], items: [{ kind: 'file', getAsFile: () => ({ name: '', type: 'image/jpeg', data: 'anBlZw==' }) }] },
      preventDefault() {},
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.match(card.actions[1].file.name, /^pasted-image-\d+-\d+\.jpg$/)
    assert.equal(card.actions[1].file.data, 'anBlZw==')

    composer.props.onDrop({
      dataTransfer: { files: [
        { name: 'notes.txt', type: 'text/plain', data: 'bm90ZXM=' },
        { name: 'data.json', type: 'application/json', data: 'anNvbg==' },
      ], types: ['Files'] },
      preventDefault() {}, stopPropagation() {},
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(card.actions.slice(2).map(action => action.file.name), ['notes.txt', 'data.json'])
    assert.deepEqual(card.actions.slice(2).map(action => action.file.data), ['bm90ZXM=', 'anNvbg=='])
  } finally {
    if (originalReader === undefined) delete globalThis.FileReader
    else globalThis.FileReader = originalReader
  }
})

test('queued composer uploads keep their enqueue-time workspace and disabled state', async () => {
  const originalReader = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type || 'application/octet-stream'};base64,${file.data || 'ZGF0YQ=='}`
      this.onload?.()
    }
  }
  const drop = (composer, name) => composer.props.onDrop({
    dataTransfer: { files: [{ name, type: 'text/plain', data: 'ZGF0YQ==' }], types: ['Files'] },
    preventDefault() {}, stopPropagation() {},
  })
  try {
    const card = await taskCardHarness()
    const first = card.render({ project: { cwd: '/work/a', name: 'A' } })
    drop(first.find(node => node.props?.className === 'dsa-composer'), 'a.txt')
    const second = card.render({ project: { cwd: '/work/b', name: 'B' } })
    drop(second.find(node => node.props?.className === 'dsa-composer'), 'b.txt')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(card.actions.map(action => [action.file.name, action.project]), [
      ['a.txt', '/work/a'], ['b.txt', '/work/b'],
    ], 'switching workspaces must not redirect either queued batch')

    const blocked = await taskCardHarness({}, { project: { cwd: '/work/a' }, sending: true })
    drop(blocked.render().find(node => node.props?.className === 'dsa-composer'), 'blocked.txt')
    blocked.render({ project: { cwd: '/work/b' }, sending: false })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(blocked.actions, [], 'a batch accepted while disabled must stay disabled')
  } finally {
    if (originalReader === undefined) delete globalThis.FileReader
    else globalThis.FileReader = originalReader
  }
})

test('the upload request keeps the workspace captured before a project switch', async () => {
  const originalReader = globalThis.FileReader
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.FileReader = class {
    readAsDataURL(file) {
      this.result = `data:${file.type || 'application/octet-stream'};base64,${file.data || 'ZGF0YQ=='}`
      this.onload?.()
    }
  }
  globalThis.fetch = async (route, options) => {
    requests.push({ route, body: JSON.parse(options.body) })
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { path: '/work/a/upload.txt' } }) }
  }
  try {
    const cache = hookCache()
    let currentModel = {
      phase: 'ready', sessionId: 'chat-a', project: { cwd: '/work/a', name: 'A' },
      capabilities: { chat: true }, messages: [], runs: [], goals: [], approvals: [], typing: false,
      workbench: { projects: [], runs: [], goals: [], inbox: [] },
    }
    let shell
    let firstPanelHook = false
    const renderPanel = () => {
      firstPanelHook = true
      return shell()
    }
    const { exports } = await materialize(null, {
      ...cache.hooks,
      useState(initial) {
        if (firstPanelHook) {
          firstPanelHook = false
          return [currentModel, updater => {
            currentModel = updater(currentModel)
            cache.begin()
            renderPanel()
            cache.end()
          }]
        }
        return cache.hooks.useState(initial)
      },
      useCallback: callback => callback,
    })
    exports.apply({ slots: {
      inject: (name, callback) => callback(),
      register: (props, component) => { if (props.name === 'main') shell = component },
    } })
    cache.begin()
    const seat = renderPanel()
    const composer = [...walkTree(seat)].find(node => node.props?.className === 'dsa-composer')
    cache.end()
    assert.ok(composer)
    composer.props.onDrop({
      dataTransfer: { files: [{ name: 'upload.txt', type: 'text/plain', data: 'ZGF0YQ==' }], types: ['Files'] },
      preventDefault() {}, stopPropagation() {},
    })
    await seat.props.dispatch({ type: 'selectProject', project: { cwd: '/work/b', name: 'B' } })
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(requests.length, 1)
    assert.equal(requests[0].route, '/superagent/api/console/upload')
    assert.equal(requests[0].body.project, '/work/a', 'the request must not use the newly selected workspace')
    assert.equal(currentModel.uploadInsert, '', 'an A upload must not be inserted into the B draft')
  } finally {
    if (originalReader === undefined) delete globalThis.FileReader
    else globalThis.FileReader = originalReader
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('global artifacts use the console filters, descriptor ownership, visible errors, and return to their tab', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let failArtifacts = false
  const artifact = {
    id: 'artifact-1', runId: 'run-1', ownerSessionId: 'owner-1', project: { name: '工作区 A', cwd: '/work/a' },
    goal: '发布检查', runStatus: 'completed', name: '报告.md', kind: 'markdown', source: 'run',
    href: '/work/a/报告.md', path: '/work/a/报告.md', bytes: 2048, at: new Date().toISOString(),
  }
  globalThis.fetch = async route => {
    requests.push(route)
    if (route.startsWith('/superagent/api/console/artifacts?')) {
      return failArtifacts
        ? { ok: false, status: 503, json: async () => ({ message: '产物服务暂不可用' }) }
        : { ok: true, status: 200, json: async () => ({ ok: true, data: { artifacts: [artifact], nextCursor: null } }) }
    }
    if (route.includes('/runs/run-1?')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        id: 'run-1', goal: '发布检查', status: 'completed', parentSessionId: 'owner-1', artifacts: [],
      } }) }
    }
    if (route.startsWith('/superagent/api/console/artifact?')) {
      return { ok: false, status: 500, text: async () => '读取失败', json: async () => ({ message: '读取失败' }) }
    }
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = card.render()
    nodes.find(node => node.props?.role === 'tab' && (node.children ?? []).includes('更多')).props.onClick()
    nodes = card.render()
    nodes.find(node => node.props?.['aria-label'] === '产物库').props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    nodes = card.render()
    assert.equal(new URL(requests[0], 'http://local').searchParams.get('limit'), '50')
    assert.match(requests[0], /[?&]q=&kind=&project=&from=&to=&limit=50$/)
    assert.equal(new URL(requests[0], 'http://local').searchParams.get('from'), '')
    assert.equal(new URL(requests[0], 'http://local').searchParams.get('to'), '')
    assert.equal(card.model().more.panel, 'artifacts')

    const artifactCard = nodes.find(node => node.props?.className === 'dsa-artifact-card')
    assert.ok(artifactCard, 'the API descriptor is a clickable card')
    assert.ok([...walkTree(artifactCard)].some(node => (node.children ?? []).includes('工作区 A')),
      'an object project descriptor renders its name, not the raw object')
    await artifactCard.props.onClick()
    nodes = card.render()
    const runUrl = new URL(requests.find(route => route.includes('/runs/run-1?')), 'http://local')
    assert.equal(runUrl.searchParams.get('owner'), 'owner-1')
    const previewUrl = new URL(requests.find(route => route.startsWith('/superagent/api/console/artifact?')), 'http://local')
    assert.equal(previewUrl.searchParams.get('path'), '/work/a/报告.md')
    assert.equal(previewUrl.searchParams.get('runId'), 'run-1')
    assert.equal(previewUrl.searchParams.get('owner'), 'owner-1')
    assert.match(card.model().previewError, /读取失败/)
    assert.equal(card.model().toast.kind, 'err', 'a failed preview is not silent')

    await nodes.find(node => node.props?.['aria-label'] === '返回更多').props.onClick()
    nodes = card.render()
    assert.equal(card.model().preview, null)
    assert.equal(card.model().detail.id, 'run-1', 'preview keeps the existing return-to-detail behavior')
    await nodes.find(node => node.props?.['aria-label'] === '返回更多').props.onClick()
    nodes = card.render()
    assert.equal(card.model().more.panel, 'artifacts', 'closing the detail returns to the originating panel')
    assert.equal(card.model().detail, null)

    const searchArtifacts = nodes.find(node => node.props?.['aria-label'] === '搜索产物')
    assert.ok(searchArtifacts, `artifact search returns after detail: ${textOf(nodes).slice(-800)}`)
    searchArtifacts.props.onChange({ target: { value: '发布' } })
    nodes = card.render()
    nodes.find(node => node.type === 'form' && node.props?.className === 'dsa-answer-row').props.onSubmit({ preventDefault() {} })
    await new Promise(resolve => setImmediate(resolve))
    nodes = card.render()
    assert.equal(new URL(requests.at(-1), 'http://local').searchParams.get('q'), '发布')
    await nodes.find(node => node.props?.['aria-label'] === '产物类型').props.onChange({ target: { value: 'markdown' } })
    nodes = card.render()
    assert.equal(new URL(requests.at(-1), 'http://local').searchParams.get('kind'), 'markdown')
    await nodes.find(node => node.props?.['aria-label'] === '产物开始日期').props.onChange({ target: { value: '2026-11-01' } })
    await new Promise(resolve => setImmediate(resolve))
    nodes = card.render()
    assert.equal(new URL(requests.at(-1), 'http://local').searchParams.get('from'), '2026-11-01')
    await nodes.find(node => node.props?.['aria-label'] === '产物结束日期').props.onChange({ target: { value: '2026-11-25' } })
    await new Promise(resolve => setImmediate(resolve))
    nodes = card.render()
    assert.equal(new URL(requests.at(-1), 'http://local').searchParams.get('to'), '2026-11-25T23:59:59.999Z')
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('列表')).props.onClick()
    nodes = card.render()
    assert.ok(nodes.some(node => node.props?.className === 'dsa-artifact-grid dsa-artifact-list'))

    failArtifacts = true
    await nodes.find(node => node.props?.['aria-label'] === '产物工作区').props.onChange({ target: { value: '/work/a' } })
    nodes = card.render()
    const filterUrl = new URL(requests.at(-1), 'http://local')
    assert.equal(filterUrl.searchParams.get('project'), '/work/a')
    assert.ok(nodes.some(node => node.props?.role === 'alert' && (node.children ?? []).includes('产物读取失败：产物服务暂不可用')))
    assert.equal(card.model().toast.kind, 'err')
    assert.equal(card.model().artifactsLoading, false)
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('run history is not a separate global destination', async () => {
  const card = await panelHarness()
  let nodes = card.render()
  nodes.find(node => node.props?.role === 'tab' && (node.children ?? []).includes('更多')).props.onClick()
  nodes = card.render()
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '运行记录'), false)
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '自动化规则'), false)
})

test('an empty task offers 加别名 and 记决定, and 加别名 only prefills the composer', async () => {
  const card = await taskCardHarness()
  const nodes = card.openRail()
  assert.ok(nodes.some(node => (node.children ?? []).includes('还没有别名或已确认的决定。')),
    'the empty context section still renders')
  const alias = card.button(nodes, '加别名')
  const decision = card.button(nodes, '记决定')
  assert.ok(alias && decision, 'both record entries sit in the expanded card')
  assert.equal(alias.props['aria-label'], '给「空任务」加别名')

  alias.props.onClick()
  assert.deepEqual(card.actions, [], 'a prefill never sends by itself')
  const after = card.render()
  assert.equal(card.composer(after).props.value, '/别名 goal-empty | ')
  assert.equal(card.composer(after).props['aria-label'], '给超级智能体发消息',
    'the command goes through the plain message entry, not a task follow-up')
})

test('记决定 prefills the decision template for the opened task', async () => {
  const card = await taskCardHarness()
  const nodes = card.openRail()
  card.button(nodes, '记决定').props.onClick()
  assert.deepEqual(card.actions, [])
  assert.equal(card.composer(card.render()).props.value, '/决定 goal-empty | ')
})

test('an existing draft is kept intact when a record entry is used', async () => {
  const card = await taskCardHarness()
  let nodes = card.openRail()
  card.composer(nodes).props.onInput({ target: { value: '已经写了一半' } })
  nodes = card.render()
  assert.equal(card.composer(nodes).props.value, '已经写了一半')

  card.button(nodes, '加别名').props.onClick()
  nodes = card.render()
  assert.equal(card.composer(nodes).props.value, '已经写了一半', 'the draft is not replaced')
  assert.match(card.hint(nodes, 'dsa-composer-hint'), /已原样保留/)
  assert.deepEqual(card.actions, [])
})

test('a task follow-up context is kept and the record entry asks to leave it first', async () => {
  const card = await taskCardHarness({}, {
    reply: { id: 'goal-empty', taskId: 'goal-empty', text: '补充给 空任务' },
  })
  let nodes = card.openRail()
  assert.equal(card.composer(nodes).props['aria-label'], '任务补充要求')
  card.button(nodes, '记决定').props.onClick()
  nodes = card.render()
  assert.equal(card.composer(nodes).props.value, '', 'the follow-up mode keeps its empty draft')
  assert.match(card.hint(nodes, 'dsa-composer-hint'), /取消追加/)
  assert.deepEqual(card.actions, [])
})

test('a task outside the selected workspace is not written blind: the card asks to switch first', async () => {
  const card = await taskCardHarness({}, {
    project: { cwd: '/work/one', name: '工作区一' },
  }, {
    sessionProjects: { 'chat-a': { cwd: '/work/two', name: '工作区二' } },
  })
  const nodes = card.openRail()
  card.button(nodes, '加别名').props.onClick()
  const after = card.render()
  assert.equal(card.composer(after).props.value, '')
  assert.match(card.hint(after, 'dsa-record-hint'), /工作区二/)
  assert.match(card.hint(after, 'dsa-record-hint'), /切换到/)
  assert.deepEqual(card.actions, [])
})

test('a default workspace task requires switching back before recording from a named workspace', async () => {
  const card = await taskCardHarness({}, { project: { cwd: '/work/one', name: '工作区一' } })
  card.button(card.openRail(), '记决定').props.onClick()
  const after = card.render()
  assert.equal(card.composer(after).props.value, '')
  assert.match(card.hint(after, 'dsa-record-hint'), /切换到「默认工作区」/)
})

test('the task card separates current decisions from sources and evidence, and labels a receipt', async () => {  const at = Date.now()
  const card = await taskCardHarness({}, {
    contextFacts: [
      { id: 'f-alias', taskId: 'goal-empty', kind: 'alias', value: '发版', confirmedAt: at, origin: 'user' },
      { id: 'f-decision', taskId: 'goal-empty', kind: 'decision', subject: '兼容性', value: '先查旧版',
        confirmedAt: at, phaseId: null, origin: 'user', source: 'user-message' },
      { id: 'f-source', taskId: 'goal-empty', kind: 'source', subject: 'issues.opened', value: 'Issue #7',
        source: 'github', origin: 'external', validFrom: at },
      { id: 'f-evidence', taskId: 'goal-empty', kind: 'evidence', subject: '交付结论', value: '已完成',
        source: 'run', origin: 'run', observedAt: at },
    ],
    messages: [{ id: 'receipt-1', role: 'assistant', text: '已把补充要求写入执行记录。', receipt: 'delivered', at }],
  })
  const nodes = card.openRail()
  const textOf = node => (node.children ?? []).filter(child => typeof child === 'string').join('')
  assert.ok(nodes.some(node => textOf(node).includes('别名 · 发版')))
  assert.ok(nodes.some(node => textOf(node).includes('兼容性 · 先查旧版')))
  assert.ok(nodes.some(node => textOf(node).includes('来源 · issues.opened')), 'an external source is shown as data')
  assert.ok(nodes.some(node => textOf(node).includes('证据 · 已完成')), 'run evidence is shown next to decisions')
  assert.ok(nodes.some(node => (node.children ?? []).includes('已送达')), 'the receipt state is visible')
})

test('the task card binds and unbinds a source without calling the API by hand', async () => {
  const card = await taskCardHarness({ phases: [{ id: 'p1', title: '准备发布说明', status: 'running' }] }, {
    project: { cwd: '/work/one', name: '工作区一' },
    sourceBindings: [{
      id: 'binding-1', source: 'github', objectId: 'github:1:issue:7',
      project: '/work/one', taskId: 'goal-empty', phaseId: 'p1', autoStart: false,
    }],
    sourceState: {
      instances: { feishu: { enabled: true, instanceId: 'fs' } },
      recent: [{ source: 'feishu', instanceId: 'fs', objectId: 'feishu:t1:message:om_1',
        status: 'unbound', data: { subject: { text: '发布检查清单' } } }],
      deliveries: { 'binding-1': [{ key: 'e1', status: 'failed', at: Date.now(), reason: 'Router 无法接收' }] },
    },
  }, { sessionProjects: { 'chat-a': { cwd: '/work/one', name: '工作区一' } } })
  const nodes = card.openRail()
  assert.ok(nodes.some(node => (node.children ?? []).join('').includes('github:1:issue:7')),
    'an existing binding is visible on the task card')
  assert.ok(nodes.some(node => (node.children ?? []).includes('Router 无法接收')))
  card.button(nodes, '撤销').props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'sourceUnbind', id: 'binding-1' })

  card.button(nodes, '绑定来源').props.onClick()
  const form = card.render()
  const object = form.find(node => node.props?.['aria-label'] === '选择收到的来源')
  assert.ok(object, 'the card offers observed objects')
  assert.ok(form.some(node => node.type === 'option' && (node.children ?? []).includes('发布检查清单')))
  object.props.onChange({ target: { value: 'feishu:t1:message:om_1' } })
  const phase = card.render().find(node => node.props?.['aria-label'] === '归到哪个阶段')
  phase.props.onChange({ target: { value: 'p1' } })
  const bind = card.button(card.render(), '绑定')
  await bind.props.onClick()
  const action = card.actions.at(-1)
  assert.equal(action.type, 'sourceBind')
  assert.equal(action.objectId, 'feishu:t1:message:om_1')
  assert.equal(action.taskId, 'goal-empty')
  assert.equal(action.phaseId, 'p1')
  assert.equal(action.project, '/work/one')
})

test('a phase receipt click opens that phase run, and an expired run falls back to the task', async () => {
  const { exports } = await materialize()
  const runs = []
  const tasks = []
  const notes = []
  const openRun = async runId => {
    if (runId === 'run-gone') return false
    runs.push(runId)
    return true
  }
  const openTask = async taskId => { tasks.push(taskId) }
  const notify = text => notes.push(text)

  const first = await exports.openReceiptTarget({
    message: { taskId: 'g1', phaseId: 'p1', runId: 'run-1' }, openRun, openTask, notify,
  })
  const second = await exports.openReceiptTarget({
    message: { taskId: 'g1', phaseId: 'p2', runId: 'run-2' }, openRun, openTask, notify,
  })
  assert.deepEqual(runs, ['run-1', 'run-2'], 'each receipt opens its own phase run')
  assert.deepEqual(tasks, [])
  assert.equal(first.opened, 'phase')
  assert.equal(second.phaseId, 'p2')

  const whole = await exports.openReceiptTarget({
    message: { taskId: 'g1' }, openRun, openTask, notify,
  })
  assert.equal(whole.opened, 'task')
  assert.deepEqual(tasks, ['g1'], 'a whole-task receipt opens the task page')

  const expired = await exports.openReceiptTarget({
    message: { taskId: 'g1', phaseId: 'p1', runId: 'run-gone' }, openRun, openTask, notify,
  })
  assert.equal(expired.opened, 'task')
  assert.equal(expired.fellBack, true)
  assert.deepEqual(tasks, ['g1', 'g1'], 'an expired phase still lands on its task')
  assert.match(notes.join(' '), /阶段 p1 的执行记录已失效/)
})

test('todo and phase-receipt controls stay inside a narrow, 200%-zoomed panel', async () => {
  const { exports } = await materialize()
  const style = { id: 'dsh-superagent-native-style', textContent: '' }
  const originalDocument = globalThis.document
  globalThis.document = {
    getElementById: requested => (requested === style.id ? style : null),
    head: { appendChild: () => {} },
    createElement: () => ({}),
  }
  try {
    const ctx = { slots: { inject() {} } }
    exports.apply(ctx)
    const css = style.textContent

    // A 320px sidebar at 200% zoom still has 160 layout pixels. Everything that
    // carries a todo or a receipt must shrink to its container and wrap, never
    // spill out or be hidden.
    assert.match(css, /\.dsa-task-receipt[^}]*width:min\(100%,460px\)/u,
      'the task receipt must be capped by its container')
    assert.match(css, /\.dsa-task-receipt[^}]*min-width:0/u)
    assert.match(css, /\.dsa-receipt-copy\{[^}]*min-width:0/u)
    assert.match(css, /\.dsa-receipt-heading strong\{[^}]*overflow-wrap:anywhere/u)
    assert.match(css, /\.dsa-answer-row\{[^}]*flex-wrap:wrap/u,
      'todo buttons and the answer field must wrap instead of overflowing')
    assert.match(css, /\.dsa-answer-row > button\{[^}]*max-width:100%[^}]*min-width:0/u)
    assert.match(css, /\.dsa-answer-input\{[^}]*box-sizing:border-box/u)
    assert.doesNotMatch(css, /\.dsa-task-receipt[^}]*display:none/u,
      'a narrow panel must not hide the receipt')
    assert.doesNotMatch(css, /\.dsa-answer-row > button[^}]*display:none/u,
      'a narrow panel must not hide a todo action')
    assert.match(css, /\.dsa-workbench\{[^}]*box-sizing:border-box/u, 'the drawer border stays inside its viewport width')
    assert.match(css, /@container dsa-shell \(max-width:820px\)\{[^}]*\.dsa-body\[data-rail=open\][^}]*grid-template-columns:minmax\(0,1fr\)/u,
      'the resident rail becomes an overlay at the shell container breakpoint')
    assert.match(css, /@container dsa-shell \(max-width:820px\)\{[\s\S]*?\.dsa-workbench\{[^}]*position:absolute/u)
    assert.match(css, /@container dsa-shell \(max-width:820px\)\{[\s\S]*?\.dsa-rail-scrim\{[^}]*display:block/u)
    assert.doesNotMatch(css, /@container dsa-rail \(min-width:360px\)\{\.dsa-artifact-grid\{[^}]*repeat\(2,/u,
      'artifact cards stay single-column in the narrow rail')
    assert.match(css, /\.dsa-more-grid\{grid-template-columns:minmax\(0,1fr\)/u,
      'More cards stay single-column in the narrow rail')
    assert.match(css, /@container dsa-shell \(max-width:480px\)\{[\s\S]*?\.dsa-workbench\{[^}]*width:min\(375px,100%\)/u,
      'the narrow drawer is capped at 375px')
    assert.match(css, /@container dsa-rail \(max-width:375px\)\{[^}]*\.dsa-more-grid\{[^}]*grid-template-columns:minmax\(0,1fr\)/u,
      'More cards collapse inside a 375px rail')
    assert.doesNotMatch(css, /\.dsa-hero/u, 'the empty state has no duplicate brand block')
    assert.match(css, /\.dsa-compose-menu\{[^}]*max-width:100%/u)
    assert.match(css, /@media \(prefers-reduced-motion:reduce\)/u, 'motion respects the OS preference')
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

const jsonResponse = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => status >= 200 && status < 300 ? { ok: true, data } : { ok: false, error: { summary: data?.message ?? `HTTP ${status}` }, data },
})
const settle = () => new Promise(resolve => setImmediate(resolve))

async function openMore(card, label) {
  let nodes = card.render()
  const tab = nodes.find(node => node.props?.role === 'tab' && (node.children ?? []).includes('更多'))
  assert.ok(tab, 'the workbench has a More tab')
  tab.props.onClick()
  await settle()
  nodes = card.render()
  let entry = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === label)
  if (!entry) {
    const settings = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '高级设置')
    if (settings) await settings.props.onClick()
    else {
      const back = nodes.find(node => node.type === 'button' && node.children.includes('返回常用'))
      assert.ok(back, 'More can return from Settings to common entries')
      await back.props.onClick()
    }
    nodes = card.render()
    entry = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === label)
  }
  assert.ok(entry, `More offers ${label}`)
  await entry.props.onClick()
  return card.render()
}

async function openPlanForTest(card) {
  let nodes = card.render()
  nodes.find(node => node.props?.role === 'tab' && node.children.includes('更多')).props.onClick()
  card.model().more = { ...card.model().more, panel: 'plan', loading: false, error: '', busy: {}, confirming: {},
    planDraft: { goal: '', constraints: '', tasks: '', allow: 'read, write', deny: 'shell.execute, network', isolation: 'workspace', budget: '' } }
  return card.render()
}

function field(nodes, label) {
  const direct = nodes.find(node => ['input', 'select', 'textarea'].includes(node.type) && node.props?.['aria-label'] === label)
  if (direct) return direct
  const owner = nodes.find(node => node.type === 'label' && (node.children ?? []).includes(label))
  assert.ok(owner, `the panel has a ${label} field`)
  return [...walkTree(owner)].find(node => ['input', 'select', 'textarea'].includes(node.type))
}

test('the More tab keeps two common entries and discloses advanced settings', async () => {
  const card = await panelHarness()
  let nodes = card.render()
  const more = nodes.find(node => node.props?.role === 'tab' && (node.children ?? []).includes('更多'))
  more.props.onClick()
  nodes = card.render()
  assert.equal(nodes.find(node => node.props?.role === 'tab' && (node.children ?? []).includes('更多'))?.props['aria-selected'], true)
  for (const label of ['产物库', '待办中心']) {
    assert.ok(nodes.some(node => node.type === 'button' && node.props?.['aria-label'] === label), label)
  }
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '能力与连接'), false, 'advanced entries are hidden by default')
  const settings = nodes.find(node => node.props?.['aria-label'] === '高级设置')
  assert.ok(settings)
  await settings.props.onClick()
  nodes = card.render()
  for (const label of ['通知设置', '能力与连接', '记忆中心', '屏幕与控制', '费用', '智能体设置', '设备', '分享', '市场', '云端 Worker']) {
    assert.ok(nodes.some(node => node.type === 'button' && node.props?.['aria-label'] === label), label)
  }
  await nodes.find(node => node.type === 'button' && node.children.includes('返回常用')).props.onClick()
  nodes = card.render()
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '自动化规则'), false)
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '运行记录'), false)
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '任务拆解'), false)
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '验收结果'), false)
  assert.equal(card.model().more?.panel ?? null, null)
  assert.ok(nodes.some(node => node.props?.className === 'dsa-more-grid'))
})

test('notification settings render brief and save dailyBrief/quietHours through PATCH', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let preferences = {
    events: { added: 'inbox', completed: 'both', failed: 'both', decision: 'both', approval: 'both', artifact: 'inbox' },
    channels: ['inbox', 'push'], maxPushPerHour: 3,
    dailyBrief: { enabled: true, time: '09:00', timeZone: 'UTC', channels: ['inbox'] },
    quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: 'UTC', except: [] },
  }
  const center = () => ({
    inbox: [{ id: 'n1', event: 'completed', title: '发布完成', body: '报告已就绪', read: false, at: new Date().toISOString() }],
    brief: { date: '2026-11-26', text: 'Daily brief — 1 completed', nextAt: null },
    unreadCount: 1, preferences, revision: 'rev-2',
  })
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (route.endsWith('/notifications/preferences') && options.method === 'PATCH') {
      preferences = {
        ...preferences,
        dailyBrief: { ...preferences.dailyBrief, ...options.body && JSON.parse(options.body).dailyBrief },
        quietHours: { ...preferences.quietHours, ...options.body && JSON.parse(options.body).quietHours },
      }
      return jsonResponse({ preferences, revision: 'rev-2' })
    }
    if (route.endsWith('/notifications/preferences')) return jsonResponse({ preferences, revision: 'rev-1' })
    if (route.endsWith('/notices/read')) return jsonResponse({ read: JSON.parse(options.body).ids.length, added: 1 })
    if (route.endsWith('/notifications')) return jsonResponse(center())
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = await openMore(card, '通知设置')
    assert.equal(nodes.some(node => (node.children ?? []).includes('发布完成')), false, 'notification settings do not duplicate the inbox queue')
    assert.ok(nodes.some(node => (node.children ?? []).includes('Daily brief — 1 completed')))
    field(nodes, '完成').props.onChange({ target: { value: 'inbox' } })
    field(nodes, '启用每日简报').props.onChange({ target: { checked: false } })
    field(card.render(), '简报时间').props.onChange({ target: { value: '08:30' } })
    field(card.render(), '启用免打扰').props.onChange({ target: { checked: true } })
    field(card.render(), '免打扰开始').props.onChange({ target: { value: '23:00' } })
    field(card.render(), '免打扰结束').props.onChange({ target: { value: '07:30' } })
    nodes = card.render()
    const form = nodes.find(node => node.type === 'form' && String(node.props.className).includes('dsa-more-form'))
    await form.props.onSubmit({ preventDefault() {} })
    const saved = requests.find(request => request.method === 'PATCH')
    assert.equal(saved.route, '/superagent/api/console/notifications/preferences')
    assert.equal(saved.body.dailyBrief.enabled, false)
    assert.equal(saved.body.dailyBrief.time, '08:30')
    assert.equal(saved.body.quietHours.enabled, true)
    assert.equal(saved.body.quietHours.start, '23:00')
    assert.equal(saved.body.quietHours.end, '07:30')
    assert.equal(saved.body.events.completed, 'inbox')
    assert.equal(saved.body.maxPushPerHour, 3)
    assert.equal(card.model().more.notifications.revision, 'rev-2')
    assert.equal(card.model().more.error, '')
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('memory search edits and forgets writable records while read-only and denied writes stay visible', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let denyWrite = true
  let entries = [
    { id: 'editable', title: '简洁偏好', type: 'user-preference', body: 'concise', editable: true, forgettable: true, revision: 1 },
    { id: 'readonly', title: '项目规则', type: 'project-rule', body: 'rule', editable: false, forgettable: false, revision: 1 },
  ]
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (route.startsWith('/superagent/api/console/memory?') && !options.method) {
      const query = new URL(route, 'http://local').searchParams.get('search')?.toLowerCase() ?? ''
      return jsonResponse({ enabled: true, entries: entries.filter(entry => `${entry.title} ${entry.body}`.toLowerCase().includes(query)) })
    }
    if (route.endsWith('/memory') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      if (denyWrite) return jsonResponse({ message: 'memory.write forbidden' }, 403)
      if (body.action === 'update') {
        entries = entries.map(entry => entry.id === body.id ? { ...entry, ...body.patch, revision: entry.revision + 1 } : entry)
        return jsonResponse(entries.find(entry => entry.id === body.id))
      }
      entries = entries.filter(entry => entry.id !== body.id)
      return jsonResponse({ id: body.id, forgotten: true })
    }
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = await openMore(card, '记忆中心')
    assert.equal(nodes.filter(node => node.type === 'button' && (node.children ?? []).includes('编辑')).length, 1,
      'read-only records do not offer edit')
    assert.equal(nodes.filter(node => node.type === 'button' && (node.children ?? []).includes('遗忘')).length, 1,
      'read-only records do not offer forget')
    nodes.find(node => node.type === 'button' && (node.children ?? []).includes('编辑')).props.onClick()
    nodes = card.render()
    const editor = nodes.find(node => node.type === 'textarea' && node.props?.['aria-label']?.startsWith('编辑记忆'))
    editor.props.onChange({ target: { value: 'changed' } })
    nodes = card.render()
    const editForm = nodes.find(node => node.type === 'form' && [...walkTree(node)].some(child => child.type === 'textarea'))
    assert.equal(await editForm.props.onSubmit({ preventDefault() {} }), false)
    nodes = card.render()
    assert.ok(nodes.some(node => node.props?.role === 'alert' && (node.children ?? []).includes('memory.write forbidden')),
      'a denied memory write remains on screen')
    assert.equal(card.model().more.busy['memory:editable'], undefined)

    denyWrite = false
    nodes = card.render()
    const retry = nodes.find(node => node.type === 'form' && [...walkTree(node)].some(child => child.type === 'textarea'))
    assert.equal(await retry.props.onSubmit({ preventDefault() {} }), true)
    const update = requests.find(request => request.method === 'POST')
    assert.deepEqual(update.body, { action: 'update', id: 'editable', expectedRevision: 1, patch: { body: 'changed' } })

    nodes = card.render()
    nodes.find(node => node.type === 'button' && (node.children ?? []).includes('遗忘')).props.onClick()
    nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('确认遗忘')).props.onClick()
    const forget = requests.filter(request => request.method === 'POST').at(-1)
    assert.deepEqual(forget.body, { action: 'forget', id: 'editable', expectedRevision: 2 })

    nodes = card.render()
    const search = nodes.find(node => node.props?.['aria-label'] === '搜索记忆')
    search.props.onChange({ target: { value: 'rule' } })
    nodes = card.render()
    const searchForm = nodes.find(node => node.type === 'form' && ![...walkTree(node)].some(child => child.type === 'textarea'))
    await searchForm.props.onSubmit({ preventDefault() {} })
    assert.equal(new URL(requests.at(-1).route, 'http://local').searchParams.get('search'), 'rule')
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('capability center lists skills/mcp/grants and sends probe/restart/setEnabled with settingsRevision', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let revision = 7
  const snapshot = () => ({
    schemaVersion: 1, available: true, settingsRevision: revision,
    skills: { supported: true, items: [{ name: 'release-review', description: '检查发布', enabled: true, status: 'ready' },
      { name: 'local-review', description: '本地复核', enabled: true, status: 'imported', imported: true }] },
    mcp: { supported: true, servers: [{ name: 'docs', enabled: true, manageable: true, status: 'registered' }] },
    grants: { supported: true, items: [{ id: 'grant-1', provider: 'github', scopes: ['repo.read'], status: 'active' }] },
  })
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (route.endsWith('/capabilities') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      if (body.action === 'setEnabled') {
        assert.equal(body.expectedSettingsRevision, 7)
        revision = 8
        return jsonResponse({ ok: true, name: body.name, enabled: body.enabled, settingsRevision: revision })
      }
      if (body.action === 'loadSkill') return jsonResponse({ name: body.name, content: '# Local review', provider: 'dsh-superagent-imported' })
      if (body.action === 'setSkillEnabled') return jsonResponse({ ok: true, name: body.name, enabled: body.enabled })
      return jsonResponse({ ok: true, name: body.name, action: body.action, latencyMs: 12 })
    }
    if (route.endsWith('/capabilities')) return jsonResponse(snapshot())
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = await openMore(card, '能力与连接')
    assert.ok(nodes.some(node => (node.children ?? []).includes('release-review')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('docs')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('repo.read')))
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('探测')).props.onClick()
    nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('重启')).props.onClick()
    nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('停用')).props.onClick()
    const posts = requests.filter(request => request.method === 'POST')
    assert.deepEqual(posts.map(request => request.body.action), ['probe', 'restart', 'setEnabled'])
    assert.deepEqual(posts[0].body, { action: 'probe', name: 'docs' })
    assert.deepEqual(posts[1].body, { action: 'restart', name: 'docs' })
    assert.deepEqual(posts[2].body, { action: 'setEnabled', name: 'docs', enabled: false, expectedSettingsRevision: 7 })
    assert.equal(card.model().more.capabilities.settingsRevision, 8)
    nodes = card.render()
    await nodes.find(node => node.props?.['aria-label'] === 'MCP 名称').props.onChange({ target: { value: 'local-review' } })
    nodes = card.render()
    await nodes.find(node => node.props?.['aria-label'] === 'MCP 参数').props.onChange({ target: { value: 'server.js\n--read-only' } })
    nodes = card.render()
    await nodes.find(node => node.props?.['aria-label'] === 'MCP 环境变量引用').props.onChange({ target: { value: 'TOKEN=${MCP_TOKEN}' } })
    nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('添加 MCP')).props.onClick()
    nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('确认添加')).props.onClick()
    const add = requests.filter(request => request.method === 'POST').at(-1)
    assert.deepEqual(add.body, { action: 'add', name: 'local-review', expectedSettingsRevision: 8,
      server: { transport: 'stdio', enabled: true, command: 'node', args: ['server.js', '--read-only'], env: { TOKEN: '${MCP_TOKEN}' } } })
    nodes = card.render()
    const skillRow = rowNamed(nodes, '本地复核')
    await buttonIn(skillRow, '按需加载').props.onClick()
    assert.equal(requests.filter(request => request.method === 'POST').at(-1).body.action, 'loadSkill')
    assert.ok(textOf(card.render()).includes('# Local review'))
    nodes = card.render()
    await buttonIn(rowNamed(nodes, '本地复核'), '停用 Skill').props.onClick()
    assert.deepEqual(requests.filter(request => request.method === 'POST').at(-1).body,
      { action: 'setSkillEnabled', name: 'local-review', enabled: false })
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('runtime view captures, takes over, releases and confirms emergency stop', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let snapshot = { available: true, services: { browser: true, desktop: false, runtime: true }, control: { mode: 'auto', automaticActions: 'running' }, actions: [] }
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (route.endsWith('/runtime-view') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      if (body.action === 'capture') return jsonResponse({ path: '/shots/view.png', source: body.payload.source, capturedAt: Date.now() })
      if (body.action === 'stop') return jsonResponse({ stopped: true, cancelled: true, runId: body.payload.runId })
      snapshot = { ...snapshot, control: { mode: body.action === 'takeover' ? 'manual' : 'auto', automaticActions: body.action === 'takeover' ? 'paused' : 'running' } }
      return jsonResponse(snapshot)
    }
    if (route.endsWith('/runtime-view')) return jsonResponse(snapshot)
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness({ detail: { id: 'run-1', goal: '检查', status: 'running' } })
    let nodes = await openMore(card, '屏幕与控制')
    for (const label of ['截图', '接管', '释放']) {
      await nodes.find(node => node.type === 'button' && (node.children ?? []).includes(label)).props.onClick()
      nodes = card.render()
    }
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('停止')).props.onClick()
    nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('确认停止')).props.onClick()
    const posts = requests.filter(request => request.method === 'POST')
    assert.deepEqual(posts.map(request => request.body.action), ['capture', 'takeover', 'release', 'stop'])
    assert.deepEqual(posts[0].body.payload, { source: 'auto' })
    assert.deepEqual(posts[3].body.payload, { runId: null }, 'More closes task detail before runtime stop')
    assert.equal(card.model().more.runtimeActionResult.stopped, true)
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('cost, profiles and device pairing load through advanced settings', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let profiles = [{ id: 'agent-1', name: '研究员', role: 'researcher', model: 'test/model', enabled: true, revision: 1, tools: ['read_file'], permissions: ['workspace.read'] }]
  let devices = [{ id: 'device-1', name: '旧手机', status: 'active', scopes: ['chat'], expiresAt: '2027-01-01T00:00:00.000Z' }]
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (route.includes('/runs/run-1/evidence?')) return jsonResponse({ runId: 'run-1', cards: [{ id: 'e1', title: '机器校验', category: 'machine', status: 'passed', basis: { summary: '退出码 0' }, confidence: { level: 'verified' } }], summary: { total: 1, byStatus: { passed: 1, failed: 0, unverified: 0 } } })
    if (route.endsWith('/cost') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      if (body.action === 'budget') return jsonResponse({ budgets: body.budgets })
      return jsonResponse({ ok: true, status: 'selected', provider: 'test', model: 'model-v1', route: 'test/model-v1', role: 'worker', estimatedMicros: 10, currency: 'CNY' })
    }
    if (route.endsWith('/cost')) return jsonResponse({ runs: 1, records: 1, complete: false, byCurrency: { CNY: 100_000 }, byModel: { 'test/model': { calls: 1, totalTokens: 10, priced: true, amountMicros: 100_000 } }, unpricedItems: [{ model: 'unpriced/model', runId: 'run-1', reason: 'no usable price' }] })
    if (route.endsWith('/profiles?includeDisabled=true')) return jsonResponse(profiles)
    if (route.endsWith('/profiles') && options.method === 'POST') {
      const body = JSON.parse(options.body)
      profiles = profiles.map(profile => profile.id === body.id ? { ...profile, enabled: body.enabled, revision: profile.revision + 1 } : profile)
      return jsonResponse(profiles[0])
    }
    if (route.endsWith('/device/status')) return jsonResponse(devices)
    if (route.endsWith('/device/pair')) {
      const body = JSON.parse(options.body)
      const device = { id: 'device-2', name: body.name, status: 'active', scopes: body.scopes, expiresAt: '2026-11-27T00:00:00.000Z', token: 'dsm_test_token' }
      devices = [...devices, device]
      return jsonResponse(device)
    }
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness({ workbench: { runs: [{ id: 'run-1', goal: '最近任务', status: 'completed', parentSessionId: 'chat-a' }], goals: [], inbox: [] } })
    let nodes = await openMore(card, '费用')
    assert.ok(nodes.some(node => (node.children ?? []).includes('CNY 0.1')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('unpriced/model')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('no usable price')))
    field(nodes, '预算金额').props.onChange({ target: { value: '2.5' } })
    nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('保存预算')).props.onClick()
    assert.deepEqual(requests.filter(request => request.method === 'POST').at(-1).body,
      { action: 'budget', budgets: { USD: 2_500_000 } })
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('获取路由建议')).props.onClick()
    assert.deepEqual(requests.filter(request => request.method === 'POST').at(-1).body,
      { action: 'route', role: 'worker', complexity: 'medium', inputTokens: 4000 })
    assert.ok(textOf(card.render()).includes('model-v1'))

    await card.dispatch({ type: 'closeMore' })
    nodes = await openMore(card, '智能体设置')
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('停用')).props.onClick()
    await card.render().find(node => node.type === 'button' && (node.children ?? []).includes('确认停用')).props.onClick()
    assert.deepEqual(requests.filter(request => request.method === 'POST').at(-1).body, { action: 'toggle', id: 'agent-1', enabled: false })

    await card.dispatch({ type: 'closeMore' })
    nodes = await openMore(card, '设备')
    assert.ok(nodes.some(node => (node.children ?? []).includes('旧手机')))
    field(nodes, '设备名称').props.onChange({ target: { value: '新手机' } })
    nodes = card.render()
    const pairForm = nodes.find(node => node.type === 'form')
    await pairForm.props.onSubmit({ preventDefault() {} })
    const pair = requests.find(request => request.route.endsWith('/device/pair'))
    assert.equal(pair.body.name, '新手机')
    assert.deepEqual(pair.body.scopes, ['chat', 'tasks'])
    nodes = card.render()
    assert.ok(nodes.some(node => (node.children ?? []).includes('dsm_test_token')), 'pairing token is shown once')
    await card.dispatch({ type: 'closeMore' })
    assert.equal(card.model().more.pairing, null, 'closing the panel clears the one-time token')
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('the global assistant editor saves every editable field through the profile revision contract', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  let assistant = { id: 'global-assistant', name: 'Global Assistant', avatar: 'assistant', role: 'assistant',
    provider: null, model: null, tools: ['read_file'], permissions: ['workspace.read', 'memory.global'],
    memoryScope: 'global', workspaceScope: 'global', enabled: true, revision: 4 }
  globalThis.fetch = async (route, options = {}) => {
    const method = options.method ?? 'GET'
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ route, method, body })
    if (route.endsWith('/profiles?includeDisabled=true')) return jsonResponse([assistant])
    if (route.endsWith('/profiles') && method === 'POST' && body.action === 'update') {
      assert.equal(body.expectedRevision, assistant.revision)
      assistant = { ...assistant, ...body.patch, revision: assistant.revision + 1 }
      return jsonResponse(assistant)
    }
    if (route.endsWith('/profiles') && method === 'POST' && body.action === 'toggle') {
      assistant = { ...assistant, enabled: body.enabled, revision: assistant.revision + 1 }
      return jsonResponse(assistant)
    }
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = await openMore(card, '智能体设置')
    assert.ok(textOf(nodes).includes('超级智能体设置'))
    assert.ok(nodes.some(node => node.type === 'details' && (node.children ?? []).some(child => child.type === 'summary' && child.children.includes('高级选项'))))
    assert.equal(textOf(nodes).includes('角色：assistant'), false)
    for (const [label, value] of [
      ['超级智能体名称', 'Release Assistant'], ['超级智能体头像', 'bot'], ['超级智能体 Provider', 'local'],
      ['超级智能体模型', 'test/model'], ['超级智能体工具', 'read_file, write_file'],
      ['超级智能体权限', 'workspace.read, workspace.write, memory.global'],
    ]) {
      await nodes.find(node => node.props?.['aria-label'] === label).props.onChange({ target: { value } })
      nodes = card.render()
    }
    await nodes.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    const saved = requests.find(request => request.method === 'POST')
    assert.deepEqual(saved.body, { action: 'update', id: 'global-assistant', expectedRevision: 4, patch: {
      name: 'Release Assistant', avatar: 'bot', provider: 'local', model: 'test/model',
      tools: ['read_file', 'write_file'], permissions: ['workspace.read', 'workspace.write', 'memory.global'],
      memoryScope: 'global', workspaceScope: 'global',
    } })
    assert.equal(card.model().more.profileDraft.expectedRevision, 5)
    assert.equal(card.model().more.profileDraft.dirty, false)
    await card.render().find(node => node.props?.['aria-label'] === '超级智能体模型').props.onChange({ target: { value: 'test/model-v2' } })
    await card.render().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
    assert.equal(requests.filter(request => request.method === 'POST').at(-1).body.expectedRevision, 5)
    await buttonIn(card.render(), '停用超级智能体').props.onClick()
    assert.equal(requests.some(request => request.body?.action === 'toggle'), false)
    await buttonIn(card.render(), '确认停用').props.onClick()
    assert.deepEqual(requests.filter(request => request.body?.action === 'toggle').at(-1),
      { route: '/superagent/api/console/profiles', method: 'POST', body: { action: 'toggle', id: 'global-assistant', enabled: false } })
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

class VoiceTrack {
  readyState = 'live'
  stops = 0
  stop() { this.stops += 1; this.readyState = 'ended' }
}

class VoiceRecorder {
  static instances = []
  static isTypeSupported() { return true }
  constructor(stream, options) {
    this.stream = stream
    this.options = options
    this.state = 'inactive'
    this.listeners = new Map()
    VoiceRecorder.instances.push(this)
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  emit(type, event = {}) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event) }
  start() { this.state = 'recording' }
  data() { this.emit('dataavailable', { data: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: this.options.mimeType }) }) }
  stop() {
    this.state = 'inactive'
    this.data()
    this.emit('stop')
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('composer voice stub records PCM16 WAV, inserts a draft, and discards a late cancelled result', async () => {
  const originalFetch = globalThis.fetch
  const originalRecorder = globalThis.MediaRecorder
  const originalContext = globalThis.AudioContext
  const originalWindow = globalThis.window
  const track = new VoiceTrack()
  const requests = []
  const closes = []
  let pending = null
  class Context {
    async decodeAudioData() {
      return { sampleRate: 16_000, length: 4, numberOfChannels: 1, getChannelData: () => Float32Array.from([0.25, -0.25, 0.5, -0.5]) }
    }
    async close() { closes.push('closed') }
  }
  globalThis.MediaRecorder = VoiceRecorder
  globalThis.AudioContext = Context
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, body: JSON.parse(options.body) })
    if (pending) return pending.promise
    return jsonResponse({ text: '识别文本' })
  }
  VoiceRecorder.instances = []
  try {
    const card = await taskCardHarness()
    globalThis.window.navigator = { mediaDevices: { getUserMedia: async constraints => {
      assert.equal(constraints.audio.channelCount, 1)
      track.readyState = 'live'
      return { getTracks: () => [track], getAudioTracks: () => [track] }
    } } }
    globalThis.window.MediaRecorder = VoiceRecorder
    let nodes = card.render()
    const mic = () => nodes.find(node => node.type === 'button' && node.props?.['aria-label']?.includes('语音') || node.props?.['aria-label'] === '停止录音')
    const pointer = { button: 0, pointerId: 1, preventDefault() {}, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } }
    mic().props.onPointerDown(pointer)
    await settle()
    assert.equal(VoiceRecorder.instances.length, 1)
    nodes = card.render()
    assert.equal(nodes.filter(node => node.props?.['aria-label'] === '停止录音').length, 1,
      'the voice control stays mounted through state changes')
    await nodes.find(node => node.props?.['aria-label'] === '停止录音').props.onPointerUp(pointer)
    nodes = card.render()
    assert.equal(card.composer(nodes).props.value, '识别文本')
    assert.deepEqual(card.actions, [], 'transcription inserts text but never sends it')
    assert.equal(requests[0].route, '/superagent/api/console/voice/transcribe')
    const wav = Buffer.from(requests[0].body.audio, 'base64')
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
    assert.equal(wav.readUInt16LE(22), 1)
    assert.equal(wav.readUInt32LE(24), 16_000)
    assert.equal(wav.readUInt16LE(34), 16)
    assert.equal(track.stops, 1)
    assert.deepEqual(closes, ['closed'])

    mic().props.onPointerDown(pointer)
    await settle()
    nodes = card.render()
    pending = deferred()
    const stopping = nodes.find(node => node.props?.['aria-label'] === '停止录音').props.onPointerUp(pointer)
    await settle()
    nodes = card.render()
    assert.ok(nodes.find(node => node.props?.['aria-label'] === '取消语音输入'))
    nodes.find(node => node.props?.['aria-label'] === '取消语音输入').props.onPointerDown(pointer)
    pending.resolve(jsonResponse({ text: '迟到的文本' }))
    assert.equal(await stopping, null)
    nodes = card.render()
    assert.equal(card.composer(nodes).props.value, '识别文本', 'a cancelled late result cannot alter the draft')
    assert.equal(track.stops, 2)
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    if (originalRecorder === undefined) delete globalThis.MediaRecorder
    else globalThis.MediaRecorder = originalRecorder
    if (originalContext === undefined) delete globalThis.AudioContext
    else globalThis.AudioContext = originalContext
    globalThis.window = originalWindow
  }
})

test('composer voice explains denied permission, missing devices and unavailable transcription', async () => {
  const originalFetch = globalThis.fetch
  const originalRecorder = globalThis.MediaRecorder
  const originalContext = globalThis.AudioContext
  const originalWindow = globalThis.window
  class Context {
    async decodeAudioData() { return { sampleRate: 16_000, length: 1, numberOfChannels: 1, getChannelData: () => Float32Array.from([0]) } }
    async close() {}
  }
  globalThis.MediaRecorder = VoiceRecorder
  globalThis.AudioContext = Context
  VoiceRecorder.instances = []
  try {
    const card = await taskCardHarness()
    let denial = 'NotAllowedError'
    globalThis.window.navigator = { mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: denial, code: 8 }) } } }
    globalThis.window.MediaRecorder = VoiceRecorder
    const pointer = { button: 0, pointerId: 1, preventDefault() {}, currentTarget: { setPointerCapture() {}, releasePointerCapture() {} } }
    let nodes = card.render()
    nodes.find(node => node.props?.['aria-label'] === '语音输入').props.onPointerDown(pointer)
    await settle()
    nodes = card.render()
    assert.ok(nodes.some(node => node.props?.className?.includes('dsa-voice-status') && (node.children ?? []).join('').includes('麦克风权限被拒绝')))

    denial = 'NotFoundError'
    nodes = card.render()
    nodes.find(node => node.props?.['aria-label'] === '语音输入').props.onPointerDown(pointer)
    await settle()
    nodes = card.render()
    assert.ok(nodes.some(node => node.props?.className?.includes('dsa-voice-status') && (node.children ?? []).join('').includes('未检测到可用的麦克风')))

    globalThis.window.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [new VoiceTrack()] })
    globalThis.fetch = async () => jsonResponse({ message: 'remote.speech is unavailable' }, 503)
    nodes = card.render()
    nodes.find(node => node.props?.['aria-label'] === '语音输入').props.onPointerDown(pointer)
    await settle()
    nodes = card.render()
    await nodes.find(node => node.props?.['aria-label'] === '停止录音').props.onPointerUp(pointer).catch(() => {})
    nodes = card.render()
    assert.ok(nodes.some(node => node.props?.className?.includes('dsa-voice-status') && (node.children ?? []).join('').includes('语音转写服务暂不可用')))
    assert.equal(card.composer(nodes).props.value, '')
    assert.deepEqual(card.actions, [])
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    if (originalRecorder === undefined) delete globalThis.MediaRecorder
    else globalThis.MediaRecorder = originalRecorder
    if (originalContext === undefined) delete globalThis.AudioContext
    else globalThis.AudioContext = originalContext
    globalThis.window = originalWindow
  }
})

test('artifact preview shares an explicit artifact id through POST /shares', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, method: options.method, body: JSON.parse(options.body) })
    return jsonResponse({ share: { id: 'share-1' }, token: 'shr_test', url: 'https://example.test/s/shr_test' })
  }
  try {
    const card = await panelHarness({
      detail: { id: 'run-1', goal: '发布', status: 'completed', parentSessionId: 'chat-a' },
      preview: { name: 'report.md', kind: 'md', url: '/superagent/api/console/artifact?path=report.md', item: { id: 'artifact-1', href: 'report.md', runId: 'run-1' } },
      previewText: '# 报告',
    })
    let nodes = card.render()
    const share = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '分享 report.md')
    assert.ok(share, 'artifact preview has a share button')
    await share.props.onClick()
    assert.equal(requests.length, 0, 'sharing a bearer token requires confirmation')
    nodes = card.render()
    const confirm = nodes.find(node => node.type === 'button' && (node.children ?? []).includes('确认分享'))
    assert.ok(confirm, 'the preview offers an explicit share confirmation')
    await confirm.props.onClick()
    assert.deepEqual(requests, [{ route: '/superagent/api/console/shares', method: 'POST',
      body: { action: 'create', share: { artifactIds: ['artifact-1'], role: 'viewer' } } }])
    nodes = card.render()
    assert.ok(nodes.some(node => node.props?.role === 'status' && (node.children ?? []).join('').includes('https://example.test/s/shr_test')))
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('artifact preview opens the original run or continues in a new conversation', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, method: options.method ?? 'GET' })
    if (route === '/superagent/api/console/session' && options.method === 'POST') return jsonResponse({ sessionId: 'chat-b', capabilities: { chat: true } })
    if (route.startsWith('/superagent/api/console/runs/run-1?')) return jsonResponse({ id: 'run-1', goal: '发布', status: 'completed', parentSessionId: 'chat-a' })
    if (route.startsWith('/superagent/api/console/workbench')) return jsonResponse({ sessionId: 'chat-b', name: '测试工作台', projects: [], runs: [], goals: [], inbox: [] })
    if (route === '/superagent/api/console/sources') return jsonResponse({ bindings: [], recent: [] })
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness({
      detail: { id: 'run-1', goal: '发布', status: 'completed', parentSessionId: 'chat-a' },
      preview: { name: 'report.md', kind: 'md', url: '/superagent/api/console/artifact?path=report.md',
        item: { id: 'artifact-1', href: 'report.md', runId: 'run-1', ownerSessionId: 'chat-a' } },
      previewText: '# 报告',
    })
    let nodes = card.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('在原任务打开')).props.onClick()
    assert.equal(card.model().detail.id, 'run-1')
    assert.ok(requests.some(request => request.route.includes('/runs/run-1?') && request.route.includes('owner=chat-a')))
    const continued = await panelHarness({
      routerRevision: -1,
      detail: { id: 'run-1', goal: '发布', status: 'completed', parentSessionId: 'chat-a' },
      preview: { name: 'report.md', kind: 'md', url: '/superagent/api/console/artifact?path=report.md',
        item: { id: 'artifact-1', href: 'report.md', runId: 'run-1', ownerSessionId: 'chat-a' } },
      previewText: '# 报告',
    })
    nodes = continued.render()
    await nodes.find(node => node.type === 'button' && (node.children ?? []).includes('新对话继续')).props.onClick()
    assert.equal(continued.model().sessionId, 'chat-b')
    assert.match(continued.model().uploadInsert, /请基于产物「report.md」继续/)
    assert.ok(requests.some(request => request.route === '/superagent/api/console/session' && request.method === 'POST'))
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('candidate plans auto-generate from goal and optional constraints while manual inputs stay advanced', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (route, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ route, method: options.method ?? 'GET', body })
    if (route.endsWith('/plan-preview') && body.action === 'auto') return jsonResponse({
      kind: 'candidate-plan-preview', status: 'ready', canApprove: true, planDigest: `sha256:${'d'.repeat(64)}`,
      goal: { title: body.goal }, inputSnapshot: { goal: body.goal, project: body.project, subtasks: [{ id: 'one' }],
        permissionScope: { allow: ['read'] }, runtime: { cwd: body.project } },
      issues: [], blocks: [], estimate: { cost: {} }, dag: { tasks: [{ id: 'one', title: '自动任务' }] }, executionStarted: false,
    })
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = await openPlanForTest(card)
    const mainForm = nodes.find(node => node.type === 'form' && textOf(node).includes('自动生成计划'))
    assert.ok(mainForm)
    assert.equal(textOf(mainForm).includes('子任务'), false)
    assert.equal(textOf(mainForm).includes('允许工具'), false)
    assert.ok(nodes.some(node => node.type === 'details' && textOf(node).includes('高级设置')))
    await field(nodes, '候选计划目标').props.onChange({ target: { value: '整理发布说明' } })
    nodes = card.render()
    await field(nodes, '候选计划约束').props.onChange({ target: { value: '只读代码' } })
    nodes = card.render()
    await nodes.find(node => node.type === 'form' && textOf(node).includes('自动生成计划')).props.onSubmit({ preventDefault() {} })
    assert.deepEqual(requests[0].body, { action: 'auto', goal: '整理发布说明', project: '/work/a', constraints: '只读代码' })
    assert.equal(card.model().more.planPreview.kind, 'candidate-plan-preview')
    assert.ok(textOf(card.render()).includes('自动任务'))
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('candidate plan approval does not submit a blind message when Router support is absent', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  const planDigest = `sha256:${'a'.repeat(64)}`
  const inputSnapshot = { version: 1, kind: 'candidate-plan-input', goal: '候选发布', project: '/work/a',
    subtasks: [{ id: 'candidate-1', title: '起草', prompt: '写报告', capabilities: ['analysis'] }],
    capabilities: ['analysis'], model: 'default', budget: null,
    permissionScope: { tools: ['read', 'write'], allow: ['read', 'write'], deny: ['shell.execute', 'network'], approvalMode: 'policy' },
    runtime: { cwd: '/work/a', isolation: 'workspace', provider: 'local', mode: 'execute', platform: 'host', shell: 'host' } }
  const preview = { kind: 'candidate-plan-preview', status: 'ready', goal: { title: '候选发布' }, planDigest, inputSnapshot,
    sideEffects: 'none', executionStarted: false, canApprove: true, estimate: { modelCalls: 2, tokens: { total: 100 }, cost: { totalMicros: 0, complete: true } },
    issues: [], pendingConfirmations: [], dag: { tasks: [{ id: 'candidate-1', title: '起草' }] },
    permissionScope: inputSnapshot.permissionScope, runtime: inputSnapshot.runtime }
  globalThis.fetch = async (route, options = {}) => {
    const method = options.method ?? 'GET'
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ route, method, body })
    if (route.endsWith('/plan-preview') && body.action === 'candidate') return jsonResponse(preview)
    if (route.endsWith('/plan-preview') && body.action === 'approve') return jsonResponse({ kind: 'plan-approval-credential',
      state: 'approved', planDigest, goal: preview.goal, project: inputSnapshot.project,
      permissionScope: inputSnapshot.permissionScope, runtime: inputSnapshot.runtime, approval: { confirmations: [] }, executionStarted: false })
    if (route.endsWith('/router')) return jsonResponse({ revision: 1, messages: [], facts: [], pending: 0 })
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = await openPlanForTest(card)
    const goalField = nodes.find(node => node.props?.['aria-label'] === '候选计划目标')
    assert.ok(goalField, `candidate goal field missing: ${textOf(nodes).slice(-1200)}`)
    await goalField.props.onChange({ target: { value: '候选发布' } })
    nodes = card.render()
    await field(nodes, '子任务（每行一个）').props.onChange({ target: { value: '起草：写报告' } })
    nodes = card.render()
    await nodes.find(node => node.type === 'form' && textOf(node).includes('手工预览候选计划')).props.onSubmit({ preventDefault() {} })
    assert.equal(requests[0].body.action, 'candidate')
    assert.equal(requests[0].body.subtasks[0].title, '起草')
    assert.deepEqual(requests[0].body.permissionScope.deny, ['shell.execute', 'network'])
    assert.equal(requests[0].body.runtime.cwd, '/work/a')
    assert.ok(textOf(card.render()).includes('权限范围'))
    assert.ok(textOf(card.render()).includes('运行环境'))
    assert.equal(card.model().more.planPreview.executionStarted, false)
    await buttonIn(card.render(), '批准并运行').props.onClick()
    assert.deepEqual(requests.filter(request => request.route.endsWith('/plan-preview')).map(request => request.body.action), ['candidate', 'approve'])
    assert.equal(requests.some(request => request.route.endsWith('/message')), false)
    assert.equal(card.model().more.planHandoff.state, 'awaiting-router')
    assert.ok(textOf(card.render()).includes('计划已批准，但系统尚未确认执行方式；没有启动任务。'))
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('an approved candidate plan is bound to the next Router submission', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  const planDigest = `sha256:${'b'.repeat(64)}`
  let inputSnapshot
  let approval
  globalThis.fetch = async (route, options = {}) => {
    const method = options.method ?? 'GET'
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ route, method, body })
    if (route.endsWith('/plan-preview') && body.action === 'candidate') {
      inputSnapshot = { version: 1, kind: 'candidate-plan-input', goal: body.goal, project: body.project,
        subtasks: body.subtasks, capabilities: body.capabilities, model: body.model ?? null, budget: body.budget ?? null,
        permissionScope: body.permissionScope, runtime: body.runtime }
      return jsonResponse({ kind: 'candidate-plan-preview', status: 'ready', goal: { title: body.goal }, planDigest,
        inputSnapshot, canApprove: true, issues: [], blocks: [], pendingConfirmations: [], executionStarted: false,
        estimate: { modelCalls: 1, tokens: { total: 10 }, cost: { totalMicros: 0, complete: true } },
        dag: { tasks: body.subtasks }, permissionScope: body.permissionScope, runtime: body.runtime })
    }
    if (route.endsWith('/plan-preview') && body.action === 'approve') {
      assert.equal(body.planDigest, planDigest)
      approval = { kind: 'plan-approval-credential', state: 'approved', planDigest, goal: { title: body.preview.goal.title },
        project: inputSnapshot.project, permissionScope: inputSnapshot.permissionScope, runtime: inputSnapshot.runtime,
        approval: { confirmations: [] }, executionStarted: false }
      return jsonResponse(approval)
    }
    if (route.endsWith('/router')) return jsonResponse({ revision: 1, messages: [], facts: [], pending: 0,
      planExecution: 'candidate-plan-v1' })
    if (route.endsWith('/message') && method === 'POST') {
      assert.deepEqual(body.planApproval, approval)
      assert.deepEqual(body.candidatePlan, inputSnapshot)
      return jsonResponse({ accepted: true, id: body.id, planDigest: body.planApproval.planDigest })
    }
    throw new Error(`unexpected route ${route}`)
  }
  try {
    const card = await panelHarness()
    let nodes = await openPlanForTest(card)
    await nodes.find(node => node.props?.['aria-label'] === '候选计划目标').props.onChange({ target: { value: '发布候选' } })
    nodes = card.render()
    await nodes.find(node => node.props?.['aria-label'] === '候选计划子任务').props.onChange({ target: { value: '起草：写报告\n复核：检查证据' } })
    nodes = card.render()
    await nodes.find(node => node.type === 'form' && textOf(node).includes('手工预览候选计划')).props.onSubmit({ preventDefault() {} })
    await buttonIn(card.render(), '批准并运行').props.onClick()
    const approveIndex = requests.findIndex(request => request.body?.action === 'approve')
    const messageIndex = requests.findIndex(request => request.route.endsWith('/message'))
    assert.ok(approveIndex >= 0 && messageIndex > approveIndex, 'Router receives the plan only after approval')
    const message = requests[messageIndex]
    assert.equal(message.body.text, '发布候选')
    assert.equal(message.body.project, '/work/a')
    assert.equal(message.body.intent, 'task')
    assert.deepEqual(message.body.candidatePlan.subtasks.map(task => task.id), ['candidate-1', 'candidate-2'])
    assert.equal(message.body.planApproval.planDigest, planDigest)
    assert.equal(card.model().more.planHandoff.state, 'submitted', card.model().more.error)
    assert.equal(card.model().more.planHandoff.planDigest, planDigest)
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('blocked candidate plans expose no runnable approval control', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (route, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ route, body })
    return jsonResponse({ kind: 'candidate-plan-preview', status: 'blocked', canApprove: false, planDigest: `sha256:${'c'.repeat(64)}`,
      inputSnapshot: { goal: '阻塞发布', project: '/work/a', subtasks: [{ id: 'one' }], permissionScope: {}, runtime: {} },
      issues: [{ severity: 'block', code: 'permission_not_allowed', message: '权限不足' }], blocks: [{ code: 'permission_not_allowed' }],
      estimate: { cost: {} }, dag: { tasks: [{ id: 'one' }] }, executionStarted: false })
  }
  try {
    const card = await panelHarness()
    let nodes = await openPlanForTest(card)
    await nodes.find(node => node.props?.['aria-label'] === '候选计划目标').props.onChange({ target: { value: '阻塞发布' } })
    nodes = card.render()
    await nodes.find(node => node.props?.['aria-label'] === '候选计划子任务').props.onChange({ target: { value: '执行：发布' } })
    nodes = card.render()
    await nodes.find(node => node.type === 'form' && textOf(node).includes('手工预览候选计划')).props.onSubmit({ preventDefault() {} })
    assert.equal(buttonIn(card.render(), '批准并运行'), undefined)
    assert.ok(textOf(card.render()).includes('暂时不能运行：权限不足'))
    assert.equal(requests.filter(request => request.body?.action === 'approve').length, 0)
    assert.equal(requests.some(request => request.route.endsWith('/message')), false)
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).filter(Boolean).join(' ')
  if (typeof tree === 'string') return tree
  if (!tree || typeof tree !== 'object') return ''
  if (typeof tree.type === 'function') return textOf(tree.type({ ...tree.props, children: tree.children }))
  return textOf(tree.children ?? tree.props?.children)
}

function buttonIn(tree, label) {
  return [...walkTree(tree)].find(node => node.type === 'button'
    && ((node.children ?? []).includes(label) || node.props?.children === label
      || (Array.isArray(node.props?.children) && node.props.children.includes(label))))
}

function rowNamed(nodes, name) {
  const row = nodes.find(node => node.props?.className === 'dsa-more-row' && textOf(node).includes(name))
  assert.ok(row, `the panel has a row for ${name}; rendered: ${textOf(nodes).slice(-900)}`)
  return row
}

async function clickConfirmed(card, label, confirmLabel, scope = null) {
  const trigger = buttonIn(scope ?? card.render(), label)
  assert.ok(trigger, `the panel offers ${label}`)
  await trigger.props.onClick()
  const confirm = buttonIn(card.render(), confirmLabel)
  assert.ok(confirm, `${label} asks for ${confirmLabel}; rendered: ${textOf(card.render()).slice(-1200)}`)
  await confirm.props.onClick()
  return card.render()
}

test('task-context evidence remains reachable without a global menu entry', async () => {
  const card = await panelHarness()
  await card.dispatch({ type: 'openMore', panel: 'evidence' })
  assert.equal(card.model().more.panel, 'evidence')
})

test('manual automation setup is not exposed in the sidebar', async () => {
  const card = await panelHarness()
  let nodes = card.render()
  nodes.find(node => node.props?.role === 'tab' && node.children.includes('更多')).props.onClick()
  nodes = card.render()
  assert.equal(nodes.some(node => node.props?.['aria-label'] === '自动化规则'), false)
  await card.dispatch({ type: 'openMore', panel: 'automations' })
  assert.equal(card.model().more?.panel ?? null, null)
})

test('task detail leads with a plain conclusion, actions and deliverables', async () => {
  const run = {
    id: 'run-plain', title: 'This run is phase 2 of 3: 核查 trpc/trpc 的 PR 待办 Phase objective: 从现有 GitHub 会话确认账号',
    goal: 'This run is phase 2 of 3: 核查 trpc/trpc 的 PR 待办 Phase objective',
    status: 'completed', phaseIndex: 1,
    phases: [{ id: 'p1', status: 'completed' }, { id: 'p2', status: 'completed' }, { id: 'p3', status: 'completed' }],
    subtasks: Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, title: `工作线 ${index + 1}`, status: 'completed' })),
    output: '# trpc/trpc PR 待核查\n\n**优先处理 [PR #8204](https://github.com/trpc/trpc/pull/8204) 的 CI 失败。**\n\n### 需要处理的事项\n- 登录 GitHub 后重跑 CI\n- 下一步：回复评审意见\n',
    artifacts: [{ name: '20261126T143738-d9a2.md', href: '/work/a/20261126T143738-d9a2.md' }],
  }
  const card = await panelHarness({ detail: run, workbench: { runs: [run], goals: [], inbox: [], projects: [] } })
  const nodes = card.render()
  const heading = nodes.filter(node => node.type === 'h2').at(-1)
  assert.ok(heading)
  assert.ok(textOf(heading).includes('核查 trpc/trpc 的 PR 待办'))
  assert.equal(textOf(heading).includes('Phase objective'), false)
  assert.ok(textOf(nodes).includes('第 2/3 阶段'))
  assert.ok(textOf(nodes).includes('结论'))
  assert.ok(textOf(nodes).includes('优先处理：') && textOf(nodes).includes('PR #8204') && textOf(nodes).includes('CI 失败'))
  assert.ok(nodes.some(node => node.type === 'a' && node.props?.href === 'https://github.com/trpc/trpc/pull/8204'))
  assert.ok(textOf(nodes).includes('下一步'))
  const actionList = nodes.find(node => node.props?.className === 'dsa-run-action-list')
  assert.equal([...walkTree(actionList)].filter(node => node.type === 'li').length, 2, 'distinct next steps are kept without repeating the conclusion')
  assert.ok(textOf(nodes).includes('登录 GitHub 后重跑 CI'))
  assert.ok(textOf(nodes).includes('下一步：回复评审意见'))
  assert.ok(textOf(nodes).includes('交付物'))
  assert.ok(textOf(nodes).includes('核查 trpc/trpc 的 PR 待办报告'))
  const technical = nodes.find(node => node.props?.className === 'dsa-run-technical')
  assert.ok(technical)
  assert.equal(technical.props.open, undefined, 'technical details start collapsed')
  assert.ok(nodes.some(node => node.type === 'button' && (node.children ?? []).includes('查看任务拆解')))
})

test('task detail builds plan preview from run.subtasks and shows blockers, warnings and cost', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  const run = {
    id: 'run-1', goal: '准备发布', status: 'completed', parentSessionId: 'chat-a', project: '/work/a',
    subtasks: [
      { id: 'draft', title: '起草', model: 'test/model', inputTokens: 100, outputTokens: 50, capabilities: ['analysis'] },
      { id: 'review', title: '复核', model: 'test/model', dependsOn: ['draft'], inputTokens: 80, outputTokens: 40 },
    ],
  }
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, body: JSON.parse(options.body) })
    return jsonResponse({
      status: 'blocked', sideEffects: 'none', executionStarted: false,
      issues: [
        { severity: 'block', code: 'pricing_missing', message: '缺少模型价格' },
        { severity: 'warning', code: 'budget_unverified', message: '预算尚未核验' },
      ],
      estimate: { modelCalls: 2, tokens: { total: 270 }, cost: { complete: false, totalMicros: null, currency: 'CNY', unpriced: ['test/model'] } },
      dag: { tasks: [{ id: 'draft', title: '起草' }, { id: 'review', title: '复核', dependsOn: ['draft'] }] },
    })
  }
  try {
    const card = await panelHarness({ detail: run, workbench: { runs: [run], goals: [], inbox: [] } })
    let nodes = card.render()
    const preview = nodes.find(node => node.type === 'button' && (node.children ?? []).includes('查看任务拆解'))
    assert.ok(preview, 'current task detail offers plan preview')
    await preview.props.onClick()
    assert.equal(requests[0].route, '/superagent/api/console/plan-preview')
    assert.equal(requests[0].body.action, 'preview')
    assert.equal(requests[0].body.workspace, '/work/a')
    assert.deepEqual(requests[0].body.plan.subtasks.map(task => task.id), ['draft', 'review'])
    assert.deepEqual(requests[0].body.plan.subtasks[1].dependsOn, ['draft'])
    assert.equal(requests[0].body.plan.subtasks[0].inputTokens, 100)
    assert.ok(requests[0].body.capabilities.includes('model.test/model'))
    nodes = card.render()
    assert.ok(nodes.some(node => (node.children ?? []).includes('阻塞：缺少模型价格')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('警告：预算尚未核验')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('未定价模型：test/model')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('预计：2 次模型调用 · 270 tokens')))
    assert.ok(nodes.some(node => (node.children ?? []).includes('状态：blocked')))
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})
