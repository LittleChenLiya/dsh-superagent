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
  button(render(), '任务').props.onClick()
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
})

test('a closed task ends the conversation with its own summary bubble', async () => {
  // The progress card sits where the task began; the conclusion needs a bubble
  // of its own at the end, or the conversation reads as if nothing came back.
  const card = await taskCardHarness({ status: 'partial' }, {
    messages: [
      { id: 'reply-u1', role: 'assistant', text: '', taskId: 'goal-empty', at: 1 },
      { id: 'phase-goal-empty-p1-aaaaaaaaaaaa', role: 'assistant', text: '阶段「改造镜头」已交付：完成。',
        taskId: 'goal-empty', phaseId: 'p1', at: 2 },
      { id: 'result-goal-empty-bbbbbbbbbbbb', role: 'assistant', receipt: 'delivered', taskId: 'goal-empty', at: 3,
        text: '「空任务」部分交付（1/2 阶段完成）。最终结论：镜头已改为固定面视角。' },
    ],
  })
  const nodes = card.render()
  const lines = nodes.filter(node => node.props?.className === 'dsa-md-plain')
    .map(node => (node.children ?? []).join(''))
  assert.ok(lines.some(text => text.includes('最终结论：镜头已改为固定面视角。')),
    'the closing text is readable in the conversation')
  assert.ok(nodes.some(node => (node.children ?? []).includes('最终总结')),
    'the closing bubble names itself')
  const cards = nodes.filter(node => String(node.props?.className ?? '').includes('dsa-task-receipt'))
  assert.equal(cards.length, 1, 'the progress card still appears once')
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
async function taskCardHarness(goalPatch = {}, modelPatch = {}, benchPatch = {}, workspace = null) {
  const cache = hookCache()
  const { exports } = await materialize(null, cache.hooks)
  let panel
  exports.apply({
    get: name => (name === 'uiWorkspace' ? workspace : undefined),
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
      && node.props?.['aria-label'] === '任务')
    assert.ok(tasks, 'the header keeps the panel expand button')
    tasks.props.onClick()
    return render()
  }
  const button = (nodes, label) => nodes.find(node => node.type === 'button' && (node.children ?? []).includes(label))
  const composer = nodes => nodes.find(node => node.type === 'textarea')
  const hint = (nodes, name) => nodes.find(node => String(node.props?.className ?? '').includes(name))?.children?.[0]
  const openMore = () => render()
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
  assert.equal(shortNodes.some(node => node.type === 'button' && node.props?.['aria-label'] === '更多入口'), false,
    'no overflow menu hides a duplicate todo entry')
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

test('the reply close button and Escape clear the quote while keeping the draft', async () => {
  const card = await taskCardHarness({}, { reply: { id: 'm1', text: '先前的消息' } })
  card.composer(card.render()).props.onInput({ target: { value: '留在输入框的草稿' } })
  const nodes = card.render()
  const close = nodes.find(node => node.props?.['aria-label'] === '取消引用')
  assert.equal(close.props.className, 'dsa-quote-close')
  close.props.onClick()
  assert.deepEqual(card.actions.pop(), { type: 'reply' })

  const composer = nodes.find(node => node.props?.className === 'dsa-composer')
  let stopped = false
  const escape = { key: 'Escape', preventDefault() { this.defaultPrevented = true },
    stopPropagation() { stopped = true } }
  composer.props.onKeyDown({ ...escape, nativeEvent: { isComposing: true } })
  assert.deepEqual(card.actions, [], 'Escape can first leave the input method')
  composer.props.onKeyDown(escape)
  assert.deepEqual(card.actions, [{ type: 'reply' }])
  assert.ok(escape.defaultPrevented && stopped)
  assert.equal(card.composer(card.render({ reply: null })).props.value, '留在输入框的草稿')
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
    assert.match(css, /\.dsa-inbox-msg-task\{[^}]*min-width:0[^}]*ellipsis/u,
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
  const row = opened.find(node => node.type === 'button' && String(node.props?.className ?? '').includes('dsa-session-main'))
  assert.ok(row, 'the session card is rendered')
  assert.match(deepText(row), /调整镜头/)
  assert.doesNotMatch(deepText(row), /This run is phase|Phase objective|Keep the door open/)
  assert.doesNotMatch(String(row.props.title), /This run is phase/, 'the hover title is clean too')

  const brief = opened.find(node => String(node.props?.className ?? '') === 'dsa-task-line')
  assert.equal(brief?.children?.[0], '镜头已切换', 'the opened task leads with its latest result')
})

test('the todo badge counts one handoff once and leads with what the person must do', async () => {
  const question = '阶段 p2（执行会话 child-9）需要你亲自完成：学习通需要扫码登录。页面：https://pan.example/login'
  const decision = {
    id: 'g1:decision-1', kind: 'decision', goalId: 'g1', sessionId: 'chat-a',
    project: { cwd: '/work/one', name: '学习通' },
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
  const nodes = card.render()
  const rows = nodes.filter(node => String(node.props?.className ?? '') === 'dsa-inbox-msg-row')
  assert.equal(rows.length, 1, 'two surfaces of one handoff count once')
  assert.equal(card.render({ messages: [] }).find(node => node.type === 'main')?.props?.['data-empty'], false,
    'a pending handoff stays visible even if the conversation has no messages')
  assert.ok(nodes.some(node => String(node.props?.className ?? '') === 'dsa-header-dot'),
    'outside the panel a dot still reminds without a second entry')
  const text = nodes.map(deepText).join('')
  assert.ok(text.includes('学习通需要扫码登录'), 'the conversation states the act itself')
  assert.equal(text.includes('整段内部提示'), false, 'the prompt never becomes a label')
  assert.ok(card.button(nodes, '完成'), 'the direct action sits in the message flow')
  assert.ok(card.button(nodes, '登录'), 'the run browser opens inside the conversation')
  assert.ok(nodes.some(node => (node.children ?? []).includes('原因')), 'the reason stays one tap away')
  card.button(nodes, '去会话处理').props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'openSession', sessionId: 'chat-a' })

  card.button(nodes, '登录').props.onClick()
  const withLive = card.render()
  const liveRow = withLive.find(node => node.props?.['data-live-login'])
  assert.ok(liveRow, 'the hand-off becomes a row in the message flow')
  assert.equal(liveRow.props.className, 'dsa-live-msg')

  const empty = card.render({ workbench: { sessionId: 'chat-a', runs: [], goals: [card.goal], inbox: [] } })
  assert.equal(empty.some(node => String(node.props?.className ?? '').includes('dsa-header-dot')), false,
    'no dot without a todo')
})

const deepText = node => typeof node === 'string' ? node : (node?.children ?? []).map(deepText).join('')

/** Text on the card face only; an expanded detail inside the card is skipped. */
const faceText = node => {
  if (typeof node === 'string') return node
  if (String(node?.props?.className ?? '').includes('dsa-session-detail')) return ''
  return (node?.children ?? []).map(faceText).join('')
}

test('a failed card folds from its menu and restores from the closed section', async () => {
  const failed = {
    id: 'r-fail', goal: '回归测试', title: '回归测试', status: 'failed', parentSessionId: 'chat-a',
    report: '断言失败：登录页超时',
  }
  const card = await taskCardHarness({ status: 'completed' }, { selectedGoalId: null },
    { runs: [failed], goals: [] })
  let nodes = card.openRail()
  assert.ok(nodes.some(node => String(node.props?.className ?? '') === 'dsa-session-grid'),
    'the failed run leads the grid')
  const first = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-card')
  first.props.onContextMenu({ preventDefault() {}, clientX: 20, clientY: 30 })
  nodes = card.render()
  card.button(nodes, '关闭卡片').props.onClick()
  nodes = card.render()
  assert.equal(nodes.some(node => String(node.props?.className ?? '') === 'dsa-session-grid'), false,
    'closing clears the failed card from the main grid')
  assert.ok(nodes.some(node => (node.children ?? []).includes('已关闭 1 项')), 'the card folds instead of vanishing')
  const folded = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-card')
  folded.props.onContextMenu({ preventDefault() {}, clientX: 20, clientY: 30 })
  nodes = card.render()
  card.button(nodes, '恢复卡片').props.onClick()
  nodes = card.render()
  assert.ok(nodes.some(node => String(node.props?.className ?? '') === 'dsa-session-grid'),
    'restoring brings the card back')
})

test('right-clicking a card offers jump to session and close', async () => {
  const goal = {
    id: 'g1', goal: '写脚本', title: '写脚本', ownerSessionId: 'chat-a', status: 'running',
    decisions: [], phases: [{ id: 'p1', title: '写脚本', status: 'running', runId: 'r1' }],
  }
  const run = {
    id: 'r1', goal: '写脚本', status: 'running', parentSessionId: 'chat-a',
    subtasks: [{ index: 0, title: '写脚本', status: 'running', childId: 'child-1' }],
  }
  const card = await taskCardHarness(goal, { selectedGoalId: null }, { runs: [run] })
  let nodes = card.openRail()
  const sessionCard = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-card')
  sessionCard.props.onContextMenu({ preventDefault() {}, clientX: 20, clientY: 30 })
  nodes = card.render()
  assert.ok(nodes.some(node => String(node.props?.className ?? '') === 'dsa-card-menu'), 'right click opens a menu')
  assert.ok(card.button(nodes, '关闭卡片'), 'the menu closes the card')
  card.button(nodes, '跳转会话').props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'openSession', sessionId: 'child-1' })
})

