/**
 * Runtime control: browser and desktop actions, gated and audited.
 *
 * The layer is opt-in. With `runtime.enabled` off nothing is registered, so a
 * profile that never asked for it behaves exactly as before. When it is on, the
 * rules that matter are enforced here rather than trusted to the model:
 *
 * 1. an emergency stop file refuses every action while it exists;
 * 2. navigation is limited to configured hosts (loopback by default) and never
 *    reaches `file://` or another local scheme;
 * 3. an action that looks irreversible — submit, delete, pay — needs the caller
 *    to repeat the intent with `confirm: true`;
 * 4. bringing a window to the foreground needs `activate: true` plus a config
 *    that allows it, and the activation is recorded.
 *
 * Every attempt, allowed or refused, goes through one wrapper that writes the
 * audit line. A refusal is thrown as {@link RuntimeRefusal} rather than returned
 * as text, so the trail can never claim `result: ok` for an action that the gate
 * stopped.
 *
 * @module dsh-superagent/runtime-control
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { attachBrowser, findBrowserExecutable, openBrowser } from './browser.js'
import { captureScreenshot, clickAt, listWindows, pressKeys, resolveVirtualKeys, typeText } from './desktop.js'
import { describeError } from './errors.js'

/** Hosts an unconfigured install may still reach: the machine itself. */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1']

/**
 * Words that mark an action as irreversible in a button label. The list is
 * about intent, not about any particular site: the caller has to repeat
 * `confirm: true` when one of these shows up.
 */
export const IRREVERSIBLE_PATTERNS = [
  /\bsubmit\b/i,
  /\bconfirm\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bpay\b/i,
  /\bpayment\b/i,
  /\bpurchase\b/i,
  /\bbuy\b/i,
  /\bcheckout\b/i,
  /\bplace\s+order\b/i,
  /\btransfer\b/i,
  /\bwithdraw\b/i,
  /\bsend\b/i,
  /\bpublish\b/i,
  /\bdeploy\b/i,
  /\bunsubscribe\b/i,
  /提交/,
  /确定/,
  /确认/,
  /删除/,
  /移除/,
  /支付/,
  /付款/,
  /购买/,
  /下单/,
  /结算/,
  /转账/,
  /提现/,
  /发布/,
  /发送/,
  /注销/,
]

/** A gate said no. Carries the rule so the audit line names the policy. */
export class RuntimeRefusal extends Error {
  constructor({ message, rule, decision = 'deny', target = null, meta = {} }) {
    super(message)
    this.name = 'RuntimeRefusal'
    this.rule = rule
    this.decision = decision
    this.target = target
    this.meta = meta
  }
}

/**
 * The page asked for a person. This is a hand-off, not a failure: the action
 * stopped short of the check, the audit line records `decision: "attention"`,
 * and the caller is told how to let the person finish and continue.
 */
export class RuntimeAttention extends Error {
  constructor({ message, gate, target = null, meta = {} }) {
    super(message)
    this.name = 'RuntimeAttention'
    this.gate = gate
    this.target = target
    this.meta = meta
  }
}

/**
 * The runtime could not be set up. The message is already actionable, so it is
 * returned as-is instead of being run through the provider-error classifier,
 * which would call an unreachable DevTools port a model-provider failure.
 */
class RuntimeSetupError extends Error {
  constructor({ message, rule, meta = {} }) {
    super(message)
    this.name = 'RuntimeSetupError'
    this.rule = rule
    this.meta = meta
  }
}

/**
 * Find the irreversible-intent word in a label, if any.
 * @param {string|null|undefined} label
 * @returns {string|null} the matched word, so the refusal can quote it.
 */
export function irreversibleIntent(label) {
  const text = String(label ?? '')
  if (!text.trim()) return null
  for (const pattern of IRREVERSIBLE_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return null
}

function hostAllowed(host, allowed) {
  const target = String(host ?? '').toLowerCase()
  if (!target) return false
  return allowed.some(entry => {
    const rule = String(entry ?? '').trim().toLowerCase()
    if (!rule) return false
    if (rule.startsWith('*.')) return target === rule.slice(2) || target.endsWith(rule.slice(1))
    return target === rule
  })
}

/**
 * Decide whether a URL may be opened or navigated to.
 *
 * Only `http:` and `https:` are reachable. `file:` is refused outright: a page
 * that can read local files would bypass the filesystem guard entirely, and
 * that guard is the reason a worker cannot touch the user's disk.
 *
 * @param {string} url
 * @param {{ allowedHosts?: string[] }} [options]
 * @returns {{ allowed: boolean, rule: string|null, reason: string|null, url: string }}
 */
export function checkNavigation(url, { allowedHosts = [] } = {}) {
  const raw = String(url ?? '').trim()
  if (!raw) return { allowed: false, rule: 'runtime/bad-url', reason: 'a URL is required', url: raw }
  if (raw === 'about:blank') return { allowed: true, rule: null, reason: null, url: raw }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { allowed: false, rule: 'runtime/bad-url', reason: `${JSON.stringify(raw)} is not an absolute URL`, url: raw }
  }
  if (parsed.protocol === 'file:') {
    return {
      allowed: false,
      rule: 'runtime/file-url',
      reason: 'file:// pages are refused: they would expose local files outside the workspace guard',
      url: raw,
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      allowed: false,
      rule: 'runtime/scheme',
      reason: `only http and https are reachable; ${parsed.protocol} is refused`,
      url: raw,
    }
  }
  const allowed = allowedHosts.length > 0 ? allowedHosts : LOOPBACK_HOSTS
  if (!hostAllowed(parsed.hostname, allowed)) {
    return {
      allowed: false,
      rule: 'runtime/host-not-allowed',
      reason: `${parsed.hostname} is not an allowed host; add it to runtime.browser.allowedHosts `
        + `(currently: ${allowed.join(', ')})`,
      url: raw,
    }
  }
  return { allowed: true, rule: null, reason: null, url: raw }
}

/** Local-time stamp that is safe in a file name on every platform. */
function stamp(now = Date.now()) {
  const date = new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${String(date.getMilliseconds()).padStart(3, '0')}`
}

function clip(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function boxText(box) {
  if (!box) return 'none'
  return `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`
}

/** Short label for the audit trail when the caller addressed an element several ways. */
function targetLabel(args) {
  if (args?.text) return clip(args.text, 120)
  if (args?.css) return clip(args.css, 120)
  if (Number.isInteger(args?.index)) return `#${args.index}`
  return ''
}

/**
 * Build the runtime-control layer for one plugin mount.
 *
 * @param {{
 *   config: object,
 *   stateRoot: string,
 *   auditor?: { record: (event: object) => Promise<unknown> } | null,
 *   warn?: (message: string) => void,
 *   now?: () => number,
 *   env?: NodeJS.ProcessEnv,
 *   openBrowserImpl?: typeof openBrowser,
 *   attachBrowserImpl?: typeof attachBrowser,
 * }} options
 */
