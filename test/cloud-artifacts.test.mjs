import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CloudArtifactError,
  MAX_CLOUD_ARTIFACT_BYTES,
  finalizeCloudArtifacts,
} from '../lib/cloud-artifacts.js'

const FINALIZED_AT = '2026-11-26T12:00:00.000Z'
const FALLBACK_AT = '2026-11-26T12:05:00.000Z'
const hasCode = code => error => {
  assert.ok(error instanceof CloudArtifactError)
  assert.equal(error.code, code)
  return true
}
const missing = error => error?.code === 'ENOENT'

async function fixture(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-cloud-artifacts-'))
  const workspace = path.join(base, 'workspace')
  await fsp.mkdir(workspace)
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  return { base, workspace, realWorkspace: await fsp.realpath(workspace) }
}

function artifact(relativePath, content = 'artifact\n', overrides = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return {
    path: relativePath,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    encoding: 'base64',
    content: bytes.toString('base64'),
    ...overrides,
  }
}

function finalizeResult(entries, overrides = {}) {
  return {
    workerId: 'worker-1',
    artifactId: 'artifact-1',
    finalizedAt: FINALIZED_AT,
    manifest: { version: 1, algorithm: 'sha256', entries },
    ...overrides,
  }
}

function destination(fx, relativePath, runId = 'run-1') {
  return path.join(fx.realWorkspace, 'cloud-artifacts', runId, ...relativePath.split('/'))
}

function finalize(fx, result, overrides = {}) {
  return finalizeCloudArtifacts({
    result,
    workspace: fx.workspace,
    runId: 'run-1',
    now: () => Date.parse(FALLBACK_AT),
    ...overrides,
  })
}

async function directoryLink(target, link) {
  await fsp.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

async function temporaryFiles(directory) {
  const found = []
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.name.startsWith('.cloud-artifact-')) found.push(file)
      if (entry.isDirectory()) await visit(file)
    }
  }
  await visit(directory)
  return found
}

