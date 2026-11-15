import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { createStore } from '../lib/store.js'
import {
  createRunChangeTracker,
  createUnifiedDiff,
  createWorkbench,
  looksBinary,
  MAX_EDIT_BYTES,
} from '../lib/workbench.js'

const exec = promisify(execFile)

async function fixture({ stateInsideRoot = false } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-workbench-'))
  const rawRoot = path.join(base, 'root')
  await fsp.mkdir(path.join(rawRoot, 'src'), { recursive: true })
  const root = await fsp.realpath(rawRoot)
  const state = stateInsideRoot ? path.join(root, 'state') : path.join(base, 'state')
  await fsp.mkdir(state, { recursive: true })
  await fsp.writeFile(path.join(root, 'src', 'app.js'), 'const a = 1\nconst b = 2\n', 'utf8')
  await fsp.writeFile(path.join(root, 'notes.txt'), 'hello\n', 'utf8')
  await fsp.writeFile(path.join(base, 'outside.txt'), 'secret outside the root\n', 'utf8')
  return { base, root, state }
}

async function startPanel({ root, state, store }) {
  const panel = createWorkbench({
    port: 0,
    root,
    stateRoot: state,
    store,
    version: 'test',
    log: () => {},
  })
  await panel.start()
  const request = async (method, route, body, token = panel.token) => {
    const headers = {}
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${panel.url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      // The HTML page is not JSON; callers of `/` use the raw text.
    }
    return { status: response.status, json, text, headers: response.headers }
  }
  return { panel, request }
}

