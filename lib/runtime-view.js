/**
 * Bounded, JSON-safe live view over the existing runtime tools.
 *
 * The controller never opens a browser or talks to the desktop itself. Callers
 * register the returned `tools` in place of `runtimeControl.tools`; the wrappers
 * observe execution, gate automatic work during a human takeover, and retain
 * only action names and outcomes. Screenshots use the runtime's configured
 * shotDir and cross the view boundary as paths/metadata, never image bytes.
 *
 * @module dsh-superagent/runtime-view
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_MAX_SUBSCRIBERS = 16
export const DEFAULT_MAX_ACTIONS = 100
export const DEFAULT_MAX_PENDING_EVENTS = 64
export const DEFAULT_STALE_FRAME_MS = 1500

const MAX_TOOL_NAME = 100
const MAX_TEXT = 1024
const MAX_DIMENSION = 65535
const READ_ONLY_TOOLS = new Set([
  'browser_elements',
  'browser_screenshot',
  'desktop_windows',
  'desktop_screenshot',
  'runtime_status',
])

export class RuntimeViewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RuntimeViewError'
    this.code = code
  }
}

function integerOption(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function clip(value, limit = MAX_TEXT) {
  return String(value ?? '').slice(0, limit)
}

function safeToolName(value) {
  const name = clip(value, MAX_TOOL_NAME)
  return /^[a-z0-9_.:-]+$/i.test(name) ? name : 'runtime.action'
}

function sourceOf(name) {
  if (name.startsWith('browser_')) return 'browser'
  if (name.startsWith('desktop_')) return 'desktop'
  return 'runtime'
}

function numberOrNull(value, max = Number.MAX_SAFE_INTEGER) {
  try {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(max, Math.max(0, Math.trunc(number))) : null
  } catch {
    return null
  }
}

/** Remove user info, query strings, and fragments before exposing a page URL. */
function safeUrl(value) {
  const raw = clip(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) return url.protocol.replace(':', '')
    return clip(`${url.origin}${url.pathname}`)
  } catch {
    return null
  }
}

function copy(value) {
  return JSON.parse(JSON.stringify(value))
}

function inside(file, directory) {
  const relative = path.relative(directory, file)
  if (process.platform === 'win32') {
    const rel = path.relative(directory.toLowerCase(), file.toLowerCase())
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  }
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function toolEntries(input) {
  if (Array.isArray(input)) return input.filter(tool => tool && typeof tool.execute === 'function')
  if (input instanceof Map) return [...input.values()].filter(tool => tool && typeof tool.execute === 'function')
  if (Array.isArray(input?.tools)) return toolEntries(input.tools)
  if (input?.tools instanceof Map) return toolEntries(input.tools)
  if (input && typeof input === 'object') {
    return Object.values(input).filter(tool => tool && typeof tool.execute === 'function')
  }
  return []
}

function mergeTools(...inputs) {
  const tools = new Map()
  for (const input of inputs) {
    for (const tool of toolEntries(input)) {
      if (typeof tool.name === 'string' && tool.name && !tools.has(tool.name)) tools.set(tool.name, tool)
    }
  }
  return tools
}

function frameTime(value, fallback) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  try {
    const number = Number(value)
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback
  } catch {
    return fallback
  }
}

function stamp(now) {
  const date = new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    + `-${String(date.getUTCMilliseconds()).padStart(3, '0')}`
}

function screenshotFields(result, source, file, capturedAt) {
  const value = result && typeof result === 'object' ? result : {}
  const width = numberOrNull(value.width ?? value.viewport?.width, MAX_DIMENSION)
  const height = numberOrNull(value.height ?? value.viewport?.height, MAX_DIMENSION)
  return {
    source,
    path: file,
    url: safeUrl(value.url),
    width,
    height,
    bytes: numberOrNull(value.bytes ?? value.size),
    scope: ['screen', 'window', 'page', 'browser', 'desktop'].includes(value.scope) ? value.scope : source,
    capturedAt,
  }
}