test('lands verified bytes under the run namespace and maps artifact kinds', async t => {
  const fx = await fixture(t)
  const entries = [
    artifact('reports/summary.md', '# Summary\n'),
    artifact('reports/page.HTML', '<h1>Summary</h1>\n'),
    artifact('images/pixel.PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff])),
    artifact('documents/spec.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0])),
    artifact('scripts/payload.js', 'process.exit(0)\n'),
    artifact('README', 'plain data\n'),
  ]
  const result = await finalize(fx, finalizeResult(entries))

  assert.deepEqual(Object.keys(result), ['artifactId', 'workspace', 'artifacts', 'totalBytes'])
  assert.equal(result.artifactId, 'artifact-1')
  assert.equal(result.workspace, fx.realWorkspace)
  assert.deepEqual(result.artifacts.map(item => item.kind), ['md', 'html', 'image', 'pdf', 'file', 'file'])
  assert.equal(result.totalBytes, entries.reduce((sum, entry) => sum + entry.size, 0))
  for (const [index, entry] of entries.entries()) {
    const item = result.artifacts[index]
    const file = destination(fx, entry.path)
    assert.deepEqual(item, {
      kind: item.kind,
      path: file,
      bytes: entry.size,
      sha256: entry.sha256,
      at: FINALIZED_AT,
    })
    assert.deepEqual(await fsp.readFile(file), Buffer.from(entry.content, 'base64'))
    const stat = await fsp.stat(file)
    assert.equal(stat.isFile(), true)
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o111, 0, 'artifact content must not be executable')
  }
  assert.deepEqual(await temporaryFiles(path.dirname(destination(fx, 'reports/summary.md'))), [])
})

test('preserves finalizedAt and uses the injected clock only as a fallback', async t => {
  const fx = await fixture(t)
  const withoutFinalizedAt = finalizeResult([artifact('note.md')], { finalizedAt: undefined })
  const result = await finalize(fx, withoutFinalizedAt, { now: () => new Date(FALLBACK_AT) })
  assert.equal(result.artifacts[0].at, FALLBACK_AT)
  await assert.rejects(finalize(fx, withoutFinalizedAt, { now: () => 'not-a-date' }), hasCode('CLOUD_ARTIFACT_INVALID_INPUT'))
  await assert.rejects(finalize(fx, finalizeResult([]), { now: 123 }), hasCode('CLOUD_ARTIFACT_INVALID_INPUT'))
  await assert.rejects(finalize(fx, finalizeResult([], { finalizedAt: 'not-a-date' })), hasCode('CLOUD_ARTIFACT_INVALID_INPUT'))
})

test('requires an existing absolute real workspace and a safe run id', async t => {
  const fx = await fixture(t)
  const result = finalizeResult([artifact('note.md')])
  await assert.rejects(finalizeCloudArtifacts({ result, workspace: 'relative/path', runId: 'run-1' }),
    hasCode('CLOUD_ARTIFACT_WORKSPACE'))
  await assert.rejects(finalizeCloudArtifacts({ result, workspace: path.join(fx.base, 'missing'), runId: 'run-1' }),
    hasCode('CLOUD_ARTIFACT_WORKSPACE'))
  const workspaceFile = path.join(fx.base, 'workspace-file')
  await fsp.writeFile(workspaceFile, 'not a directory')
  await assert.rejects(finalizeCloudArtifacts({ result, workspace: workspaceFile, runId: 'run-1' }),
    hasCode('CLOUD_ARTIFACT_WORKSPACE'))
  const linkedWorkspace = path.join(fx.base, 'linked-workspace')
  await directoryLink(fx.workspace, linkedWorkspace)
  await assert.rejects(finalizeCloudArtifacts({ result, workspace: linkedWorkspace, runId: 'run-1' }),
    hasCode('CLOUD_ARTIFACT_SYMLINK'))
  for (const runId of ['', '.', '..', '../escape', 'nested/run', 'run\\escape', 'run:1']) {
    await assert.rejects(finalize(fx, result, { runId }), hasCode('CLOUD_ARTIFACT_INVALID_INPUT'))
  }
})

test('rejects absolute, parent, ambiguous, duplicate, and Windows-style entry paths', async t => {
  const fx = await fixture(t)
  const unsafePaths = [
    '/absolute.md',
    'C:\\absolute.md',
    '\\\\server\\share\\artifact.md',
    '..',
    '../escape.md',
    'nested/../../escape.md',
    'nested\\escape.md',
    'nested//artifact.md',
    'nested/./artifact.md',
    'nested/../artifact.md',
    'artifact.md/',
    '',
    'nul\0.md',
  ]
  for (const unsafe of unsafePaths) {
    await assert.rejects(finalize(fx, finalizeResult([artifact(unsafe)])), hasCode('CLOUD_ARTIFACT_PATH'))
  }
  const valid = artifact('same.md')
  await assert.rejects(finalize(fx, finalizeResult([valid, valid])), hasCode('CLOUD_ARTIFACT_DUPLICATE'))
  await assert.rejects(finalize(fx, finalizeResult([artifact('file'), artifact('file/child.md')])),
    hasCode('CLOUD_ARTIFACT_PATH_CONFLICT'))
  if (process.platform === 'win32') {
    await assert.rejects(finalize(fx, finalizeResult([artifact('case.md'), artifact('CASE.md')])),
      hasCode('CLOUD_ARTIFACT_PATH_CONFLICT'))
  }
})

test('rejects symbolic-link parents, symbolic-link targets, and non-file destinations', async t => {
  const fx = await fixture(t)
  const root = path.join(fx.realWorkspace, 'cloud-artifacts', 'run-1')
  const outside = path.join(fx.base, 'outside')
  await fsp.mkdir(root, { recursive: true })
  await fsp.mkdir(outside)
  await fsp.writeFile(path.join(outside, 'secret.md'), 'outside\n')

  await directoryLink(outside, path.join(root, 'linked-parent'))
  await assert.rejects(finalize(fx, finalizeResult([artifact('linked-parent/secret.md')])),
    hasCode('CLOUD_ARTIFACT_SYMLINK'))
  assert.equal(await fsp.readFile(path.join(outside, 'secret.md'), 'utf8'), 'outside\n')

  await directoryLink(outside, path.join(root, 'linked-target'))
  await assert.rejects(finalize(fx, finalizeResult([artifact('linked-target')])), hasCode('CLOUD_ARTIFACT_SYMLINK'))

  await fsp.mkdir(path.join(root, 'directory.md'))
  await assert.rejects(finalize(fx, finalizeResult([artifact('directory.md')])), hasCode('CLOUD_ARTIFACT_NOT_FILE'))
})

test('validates canonical base64, size, digest, algorithm, version, and total bytes before writing', async t => {
  const fx = await fixture(t)
  const valid = artifact('valid.md')
  const cases = [
    [{ ...valid, content: 'not base64!' }, 'CLOUD_ARTIFACT_ENCODING'],
    [{ ...valid, content: `${valid.content}\n` }, 'CLOUD_ARTIFACT_ENCODING'],
    [{ ...valid, encoding: 'hex' }, 'CLOUD_ARTIFACT_ENCODING'],
    [{ ...valid, content: undefined }, 'CLOUD_ARTIFACT_CONTENT'],
    [{ ...valid, size: valid.size + 1 }, 'CLOUD_ARTIFACT_SIZE'],
    [{ ...valid, size: -1 }, 'CLOUD_ARTIFACT_SIZE'],
    [{ ...valid, size: Number.MAX_SAFE_INTEGER + 1 }, 'CLOUD_ARTIFACT_SIZE'],
    [{ ...valid, sha256: '0'.repeat(64) }, 'CLOUD_ARTIFACT_DIGEST'],
    [{ ...valid, sha256: 'not-a-digest' }, 'CLOUD_ARTIFACT_DIGEST'],
  ]
  for (const [entry, code] of cases) {
    await assert.rejects(finalize(fx, finalizeResult([entry])), hasCode(code))
  }
  await assert.rejects(finalize(fx, finalizeResult([valid], {
    manifest: { version: 1, algorithm: 'md5', entries: [valid] },
  })), hasCode('CLOUD_ARTIFACT_ALGORITHM'))
  await assert.rejects(finalize(fx, finalizeResult([valid], {
    manifest: { version: 0, algorithm: 'sha256', entries: [valid] },
  })), hasCode('CLOUD_ARTIFACT_MANIFEST'))

  const empty = artifact('empty.bin', '')
  await assert.rejects(finalize(fx, finalizeResult([
    { ...empty, size: MAX_CLOUD_ARTIFACT_BYTES },
    { ...empty, path: 'one-more.bin', size: 1 },
  ])), hasCode('CLOUD_ARTIFACT_TOTAL_BYTES'))
  await assert.rejects(finalize(fx, finalizeResult([valid, { ...valid, path: 'bad.md', sha256: '0'.repeat(64) }])),
    hasCode('CLOUD_ARTIFACT_DIGEST'))
  await assert.rejects(fsp.access(destination(fx, 'valid.md')), missing, 'validation must finish before the first write')
})

test('same-digest retries are idempotent sequentially and concurrently', async t => {
  const fx = await fixture(t)
  const result = finalizeResult([artifact('nested/report.md', 'stable content\n')])
  const first = await finalize(fx, result)
  const file = first.artifacts[0].path
  const before = await fsp.stat(file)
  const second = await finalize(fx, result)
  const after = await fsp.stat(file)
  assert.deepEqual(second, first)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)

  const concurrent = await Promise.all(Array.from({ length: 4 }, () => finalize(fx, result)))
  assert.ok(concurrent.every(item => JSON.stringify(item) === JSON.stringify(first)))
  assert.deepEqual(await temporaryFiles(path.dirname(file)), [])
})