test('the card menu also opens from the keyboard, not only from a right click', async () => {
  const goal = { id: 'g1', goal: '写脚本', title: '写脚本', ownerSessionId: 'chat-a', status: 'running', decisions: [], phases: [] }
  const card = await taskCardHarness(goal, { selectedGoalId: null }, { runs: [] })
  const nodes = card.openRail()
  const sessionCard = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-card')
  let prevented = 0
  sessionCard.props.onKeyDown({
    key: 'F10', shiftKey: true, preventDefault() { prevented += 1 },
    currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 200 }) },
  })
  const after = card.render()
  assert.ok(after.some(node => String(node.props?.className ?? '') === 'dsa-card-menu'), 'Shift+F10 opens the same menu')
  assert.equal(prevented, 1)
  assert.equal(sessionCard.children.find(child => child?.props?.className === 'dsa-session-main').props['aria-expanded'], false,
    'the card button is the one disclosure control for its detail')
})

test('a waiting card keeps its question on the face and moves context into the detail', async () => {
  const run = {
    id: 'r-art', goal: '交付', status: 'running', parentSessionId: 'chat-a',
    artifacts: [{ name: 'a.md', href: 'a.md' }],
  }
  const sibling = { id: 'r-other', goal: '另一条', title: '另一条', status: 'running', parentSessionId: 'chat-b' }
  const entry = {
    id: 'r-art:q1', kind: 'question', runId: 'r-art',
    item: { id: 'q1', kind: 'human', question: '需要扫码登录', options: ['answer'] },
  }
  const card = await taskCardHarness({}, { selectedGoalId: null }, {
    goals: [], runs: [run, sibling], inbox: [entry],
    sessionProjects: { 'chat-a': { name: '学习通', cwd: '/work' }, 'chat-b': { name: '另一处', cwd: '/other' } },
  })
  const nodes = card.openRail()
  const session = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-card'
    && deepText(node).includes('需要扫码登录'))
  assert.ok(deepText(session).includes('需要扫码登录'), 'the question stays on the card')
  assert.equal(session.children.some(child => String(child?.props?.className ?? '') === 'dsa-session-links'), false,
    'secondary file links fold away so the fixed card does not clip its footer')
  assert.equal(session.children.some(child => String(child?.props?.className ?? '') === 'dsa-session-foot'), false,
    'project path and close controls stay off the card face')
})