function parseScreenshotResult(result, source, file, capturedAt) {
  if (typeof result === 'string') {
    if (result.startsWith('[error]') || result.startsWith('[attention]')) {
      throw new RuntimeViewError('CAPTURE_FAILED', `${source} screenshot failed`)
    }
    const fields = screenshotFields({}, source, file, capturedAt)
    const returnedPath = /(?:^|\n)\s*path:\s*(.+?)(?:\r?\n|$)/i.exec(result)?.[1]?.trim()
    if (returnedPath) fields.path = path.resolve(clip(returnedPath))
    fields.url = safeUrl(/(?:^|\n)\s*url:\s*(.+?)(?:\r?\n|$)/i.exec(result)?.[1]?.trim())
    fields.scope = /(?:^|\n)\s*scope:\s*(screen|window)(?:\r?\n|$)/i.exec(result)?.[1]?.toLowerCase() ?? source
    const viewport = /(?:^|\n)\s*viewport:\s*(\d+)\s*[×x]\s*(\d+)/i.exec(result)
    fields.width = viewport ? numberOrNull(viewport[1], MAX_DIMENSION) : null
    fields.height = viewport ? numberOrNull(viewport[2], MAX_DIMENSION) : null
    fields.bytes = numberOrNull(/(?:^|\n)\s*bytes:\s*(\d+)/i.exec(result)?.[1])
    return fields
  }
  if (!result || typeof result !== 'object') {
    throw new RuntimeViewError('CAPTURE_FAILED', `${source} screenshot returned no metadata`)
  }
  const fields = screenshotFields(result, source, file, capturedAt)
  if (result.path !== undefined && result.path !== null) fields.path = path.resolve(clip(result.path))
  return fields
}

/**
 * Observe and control an existing runtime without replacing its policy/audit
 * layer. `browser` and `desktop` may be tool arrays, maps, or objects with a
 * `tools` collection. Frame-capable services may additionally expose
 * `onFrame(listener)` or `subscribeFrames(listener)`.
 *
 * @param {{
 *   runtimeControl?: object|null,
 *   browser?: object|Map|Array|null,
 *   desktop?: object|Map|Array|null,
 *   shotDir?: string,
 *   cancel?: (runId?: string|null) => unknown,
 *   emergencyStop?: () => unknown,
 *   now?: () => number,
 *   maxSubscribers?: number,
 *   maxActions?: number,
 *   maxPendingEvents?: number,
 *   staleFrameMs?: number,
 *   warn?: (message: string) => void,
 * }} [options]
 */
