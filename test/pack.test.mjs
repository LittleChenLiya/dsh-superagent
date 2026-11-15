import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { auditPackedFiles, packFileList } from '../lib/doctor.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The release guard: `npm pack --dry-run` must list every file the entry points
 * import. This runs in CI as part of `npm test`, so a `files` entry dropped by
 * hand cannot reach a tag again.
 */
test('npm pack ships every file the plugin imports', { timeout: 120_000 }, async () => {
  const packed = await packFileList(packageRoot)
  const result = await auditPackedFiles({ packageRoot, packed })

  assert.deepEqual(
    result.missing,
    [],
    `these imported files are missing from the tarball (add them to "files"): ${result.missing.join(', ')}`,
  )
  assert.deepEqual(
    result.notPacked,
    [],
    `"files" lists paths npm cannot find: ${result.notPacked.join(', ')}`,
  )
  assert.ok(packed.length > 0, 'npm pack reported no files')
  // The doctor itself is part of the guard: if it ever drops out of the
  // tarball, this test fails instead of the command disappearing quietly.
  assert.ok(result.required.includes('bin/doctor.js'))
  assert.ok(result.required.includes('lib/doctor.js'))
})
