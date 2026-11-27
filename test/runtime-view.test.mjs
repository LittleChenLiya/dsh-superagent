import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createRuntimeViewController,
  RuntimeViewError,
  DEFAULT_MAX_SUBSCRIBERS,
} from '../lib/runtime-view.js'

const SECRET = 'sk-live-do-not-log-this'

async function tempDir(t, prefix = 'superagent-runtime-view-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** A runtime tool surface with real files but no browser or desktop process. */
function fakeRuntime({ shotDir, stopFile, holdClick = null, screenshot = null } = {}) {
  const calls = []
  const stoppedResult = () => existsSync(stopFile) ? `[error] runtime control is stopped by ${stopFile}` : null
  const tools = [
    {
      name: 'browser_click',
      async execute(args) {
        calls.push({ name: 'browser_click', args })
        if (stoppedResult()) return stoppedResult()
        if (holdClick) await holdClick.promise
        return 'browser_click: ok'
      },
    },
    {
      name: 'browser_type',
      async execute(args) {
        calls.push({ name: 'browser_type', args })
        if (stoppedResult()) return stoppedResult()
        return 'browser_type: ok'
      },
    },
    {
      name: 'browser_script',
      async execute(args) {
        calls.push({ name: 'browser_script', args })
        if (stoppedResult()) return stoppedResult()
        if (args.fail) throw new Error(`script failed with ${SECRET}`)
        return 'browser_script: ok'
      },
    },
    {
      name: 'browser_elements',
      async execute() { return 'browser_elements: ok' },
    },
    {
      name: 'browser_screenshot',
      async execute(args) {
        calls.push({ name: 'browser_screenshot', args })
        if (stoppedResult()) return stoppedResult()
        if (screenshot) return screenshot(args)
        await fsp.mkdir(path.dirname(args.path), { recursive: true })
        await fsp.writeFile(args.path, Buffer.from('fake png bytes'))
        return {
          path: args.path,
          width: 1280,
          height: 720,
          bytes: 14,
          url: 'https://user:password@example.test/private?token=do-not-expose#fragment',
          data: 'data:image/png;base64,SECRET_IMAGE_DATA',
        }
      },
    },
    {
      name: 'desktop_screenshot',
      async execute(args) {
        calls.push({ name: 'desktop_screenshot', args })
        if (stoppedResult()) return stoppedResult()
        await fsp.mkdir(path.dirname(args.path), { recursive: true })
        await fsp.writeFile(args.path, 'fake desktop png')
        return {
          path: args.path,
          scope: 'window',
          bytes: 17,
          width: 800,
          height: 600,
          image: Buffer.from('DESKTOP_IMAGE_DATA'),
        }
      },
    },
    {
      name: 'desktop_click',
      async execute(args) {
        calls.push({ name: 'desktop_click', args })
        if (stoppedResult()) return stoppedResult()
        return 'desktop_click: ok'
      },
    },
    {
      name: 'runtime_status',
      async execute() { return `runtime_status\nstop switch: ${existsSync(stopFile) ? 'SET' : 'clear'}` },
    },
  ]
  return {
    calls,
    tools,
    shotDir,
    stopFile,
    stopState: () => ({ stopped: existsSync(stopFile), source: existsSync(stopFile) ? stopFile : null }),
  }
}

function frameService() {
  const listeners = new Set()
  let unsubscribed = 0
  return {
    listeners,
    get unsubscribed() { return unsubscribed },
    onFrame(listener) {
      listeners.add(listener)
      return () => {
        unsubscribed += 1
        listeners.delete(listener)
      }
    },
    emit(frame) {
      for (const listener of [...listeners]) listener(frame)
    },
  }
}

function codeOf(code) {
  return error => error instanceof RuntimeViewError && error.code === code
}

test('snapshot reports injected services and capture returns bounded file metadata, never image JSON', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'existing-shots')
  await fsp.mkdir(shotDir)
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'runtime', 'STOP') })
  const view = createRuntimeViewController({ runtimeControl: runtime, now: () => 1700000000000 })

  const initial = view.snapshot()
  assert.equal(initial.available, true)
  assert.deepEqual(initial.services, { runtime: true, browser: true, desktop: true })
  assert.deepEqual(initial.control, {
    mode: 'auto', stopped: false, stopSource: null, takeover: false, automaticActions: 'running',
  })
  assert.equal(initial.currentAction, null)
  assert.equal(view.currentAction(), null)

  const shot = await view.capture({ fullPage: true })
  assert.equal(shot.source, 'browser')
  assert.equal(path.dirname(shot.path), shotDir)
  assert.match(path.basename(shot.path), /^view-browser-.*\.png$/)
  assert.deepEqual(await fsp.readFile(shot.path), Buffer.from('fake png bytes'))
  assert.equal(shot.width, 1280)
  assert.equal(shot.height, 720)
  assert.equal(shot.bytes, 14)
  assert.equal(shot.url, 'https://example.test/private')
  assert.equal(shot.published, true)
  assert.ok(Number.isInteger(shot.seq))
  assert.equal(runtime.calls.at(-1).args.full_page, true)

  const desktop = await view.capture({ source: 'desktop', window: 'Editor' })
  assert.equal(desktop.source, 'desktop')
  assert.equal(desktop.scope, 'window')
  assert.equal(path.dirname(desktop.path), shotDir)
  assert.equal(runtime.calls.at(-1).args.window, 'Editor')

  const json = JSON.stringify({ initial, shot, desktop, snapshot: view.snapshot() })
  for (const forbidden of ['base64', 'SECRET_IMAGE_DATA', 'DESKTOP_IMAGE_DATA', 'password', 'do-not-expose', 'fragment', 'data:image']) {
    assert.equal(json.includes(forbidden), false, `view JSON must not contain ${forbidden}`)
  }
  assert.equal(json.includes('"path"'), true)
  assert.doesNotThrow(() => JSON.parse(json))
  view.dispose()
})

