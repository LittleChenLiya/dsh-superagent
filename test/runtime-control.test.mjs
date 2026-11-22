import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { createAuditor } from '../lib/audit.js'
import { createGuard } from '../lib/guard.js'
import { createRuntimeControl, checkNavigation, irreversibleIntent, LOOPBACK_HOSTS } from '../lib/runtime-control.js'
import { resolveVirtualKeys } from '../lib/desktop.js'
import { classifyHumanGate, findBrowserExecutable } from '../lib/browser.js'

/** Build one runtime layer over a real auditor, so the trail can be read back. */
function runtimeFor(stateDir, config) {
  const auditor = createAuditor({ dir: path.join(stateDir, 'audit'), warn: () => {} })
  const runtime = createRuntimeControl({ config, stateRoot: stateDir, auditor, warn: () => {} })
  return { runtime, auditor }
}

/** A host stub with the whole injected surface: `tools.register` only. */
function fakeHost() {
  const tools = new Map()
  return {
    tools,
    ctx: {
      tools: { register: tool => tools.set(tool.name, tool) },
      get: () => undefined,
    },
  }
}

/**
 * A page stub with just the methods runtime-control calls. It records how the
 * session was initialised and replays a fixed human-gate answer, so the hand-off
 * path can be exercised without a real browser.
 */
function fakePage({ url = 'http://127.0.0.1:8080/', title = 'Test page', gate = null, element = null } = {}) {
  let currentUrl = url
  let currentElement = element
  const initCalls = []
  return {
    initCalls,
    get url() {
      return currentUrl
    },
    setElement(value) {
      currentElement = value
    },
    async init(options = {}) {
      initCalls.push(options)
    },
    async goto(target) {
      currentUrl = target
      return { url: currentUrl, title }
    },
    async evaluate(expression) {
      if (expression.includes('data-dsh-el')) return currentElement
      if (expression.includes('location.href')) {
        return expression.includes('document.title') ? { url: currentUrl, title } : currentUrl
      }
      if (expression.includes('innerWidth')) return { width: 1280, height: 900 }
      if (expression.includes('document.activeElement')) return { tag: 'input', value: 'typed' }
      return null
    },
    async humanGate() {
      return typeof gate === 'function' ? gate() : gate
    },
    async elements() {
      return {
        url: currentUrl,
        title,
        scroll: { x: 0, y: 0 },
        viewport: { width: 1280, height: 900 },
        elements: [],
      }
    },
    async clickIndex() {
      return { x: 10, y: 20, box: currentElement?.box ?? { x: 0, y: 0, width: 20, height: 20 } }
    },
    async clickAt(point) {
      return { ...point, box: point.box ?? null }
    },
    async typeInto() {
      return { index: 0, inserted: 3, submit: false }
    },
    async screenshot({ path: file }) {
      return { path: file, bytes: 12, width: 1280, height: 900 }
    },
    async waitFor() {},
  }
}

/** One live browser session as runtime-control expects it. */
function fakeLive({ mode = 'launch', port = 5555, page = fakePage() } = {}) {
  return {
    page,
    connection: null,
    mode,
    port,
    executablePath: 'C:/fake/chrome.exe',
    userDataDir: mode === 'attach' ? null : 'C:/temp/fake-profile',
    persistentProfile: mode === 'attach',
    headless: mode !== 'attach',
    browser: mode === 'attach' ? 'Chrome/999.0' : null,
    attachedUrl: mode === 'attach' ? 'http://127.0.0.1:8080/inbox' : null,
    pid: mode === 'attach' ? null : 4242,
    closed: false,
    async close() {
      this.closed = true
    },
  }
}

/** A runtime layer over stubs, with the browser half replaceable. */
function runtimeWith(stateDir, config, { openBrowserImpl = null, attachBrowserImpl = null } = {}) {
  const auditor = createAuditor({ dir: path.join(stateDir, 'audit'), warn: () => {} })
  const runtime = createRuntimeControl({
    config,
    stateRoot: stateDir,
    auditor,
    warn: () => {},
    ...(openBrowserImpl ? { openBrowserImpl } : {}),
    ...(attachBrowserImpl ? { attachBrowserImpl } : {}),
  })
  return { runtime, auditor }
}

