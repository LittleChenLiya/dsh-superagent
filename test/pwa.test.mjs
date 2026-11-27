import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const read = name => fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')
const origin = 'http://127.0.0.1:3200'
const deviceToken = `dsm_${'a'.repeat(43)}`

function json(data, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mobileScript(html) {
  const start = html.indexOf('<script>') + '<script>'.length
  return html.slice(start, html.indexOf('</script>', start))
}

function createMobile(fetchImpl, { token = '', online = true } = {}) {
  const html = readFileSync(new URL('../public/mobile.html', import.meta.url), 'utf8')
  const elements = new Map()
  const listeners = new Map()
  const storage = new Map(token ? [['superagent.mobile.token', token]] : [])
  const requests = []

  class Element {
    constructor(tagName, id = '') {
      this.tagName = tagName.toUpperCase()
      this.id = id
      this.children = []
      this.dataset = {}
      this.attributes = {}
      this.listeners = new Map()
      this.className = ''
      this.hidden = false
      this.disabled = false
      this.value = ''
      this.textContent = ''
      this.scrollTop = 0
      this.scrollHeight = 0
      this.tabIndex = 0
    }
    append(...nodes) { this.children.push(...nodes) }
    replaceChildren(...nodes) { this.textContent = ''; this.children = [...nodes] }
    setAttribute(name, value) { this.attributes[name] = String(value) }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(listener)
    }
    async dispatch(type, extras = {}) {
      const event = { type, target: this, preventDefault() {}, ...extras }
      await Promise.all((this.listeners.get(type) || []).map(listener => listener(event)))
    }
    querySelectorAll(selector) {
      const wanted = selector.toLowerCase()
      return this.children.flatMap(child => [
        ...(child.tagName.toLowerCase() === wanted ? [child] : []),
        ...child.querySelectorAll(selector),
      ])
    }
    focus() {}
    scrollTo() {}
    get textContent() {
      return this.children.length ? this.children.map(child => child.textContent).join('') : this._text
    }
    set textContent(value) { this.children = []; this._text = String(value) }
  }

  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1], match[2])
    element.hidden = /\bhidden\b/.test(match[0])
    element.disabled = /\bdisabled\b/.test(match[0])
    elements.set(match[2], element)
  }
  const tabs = elements.get('tabs')
  const document = {
    documentElement: { dataset: {} },
    hidden: false,
    getElementById(id) { return elements.get(id) || null },
    createElement(tag) { return new Element(tag) },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(listener)
    },
  }
  const windowListeners = new Map()
  const window = {
    matchMedia() { return { matches: false } },
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, [])
      windowListeners.get(type).push(listener)
    },
  }
  const location = { search: '', hash: '#chat' }
  const sessionStorage = {
    getItem(key) { return storage.get(key) ?? null },
    setItem(key, value) { storage.set(key, String(value)) },
    removeItem(key) { storage.delete(key) },
  }
  const forbiddenStorage = new Proxy({}, {
    get() { throw new Error('persistent storage is forbidden') },
    set() { throw new Error('persistent storage is forbidden') },
  })
  const context = vm.createContext({
    document, window, location, sessionStorage,
    localStorage: forbiddenStorage,
    history: { replaceState(_state, _title, hash) { location.hash = hash } },
    navigator: { onLine: online },
    URL, URLSearchParams, Response, Headers, AbortController, TextDecoder,
    setTimeout, clearTimeout,
    setInterval() { return 1 },
    clearInterval() {},
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), ...options })
      return fetchImpl(String(url), options)
    },
    console,
  })
  vm.runInContext(mobileScript(html), context, { filename: 'mobile.html' })
  return { context, elements, storage, requests, window, document, listeners }
}


function basicResponse(body = 'ok', init = {}) {
  const response = new Response(body, init)
  Object.defineProperty(response, 'type', { value: 'basic' })
  return response
}

