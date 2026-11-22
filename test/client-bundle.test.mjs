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
    assert.match(previous.textContent, /\.dsa-header-start,\.dsa-header-actions\{display:flex/)
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
  assert.equal(note.children[0], '连接中')

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
  assert.equal(initial.some(node => node.type === 'aside'), false, 'the chat starts without the task drawer')
  initial.find(node => node.type === 'button'
    && String(node.props?.className ?? '').includes('dsa-task-receipt')).props.onClick()
  const nodes = render()
  button(nodes, '追加').props.onClick()
  button(nodes, 'feedback.md').props.onClick()
  assert.equal(actions[0].type, 'openReceipt')
  assert.equal(actions[0].message.taskId, goal.id)
  assert.equal(actions[1].run.id, goal.id)
  assert.equal(actions[2].run.parentSessionId, 'chat-b')
  assert.equal(actions[2].item.href, 'feedback.md')
  assert.ok(nodes.some(node => node.children.includes('等待 Draft')))
  button(nodes, '追加 Review').props.onClick()
  assert.equal(actions.at(-1).run.id, goal.id)
  assert.equal(actions.at(-1).phase.id, 'p2')
  button(render(), '待办').props.onClick()
  // A phase receipt is a different button from a whole-task receipt: it is
  // named after the phase a person knows, and clicking it opens that evidence.
  const withPhase = render()
  const feedCard = withPhase.find(node => node.type === 'button'
    && String(node.props?.className ?? '').includes('dsa-task-receipt'))
  assert.equal(feedCard.props?.title, '报告', 'the one task card leads with the report')
  const receiptCopy = feedCard.children.find(child => child?.props?.className === 'dsa-receipt-copy')
  assert.match(receiptCopy.children[0].children.join(''), /Release notes/)
  assert.doesNotMatch(receiptCopy.children[0].children.join(''), /p1/)
  assert.match(receiptCopy.children[1].children.join(''), /Draft/)
  const phaseButton = withPhase.find(node => node.type === 'button'
    && node.props?.title === '证据')
  assert.ok(phaseButton, 'the old phase receipt stays openable from the same card')
  phaseButton.props.onClick()
  assert.equal(actions.at(-1).type, 'openReceipt')
  assert.equal(actions.at(-1).message.runId, first.id)
  const inbox = render({ inboxOpen: true })
  assert.equal(inbox.some(node => node.children.includes('暂无待处理事项')), false,
    'an empty inbox shows nothing instead of a placeholder')
  assert.equal(inbox.find(node => node.props?.['aria-label'] === '任务列表')?.props.hidden, true,
    'the task list stays mounted so its search can survive a view change')
})

/** Hook storage that keeps component state across explicit re-renders. */
function hookCache() {
  // State belongs to a component, not to a global cursor. A panel that grows a
  // hook must not hand its neighbour the wrong slot.
  const stores = new Map()
  let current = null
  let index = 0
  return {
    hooks: {
      useState(initial) {
        const value = typeof initial === 'function' ? initial() : initial
        if (current === null) return [value, () => {}]
        if (!stores.has(current)) stores.set(current, [])
        const slots = stores.get(current)
        const at = index++
        if (slots[at] === undefined) slots[at] = value
        return [slots[at], next => {
          slots[at] = typeof next === 'function' ? next(slots[at]) : next
        }]
      },
    },
    enter(component) { current = component; index = 0 },
    leave() { current = null; index = 0 },
  }
}

/** Depth-first walk over a stub element tree, rendering function components. */
function* walkTree(tree, cache) {
  if (Array.isArray(tree)) {
    for (const child of tree) yield* walkTree(child, cache)
  } else if (tree && typeof tree === 'object') {
    if (typeof tree.type === 'function') {
      const id = tree.key != null ? `${tree.type.name}#${tree.key}` : tree.type
      cache.enter(id)
      try {
        yield* walkTree(tree.type({ ...tree.props, children: tree.children }), cache)
      } finally {
        cache.leave()
      }
    } else {
      yield tree
      yield* walkTree(tree.children, cache)
    }
  }
}

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
    cache.enter(shell.type)
    let seat
    try {
      seat = shell.type({ model: { ...model, ...extra }, dispatch: action => actions.push(action) })
    } finally {
      cache.leave()
    }
    return [...walkTree(seat, cache)]
  }
  const openRail = () => {
    const tasks = render().find(node => node.type === 'button'
      && String(node.props?.['aria-label'] ?? '').startsWith('待办'))
    assert.ok(tasks, 'the header offers the single 待办 view')
    tasks.props.onClick()
    return render()
  }
  const button = (nodes, label) => nodes.find(node => node.type === 'button' && (node.children ?? []).includes(label))
  const composer = nodes => nodes.find(node => node.type === 'textarea')
  const hint = (nodes, name) => nodes.find(node => String(node.props?.className ?? '').includes(name))?.children?.[0]
  const openMore = nodes => {
    const more = nodes.find(node => node.type === 'button'
      && String(node.props?.['aria-label'] ?? '').startsWith('更多操作'))
    assert.ok(more, 'the empty context folds its two actions behind one 更多操作 entry')
    more.props.onClick()
    return render()
  }
  return { render, openRail, openMore, actions, goal, button, composer, hint }
}