test('runtime control is not registered unless a profile opts in', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-off-'))
  const { tools, ctx } = fakeHost()
  apply(ctx, { stateDir, notifyOnComplete: false })
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'superagent_answer', 'superagent_audit', 'superagent_cancel', 'superagent_followup',
      'superagent_goal', 'superagent_help', 'superagent_inject', 'superagent_list',
      'superagent_memory', 'superagent_resume', 'superagent_schedule', 'superagent_start',
      'superagent_status', 'superagent_template',
    ],
  )
  assert.equal(tools.has('browser_open'), false)
  assert.equal(tools.has('desktop_click'), false)
})

test('opting in registers browser tools and leaves desktop off until it is enabled', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-on-'))
  const { tools, ctx } = fakeHost()
  apply(ctx, { stateDir, notifyOnComplete: false, runtime: { enabled: true } })
  for (const name of [
    'browser_open', 'browser_elements', 'browser_click', 'browser_type',
    'browser_screenshot', 'browser_script', 'browser_wait', 'browser_await_human',
    'browser_close', 'runtime_status',
  ]) {
    assert.equal(tools.has(name), true, `${name} should be registered`)
  }
  assert.equal(tools.has('desktop_windows'), false)

  const desktopDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-desktop-'))
  const enabled = fakeHost()
  apply(enabled.ctx, {
    stateDir: desktopDir,
    notifyOnComplete: false,
    runtime: { enabled: true, desktop: { enabled: true } },
  })
  for (const name of ['desktop_screenshot', 'desktop_windows', 'desktop_click', 'desktop_type', 'desktop_keys']) {
    assert.equal(enabled.tools.has(name), true, `${name} should be registered`)
  }
})

test('navigation is loopback by default and refuses file, other schemes, and unknown hosts', () => {
  assert.equal(checkNavigation('http://127.0.0.1:8080/a').allowed, true)
  assert.equal(checkNavigation('http://localhost/').allowed, true)

  const file = checkNavigation('file:///C:/Windows/win.ini')
  assert.equal(file.allowed, false)
  assert.equal(file.rule, 'runtime/file-url')

  const scheme = checkNavigation('javascript:alert(1)')
  assert.equal(scheme.allowed, false)
  assert.equal(scheme.rule, 'runtime/scheme')

  const remote = checkNavigation('https://example.com/')
  assert.equal(remote.allowed, false)
  assert.equal(remote.rule, 'runtime/host-not-allowed')
  assert.match(remote.reason, /127\.0\.0\.1/)

  assert.equal(checkNavigation('https://example.com/', { allowedHosts: ['example.com'] }).allowed, true)
  assert.equal(checkNavigation('https://api.example.com/', { allowedHosts: ['*.example.com'] }).allowed, true)
  assert.equal(checkNavigation('https://example.com.evil.test/', { allowedHosts: ['*.example.com'] }).allowed, false)
  assert.equal(checkNavigation('', {}).allowed, false)
  assert.deepEqual(LOOPBACK_HOSTS, ['localhost', '127.0.0.1', '::1'])
})

test('irreversible intent is detected in English and Chinese labels only', () => {
  assert.equal(irreversibleIntent('Submit order'), 'Submit')
  assert.equal(irreversibleIntent('Delete account'), 'Delete')
  assert.equal(irreversibleIntent('立即支付'), '支付')
  assert.equal(irreversibleIntent('提交表单'), '提交')
  assert.equal(irreversibleIntent('Add to cart'), null)
  assert.equal(irreversibleIntent('Next'), null)
  assert.equal(irreversibleIntent(''), null)
})

test('human checks are recognised in both languages and ordinary pages stay quiet', () => {
  assert.equal(classifyHumanGate({ text: '请先登录后继续' }).kind, 'login-required')
  assert.equal(classifyHumanGate({ text: 'Please sign in to continue' }).kind, 'login-required')
  assert.equal(classifyHumanGate({ text: 'Confirm you are human to continue' }).kind, 'human-verification')
  assert.equal(classifyHumanGate({ text: '请完成人机验证' }).kind, 'human-verification')
  assert.equal(classifyHumanGate({ text: '请输入短信验证码' }).kind, 'sms-code')
  assert.equal(classifyHumanGate({ text: 'Enter the verification code we sent' }).kind, 'sms-code')
  assert.equal(classifyHumanGate({ text: '双重验证' }).kind, 'two-factor')
  assert.equal(classifyHumanGate({ text: 'Scan the QR code to sign in' }).kind, 'qr-login')
  assert.equal(classifyHumanGate({ text: '请扫码登录' }).kind, 'qr-login')
  assert.equal(classifyHumanGate({ text: '欢迎回来 登录', passwordField: true }).kind, 'login-required')
  assert.equal(classifyHumanGate({ text: 'Change password', passwordField: true }), null)
  assert.equal(classifyHumanGate({ text: 'Browse products' }), null)
  assert.equal(classifyHumanGate({}), null)
})