function createServiceWorker(fetchImpl) {
  const listeners = new Map()
  const entries = new Map()
  const puts = []
  const deleted = []
  const messages = []
  const keyOf = request => typeof request === 'string' ? new URL(request, origin).href : request.url
  const cache = {
    async put(request, response) {
      const key = keyOf(request)
      entries.set(key, response.clone())
      puts.push(key)
    },
    async match(request) {
      const response = entries.get(keyOf(request))
      return response?.clone()
    },
  }
  const context = vm.createContext({
    URL, Request, Response, Headers,
    fetch: fetchImpl,
    caches: {
      async open() { return cache },
      async match(request) { return cache.match(request) },
      async keys() { return ['superagent-mobile-shell-v0', 'unrelated-cache'] },
      async delete(name) { deleted.push(name); return true },
    },
    self: {
      location: { origin },
      skipWaiting: async () => {},
      clients: {
        claim: async () => {},
        async matchAll() { return [{ postMessage: message => messages.push(message) }] },
      },
      addEventListener(type, listener) { listeners.set(type, listener) },
    },
  })
  return { context, listeners, entries, puts, deleted, messages, cache }
}

async function loadServiceWorker(fetchImpl = async () => basicResponse('ok')) {
  const worker = createServiceWorker(fetchImpl)
  vm.runInContext(await read('sw.js'), worker.context, { filename: 'sw.js' })
  return worker
}

async function dispatch(worker, type, request) {
  let promise
  worker.listeners.get(type)({
    request,
    waitUntil(value) { promise = value },
    respondWith(value) { promise = value },
  })
  assert.ok(promise, `${type} should call respondWith/waitUntil`)
  return promise
}

test('manifest is a valid installable standalone shell scoped at the origin root', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'))
  assert.equal(manifest.id, '/')
  assert.equal(manifest.start_url, '/mobile.html')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.lang, 'zh-CN')
  assert.ok(manifest.name && manifest.short_name)
  assert.deepEqual(manifest.icons.map(icon => [icon.src, icon.sizes, icon.type]), [
    ['/icons/superagent-192.svg', '192x192', 'image/svg+xml'],
    ['/icons/superagent-512.svg', '512x512', 'image/svg+xml'],
  ])
  for (const icon of manifest.icons) {
    assert.match(icon.purpose, /\bany\b/)
    assert.match(icon.purpose, /\bmaskable\b/)
    const svg = await read(icon.src.replace(/^\//, ''))
    const dimensions = svg.match(/<svg[^>]+width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) \d+"/)
    assert.ok(dimensions)
    assert.equal(Number(dimensions[1]), Number(icon.sizes.split('x')[0]))
    assert.equal(Number(dimensions[2]), Number(icon.sizes.split('x')[1]))
    assert.equal(Number(dimensions[3]), 512)
    assert.doesNotMatch(svg, /<script|foreignObject|javascript:/i)
  }
})

