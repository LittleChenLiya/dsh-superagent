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
import { findBrowserExecutable } from '../lib/browser.js'

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

test('runtime control is not registered unless a profile opts in', async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-runtime-off-'))
  const { tools, ctx } = fakeHost()
  apply(ctx, { stateDir, notifyOnComplete: false })
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'superagent_answer', 'superagent_audit', 'superagent_cancel', 'superagent_followup',
      'superagent_inject', 'superagent_list', 'superagent_memory', 'superagent_resume',
      'superagent_schedule', 'superagent_start', 'superagent_status', 'superagent_template',
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
    'browser_screenshot', 'browser_script', 'browser_wait', 'browser_close', 'runtime_status',
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
  assert.match(text, /browser tools: 8/)
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

/** Read the auditor's JSONL through the same reader the plugin uses. */
async function readAudit(stateDir) {
  const file = path.join(stateDir, 'audit', 'audit.jsonl')
  const text = await fsp.readFile(file, 'utf8').catch(() => '')
  const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { events }
}
