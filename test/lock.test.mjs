import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acquireFileLock } from '../lib/lock.js'

async function tempLock(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-lock-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return path.join(dir, 'state.lock')
}

test('two concurrent stale breakers cannot both acquire the same lock', async t => {
  const file = await tempLock(t)
  await fsp.writeFile(file, `${JSON.stringify({
    pid: 4321,
    hostname: 'another-host',
    at: '2020-01-01T00:00:00.000Z',
    token: 'stale',
  })}\n`)

  const originalUnlink = fsp.unlink
  let first = true
  let open
  const opened = new Promise(resolve => { open = resolve })
  const timer = setTimeout(open, 100)
  fsp.unlink = async target => {
    if (target === file) {
      if (!first) {
        const result = await originalUnlink(target)
        open()
        return result
      }
      first = false
      await opened
    }
    return originalUnlink(target)
  }
  let releases
  try {
    releases = await Promise.all([
      acquireFileLock(file),
      acquireFileLock(file),
    ])
  } finally {
    clearTimeout(timer)
    fsp.unlink = originalUnlink
    open()
  }

  assert.equal(releases.filter(Boolean).length, 1, 'only one stale breaker may win')
  await Promise.all(releases.filter(Boolean).map(release => release()))
})

test('a stale breaker fails closed instead of racing another reclaimer', async t => {
  const file = await tempLock(t)
  const stale = { pid: 4321, hostname: 'another-host', at: '2020-01-01T00:00:00.000Z', token: 'stale' }
  await fsp.writeFile(file, `${JSON.stringify(stale)}\n`)
  await fsp.writeFile(`${file}.break`, `${JSON.stringify(stale)}\n`)

  await assert.rejects(acquireFileLock(file), /stale lock breaker/)
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), stale)
  assert.deepEqual(JSON.parse(await fsp.readFile(`${file}.break`, 'utf8')), stale)
})

test('a busy breaker makes release fail loudly instead of leaking the lock silently', async t => {
  const file = await tempLock(t)
  const release = await acquireFileLock(file)
  const busy = { pid: process.pid, hostname: os.hostname(), at: new Date().toISOString(), token: 'busy' }
  await fsp.writeFile(`${file}.break`, `${JSON.stringify(busy)}\n`)

  await assert.rejects(release(), /lock breaker is busy/)
  assert.ok(JSON.parse(await fsp.readFile(file, 'utf8')).token)
  await fsp.unlink(`${file}.break`)
  await release()
})

test('a late release cannot unlink a replacement lock', async t => {
  const file = await tempLock(t)
  const release = await acquireFileLock(file)
  assert.ok(release)
  const replacement = { pid: process.pid, hostname: os.hostname(), at: new Date().toISOString(), token: 'replacement' }
  await fsp.writeFile(file, `${JSON.stringify(replacement)}\n`)

  await release()

  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), replacement)
})