test('completed browser and desktop screenshot tools publish bounded frames and reject escaping paths', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP') })
  let clock = 1700000000000
  let mode = 'ok'
  const returned = []
  for (const source of ['browser', 'desktop']) {
    const tool = runtime.tools.find(entry => entry.name === `${source}_screenshot`)
    tool.execute = async args => {
      const file = mode === 'outside' ? path.join(dir, 'outside.png') : args.path
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, 'png')
      if (mode === 'failed') return `[error] ${source} capture failed\npath: ${file}`
      const text = source === 'browser'
        ? `${source}_screenshot: ok\npath: ${file}\nviewport: 1280×720  bytes: 3\nurl: https://user:password@example.test/private?token=${SECRET}#fragment`
        : `${source}_screenshot: ok\nscope: window\npath: ${file}\nbytes: 3`
      returned.push(text)
      return text
    }
  }
  const view = createRuntimeViewController({ runtimeControl: runtime, now: () => clock })
  const events = []
  view.subscribe(event => events.push(event))

  assert.equal(await view.tool('browser_screenshot').execute({ path: path.join(shotDir, 'browser.png') }), returned[0])
  assert.equal(await view.tool('desktop_screenshot').execute({ window: SECRET, path: path.join(shotDir, 'desktop.png') }), returned[1])
  const frames = events.filter(event => event.type === 'frame').map(event => event.frame)
  assert.deepEqual(frames.map(frame => frame.source), ['browser', 'desktop'])
  assert.deepEqual(frames.map(frame => frame.seq), [1, 2])
  assert.equal(frames[0].width, 1280)
  assert.equal(frames[0].height, 720)
  assert.equal(frames[0].bytes, 3)
  assert.equal(frames[0].url, 'https://example.test/private')
  assert.equal(frames[1].scope, 'window')
  assert.equal(frames.every(frame => path.dirname(frame.path) === shotDir), true)
  assert.equal(view.snapshot().frame.source, 'desktop')

  clock += 10
  mode = 'outside'
  await view.tool('browser_screenshot').execute({ path: path.join(shotDir, 'escape.png') })
  clock += 10
  mode = 'failed'
  await view.tool('desktop_screenshot').execute({ path: path.join(shotDir, 'failed.png') })
  assert.equal(events.filter(event => event.type === 'frame').length, 2, 'failed and escaping captures must not publish')
  const json = JSON.stringify({ events, snapshot: view.snapshot() })
  for (const forbidden of [SECRET, 'password', 'token=', 'fragment', 'outside.png', 'result', 'browser_screenshot: ok']) {
    assert.equal(json.includes(forbidden), false, `published frames must not retain ${forbidden}`)
  }
  view.dispose()
})

test('capture publishes exactly one frame when its wrapped screenshot tool also completes', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP') })
  const view = createRuntimeViewController({ runtimeControl: runtime })
  const frames = []
  view.subscribe(event => { if (event.type === 'frame') frames.push(event.frame) })
  const shot = await view.capture()
  assert.equal(shot.published, true)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].seq, shot.seq)
  assert.equal(frames[0].path, shot.path)
  view.dispose()
})