test('a sign-in page stops the action as attention, not as a failure', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-attention-'))
  const page = fakePage({ gate: { kind: 'login-required', label: 'a sign-in the page is waiting for', matched: '请先登录' } })
  const { runtime } = runtimeWith(stateDir, { enabled: true }, { openBrowserImpl: async () => fakeLive({ page }) })
  const open = runtime.tools.find(tool => tool.name === 'browser_open')
  const result = await runtime.withActor('worker-1', () => open.execute({ url: 'http://127.0.0.1:8080/?private=token' }))

  assert.match(result, /^\[attention\]/)
  assert.doesNotMatch(result, /^\[error\]/)
  assert.match(result, /browser_await_human/)
  assert.match(result, /sign-in the page is waiting for/)
  assert.equal(runtime.takeHumanHandoff('worker-2'), null)
  assert.deepEqual(runtime.takeHumanHandoff('worker-1'), {
    kind: 'login-required', url: 'http://127.0.0.1:8080/', headless: true,
  })
  assert.equal(runtime.takeHumanHandoff('worker-1'), null)

  const { events } = await readAudit(stateDir)
  const attention = events.find(event => event.kind === 'attention')
  assert.ok(attention, 'the hand-off must be in the audit trail')
  assert.equal(attention.action, 'open')
  assert.equal(attention.decision, 'attention')
  assert.equal(attention.result, 'needs-human')
  assert.equal(attention.rule, 'runtime/needs-human')
  assert.equal(attention.meta.gate, 'login-required')
  assert.equal(attention.meta.session, 'launch')
  assert.equal(attention.meta.port, 5555)
  assert.equal(attention.meta.profile, 'C:/temp/fake-profile')
  assert.ok(attention.meta.screenshot)
})

test('browser_await_human continues once the person clears the check', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-await-'))
  const gate = { kind: 'sms-code', label: 'an SMS or one-time verification code', matched: '短信验证码' }
  let answers = 0
  const page = fakePage({
    gate: () => {
      answers += 1
      return answers <= 2 ? gate : null
    },
  })
  const { runtime } = runtimeWith(stateDir, { enabled: true }, { openBrowserImpl: async () => fakeLive({ page }) })
  const open = runtime.tools.find(tool => tool.name === 'browser_open')
  const awaitHuman = runtime.tools.find(tool => tool.name === 'browser_await_human')

  assert.match(await open.execute({ url: 'http://127.0.0.1:8080/' }), /^\[attention\]/)
  const result = await awaitHuman.execute({ timeout_ms: 3000, poll_ms: 100 })
  assert.match(result, /^browser_await_human: ok/)
  assert.match(result, /cleared after \d+ms/)

  const { events } = await readAudit(stateDir)
  const allowed = events.filter(event => event.action === 'await_human' && event.decision === 'allow')
  assert.equal(allowed.length, 1)
  assert.equal(allowed[0].meta.gate, 'cleared')
  assert.equal(allowed[0].meta.session, 'launch')
})

