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
  // A phase receipt is a different button from a whole-task receipt: clicking
  // it must open that phase's execution evidence.
  const withPhase = render()
  const phaseButton = withPhase.find(node => node.type === 'button'
    && node.props?.title === '打开阶段 p1 的执行证据')
  assert.ok(phaseButton, 'the phase receipt offers its own evidence entry')
  phaseButton.props.onClick()
  assert.equal(actions.at(-1).type, 'openReceipt')
  assert.equal(actions.at(-1).message.runId, first.id)
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
  card.render().find(node => node.type === 'button' && (node.children ?? []).includes('待办')).props.onClick()
  const nodes = card.render({ inboxOpen: true })
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
    assert.match(css, /\.dsa-receipt-copy strong\{[^}]*overflow-wrap:anywhere/u)
    assert.match(css, /\.dsa-answer-row\{[^}]*flex-wrap:wrap/u,
      'todo buttons and the answer field must wrap instead of overflowing')
    assert.match(css, /\.dsa-answer-row > button\{[^}]*max-width:100%[^}]*min-width:0/u)
    assert.match(css, /\.dsa-answer-input\{[^}]*box-sizing:border-box/u)
    assert.doesNotMatch(css, /\.dsa-task-receipt[^}]*display:none/u,
      'a narrow panel must not hide the receipt')
    assert.doesNotMatch(css, /\.dsa-answer-row > button[^}]*display:none/u,
      'a narrow panel must not hide a todo action')
  } finally {
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})