test('different existing content is preserved and reported as a conflict', async t => {
  const fx = await fixture(t)
  const original = finalizeResult([artifact('report.md', 'original\n')])
  const first = await finalize(fx, original)
  const file = first.artifacts[0].path
  await assert.rejects(finalize(fx, finalizeResult([artifact('report.md', 'modified\n')])),
    hasCode('CLOUD_ARTIFACT_CONFLICT'))
  await assert.rejects(finalize(fx, finalizeResult([artifact('report.md', 'different size\n')])),
    hasCode('CLOUD_ARTIFACT_CONFLICT'))
  assert.equal(await fsp.readFile(file, 'utf8'), 'original\n')
})

test('a known conflict in a later entry leaves no earlier artifact behind', async t => {
  const fx = await fixture(t)
  const root = path.join(fx.realWorkspace, 'cloud-artifacts', 'run-1')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'second.md'), 'local content\n')
  await assert.rejects(finalize(fx, finalizeResult([
    artifact('first.md', 'remote content\n'),
    artifact('second.md', 'other remote content\n'),
  ])), hasCode('CLOUD_ARTIFACT_CONFLICT'))
  await assert.rejects(fsp.access(path.join(root, 'first.md')), missing)
  assert.equal(await fsp.readFile(path.join(root, 'second.md'), 'utf8'), 'local content\n')
})