test('a waiting card without a session offers no dead 处理 button', async () => {
  const goal = {
    id: 'goal-empty', goal: '等你决定', title: '等你决定', status: 'needs-decision',
    ownerSessionId: null, decisions: [], phases: [],
  }
  const entry = {
    id: 'g:q1', kind: 'decision', goalId: 'goal-empty',
    item: { id: 'q1', question: '需要你决定', options: ['answer'] },
  }
  const card = await taskCardHarness(goal, { selectedGoalId: null }, { runs: [], inbox: [entry] })
  const nodes = card.openRail()
  const session = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-card')
  const text = deepText(session)
  assert.ok(text.includes('需要你决定'), 'the question is still shown')
  assert.equal(text.includes('处理'), false, 'without an owning session, no dead handle is rendered')
})

test('the header keeps one entry and the todo view lives inside the panel', async () => {
  const card = await taskCardHarness()
  const labels = card.render().filter(node => node.type === 'button')
    .map(node => String(node.props?.['aria-label'] ?? ''))
  assert.ok(labels.includes('任务'), 'the panel expand button is a direct control')
  assert.equal(labels.includes('待办'), false, 'the todo entry no longer competes in the header')
  assert.equal(labels.includes('更多入口'), false, 'no ellipsis menu replaces it either')
})

test('a task card expands its detail in place, and the detail holds the one session entry', async () => {
  const card = await taskCardHarness({}, { selectedGoalId: null })
  let nodes = card.openRail()
  const main = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '查看「空任务」')
  assert.ok(main, 'the card body is the single control for its detail')
  main.props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'openTask', taskId: 'goal-empty' },
    'one click expands the task detail in place instead of leaving the panel')
  nodes = card.render({ selectedGoalId: 'goal-empty' })
  const open = nodes.find(node => node.type === 'button' && (node.children ?? []).includes('打开会话'))
  assert.ok(open, 'the expanded detail offers the conversation as a second step')
  open.props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'openSession', sessionId: 'chat-a' })
})

test('the panel still loads when the host has no workspace service', async () => {
  const card = await taskCardHarness({}, { selectedGoalId: null })
  const nodes = card.openRail()
  const main = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '查看「空任务」')
  assert.ok(main, 'the card stays clickable so the click can explain the missing host')
  assert.doesNotThrow(() => main.props.onClick())
})

test('a long task title stays within 20 characters on the task row', async () => {
  const long = '在当前工作区把发布说明和兼容性检查一起整理成可以交付的版本并通知所有相关的人'
  const card = await taskCardHarness({ title: long, goal: long, status: 'running' })
  const nodes = card.openRail()
  const label = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-title')
  assert.ok(label, 'the session card renders')
  const text = deepText(label).trim()
  assert.ok(text.length > 0 && text.length <= 20, `task row title is ${text.length} characters: ${text}`)
})