test('browser_await_human hands back again when the check outlasts the timeout', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-await-timeout-'))
  const page = fakePage({ gate: { kind: 'human-verification', label: 'a CAPTCHA', matched: 'captcha' } })
  const { runtime } = runtimeWith(stateDir, { enabled: true }, { openBrowserImpl: async () => fakeLive({ page }) })
  const awaitHuman = runtime.tools.find(tool => tool.name === 'browser_await_human')

  // No browser yet: the tool says how to get one instead of launching one behind the caller's back.
  assert.match(await awaitHuman.execute({}), /^\[error\] no browser is open/)

  await runtime.tools.find(tool => tool.name === 'browser_open').execute({ url: 'http://127.0.0.1:8080/' })
  const result = await awaitHuman.execute({ timeout_ms: 400, poll_ms: 100 })
  assert.match(result, /^\[attention\]/)
  assert.match(result, /waited: \d+ms/)

  const { events } = await readAudit(stateDir)
  const timeout = events.find(event => event.action === 'await_human' && event.decision === 'attention')
  assert.ok(timeout)
  assert.ok(timeout.meta.waited >= 400)
  assert.equal(timeout.meta.gate, 'human-verification')
})

test('attach mode is audited as attach and leaves the attached window size alone', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-attach-audit-'))
  const page = fakePage()
  const live = fakeLive({ mode: 'attach', port: 9222, page })
  let attachOptions = null
  const { runtime } = runtimeWith(
    stateDir,
    { enabled: true, browser: { attachPort: 9222 } },
    {
      attachBrowserImpl: async options => {
        attachOptions = options
        return live
      },
      openBrowserImpl: async () => {
        throw new Error('launch must not run while attachPort is set')
      },
    },
  )
  const open = runtime.tools.find(tool => tool.name === 'browser_open')
  const result = await open.execute({ url: 'http://127.0.0.1:8080/inbox' })

  assert.match(result, /^browser_open: ok/)
  assert.deepEqual(attachOptions, { port: 9222 })
  assert.equal(page.initCalls.at(-1).emulateViewport, false, 'an attached tab keeps its own viewport')

  const { events } = await readAudit(stateDir)
  const opened = events.find(event => event.action === 'open' && event.decision === 'allow')
  assert.ok(opened)
  assert.equal(opened.meta.session, 'attach')
  assert.equal(opened.meta.port, 9222)
  assert.equal(opened.meta.browser, 'Chrome/999.0')
  assert.equal(opened.meta.tab, 'http://127.0.0.1:8080/inbox')
  assert.equal(opened.meta.profile, undefined)
})

test('an attach failure names the port and the launch command, and never starts a profile', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-attach-fail-'))
  let launches = 0
  const { runtime } = runtimeWith(
    stateDir,
    { enabled: true, browser: { attachPort: 9333 } },
    {
      attachBrowserImpl: async () => {
        throw new Error('fetch failed')
      },
      openBrowserImpl: async () => {
        launches += 1
        return fakeLive()
      },
    },
  )
  const result = await runtime.tools.find(tool => tool.name === 'browser_open')
    .execute({ url: 'http://127.0.0.1:8080/' })

  assert.match(result, /^\[error\] cannot attach to the browser on 127\.0\.0\.1:9333/)
  assert.match(result, /remote-debugging-port=9333/)
  assert.match(result, /no browser was launched in its place/)
  assert.equal(launches, 0, 'attach must not fall back to a new profile')
})