test('publication is staged, exclusive, and rolls back earlier files if a later commit fails', async t => {
  const fx = await fixture(t)
  const result = finalizeResult([artifact('first.md', 'first\n'), artifact('second.md', 'second\n')])
  const originalLink = fsp.link
  let calls = 0
  t.mock.method(fsp, 'link', async (...args) => {
    calls += 1
    await assert.rejects(fsp.access(args[1]), missing, 'the final path must not appear before commit')
    assert.equal(await fsp.readFile(args[0], 'utf8'), calls === 1 ? 'first\n' : 'second\n')
    if (calls === 2) throw Object.assign(new Error('injected commit failure'), { code: 'EIO' })
    return originalLink(...args)
  })

  await assert.rejects(finalize(fx, result), hasCode('CLOUD_ARTIFACT_IO'))
  assert.equal(calls, 2)
  await assert.rejects(fsp.access(destination(fx, 'first.md')), missing)
  await assert.rejects(fsp.access(destination(fx, 'second.md')), missing)
  assert.deepEqual(await temporaryFiles(path.join(fx.realWorkspace, 'cloud-artifacts', 'run-1')), [])
})

test('a parent swapped for a symbolic link during staging cannot leave an escaped file', async t => {
  const fx = await fixture(t)
  const root = path.join(fx.realWorkspace, 'cloud-artifacts', 'run-1')
  const parent = path.join(root, 'raced')
  const moved = path.join(root, 'raced-original')
  const outside = path.join(fx.base, 'race-outside')
  await fsp.mkdir(outside)
  const originalOpen = fsp.open
  let swapped = false
  t.mock.method(fsp, 'open', async (file, ...args) => {
    if (!swapped && typeof file === 'string' && path.dirname(file) === parent && args[0] === 'wx') {
      swapped = true
      await fsp.rename(parent, moved)
      await directoryLink(outside, parent)
    }
    return originalOpen(file, ...args)
  })

  await assert.rejects(finalize(fx, finalizeResult([artifact('raced/escape.md')])), hasCode('CLOUD_ARTIFACT_SYMLINK'))
  assert.equal(swapped, true)
  assert.deepEqual(await fsp.readdir(outside), [])
  assert.deepEqual(await fsp.readdir(moved), [])
})

test('artifact content is never executed', async t => {
  const fx = await fixture(t)
  const marker = path.join(fx.base, 'executed')
  const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`
  const result = await finalize(fx, finalizeResult([
    artifact('payload.js', source),
    artifact('payload.html', `<script>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')</script>`),
  ]))
  assert.equal(result.totalBytes, Buffer.byteLength(source) + Buffer.byteLength(`<script>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')</script>`))
  await assert.rejects(fsp.access(marker, constants.F_OK), missing)
})
