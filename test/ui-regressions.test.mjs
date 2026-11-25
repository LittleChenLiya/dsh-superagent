import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const publicUrl = name => new URL(`../public/${name}`, import.meta.url)

class ClassList {
  constructor() { this.values = new Set() }
  add(...names) { for (const name of names) this.values.add(name) }
  remove(...names) { for (const name of names) this.values.delete(name) }
  contains(name) { return this.values.has(name) }
  toggle(name, force) {
    const on = force === undefined ? !this.values.has(name) : Boolean(force)
    if (on) this.values.add(name)
    else this.values.delete(name)
    return on
  }
}

class Element {
  constructor(tag = 'div', document = null) {
    this.tagName = tag.toUpperCase()
    this.document = document
    this.children = []
    this.dataset = {}
    this.style = {}
    this.classList = new ClassList()
    this.listeners = new Map()
    this.attributes = new Map()
    this.value = ''
    this.textContent = ''
    this.hidden = false
    this.disabled = false
    this.className = ''
    this._html = ''
    this.innerHTMLWrites = 0
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
  }
  get innerHTML() { return this._html }
  set innerHTML(value) {
    this._html = String(value)
    this.innerHTMLWrites += 1
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event })
  }
  append(...nodes) { this.children.push(...nodes) }
  appendChild(node) { this.children.push(node); return node }
  remove() {}
  replaceWith() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  matches(selector) {
    if (selector === '[data-answer]') return Boolean(this.dataset.answer)
    if (selector === '[data-param]') return Boolean(this.dataset.param)
    return false
  }
  closest(selector) { return this.matches(selector) ? this : null }
  contains(node) { return this._containsActive === true || node === this || this.children.includes(node) }
  querySelector() { return null }
  querySelectorAll() { return [] }
  focus() { if (this.document) this.document.activeElement = this }
  blur() { if (this.document?.activeElement === this) this.document.activeElement = null }
  scrollIntoView() {}
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
}

function fakeDocument(ids = []) {
  const elements = new Map()
  const document = {
    activeElement: null,
    body: new Element('body'),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element('div', document))
      return elements.get(id)
    },
    createElement(tag) { return new Element(tag, document) },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener() {},
  }
  for (const id of ids) document.getElementById(id)
  return document
}

function pageScript(name) {
  return fsp.readFile(publicUrl(name), 'utf8').then(html => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    assert.ok(scripts.length, `${name} must contain its page script`)
    return { html, script: scripts.at(-1)[1].replace(/\r\n/g, '\n') }
  })
}

function withoutBoot(script, exports) {
  const marker = '\n  boot();\n})();'
  assert.ok(script.includes(marker), 'the page script must keep its boot call at the end')
  return script.replace(marker, `\n  globalThis.__test = {${exports}};\n})();`)
}

