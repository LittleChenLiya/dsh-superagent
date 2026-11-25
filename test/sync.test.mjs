import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSync, IGNORE_PATTERNS, mergeIgnore } from '../lib/sync.js'

/**
 * The whole module shells out to git, so the tests use a real bare repository
 * and two real state directories. There is no fake for that: the point of the
 * feature is what git does with these files.
 */
let gitReady = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitReady = false
}

const withGit = gitReady
  ? test
  : (name, fn) => test(name, { skip: 'git is not installed' }, fn)

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} in ${cwd} failed: ${(stderr || error.message).trim()}`))
      else resolve(String(stdout ?? '').trim())
    })
  })
}

async function withTemp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-sync-'))
  try {
    return await fn(dir)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

async function write(root, relative, text) {
  const file = path.join(root, relative)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, 'utf8')
  return file
}

/** A bare remote plus two independent state directories pointed at it. */
async function setupPair(dir) {
  const remote = path.join(dir, 'remote.git')
  await fsp.mkdir(remote, { recursive: true })
  await git(remote, ['init', '--bare'])
  const aRoot = path.join(dir, 'a', 'state')
  const bRoot = path.join(dir, 'b', 'state')
  const a = createSync(aRoot, { hostname: 'machine-a' })
  const b = createSync(bRoot, { hostname: 'machine-b' })
  await a.init({ remote })
  await b.init({ remote })
  return { remote, a, b, aRoot, bRoot }
}

test('the managed ignore block refreshes in place and leaves user lines alone', () => {
  const first = mergeIgnore('node_modules/\n')
  assert.match(first.text, /^node_modules\//, 'a user entry outside the block survives')
  for (const pattern of IGNORE_PATTERNS) {
    assert.ok(first.text.split('\n').includes(pattern), `${pattern} is ignored`)
  }
  const second = mergeIgnore(first.text)
  assert.equal(second.changed, false, 'a second init does not rewrite the file')
  assert.equal(second.text, first.text)
})

withGit('init commits the state and keeps credentials, locks and temp files out', async () => {
  await withTemp(async dir => {
    const remote = path.join(dir, 'remote.git')
    await fsp.mkdir(remote, { recursive: true })
    await git(remote, ['init', '--bare'])
    const root = path.join(dir, 'state')
    await write(root, 'runs/run-1.json', '{"id":"run-1"}\n')
    await write(root, 'runs/run-1.lock', '{"pid":1}\n')
    await write(root, 'runs/run-2.cancel', '{"pid":1}\n')
    await write(root, 'runs/run-3.json.corrupt-1700000000000', 'not json\n')
    await write(root, 'runs/.run-4.123.1.tmp', 'half written\n')
    await write(root, '.owner', '{"hostname":"machine-a"}\n')
    await write(root, 'control.json', '{"token":"secret"}\n')
    for (const tokenFile of ['workbench.json', 'console.json', 'board.json']) {
      await write(root, tokenFile, '{"token":"secret"}\n')
    }
    await write(root, 'console-workbench.json', '{"sessions":{}}\n')
    await write(root, 'notifications.json', '{"hour":[]}\n')
    await write(root, 'memory/.gitignore', '*\n')
    await write(root, 'memory/default.jsonl', '{"note":"one","at":"2026-11-14T00:00:00Z"}\n')

    const sync = createSync(root, { hostname: 'machine-a' })
    const result = await sync.init({ remote })

    assert.equal(result.created, true)
    assert.ok(result.commit, 'the first commit exists')
    assert.equal(result.remoteAction, 'added')
    assert.equal(result.memorySynced, true)
    assert.match(await git(root, ['log', '-1', '--format=%s']), /^sync init: machine-a /)

    const tracked = (await git(root, ['ls-files'])).split('\n').filter(Boolean)
    assert.ok(tracked.includes('.gitignore'))
    assert.ok(tracked.includes('runs/run-1.json'), 'run state is what gets synced')
    assert.ok(tracked.includes('memory/default.jsonl'), 'notes cross machines too')
    for (const local of [
      'runs/run-1.lock',
      'runs/run-2.cancel',
      'runs/run-3.json.corrupt-1700000000000',
      'runs/.run-4.123.1.tmp',
      '.owner',
      'control.json',
      'workbench.json',
      'console.json',
      'console-workbench.json',
      'board.json',
      'notifications.json',
    ]) {
      assert.ok(!tracked.includes(local), `${local} must never be pushed`)
    }

    const ignore = await fsp.readFile(path.join(root, '.gitignore'), 'utf8')
    for (const pattern of IGNORE_PATTERNS) {
      assert.ok(ignore.split('\n').includes(pattern), `${pattern} is written to .gitignore`)
    }
  })
})

withGit('sync refuses token files already tracked under different casing', async () => {
  await withTemp(async dir => {
    const remote = path.join(dir, 'remote.git')
    await fsp.mkdir(remote, { recursive: true })
    await git(remote, ['init', '--bare'])
    const root = path.join(dir, 'state')
    const sync = createSync(root, { hostname: 'machine-a' })
    await sync.init({ remote })
    await write(root, 'nested/CONSOLE.JSON', '{"token":"secret"}\n')
    await git(root, ['add', '-f', 'nested/CONSOLE.JSON'])

    await assert.rejects(() => sync.init({ remote }), /refusing to sync tracked token file.*nested\/CONSOLE\.JSON/)
    assert.equal((await git(root, ['log', '-1', '--format=%s'])).startsWith('sync init:'), true)
  })
})

withGit('a second init refreshes the remote in place instead of failing', async () => {
  await withTemp(async dir => {
    const first = path.join(dir, 'first.git')
    const second = path.join(dir, 'second.git')
    for (const bare of [first, second]) {
      await fsp.mkdir(bare, { recursive: true })
      await git(bare, ['init', '--bare'])
    }
    const root = path.join(dir, 'state')
    const sync = createSync(root, { hostname: 'machine-a' })
    await sync.init({ remote: first })
    const again = await sync.init({ remote: second })
    assert.equal(again.created, false)
    assert.equal(again.remoteAction, 'updated')
    assert.equal(await git(root, ['remote', 'get-url', 'origin']), second)
  })
})

withGit('pull stashes uncommitted local work, merges, and reapplies it', async () => {
  await withTemp(async dir => {
    const { a, b, aRoot, bRoot } = await setupPair(dir)
    await a.push()
    await b.pull()

    await write(aRoot, 'runs/run-a.json', '{"id":"run-a","status":"completed"}\n')
    await a.push()

    // Machine B has work that was never committed. It must survive the pull.
    await write(bRoot, 'runs/run-b.json', '{"id":"run-b","status":"running"}\n')
    const pulled = await b.pull()

    assert.ok(pulled.stash, 'the dirty tree is stashed before merging')
    assert.match(pulled.stash.message, /dsh-sync auto-stash/)
    assert.equal(pulled.stash.files, 1)
    assert.equal(pulled.stash.reapplied, true)
    assert.deepEqual(pulled.conflicts, [])
    assert.equal(JSON.parse(await fsp.readFile(path.join(bRoot, 'runs/run-a.json'), 'utf8')).id, 'run-a')
    assert.equal(JSON.parse(await fsp.readFile(path.join(bRoot, 'runs/run-b.json'), 'utf8')).id, 'run-b')

    const status = await b.status()
    assert.equal(status.stashes.length, 0, 'the stash is dropped once it is back in the tree')
    assert.equal(status.dirty, 1)
  })
})

withGit('two edits of one run file stop the merge and name the path', async () => {
  await withTemp(async dir => {
    const { a, b, aRoot, bRoot } = await setupPair(dir)
    await write(aRoot, 'runs/shared.json', '{"id":"shared","status":"running"}\n')
    await a.push()
    await b.pull()

    await write(aRoot, 'runs/shared.json', '{"id":"shared","status":"completed"}\n')
    await a.push()

    await write(bRoot, 'runs/shared.json', '{"id":"shared","status":"cancelled"}\n')
    const rejected = await b.push()
    assert.equal(rejected.pushed, false)
    assert.equal(rejected.rejected, true, 'a commit that the remote does not have is refused, not force-pushed')

    const pulled = await b.pull()
    assert.deepEqual(pulled.conflicts, ['runs/shared.json'])
    assert.equal(pulled.merged, false)

    const text = await fsp.readFile(path.join(bRoot, 'runs/shared.json'), 'utf8')
    assert.match(text, /<<<<<<< /, 'both sides stay in the file')
    assert.match(text, /completed/)
    assert.match(text, /cancelled/)

    const status = await b.status()
    assert.deepEqual(status.conflicts, ['runs/shared.json'])

    // Pulling again before resolving repeats the same list instead of failing.
    const again = await b.pull()
    assert.deepEqual(again.conflicts, ['runs/shared.json'])

    await assert.rejects(() => b.push(), /unresolved conflict/)
  })
})

withGit('status counts what is ahead, behind and clean', async () => {
  await withTemp(async dir => {
    const { remote, a, b, aRoot, bRoot } = await setupPair(dir)
    await a.push()
    await b.pull()
    // After the first push the two histories match, so the counts are about
    // new work only — not about the unrelated root commits a second machine
    // starts with.
    await b.push()

    const clean = await b.status()
    assert.equal(clean.remote, remote)
    assert.equal(clean.ahead, 0)
    assert.equal(clean.behind, 0)
    assert.equal(clean.dirty, 0)
    assert.deepEqual(clean.conflicts, [])

    await write(bRoot, 'runs/run-b.json', '{"id":"run-b"}\n')
    await git(bRoot, ['add', '-A'])
    await git(bRoot, ['commit', '-m', 'local only'])
    const ahead = await b.status()
    assert.equal(ahead.ahead, 1)
    assert.equal(ahead.behind, 0)

    await a.pull()
    await write(aRoot, 'runs/run-a.json', '{"id":"run-a"}\n')
    await a.push()
    const behind = await b.status()
    assert.equal(behind.ahead, 1)
    assert.equal(behind.behind, 1)
    assert.ok(behind.head, 'the last local commit is reported')
  })
})

withGit('a directory that was never initialized says how to start', async () => {
  await withTemp(async dir => {
    const root = path.join(dir, 'state')
    await fsp.mkdir(root, { recursive: true })
    const sync = createSync(root, { hostname: 'machine-a' })
    await assert.rejects(() => sync.pull(), /not a git repository/)
    await assert.rejects(() => sync.status(), /not a git repository/)
    await assert.rejects(() => sync.init({ remote: '  ' }), /needs a git remote/)
  })
})