test('the rail schedules sessions as cards, two or three per row', async () => {
  const card = await taskCardHarness({
    status: 'running',
    phases: [
      { id: 'p1', title: '整理素材', status: 'running' },
      { id: 'p2', title: '写脚本', status: 'pending' },
      { id: 'p3', title: '剪辑', status: 'pending' },
    ],
  })
  const nodes = card.openRail()
  const grid = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-grid')
  assert.ok(grid, 'sessions share one grid')
  const sessions = nodes.filter(node => String(node.props?.className ?? '') === 'dsa-session-card')
  assert.equal(sessions.length, 3, 'each session phase is its own card')
  assert.ok(!nodes.some(node => String(node.props?.className ?? '') === 'dsa-session-summary'),
    'the rail does not narrate a session count above the cards')
  assert.doesNotMatch(deepText(grid), /正在调度|个需要你/, 'the cards carry the facts, not a summary line')
})

test('a question lives inside the session card that raised it', async () => {
  const question = '学习通需要扫码登录。页面：https://pan.example/login'
  const goal = {
    id: 'g1', goal: '扫码登录', title: '扫码登录', ownerSessionId: 'chat-a', status: 'needs-decision',
    decisions: [], phases: [{ id: 'p1', title: '扫码登录', status: 'needs-decision', runId: 'r1' }],
  }
  const run = { id: 'r1', goal: '扫码登录', status: 'running', parentSessionId: 'chat-a' }
  const entry = {
    id: 'r1:a1', kind: 'question', runId: 'r1',
    item: { id: 'a1', kind: 'human', question, options: ['answer'] },
  }
  const card = await taskCardHarness(goal, { selectedGoalId: null }, { runs: [run], inbox: [entry] })
  const nodes = card.openRail()
  const session = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-card')
  const text = deepText(session)
  assert.match(text, /学习通需要扫码登录/, 'the card states the act itself')
  assert.match(text, /待你决定/)
  assert.doesNotMatch(text, /https:\/\//, 'the page line stays in the detail')
  assert.doesNotMatch(deepText(nodes.find(node => String(node.props?.className ?? '') === 'dsa-task-list') ?? session), /正在调度|个需要你/,
    'the rail lets the card itself say what needs a person')
  const handle = session.children.find(child => child?.props?.className === 'dsa-session-ask')
    .children.find(child => child?.props?.className === 'dsa-session-actions')
    .children.find(child => child?.children?.[0] === '处理')
  handle.props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'openSession', sessionId: 'chat-a' },
    '处理 jumps into the session that raised the question')
})

test('处理 opens the selected phase login inline and submits only its own decision', async () => {
  const phases = [
    { id: 'p1', title: '学习通登录', status: 'needs-decision' },
    { id: 'p2', title: '慕课登录', status: 'needs-decision' },
  ]
  const inbox = [...phases].reverse().map(phase => ({
    id: `g1:${phase.id}`, kind: 'decision', goalId: 'g1', sessionId: 'chat-a',
    item: { id: `decision-${phase.id}`, phaseId: phase.id, question: `请扫码完成${phase.title}`,
      source: { kind: 'human', runtimeVerified: true, headless: true, handoffId: `browser-${phase.id}` } },
  }))
  for (const phase of [...phases].reverse()) {
    const card = await taskCardHarness({ id: 'g1', status: 'needs-decision', phases },
      { selectedGoalId: null }, { inbox })
    const session = card.openRail().find(node => node.props?.className === 'dsa-session-card'
      && deepText(node).includes(`请扫码完成${phase.title}`))
    assert.ok(session, 'the matching phase owns its login even before the run data loads')
    const handle = session.children.find(node => node?.props?.className === 'dsa-session-ask')
      .children.find(node => node?.props?.className === 'dsa-session-actions')
      .children.find(node => node?.children?.[0] === '处理')
    handle.props.onClick()
    const after = card.render()
    assert.equal(after.find(node => node.props?.['data-live-login'])?.props['data-live-login'],
      `goal:g1:decision-${phase.id}`)
    assert.equal(after.some(node => node.props?.id === 'dsa-workbench'), false)
    await card.button(after, '完成').props.onClick()
    assert.deepEqual(card.actions.at(-1), { type: 'goalAction', goalId: 'g1', action: 'answer', owner: 'chat-a',
      body: { decisionId: `decision-${phase.id}`, answer: 'answer', note: '已登录' } })
    assert.equal(card.actions.some(action => action.type === 'openSession'), false)
  }
})

test('the live worker run stays reachable through the expanded detail, not a hover-only arrow', async () => {
  const goal = {
    id: 'g1', goal: '写脚本', title: '写脚本', ownerSessionId: 'chat-a', status: 'running',
    decisions: [], phases: [{ id: 'p1', title: '写脚本', status: 'running', runId: 'r1' }],
  }
  const run = {
    id: 'r1', goal: '写脚本', status: 'running', parentSessionId: 'chat-a',
    subtasks: [{ index: 0, title: '写脚本', status: 'running', childId: 'child-1' }],
  }
  const card = await taskCardHarness(goal, { selectedGoalId: null }, { runs: [run] })
  let nodes = card.openRail()
  assert.equal(nodes.some(node => String(node.props?.className ?? '').includes('dsa-session-open')), false,
    'no button appears only on hover')
  nodes = card.render({ selectedGoalId: 'g1' })
  const open = nodes.find(node => node.type === 'button' && (node.children ?? []).includes('打开会话'))
  assert.ok(open, 'the expanded goal detail keeps one way into the conversation')
  open.props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'openSession', sessionId: 'chat-a' })
})