test('the guardrails still apply on an attached connection', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-attach-gates-'))
  const page = fakePage()
  let attaches = 0
  const { runtime } = runtimeWith(
    stateDir,
    { enabled: true, browser: { attachPort: 9222, allowedHosts: ['127.0.0.1'] } },
    {
      attachBrowserImpl: async () => {
        attaches += 1
        return fakeLive({ mode: 'attach', port: 9222, page })
      },
      openBrowserImpl: async () => fakeLive(),
    },
  )
  const open = runtime.tools.find(tool => tool.name === 'browser_open')
  const click = runtime.tools.find(tool => tool.name === 'browser_click')

  const remote = await open.execute({ url: 'https://example.com/' })
  assert.match(remote, /^\[error\] example\.com is not an allowed host/)
  assert.equal(attaches, 0, 'the host gate runs before any attach')

  page.setElement({ index: 0, label: 'Upload resume', type: 'file', box: { x: 0, y: 0, width: 40, height: 20 } })
  const upload = await click.execute({ index: 0 })
  assert.match(upload, /^\[error\].*uploads are refused/)

  page.setElement({ index: 0, label: 'Delete project', type: 'submit', box: { x: 0, y: 0, width: 40, height: 20 } })
  const held = await click.execute({ index: 0 })
  assert.match(held, /^\[error\].*looks irreversible/)

  page.setElement({ index: 0, label: 'Open settings', type: 'button', box: { x: 0, y: 0, width: 40, height: 20 } })
  const allowed = await click.execute({ index: 0 })
  assert.match(allowed, /^browser_click: ok/)

  const { events } = await readAudit(stateDir)
  const refused = events.filter(event => ['runtime/host-not-allowed', 'runtime/file-upload', 'runtime/irreversible'].includes(event.rule))
  assert.deepEqual(
    refused.map(event => event.rule).sort(),
    ['runtime/file-upload', 'runtime/host-not-allowed', 'runtime/irreversible'],
  )
  const clicked = events.find(event => event.action === 'click' && event.decision === 'allow')
  assert.equal(clicked.meta.session, 'attach')

  // The stop switch is checked before the connection, attach included.
  const stopDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-attach-stop-'))
  const stopFile = path.join(stopDir, 'runtime', 'STOP')
  await fsp.mkdir(path.dirname(stopFile), { recursive: true })
  await fsp.writeFile(stopFile, 'stop\n', 'utf8')
  let stoppedAttaches = 0
  const stopped = runtimeWith(
    stopDir,
    { enabled: true, stopFile, browser: { attachPort: 9222 } },
    {
      attachBrowserImpl: async () => {
        stoppedAttaches += 1
        return fakeLive({ mode: 'attach', port: 9222 })
      },
    },
  ).runtime
  const stoppedResult = await stopped.tools.find(tool => tool.name === 'browser_open')
    .execute({ url: 'http://127.0.0.1:8080/' })
  assert.match(stoppedResult, /^\[error\] runtime control is stopped/)
  assert.equal(stoppedAttaches, 0)
})

test('a configured userDataDir is passed through and audited as a persistent profile', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-profile-'))
  let launchOptions = null
  const live = fakeLive()
  live.persistentProfile = true
  live.userDataDir = 'C:/temp/kept-profile'
  const { runtime } = runtimeWith(
    stateDir,
    { enabled: true, browser: { userDataDir: 'C:/temp/kept-profile' } },
    {
      openBrowserImpl: async options => {
        launchOptions = options
        return live
      },
    },
  )
  const result = await runtime.tools.find(tool => tool.name === 'browser_open')
    .execute({ url: 'http://127.0.0.1:8080/' })
  assert.match(result, /^browser_open: ok/)
  assert.equal(launchOptions.userDataDir, 'C:/temp/kept-profile')

  const { events } = await readAudit(stateDir)
  const opened = events.find(event => event.action === 'open' && event.decision === 'allow')
  assert.equal(opened.meta.session, 'launch')
  assert.equal(opened.meta.profile, 'C:/temp/kept-profile')
  assert.equal(opened.meta.persistentProfile, true)
})

test('a stop file refuses every action and records the refusal', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-stop-'))
  const stopFile = path.join(stateDir, 'runtime', 'STOP')
  await fsp.mkdir(path.dirname(stopFile), { recursive: true })
  await fsp.writeFile(stopFile, 'stop\n', 'utf8')

  const runtime = runtimeFor(stateDir, { enabled: true, stopFile }).runtime
  const open = runtime.tools.find(tool => tool.name === 'browser_open')
  const result = await open.execute({ url: 'http://127.0.0.1:1/' })
  assert.match(result, /^\[error\] runtime control is stopped/)
  assert.match(result, /STOP/)

  const { events } = await readAudit(stateDir)
  const blocked = events.find(event => event.rule === 'runtime/stopped')
  assert.ok(blocked, 'the refusal must be in the audit trail')
  assert.equal(blocked.decision, 'deny')
  assert.equal(blocked.result, 'blocked')
  assert.equal(blocked.action, 'open')
  assert.ok(Number.isFinite(blocked.durationMs))
})

test('an unknown host is refused before any browser is launched, and is audited', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-host-'))
  const runtime = runtimeFor(stateDir, { enabled: true }).runtime
  const open = runtime.tools.find(tool => tool.name === 'browser_open')
  const result = await open.execute({ url: 'https://example.com/' })
  assert.match(result, /^\[error\] example\.com is not an allowed host/)
  const { events } = await readAudit(stateDir)
  const blocked = events.find(event => event.rule === 'runtime/host-not-allowed')
  assert.ok(blocked)
  assert.equal(blocked.target, 'https://example.com/')
})

