import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cleanText,
  createMemory,
  effectiveEntries,
  extractMemoryBlock,
  isInside,
  normalizeScope,
  redact,
  slugKey,
} from '../lib/memory.js'
import { acquireFileLock } from '../lib/lock.js'

async function withRoot(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-memory-'))
  try {
    return await fn(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

test('redaction removes keys, bearer headers, blobs, emails and home paths', () => {
  const text = [
    'key sk-abcdefgh12345678',
    'header Bearer abcdefghijklmnop',
    'hex 0123456789abcdef0123456789abcdef01234567',
    'mail someone@example.com',
    String.raw`path C:\Users\alice\work`,
    'home /home/alice/work',
  ].join(' | ')
  const clean = redact(text)
  assert.doesNotMatch(clean, /sk-abcdefgh/)
  assert.doesNotMatch(clean, /someone@example\.com/)
  assert.doesNotMatch(clean, /alice/)
  assert.match(clean, /\[redacted-key\]/)
  assert.match(clean, /\[redacted-email\]/)
})

test('cleanText is one bounded line', () => {
  const text = cleanText('  first\n\nsecond\tthird  ', 12)
  assert.equal(text, 'first second')
  assert.doesNotMatch(text, /\n/)
})

test('a key is a lowercase slug and a scope cannot escape the memory directory', () => {
  assert.equal(slugKey('Deploy Target!'), 'deploy-target')
  assert.equal(slugKey('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugKey('sk-abcdefgh12345678'), 'redacted-key', 'a secret never survives in a key')
  assert.equal(normalizeScope('../../etc'), 'default')
  assert.equal(normalizeScope('Work_1'), 'work_1')
  assert.equal(isInside(path.join('/tmp', 'a', 'b'), path.join('/tmp', 'a')), true)
  assert.equal(isInside('/tmp/other', '/tmp/a'), false)
})

test('the fenced memory block is parsed and removed from the report', () => {
  const report = [
    '# Result',
    '',
    'Body text.',
    '',
    '```memory',
    JSON.stringify({
      entries: [
        { key: 'Deploy Target', kind: 'decision', text: 'staging is eu-west' },
        { key: 'deploy-target', kind: 'pitfall', text: 'old note wins is wrong' },
        { key: 'bad', kind: 'unknown-kind', text: 'stored as a note' },
        { key: 'empty', kind: 'note', text: '   ' },
      ],
    }),
    '```',
    '',
  ].join('\n')
  const { report: clean, entries, found } = extractMemoryBlock(report)
  assert.equal(found, true)
  assert.doesNotMatch(clean, /```memory/)
  assert.match(clean, /Body text\./)
  assert.equal(entries.length, 3, 'an empty note is dropped')
  assert.equal(entries[0].key, 'deploy-target')
  assert.equal(entries[0].kind, 'decision')
  assert.equal(entries[2].kind, 'note')
})

test('a malformed memory block is stripped and reported instead of shown', () => {
  const { report, entries, found, error } = extractMemoryBlock('answer\n\n```memory\nnot json\n```\n')
  assert.equal(found, true)
  assert.equal(report, 'answer')
  assert.deepEqual(entries, [])
  assert.match(error, /valid JSON/)
  assert.equal(extractMemoryBlock('no block here').found, false)
})

test('a note is superseded by key, retracted by a tombstone, and expired by age', () => {
  const now = Date.parse('2026-11-14T00:00:00.000Z')
  const records = [
    { key: 'deploy', kind: 'decision', text: 'old', ts: '2026-11-01T00:00:00.000Z' },
    { key: 'deploy', kind: 'decision', text: 'new', ts: '2026-11-10T00:00:00.000Z' },
    { key: 'trap', kind: 'pitfall', text: 'kept', ts: '2026-11-12T00:00:00.000Z' },
    { key: 'trap', status: 'retracted', text: '', ts: '2026-11-13T00:00:00.000Z' },
    { key: 'stale', kind: 'note', text: 'too old', ts: '2026-09-01T00:00:00.000Z' },
  ]
  const entries = effectiveEntries(records, { now, maxAgeDays: 30 })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].key, 'deploy')
  assert.equal(entries[0].text, 'new')
})

test('notes round-trip through the notebook and never store a secret in clear', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    const result = await memory.write({
      runId: 'run-1',
      entries: [
        { key: 'Deploy Target', kind: 'decision', text: 'staging is eu-west; token sk-abcdefgh12345678' },
        { key: 'next', kind: 'next', text: 'verify the rollout' },
      ],
    })
    assert.equal(result.written, 2)

    const raw = await fsp.readFile(memory.fileOf('default'), 'utf8')
    assert.doesNotMatch(raw, /sk-abcdefgh/)
    assert.match(raw, /\[redacted-key\]/)

    const read = await memory.read()
    assert.equal(read.entries.length, 2)
    const deploy = read.entries.find(entry => entry.key === 'deploy-target')
    assert.equal(deploy.kind, 'decision')

    const ignore = await fsp.readFile(path.join(memory.dir, '.gitignore'), 'utf8')
    assert.equal(ignore.trim(), '*')
  })
})

test('a run that settles twice writes its notes once', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    const entries = [{ key: 'decision', kind: 'decision', text: 'keep it' }]
    assert.equal((await memory.write({ runId: 'run-1', entries })).written, 1)
    const second = await memory.write({ runId: 'run-1', entries })
    assert.equal(second.written, 0)
    assert.match(second.reason ?? '', /already wrote/)
    assert.equal((await memory.read()).entries.length, 1)
  })
})

test('concurrent appends all survive and each line stays valid JSON', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    await memory.init()
    await Promise.all(Array.from({ length: 20 }, (_, index) => memory.write({
      runId: `run-${index}`,
      entries: [{ key: `topic-${index}`, kind: 'note', text: `fact ${index}` }],
    })))
    const lines = (await fsp.readFile(memory.fileOf('default'), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 20)
    for (const line of lines) JSON.parse(line)
    assert.equal((await memory.read()).entries.length, 20)
  })
})

test('a held scope lock does not lose the note, and compaction is skipped', async () => {
  await withRoot(async root => {
    const warnings = []
    const memory = createMemory(root, { warn: message => warnings.push(message) })
    await memory.init()
    const release = await acquireFileLock(path.join(memory.dir, 'default.lock'))
    assert.ok(release, 'the test must hold the lock')
    try {
      const result = await memory.write({ runId: 'run-locked', entries: [{ key: 'kept', kind: 'note', text: 'landed' }] })
      assert.equal(result.written, 1)
    } finally {
      await release()
    }
    assert.match(warnings.join('\n'), /locked by another process/)
    assert.equal((await memory.read()).entries[0].key, 'kept')
  })
})

test('a truncated last line is skipped instead of hiding the readable notes', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    await memory.init()
    const good = JSON.stringify({ key: 'kept', kind: 'note', text: 'readable', ts: new Date().toISOString() })
    await fsp.writeFile(memory.fileOf('default'), `${good}\n{"key":"cut"`, 'utf8')
    const read = await memory.read()
    assert.equal(read.bad, 1)
    assert.equal(read.entries.length, 1)
    assert.equal(read.entries[0].key, 'kept')
  })
})

test('the digest is bounded by entry count and characters', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    const entries = Array.from({ length: 30 }, (_, index) => ({
      key: `topic-${index}`,
      kind: 'note',
      text: `${index} ${'x'.repeat(300)}`,
    }))
    await memory.write({ runId: 'bulk', entries })
    const digest = await memory.digest({ maxEntries: 5, maxChars: 400 })
    const lines = digest.split('\n')
    assert.ok(lines.length <= 6, digest)
    assert.ok(digest.length <= 600, `${digest.length} chars`)
    assert.match(digest, /topic-29/, 'newest note comes first')
  })
})

test('compaction keeps the notebook bounded and drops old notes', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    const entries = Array.from({ length: 420 }, (_, index) => ({
      key: `topic-${index}`,
      kind: 'note',
      text: `fact ${index}`,
    }))
    await memory.write({ runId: 'bulk', entries, maxEntries: 60 })
    const lines = (await fsp.readFile(memory.fileOf('default'), 'utf8')).split('\n').filter(Boolean)
    assert.ok(lines.length <= 60, `${lines.length} lines left`)
    const read = await memory.read()
    assert.equal(read.entries.length, 60)
    assert.equal(read.entries[0].key, 'topic-419')  })
})

test('memoryMaxEntries is the compaction trigger, not only the keep size', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    for (let index = 0; index < 3; index++) {
      await memory.write({
        runId: `run-${index}`,
        entries: [{ key: `topic-${index}`, kind: 'note', text: `fact ${index}` }],
        maxEntries: 2,
      })
    }

    const lines = (await fsp.readFile(memory.fileOf('default'), 'utf8')).split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    assert.deepEqual((await memory.read()).entries.map(entry => entry.key), ['topic-2', 'topic-1'])
  })
})

test('forget retracts a note without leaving it visible', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    await memory.set({ key: 'deploy', kind: 'decision', text: 'staging' })
    assert.equal((await memory.read()).entries.length, 1)
    assert.equal((await memory.forget({ key: 'Deploy' })).forgotten, true)
    assert.equal((await memory.read()).entries.length, 0)
  })
})

test('a note with no text and an empty batch write nothing', async () => {
  await withRoot(async root => {
    const memory = createMemory(root)
    assert.equal((await memory.write({ runId: 'r', entries: [{ key: 'x', text: ' ' }] })).written, 0)
    assert.equal((await memory.write({ runId: 'r', entries: [] })).written, 0)
    assert.equal((await memory.read()).entries.length, 0)
  })
})
