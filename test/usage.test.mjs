import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import zlib from 'node:zlib'

import { createUsageReader } from '../lib/usage.js'

function event(usage, source = { kind: 'model', provider: 'dashscope', model: 'qwen-flash' }) {
  return JSON.stringify({ type: 'model/usage', data: { usage, message: { source } } })
}

function frame(...lines) {
  return zlib.zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'))
}

async function sessionsDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-usage-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeLog(root, childId, buffer) {
  const dir = path.join(root, 'workspace-a', `session-${childId}`)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'session.20260101.zstd'), buffer)
}

test('usage sums every recorded model call across zstd frames', async t => {
  const root = await sessionsDir(t)
  const log = Buffer.concat([
    frame(event({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, totalTokens: 110 })),
    frame(event({ inputTokens: 200, outputTokens: 20, totalTokens: 220 })),
  ])
  await writeLog(root, 'child-a', log)

  const readUsage = createUsageReader({ sessionsRoot: root })
  const usage = await readUsage('child-a')

  assert.equal(usage.inputTokens, 300)
  assert.equal(usage.outputTokens, 30)
  assert.equal(usage.cacheReadTokens, 40)
  assert.equal(usage.modelCalls, 2)
  assert.equal(usage.models['dashscope/qwen-flash'].calls, 2)
  assert.equal(usage.models['dashscope/qwen-flash'].inputTokens, 300)
})

test('a child session with no usage events reads as null', async t => {
  const root = await sessionsDir(t)
  await writeLog(root, 'child-empty', frame(JSON.stringify({ type: 'message', data: { text: 'hello' } })))

  const readUsage = createUsageReader({ sessionsRoot: root })
  assert.equal(await readUsage('child-empty'), null)
})

test('an unknown child id reads as null instead of throwing', async t => {
  const root = await sessionsDir(t)
  await fsp.mkdir(path.join(root, 'workspace-a'), { recursive: true })
  const readUsage = createUsageReader({ sessionsRoot: root })

  assert.equal(await readUsage('nope'), null)
  assert.equal(await readUsage(''), null)
})

test('junk after the last frame does not hide the readable usage', async t => {
  const root = await sessionsDir(t)
  const warnings = []
  // A torn tail is what a killed host leaves behind; the readable frame must
  // still be counted, and decoding must not throw out of the reader.
  const log = Buffer.concat([
    frame(event({ inputTokens: 5, outputTokens: 1, totalTokens: 6 })),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]),
  ])
  await writeLog(root, 'child-broken', log)

  const readUsage = createUsageReader({ sessionsRoot: root, warn: message => warnings.push(message) })
  const usage = await readUsage('child-broken')

  assert.equal(usage.inputTokens, 5)
  assert.equal(usage.modelCalls, 1)
})

test('child sessions are also found under their bare id folder', async t => {
  const root = await sessionsDir(t)
  const dir = path.join(root, 'workspace-b', 'child-plain')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'session.1.zstd'), frame(event({ inputTokens: 7, outputTokens: 3, totalTokens: 10 })))

  const readUsage = createUsageReader({ sessionsRoot: root })
  const usage = await readUsage('child-plain')

  assert.equal(usage.inputTokens, 7)
  assert.equal(usage.outputTokens, 3)
})

test('usage without a model source is counted but not attributed to a model', async t => {
  const root = await sessionsDir(t)
  await writeLog(root, 'child-nosource', frame(event({ inputTokens: 9, outputTokens: 4, totalTokens: 13 }, { kind: 'tool' })))

  const readUsage = createUsageReader({ sessionsRoot: root })
  const usage = await readUsage('child-nosource')

  assert.equal(usage.modelCalls, 1)
  assert.equal(usage.inputTokens, 9)
  assert.deepEqual(usage.models, {})
})