test('activation is refused when the config does not allow it', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-activate-'))
  const runtime = runtimeFor(stateDir, { enabled: true, desktop: { enabled: true, allowActivation: false } }).runtime
  const click = runtime.tools.find(tool => tool.name === 'desktop_click')
  const result = await click.execute({ x: 10, y: 10, window: 'Notepad', activate: true })
  assert.match(result, /^\[error\] activation is disabled/)
  const { events } = await readAudit(stateDir)
  assert.ok(events.some(event => event.rule === 'runtime/activation-disabled' && event.decision === 'deny'))
})

test('desktop click refuses an irreversible window title without confirmation', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-confirm-'))
  const runtime = runtimeFor(stateDir, { enabled: true, desktop: { enabled: true } }).runtime
  const click = runtime.tools.find(tool => tool.name === 'desktop_click')
  const result = await click.execute({ x: 5, y: 5, window: 'Confirm payment' })
  assert.match(result, /^\[error\] "Confirm payment" looks irreversible \(matched "Confirm"\)/)
  const { events } = await readAudit(stateDir)
  const held = events.find(event => event.rule === 'runtime/irreversible')
  assert.ok(held)
  assert.equal(held.decision, 'confirm')
  assert.equal(held.meta.matched, 'Confirm')
})

test('runtime_status reports the stop state, hosts, and halves', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-status-'))
  const runtime = createRuntimeControl({ config: { enabled: true }, stateRoot: stateDir, warn: () => {} })
  const status = runtime.tools.find(tool => tool.name === 'runtime_status')
  const text = await status.execute({})
  assert.match(text, /enabled: yes/)
  assert.match(text, /browser tools: 9/)
  assert.match(text, /browser mode: launch with a fresh temporary profile/)
  assert.match(text, /desktop tools: 0/)
  assert.match(text, /stop switch: clear/)
  assert.match(text, /127\.0\.0\.1/)
})

test('key names resolve to virtual-key codes and a chord is refused', () => {
  assert.deepEqual(resolveVirtualKeys(['Enter', 'tab', 'a', '7']), [13, 9, 65, 55])
  assert.throws(() => resolveVirtualKeys(['Ctrl+A']), /unknown key/)
  assert.throws(() => resolveVirtualKeys([]), /at least one key/)
})

test('the browser executable lookup honours an explicit path and never guesses a missing one', () => {
  const found = findBrowserExecutable({ explicit: 'C:/definitely/not/here.exe' })
  assert.equal(found, null)
  const resolved = findBrowserExecutable({ explicit: process.execPath })
  assert.equal(resolved, path.resolve(process.execPath))
})

test('the guard refuses browser and desktop tools for worker agents unless allowed', () => {
  const blocked = createGuard({ config: { enabled: true } })
  blocked.bindChild('child-1', { runId: 'run-1', label: 'worker' })
  const browser = blocked.checkToolCall({ name: 'browser_open', arguments: { url: 'http://127.0.0.1/' }, agent: { id: 'child-1' } })
  assert.equal(browser.blocked, true)
  assert.equal(browser.rule, 'guard/runtime-tool')
  assert.match(browser.reasonText, /\[guard\] blocked browser_open/)

  const desktop = blocked.checkToolCall({ name: 'desktop_click', arguments: { x: 1, y: 2, window: 'Notepad' }, agent: { id: 'child-1' } })
  assert.equal(desktop.blocked, true)
  assert.equal(desktop.rule, 'guard/runtime-tool')

  const permitted = createGuard({ config: { enabled: true, allowRuntimeTools: true } })
  permitted.bindChild('child-2', { runId: 'run-2', label: 'worker' })
  const allowed = permitted.checkToolCall({ name: 'browser_elements', arguments: {}, agent: { id: 'child-2' } })
  assert.equal(allowed.blocked, false)

  const unbound = blocked.checkToolCall({ name: 'browser_open', arguments: { url: 'http://127.0.0.1/' }, agent: { id: 'someone-else' } })
  assert.equal(unbound.blocked, false, 'calls the guard does not own pass through')
})