test('capture clamps numeric metadata and refuses a returned path outside the generated shotDir file', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  await fsp.mkdir(shotDir)
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP') })
  let mode = 'large'
  const view = createRuntimeViewController({
    runtimeControl: fakeRuntime({
      shotDir,
      stopFile: runtime.stopFile,
      screenshot: async args => {
        if (mode === 'escape') return { path: path.join(dir, 'outside.png'), data: 'image' }
        await fsp.writeFile(args.path, 'png')
        return { path: args.path, width: 1e30, height: -10, bytes: 1e30, data: 'image' }
      },
    }),
  })
  const bounded = await view.capture()
  assert.equal(bounded.width, 65535)
  assert.equal(bounded.height, 0)
  assert.equal(bounded.bytes, Number.MAX_SAFE_INTEGER)
  assert.equal(JSON.stringify(bounded).includes('image'), false)

  mode = 'escape'
  await assert.rejects(view.capture(), codeOf('CAPTURE_PATH'))
  view.dispose()
})

test('action streams expose current work and redact arguments, results, errors, and credentials', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const holdClick = deferred()
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP'), holdClick })
  const view = createRuntimeViewController({ runtimeControl: runtime, maxActions: 4 })
  const events = []
  const unsubscribe = view.subscribe(event => events.push(event))

  const pending = view.tool('browser_click').execute({
    text: `type ${SECRET}`, css: `[data-token="${SECRET}"]`, command: `cmd /c echo ${SECRET}`,
  })
  const current = view.currentAction()
  assert.equal(current.name, 'browser_click')
  assert.equal(current.source, 'browser')
  assert.deepEqual(Object.keys(current).sort(), ['id', 'name', 'seq', 'source', 'startedAt'])
  assert.equal(view.snapshot().currentAction.name, 'browser_click')
  assert.ok(events.some(event => event.type === 'action' && event.action.phase === 'started'))

  runtime.calls[0].args.credential = SECRET
  await assert.rejects(view.tool('browser_script').execute({ expression: `fetch("?token=${SECRET}")`, fail: true }), new RegExp(SECRET))
  holdClick.resolve()
  assert.match(await pending, /^browser_click: ok/)
  assert.equal(view.currentAction(), null)

  const actionEvents = events.filter(event => event.type === 'action').map(event => event.action)
  assert.deepEqual(actionEvents.map(event => event.phase), ['started', 'started', 'failed', 'succeeded'])
  for (const action of actionEvents) {
    assert.deepEqual(Object.keys(action).sort(), [
      'durationMs', 'id', 'name', 'phase', 'seq', 'source', 'startedAt',
    ])
  }
  const snapshot = view.snapshot()
  assert.equal(snapshot.actions.length, 4)
  assert.equal(snapshot.actions[0].name, 'browser_click')
  assert.equal(snapshot.actions[0].phase, 'started')
  assert.ok(snapshot.actions.some(action => action.name === 'browser_script' && action.phase === 'failed'))
  const json = JSON.stringify({ events, snapshot })
  for (const forbidden of [SECRET, 'cmd /c', 'expression', 'credential', 'args', 'result', 'error', 'fetch(']) {
    assert.equal(json.includes(forbidden), false, `action view must not retain ${forbidden}`)
  }
  unsubscribe()
  view.dispose()
})

test('takeover pauses automatic browser and desktop actions while release resumes them', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP') })
  const view = createRuntimeViewController({ runtimeControl: runtime })
  const states = []
  view.subscribe(event => { if (event.type === 'state') states.push(event.snapshot.control.mode) })

  assert.equal(view.takeover().control.mode, 'manual')
  assert.match(await view.tool('browser_click').execute({ text: 'Continue' }), /automatic actions are paused/)
  assert.match(await view.tool('desktop_click').execute({ x: 1, y: 2 }), /automatic actions are paused/)
  assert.equal(runtime.calls.length, 0, 'paused actions must not reach the runtime')
  assert.equal(view.tool('browser_elements') ? 'available' : 'missing', 'available')
  assert.match(await view.tool('browser_elements').execute({}), /^browser_elements: ok/)
  assert.equal((await view.capture()).source, 'browser', 'observing the screen remains available during takeover')

  assert.equal(view.release().control.mode, 'auto')
  assert.match(await view.tool('browser_click').execute({ text: 'Continue' }), /^browser_click: ok/)
  assert.match(await view.tool('desktop_click').execute({ x: 1, y: 2 }), /^desktop_click: ok/)
  assert.equal(runtime.calls.filter(call => call.name.endsWith('_click')).length, 2)
  assert.deepEqual(states.filter((mode, index) => index === 0 || mode !== states[index - 1]), ['auto', 'manual', 'auto'])
  assert.ok(view.snapshot().actions.some(action => action.phase === 'blocked'))
  view.dispose()
})