export function createRuntimeViewController({
  runtimeControl = null,
  browser = null,
  desktop = null,
  shotDir = null,
  cancel = null,
  emergencyStop = null,
  now = () => Date.now(),
  maxSubscribers = DEFAULT_MAX_SUBSCRIBERS,
  maxActions = DEFAULT_MAX_ACTIONS,
  maxPendingEvents = DEFAULT_MAX_PENDING_EVENTS,
  staleFrameMs = DEFAULT_STALE_FRAME_MS,
  warn = () => {},
} = {}) {
  const subscriberLimit = integerOption(maxSubscribers, DEFAULT_MAX_SUBSCRIBERS, 1, 64, 'maxSubscribers')
  const actionLimit = integerOption(maxActions, DEFAULT_MAX_ACTIONS, 1, 500, 'maxActions')
  const pendingLimit = integerOption(maxPendingEvents, DEFAULT_MAX_PENDING_EVENTS, 1, 256, 'maxPendingEvents')
  const frameAgeLimit = integerOption(staleFrameMs, DEFAULT_STALE_FRAME_MS, 0, 60000, 'staleFrameMs')
  const configuredShotDir = clip(shotDir || runtimeControl?.shotDir).trim()
  const directory = configuredShotDir ? path.resolve(configuredShotDir) : null
  const originals = mergeTools(runtimeControl?.tools, browser, desktop)
  const subscribers = new Set()
  const actions = []
  const active = new Map()
  const streamDisposers = []
  let disposed = false
  let takenOver = false
  let emergencyStopped = false
  let actionSerial = 0
  let frameSerial = 0
  let latestFrame = null
  let latestFrameTime = -1

  function serviceAvailable(source) {
    if (source === 'browser') {
      return [...originals.keys()].some(name => name.startsWith('browser_'))
        || typeof browser?.onFrame === 'function' || typeof browser?.subscribeFrames === 'function'
    }
    if (source === 'desktop') {
      return [...originals.keys()].some(name => name.startsWith('desktop_'))
        || typeof desktop?.onFrame === 'function' || typeof desktop?.subscribeFrames === 'function'
    }
    return Boolean(runtimeControl)
  }

  function stopState() {
    try {
      const state = runtimeControl?.stopState?.()
      if (state && typeof state.then === 'function') return { stopped: emergencyStopped, source: null }
      return {
        stopped: emergencyStopped || state?.stopped === true,
        source: clip(state?.source, MAX_TEXT) || (emergencyStopped ? 'runtime-view stop' : null),
      }
    } catch {
      return { stopped: emergencyStopped, source: emergencyStopped ? 'runtime-view stop' : null }
    }
  }

  function snapshot() {
    const stopped = stopState()
    return copy({
      version: 1,
      capturedAt: now(),
      available: serviceAvailable('runtime') || serviceAvailable('browser') || serviceAvailable('desktop'),
      services: {
        runtime: serviceAvailable('runtime'),
        browser: serviceAvailable('browser'),
        desktop: serviceAvailable('desktop'),
      },
      control: {
        mode: stopped.stopped ? 'stopped' : takenOver ? 'manual' : 'auto',
        stopped: stopped.stopped,
        stopSource: stopped.source,
        takeover: takenOver,
        automaticActions: stopped.stopped ? 'stopped' : takenOver ? 'paused' : 'running',
      },
      shotDir: directory,
      stopFile: clip(runtimeControl?.stopFile) || null,
      currentAction: currentAction(),
      actions,
      frame: latestFrame,
    })
  }

  function deliver(subscription, event) {
    if (subscription.closed) return
    subscription.queue.push(copy(event))
    if (subscription.queue.length > pendingLimit) subscription.queue.shift()
    if (subscription.flushing) return
    subscription.flushing = true
    try {
      while (!subscription.closed && subscription.queue.length > 0) {
        const next = subscription.queue.shift()
        try {
          subscription.listener(next)
        } catch {
          warn('runtime view subscriber failed')
        }
      }
    } finally {
      subscription.flushing = false
    }
  }

  function emit(event) {
    if (disposed) return
    for (const subscription of [...subscribers]) deliver(subscription, event)
  }

  function emitState() {
    emit({ type: 'state', snapshot: snapshot() })
  }

  function recordAction(action, phase, durationMs = null) {
    const entry = {
      id: action.id,
      seq: action.seq,
      source: action.source,
      name: action.name,
      phase,
      startedAt: action.startedAt,
      durationMs,
    }
    actions.push(entry)
    if (actions.length > actionLimit) actions.splice(0, actions.length - actionLimit)
    emit({ type: 'action', action: copy(entry) })
    return entry
  }

  function currentAction() {
    let latest = null
    for (const action of active.values()) {
      if (!latest || action.seq > latest.seq) latest = action
    }
    return latest ? {
      id: latest.id,
      seq: latest.seq,
      source: latest.source,
      name: latest.name,
      startedAt: latest.startedAt,
    } : null
  }

  function finishAction(action, phase, started) {
    active.delete(action.id)
    if (disposed) return
    recordAction(action, phase, Math.max(0, Math.trunc(now() - started)))
    emitState()
  }

  function wrappedExecute(original, args, context) {
    if (disposed) return Promise.reject(new RuntimeViewError('DISPOSED', 'runtime view is disposed'))
    const name = safeToolName(original.name)
    const source = sourceOf(name)
    if (!disposed && (takenOver || emergencyStopped) && !READ_ONLY_TOOLS.has(name)) {
      const blocked = {
        id: randomUUID(),
        seq: ++actionSerial,
        source,
        name,
        startedAt: now(),
      }
      recordAction(blocked, 'blocked')
      emitState()
      return '[error] runtime view: automatic actions are paused; release the human takeover before continuing'
    }
    const action = { id: randomUUID(), seq: ++actionSerial, source, name, startedAt: now() }
    const started = action.startedAt
    active.set(action.id, action)
    recordAction(action, 'started')
    emitState()
    return (async () => {
      try {
        const result = await original.execute(args, context)
        const phase = typeof result === 'string' && result.startsWith('[error]') ? 'failed'
          : typeof result === 'string' && result.startsWith('[attention]') ? 'attention'
            : 'succeeded'
        finishAction(action, phase, started)
        return result
      } catch (error) {
        finishAction(action, 'failed', started)
        throw error
      }
    })()
  }

  const tools = [...originals.values()].map(original => ({
    ...original,
    execute: (args, context) => wrappedExecute(original, args, context),
  }))
  const wrappedByName = new Map(tools.map(tool => [tool.name, tool]))

  function frameMetadata(raw, source, fallbackTime) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw.frame && typeof raw.frame === 'object' ? raw.frame : raw
    const capturedAt = frameTime(value.capturedAt ?? value.timestamp ?? value.time ?? raw.capturedAt ?? raw.timestamp, fallbackTime)
    let file = null
    if (value.path !== undefined && value.path !== null && value.path !== '') {
      file = path.resolve(clip(value.path))
      if (!directory || !inside(file, directory)) return null
    }
    return {
      source,
      path: file,
      url: safeUrl(value.url),
      width: numberOrNull(value.width, MAX_DIMENSION),
      height: numberOrNull(value.height, MAX_DIMENSION),
      bytes: numberOrNull(value.bytes ?? value.size),
      scope: ['screen', 'window', 'page', 'browser', 'desktop'].includes(value.scope) ? value.scope : source,
      capturedAt,
    }
  }

  function acceptFrame(raw, source, fallbackTime = now()) {
    if (disposed) return null
    const frame = frameMetadata(raw, source, fallbackTime)
    if (!frame) return null
    const current = now()
    if (frameAgeLimit > 0 && current - frame.capturedAt > frameAgeLimit) return null
    if (frame.capturedAt > current + 5000) return null
    if (frame.capturedAt < latestFrameTime) return null
    if (frame.capturedAt === latestFrameTime && latestFrame?.source === source) return null
    frame.seq = ++frameSerial
    latestFrameTime = frame.capturedAt
    latestFrame = frame
    emit({ type: 'frame', frame: copy(frame) })
    emitState()
    return copy(frame)
  }

  function attachFrames(service, source) {
    if (!service) return
    const subscribe = typeof service.onFrame === 'function'
      ? service.onFrame.bind(service)
      : typeof service.subscribeFrames === 'function'
        ? service.subscribeFrames.bind(service)
        : null
    if (!subscribe) return
    try {
      const unsubscribe = subscribe(raw => acceptFrame(raw, source))
      if (typeof unsubscribe === 'function') streamDisposers.push(unsubscribe)
      else if (unsubscribe && typeof unsubscribe.unsubscribe === 'function') streamDisposers.push(() => unsubscribe.unsubscribe())
      else if (typeof unsubscribe.dispose === 'function') streamDisposers.push(() => unsubscribe.dispose())
    } catch {
      warn(`runtime view: cannot subscribe to ${source} frames`)
    }
  }

  attachFrames(browser, 'browser')
  attachFrames(desktop, 'desktop')

  function subscribe(listener) {
    if (disposed) throw new RuntimeViewError('DISPOSED', 'runtime view is disposed')
    if (typeof listener !== 'function') throw new TypeError('runtime view subscriber must be a function')
    if (subscribers.size >= subscriberLimit) {
      throw new RuntimeViewError('SUBSCRIPTION_LIMIT', `runtime view allows at most ${subscriberLimit} subscribers`)
    }
    const subscription = { listener, queue: [], flushing: false, closed: false }
    subscribers.add(subscription)
    deliver(subscription, { type: 'state', snapshot: snapshot() })
    const unsubscribe = () => {
      if (subscription.closed) return
      subscription.closed = true
      subscription.queue.length = 0
      subscribers.delete(subscription)
    }
    unsubscribe.unsubscribe = unsubscribe
    return unsubscribe
  }

  async function capture({ source = 'auto', window = null, fullPage = false } = {}) {
    if (disposed) throw new RuntimeViewError('DISPOSED', 'runtime view is disposed')
    if (!directory) throw new RuntimeViewError('SERVICE_MISSING', 'runtime view has no configured shotDir')
    const selected = source === 'auto'
      ? wrappedByName.has('browser_screenshot') ? 'browser' : wrappedByName.has('desktop_screenshot') ? 'desktop' : null
      : source
    if (!['browser', 'desktop'].includes(selected)) {
      throw new RuntimeViewError('BAD_SOURCE', 'screenshot source must be browser, desktop, or auto')
    }
    const tool = wrappedByName.get(`${selected}_screenshot`)
    if (!tool) throw new RuntimeViewError('SERVICE_MISSING', `${selected} screenshot service is unavailable`)
    const capturedAt = now()
    const file = path.join(directory, `view-${selected}-${stamp(capturedAt)}-${randomUUID().slice(0, 8)}.png`)
    const args = selected === 'browser'
      ? { path: file, full_page: fullPage === true }
      : { path: file, ...(window ? { window: clip(window, 256) } : {}) }
    let result
    try {
      result = await tool.execute(args)
    } catch {
      throw new RuntimeViewError('CAPTURE_FAILED', `${selected} screenshot failed`)
    }
    let fields
    try {
      fields = parseScreenshotResult(result, selected, file, capturedAt)
    } catch (error) {
      if (error instanceof RuntimeViewError) throw error
      throw new RuntimeViewError('CAPTURE_FAILED', `${selected} screenshot returned invalid metadata`)
    }
    const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value
    if (!inside(fields.path, directory) || comparable(path.resolve(fields.path)) !== comparable(path.resolve(file))) {
      throw new RuntimeViewError('CAPTURE_PATH', 'screenshot service returned a path outside the requested shotDir file')
    }
    if (fields.bytes === null) {
      fields.bytes = await fsp.stat(file).then(stat => numberOrNull(stat.size)).catch(() => null)
    }
    const accepted = acceptFrame(fields, selected, capturedAt)
    return copy({ ...fields, seq: accepted?.seq ?? null, published: accepted !== null })
  }

  function takeover() {
    if (disposed) throw new RuntimeViewError('DISPOSED', 'runtime view is disposed')
    takenOver = true
    emitState()
    return snapshot()
  }

  function release() {
    if (disposed) throw new RuntimeViewError('DISPOSED', 'runtime view is disposed')
    takenOver = false
    emitState()
    return snapshot()
  }

  async function stop({ runId = null } = {}) {
    if (disposed) throw new RuntimeViewError('DISPOSED', 'runtime view is disposed')
    const rawStopFile = runtimeControl?.stopFile
    const file = typeof rawStopFile === 'string' && rawStopFile.trim() ? rawStopFile : null
    const stopImpl = emergencyStop || (typeof runtimeControl?.emergencyStop === 'function' ? runtimeControl.emergencyStop.bind(runtimeControl) : null)
    const cancelImpl = cancel || (typeof runtimeControl?.cancel === 'function' ? runtimeControl.cancel.bind(runtimeControl) : null)
    if (!file && !stopImpl && !cancelImpl) {
      throw new RuntimeViewError('SERVICE_MISSING', 'runtime view has no emergency-stop or cancellation service')
    }
    const action = {
      id: randomUUID(), seq: ++actionSerial, source: 'runtime', name: 'runtime_view.stop', startedAt: now(),
    }
    const started = action.startedAt
    active.set(action.id, action)
    recordAction(action, 'started')
    emitState()
    const errors = []
    let stopped = false
    let cancelled = false
    if (file) {
      try {
        await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true })
        await fsp.writeFile(path.resolve(file), 'stopped by runtime view\n', 'utf8')
        emergencyStopped = true
        stopped = true
      } catch {
        errors.push('STOP_FILE_FAILED')
      }
    }
    if (stopImpl) {
      try {
        const result = await stopImpl()
        emergencyStopped = result?.stopped !== false
        stopped = stopped || emergencyStopped
      } catch {
        errors.push('EMERGENCY_STOP_FAILED')
      }
    }
    if (cancelImpl) {
      try {
        await cancelImpl(runId === null || runId === undefined ? null : clip(runId, 128))
        cancelled = true
      } catch {
        errors.push('CANCEL_FAILED')
      }
    }
    const finalStopState = stopState()
    stopped = stopped || finalStopState.stopped
    finishAction(action, stopped || cancelled ? 'succeeded' : 'failed', started)
    return copy({ stopped, stopFile: file ? path.resolve(file) : null, cancelled, runId: runId == null ? null : clip(runId, 128), errors })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const unsubscribe of streamDisposers) {
      try { unsubscribe() } catch { /* The stream is already gone. */ }
    }
    streamDisposers.length = 0
    for (const subscription of subscribers) {
      subscription.closed = true
      subscription.queue.length = 0
    }
    subscribers.clear()
    active.clear()
    actions.length = 0
    latestFrame = null
    latestFrameTime = -1
  }

  return {
    tools,
    snapshot,
    subscribe,
    capture,
    currentAction,
    takeover,
    release,
    stop,
    dispose,
    tool: name => wrappedByName.get(name) ?? null,
  }
}