test('service worker precaches only the HTML shell and two icons', async () => {
  const requested = []
  const worker = await loadServiceWorker(async request => {
    requested.push(request.url)
    const path = new URL(request.url).pathname
    return basicResponse(path.endsWith('.svg') ? '<svg/>' : '<html/>', {
      headers: { 'content-type': path.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' },
    })
  })
  await dispatch(worker, 'install', new Request(`${origin}/mobile.html`))
  assert.deepEqual(requested.map(url => new URL(url).pathname).sort(), [
    '/icons/superagent-192.svg', '/icons/superagent-512.svg', '/mobile.html',
  ])
  assert.equal(worker.puts.length, 3)
  assert.equal(worker.entries.size, 3)
  assert.ok([...worker.entries.keys()].every(key => /^\/(?:mobile\.html|icons\/superagent-(?:192|512)\.svg)$/.test(new URL(key).pathname)))
})

test('service worker never caches API, SSE, artifact, token or authentication responses', async () => {
  const sensitivePaths = [
    '/api/console/state', '/superagent/api/console/events', '/events', '/sse',
    '/artifact?path=report.md', '/artifacts/run-1', '/token', '/auth/login',
    '/login', '/oauth/callback', '/session', '/credentials', '/console/api/state',
  ]
  for (const path of sensitivePaths) {
    const worker = await loadServiceWorker(async () => basicResponse('sensitive', {
      headers: { 'content-type': 'application/json' },
    }))
    const response = await dispatch(worker, 'fetch', new Request(origin + path))
    assert.equal(await response.text(), 'sensitive', path)
    assert.equal(worker.puts.length, 0, path)
    assert.equal(worker.entries.size, 0, path)
  }
})

test('cache allowlist rejects queries, credentials, non-GET and non-static responses', async () => {
  const cases = [
    { url: '/mobile.html?token=secret', headers: { 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { authorization: 'Bearer secret', 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { 'x-api-key': 'secret', 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { 'set-cookie': 'session=secret', 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { 'www-authenticate': 'Bearer', 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { 'cache-control': 'private, max-age=60', 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { 'cache-control': 'no-store', 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { vary: '*', 'content-type': 'text/html' } },
    { url: '/mobile.html', headers: { 'content-type': 'application/json' } },
    { url: '/other.html', headers: { 'content-type': 'text/html' } },
  ]
  for (const item of cases) {
    const worker = await loadServiceWorker(async () => basicResponse('body', { headers: item.headers }))
    await dispatch(worker, 'fetch', new Request(origin + item.url, { credentials: 'omit', headers: item.headers }))
    assert.equal(worker.puts.length, 0, item.url + JSON.stringify(item.headers))
  }
  const postWorker = await loadServiceWorker()
  await dispatch(postWorker, 'fetch', new Request(origin + '/mobile.html', { method: 'POST' }))
  assert.equal(postWorker.puts.length, 0)
  const cookieWorker = await loadServiceWorker(async () => basicResponse('private shell', { headers: { 'content-type': 'text/html' } }))
  await dispatch(cookieWorker, 'fetch', new Request(origin + '/mobile.html', { credentials: 'include' }))
  assert.equal(cookieWorker.puts.length, 0, 'ambient credentials must never populate the cache')
  const externalWorker = await loadServiceWorker()
  assert.equal(externalWorker.listeners.has('fetch'), true)
  externalWorker.listeners.get('fetch')({ request: new Request('https://example.com/mobile.html'), respondWith() { assert.fail('cross-origin must be ignored') } })
})

test('shell is network-first and immutable sensitive traffic is never stored', async () => {
  let online = true
  const worker = await loadServiceWorker(async () => {
    if (!online) throw new TypeError('offline')
    return basicResponse('<html>fresh</html>', { headers: { 'content-type': 'text/html' } })
  })
  const request = new Request(origin + '/mobile.html', { credentials: 'omit' })
  const fresh = await dispatch(worker, 'fetch', request)
  assert.equal(await fresh.text(), '<html>fresh</html>')
  assert.equal(worker.puts.length, 1)
  online = false
  const cached = await dispatch(worker, 'fetch', request)
  assert.equal(await cached.text(), '<html>fresh</html>')
  assert.equal(worker.puts.length, 1)
})

test('offline navigation shows the cached shell while API failure is explicit and uncached', async () => {
  let online = true
  const worker = await loadServiceWorker(async request => {
    if (!online) throw new TypeError('offline')
    if (new URL(request.url).pathname === '/mobile.html') {
      return basicResponse('<html>shell</html>', { headers: { 'content-type': 'text/html' } })
    }
    return basicResponse('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })
  })
  await dispatch(worker, 'install', new Request(origin + '/mobile.html'))
  online = false
  const navigationRequest = path => ({ url: origin + path, method: 'GET', mode: 'navigate' })
  const shell = await dispatch(worker, 'fetch', navigationRequest('/mobile.html'))
  assert.match(await shell.text(), /<html>shell<\/html>/)
  const navigation = await dispatch(worker, 'fetch', navigationRequest('/tasks/today'))
  assert.match(await navigation.text(), /<html>shell<\/html>/)
  const api = await dispatch(worker, 'fetch', new Request(origin + '/api/console/state'))
  assert.equal(api.status, 503)
  assert.equal(api.headers.get('cache-control'), 'no-store')
  assert.equal(await api.text(), '无法连接执行服务')
  assert.equal(worker.puts.length, 3)
  assert.ok(worker.messages.some(message => message.type === 'SUPERAGENT_OFFLINE'))
})

test('activation removes only old shell caches and claims clients', async () => {
  const worker = await loadServiceWorker()
  await dispatch(worker, 'activate', new Request(origin + '/mobile.html'))
  assert.deepEqual(worker.deleted, ['superagent-mobile-shell-v0'])
})

test('mobile HTML has a strict hash-based CSP, viewport, install prompt and SW registration', async () => {
  const html = await read('mobile.html')
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]
  assert.ok(csp)
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /connect-src 'self'/)
  assert.match(csp, /worker-src 'self'/)
  assert.match(csp, /manifest-src 'self'/)
  assert.match(csp, /base-uri 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.match(csp, /frame-ancestors 'self'/)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|https?:/i)
  for (const tag of ['style', 'script']) {
    const start = html.indexOf(`<${tag}>`) + tag.length + 2
    const content = html.slice(start, html.indexOf(`</${tag}>`, start))
    const hash = createHash('sha256').update(content).digest('base64')
    assert.ok(csp.includes(`'sha256-${hash}'`), `${tag} must have an exact CSP hash`)
  }
  assert.equal((html.match(/<script(?:\s|>)/g) || []).length, 1)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i)
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/)
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/)
  assert.match(html, /beforeinstallprompt/)
  assert.match(html, /installEvent\.prompt\(\)/)
  assert.match(html, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/)
  assert.match(html, /无法连接执行服务/)
})

test('mobile API is an explicit device-scope allowlist with no privileged entry points', async () => {
  const html = await read('mobile.html')
  const script = mobileScript(html)
  const routes = [...script.matchAll(/(\w+): \{ method: '(GET|POST)', path: '([^']+)', scope: (null|'\w+') \}/g)]
    .map(match => ({ name: match[1], method: match[2], path: match[3], scope: match[4] }))
  assert.deepEqual(routes, [
    { name: 'status', method: 'GET', path: '/api/console/device/status', scope: 'null' },
    { name: 'sessions', method: 'GET', path: '/api/console/sessions', scope: "'chat'" },
    { name: 'router', method: 'GET', path: '/api/console/router', scope: "'chat'" },
    { name: 'events', method: 'GET', path: '/api/console/events', scope: "'chat'" },
    { name: 'runs', method: 'GET', path: '/api/console/runs', scope: "'tasks'" },
    { name: 'notifications', method: 'GET', path: '/api/console/notifications', scope: "'inbox'" },
    { name: 'artifacts', method: 'GET', path: '/api/console/artifacts?limit=50', scope: "'artifacts'" },
    { name: 'artifact', method: 'GET', path: '/api/console/artifacts/', scope: "'artifacts'" },
    { name: 'message', method: 'POST', path: '/api/console/message', scope: "'chat'" },
    { name: 'approval', method: 'POST', path: '/api/console/approval', scope: "'approval'" },
    { name: 'answer', method: 'POST', path: '/api/console/answer', scope: "'approval'" },
  ])
  assert.match(script, /API_BASES = Object\.freeze\(\['\/api', '\/superagent\/api'\]\)/)
  assert.match(script, /path\.replace\(\/\^\\\/api\/, state\.apiBase\)/)
  for (const forbidden of ['control', 'admin', 'share', 'memory', 'capabilities', 'runtime', 'cloud', 'market']) {
    assert.doesNotMatch(script, new RegExp(`/api/console/${forbidden}(?:['"/?]|$)`), forbidden)
    assert.doesNotMatch(html, new RegExp(`(?:href|data-page|data-route)=["'][^"']*${forbidden}`, 'i'), forbidden)
  }
  assert.match(script, /credentials: 'omit'/)
  assert.match(script, /cache: 'no-store'/)
  assert.match(script, /redirect: 'error'/)
  assert.match(script, /authorization: 'Bearer '/)
  assert.doesNotMatch(script, /token[^\n]*URL|URL[^\n]*token|[?&]token=/i)
})

test('mobile token is session-only, validated before API use, and failures are explicit', async () => {
  const missing = createMobile(async () => { assert.fail('missing token must not fetch') })
  missing.elements.get('token-input').value = '   '
  await missing.elements.get('token-form').dispatch('submit')
  assert.match(missing.elements.get('auth-status').textContent, /缺少设备 token/)
  assert.equal(missing.storage.size, 0)
  assert.equal(missing.elements.get('pages').hidden, true)

  const invalid = createMobile(async () => json({ error: { summary: 'token expired' } }, 401))
  invalid.elements.get('token-input').value = 'not-a-device-token'
  await invalid.elements.get('token-form').dispatch('submit')
  assert.match(invalid.elements.get('auth-status').textContent, /格式无效/)
  assert.equal(invalid.requests.length, 0)

  const expired = createMobile(async () => json({ error: { summary: 'expired' } }, 401))
  expired.elements.get('token-input').value = deviceToken
  await expired.elements.get('token-form').dispatch('submit')
  assert.equal(expired.requests[0].url, '/api/console/device/status')
  assert.equal(expired.storage.has('superagent.mobile.token'), false, expired.elements.get('auth-status').textContent)
  assert.match(expired.elements.get('auth-status').textContent, /无效、已过期或已撤销/)
  assert.equal(expired.elements.get('connection').textContent, '未验证')

  const forbidden = createMobile(async () => json({ error: { summary: 'forbidden' } }, 403))
  forbidden.elements.get('token-input').value = deviceToken
  await forbidden.elements.get('token-form').dispatch('submit')
  assert.match(forbidden.elements.get('auth-status').textContent, /没有此功能的权限|scope/)
  assert.equal(forbidden.elements.get('pages').hidden, true)
})

test('mobile consumes read APIs, sends messages and answers approvals without HTML injection', async () => {
  const hostile = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>'
  const answers = []
  const mobile = createMobile(async (url, options) => {
    const path = new URL(url, origin).pathname
    if (path.endsWith('/device/status')) return json([])
    if (path.endsWith('/sessions')) return json({ currentSessionId: 'session-1', sessions: [{ sessionId: 'session-1', title: hostile }] })
    if (path.endsWith('/router')) return json({ revision: 1, pending: 0, messages: [
      { id: 'prior-user', role: 'user', text: '之前的问题' },
      { id: 'prior-reply', role: 'assistant', text: hostile },
    ] })
    if (path.endsWith('/runs')) return json({ runs: [{ id: 'run-1', goal: hostile, status: 'running' }] })
    if (path.endsWith('/notifications')) return json({ inbox: [
      { id: 'approval:ap-1', kind: 'approval', approvalId: 'ap-1', title: 'shell', body: hostile },
      { id: 'run:run-1:q-1', kind: 'decision', runId: 'run-1', decisionId: 'q-1', sessionId: 'session-1', title: hostile, body: 'Ship?', options: ['yes', 'no'] },
    ] })
    if (path.endsWith('/artifacts')) return json({ artifacts: [{ id: 'art_run-1.abc', name: hostile, path: '/tmp/report.md' }] })
    if (path.endsWith('/artifacts/art_run-1.abc')) return json({ artifact: { name: hostile }, run: { report: hostile } })
    if (path.endsWith('/message')) return json({ accepted: true, sessionId: 'session-1' })
    if (path.endsWith('/approval')) { answers.push(JSON.parse(options.body)); return json({ id: 'ap-1' }) }
    if (path.endsWith('/answer')) { answers.push(JSON.parse(options.body)); return json({ runId: 'run-1' }) }
    assert.fail(`unexpected route ${url}`)
  })
  const { elements, storage, requests } = mobile
  elements.get('token-input').value = deviceToken
  await elements.get('token-form').dispatch('submit')
  assert.equal(storage.get('superagent.mobile.token'), deviceToken)
  assert.equal(elements.get('pages').hidden, false)
  assert.equal(elements.get('connection').textContent, '已连接')
  assert.match(elements.get('session-list').textContent, /session-1/)
  assert.equal(elements.get('session-list').querySelectorAll('img').length, 0)
  assert.match(elements.get('chat-log').textContent, /Superagent/)
  assert.match(elements.get('chat-log').textContent, /<script>globalThis\.pwned=1<\/script>/)
  assert.equal(elements.get('chat-log').querySelectorAll('img').length, 0)

  await elements.get('tab-tasks').dispatch('click')
  assert.match(elements.get('task-list').textContent, /run-1/)
  await elements.get('tab-todos').dispatch('click')
  const approvalCard = elements.get('inbox-list').children[0]
  await approvalCard.querySelectorAll('button')[0].dispatch('click')
  const decisionCard = elements.get('inbox-list').children[1]
  const answerForm = decisionCard.children.find(child => child.tagName === 'FORM')
  answerForm.children[0].value = 'yes'
  await answerForm.dispatch('submit')
  assert.deepEqual(answers, [
    { id: 'ap-1', decision: 'allow' },
    { owner: 'session-1', runId: 'run-1', attentionId: 'q-1', answer: 'yes' },
  ])

  await elements.get('tab-artifacts').dispatch('click')
  await elements.get('artifact-list').children[0].querySelectorAll('button')[0].dispatch('click')
  assert.match(elements.get('artifact-list').textContent, /<img src=x onerror=/)

  await elements.get('tab-chat').dispatch('click')
  elements.get('chat-input').value = hostile
  await elements.get('chat-form').dispatch('submit')
  assert.match(elements.get('chat-log').textContent, /<script>globalThis\.pwned=1<\/script>/)
  assert.equal(mobile.context.pwned, undefined)

  const paths = requests.map(item => new URL(item.url, origin).pathname)
  assert.deepEqual([...new Set(paths)].sort(), [
    '/api/console/device/status', '/api/console/sessions', '/api/console/router', '/api/console/events', '/api/console/runs',
    '/api/console/notifications', '/api/console/artifacts',
    '/api/console/artifacts/art_run-1.abc', '/api/console/approval',
    '/api/console/answer', '/api/console/message',
  ].sort())
  for (const request of requests) {
    assert.equal(request.headers.authorization, `Bearer ${deviceToken}`)
    assert.equal(request.credentials, 'omit')
    assert.equal(request.cache, 'no-store')
    assert.doesNotMatch(request.url, /token|dsm_/i)
  }
  const allNodes = [...elements.values(), ...requests]
  assert.ok(allNodes.every(node => !('innerHTML' in node)))
})

test('mobile renders authoritative router assistant replies and reconciles optimistic sends', async () => {
  let releaseMessage
  const messageGate = new Promise(resolve => { releaseMessage = resolve })
  let revision = 1
  const messages = [
    { id: 'old-user', role: 'user', text: '之前的问题', at: Date.now() - 1000 },
    { id: 'old-reply', role: 'assistant', text: '权威助手回复', at: Date.now() - 500 },
  ]
  const mobile = createMobile(async (url, options) => {
    const path = new URL(url, origin).pathname
    if (path.endsWith('/device/status')) return json({ id: 'device-1', scopes: ['chat'] })
    if (path.endsWith('/sessions')) return json({ sessions: [], currentSessionId: null, reason: 'router-mode' })
    if (path.endsWith('/router')) return json({ revision, messages, pending: 0 })
    if (path.endsWith('/events')) return json({}, 503)
    if (path.endsWith('/message')) {
      const body = JSON.parse(options.body)
      assert.match(body.id, /^local-[a-z0-9-]+$/)
      await messageGate
      messages.push({ id: body.id, role: 'user', text: body.text, at: Date.now() })
      messages.push({ id: `reply-${body.id}`, role: 'assistant', text: `已回复：${body.text}`, at: Date.now() })
      revision += 1
      return json({ accepted: true, id: body.id })
    }
    assert.fail(`unexpected route ${url}`)
  })
  const { elements } = mobile
  elements.get('token-input').value = deviceToken
  await elements.get('token-form').dispatch('submit')
  assert.match(elements.get('chat-log').textContent, /权威助手回复/)
  assert.match(elements.get('chat-log').textContent, /Superagent/)

  elements.get('chat-input').value = 'new question'
  const sending = elements.get('chat-form').dispatch('submit')
  assert.match(elements.get('chat-log').textContent, /new question/, 'the optimistic send must appear before the server answers')
  releaseMessage()
  await sending
  const rendered = elements.get('chat-log').textContent
  assert.match(rendered, /已回复：new question/)
  const userCards = elements.get('chat-log').children.filter(card =>
    card.children[0]?.textContent === '你' && card.children[1]?.textContent === 'new question')
  assert.equal(userCards.length, 1, 'the snapshot must replace, not duplicate, the optimistic echo')
})

test('mobile supports the host API prefix and reports per-feature scope denials', async () => {
  const mobile = createMobile(async url => {
    const path = new URL(url, origin).pathname
    if (path === '/api/console/device/status') return json({}, 404)
    if (path === '/superagent/api/console/device/status') return json({ id: 'device-1', scopes: ['chat'] })
    if (path === '/superagent/api/console/sessions') return json({ sessions: [] })
    if (path === '/superagent/api/console/router') return json({ revision: 0, pending: 0, messages: [] })
    if (path === '/superagent/api/console/runs') return json({ error: { summary: 'forbidden' } }, 403)
    assert.fail(`unexpected route ${url}`)
  })
  mobile.elements.get('token-input').value = deviceToken
  await mobile.elements.get('token-form').dispatch('submit')
  assert.equal(mobile.elements.get('pages').hidden, false)
  await mobile.elements.get('tab-tasks').dispatch('click')
  assert.match(mobile.elements.get('task-list').textContent, /没有此功能的权限|scope/)
  assert.ok(mobile.requests.some(item => item.url === '/superagent/api/console/device/status'))
  assert.ok(mobile.requests.every(item => !item.url.includes(deviceToken)))
})

test('mobile shell uses console tokens, four tabs, session-only token storage and 375px-safe layout', async () => {
  const html = await read('mobile.html')
  const consoleHtml = await read('console.html')
  for (const name of ['bg', 'panel', 'panel-2', 'line', 'text', 'muted', 'accent', 'accent-ink', 'amber', 'red', 'green', 'input-bg', 'radius', 'sans']) {
    const declaration = new RegExp(`--${name}:\\s*([^;]+);`).exec(consoleHtml)?.[1]
    assert.ok(declaration, name)
    assert.ok(html.includes(`--${name}: ${declaration};`), `mobile must reuse console token --${name}`)
  }
  for (const page of ['chat', 'tasks', 'todos', 'artifacts']) {
    assert.match(html, new RegExp(`id="tab-${page}"[^>]*role="tab"`))
    assert.match(html, new RegExp(`id="page-${page}"[^>]*role="tabpanel"`))
  }
  assert.match(html, /sessionStorage\.getItem\(TOKEN_KEY\)/)
  assert.match(html, /sessionStorage\.setItem\(TOKEN_KEY, value\)/)
  assert.doesNotMatch(html, /localStorage|document\.cookie|indexedDB/)
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/)
  assert.match(html, /type="password"[^>]*autocomplete="off"/)
  assert.match(html, /id="token-form"/)
  assert.match(html, /textContent = value/)
  assert.match(html, /@media \(max-width: 350px\)/)
  assert.match(html, /html, body \{[^}]*width: 100%;[^}]*overflow-x: hidden;/)
  assert.match(html, /\.app \{[^}]*width: 100%;[^}]*max-width: 720px;[^}]*overflow: hidden;/)
  assert.match(html, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
  assert.match(html, /@media \(max-width: 420px\)/)
  assert.match(html, /\.composer textarea \{[^}]*min-width: 0;/)
  assert.match(html, /\.tab \{[^}]*min-width: 0;/)
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
  assert.doesNotMatch(css, /(?:^|[;{]\s*)(?:min-)?width:\s*(?:[4-9]\d{2}|\d{4,})px/m)
})
