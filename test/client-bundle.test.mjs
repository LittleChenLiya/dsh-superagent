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
  assert.equal(note.children[0], '正在连接 Superagent 专属空间…')

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
    messages: [{ id: 'receipt', role: 'assistant', text: '已接下任务', taskId: goal.id, at: Date.now() }],
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
  button(initial, first.goal).props.onClick()
  const nodes = render()
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
  button(render(), '待办').props.onClick()
  const inbox = render({ inboxOpen: true })
  assert.equal(inbox.some(node => node.children.includes('暂无待处理事项')), true)
  assert.equal(inbox.find(node => node.props?.['aria-label'] === '任务列表')?.props.hidden, true,
    'the task list stays mounted so its search can survive a view change')
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
    const tasks = render().find(node => node.type === 'button' && node.props?.['aria-label'] === '任务')
    assert.ok(tasks, 'the header offers the task view')
    tasks.props.onClick()
    return render()
  }
  const button = (nodes, label) => nodes.find(node => node.type === 'button' && (node.children ?? []).includes(label))
  const composer = nodes => nodes.find(node => node.type === 'textarea')
  const hint = (nodes, name) => nodes.find(node => String(node.props?.className ?? '').includes(name))?.children?.[0]
  return { render, openRail, actions, goal, button, composer, hint }
}

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

test('the task card separates current decisions from sources and evidence, and labels a receipt', async () => {
  const at = Date.now()
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