test('Escape collapses an expanded card before it closes the panel', async () => {
  const card = await taskCardHarness({}, { selectedGoalId: 'goal-empty' })
  const nodes = card.openRail()
  const root = nodes.find(node => node.props?.className === 'dsa-root')
  assert.ok(root?.props?.onKeyDown, 'the panel handles Escape at its root')
  root.props.onKeyDown({ key: 'Escape', defaultPrevented: false, ctrlKey: false, metaKey: false, shiftKey: false })
  assert.deepEqual(card.actions.at(-1), { type: 'focusGoal', goalId: null },
    'Escape only collapses the card, it does not close the whole panel')
})

test('an open card keeps its cell and grows a full-width detail beneath its row', async () => {
  const goal = {
    id: 'goal-empty', goal: '三列任务', title: '三列任务', ownerSessionId: 'chat-a', status: 'running',
    decisions: [],
    phases: [
      { id: 'p1', title: '第一步', status: 'running' },
      { id: 'p2', title: '第二步', status: 'pending' },
      { id: 'p3', title: '第三步', status: 'pending' },
    ],
  }
  const card = await taskCardHarness(goal, { selectedGoalId: null })
  let nodes = card.openRail()
  let grid = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-grid')
  const beforeKeys = grid.children.flat().map(cell => cell.props.key)
  assert.deepEqual(beforeKeys, ['phase:goal-empty:p1', 'phase:goal-empty:p2', 'phase:goal-empty:p3'])
  const first = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '查看「第一步」')
  first.props.onClick()
  nodes = card.render()
  grid = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-grid')
  const cells = grid.children.flat()
  assert.equal(cells.length, 4, 'one full-width detail block joins the grid')
  assert.equal(cells[0].props.key, 'phase:goal-empty:p1', 'the open card stays in its own cell')
  assert.equal(cells[0].props.selected, true, 'the first card is the open one')
  assert.equal(cells[1].props.key, 'phase:goal-empty:p2', 'its row neighbour keeps its cell')
  assert.equal(cells[1].props.selected, false)
  assert.equal(cells[3].props.key, 'phase:goal-empty:p3')
  const detail = cells.find(cell => String(cell.props?.className ?? '') === 'dsa-session-detail')
  assert.ok(detail, 'the detail is a grid item of its own')
  assert.equal(cells.indexOf(detail), 2, 'the detail starts right under the expanded card row')
  assert.equal(detail.props.style.gridColumn, '1 / -1', 'the detail spans the whole row width')
  assert.equal(detail.props['data-open-card'], 'phase:goal-empty:p1', 'the detail belongs to the open card')
  assert.deepEqual(cells.filter(cell => String(cell.props?.className ?? '') !== 'dsa-session-detail').map(cell => cell.props.key),
    beforeKeys, 'no card moved or was reordered')
  const cards = nodes.filter(node => String(node.props?.className ?? '') === 'dsa-session-card')
  assert.equal(cards.filter(node => node.props?.['data-open'] === 'true').length, 1, 'exactly one card is open')

  const list = nodes.find(node => String(node.props?.className ?? '').includes('dsa-task-list'))
  let stopped = 0
  list.props.onKeyDown({ key: 'Escape', defaultPrevented: false, preventDefault() {}, stopPropagation() { stopped += 1 } })
  nodes = card.render()
  grid = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-grid')
  assert.equal(grid.children.flat().length, 3, 'the detail disappears with the open state')
  assert.deepEqual(grid.children.flat().map(cell => cell.props.key), beforeKeys, 'the cards return exactly as they were')
  assert.equal(stopped, 1, 'the panel stays open behind the folded card')
})