test('stop writes the existing emergency stop path and invokes cancellation without logging run arguments', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const stopFile = path.join(dir, 'runtime', 'STOP')
  const runtime = fakeRuntime({ shotDir, stopFile })
  const cancelled = []
  const view = createRuntimeViewController({
    runtimeControl: runtime,
    cancel: async runId => { cancelled.push(runId) },
  })

  const stopped = await view.stop({ runId: 'run-123' })
  assert.deepEqual(stopped, {
    stopped: true,
    stopFile,
    cancelled: true,
    runId: 'run-123',
    errors: [],
  })
  assert.equal(await fsp.readFile(stopFile, 'utf8'), 'stopped by runtime view\n')
  assert.deepEqual(cancelled, ['run-123'])
  assert.equal(runtime.stopState().stopped, true)
  assert.equal(view.snapshot().control.mode, 'stopped')
  assert.equal(view.snapshot().control.automaticActions, 'stopped')

  // The policy layer itself also refuses work: stop did not invent a separate
  // browser/desktop shutdown path or bypass runtime-control's STOP check.
  const originalClick = runtime.tools.find(tool => tool.name === 'browser_click')
  assert.match(await originalClick.execute({}), /^\[error\] runtime control is stopped/)
  assert.equal(runtime.stopState().source, stopFile)
  assert.equal(view.release().control.mode, 'stopped', 'releasing takeover cannot clear an emergency stop')
  assert.match(await view.tool('browser_click').execute({}), /automatic actions are paused/)
  assert.equal(cancelled.length, 1)
  const json = JSON.stringify(view.snapshot())
  assert.equal(json.includes('run-123'), false, 'stop arguments do not belong in the action log')
  view.dispose()
})

test('stop supports an injected emergency-stop service and returns only bounded failure codes', async t => {
  const dir = await tempDir(t)
  let stopped = 0
  const view = createRuntimeViewController({
    emergencyStop: async () => { stopped += 1 },
    cancel: async () => { throw new Error(`cancel leaked ${SECRET}`) },
  })
  const result = await view.stop()
  assert.equal(result.stopped, true)
  assert.equal(result.cancelled, false)
  assert.deepEqual(result.errors, ['CANCEL_FAILED'])
  assert.equal(stopped, 1)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
  assert.equal(view.snapshot().control.stopped, true)
  view.dispose()
})

test('subscriptions are capped, idempotently disconnected, and rejected after disposal', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP') })
  const view = createRuntimeViewController({ runtimeControl: runtime, maxSubscribers: 2 })
  const first = []
  const second = []
  const unsubscribeFirst = view.subscribe(event => first.push(event))
  const unsubscribeSecond = view.subscribe(event => second.push(event))
  assert.equal(first.length, 1)
  assert.equal(second.length, 1)
  assert.throws(() => view.subscribe(() => {}), codeOf('SUBSCRIPTION_LIMIT'))

  unsubscribeFirst()
  unsubscribeFirst()
  let thirdEvents = 0
  const unsubscribeThird = view.subscribe(() => { thirdEvents += 1 })
  assert.equal(thirdEvents, 1)
  view.takeover()
  assert.equal(first.length, 1, 'an unsubscribed listener receives no later events')
  assert.ok(second.length > 1)
  assert.ok(thirdEvents > 1)

  unsubscribeSecond()
  unsubscribeThird()
  view.dispose()
  view.dispose()
  assert.throws(() => view.subscribe(() => {}), codeOf('DISPOSED'))
})

test('subscription defaults and invalid bounds are explicit', () => {
  assert.equal(DEFAULT_MAX_SUBSCRIBERS, 16)
  assert.throws(() => createRuntimeViewController({ maxSubscribers: 0 }), /maxSubscribers/)
  assert.throws(() => createRuntimeViewController({ maxActions: 501 }), /maxActions/)
  assert.throws(() => createRuntimeViewController({ maxPendingEvents: 1.5 }), /maxPendingEvents/)
  assert.throws(() => createRuntimeViewController({ staleFrameMs: -1 }), /staleFrameMs/)
})