/** A CDP stub that records frames, acks, and input on one page session. */
function fakeConnection() {
  const calls = []
  const listeners = new Set()
  return {
    calls,
    async send(method, params = {}, options = {}) {
      calls.push({ method, params, sessionId: options.sessionId })
      if (method === 'Page.startScreencast') {
        queueMicrotask(() => this.emit({
          method: 'Page.screencastFrame',
          sessionId: 'page-1',
          params: {
            data: 'aGk=', metadata: { deviceWidth: 420, deviceHeight: 760 }, sessionId: 7,
          },
        }))
      }
      return {}
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

/** A live session whose page is the fake above and whose CDP channel is ours. */
function liveWithConnection(connection, options = {}) {
  const page = fakePage()
  page.sessionId = 'page-1'
  return { live: { ...fakeLive({ page, ...options }), connection }, page }
}

test('the live view streams the run browser, forwards input, and restores the viewport', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-live-'))
  const connection = fakeConnection()
  const { live } = liveWithConnection(connection)
  const { runtime } = runtimeWith(stateDir, { enabled: true }, { openBrowserImpl: async () => live })
  try {
    assert.equal((await runtime.live.status()).available, false, 'no browser before the first action')

    const open = runtime.tools.find(tool => tool.name === 'browser_open')
    await open.execute({ url: 'http://127.0.0.1:8080/login' })
    const status = await runtime.live.status()
    assert.equal(status.available, true)
    assert.equal(status.headless, true)
    assert.equal(status.url, 'http://127.0.0.1:8080/login')

    const frames = []
    const detach = runtime.live.attach(frame => frames.push(frame), { width: 420, height: 760 })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(frames.some(frame => frame.type === 'frame'), 'the panel receives a painted frame')
    assert.ok(connection.calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride'
      && call.params.width === 420), 'the panel width becomes the page viewport')
    assert.ok(connection.calls.some(call => call.method === 'Page.startScreencast'))
    assert.ok(connection.calls.some(call => call.method === 'Page.screencastFrameAck'),
      'every frame is acknowledged')

    await runtime.live.input({ kind: 'mouse', type: 'down', x: 12, y: 24, button: 'left', buttons: 1 })
    await runtime.live.input({ kind: 'key', type: 'press', key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
    await runtime.live.input({ kind: 'wheel', x: 10, y: 20, deltaY: 120 })
    assert.ok(connection.calls.some(call => call.method === 'Input.dispatchMouseEvent'
      && call.params.type === 'mousePressed' && call.params.x === 12 && call.params.y === 24))
    assert.equal(connection.calls.filter(call => call.method === 'Input.dispatchKeyEvent').length, 2,
      'a press is one keyDown and one keyUp')
    assert.ok(connection.calls.some(call => call.method === 'Input.dispatchMouseEvent'
      && call.params.type === 'mouseWheel' && call.params.deltaY === 120))

    detach()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(connection.calls.some(call => call.method === 'Page.stopScreencast'))
    const restored = connection.calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').at(-1)
    assert.deepEqual({ width: restored.params.width, height: restored.params.height },
      { width: 1280, height: 900 }, 'the run gets its own viewport back')
  } finally {
    await runtime.dispose()
    await fsp.rm(stateDir, { recursive: true, force: true })
  }
})

test('an attached user tab is streamed but never resized', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-live-attach-'))
  const connection = fakeConnection()
  const { live } = liveWithConnection(connection, { mode: 'attach' })
  const { runtime } = runtimeWith(stateDir, { enabled: true, browser: { attachPort: 9333 } }, {
    attachBrowserImpl: async () => live,
    openBrowserImpl: async () => { throw new Error('attach must not launch a browser') },
  })
  try {
    const open = runtime.tools.find(tool => tool.name === 'browser_open')
    await open.execute({ url: 'http://127.0.0.1:8080/login' })
    const detach = runtime.live.attach(() => {}, { width: 420, height: 760 })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(connection.calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride'), false,
      'the size of the user window is theirs')
    detach()
  } finally {
    await runtime.dispose()
    await fsp.rm(stateDir, { recursive: true, force: true })
  }
})

/** Read the auditor's JSONL through the same reader the plugin uses. */
async function readAudit(stateDir) {
  const file = path.join(stateDir, 'audit', 'audit.jsonl')
  const text = await fsp.readFile(file, 'utf8').catch(() => '')
  const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { events }
}
