/**
 * Zero-dependency Chromium control over the DevTools protocol.
 *
 * Node 22+ ships a global `WebSocket`, so one browser can be driven without a
 * single npm package: launch Chromium with `--remote-debugging-port=0`, read the
 * port it chose from `DevToolsActivePort`, then exchange CDP frames with it.
 *
 * Everything here is deliberately plain: no retries on a dead socket, no
 * implicit browser reuse across processes, and no fallback that would turn a
 * failed action into a silent no-op. A caller gets either a result or an error.
 *
 * @module dsh-superagent/browser
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const LAUNCH_TIMEOUT_MS = 20000
const CALL_TIMEOUT_MS = 30000
const NAVIGATION_TIMEOUT_MS = 30000

/** Chromium-family executables, in the order a Windows desktop usually has them. */
export const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
]

/**
 * Resolve the browser binary to drive.
 * @param {{ explicit?: string|null, env?: NodeJS.ProcessEnv, platform?: string, exists?: (file: string) => boolean }} [options]
 * @returns {string|null} absolute executable path, or null when none is installed.
 */
export function findBrowserExecutable({ explicit = null, env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const named = explicit ?? env.DSH_BROWSER_PATH ?? null
  if (typeof named === 'string' && named.trim()) {
    const file = path.resolve(named.trim())
    return exists(file) ? file : null
  }
  const candidates = platform === 'win32'
    ? BROWSER_CANDIDATES.filter(entry => /^[A-Za-z]:\//.test(entry))
    : BROWSER_CANDIDATES.filter(entry => entry.startsWith('/'))
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/** One CDP message channel. Calls are correlated by numeric id, events by method. */
class CdpConnection {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Set()
  #closed
  #closePromise

  constructor(socket) {
    this.#socket = socket
    this.#closed = new Promise(resolve => {
      this.#closePromise = resolve
    })
    socket.addEventListener('message', event => this.#route(event.data))
    socket.addEventListener('close', () => this.#failAll(new Error('the DevTools connection closed')))
    socket.addEventListener('error', () => this.#failAll(new Error('the DevTools connection failed')))
  }

  /**
   * @param {string} url - Chrome DevTools websocket URL.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<CdpConnection>}
   */
  static async connect(url, { timeoutMs = LAUNCH_TIMEOUT_MS } = {}) {
    if (typeof WebSocket !== 'function') {
      throw new Error('this Node version has no global WebSocket; zero-dependency browser control needs Node 22 or newer')
    }
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms connecting to ${url}`)), timeoutMs)
      const done = fn => () => {
        clearTimeout(timer)
        fn()
      }
      socket.addEventListener('open', done(resolve), { once: true })
      socket.addEventListener('error', done(() => reject(new Error(`cannot reach the DevTools endpoint ${url}`))), { once: true })
    })
    return new CdpConnection(socket)
  }

  #route(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const waiting = this.#pending.get(message.id)
      if (!waiting) return
      this.#pending.delete(message.id)
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message ?? 'DevTools error'}`))
      else waiting.resolve(message.result ?? {})
      return
    }
    for (const listener of this.#listeners) listener(message)
  }

  #failAll(error) {
    for (const [, waiting] of this.#pending) waiting.reject(error)
    this.#pending.clear()
    this.#closePromise()
  }

  /**
   * Send one command and wait for its reply.
   * @param {string} method - e.g. `Runtime.evaluate`.
   * @param {object} [params]
   * @param {{ sessionId?: string, timeoutMs?: number }} [options]
   */
  send(method, params = {}, { sessionId, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    if (this.#socket.readyState !== 1) {
      return Promise.reject(new Error(`the DevTools connection is not open (${method})`))
    }
    const id = this.#nextId++
    const envelope = { id, method, params }
    if (sessionId) envelope.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#pending.set(id, {
        method,
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.#socket.send(JSON.stringify(envelope))
    })
  }

  /** Listen for every DevTools event; returns an unsubscribe function. */
  onEvent(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Wait until the socket closes. */
  closed() {
    return this.#closed
  }

  close() {
    try {
      this.#socket.close()
    } catch {
      // Already closing; nothing to release.
    }
  }
}

/**
 * Wait for `DevToolsActivePort` to appear, which is how a browser launched with
 * port 0 reports the port it actually took.
 */
async function readActivePort(userDataDir, { timeoutMs = LAUNCH_TIMEOUT_MS, child = null } = {}) {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  const started = Date.now()
  for (;;) {
    if (child && child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`the browser exited with code ${child.exitCode} before opening a debugging port`)
    }
    try {
      const text = await fsp.readFile(file, 'utf8')
      const [port, target] = text.split('\n')
      if (port && /^\d+$/.test(port.trim())) {
        return { port: Number(port.trim()), path: (target ?? '').trim() }
      }
    } catch {
      // Not written yet.
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`the browser did not open a debugging port within ${timeoutMs}ms (expected ${file})`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/**
 * Launch a Chromium-family browser with its own profile directory.
 *
 * The profile is isolated on purpose: the user's everyday cookies and logins
 * stay out of reach, which is exactly why an agent cannot inherit them.
 *
 * @param {{
 *   executablePath?: string|null,
 *   userDataDir?: string|null,
 *   headless?: boolean,
 *   timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {Promise<{ port: number, wsUrl: string, executablePath: string, userDataDir: string, pid: number|undefined, close: () => Promise<void> }>}
 */
export async function launchBrowser({
  executablePath = null,
  userDataDir = null,
  headless = true,
  timeoutMs = LAUNCH_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const executable = findBrowserExecutable({ explicit: executablePath, env })
  if (!executable) {
    throw new Error(
      'no Chromium-family browser found; set runtime.browser.executablePath (or DSH_BROWSER_PATH) to chrome.exe or msedge.exe',
    )
  }
  const profileDir = userDataDir
    ? path.resolve(userDataDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-profile-'))
  await fsp.mkdir(profileDir, { recursive: true })
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1280,900',
  ]
  if (headless) args.push('--headless=new')
  args.push('about:blank')

  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', chunk => {
    if (stderr.length < 4000) stderr += String(chunk)
  })
  const close = async () => {
    if (child.exitCode === null) {
      child.kill()
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 3000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
  let active
  try {
    active = await readActivePort(profileDir, { timeoutMs, child })
  } catch (error) {
    await close()
    throw new Error(`${error.message}${stderr ? `\nbrowser stderr: ${stderr.trim().slice(0, 800)}` : ''}`)
  }
  const wsUrl = `ws://127.0.0.1:${active.port}${active.path || `/devtools/browser/`}`
  return { port: active.port, wsUrl, executablePath: executable, userDataDir: profileDir, pid: child.pid, close }
}

/**
 * Read the browser websocket URL from an already running browser that was
 * started with `--remote-debugging-port=<port>`.
 * @param {number} port
 * @returns {Promise<{ wsUrl: string, browser: string, webSocketDebuggerUrl: string }>}
 */
export async function discoverEndpoint(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`)
  if (!response.ok) throw new Error(`no DevTools endpoint on 127.0.0.1:${port} (HTTP ${response.status})`)
  const info = await response.json()
  if (!info?.webSocketDebuggerUrl) throw new Error(`127.0.0.1:${port} answered without a webSocketDebuggerUrl`)
  return { wsUrl: info.webSocketDebuggerUrl, browser: info.Browser ?? 'unknown', webSocketDebuggerUrl: info.webSocketDebuggerUrl }
}

/**
 * In-page enumeration of actionable elements.
 *
 * It assigns `data-dsh-el="<index>"` to every element it returns, so a later
 * click can address the exact node instead of re-running an ambiguous selector.
 * The accessible name follows the ARIA fallback order closely enough to match
 * what a screen reader announces for buttons, links, and labelled inputs.
 */
export const ENUMERATE_ELEMENTS = String.raw`(() => {
  const MAX = 400
  const visible = el => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity || '1') < 0.05) return false
    return true
  }
  const implicitRole = el => {
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'file') return 'file-input'
      if (type === 'search') return 'searchbox'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return null
  }
  const nameOf = el => {
    const labelled = el.getAttribute('aria-labelledby')
    if (labelled) {
      const text = labelled.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '')
        .join(' ')
        .trim()
      if (text) return text
    }
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.labels && el.labels.length > 0) {
        const text = [...el.labels].map(label => label.textContent || '').join(' ').trim()
        if (text) return text
      }
      const placeholder = el.getAttribute('placeholder')
      if (placeholder && placeholder.trim()) return placeholder.trim()
    }
    const alt = el.getAttribute('alt')
    if (alt && alt.trim()) return alt.trim()
    const title = el.getAttribute('title')
    if (title && title.trim()) return title.trim()
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) return text
    return (el.getAttribute('value') || '').trim()
  }
  const selector = 'a[href], button, input, select, textarea, summary, [role], [onclick], [contenteditable="true"], [tabindex]'
  const nodes = [...document.querySelectorAll(selector)]
  for (const node of document.querySelectorAll('[data-dsh-el]')) node.removeAttribute('data-dsh-el')
  const out = []
  let index = 0
  for (const el of nodes) {
    if (out.length >= MAX) break
    if (!visible(el)) continue
    const role = (el.getAttribute('role') || implicitRole(el) || '').trim() || null
    const name = nameOf(el)
    if (!role && !name && !el.hasAttribute('onclick') && !el.hasAttribute('tabindex')) continue
    const rect = el.getBoundingClientRect()
    el.setAttribute('data-dsh-el', String(index))
    out.push({
      index,
      tag: el.tagName.toLowerCase(),
      role,
      name,
      type: (el.getAttribute('type') || '').toLowerCase() || null,
      href: el.getAttribute('href'),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      value: typeof el.value === 'string' ? el.value.slice(0, 200) : null,
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    })
    index += 1
  }
  return {
    url: location.href,
    title: document.title,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    viewport: { width: innerWidth, height: innerHeight },
    elements: out,
  }
})()`

/**
 * Decide whether a page is asking a person to do something automation must not
 * do for them: solve a CAPTCHA, enter an SMS code, confirm "you are human",
 * scan a QR code, or sign in.
 *
 * Only page text is inspected, deliberately. A reCAPTCHA badge or a password
 * field on an ordinary settings page must not stop a run, so a check is only
 * reported when the copy says a person is needed; the password field counts
 * only next to a sign-in word.
 *
 * @param {{ text?: string, passwordField?: boolean }} [signals]
 * @returns {{ kind: string, label: string, matched: string }|null}
 */
export function classifyHumanGate({ text = '', passwordField = false } = {}) {
  const body = String(text ?? '').slice(0, 20000)
  const rules = [
    {
      kind: 'human-verification',
      label: 'a CAPTCHA or "confirm you are human" check',
      patterns: [
        /confirm (that )?you are (a )?human/i,
        /verify (that )?you are (a )?human/i,
        /i'?m not a robot/i,
        /not a robot/i,
        /captcha/i,
        /人机验证/,
        /安全验证/,
        /完成验证/,
        /滑动.{0,8}验证/,
        /拖动.{0,8}滑块/,
        /滑块验证/,
      ],
    },
    {
      kind: 'sms-code',
      label: 'an SMS or one-time verification code',
      patterns: [
        /短信验证码/,
        /短信验证/,
        /验证码/,
        /verification code/i,
        /one[- ]time (pass)?code/i,
        /动态码/,
        /校验码/,
      ],
    },
    {
      kind: 'two-factor',
      label: 'a two-factor confirmation',
      patterns: [/two[- ]factor/i, /\b2fa\b/i, /authenticator/i, /双重验证/, /两步验证/, /身份验证器/],
    },
    {
      kind: 'qr-login',
      label: 'a QR-code sign-in',
      patterns: [/扫码登录/, /扫一扫登录/, /二维码登录/, /scan (the )?qr/i, /qr code.*(sign|log)\s?in/i],
    },
    {
      kind: 'login-required',
      label: 'a sign-in the page is waiting for',
      patterns: [
        /请先登录/,
        /请登录后/,
        /登录后(查看|继续|访问|才)/,
        /登录已(过期|失效)/,
        /未登录/,
        /please (sign|log) in/i,
        /sign in to continue/i,
        /log in to continue/i,
        /session (has )?expired/i,
        /authentication required/i,
      ],
    },
  ]
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(body)
      if (match) return { kind: rule.kind, label: rule.label, matched: match[0] }
    }
  }
  if (passwordField && /(sign in|log in|登录)/i.test(body)) {
    return { kind: 'login-required', label: 'a sign-in form the page is waiting for', matched: 'password field' }
  }
  return null
}

/**
 * One tab, attached as a flat DevTools session.
 *
 * Coordinates are CSS pixels from the top-left of the viewport, which is what
 * `Input.dispatchMouseEvent` and `getBoundingClientRect()` both use, so a
 * reported box can be fed straight back into a click.
 */
export class PageSession {
  /**
   * @param {CdpConnection} connection
   * @param {string} sessionId
   * @param {string} targetId
   */
  constructor(connection, sessionId, targetId) {
    this.connection = connection
    this.sessionId = sessionId
    this.targetId = targetId
    this.closed = false
  }

  #send(method, params = {}, timeoutMs) {
    return this.connection.send(method, params, { sessionId: this.sessionId, timeoutMs })
  }

  /** Enable the domains every later call depends on. */
  async init({ width = 1280, height = 900, emulateViewport = true } = {}) {
    await this.#send('Page.enable')
    await this.#send('Runtime.enable')
    // A fixed viewport makes a screenshot a stable piece of evidence instead of
    // whatever size the last window happened to have. An attached tab is the
    // user's own window, so it keeps the size the user gave it.
    if (emulateViewport) {
      await this.#send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
    }
    return this
  }

  /**
   * Navigate and wait for `document.readyState` to settle.
   * @param {string} url
   * @param {{ timeoutMs?: number }} [options]
   */
  async goto(url, { timeoutMs = NAVIGATION_TIMEOUT_MS } = {}) {
    const result = await this.#send('Page.navigate', { url }, timeoutMs)
    if (result.errorText) throw new Error(`navigation to ${url} failed: ${result.errorText}`)
    await this.waitForIdle({ timeoutMs })
    return { url: await this.evaluate('location.href'), title: await this.evaluate('document.title') }
  }

  /** Poll until the document finished loading or the timeout expires. */
  async waitForIdle({ timeoutMs = NAVIGATION_TIMEOUT_MS } = {}) {
    const started = Date.now()
    for (;;) {
      const state = await this.evaluate('document.readyState', { timeoutMs: 5000 })
      if (state === 'complete') return
      if (Date.now() - started > timeoutMs) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  /**
   * Evaluate an expression in the page and return its JSON value.
   * @param {string} expression
   * @param {{ awaitPromise?: boolean, timeoutMs?: number }} [options]
   */
  async evaluate(expression, { awaitPromise = true, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const result = await this.#send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }, timeoutMs)
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page script threw: ${String(detail).split('\n')[0]}`)
    }
    return result.result?.value
  }

  /** Enumerate actionable elements, assigning a clickable data-dsh-el index. */
  async elements() {
    return this.evaluate(ENUMERATE_ELEMENTS)
  }

  /**
   * Report the human check this page is waiting for, or null.
   *
   * The classifier is injected from its own source so the page and the unit
   * tests run exactly the same rules.
   *
   * @returns {Promise<{ kind: string, label: string, matched: string }|null>}
   */
  async humanGate() {
    const expression = `(() => {
      const visible = el => {
        const rect = el.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return false
        const style = getComputedStyle(el)
        return style.visibility !== 'hidden' && style.display !== 'none'
      }
      const passwordField = [...document.querySelectorAll('input[type="password"]')].some(visible)
      const text = (document.body ? document.body.innerText : '').slice(0, 20000)
      return (${classifyHumanGate.toString()})({ text, passwordField })
    })()`
    return this.evaluate(expression)
  }

  /**
   * Click one element by its `data-dsh-el` index.
   * @param {number} index
   */
  async clickIndex(index) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector('[data-dsh-el="${Number(index)}"]')
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = el.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height }
    })()`)
    if (!box) throw new Error(`element index ${index} is no longer on the page; list the elements again`)
    return this.clickAt({ x: box.x, y: box.y, box })
  }

  /**
   * Dispatch a real mouse press/release at a viewport coordinate.
   * @param {{ x: number, y: number, box?: object }} point
   */
  async clickAt({ x, y, box = null }) {
    const base = { x, y, button: 'left', clickCount: 1 }
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
    return { x: Math.round(x), y: Math.round(y), box }
  }

  /**
   * Focus an element and insert text.
   * @param {{ index?: number, text: string, submit?: boolean }} options
   */
  async typeInto({ index = null, text, submit = false }) {
    if (index !== null) await this.clickIndex(index)
    // insertText goes through the same input pipeline as a paste: React and
    // plain inputs both see it, and it cannot be swallowed by a slow keymap.
    await this.#send('Input.insertText', { text })
    if (submit) await this.pressEnter()
    return { index, inserted: text.length, submit }
  }

  /** Press Enter through the input domain, so a form submits the way a user's key would. */
  async pressEnter() {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await this.#send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
    await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  /**
   * Capture a PNG screenshot.
   * @param {{ path: string, fullPage?: boolean }} options
   * @returns {Promise<{ path: string, bytes: number, width: number, height: number }>}
   */
  async screenshot({ path: file, fullPage = false }) {
    const { data } = await this.#send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: fullPage,
    })
    const buffer = Buffer.from(data, 'base64')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, buffer)
    const size = await this.evaluate('({ width: innerWidth, height: innerHeight })')
    return { path: file, bytes: buffer.length, width: size.width, height: size.height }
  }

  /**
   * Poll for a condition.
   * @param {{ text?: string|null, css?: string|null, urlContains?: string|null, timeoutMs?: number, intervalMs?: number, sleepMs?: number }} [options]
   */
  async waitFor({ text = null, css = null, urlContains = null, timeoutMs = 10000, intervalMs = 150, sleepMs = null } = {}) {
    if (sleepMs !== null) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(sleepMs) || 0)))
      return { waited: Number(sleepMs), condition: 'sleep' }
    }
    const started = Date.now()
    const checks = []
    if (text) {
      const needle = JSON.stringify(String(text))
      checks.push(`(document.body ? document.body.innerText : '').includes(${needle})`)
    }
    if (css) checks.push(`Boolean(document.querySelector(${JSON.stringify(String(css))}))`)
    if (urlContains) checks.push(`location.href.includes(${JSON.stringify(String(urlContains))})`)
    if (checks.length === 0) throw new Error('wait needs text, css, url_contains, or milliseconds')
    const expression = `Boolean(${checks.join(' && ')})`
    for (;;) {
      if (await this.evaluate(expression, { timeoutMs: 5000 })) {
        return { waited: Date.now() - started, condition: expression }
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`waited ${timeoutMs}ms and the condition never became true: ${expression}`)
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }
}

/**
 * A browser plus the single tab this plugin keeps for the process.
 *
 * One tab is enough for the supported actions and keeps the audit trail
 * unambiguous: every URL in the log belongs to the same page.
 */
export async function openBrowser({ executablePath = null, headless = true, timeoutMs = LAUNCH_TIMEOUT_MS, width = 1280, height = 900, userDataDir = null } = {}) {
  const launched = await launchBrowser({ executablePath, headless, timeoutMs, userDataDir })
  let connection
  try {
    connection = await CdpConnection.connect(launched.wsUrl, { timeoutMs })
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new PageSession(connection, sessionId, targetId)
    await page.init({ width, height })
    return {
      page,
      connection,
      mode: 'launch',
      port: launched.port,
      executablePath: launched.executablePath,
      userDataDir: launched.userDataDir,
      persistentProfile: Boolean(userDataDir),
      headless: headless === true,
      pid: launched.pid,
      async close() {
        try {
          await connection.send('Target.closeTarget', { targetId })
        } catch {
          // The tab may already be gone; the socket close below still releases it.
        }
        try {
          await connection.send('Browser.close')
        } catch {
          // Edge may close the socket before acknowledging Browser.close.
        }
        connection.close()
        await launched.close()
      },
    }
  } catch (error) {
    connection?.close()
    await launched.close()
    throw error
  }
}

/**
 * Attach to a browser the user started themselves with `--remote-debugging-port`.
 *
 * The existing tab is reused, not a new one, and the window keeps its size: this
 * is the user's own session, so the plugin borrows it rather than repainting it.
 * The returned `close` detaches; it never terminates the user's browser.
 *
 * @param {{ port: number, timeoutMs?: number, width?: number, height?: number }} options
 */
export async function attachBrowser({ port, timeoutMs = LAUNCH_TIMEOUT_MS, width = 1280, height = 900 }) {
  const endpoint = await discoverEndpoint(port)
  const connection = await CdpConnection.connect(endpoint.wsUrl, { timeoutMs })
  let targetId = null
  let createdTarget = false
  try {
    const targets = await connection.send('Target.getTargets')
    const pages = (targets.targetInfos ?? [])
      .filter(info => info.type === 'page' && !String(info.url ?? '').startsWith('devtools://'))
    // Prefer a real page over about:blank, so a freshly started browser does not
    // win over the tab the user already has open.
    const existing = pages.find(info => /^https?:/i.test(String(info.url ?? ''))) ?? pages[0]
    if (existing) {
      targetId = existing.targetId
    } else {
      targetId = (await connection.send('Target.createTarget', { url: 'about:blank' })).targetId
      createdTarget = true
    }
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new PageSession(connection, sessionId, targetId)
    await page.init({ width, height, emulateViewport: false })
    let attachedUrl = null
    try {
      attachedUrl = await page.evaluate('location.href')
    } catch {
      attachedUrl = null
    }
    return {
      page,
      connection,
      mode: 'attach',
      port,
      executablePath: null,
      userDataDir: null,
      persistentProfile: true,
      headless: false,
      pid: null,
      browser: endpoint.browser,
      attachedUrl,
      createdTarget,
      async close() {
        // Only a tab this process created is closed; the user's own tabs stay.
        if (createdTarget) {
          try {
            await connection.send('Target.closeTarget', { targetId })
          } catch {
            // The tab may already be gone.
          }
        }
        connection.close()
      },
    }
  } catch (error) {
    connection.close()
    throw error
  }
}