test('the panel refuses every request without the one-time token', async () => {
  const { base, root, state } = await fixture()
  let panel = null
  try {
    const started = await startPanel({ root, state })
    panel = started.panel
    const anonymous = await started.request('GET', '/api/health', undefined, null)
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.id, 'unauthorized')

    const wrong = await started.request('GET', '/api/health', undefined, 'not-the-token')
    assert.equal(wrong.status, 401)

    const allowed = await started.request('GET', '/api/health')
    assert.equal(allowed.status, 200)
    assert.equal(allowed.json.data.root, root)

    // The page itself needs the token too; the query form exists only so a
    // browser navigation can bootstrap the session.
    const pageWithoutToken = await fetch(`${panel.url}/`)
    assert.equal(pageWithoutToken.status, 401)
    const page = await fetch(`${panel.url}/?token=${encodeURIComponent(panel.token)}`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /dsh-superagent/)
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)

    const discovery = JSON.parse(await fsp.readFile(path.join(state, 'workbench.json'), 'utf8'))
    assert.equal(discovery.token, panel.token)
    assert.equal(discovery.url, panel.url)
    assert.equal(discovery.root, root)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('paths outside the configured root are refused with a reason', async () => {
  const { base, root, state } = await fixture()
  let panel = null
  try {
    const started = await startPanel({ root, state })
    panel = started.panel

    const tree = await started.request('GET', '/api/tree?path=.')
    assert.equal(tree.status, 200)
    assert.deepEqual(tree.json.data.entries.map(entry => entry.name), ['src', 'notes.txt'])

    const opened = await started.request('GET', '/api/file?path=src/app.js')
    assert.equal(opened.status, 200)
    assert.equal(opened.json.data.content, 'const a = 1\nconst b = 2\n')
    assert.match(opened.json.data.hash, /^[0-9a-f]{64}$/)

    for (const attempted of ['../outside.txt', '../../outside.txt', path.join(base, 'outside.txt'), 'C:\\Windows\\win.ini']) {
      const response = await started.request('GET', `/api/file?path=${encodeURIComponent(attempted)}`)
      assert.equal(response.status, 403, `${attempted} must not be readable`)
      assert.equal(response.json.error.id, 'outside-root')
      assert.match(response.json.error.summary, /outside the workspace root|absolute path/)
      assert.ok(response.json.error.hint, 'the refusal must explain what is allowed')
    }

    // A symlink inside the root that points outside is a different escape path.
    try {
      await fsp.symlink(path.join(base, 'outside.txt'), path.join(root, 'escape.txt'))
      const viaLink = await started.request('GET', '/api/file?path=escape.txt')
      assert.equal(viaLink.status, 403)
      assert.equal(viaLink.json.error.id, 'outside-root')
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) throw error
      // Windows without developer mode cannot create this link; the path
      // checks above already cover the lexical escapes.
    }
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the plugin state directory is never readable, even when it sits inside the root', async () => {
  const { base, root, state } = await fixture({ stateInsideRoot: true })
  let panel = null
  try {
    const started = await startPanel({ root, state })
    panel = started.panel
    const tree = await started.request('GET', '/api/tree?path=.')
    assert.equal(tree.status, 200)
    assert.ok(!tree.json.data.entries.some(entry => entry.name === 'state'), 'the state directory must be hidden')

    const stateFile = path.relative(root, path.join(state, 'workbench.json')).split(path.sep).join('/')
    const response = await started.request('GET', `/api/file?path=${encodeURIComponent(stateFile)}`)
    assert.equal(response.status, 403)
    assert.equal(response.json.error.id, 'protected-path')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a file changed on disk after opening is not overwritten', async () => {
  const { base, root, state } = await fixture()
  let panel = null
  try {
    const started = await startPanel({ root, state })
    panel = started.panel
    const target = path.join(root, 'src', 'app.js')

    const opened = await started.request('GET', '/api/file?path=src/app.js')
    const baseline = opened.json.data

    await fsp.writeFile(target, 'someone else wrote this\n', 'utf8')

    const rejected = await started.request('POST', '/api/save', {
      path: 'src/app.js',
      content: 'const a = 1\nconst b = 2\nconst c = 3\n',
      expectedHash: baseline.hash,
      expectedMtimeMs: baseline.mtimeMs,
    })
    assert.equal(rejected.status, 409)
    assert.equal(rejected.json.error.id, 'external-change')
    assert.equal(await fsp.readFile(target, 'utf8'), 'someone else wrote this\n', 'the external edit must survive')

    // Reopening gives a fresh baseline, and the same edit then succeeds.
    const reopened = await started.request('GET', '/api/file?path=src/app.js')
    const saved = await started.request('POST', '/api/save', {
      path: 'src/app.js',
      content: 'const a = 1\nconst b = 2\nconst c = 3\n',
      expectedHash: reopened.json.data.hash,
      expectedMtimeMs: reopened.json.data.mtimeMs,
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.data.size, Buffer.byteLength('const a = 1\nconst b = 2\nconst c = 3\n'))
    assert.equal(await fsp.readFile(target, 'utf8'), 'const a = 1\nconst b = 2\nconst c = 3\n')

    const missingBaseline = await started.request('POST', '/api/save', {
      path: 'src/app.js',
      content: 'anything',
    })
    assert.equal(missingBaseline.status, 400)
    assert.equal(missingBaseline.json.error.id, 'missing-baseline')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('diff generation and the preview endpoint agree', async () => {
  const before = 'one\ntwo\nthree\nfour\nfive\n'
  const after = 'one\nTWO\nthree\nfour\nfive\nsix\n'
  const diff = createUnifiedDiff(before, after, { path: 'sample.txt' })
  assert.match(diff, /^--- a\/sample\.txt$/m)
  assert.match(diff, /^\+\+\+ b\/sample\.txt$/m)
  assert.match(diff, /^-two$/m)
  assert.match(diff, /^\+TWO$/m)
  assert.match(diff, /^\+six$/m)
  assert.match(diff, /@@ -\d+,\d+ \+\d+,\d+ @@/)
  assert.equal(createUnifiedDiff('same\n', 'same\n'), '')
  assert.equal(createUnifiedDiff('', 'added\n'), '--- a/file\n+++ b/file\n# 1 added, 0 removed\n@@ -0,0 +1,1 @@\n+added\n')

  const { base, root, state } = await fixture()
  let panel = null
  try {
    const started = await startPanel({ root, state })
    panel = started.panel
    const preview = await started.request('POST', '/api/preview', {
      path: 'notes.txt',
      content: 'hello\nworld\n',
    })
    assert.equal(preview.status, 200)
    assert.equal(preview.json.data.stats.added, 1)
    assert.equal(preview.json.data.stats.removed, 0)
    assert.match(preview.json.data.diff, /^\+world$/m)
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('binary and oversized files are read-only with an explanation', async () => {
  const { base, root, state } = await fixture()
  let panel = null
  try {
    await fsp.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]))
    await fsp.writeFile(path.join(root, 'big.txt'), 'x'.repeat(MAX_EDIT_BYTES + 1))
    const started = await startPanel({ root, state })
    panel = started.panel

    assert.equal(looksBinary(Buffer.from([0, 1])), true)
    assert.equal(looksBinary(Buffer.from('plain text')), false)

    const binary = await started.request('GET', '/api/file?path=blob.bin')
    assert.equal(binary.status, 200)
    assert.equal(binary.json.data.readOnly, 'binary')
    assert.equal(binary.json.data.content, null)
    assert.match(binary.json.data.note, /binary/)

    const big = await started.request('GET', '/api/file?path=big.txt')
    assert.equal(big.status, 200)
    assert.equal(big.json.data.readOnly, 'too-large')
    assert.equal(big.json.data.content, null)

    const save = await started.request('POST', '/api/save', {
      path: 'big.txt',
      content: 'small',
      expectedHash: big.json.data.hash,
      expectedMtimeMs: big.json.data.mtimeMs,
    })
    assert.equal(save.status, 409)
    assert.equal(save.json.error.id, 'read-only-too-large')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('the change tracker writes each run its own changed-file record', async () => {
  const { base, root, state } = await fixture()
  try {
    const baseStore = createStore(state)
    await baseStore.init()
    const { store } = createRunChangeTracker({ store: baseStore, root, stateRoot: state })
    const run = { id: 'run-change-1', status: 'queued', goal: 'edit files' }
    await store.write(run)
    await fsp.writeFile(path.join(root, 'src', 'app.js'), 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')
    await fsp.writeFile(path.join(root, 'new.txt'), 'created\n', 'utf8')
    await fsp.unlink(path.join(root, 'notes.txt'))
    run.status = 'completed'
    await store.write(run)

    // Reading through the same wrapper exercises the copied store methods.
    const persisted = await store.read('run-change-1')
    const changes = persisted.changes
    assert.equal(changes.root, root)
    assert.deepEqual(
      changes.files.map(item => `${item.change}:${item.path}`),
      ['added:new.txt', 'deleted:notes.txt', 'modified:src/app.js'],
    )
  } finally {
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('run views read changed files from the run record and render their diff', async () => {
  const { base, root, state } = await fixture()
  let panel = null
  try {
    const store = createStore(state)
    await store.init()
    await store.write({
      id: 'run-view-1',
      goal: 'touch app.js',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:05:00.000Z',
      changes: {
        root,
        recordedAt: '2026-01-01T00:05:00.000Z',
        files: [{ path: 'src/app.js', change: 'modified', beforeBytes: 10, afterBytes: 20 }],
      },
    })
    await fsp.writeFile(path.join(root, 'src', 'app.js'), 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')

    const started = await startPanel({ root, state, store })
    panel = started.panel
    const list = await started.request('GET', '/api/runs')
    assert.equal(list.status, 200)
    assert.equal(list.json.data.runs[0].id, 'run-view-1')
    assert.equal(list.json.data.runs[0].changedFiles, 1)

    const one = await started.request('GET', '/api/runs/run-view-1')
    assert.equal(one.status, 200)
    assert.equal(one.json.data.changes.files[0].path, 'src/app.js')

    const diff = await started.request('GET', '/api/runs/run-view-1/diff?path=src%2Fapp.js')
    assert.equal(diff.status, 200)
    assert.match(diff.json.data.diff, /^\+const c = 3$/m)
    assert.match(diff.json.data.note ?? '', /not a git repository|no git baseline|untracked/i)

    const unrelated = await started.request('GET', '/api/runs/run-view-1/diff?path=notes.txt')
    assert.equal(unrelated.status, 404)
    assert.equal(unrelated.json.error.id, 'not-in-run')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})

test('a run diff stays compact when the workspace is a git repository', async t => {
  const { base, root, state } = await fixture()
  let panel = null
  try {
    const git = (...args) => exec('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' })
    try {
      await git('init', '-q')
    } catch {
      t.skip('git is not installed')
      return
    }
    await git('config', 'user.name', 'test')
    await git('config', 'user.email', 'test@example.com')
    await git('add', '.')
    await git('commit', '-qm', 'base')
    await fsp.writeFile(path.join(root, 'src', 'app.js'), 'const a = 1\nconst b = 22\n', 'utf8')

    const store = createStore(state)
    await store.init()
    await store.write({
      id: 'run-git-1',
      goal: 'change b',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      changes: {
        root,
        recordedAt: '2026-01-01T00:01:00.000Z',
        files: [{ path: 'src/app.js', change: 'modified', beforeBytes: 20, afterBytes: 21 }],
      },
    })

    const started = await startPanel({ root, state, store })
    panel = started.panel
    const response = await started.request('GET', '/api/runs/run-git-1/diff?path=src%2Fapp.js')
    assert.equal(response.status, 200)
    assert.equal(response.json.data.baseline, 'git HEAD')
    assert.match(response.json.data.diff, /^-const b = 2$/m)
    assert.match(response.json.data.diff, /^\+const b = 22$/m)
    assert.doesNotMatch(response.json.data.diff, /^-const a = 1$/m)
    assert.ok(response.json.data.diff.split('\n').length < 20, 'git must supply the hunk, not a whole-file rewrite')
  } finally {
    if (panel) await panel.stop()
    await fsp.rm(base, { recursive: true, force: true })
  }
})
