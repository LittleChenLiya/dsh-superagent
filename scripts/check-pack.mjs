#!/usr/bin/env node
/**
 * Fail when `npm pack` would ship a package that cannot import itself.
 *
 * The release that motivated this shipped an `index.js` importing modules the
 * `files` whitelist had dropped; `npm pack` happily produced a 15-file tarball.
 * Run this after `npm pack`, or through `npm test`, which asserts the same
 * thing (test/pack.test.mjs) so CI cannot merge a broken whitelist.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPackedFiles, packFileList } from '../lib/doctor.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let packed
try {
  packed = await packFileList(packageRoot)
} catch (error) {
  console.error(`check-pack: ${error?.message ?? error}`)
  process.exit(1)
}

const result = await auditPackedFiles({ packageRoot, packed })
const problems = []
if (result.missing.length > 0) {
  problems.push(`imported but not packed (add them to "files"):\n${result.missing.map(file => `  ${file}`).join('\n')}`)
}
if (result.notPacked.length > 0) {
  problems.push(`listed in "files" but npm cannot find them:\n${result.notPacked.map(file => `  ${file}`).join('\n')}`)
}
if (problems.length > 0) {
  console.error(`check-pack: the tarball is incomplete\n\n${problems.join('\n\n')}`)
  process.exit(1)
}

console.log(
  `check-pack: ok — ${result.packed.length} file(s) in the tarball; `
  + `all ${result.required.length} file(s) reachable from the entry points are shipped`,
)