function contextFor(document, overrides = {}) {
  const sessionStorage = storage()
  const localStorage = storage()
  const location = { href: 'http://127.0.0.1/', search: '', pathname: '/' }
  const history = { replaceState() {} }
  const context = {
    document,
    sessionStorage,
    localStorage,
    location,
    history,
    window: { location, history, innerWidth: 1280 },
    URL,
    URLSearchParams,
    CSS: { escape: value => String(value).replace(/["\\]/g, '\\$&') },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    confirm: () => true,
    navigator: {},
    console,
    fetch: async () => { throw new Error('unexpected fetch') },
    ...overrides,
  }
  vm.createContext(context)
  return context
}

function response(data, { status = 200, payload } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload ?? { ok: status >= 200 && status < 300, data },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function loadWorkbench(overrides = {}) {
  const { script } = await pageScript('workbench.html')
  const document = fakeDocument([
    'editor', 'dirty', 'previewBtn', 'saveBtn', 'crumbs', 'fileMeta', 'notice',
    'confirm', 'sideTitle', 'sideBody', 'toast', 'conn', 'connText',
  ])
  const context = contextFor(document, overrides)
  vm.runInContext(withoutBoot(script, 'state, openFile, previewCurrent, saveCurrent, updateDirty'), context)
  return { ui: context.__test, document }
}

async function loadConsoleMessageHarness(overrides = {}) {
  const { script } = await pageScript('console.html')
  const frameStart = script.indexOf('  function handleFrame(frame) {')
  const frameEnd = script.indexOf('  function upsertTool', frameStart)
  const sendStart = script.indexOf('  async function sendMessage() {')
  const sendEnd = script.indexOf('  async function newConversation()', sendStart)
  assert.ok(frameStart >= 0 && frameEnd > frameStart && sendStart >= 0 && sendEnd > sendStart)
  const messages = []
  const STATE = {
    messages, currentAssistant: null, toolCalls: new Map(), approvals: new Map(), cancelRequested: new Set(),
    messageSeq: 0, sending: false, router: false, mode: 'chat', sessionId: 'session-a', sendMode: 'queue',
  }
  const inputEl = new Element('textarea')
  inputEl.value = 'hello'
  const sandbox = {
    STATE, inputEl,
    contentText: content => typeof content === 'string' ? content : (content ?? []).map(part => part.text).join(''),
    addMessage(role, text, options = {}) {
      const message = { id: `m${++STATE.messageSeq}`, role, text, at: options.at ?? Date.now(), ...options }
      messages.push(message)
      return message
    },
    refreshMessage() {}, removeEmpty() {}, setTyping() {}, autoGrow() {}, updateSend() {}, pushToast() {},
    ...overrides,
  }
  vm.createContext(sandbox)
  vm.runInContext(`${script.slice(frameStart, frameEnd)}\n${script.slice(sendStart, sendEnd)}
    globalThis.__test = { handleFrame, handleSessionEvent, sendMessage }`, sandbox)
  return { ui: sandbox.__test, STATE, messages, inputEl }
}

async function loadBoard(overrides = {}) {
  const { script } = await pageScript('board.html')
  const document = fakeDocument([
    'gate', 'shell', 'gate-err', 'gate-token', 'toast', 'inbox', 'tpl-grid',
    'tpl-form-panel', 'tpl-form-title', 'tpl-purpose', 'tpl-fields', 'tpl-start',
    'tpl-note', 'modal-title', 'modal-body', 'modal',
  ])
  const context = contextFor(document, overrides)
  vm.runInContext(withoutBoot(script, [
    'state', 'readToken', 'api', 'renderInbox', 'renderTemplateForm', 'showReport', 'cardHtml', 'sendInbox',
  ].join(', ')), context)
  return { ui: context.__test, document, context, script }
}

test('workbench disables the editor while saving and does not mark newer text saved', async () => {
  const pending = deferred()
  let requestBody
  let requests = 0
  const { ui, document } = await loadWorkbench({
    fetch: async (_route, options) => {
      requests += 1
      requestBody = JSON.parse(options.body)
      return pending.promise
    },
  })
  const editor = document.getElementById('editor')
  ui.state.file = { path: 'a.txt', content: 'one', hash: 'old', mtimeMs: 1, size: 3, readOnly: false, eol: 'lf' }
  editor.value = 'two'
  ui.state.confirmVersion = ui.state.editorVersion
  ui.state.confirmFile = ui.state.file
  document.getElementById('confirm').hidden = false
  ui.updateDirty()

  const saving = ui.saveCurrent()
  assert.equal(editor.disabled, true, 'the editor must be locked for the whole save request')
  assert.equal(document.getElementById('saveBtn').disabled, true)
  assert.equal(document.getElementById('confirmSave').disabled, true)
  await ui.saveCurrent()
  assert.equal(requests, 1, 'a double click must not issue a second save')
  assert.deepEqual(requestBody, { path: 'a.txt', content: 'two', expectedHash: 'old', expectedMtimeMs: 1 })

  editor.value = 'three'
  editor.dispatch('input')
  pending.resolve(response({ hash: 'new', mtimeMs: 2, size: 5, path: 'a.txt' }))
  await saving

  assert.equal(editor.value, 'three')
  assert.equal(editor.disabled, false)
  assert.equal(ui.state.dirty, true, 'an old save response must not claim the newer editor text is saved')
  assert.equal(document.getElementById('dirty').textContent, '有未保存改动')
})

test('workbench ignores a slow file response that finishes after the latest selection', async () => {
  const first = deferred()
  const second = deferred()
  const { ui } = await loadWorkbench({
    fetch: route => route.includes('first.txt') ? first.promise : second.promise,
  })

  const openingFirst = ui.openFile('first.txt')
  const openingSecond = ui.openFile('second.txt')
  second.resolve(response({ path: 'second.txt', content: 'second', hash: '2', mtimeMs: 2, size: 6 }))
  await openingSecond
  first.resolve(response({ path: 'first.txt', content: 'first', hash: '1', mtimeMs: 1, size: 5 }))
  await openingFirst

  assert.equal(ui.state.file.path, 'second.txt')
  assert.equal(ui.state.file.content, 'second')
})

test('workbench drops a diff response after the user switches files', async () => {
  const preview = deferred()
  const opening = deferred()
  const { ui, document } = await loadWorkbench({
    fetch: route => route === '/api/preview' ? preview.promise : opening.promise,
  })
  ui.state.file = { path: 'a.txt', content: 'one', readOnly: false, eol: 'lf' }
  document.getElementById('editor').value = 'two'
  const previewing = ui.previewCurrent(true)
  const switching = ui.openFile('b.txt')
  opening.resolve(response({ path: 'b.txt', content: 'second', hash: '2', mtimeMs: 2, size: 6 }))
  await switching
  preview.resolve(response({ identical: false, stats: { added: 1, removed: 1 }, diff: '+two\n-one' }))

  assert.equal(await previewing, false)
  assert.equal(ui.state.file.path, 'b.txt')
  assert.equal(document.getElementById('confirm').hidden, true,
    'an old file diff must not reopen the save confirmation')
  assert.equal(document.getElementById('confirmDiff').textContent, '')
  assert.equal(ui.state.busy, false)
})

test('workbench drops a diff response after the editor text changes', async () => {
  const preview = deferred()
  const { ui, document } = await loadWorkbench({ fetch: async () => preview.promise })
  ui.state.file = { path: 'a.txt', content: 'one', readOnly: false, eol: 'lf' }
  document.getElementById('editor').value = 'two'
  document.getElementById('confirm').hidden = true
  const previewing = ui.previewCurrent(true)
  document.getElementById('editor').value = 'three'
  document.getElementById('editor').dispatch('input')
  preview.resolve(response({ identical: false, stats: { added: 1, removed: 1 }, diff: '+two\n-one' }))

  assert.equal(await previewing, false)
  assert.equal(document.getElementById('confirm').hidden, true,
    'a diff for older editor text must not authorize saving newer text')
  assert.equal(ui.state.dirty, true)
  assert.equal(ui.state.busy, false)
})

test('workbench revokes a save confirmation as soon as the editor changes', async () => {
  const { ui, document } = await loadWorkbench({
    fetch: async () => response({ identical: false, stats: { added: 1, removed: 1 }, diff: '+two\n-one' }),
  })
  ui.state.file = { path: 'a.txt', content: 'one', hash: 'old', mtimeMs: 1, readOnly: false }
  document.getElementById('editor').value = 'two'
  await ui.previewCurrent(true)
  assert.equal(document.getElementById('confirm').hidden, false)

  document.getElementById('editor').value = 'three'
  document.getElementById('editor').dispatch('input')
  assert.equal(document.getElementById('confirm').hidden, true)
  await ui.saveCurrent()
  assert.equal(ui.state.file.content, 'one', 'a revoked confirmation must not save newer text')
})

test('workbench asks before discarding dirty text and cancellation performs no read', async () => {
  let reads = 0
  const { ui, document } = await loadWorkbench({
    confirm: () => false,
    fetch: async () => { reads += 1; return response({}) },
  })
  document.getElementById('editor').value = 'unsaved'
  ui.state.file = { path: 'a.txt', content: 'saved', readOnly: false }
  ui.state.dirty = true

  await ui.openFile('b.txt')
  assert.equal(reads, 0, 'cancelling the discard prompt must not start a file request')
  assert.equal(ui.state.file.path, 'a.txt')
  assert.equal(document.getElementById('editor').value, 'unsaved')
})

test('workbench narrow layout keeps editor actions inside the viewport', async () => {
  const { html } = await pageScript('workbench.html')
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?grid-template-columns: 132px minmax\(0, 1fr\)/)
  assert.match(html, /@media \(max-width: 600px\)[\s\S]*?\.editor-actions \{ flex-wrap: wrap/)
})

test('board hides the token gate after a successful connection', async () => {
  const { html } = await pageScript('board.html')
  assert.match(html, /\.gate\[hidden\] \{ display: none; \}/)
})

test('board keeps token state in sessionStorage and clears it on 401 or 403', async () => {
  const { ui, context } = await loadBoard()
  context.localStorage.setItem('dsh.board.token', 'legacy-token')
  context.location.href = 'http://127.0.0.1/?token=session-token'
  assert.equal(ui.readToken(), 'session-token')
  assert.equal(context.localStorage.getItem('dsh.board.token'), null, 'the legacy persistent token must be removed')
  assert.equal(context.sessionStorage.getItem('dsh.board.token'), 'session-token')
  assert.equal(context.localStorage.getItem('dsh.board.token'), null)

  for (const status of [401, 403]) {
    context.sessionStorage.setItem('dsh.board.token', 'session-token')
    context.fetch = async () => response(null, {
      status,
      payload: { ok: false, error: { id: status === 401 ? 'unauthorized' : 'forbidden', summary: 'denied' } },
    })
    await assert.rejects(ui.api('/api/board/state'))
    assert.equal(context.sessionStorage.getItem('dsh.board.token'), null, `HTTP ${status} must clear the session token`)
  }
})

test('board preserves inbox drafts and does not replace a field while it is being edited', async () => {
  const { ui, document, script } = await loadBoard()
  const root = document.getElementById('inbox')
  const item = {
    id: 'question:r:q', kind: 'question', kindLabel: '需要回答', title: 'Choose',
    what: 'Pick one', why: 'A choice is needed', impact: 'The run continues', options: ['A', 'B'],
  }
  ui.state.snapshot = { inbox: [item] }
  ui.state.inboxDraft.set(item.id, { text: 'my unfinished answer', choice: 'A' })
  ui.renderInbox()
  assert.match(root.innerHTML, /my unfinished answer/)
  assert.match(root.innerHTML, /data-answer="question:r:q"/)
  assert.match(script, /addEventListener\('input'[\s\S]*?inboxDraft\.set/, 'typing must update the draft state')
  assert.match(script, /active\.dataset\.answer \|\| active\.dataset\.item \|\| active\.dataset\.send/, 'a focused submit button must also defer redraw')
  assert.match(script, /querySelectorAll\('\[data-send\]'\)[\s\S]*?addEventListener\('blur', flushPending\)/, 'leaving the submit button must release a deferred redraw')

  const writes = root.innerHTMLWrites
  ui.renderInbox()
  assert.equal(root.innerHTMLWrites, writes, 'an unchanged snapshot must not rebuild the inbox')

  const active = new Element('textarea', document)
  active.dataset.answer = item.id
  document.activeElement = active
  root._containsActive = true
  ui.state.snapshot = { inbox: [{ ...item, title: 'Choose updated' }] }
  ui.renderInbox()
  assert.equal(root.innerHTMLWrites, writes, 'a changed snapshot must defer rendering while the answer field has focus')
  assert.equal(document.activeElement, active)
})

test('board removes a submitted inbox item without waiting for another snapshot', async () => {
  const item = { id: 'q1', kind: 'question', title: 'Choose', options: ['yes'] }
  const { ui } = await loadBoard({
    fetch: async (_route, options) => options.method === 'POST'
      ? response({ message: 'ok' })
      : response({ inbox: [item], templates: [], runs: [], capabilities: { start: true, answer: true } }),
  })
  ui.state.snapshot = { inbox: [item] }
  ui.state.inboxDraft.set('q1', { choice: 'yes' })

  await ui.sendInbox('q1')

  assert.deepEqual(ui.state.snapshot.inbox, [])
  assert.equal(ui.state.inboxDraft.has('q1'), false)
})

test('board reuses template fields across snapshots and restores per-template drafts', async () => {
  const { ui, document } = await loadBoard()
  const fields = document.getElementById('tpl-fields')
  const template = {
    id: 'fix', title: 'Fix', purpose: 'Repair', estimate: 2,
    params: [{ name: 'symptom', label: 'Symptom', hint: 'What broke', description: '' }],
  }
  ui.state.snapshot = { templates: [template], capabilities: { start: true } }
  ui.state.templateId = 'fix'
  ui.state.templateDrafts.set('fix', { symptom: 'login crashes' })
  ui.renderTemplateForm()
  assert.match(fields.innerHTML, /login crashes/)

  const writes = fields.innerHTMLWrites
  ui.state.snapshot = { templates: [{ ...template, title: 'Fix updated' }], capabilities: { start: true } }
  ui.renderTemplateForm()
  assert.equal(fields.innerHTMLWrites, writes, 'a live snapshot must not replace template inputs')
  assert.equal(document.getElementById('tpl-form-title').textContent, 'Fix updated')
})

test('board shows dependency titles instead of internal subtask keys', async () => {
  const { ui } = await loadBoard()
  const run = {
    id: 'r',
    subtasks: [
      { key: 'w1', index: 1, title: '读取崩溃日志', status: 'completed', statusLabel: '已完成', dependsOn: [], waitingOn: [] },
      { key: 'w2', index: 2, title: '复现并修复', status: 'waiting', statusLabel: '等待', dependsOn: ['w1'], waitingOn: ['w1'] },
    ],
  }
  const html = ui.cardHtml(run, run.subtasks[1], {})
  assert.match(html, /依赖 读取崩溃日志/)
  assert.match(html, /等待 读取崩溃日志/)
  assert.doesNotMatch(html, /依赖 w1|等待 w1/)
})

test('board report click reads detail only when absent and otherwise shows an empty state', async () => {
  const { ui } = await loadBoard()
  let reads = 0
  const modals = []
  ui.state.detail = { run: { id: 'r' }, report: null }
  const originalLoad = () => { reads += 1; return new Promise(() => {}) }
  const source = await pageScript('board.html')
  const fn = source.script.match(/  async function showReport\(runId\) \{[\s\S]*?\n  \}/)
    || source.script.match(/  function showReport\(runId\) \{[\s\S]*?\n  \}/)
  assert.ok(fn)
  const sandbox = {
    state: ui.state,
    loadDetail: originalLoad,
    openModal: (...args) => modals.push(args),
  }
  vm.createContext(sandbox)
  vm.runInContext(`${fn[0]}\nglobalThis.showReport = showReport`, sandbox)
  await sandbox.showReport('r')
  assert.equal(reads, 0, 'a loaded detail with no report must not trigger another read')
  assert.equal(modals.length, 1)
  assert.match(modals[0][1], /还没有最终报告|没有最终报告/)
})

test('console keeps an optimistic message pending after accepted until the authoritative user event', async () => {
  const { ui, messages } = await loadConsoleMessageHarness()
  const optimistic = { id: 'm1', role: 'user', text: 'hello', pending: true, at: Date.now() }
  messages.push(optimistic)

  ui.handleFrame({ type: 'accepted', text: 'hello' })
  assert.equal(optimistic.pending, true, 'an acceptance frame is not the authoritative transcript event')
  ui.handleSessionEvent({ type: 'user/message', time: Date.now(), data: { content: [{ type: 'text', text: 'hello' }] } })

  assert.equal(messages.length, 1, 'the late user/message event must settle the optimistic row, not duplicate it')
  assert.equal(optimistic.pending, false)
})

test('console keeps an optimistic message pending when the send response beats the user event', async () => {
  const pending = deferred()
  const { ui, messages } = await loadConsoleMessageHarness({ api: async () => pending.promise })
  const sending = ui.sendMessage()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].pending, true)
  pending.resolve(response({ accepted: true }))
  await sending

  assert.equal(messages[0].pending, true, 'the POST response must not settle the row before user/message')
  ui.handleSessionEvent({ type: 'user/message', time: Date.now(), data: { content: [{ type: 'text', text: 'hello' }] } })
  assert.equal(messages.length, 1, 'a late authoritative event must not append a duplicate')
  assert.equal(messages[0].pending, false)
})

test('console exposes a current-generation stop that calls the session cancel endpoint', async () => {
  const { html, script } = await pageScript('console.html')
  assert.ok(html.includes('id="stopCurrent"'), 'the current-generation stop button must exist')
  assert.ok(html.includes('停止全部任务线'), 'the background stop button must say what it stops')
  assert.ok(script.includes("stopCurrentEl.addEventListener('click', stopCurrentGeneration)"), 'the current stop button must be wired')

  const block = script.match(/  function syncStop[\s\S]*?(?=  function stepLabel)/)
  assert.ok(block)
  const calls = []
  const sandbox = {
    STATE: {
      sessionId: 'session-console', mode: 'chat', router: false, running: true,
      stopCurrentBusy: false, stopCurrentRequested: false,
      stopAllBusy: false, runs: [{ id: 'background-1', status: 'running' }], cancelRequested: new Set(),
    },
    stopCurrentEl: new Element('button'),
    stopAllEl: new Element('button'),
    isTerminal: status => ['completed', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(status),
    api: async (route, options) => { calls.push({ route, body: options.body }) },
    renderLanes() {},
    pushToast() {},
    messageOf: error => error.message,
  }
  vm.createContext(sandbox)
  vm.runInContext(`${block[0]}\nglobalThis.__test = {
    stopCurrentGeneration: typeof stopCurrentGeneration === 'function' ? stopCurrentGeneration : null,
    stopAllRuns,
    syncStopControls: typeof syncStopControls === 'function' ? syncStopControls : null,
  }`, sandbox)
  assert.equal(typeof sandbox.__test.stopCurrentGeneration, 'function')
  await sandbox.__test.stopCurrentGeneration()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].route, '/api/console/cancel')
  assert.equal(calls[0].body.sessionId, 'session-console')
})

test('console ignores a stop response from an older session', async () => {
  const { script } = await pageScript('console.html')
  const block = script.match(/  function syncStop[\s\S]*?(?=  function stepLabel)/)
  assert.ok(block)
  const pending = deferred()
  const sandbox = {
    STATE: {
      sessionId: 'old-session', mode: 'chat', router: false, running: true,
      stopCurrentBusy: false, stopCurrentRequested: false, stopCurrentSeq: 0,
      stopAllBusy: false, runs: [], cancelRequested: new Set(),
    },
    stopCurrentEl: new Element('button'),
    stopAllEl: new Element('button'),
    isTerminal: status => ['completed', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(status),
    api: async () => pending.promise,
    renderLanes() {},
    pushToast() {},
    messageOf: error => error.message,
  }
  vm.createContext(sandbox)
  vm.runInContext(`${block[0]}\nglobalThis.stopCurrentGeneration = stopCurrentGeneration`, sandbox)
  const stopping = sandbox.stopCurrentGeneration()
  sandbox.STATE.sessionId = 'new-session'
  sandbox.STATE.stopCurrentRequested = false
  sandbox.STATE.stopCurrentBusy = false
  sandbox.STATE.stopCurrentSeq += 1
  pending.resolve(response({ accepted: true }))
  await stopping

  assert.equal(sandbox.STATE.stopCurrentRequested, false)
  assert.equal(sandbox.STATE.stopCurrentBusy, false)
})

test('console keeps the background task-line stop separate from current generation', async () => {
  const { script } = await pageScript('console.html')
  const block = script.match(/  function syncStop[\s\S]*?(?=  function stepLabel)/)
  assert.ok(block)
  const calls = []
  const sandbox = {
    STATE: {
      mode: 'chat', router: false, running: true, stopCurrentBusy: false, stopCurrentRequested: false,
      stopAllBusy: false,
      runs: [{ id: 'background-1', status: 'running' }, { id: 'background-2', status: 'queued' }],
      cancelRequested: new Set(),
    },
    stopCurrentEl: new Element('button'),
    stopAllEl: new Element('button'),
    isTerminal: status => ['completed', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(status),
    api: async route => { calls.push(route) },
    renderLanes() {},
    pushToast() {},
    messageOf: error => error.message,
  }
  vm.createContext(sandbox)
  vm.runInContext(`${block[0]}\nglobalThis.stopAllRuns = stopAllRuns`, sandbox)
  await sandbox.stopAllRuns()
  assert.deepEqual(calls, [
    '/api/console/runs/background-1/cancel',
    '/api/console/runs/background-2/cancel',
  ])
})