test('late, stale, future, and escaping frames are dropped; disposal detaches both streams', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP') })
  const browserFrames = frameService()
  const desktopFrames = frameService()
  const view = createRuntimeViewController({ runtimeControl: runtime, browser: browserFrames, desktop: desktopFrames })
  const frames = []
  view.subscribe(event => { if (event.type === 'frame') frames.push(event.frame) })
  const current = Date.now()
  const file = path.join(shotDir, 'stream.png')

  browserFrames.emit({ path: file, capturedAt: current, width: 100, height: 50, data: 'IMAGE_ONE' })
  browserFrames.emit({ path: file, capturedAt: current - 1, data: 'LATE_IMAGE' })
  browserFrames.emit({ path: file, capturedAt: current - 5000, data: 'STALE_IMAGE' })
  browserFrames.emit({ path: file, capturedAt: current + 10000, data: 'FUTURE_IMAGE' })
  browserFrames.emit({ path: path.join(dir, 'outside.png'), capturedAt: current + 1, data: 'ESCAPE_IMAGE' })
  desktopFrames.emit({ path: file, capturedAt: current + 2, scope: 'screen', image: 'IMAGE_TWO' })

  assert.equal(frames.length, 2)
  assert.deepEqual(frames.map(frame => frame.source), ['browser', 'desktop'])
  assert.deepEqual(frames.map(frame => frame.seq), [1, 2])
  assert.equal(view.snapshot().frame.source, 'desktop')
  const json = JSON.stringify({ frames, snapshot: view.snapshot() })
  for (const forbidden of ['IMAGE_ONE', 'IMAGE_TWO', 'LATE_IMAGE', 'STALE_IMAGE', 'FUTURE_IMAGE', 'ESCAPE_IMAGE', 'data', 'image']) {
    assert.equal(json.includes(forbidden), false)
  }

  assert.equal(browserFrames.listeners.size, 1)
  assert.equal(desktopFrames.listeners.size, 1)
  view.dispose()
  assert.equal(browserFrames.listeners.size, 0)
  assert.equal(desktopFrames.listeners.size, 0)
  assert.equal(browserFrames.unsubscribed, 1)
  assert.equal(desktopFrames.unsubscribed, 1)
  browserFrames.emit({ path: file, capturedAt: current + 3 })
  assert.equal(frames.length, 2)
})

test('missing runtime, screenshot, and stop services fail explicitly without starting anything', async t => {
  const dir = await tempDir(t)
  const empty = createRuntimeViewController({})
  assert.equal(empty.snapshot().available, false)
  assert.deepEqual(empty.snapshot().services, { runtime: false, browser: false, desktop: false })
  assert.deepEqual(empty.snapshot().actions, [])
  await assert.rejects(empty.capture(), codeOf('SERVICE_MISSING'))
  await assert.rejects(empty.stop(), codeOf('SERVICE_MISSING'))
  empty.dispose()
  await assert.rejects(empty.capture(), codeOf('DISPOSED'))
  await assert.rejects(empty.stop(), codeOf('DISPOSED'))
  assert.throws(() => empty.takeover(), codeOf('DISPOSED'))
  assert.throws(() => empty.release(), codeOf('DISPOSED'))

  const browserTools = [{
    name: 'browser_screenshot',
    execute: async () => { throw new Error('a real browser must never be started by this test') },
  }]
  const noDirectory = createRuntimeViewController({ browser: browserTools })
  await assert.rejects(noDirectory.capture(), codeOf('SERVICE_MISSING'))
  noDirectory.dispose()

  const runtime = fakeRuntime({ shotDir: path.join(dir, 'shots'), stopFile: path.join(dir, 'STOP') })
  runtime.tools = runtime.tools.filter(tool => !tool.name.endsWith('_screenshot'))
  const noScreenshot = createRuntimeViewController({ runtimeControl: runtime })
  await assert.rejects(noScreenshot.capture({ source: 'desktop' }), codeOf('SERVICE_MISSING'))
  await assert.rejects(noScreenshot.capture({ source: 'invalid' }), codeOf('BAD_SOURCE'))
  noScreenshot.dispose()
})

test('disposed tool wrappers reject and never invoke the underlying runtime', async t => {
  const dir = await tempDir(t)
  const shotDir = path.join(dir, 'shots')
  const runtime = fakeRuntime({ shotDir, stopFile: path.join(dir, 'STOP') })
  const view = createRuntimeViewController({ runtimeControl: runtime })
  const click = view.tool('browser_click')
  view.dispose()
  await assert.rejects(click.execute({ text: 'must not run' }), codeOf('DISPOSED'))
  assert.equal(runtime.calls.length, 0)
})