test('a run card uses the same full-width detail beneath its row', async () => {
  const runA = {
    id: 'r1', goal: '运行一', title: '运行一', status: 'running', parentSessionId: 'chat-a',
    subtasks: [], attention: [], artifacts: [], report: '第一行结论',
  }
  const runB = {
    id: 'r2', goal: '运行二', title: '运行二', status: 'running', parentSessionId: 'chat-a',
    subtasks: [], attention: [], artifacts: [],
  }
  const card = await taskCardHarness({}, { selectedGoalId: null }, { goals: [], runs: [runA, runB] })
  let nodes = card.openRail()
  assert.equal(nodes.filter(node => String(node.props?.className ?? '') === 'dsa-session-card').length, 2,
    'both runs share the grid')
  const main = nodes.find(node => node.type === 'button' && node.props?.['aria-label'] === '查看「运行一」')
  main.props.onClick()
  assert.equal(card.actions.some(action => action.type === 'openRun'), false,
    'the click expands the card instead of replacing the list with a run page')
  nodes = card.render()
  const grid = nodes.find(node => String(node.props?.className ?? '') === 'dsa-session-grid')
  const cells = grid.children.flat()
  assert.deepEqual(cells.filter(cell => String(cell.props?.className ?? '') !== 'dsa-session-detail').map(cell => cell.props.key),
    ['run:r1', 'run:r2'], 'both run cards keep their cells and order')
  const detail = cells.find(cell => String(cell.props?.className ?? '') === 'dsa-session-detail')
  assert.ok(detail, 'the run detail is its own full-width grid item')
  assert.equal(detail.props.style.gridColumn, '1 / -1')
  const summary = nodes.find(node => String(node.props?.className ?? '').includes('dsa-report-summary'))
  assert.ok(summary && deepText(summary).includes('第一行结论'), 'the report is readable in the full-width detail')
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

test('a receipt names its own phase when two goals reuse p1', async () => {
  const phase = { id: 'p1', title: '核查 PR', status: 'completed', runId: 'pr-run' }
  const goal = { id: 'pr-goal', title: '检查更新', status: 'running', phases: [phase] }
  const other = { id: 'course-goal', title: '课程', status: 'running', phases: [
    { id: 'p1', title: '完成心理健康网课', status: 'running', runId: 'course-run' },
  ] }
  const card = await taskCardHarness({}, {
    messages: [{ id: 'pr-receipt', role: 'assistant', text: '阶段「核查 PR」已交付：四个均已合并。',
      taskId: goal.id, phaseId: phase.id, runId: phase.runId, at: Date.now() }],
  }, { goals: [goal, other] })
  const line = card.render().find(node => node.props?.className === 'dsa-feed-line')
  assert.ok(line)
  assert.match(deepText(line), /^核查 PR：.*四个均已合并/u)
})

test('a retried phase never surfaces its old attempt as a standalone task card', async () => {
  const runs = [
    { id: 'failed-pr', goal: '历史 PR 尝试', goalId: 'goal-empty', status: 'partial' },
    { id: 'legacy-pr', goal: '旧版历史尝试', status: 'partial' },
    { id: 'current-pr', goal: 'PR 验收', goalId: 'goal-empty', status: 'completed' },
    { id: 'unrelated', goal: '独立失败任务', status: 'partial' },
  ]
  const card = await taskCardHarness({
    status: 'running',
    phases: [
      { id: 'p1', title: '核查 PR', status: 'completed', runId: 'current-pr', runIds: ['legacy-pr', 'current-pr'] },
      { id: 'p2', title: '打包试玩版', status: 'running' },
    ],
  }, { selectedGoalId: null }, { runs })
  const labels = card.openRail().filter(node => node.props?.className === 'dsa-session-main')
    .map(node => node.props['aria-label'])
  assert.deepEqual(labels.sort(), ['查看「打包试玩版」', '查看「独立失败任务」'].sort())
})

test('the rail reads failure first, then current work, and never shows a bare ellipsis', async () => {
  const card = await taskCardHarness({ status: 'needs-decision', phases: [
    { id: 'p1', title: '构建试玩版本', status: 'running', runId: 'r1' },
    { id: 'p2', title: '回归测试', status: 'failed', outcome: '端口 4310 被占用' },
  ] }, {}, { runs: [{ id: 'r1', goalId: 'goal-empty', status: 'running', parentSessionId: 'chat-a' }] })
  const nodes = card.openRail()
  const labels = nodes.filter(node => node.type === 'button').map(node => String(node.props?.['aria-label'] ?? ''))
  assert.equal(labels.some(label => label.startsWith('更多操作')), false, 'no bare ellipsis entry in the rail')
  assert.equal(nodes.some(node => node === '现在'), false, 'the current phase needs no 现在 caption')
  const cardText = faceText({ children: nodes.filter(node => String(node.props?.className ?? '').includes('dsa-session-card')) })
  assert.ok(cardText.includes('端口 4310 被占用'), 'the failure reason is on the card')
  assert.equal(cardText.includes('失败：回归测试'), false, 'the failure block does not repeat the title')
  assert.ok(cardText.indexOf('回归测试') < cardText.indexOf('构建试玩版本'),
    'a failure reads before the phase that is running')
})

test('a cancelled goal shows 已取消 even when its phase record still says running', async () => {
  const card = await taskCardHarness({
    status: 'cancelled',
    phases: [{ id: 'p1', title: '新建 naming-check.txt', status: 'running', currentRunId: 'r1', runIds: ['r1'] }],
  }, {}, { runs: [{ id: 'r1', status: 'running', parentSessionId: 'chat-a' }] })
  const nodes = card.openRail()
  const cards = nodes.filter(node => String(node.props?.className ?? '').includes('dsa-session-card'))
  assert.equal(cards.length, 1, 'the stale phase does not add a live card next to the cancelled goal')
  const text = deepText({ children: cards })
  assert.ok(text.includes('已取消'), `the card states the truth: ${text}`)
  assert.equal(text.includes('正在执行'), false, 'a cancelled goal never reads as still running')
  assert.equal(nodes.some(node => String(node.props?.className ?? '').includes('dsa-session-fail')), false,
    'a cancelled goal carries no red failure block')
})

test('a failed session card explains the stop reason in plain Chinese and hides the report ledger', async () => {
  const report = '# Goal not reached — stopped: no progress: the same acceptance condition failed again (a1 failed 3 round(s) in a row)\n\n'
    + 'Goal: This run is phase 1 of 1: Create naming-check.txt Phase objective: 在当前工作区根目录新建空文件 `naming-check.txt`。\n\n'
    + 'Acceptance conditions:\n- FAIL [a1] 当前工作区根目录存在 `naming-check.txt`，且文件大小为 0 字节。'
  const card = await taskCardHarness({ status: 'partial', phases: [] }, {}, {
    runs: [{ id: 'r-partial', status: 'partial', parentSessionId: 'chat-a', report }],
  })
  const nodes = card.openRail()
  const text = deepText({ children: nodes.filter(node => String(node.props?.className ?? '').includes('dsa-session-card')) })
  assert.ok(text.includes('连续几轮没有新进展'), `the card says why in plain Chinese: ${text}`)
  assert.equal(/可打开详情|再点/.test(text), false, 'the card skips the how-to prose')
  assert.ok(/没完成：/.test(text) && text.length < 200, `the failure line stays short: ${text}`)
  assert.equal(text.includes('Goal not reached'), false, 'the agent ledger never reaches the card')
  assert.equal(text.includes('FAIL [a1]'), false, 'a machine-check line never reaches the card')
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
    id: 'inbox-long', kind: 'decision', goalId: 'g1', sessionId: 'chat-a',
    project: { cwd: '/work/one', name: '学习通' },
    title: '特别长的待办标题需要压缩到二十五个字符以内否则就会溢出',
    item: {
      id: 'item-1',
      question: `阶段 p2 的执行 agent 需要你决定：${'这是很长的一段问题描述'.repeat(4)}`,
      options: ['answer', 'skip'], reason: '', source: {},
    },
  }
  const card = await taskCardHarness({}, {}, { inbox: [entry] })
  const nodes = card.render()
  const task = nodes.find(node => String(node.props?.className ?? '') === 'dsa-inbox-msg-task')
  assert.ok(task, 'the conversation todo shows which task raised it')
  assert.ok(deepText(task).length <= 25, `todo task label is ${deepText(task).length} characters`)
  assert.ok(card.button(nodes, '去会话处理'), 'the row can jump into its session')
})

test('the panel speaks in labels, not sentence tails or empty-state filler', async () => {
  const source = await readFile(clientPath, 'utf8')
  for (const phrase of ['当前状态', '任务继续', '还没有', '暂无']) {
    assert.equal(source.includes(phrase), false, `${phrase} must not reach the UI`)
  }
})

const decisionEntry = (item, goalId = 'g1') => ({
  id: `inbox-${item.id}`, kind: 'decision', goalId, title: '发布工作台',
  project: { cwd: '/work/one', name: '演示工作区' }, item,
})

const decisionGoal = (summary = '') => ({
  id: 'g1', title: '发布工作台', goal: '发布工作台', status: 'needs-decision', decisions: [],
  phases: [{ id: 'p2', title: '构建试玩版本', status: 'needs-decision', runId: 'r2', summary }],
})

const openInbox = async (entry, goal, runs) => {
  const card = await taskCardHarness(goal, {}, { inbox: [entry], runs, goals: [goal] })
  return { card, nodes: card.render() }
}

test('a decision is shown together with the thing being decided', async () => {
  const conclusion = '试玩反馈：8 人试玩，6 人认为镜头更清楚；门口空镜偏长，建议再收 0.5 秒。'
  const goal = decisionGoal(conclusion)
  const run = { id: 'r2', status: 'needs-decision', report: '', output: '' }
  const { nodes } = await openInbox(decisionEntry({
    id: 'd2', question: '要接受这版试玩反馈的结论吗？', reason: '三条结论覆盖了本周的全部反馈。',
    source: { runId: 'r2', options: ['accept', 'retry'] }, options: ['accept', 'retry'],
  }), goal, [run])
  const text = nodes.map(deepText).join('\n')
  assert.ok(text.includes(conclusion), 'the conclusion itself is on the card')
  assert.ok(text.includes('构建试玩版本'), 'the deciding phase is named')
  assert.equal(text.includes('阶段 p2'), false, 'internal phase ids never reach the card')
  assert.ok(text.includes('结果已出，等你验收'), 'why a person is needed is in plain words')
  assert.ok(text.includes('三条结论覆盖了本周的全部反馈'), 'the 原因 section has real content')
})

test('missing decision material becomes a failure state with retry, never a bare question', async () => {
  const goal = decisionGoal('')
  const run = { id: 'r2', status: 'needs-decision', report: '', output: '' }
  const { card, nodes } = await openInbox(decisionEntry({
    id: 'd3', question: '要采用这份试玩反馈的结论吗？', reason: '',
    source: { runId: 'r2', options: ['accept', 'retry'] }, options: ['accept', 'retry'],
  }), goal, [run])
  const text = nodes.map(deepText).join('\n')
  assert.ok(text.includes('结论读取失败'), 'the card says the read failed')
  assert.ok(text.includes('缺少阶段结论'), 'the card names the missing data')
  assert.ok(card.button(nodes, '重试'), 'the card offers one retry')
  assert.equal(card.button(nodes, '接受'), undefined, 'no blind decision without material')
  assert.equal(nodes.some(node => (node.children ?? []).includes('原因')), false,
    'a missing reason never renders an empty 原因 entry')
})

test('a decision without a reason hides 原因 but keeps the material', async () => {
  const goal = decisionGoal('性能结论：首屏 1.2 秒，低于 1.5 秒目标。')
  const run = { id: 'r2', status: 'needs-decision', report: '', output: '' }
  const { card, nodes } = await openInbox(decisionEntry({
    id: 'd4', question: '要采用这份性能结论吗？', reason: '',
    source: { runId: 'r2', options: ['accept', 'retry'] }, options: ['accept', 'retry'],
  }), goal, [run])
  const text = nodes.map(deepText).join('\n')
  assert.ok(text.includes('性能结论：首屏 1.2 秒'), 'the material stays visible')
  assert.equal(nodes.some(node => (node.children ?? []).includes('原因')), false,
    'no reason data means no 原因 entry')
  assert.ok(card.button(nodes, '接受'), 'the decision is still actionable')
})

test('an ordinary question shows the run result instead of only the question', async () => {
  const goal = { id: 'g1', title: '发布工作台', goal: '发布工作台', status: 'running', decisions: [], phases: [] }
  const run = { id: 'r2', status: 'needs-decision', report: '兼容性结论：3 个浏览器全部通过。', output: '' }
  const { nodes } = await openInbox({
    id: 'run:r2:a1', kind: 'question', runId: 'r2', title: '构建试玩版本',
    project: { cwd: '/work/one', name: '演示工作区' },
    item: { id: 'a1', question: '要采用这份兼容性结论吗？', options: ['accept'], reason: '' },
  }, goal, [run])
  const text = nodes.map(deepText).join('\n')
  assert.ok(text.includes('兼容性结论：3 个浏览器全部通过。'), 'the run result is the material')
  assert.ok(!text.includes('结论读取失败'), 'a readable run never becomes a failure state')
})

test('a human hand-off without a reason hides the 原因 entry', async () => {
  const goal = decisionGoal('')
  const { nodes } = await openInbox(decisionEntry({
    id: 'd5', question: '学习通需要扫码登录。', reason: '',
    source: { kind: 'human', runtimeVerified: true }, options: ['answer', 'stop'],
  }), goal, [])
  assert.equal(nodes.some(node => (node.children ?? []).includes('原因')), false,
    'no empty 原因 shell on the hand-off card')
})

test('a queued message says it is waiting instead of looking delivered', async () => {
  const at = Date.now()
  const card = await taskCardHarness({}, {
    messages: [{ id: 'cmd-queued', role: 'user', text: '我学习通上有新的作业，你帮我做掉。', at }],
    routerCommands: [{ id: 'cmd-queued', text: '我学习通上有新的作业，你帮我做掉。', at }],
  })
  const nodes = card.render()
  const state = nodes.find(node => String(node.props?.className ?? '') === 'dsa-user-state')
  assert.ok(state, 'a message still in the router queue carries a state line')
  assert.match(deepText(state), /排队中/)
  assert.notEqual(state.props?.['data-stale'], 'true')
})

test('a message queued too long admits it may never have been accepted', async () => {
  const at = Date.now() - 120_000
  const card = await taskCardHarness({}, {
    messages: [{ id: 'cmd-stale', role: 'user', text: '顺便帮我想一下晚饭吃什么。', at }],
    routerCommands: [{ id: 'cmd-stale', text: '顺便帮我想一下晚饭吃什么。', at }],
  })
  const nodes = card.render()
  const state = nodes.find(node => String(node.props?.className ?? '') === 'dsa-user-state')
  assert.ok(state, 'the stale queue keeps its state line')
  assert.equal(state.props?.['data-stale'], 'true')
  assert.match(deepText(state), /可能没有被受理/)
})

test('a failed task card states the reason and offers a way in', async () => {
  const card = await taskCardHarness({
    status: 'failed', reason: '慕课登录态失效', phases: [
      { id: 'p1', title: '刷完心理网课', status: 'failed' },
    ],
  }, {
    messages: [{ id: 'feed-fail', role: 'assistant', text: '任务失败', taskId: 'goal-empty' }],
  })
  const nodes = card.render()
  const failed = nodes.find(node => String(node.props?.className ?? '') === 'dsa-task-failed')
  assert.ok(failed, 'the failed row keeps a failure block')
  const text = deepText(failed)
  assert.match(text, /失败：刷完心理网课/)
  assert.match(text, /慕课登录态失效/, 'the reason reaches the row, not only the rail')
  const handle = nodes.find(node => node.type === 'button' && (node.children ?? []).includes('打开任务处理'))
  assert.ok(handle, 'a failed row offers an entry instead of dead-ending')
  handle.props.onClick()
  assert.deepEqual(card.actions.at(-1), { type: 'openTask', taskId: 'goal-empty' })
})