export function createRuntimeControl({
  config = {},
  stateRoot,
  auditor = null,
  warn = () => {},
  now = () => Date.now(),
  env = process.env,
  openBrowserImpl = openBrowser,
  attachBrowserImpl = attachBrowser,
} = {}) {
  const enabled = config?.enabled === true
  const browserConfig = {
    enabled: true,
    headless: true,
    executablePath: null,
    attachPort: null,
    userDataDir: null,
    allowedHosts: [],
    ...(config?.browser ?? {}),
  }
  const desktopConfig = { enabled: false, allowActivation: false, ...(config?.desktop ?? {}) }
  const allowActivation = desktopConfig.allowActivation === true || config?.allowActivation === true
  const stopFile = typeof config?.stopFile === 'string' && config.stopFile.trim()
    ? path.resolve(config.stopFile.trim())
    : path.join(stateRoot, 'runtime', 'STOP')
  const shotDir = typeof config?.shotDir === 'string' && config.shotDir.trim()
    ? path.resolve(config.shotDir.trim())
    : path.join(stateRoot, 'runtime', 'shots')

  /** Live browser, created on first use and reused until `browser_close`. */
  let session = null
  let openingBrowser = null
  const actors = new AsyncLocalStorage()
  const handoffs = new Map()
  const scopedTabs = new Map()
  const loginTargets = new Map()
  const latestLogin = new WeakMap()
  const tabViews = new WeakMap()

  /** True when the emergency stop is set, plus the evidence that says so. */
  function stopState() {
    if (/^(1|true|yes|on)$/i.test(String(env.DSH_RUNTIME_STOP ?? ''))) {
      return { stopped: true, source: 'DSH_RUNTIME_STOP=1' }
    }
    if (existsSync(stopFile)) return { stopped: true, source: stopFile }
    return { stopped: false, source: null }
  }

  async function record(event) {
    if (!auditor || typeof auditor.record !== 'function') return null
    try {
      return await auditor.record({
        kind: event.kind ?? 'runtime',
        action: event.action,
        target: event.target ?? null,
        decision: event.decision ?? 'allow',
        result: event.result ?? 'ok',
        durationMs: event.durationMs ?? 0,
        rule: event.rule ?? null,
        source: 'runtime',
        meta: event.meta ?? {},
      })
    } catch (error) {
      warn(`audit: cannot record ${event.action}: ${error?.message ?? error}`)
      return null
    }
  }

  /** Throw when the stop switch is set. The caller's wrapper records the refusal. */
  function assertNotStopped() {
    const state = stopState()
    if (!state.stopped) return
    throw new RuntimeRefusal({
      message: `runtime control is stopped by ${state.source}. The action did not run.\n`
        + 'hint: delete that file (or unset DSH_RUNTIME_STOP) only when you are ready to allow actions again.',
      rule: 'runtime/stopped',
      decision: 'deny',
      meta: { stop: state.source },
    })
  }

  function shotPath(prefix) {
    return path.join(shotDir, `${prefix}-${stamp(now())}-${randomUUID().slice(0, 6)}.png`)
  }

  function shotFile(requested, prefix) {
    return typeof requested === 'string' && requested.trim() ? path.resolve(requested.trim()) : shotPath(prefix)
  }

  function clamp(value, min, max, fallback) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
  }

  /**
   * Say which connection an action used. Written into every browser audit line,
   * so `attach` and a profile this plugin launched can never be confused.
   */
  function markSession(live, meta) {
    const attach = live.mode === 'attach'
    meta.session = attach ? 'attach' : 'launch'
    meta.port = live.port ?? null
    if (attach) {
      if (live.browser) meta.browser = live.browser
      if (live.attachedUrl) meta.tab = live.attachedUrl
      return
    }
    if (live.userDataDir) meta.profile = live.userDataDir
    meta.persistentProfile = live.persistentProfile === true
    meta.headless = live.headless === true
  }

  function describeSession(live) {
    if (!live) return 'none'
    if (live.mode === 'attach') {
      return `attached to 127.0.0.1:${live.port}${live.browser ? ` (${live.browser})` : ''}`
        + `${live.attachedUrl ? ` tab ${live.attachedUrl}` : ''}`
    }
    return `launched on port ${live.port} with ${live.persistentProfile ? 'persistent' : 'temporary'} `
      + `profile ${live.userDataDir}`
  }

  /** Explain an attach failure in terms the user can act on; never fall back. */
  function attachFailure(port, error) {
    const detail = error?.message ?? String(error)
    return new RuntimeSetupError({
      rule: 'runtime/attach-failed',
      meta: { port },
      message: [
        `cannot attach to the browser on 127.0.0.1:${port}: ${detail}`,
        'hint: that browser must already be listening for DevTools on the port, and an already-running browser ignores the flag; start a separate instance:',
        `  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=${port} --user-data-dir="%TEMP%\\dsh-attach-profile"`,
        `  or "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=${port} --user-data-dir="%TEMP%\\dsh-attach-profile"`,
        `keep runtime.browser.attachPort at ${port}, or set it to null so the plugin launches its own isolated profile.`,
        'no browser was launched in its place: attach never falls back to a new profile.',
      ].join('\n'),
    })
  }

  async function launchSession() {
    if (browserConfig.attachPort !== null && browserConfig.attachPort !== undefined) {
      const port = Number(browserConfig.attachPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`runtime.browser.attachPort must be a port number, not ${JSON.stringify(browserConfig.attachPort)}`)
      }
      try {
        session = await attachBrowserImpl({ port })
      } catch (error) {
        throw attachFailure(port, error)
      }
      warn(
        `runtime: attached to the browser on 127.0.0.1:${port}`
        + `${session.attachedUrl ? ` (tab ${session.attachedUrl})` : ''}; no new profile was created`,
      )
      return session
    }
    session = await openBrowserImpl({
      executablePath: browserConfig.executablePath ?? null,
      headless: browserConfig.headless !== false,
      userDataDir: browserConfig.userDataDir ?? null,
    })
    warn(
      `runtime: launched ${session.executablePath} on port ${session.port} with `
      + `${session.persistentProfile ? 'persistent' : 'temporary'} profile ${session.userDataDir}`,
    )
    return session
  }

  async function currentBrowser(start = false) {
    const scope = actors.getStore()?.scope
    const key = currentTabKey()
    if (key && scopedTabs.has(key)) return scopedTabs.get(key)
    if (!session) {
      if (!start && key) throw new Error('no browser is open; call browser_open first')
      openingBrowser ??= launchSession().finally(() => { openingBrowser = null })
      await openingBrowser
    }
    if (!key) return session
    if (!start) throw new Error('no browser tab is open for this work; call browser_open first')
    if (!session.openTab) throw new Error('the execution browser does not support opening a task tab')
    if (scopedTabs.has(key)) return scopedTabs.get(key)
    const root = session
    const tab = root.openTab().then(page => ({ ...root, ...page, scope })).catch(error => {
      scopedTabs.delete(key)
      throw error
    })
    scopedTabs.set(key, tab)
    return tab
  }

  function currentTabKey() {
    const scope = actors.getStore()?.scope
    return scope ? JSON.stringify([scope.runId, scope.subtaskId]) : null
  }

  function invalidateLogin(live) {
    const id = latestLogin.get(live)
    if (id) loginTargets.delete(id)
    latestLogin.delete(live)
  }

  async function closeTab(key) {
    const promised = scopedTabs.get(key)
    scopedTabs.delete(key)
    if (!promised) return
    const live = await promised.catch(() => null)
    if (!live) return
    invalidateLogin(live)
    await tabViews.get(live)?.close()
    live.closed = true
    await live.close()
  }

  function assertPageAllowed(url) {
    const verdict = checkNavigation(url, { allowedHosts: browserConfig.allowedHosts })
    if (!verdict.allowed) throw new RuntimeRefusal({
      message: verdict.reason, rule: verdict.rule, decision: 'deny', target: verdict.url,
    })
  }

  // ---------------------------------------------------------------------------
  // In-panel live view
  //
  // The sign-in page a person needs to finish belongs to the run's own browser.
  // Mirroring it into a second browser would put the cookie in the wrong profile,
  // so the panel receives JPEG frames from this CDP tab and sends clicks and keys
  // straight back. A login done here is already in the session the next action
  // uses; nothing is copied or replayed.
  // ---------------------------------------------------------------------------

  function createLiveView(getSession) {
    const liveView = {
      listeners: new Set(),
      offEvent: null,
      started: false,
      requested: null,
      applied: null,
      original: null,
      stateTimer: null,
    }
    let transition = Promise.resolve()
    const queueView = action => {
      const next = transition.then(action)
      transition = next.catch(() => {})
      return next
    }

    /** The browser the run is using, or null once it has been closed. */
    function liveSession() {
      const live = getSession()
      return live && !live.closed && live.page && live.connection ? live : null
    }

    function liveEmit(frame) {
      for (const listener of [...liveView.listeners]) {
        try {
          listener(frame)
        } catch {
          // The SSE socket removes itself on close.
        }
      }
    }

    async function liveState() {
      const live = liveSession()
      if (!live) return { available: false, viewing: false, reason: '执行浏览器已关闭或尚未打开。' }
      const where = await pageIdentity(live.page)
      const size = await live.page
        .evaluate('({ width: innerWidth, height: innerHeight })')
        .catch(() => null)
      return {
        available: true,
        viewing: liveView.started,
        mode: live.mode,
        headless: live.headless === true,
        url: where.url,
        title: where.title,
        width: size?.width ?? null,
        height: size?.height ?? null,
      }
    }

    async function emitLiveState() {
      if (!liveView.listeners.size) return
      liveEmit({ type: 'state', ...(await liveState()) })
    }

    function scheduleLiveState() {
      if (liveView.stateTimer) return
      liveView.stateTimer = setTimeout(() => {
        liveView.stateTimer = null
        void emitLiveState().catch(() => {})
      }, 150)
      liveView.stateTimer.unref?.()
    }

    /** Resize only a launched page; an attached tab keeps the size the person chose. */
    async function applyLiveViewport() {
      const live = liveSession()
      if (!live || live.mode === 'attach' || !liveView.requested) return
      const width = clamp(liveView.requested.width, 320, 1200, 420)
      const height = clamp(liveView.requested.height, 480, 1400, 760)
      if (liveView.applied?.width === width && liveView.applied?.height === height) return
      await live.connection.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      }, { sessionId: live.page.sessionId })
      liveView.applied = { width, height }
    }

    async function startLiveView() {
      const live = liveSession()
      if (!live) throw new Error('执行浏览器已关闭，无法在面板中打开登录页。')
      if (liveView.started) return
      liveView.original = await live.page
        .evaluate('({ width: innerWidth, height: innerHeight })')
        .catch(() => null)
      liveView.offEvent = live.connection.onEvent(event => {
        if (event.sessionId && event.sessionId !== live.page.sessionId) return
        if (event.method === 'Page.screencastFrame') {
          liveEmit({ type: 'frame', data: event.params.data, metadata: event.params.metadata })
          live.connection.send('Page.screencastFrameAck', {
            sessionId: event.params.sessionId,
          }, { sessionId: live.page.sessionId }).catch(() => {})
          return
        }
        if (event.method === 'Page.frameNavigated' && !event.params?.frame?.parentId) {
          scheduleLiveState()
          return
        }
        if (event.method === 'Inspector.detached') {
          liveEmit({ type: 'gone', message: '执行浏览器已断开，登录页不再可用。' })
        }
      })
      try {
        await live.connection.send('Page.bringToFront', {}, { sessionId: live.page.sessionId }).catch(() => {})
        await applyLiveViewport()
        // A login page is mostly static; one frame per paint change is enough and
        // keeps a narrow sidebar cheap.
        await live.connection.send('Page.startScreencast', {
          format: 'jpeg', quality: 62, maxWidth: 1000, maxHeight: 1400, everyNthFrame: 1,
        }, { sessionId: live.page.sessionId })
        liveView.started = true
        await emitLiveState()
      } catch (error) {
        await stopLiveView().catch(() => {})
        throw error
      }
    }

    async function stopLiveView() {
      const live = liveSession()
      if (liveView.stateTimer) {
        clearTimeout(liveView.stateTimer)
        liveView.stateTimer = null
      }
      if (liveView.offEvent) {
        liveView.offEvent()
        liveView.offEvent = null
      }
      if (liveView.started && live) {
        await live.connection.send('Page.stopScreencast', {}, {
          sessionId: live.page.sessionId,
        }).catch(() => {})
      }
      liveView.started = false
      if (live && live.mode !== 'attach' && liveView.original) {
        await live.connection.send('Emulation.setDeviceMetricsOverride', {
          width: liveView.original.width,
          height: liveView.original.height,
          deviceScaleFactor: 1,
          mobile: false,
        }, { sessionId: live.page.sessionId }).catch(() => {})
      }
      liveView.applied = null
      liveView.requested = null
    }

    /** Attach one SSE viewer; the first one starts the stream, the last stops it. */
    function attachLiveView(listener, viewport) {
      if (viewport) liveView.requested = viewport
      liveView.listeners.add(listener)
      if (liveView.listeners.size === 1) {
        queueView(() => liveView.listeners.size && startLiveView()).catch(error => {
          liveEmit({ type: 'error', message: error?.message ?? String(error) })
        })
      } else {
        liveState()
          .then(state => listener({ type: 'state', ...state }))
          .catch(() => {})
      }
      return () => {
        liveView.listeners.delete(listener)
        if (!liveView.listeners.size) {
          queueView(() => !liveView.listeners.size && stopLiveView())
            .catch(error => warn(`runtime: cannot stop the live view: ${error?.message ?? error}`))
        }
      }
    }

    function liveNumber(value, fallback) {
      const number = Number(value)
      return Number.isFinite(number) ? number : fallback
    }

    function livePoint(event) {
      return {
        x: Math.round(clamp(liveNumber(event.x, 0), 0, 20000, 0)),
        y: Math.round(clamp(liveNumber(event.y, 0), 0, 20000, 0)),
      }
    }

    /** Forward one pointer, key, or viewport action into the run's browser. */
    async function liveInput(event = {}) {
      const live = liveSession()
      if (!live) throw new Error('执行浏览器已关闭，无法继续在面板中操作。')
      if (live.scope) assertPageAllowed((await pageIdentity(live.page)).url)
      const kind = String(event.kind ?? '')
      const send = (method, params) => live.connection.send(method, params, { sessionId: live.page.sessionId })
      if (kind === 'resize') {
        liveView.requested = {
          width: clamp(liveNumber(event.width, 420), 320, 1200, 420),
          height: clamp(liveNumber(event.height, 760), 480, 1400, 760),
        }
        await applyLiveViewport()
        return { width: liveView.requested.width, height: liveView.requested.height }
      }
      if (kind === 'reload') {
        await send('Page.reload', {})
        return { reloaded: true }
      }
      if (kind === 'focus') {
        await send('Page.bringToFront', {})
        return { focused: true }
      }
      if (kind === 'text') {
        const text = String(event.text ?? '').slice(0, 4000)
        if (text) await send('Input.insertText', { text })
        return { inserted: text.length }
      }
      if (kind === 'key') {
        const key = String(event.key ?? '')
        const code = String(event.code ?? '')
        const keyCode = clamp(liveNumber(event.keyCode, 0), 0, 255, 0)
        const modifiers = clamp(liveNumber(event.modifiers, 0), 0, 15, 0)
        const text = typeof event.text === 'string' ? event.text.slice(0, 8) : ''
        const base = {
          key, code, modifiers, autoRepeat: false, location: 0,
          windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
        }
        const down = () => send('Input.dispatchKeyEvent', {
          ...base, type: text ? 'keyDown' : 'rawKeyDown',
          ...(text ? { text, unmodifiedText: text } : {}),
        })
        const up = () => send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
        if (event.type === 'up') await up()
        else if (event.type === 'press') {
          await down()
          await up()
        } else await down()
        return { key, type: event.type ?? 'down' }
      }
      if (kind === 'mouse') {
        const { x, y } = livePoint(event)
        const move = event.type === 'move'
        const key = ['left', 'middle', 'right'].includes(event.button) ? event.button : 'left'
        await send('Input.dispatchMouseEvent', {
          type: move ? 'mouseMoved' : event.type === 'down' ? 'mousePressed' : 'mouseReleased',
          x, y,
          button: move ? 'none' : key,
          buttons: clamp(liveNumber(event.buttons, 0), 0, 7, 0),
          clickCount: clamp(liveNumber(event.clickCount, 1), 1, 3, 1),
          modifiers: clamp(liveNumber(event.modifiers, 0), 0, 15, 0),
          pointerType: 'mouse',
        })
        return { x, y }
      }
      if (kind === 'wheel') {
        const { x, y } = livePoint(event)
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x, y,
          deltaX: liveNumber(event.deltaX, 0),
          deltaY: liveNumber(event.deltaY, 0),
          modifiers: clamp(liveNumber(event.modifiers, 0), 0, 15, 0),
          pointerType: 'mouse',
        })
        return { x, y }
      }
      throw new Error(`unknown live input "${kind}"`)
    }
    return {
      status: liveState, attach: attachLiveView, input: liveInput, stop: () => queueView(stopLiveView),
      async close() {
        liveEmit({ type: 'gone', message: '执行浏览器已关闭。' })
        await queueView(stopLiveView)
      },
    }
  }

  const defaultView = createLiveView(() => session)

  function findLogin(id) {
    const live = typeof id === 'string' ? loginTargets.get(id) : null
    if (!live || live.closed || latestLogin.get(live) !== id) return null
    return live
  }

  function loginView(id) {
    if (id === undefined || id === null) return defaultView
    const live = findLogin(id)
    if (!live) throw new Error('该任务的登录页已失效，请从任务重新打开登录。')
    if (!tabViews.has(live)) tabViews.set(live, createLiveView(() => live))
    return tabViews.get(live)
  }

  async function verifyLogin(id) {
    const live = findLogin(id)
    if (!live) throw new Error('该任务的登录页已失效，请从任务重新打开登录。')
    assertNotStopped()
    assertPageAllowed((await pageIdentity(live.page)).url)
    if (await live.page.humanGate()) throw new Error('此页面仍在等待扫码或验证。请在这个页面完成登录后重试。')
    await loginView(id).stop()
  }

  /** Report the human check the page is waiting for, or null when it is absent. */
  async function gateOf(page) {
    if (!page || typeof page.humanGate !== 'function') return null
    try {
      return await page.humanGate()
    } catch {
      // A page that is mid-navigation cannot be inspected; the next action retries.
      return null
    }
  }

  async function pageIdentity(page) {
    try {
      const info = await page.evaluate('({ url: location.href, title: document.title })')
      return { url: info?.url ?? null, title: info?.title ?? null }
    } catch {
      return { url: null, title: null }
    }
  }

  /** The hand-off text: what stopped, where the person finishes it, what to call next. */
  async function attentionFor({ gate, live, target = null, screenshot = null, waitedMs = null }) {
    const where = await pageIdentity(live.page)
    const mode = live.scope
      ? 'open the login card for this task in the Superagent conversation and finish the check in its browser tab'
      : live.mode === 'attach'
      ? `this plugin is attached to the browser on 127.0.0.1:${live.port}, so finish the step in that tab`
      : live.headless === false
        ? 'the launched browser window is visible; finish the step in that window'
        : 'the browser was launched headless, so there is no window to use: rerun with browser.headless:false, '
          + 'or start your own browser with --remote-debugging-port and set browser.attachPort'
    const persistent = live.mode !== 'attach' && live.persistentProfile
      ? `this profile is kept at ${live.userDataDir}, so a sign-in completed now is reused on later runs`
      : null
    const message = [
      `the page is asking for a person: ${gate.label} (matched "${gate.matched}").`,
      `page: ${where.url ?? '(unknown)'}${where.title ? ` — ${where.title}` : ''}`,
      'why it stopped: automation must not solve a check, type a one-time code, or scan a QR code; the action stopped short of it.',
      `what to do: ${mode}.`,
      persistent,
      'then: call browser_await_human; it returns ok once the check is gone and the run continues. A pending check is not a failure.',
      target ? `target: ${clip(target, 120)}` : null,
      waitedMs === null || waitedMs === undefined ? null : `waited: ${waitedMs}ms`,
      screenshot ? `screenshot: ${screenshot}` : null,
    ].filter(Boolean).join('\n')
    let url = null
    try {
      const pageUrl = new URL(where.url)
      if (['http:', 'https:'].includes(pageUrl.protocol)) {
        url = `${pageUrl.origin}${pageUrl.pathname}`.slice(0, 500)
      }
    } catch {}
    const actor = actors.getStore()
    const handoff = { kind: gate.kind, url, headless: live.mode !== 'attach' && live.headless !== false }
    if (actor?.id) {
      invalidateLogin(live)
      handoff.id = randomUUID()
      latestLogin.set(live, handoff.id)
      loginTargets.set(handoff.id, live)
    }
    return { message, handoff }
  }

  /** Throw a hand-off when a state-changing action lands on a human check. */
  async function raiseIfGated(live, { target = null, screenshot = null } = {}) {
    const gate = await gateOf(live.page)
    if (!gate) return
    const { message, handoff } = await attentionFor({ gate, live, target, screenshot })
    throw new RuntimeAttention({
      message,
      gate,
      target: target ?? gate.kind,
      meta: { handoff },
    })
  }

  /**
   * The single place an action is allowed to run.
   *
   * The stop switch is checked first, the work runs, and the outcome is written
   * to the audit trail exactly once. A {@link RuntimeRefusal} becomes a blocked
   * audit line plus an `[error]` result the model can read; any other throw
   * becomes a `result: error` line so a crash is never mistaken for success.
   */
  async function guarded({ kind, action, target }, work) {
    const started = now()
    const meta = {}
    const actor = actors.getStore()?.id
    try {
      assertNotStopped()
      const value = await work(meta)
      if (actor && kind === 'runtime.browser' && ['open', 'close', 'await_human'].includes(action)) {
        handoffs.delete(actor)
      }
      await record({ kind, action, target, decision: 'allow', result: 'ok', durationMs: now() - started, meta })
      return value
    } catch (error) {
      if (error instanceof RuntimeAttention) {
        await record({
          kind: 'attention',
          action,
          target: error.target ?? target,
          decision: 'attention',
          result: 'needs-human',
          rule: 'runtime/needs-human',
          durationMs: now() - started,
          meta: {
            ...meta,
            ...error.meta,
            gate: error.gate?.kind ?? null,
            matched: error.gate?.matched ?? null,
          },
        })
        if (actor && error.meta.handoff) {
          if (handoffs.size >= 256) handoffs.delete(handoffs.keys().next().value)
          handoffs.set(actor, error.meta.handoff)
        }
        return `[attention] ${error.message}`
      }
      if (error instanceof RuntimeSetupError) {
        await record({
          kind,
          action,
          target,
          decision: 'allow',
          result: 'error',
          rule: error.rule,
          durationMs: now() - started,
          meta: { ...meta, ...error.meta, error: error.message },
        })
        return `[error] ${error.message}`
      }
      if (error instanceof RuntimeRefusal) {
        await record({
          kind,
          action,
          target: error.target ?? target,
          decision: error.decision,
          result: 'blocked',
          rule: error.rule,
          durationMs: now() - started,
          meta: { ...meta, ...error.meta },
        })
        return `[error] ${error.message}`
      }
      await record({
        kind,
        action,
        target,
        decision: 'allow',
        result: 'error',
        durationMs: now() - started,
        meta: { ...meta, error: String(error?.message ?? error) },
      })
      return describeError(error)
    }
  }

  /** Browser actions: open or reuse the session, then run against its page. */
  function withPage(action, target, work) {
    return guarded({ kind: 'runtime.browser', action, target }, async meta => {
      const live = await currentBrowser(action === 'open')
      if (live.scope && action !== 'open') assertPageAllowed((await pageIdentity(live.page)).url)
      if (action === 'open') invalidateLogin(live)
      markSession(live, meta)
      return work(live, meta)
    })
  }

  /** Describe the element a call is about, without needing the caller to know its index. */
  async function pickElement(page, { index = null, css = null, text = null, role = null }) {
    if (Number.isInteger(index) && index >= 0) {
      const found = await page.evaluate(`(() => {
        const el = document.querySelector('[data-dsh-el="${index}"]')
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return { index: ${index}, label: (el.innerText || el.textContent || '').trim().slice(0, 120), type: (el.getAttribute('type') || '').toLowerCase(), box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      })()`)
      if (!found) throw new Error(`element index ${index} is not on the page any more; call browser_elements again`)
      return found
    }
    if (css) {
      const found = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(String(css))})
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center' })
        const rect = el.getBoundingClientRect()
        return { index: null, label: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 120), type: (el.getAttribute('type') || '').toLowerCase(), box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
      })()`)
      if (!found) throw new Error(`no element matches the selector ${css}`)
      return found
    }
    if (!text && !role) throw new Error('name the target with index, css, text, or role')
    const listing = await page.elements()
    const needle = text ? String(text).toLowerCase() : null
    const wantedRole = role ? String(role).toLowerCase() : null
    const matches = listing.elements.filter(item => {
      if (wantedRole && String(item.role ?? '').toLowerCase() !== wantedRole) return false
      if (!needle) return true
      return `${item.name ?? ''} ${item.value ?? ''}`.toLowerCase().includes(needle)
    })
    if (matches.length === 0) {
      throw new Error(
        `no ${role ? `${role} ` : ''}element containing ${JSON.stringify(text ?? '')}; `
        + 'call browser_elements to see what the page exposes',
      )
    }
    const visible = matches.find(item => item.inViewport) ?? matches[0]
    return {
      index: visible.index,
      label: clip(visible.name, 120),
      role: visible.role,
      type: visible.type,
      box: visible.bbox,
    }
  }

  async function shoot(page, prefix, fullPage = false) {
    return page.screenshot({ path: shotPath(prefix), fullPage })
  }

  /** Gate shared by browser and desktop actions whose label may be irreversible. */
  function assertConfirmable(label, confirm, extra = {}) {
    const intent = irreversibleIntent(label)
    if (!intent) return
    if (confirm === true) return
    throw new RuntimeRefusal({
      message: `${JSON.stringify(clip(label, 80))} looks irreversible (matched "${intent}"), so nothing ran.\n`
        + 'hint: repeat the call with confirm: true if it is genuinely intended.',
      rule: 'runtime/irreversible',
      decision: 'confirm',
      target: String(label),
      meta: { matched: intent, ...extra },
    })
  }

  function assertActivationAllowed(activate) {
    if (activate !== true || allowActivation) return
    throw new RuntimeRefusal({
      message: 'activation is disabled: runtime.desktop.allowActivation is false.\n'
        + 'hint: pass window so the action can be posted in the background, or ask the user to allow activation.',
      rule: 'runtime/activation-disabled',
      decision: 'deny',
    })
  }

  const browserTools = browserConfig.enabled === false ? [] : [
    {
      name: 'browser_open',
      description:
        'Open a page in a Chromium-family browser: either the browser this plugin launches with its own profile, '
        + 'or the one the user started with --remote-debugging-port when runtime.browser.attachPort is set. '
        + 'Only http/https on the configured hosts (loopback by default) are reachable; file:// is refused. '
        + 'Returns the final URL, title, viewport, and a screenshot path. A sign-in, CAPTCHA, SMS, or QR check '
        + 'comes back as [attention] with how to hand over, not as a failure.',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
        headless: { type: 'boolean', description: 'Run without a visible window (default from config).' },
        width: { type: 'number', description: 'Viewport width in CSS pixels (default 1280).' },
        height: { type: 'number', description: 'Viewport height in CSS pixels (default 900).' },
      },
      required: ['url'],
      async execute(args = {}) {
        const verdict = checkNavigation(args.url, { allowedHosts: browserConfig.allowedHosts })
        if (!verdict.allowed) {
          await record({
            kind: 'runtime.browser',
            action: 'open',
            target: verdict.url,
            decision: 'deny',
            result: 'blocked',
            rule: verdict.rule,
            meta: { reason: verdict.reason },
          })
          return `[error] ${verdict.reason}\nrule: ${verdict.rule}`
        }
        return withPage('open', verdict.url, async (live, meta) => {
          const page = live.page
          // An attached tab is the user's window; re-applying a fixed viewport
          // would resize it under them.
          await page.init({
            width: Number(args.width) || 1280,
            height: Number(args.height) || 900,
            emulateViewport: live.mode !== 'attach',
          })
          const loaded = await page.goto(verdict.url)
          if (live.scope) assertPageAllowed(loaded.url)
          const shot = await shoot(page, 'open')
          const info = await page.evaluate('({ width: innerWidth, height: innerHeight })')
          meta.url = loaded.url
          meta.title = loaded.title
          meta.screenshot = shot.path
          await raiseIfGated(live, { target: loaded.url, screenshot: shot.path })
          return [
            'browser_open: ok',
            `url: ${loaded.url}`,
            `title: ${loaded.title}`,
            `viewport: ${info.width}×${info.height}`,
            `screenshot: ${shot.path}`,
          ].join('\n')
        })
      },
    },
    {
      name: 'browser_elements',
      description:
        'List the actionable elements on the current page with a stable index, accessible name, role, and '
        + 'bounding box. Filter by visible text, role, or CSS selector. Feed the index to browser_click or browser_type.',
      properties: {
        text: { type: 'string', description: 'Keep elements whose name contains this text, ignoring case.' },
        role: { type: 'string', description: 'Keep elements with exactly this role (button, link, textbox, checkbox…).' },
        limit: { type: 'number', description: 'Maximum rows to print (default 60).' },
      },
      async execute(args = {}) {
        return withPage('elements', null, async live => {
          const listing = await live.page.elements()
          const needle = args.text ? String(args.text).toLowerCase() : null
          const role = args.role ? String(args.role).toLowerCase() : null
          const rows = listing.elements.filter(item => {
            if (role && String(item.role ?? '').toLowerCase() !== role) return false
            if (!needle) return true
            return `${item.name ?? ''} ${item.value ?? ''}`.toLowerCase().includes(needle)
          })
          const limit = Math.max(1, Math.min(400, Number(args.limit) || 60))
          if (rows.length === 0) {
            return `browser_elements: 0 matches of ${listing.elements.length} element(s) on ${listing.url}`
          }
          const lines = [
            `browser_elements: ${rows.length} of ${listing.elements.length} element(s) on ${listing.url}`,
            `title: ${listing.title}`,
            `scroll: ${listing.scroll.x},${listing.scroll.y}  viewport: ${listing.viewport.width}×${listing.viewport.height}`,
          ]
          for (const item of rows.slice(0, limit)) {
            lines.push(
              `  [${item.index}] ${String(item.role ?? '-').padEnd(10)} `
              + `${boxText(item.bbox).padEnd(20)} ${item.inViewport ? 'in-view' : 'offscreen'} `
              + `${item.disabled ? 'disabled ' : ''}${clip(item.name, 70) || '(no name)'}`,
            )
          }
          if (rows.length > limit) lines.push(`  … ${rows.length - limit} more (raise limit to see them)`)
          return lines.join('\n')
        })
      },
    },
    {
      name: 'browser_click',
      description:
        'Click one element by index, CSS selector, visible text, or role. Returns the element box and a fresh '
        + 'screenshot taken after the click, so the result is evidence rather than a claim. Actions whose label '
        + 'means submit/delete/pay need confirm: true.',
      properties: {
        index: { type: 'number', description: 'Element index from browser_elements.' },
        css: { type: 'string', description: 'CSS selector, used when index is absent.' },
        text: { type: 'string', description: 'Visible text or accessible name to match, ignoring case.' },
        role: { type: 'string', description: 'Role to disambiguate a text match.' },
        confirm: { type: 'boolean', description: 'Confirm an irreversible action (submit, delete, pay). Required for those labels.' },
        screenshot: { type: 'boolean', description: 'Capture a screenshot after clicking (default true).' },
      },
      async execute(args = {}) {
        return withPage('click', targetLabel(args), async (live, meta) => {
          const page = live.page
          const target = await pickElement(page, args)
          if (target.type === 'file') {
            throw new RuntimeRefusal({
              message: `${JSON.stringify(clip(target.label, 60) || 'this file input')} is a file input, and uploads are refused.\n`
                + 'hint: uploading would send a local file to a page; add the file through the workspace instead, '
                + 'or ask the user to pick it manually.',
              rule: 'runtime/file-upload',
              decision: 'deny',
              target: clip(target.label, 120) || 'file input',
            })
          }
          assertConfirmable(target.label, args.confirm, { index: target.index })
          let clicked
          if (target.index !== null && target.index !== undefined) clicked = await page.clickIndex(target.index)
          else clicked = await page.clickAt({ x: target.box.x + target.box.width / 2, y: target.box.y + target.box.height / 2, box: target.box })
          await page.waitFor({ sleepMs: 250 })
          const url = await page.evaluate('location.href')
          meta.url = url
          meta.index = target.index
          if (args.screenshot !== false) {
            const shot = await shoot(page, 'click')
            meta.screenshot = shot.path
          }
          await raiseIfGated(live, { target: target.label, screenshot: meta.screenshot ?? null })
          const lines = [
            'browser_click: ok',
            `target: [${target.index ?? 'css'}] ${clip(target.label, 80) || '(no name)'}`,
            `box: ${boxText(clicked.box ?? target.box)}  clicked at ${clicked.x},${clicked.y}`,
            `url: ${url}`,
          ]
          if (meta.screenshot) lines.push(`screenshot: ${meta.screenshot}`)
          return lines.join('\n')
        })
      },
    },
    {
      name: 'browser_type',
      description:
        'Focus an element and insert text through the browser input pipeline, then optionally press Enter. '
        + 'Returns the value the page reports and a screenshot.',
      properties: {
        index: { type: 'number', description: 'Element index from browser_elements.' },
        css: { type: 'string', description: 'CSS selector, used when index is absent.' },
        text: { type: 'string', description: 'Visible text or accessible name of the field.' },
        value: { type: 'string', description: 'Text to insert.' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
        screenshot: { type: 'boolean', description: 'Capture a screenshot after typing (default true).' },
      },
      required: ['value'],
      async execute(args = {}) {
        return withPage('type', targetLabel(args), async (live, meta) => {
          const page = live.page
          const target = await pickElement(page, args)
          const result = await page.typeInto({ index: target.index, text: String(args.value ?? ''), submit: args.submit === true })
          await page.waitFor({ sleepMs: 200 })
          const readBack = await page.evaluate(`(() => {
            const el = document.activeElement
            if (!el) return { tag: null, value: null }
            return { tag: el.tagName.toLowerCase(), value: typeof el.value === 'string' ? el.value.slice(0, 200) : (el.innerText || '').slice(0, 200) }
          })()`)
          const url = await page.evaluate('location.href')
          meta.url = url
          meta.index = target.index
          if (args.screenshot !== false) {
            const shot = await shoot(page, 'type')
            meta.screenshot = shot.path
          }
          if (args.submit === true) await raiseIfGated(live, { target: target.label, screenshot: meta.screenshot ?? null })
          const shown = target.type === 'password' ? '•••••• (masked)' : JSON.stringify(readBack.value)
          const lines = [
            'browser_type: ok',
            `target: ${clip(target.label, 80)}  box: ${boxText(target.box)}`,
            `inserted: ${result.inserted} character(s)${result.submit ? ', Enter pressed' : ''}`,
            `focused value: ${shown}`,
            `url: ${url}`,
          ]
          if (meta.screenshot) lines.push(`screenshot: ${meta.screenshot}`)
          return lines.join('\n')
        })
      },
    },
    {
      name: 'browser_screenshot',
      description: 'Capture the current page as a PNG and return its path, pixel size, and byte size.',
      properties: {
        path: { type: 'string', description: 'Optional destination file; defaults to the runtime screenshot directory.' },
        full_page: { type: 'boolean', description: 'Capture beyond the viewport (default false).' },
      },
      async execute(args = {}) {
        return withPage('screenshot', null, async live => {
          const file = shotFile(live.scope ? null : args.path, 'page')
          const shot = await live.page.screenshot({ path: file, fullPage: args.full_page === true })
          return [
            'browser_screenshot: ok',
            `path: ${shot.path}`,
            `viewport: ${shot.width}×${shot.height}  bytes: ${shot.bytes}`,
            `url: ${await live.page.evaluate('location.href')}`,
          ].join('\n')
        })
      },
    },
    {
      name: 'browser_script',
      description:
        'Evaluate one JavaScript expression in the page and return its JSON value. Use it for reads; clicks and '
        + 'typing belong to browser_click and browser_type, where the audit trail can name the element.',
      properties: {
        expression: { type: 'string', description: 'Expression to evaluate, e.g. document.title.' },
        await_promise: { type: 'boolean', description: 'Wait for a returned Promise (default true).' },
      },
      required: ['expression'],
      async execute(args = {}) {
        return withPage('script', clip(args.expression, 140), async live => {
          const value = await live.page.evaluate(String(args.expression ?? ''), { awaitPromise: args.await_promise !== false })
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
          const clipped = text.length > 8000 ? `${text.slice(0, 8000)}\n[truncated ${text.length - 8000} character(s)]` : text
          return `browser_script: ok\nresult: ${clipped}`
        })
      },
    },
    {
      name: 'browser_wait',
      description: 'Wait for visible text, a CSS selector, a URL fragment, or a fixed delay before the next action.',
      properties: {
        text: { type: 'string', description: 'Body text that must appear.' },
        css: { type: 'string', description: 'Selector that must match.' },
        url_contains: { type: 'string', description: 'Fragment the URL must contain.' },
        milliseconds: { type: 'number', description: 'Fixed delay instead of a condition.' },
        timeout_ms: { type: 'number', description: 'Give up after this long (default 10000).' },
      },
      async execute(args = {}) {
        return withPage('wait', clip(args.text ?? args.css ?? args.url_contains ?? '', 120), async live => {
          const timeoutMs = Math.max(100, Number(args.timeout_ms) || 10000)
          const result = await live.page.waitFor({
            text: args.text ?? null,
            css: args.css ?? null,
            urlContains: args.url_contains ?? null,
            timeoutMs,
            sleepMs: Number.isFinite(Number(args.milliseconds)) ? Number(args.milliseconds) : null,
          })
          return `browser_wait: ok after ${result.waited}ms\ncondition: ${result.condition}\nurl: ${await live.page.evaluate('location.href')}`
        })
      },
    },
    {
      name: 'browser_await_human',
      description:
        'Wait for a person to clear a sign-in, CAPTCHA, SMS code, two-factor, or QR-login check in the page, then '
        + 'report that automation may continue. It never solves, types, or scans the check. A check still pending at '
        + 'the timeout comes back as [attention]; that is a hand-off, not a failed run.',
      properties: {
        timeout_ms: { type: 'number', description: 'How long to wait for the check to clear (default 120000, max 1800000).' },
        poll_ms: { type: 'number', description: 'How often to look at the page again (default 1000).' },
        screenshot: { type: 'boolean', description: 'Capture a screenshot once the check is gone (default true).' },
      },
      async execute(args = {}) {
        if (!session && !currentTabKey()) return '[error] no browser is open; call browser_open first'
        return withPage('await_human', 'human verification', async (live, meta) => {
          const timeoutMs = clamp(args.timeout_ms, 1000, 1800000, 120000)
          const pollMs = clamp(args.poll_ms, 100, 10000, 1000)
          const started = now()
          let gate = await gateOf(live.page)
          while (gate) {
            const elapsed = now() - started
            if (elapsed >= timeoutMs) {
              if (args.screenshot !== false) {
                const shot = await shoot(live.page, 'attention')
                meta.screenshot = shot.path
              }
              meta.waited = elapsed
              const { message, handoff } = await attentionFor({
                gate, live, target: gate.kind, screenshot: meta.screenshot ?? null, waitedMs: elapsed,
              })
              throw new RuntimeAttention({
                message,
                gate,
                target: gate.kind,
                meta: { waited: elapsed, handoff },
              })
            }
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, timeoutMs - elapsed)))
            gate = await gateOf(live.page)
          }
          const waited = now() - started
          const url = await live.page.evaluate('location.href')
          meta.waited = waited
          meta.gate = 'cleared'
          meta.url = url
          const lines = ['browser_await_human: ok', `cleared after ${waited}ms`, `url: ${url}`]
          if (args.screenshot !== false) {
            const shot = await shoot(live.page, 'human')
            meta.screenshot = shot.path
            lines.push(`screenshot: ${shot.path}`)
          }
          return lines.join('\n')
        })
      },
    },
    {
      name: 'browser_close',
      description:
        'Forget the page handle. A browser this plugin launched is closed; an attached browser is only detached, '
        + 'because it belongs to the user and keeps running.',
      properties: {},
      async execute() {
        return guarded({ kind: 'runtime.browser', action: 'close', target: null }, async meta => {
          const key = currentTabKey()
          if (key) {
            await closeTab(key)
            return 'browser_close: closed the task tab'
          }
          if (!session) return 'browser_close: no browser was open'
          await Promise.allSettled([...scopedTabs.keys()].map(closeTab))
          invalidateLogin(session)
          await tabViews.get(session)?.close()
          await defaultView.close()
          const closing = session
          session = null
          markSession(closing, meta)
          await closing.close()
          return closing.mode === 'attach'
            ? `browser_close: detached from 127.0.0.1:${closing.port}; the browser you started was left running`
            : 'browser_close: ok'
        })
      },
    },
  ]

  const desktopTools = desktopConfig.enabled === false ? [] : [
    {
      name: 'desktop_screenshot',
      description:
        'Capture the whole desktop or one window (matched by title, captured with PrintWindow so a covered '
        + 'window still yields its own pixels) and return the PNG path.',
      properties: {
        window: { type: 'string', description: 'Part of a window title; omit to capture the whole desktop.' },
        path: { type: 'string', description: 'Optional destination file.' },
      },
      async execute(args = {}) {
        return guarded({ kind: 'runtime.desktop', action: 'desktop_screenshot', target: args.window ?? 'desktop' }, async meta => {
          const file = shotFile(args.path, 'desktop')
          const result = await captureScreenshot({ path: file, window: args.window ?? null })
          const stat = await fsp.stat(result.path)
          meta.path = result.path
          meta.scope = result.scope
          return [
            'desktop_screenshot: ok',
            `scope: ${result.scope}`,
            `path: ${result.path}`,
            `bytes: ${stat.size}`,
            result.rect ? `rect: ${result.rect.x},${result.rect.y} ${result.rect.width}×${result.rect.height}` : null,
          ].filter(Boolean).join('\n')
        })
      },
    },
    {
      name: 'desktop_windows',
      description: 'List visible top-level windows with their handle, title, process id, and screen rectangle.',
      properties: {
        filter: { type: 'string', description: 'Keep titles containing this text, ignoring case.' },
        limit: { type: 'number', description: 'Maximum rows to print (default 40).' },
      },
      async execute(args = {}) {
        return guarded({ kind: 'runtime.desktop', action: 'desktop_windows', target: args.filter ?? null }, async () => {
          const windows = await listWindows()
          const needle = args.filter ? String(args.filter).toLowerCase() : null
          const rows = windows.filter(item => !needle || String(item.title).toLowerCase().includes(needle))
          if (rows.length === 0) return `desktop_windows: 0 of ${windows.length} visible window(s) match`
          const limit = Math.max(1, Math.min(200, Number(args.limit) || 40))
          const lines = [`desktop_windows: ${rows.length} of ${windows.length} visible window(s)`]
          for (const item of rows.slice(0, limit)) {
            lines.push(
              `  ${String(item.hwnd).padEnd(10)} pid ${String(item.pid).padEnd(7)} `
              + `${item.rect.x},${item.rect.y} ${item.rect.width}×${item.rect.height}`
              + `${item.minimized ? ' minimized' : ''}  ${clip(item.title, 70)}`,
            )
          }
          return lines.join('\n')
        })
      },
    },
    {
      name: 'desktop_click',
      description:
        'Click screen coordinates. By default the click is posted to the target window without activating it '
        + '(window title required). activate: true brings the window forward first and is recorded separately.',
      properties: {
        x: { type: 'number', description: 'Screen x in physical pixels.' },
        y: { type: 'number', description: 'Screen y in physical pixels.' },
        window: { type: 'string', description: 'Part of the target window title; required for a background click.' },
        activate: { type: 'boolean', description: 'Allow a foreground click (brings the window forward).' },
        right: { type: 'boolean', description: 'Right button instead of left.' },
        confirm: { type: 'boolean', description: 'Confirm when the target window title reads as irreversible.' },
      },
      required: ['x', 'y'],
      async execute(args = {}) {
        const activation = args.activate === true
        const target = `${Math.round(Number(args.x) || 0)},${Math.round(Number(args.y) || 0)}`
        return guarded({ kind: 'runtime.desktop', action: 'desktop_click', target }, async meta => {
          assertActivationAllowed(activation)
          assertConfirmable(args.window, args.confirm, { point: target })
          const result = await clickAt({
            x: Math.round(Number(args.x)),
            y: Math.round(Number(args.y)),
            window: args.window ?? null,
            activate: activation,
            right: args.right === true,
          })
          // An activation is the one thing a reader of the audit trail must be
          // able to spot without opening the tool output.
          meta.mode = result.mode
          meta.activated = result.activated === true
          if (result.hwnd) meta.hwnd = result.hwnd
          meta.window = args.window ?? null
          meta.right = args.right === true
          return [
            `desktop_click: ok (${result.mode})`,
            `point: ${result.x},${result.y}${result.hwnd ? `  hwnd: ${result.hwnd}` : ''}`,
            activation ? 'activation: yes — the window was brought forward (recorded in the audit trail)' : 'activation: no',
          ].join('\n')
        })
      },
    },
    {
      name: 'desktop_type',
      description:
        'Type text into a window. Default is background delivery (WM_CHAR to the window\'s focused control, no '
        + 'focus change); activate: true uses SendInput after bringing the window forward.',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        window: { type: 'string', description: 'Part of the target window title.' },
        activate: { type: 'boolean', description: 'Allow foreground typing.' },
      },
      required: ['text'],
      async execute(args = {}) {
        const activation = args.activate === true
        return guarded({ kind: 'runtime.desktop', action: 'desktop_type', target: args.window ?? null }, async meta => {
          assertActivationAllowed(activation)
          const result = await typeText({
            text: String(args.text ?? ''),
            window: args.window ?? null,
            activate: activation,
          })
          meta.mode = result.mode
          meta.activated = result.activated === true
          meta.chars = result.chars
          if (result.hwnd) meta.hwnd = result.hwnd
          return [
            `desktop_type: ok (${result.mode})`,
            `characters: ${result.chars}${result.hwnd ? `  hwnd: ${result.hwnd}` : ''}`,
            activation ? 'activation: yes — recorded in the audit trail' : 'activation: no',
            'note: posted characters reach classic Win32 controls; Chromium and Electron content often ignores them.',
          ].join('\n')
        })
      },
    },
    {
      name: 'desktop_keys',
      description:
        'Press named keys (enter, tab, escape, f5, a, 1 …) one after another. Background by default; activate: true '
        + 'uses SendInput after bringing the target window forward.',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: 'Key names, pressed in order.' },
        window: { type: 'string', description: 'Part of the target window title.' },
        activate: { type: 'boolean', description: 'Allow foreground key delivery.' },
      },
      required: ['keys'],
      async execute(args = {}) {
        const activation = args.activate === true
        let virtualKeys
        try {
          virtualKeys = resolveVirtualKeys(Array.isArray(args.keys) ? args.keys : [args.keys])
        } catch (error) {
          return `[error] ${error.message}`
        }
        return guarded({ kind: 'runtime.desktop', action: 'desktop_keys', target: args.window ?? null }, async meta => {
          assertActivationAllowed(activation)
          const result = await pressKeys({ virtualKeys, window: args.window ?? null, activate: activation })
          meta.mode = result.mode
          meta.activated = result.activated === true
          meta.keys = virtualKeys
          if (result.hwnd) meta.hwnd = result.hwnd
          return [
            `desktop_keys: ok (${result.mode})`,
            `keys: ${virtualKeys.join(', ')}`,
            activation ? 'activation: yes — recorded in the audit trail' : 'activation: no',
          ].join('\n')
        })
      },
    },
  ]

  const statusTool = [{
    name: 'runtime_status',
    description: 'Report whether runtime control is stopped, which halves are registered, and the browser state.',
    properties: {},
    async execute() {
      const state = stopState()
      const executable = findBrowserExecutable({ explicit: browserConfig.executablePath ?? null, env })
      return [
        'runtime_status',
        `enabled: ${enabled ? 'yes' : 'no'}`,
        `browser tools: ${browserTools.length} (headless ${browserConfig.headless !== false}, `
          + `hosts ${(browserConfig.allowedHosts.length ? browserConfig.allowedHosts : LOOPBACK_HOSTS).join(', ')})`,
        `browser mode: ${browserConfig.attachPort !== null && browserConfig.attachPort !== undefined
          ? `attach to 127.0.0.1:${browserConfig.attachPort} (the user's own profile)`
          : `launch with a ${browserConfig.userDataDir ? `persistent profile at ${browserConfig.userDataDir}` : 'fresh temporary profile'}`}`,
        `desktop tools: ${desktopTools.length} (activation ${allowActivation ? 'allowed' : 'disabled'})`,
        `stop switch: ${state.stopped ? `SET by ${state.source}` : `clear (${stopFile})`}`,
        `screenshots: ${shotDir}`,
        `browser executable: ${executable ?? 'not found'}`,
        `browser session: ${describeSession(session)}`,
      ].join('\n')
    },
  }]

  return {
    enabled,
    stopFile,
    shotDir,
    stopState,
    checkNavigation: url => checkNavigation(url, { allowedHosts: browserConfig.allowedHosts }),
    irreversibleIntent,
    tools: enabled ? [...browserTools, ...desktopTools, ...statusTool] : [],
    withActor: (id, work, scope = null) => actors.run({ id, scope }, work),
    takeHumanHandoff(id) {
      const handoff = handoffs.get(id)
      handoffs.delete(id)
      return handoff ?? null
    },
    async releaseRun(runId) {
      await Promise.allSettled([...scopedTabs.keys()]
        .filter(key => JSON.parse(key)[0] === runId).map(closeTab))
    },
    verifyHumanHandoff: verifyLogin,
    /** A hand-off uses the exact browser tab on which a worker was blocked. */
    live: {
      async status(id) {
        if (id !== undefined && id !== null && !findLogin(id)) {
          return { available: false, viewing: false, reason: '该任务的登录页已失效，请从任务重新打开登录。' }
        }
        return loginView(id).status()
      },
      attach: (listener, viewport, id) => loginView(id).attach(listener, viewport),
      input: (event, id) => loginView(id).input(event),
      stop: id => loginView(id).stop(),
    },
    /** Close anything this layer opened; the host calls it on unload. */
    async dispose() {
      handoffs.clear()
      await openingBrowser?.catch(() => {})
      await Promise.allSettled([...scopedTabs.keys()].map(closeTab))
      if (session) await tabViews.get(session)?.close().catch(() => {})
      await defaultView.close().catch(() => {})
      loginTargets.clear()
      if (!session) return
      const closing = session
      session = null
      await closing.close().catch(error => warn(`runtime: cannot close the browser: ${error?.message ?? error}`))
    },
  }
}