test('an empty task offers 加别名 and 记决定, and 加别名 only prefills the composer', async () => {
  const card = await taskCardHarness()
  let nodes = card.openRail()
  assert.equal(nodes.some(node => (node.children ?? []).join('').includes('还没有别名或已确认的决定')), false,
    'an empty context says nothing')
  nodes = card.openMore(nodes)
  const alias = card.button(nodes, '加别名')
  const decision = card.button(nodes, '记决定')
  assert.ok(alias && decision, 'both record entries fold behind the overflow menu')
  assert.equal(alias.props['aria-label'], '给「空任务」加别名')

  alias.props.onClick()
  assert.deepEqual(card.actions, [], 'a prefill never sends by itself')
  const after = card.render()
  assert.equal(card.composer(after).props.value, '/别名 goal-empty | ')
  assert.equal(card.composer(after).props['aria-label'], '给超级智能体发消息',
    'the command goes through the plain message entry, not a task follow-up')
})

test('the task drawer folds finished work and only searches a long list', async () => {
  const finished = Array.from({ length: 9 }, (_, index) => ({
    id: `done-${index}`, goal: `已完成 ${index + 1}`, title: `已完成 ${index + 1}`, ownerSessionId: 'chat-a',
    status: 'completed', decisions: [], phases: [],
  }))
  const card = await taskCardHarness({}, {}, { goals: [
    { id: 'waiting', goal: '等你决定的任务', title: '等你决定的任务', ownerSessionId: 'chat-a', status: 'needs-decision', decisions: [], phases: [] },
    ...finished,
  ] })
  const nodes = card.openRail()
  assert.ok(nodes.some(node => (node.children ?? []).includes('最近完成 9 项')),
    'finished work collapses into one line')
  assert.ok(nodes.some(node => String(node.props?.className ?? '').includes('dsa-task-search')),
    'a long list reveals the search field')
  const short = await taskCardHarness()
  const shortNodes = short.openRail()
  assert.equal(shortNodes.some(node => String(node.props?.className ?? '').includes('dsa-task-search')), false,
    'a short list has no permanent search box')
  assert.equal(shortNodes.some(node => node.type === 'button' && node.props?.['aria-label'] === '任务'), false,
    'the header keeps only the 待办 entry')
})

test('multiple deliveries share one line until expanded', async () => {
  const run = {
    id: 'r1', goal: '交付', status: 'completed', parentSessionId: 'chat-a', subtasks: [], attention: [],
    artifacts: [{ name: 'a.md', href: 'a.md' }, { name: 'b.md', href: 'b.md' }],
  }
  const card = await taskCardHarness({
    status: 'completed', phases: [{ id: 'p1', title: '交付', status: 'completed', runId: 'r1' }],
  }, {}, { runs: [run] })
  let nodes = card.openRail()
  const summary = nodes.find(node => String(node.props?.className ?? '').includes('dsa-file-summary'))
  assert.ok(summary, 'two files become one summary row')
  assert.ok((summary.children ?? []).some(child => (child.children ?? []).includes('2 个文件')))
  assert.equal(nodes.some(node => String(node.props?.className ?? '').includes('dsa-file-card')), false,
    'individual file cards wait behind the summary')
  summary.props.onClick()
  nodes = card.render()
  const cards = nodes.filter(node => String(node.props?.className ?? '').includes('dsa-file-card'))
  assert.ok(cards.length >= 2, 'expanding reveals both files')
  assert.ok(cards.every(node => (node.children ?? []).some(child =>
    (child.children ?? []).some(name => ['a.md', 'b.md'].includes(name)))),
  'the expanded cards are the two real files')
})

test('记决定 prefills the decision template for the opened task', async () => {
  const card = await taskCardHarness()
  const nodes = card.openMore(card.openRail())
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

  card.button(card.openMore(nodes), '加别名').props.onClick()
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
  card.button(card.openMore(nodes), '记决定').props.onClick()
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
  card.button(card.openMore(nodes), '加别名').props.onClick()
  const after = card.render()
  assert.equal(card.composer(after).props.value, '')
  assert.match(card.hint(after, 'dsa-record-hint'), /工作区二/)
  assert.match(card.hint(after, 'dsa-record-hint'), /切到 工作区二/)
  assert.deepEqual(card.actions, [])
})

test('a default workspace task requires switching back before recording from a named workspace', async () => {
  const card = await taskCardHarness({}, { project: { cwd: '/work/one', name: '工作区一' } })
  card.button(card.openMore(card.openRail()), '记决定').props.onClick()
  const after = card.render()
  assert.equal(card.composer(after).props.value, '')
  assert.match(card.hint(after, 'dsa-record-hint'), /切到 默认 再插入/)
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
  // One receipt card carries the state; the old "已送达" strip only repeated it.
  assert.equal(nodes.some(node => (node.children ?? []).includes('已送达')), false, 'no duplicated receipt strip')
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

  card.button(nodes, '绑定').props.onClick()
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
  assert.match(notes.join(' '), /这一阶段的执行记录已失效/)
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
    assert.match(css, /\.dsa-receipt-copy strong\{[^}]*overflow-wrap:anywhere/u)
    assert.match(css, /\.dsa-answer-row\{[^}]*flex-wrap:wrap/u,
      'todo buttons and the answer field must wrap instead of overflowing')
    assert.match(css, /\.dsa-answer-row > button\{[^}]*max-width:100%[^}]*min-width:0/u)
    assert.match(css, /\.dsa-answer-input\{[^}]*box-sizing:border-box/u)
    assert.doesNotMatch(css, /\.dsa-task-receipt[^}]*display:none/u,
      'a narrow panel must not hide the receipt')
    assert.doesNotMatch(css, /\.dsa-answer-row > button[^}]*display:none/u,
      'a narrow panel must not hide a todo action')
    assert.match(css, /\.dsa-task-line\{[^}]*overflow-wrap:anywhere/u,
      'the task summary wraps instead of widening the rail')
    assert.match(css, /\.dsa-inbox-task\{[^}]*min-width:0[^}]*ellipsis/u,
      'the inbox task label shrinks inside its row')
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('a task title shows its own words, never the phase dispatch prompt', async () => {
  const prompt = 'This run is phase 1 of 5: 调整镜头\n\nPhase objective:\n把镜头切到敌人来的一侧。\nKeep the door open.'
  const card = await taskCardHarness({
    goal: prompt, title: 'This run is phase 1 of 5: 调整镜头',
    phases: [{ id: 'p1', title: '调整镜头', status: 'completed', summary: '镜头已切换' }],
  })
  const deepText = node => typeof node === 'string' ? node : (node?.children ?? []).map(deepText).join('')
  const opened = card.openRail()
  const row = opened.find(node => node.type === 'button' && String(node.props?.className ?? '').includes('dsa-task-row'))
  assert.ok(row, 'the task row is rendered')
  assert.match(deepText(row), /调整镜头/)
  assert.doesNotMatch(deepText(row), /This run is phase|Phase objective|Keep the door open/)
  assert.doesNotMatch(String(row.props.title), /This run is phase/, 'the hover title is clean too')

  const brief = opened.find(node => String(node.props?.className ?? '') === 'dsa-task-line')
  assert.equal(brief?.children?.[0], '镜头已切换', 'the opened task leads with its latest result')
})

test('the todo badge counts one handoff once and leads with what the person must do', async () => {
  const question = '阶段 p2（执行会话 child-9）需要你亲自完成：学习通需要扫码登录。页面：https://pan.example/login'
  const decision = {
    id: 'g1:decision-1', kind: 'decision', goalId: 'g1', project: { cwd: '/work/one', name: '学习通' },
    title: 'This run is phase 1 of 5: 整理课程\n\n整段内部提示',
    item: { id: 'decision-1', question, reason: '旧会话没有登录凭据，需要本人扫码。', options: ['answer', 'skip'],
      source: { kind: 'human', attentionId: 'attention-1', runId: 'run-9', runtimeVerified: true } },
  }
  const twin = {
    ...decision, id: 'run-9:attention-1', kind: 'question', goalId: undefined, runId: 'run-9',
    item: { id: 'attention-1', kind: 'human', question, url: 'https://pan.example/login',
      reason: '旧会话没有登录凭据，需要本人扫码。', handoff: {} },
  }
  const card = await taskCardHarness({}, {}, { inbox: [decision, twin] })
  let nodes = card.render()
  card.button(nodes, '待办').props.onClick()
  nodes = card.render({ inboxOpen: true })
  const badge = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '待办 1 项')
  assert.ok(badge, 'two surfaces of one handoff count once')
  const deepText = node => typeof node === 'string' ? node : (node?.children ?? []).map(deepText).join('')
  assert.ok(nodes.some(node => deepText(node).includes('学习通需要扫码登录')), 'the card states the act itself')
  const headline = nodes.find(node => String(node.props?.className ?? '') === 'dsa-attention-q')
  assert.doesNotMatch(String(headline?.children?.[0]), /阶段 p2|页面/, 'the phase id and page line stay in the detail')
  assert.equal(nodes.some(node => deepText(node).includes('整段内部提示')), false, 'the prompt never becomes a label')
  assert.ok(card.button(nodes, '完成'), 'the direct action is on the first screen')
  assert.ok(card.button(nodes, '登录'), 'the run browser opens inside the conversation')
  assert.ok(nodes.some(node => (node.children ?? []).includes('原因')), 'the reason stays one tap away')

  card.button(nodes, '登录').props.onClick()
  const withLive = card.render({ inboxOpen: true })
  const liveRow = withLive.find(node => node.props?.['data-live-login'])
  assert.ok(liveRow, 'the hand-off becomes a row in the message flow')
  assert.equal(liveRow.props.className, 'dsa-live-msg')

  const empty = card.render({ inboxOpen: true, workbench: { sessionId: 'chat-a', runs: [], goals: [card.goal], inbox: [] } })
  assert.equal(empty.some(node => String(node.props?.['aria-label'] ?? '').startsWith('待办 ')), false,
    'no badge without a todo')
})

const deepText = node => typeof node === 'string' ? node : (node?.children ?? []).map(deepText).join('')

test('a long task title stays within 20 characters on the task row', async () => {
  const long = '在当前工作区把发布说明和兼容性检查一起整理成可以交付的版本并通知所有相关的人'
  const card = await taskCardHarness({ title: long, goal: long, status: 'running' })
  const nodes = card.openRail()
  const label = nodes.find(node => String(node.props?.className ?? '') === 'dsa-task-label')
  assert.ok(label, 'the task row renders')
  const text = deepText(label).trim()
  assert.ok(text.length > 0 && text.length <= 20, `task row title is ${text.length} characters: ${text}`)
})

test('a long result stays within 60 characters on the task card', async () => {
  const long = `已交付发布说明、兼容性检查报告和回归记录，${'另外还有一段很长的补充细节'.repeat(8)}`
  const card = await taskCardHarness({ status: 'running' }, {
    messages: [{ id: 'feed-long', role: 'assistant', text: long, taskId: 'goal-empty', at: Date.now() }],
  })
  const line = card.render().find(node => String(node.props?.className ?? '') === 'dsa-feed-line')
  assert.ok(line, 'the task card renders its body line')
  const text = deepText(line)
  assert.ok(text.length > 0 && text.length <= 60, `task card body is ${text.length} characters: ${text}`)
  assert.doesNotMatch(text, /\n/u)
})

test('the report summary is one line of at most 40 characters', async () => {
  const output = `第一行摘要${'很长的说明'.repeat(20)}\n第二行细节\n第三行细节`
  const card = await taskCardHarness({}, { detail: { id: 'run-report', status: 'completed', output, report: '' } })
  const nodes = card.openRail()
  const summary = nodes.find(node => String(node.props?.className ?? '').includes('dsa-report-summary'))
  assert.ok(summary, 'the report renders its summary')
  const text = deepText(summary)
  assert.ok(text.length > 0 && text.length <= 40, `report summary is ${text.length} characters: ${text}`)
  assert.doesNotMatch(text, /\n/u, 'the summary is the first line only')
  assert.doesNotMatch(text, /第二行/u, 'later lines stay behind 全文')
})

test('a todo card keeps its first line within 25 characters', async () => {
  const entry = {
    id: 'inbox-long', kind: 'decision', goalId: 'g1',
    project: { cwd: '/work/one', name: '学习通' },
    title: '特别长的待办标题需要压缩到二十五个字符以内否则就会溢出',
    item: {
      id: 'item-1',
      question: `阶段 p2 的执行 agent 需要你决定：${'这是很长的一段问题描述'.repeat(4)}`,
      options: ['answer', 'skip'], reason: '', source: {},
    },
  }
  const card = await taskCardHarness({}, {}, { inbox: [entry] })
  card.button(card.render(), '待办').props.onClick()
  const nodes = card.render({ inboxOpen: true })
  const task = nodes.find(node => String(node.props?.className ?? '') === 'dsa-inbox-task')
  const question = nodes.find(node => String(node.props?.className ?? '') === 'dsa-attention-q')
  assert.ok(task && question, 'the todo card renders its first line and question')
  assert.ok(deepText(task).length <= 25, `todo first line is ${deepText(task).length} characters`)
  assert.ok(deepText(question).length <= 25, `todo question is ${deepText(question).length} characters`)
})

test('the panel speaks in labels, not sentence tails or empty-state filler', async () => {
  const source = await readFile(clientPath, 'utf8')
  for (const phrase of ['当前状态', '任务继续', '还没有', '暂无']) {
    assert.equal(source.includes(phrase), false, `${phrase} must not reach the UI`)
  }
})
