/**
 * Safely land inline artifacts returned by the cloud Worker finalize protocol.
 *
 * Artifact bytes are data only: this module never imports, evaluates, or runs
 * them. Files are staged in their destination directory and published with an
 * exclusive hard link, so a partially written file is never visible and an
 * existing file is never replaced.
 *
 * @module dsh-superagent/cloud-artifacts
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { verifyArtifactManifest } from './cloud-worker.js'

/** Maximum combined decoded size of one finalize result. */
export const MAX_CLOUD_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 10_000
const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/
const IMAGE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp',
])

export class CloudArtifactError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'CloudArtifactError'
    this.code = code
    if (details.path !== undefined) this.path = details.path
  }
}

function fail(code, message, details) {
  throw new CloudArtifactError(code, message, details)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requireString(value, field, maximum = 512) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
    fail('CLOUD_ARTIFACT_INVALID_INPUT', `${field} must be a bounded, non-empty single-line string`)
  }
  return value
}

function isoAt(value, field) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    fail('CLOUD_ARTIFACT_INVALID_INPUT', `${field} must be a valid timestamp`)
  }
  return date.toISOString()
}

function clockAt(now) {
  if (now !== undefined && typeof now !== 'function') {
    fail('CLOUD_ARTIFACT_INVALID_INPUT', 'now must be a function')
  }
  return isoAt(now === undefined ? Date.now() : now(), 'now()')
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function pathIdentity(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

async function lstatOrNull(file) {
  try {
    return await fsp.lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    fail('CLOUD_ARTIFACT_IO', 'Cannot inspect an artifact path', { path: file, cause: error })
  }
}

async function checkedDirectory(directory, boundary) {
  if (!contained(boundary, directory)) {
    fail('CLOUD_ARTIFACT_PATH_ESCAPE', 'Artifact directory escapes its workspace', { path: directory })
  }
  const relative = path.relative(boundary, directory)
  const parts = relative === '' ? [] : relative.split(path.sep)
  let current = boundary
  for (let index = 0; index <= parts.length; index += 1) {
    if (index > 0) current = path.join(current, parts[index - 1])
    const stat = await lstatOrNull(current)
    if (!stat) fail('CLOUD_ARTIFACT_PATH_MISSING', 'Artifact directory no longer exists', { path: current })
    if (stat.isSymbolicLink()) {
      fail('CLOUD_ARTIFACT_SYMLINK', 'Artifact directories may not be symbolic links', { path: current })
    }
    if (!stat.isDirectory()) {
      fail('CLOUD_ARTIFACT_NOT_DIRECTORY', 'Artifact path contains a non-directory component', { path: current })
    }
    let real
    try {
      real = await fsp.realpath(current)
    } catch (error) {
      fail('CLOUD_ARTIFACT_IO', 'Cannot resolve an artifact directory', { path: current, cause: error })
    }
    if (!contained(boundary, real)) {
      fail('CLOUD_ARTIFACT_PATH_ESCAPE', 'Artifact directory resolves outside its workspace', { path: current })
    }
  }
  return fsp.realpath(directory)
}

async function ensureDirectories(base, parts, boundary) {
  let current = base
  for (const part of parts) {
    current = path.join(current, part)
    const before = await lstatOrNull(current)
    if (!before) {
      try {
        await fsp.mkdir(current, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          fail('CLOUD_ARTIFACT_IO', 'Cannot create an artifact directory', { path: current, cause: error })
        }
      }
    }
    const stat = await lstatOrNull(current)
    if (!stat) fail('CLOUD_ARTIFACT_IO', 'Artifact directory disappeared during creation', { path: current })
    if (stat.isSymbolicLink()) {
      fail('CLOUD_ARTIFACT_SYMLINK', 'Artifact directories may not be symbolic links', { path: current })
    }
    if (!stat.isDirectory()) {
      fail('CLOUD_ARTIFACT_NOT_DIRECTORY', 'Artifact path contains a non-directory component', { path: current })
    }
  }
  return checkedDirectory(current, boundary)
}

function artifactKind(relativePath) {
  const extension = path.posix.extname(relativePath).slice(1).toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'md'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return 'file'
}

function validateFinalizeResult(result, now) {
  if (!isPlainObject(result)) fail('CLOUD_ARTIFACT_INVALID_INPUT', 'result must be an object')
  if (!isPlainObject(result.manifest)) fail('CLOUD_ARTIFACT_MANIFEST', 'result.manifest must be an object')
  requireString(result.workerId, 'result.workerId')
  const artifactId = requireString(result.artifactId, 'result.artifactId')
  if (!Number.isSafeInteger(result.manifest.version) || result.manifest.version < 1) {
    fail('CLOUD_ARTIFACT_MANIFEST', 'result.manifest.version must be a positive safe integer')
  }
  if (result.manifest.algorithm !== 'sha256') {
    fail('CLOUD_ARTIFACT_ALGORITHM', 'Only SHA-256 artifact manifests are supported')
  }
  if (!Array.isArray(result.manifest.entries) || result.manifest.entries.length > MAX_ENTRIES) {
    fail('CLOUD_ARTIFACT_MANIFEST', `result.manifest.entries must contain at most ${MAX_ENTRIES} entries`)
  }

  // Check the declared total before decoding base64. A forged size must not be
  // able to force a large allocation merely to discover the capacity error.
  let declaredTotal = 0
  for (const [index, entry] of result.manifest.entries.entries()) {
    if (!isPlainObject(entry)) fail('CLOUD_ARTIFACT_MANIFEST', `entries[${index}] must be an object`)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      fail('CLOUD_ARTIFACT_SIZE', `entries[${index}].size must be a non-negative safe integer`)
    }
    declaredTotal += entry.size
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_CLOUD_ARTIFACT_BYTES) {
      fail('CLOUD_ARTIFACT_TOTAL_BYTES', `Decoded artifacts exceed the ${MAX_CLOUD_ARTIFACT_BYTES}-byte total limit`)
    }
    if (entry.encoding !== 'base64') fail('CLOUD_ARTIFACT_ENCODING', `entries[${index}].encoding must be base64`)
    if (typeof entry.content !== 'string') fail('CLOUD_ARTIFACT_CONTENT', `entries[${index}].content must be inline base64`)
  }

  let manifest
  try {
    manifest = verifyArtifactManifest(result)
  } catch (error) {
    const code = typeof error?.code === 'string'
      ? error.code.replace(/^CLOUD_WORKER_ARTIFACT_/, 'CLOUD_ARTIFACT_')
      : 'CLOUD_ARTIFACT_MANIFEST'
    fail(code, error?.message ?? 'The cloud artifact manifest is invalid', { cause: error })
  }

  const at = result.finalizedAt === undefined
    ? clockAt(now)
    : isoAt(requireString(result.finalizedAt, 'result.finalizedAt', 64), 'result.finalizedAt')
  return { artifactId, manifest, at }
}

async function workspaceRoot(workspace) {
  if (typeof workspace !== 'string' || !workspace || !path.isAbsolute(workspace) || workspace.includes('\0')) {
    fail('CLOUD_ARTIFACT_WORKSPACE', 'workspace must be an existing absolute directory path')
  }
  const absolute = path.resolve(workspace)
  const original = await lstatOrNull(absolute)
  if (!original) fail('CLOUD_ARTIFACT_WORKSPACE', 'workspace must exist')
  if (original.isSymbolicLink()) fail('CLOUD_ARTIFACT_SYMLINK', 'workspace may not be a symbolic link')
  if (!original.isDirectory()) fail('CLOUD_ARTIFACT_WORKSPACE', 'workspace must be a directory')
  let real
  try {
    real = await fsp.realpath(absolute)
  } catch (error) {
    fail('CLOUD_ARTIFACT_WORKSPACE', 'workspace cannot be resolved', { path: absolute, cause: error })
  }
  const stat = await lstatOrNull(real)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    fail('CLOUD_ARTIFACT_WORKSPACE', 'workspace must resolve to a real directory')
  }
  return real
}

function targetsFor(root, entries) {
  const targets = entries.map(entry => {
    const target = path.resolve(root, ...entry.path.split('/'))
    if (!contained(root, target) || target === root) {
      fail('CLOUD_ARTIFACT_PATH_ESCAPE', 'Artifact path escapes its run directory', { path: entry.path })
    }
    return { entry, bytes: entry.bytes, target, parent: path.dirname(target) }
  })

  // Catch case-folded collisions on Windows and file-vs-directory conflicts
  // before creating any artifact files.
  const byIdentity = new Map()
  for (const item of targets) {
    const identity = pathIdentity(item.target)
    if (byIdentity.has(identity)) fail('CLOUD_ARTIFACT_PATH_CONFLICT', 'Artifact paths resolve to the same destination')
    byIdentity.set(identity, item)
  }
  for (const item of targets) {
    let parent = path.dirname(item.target)
    while (contained(root, parent) && parent !== root) {
      if (byIdentity.has(pathIdentity(parent))) {
        fail('CLOUD_ARTIFACT_PATH_CONFLICT', 'An artifact file may not also be an artifact directory')
      }
      parent = path.dirname(parent)
    }
  }
  return targets
}

async function readRegularFile(file, expectedSize, expectedDigest) {
  const before = await lstatOrNull(file)
  if (!before) return null
  if (before.isSymbolicLink()) fail('CLOUD_ARTIFACT_SYMLINK', 'Artifact files may not be symbolic links', { path: file })
  if (!before.isFile()) fail('CLOUD_ARTIFACT_NOT_FILE', 'Artifact destination is not a regular file', { path: file })

  let handle
  try {
    handle = await fsp.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    fail('CLOUD_ARTIFACT_IO', 'Cannot open an existing artifact', { path: file, cause: error })
  }
  let result
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) fail('CLOUD_ARTIFACT_NOT_FILE', 'Artifact destination is not a regular file', { path: file })
    if (stat.size !== expectedSize) fail('CLOUD_ARTIFACT_CONFLICT', 'An existing artifact has different content', { path: file })
    const bytes = await handle.readFile()
    if (bytes.length !== expectedSize) fail('CLOUD_ARTIFACT_CONFLICT', 'An existing artifact has different content', { path: file })
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== expectedDigest) fail('CLOUD_ARTIFACT_CONFLICT', 'An existing artifact has different content', { path: file })
    result = { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: digest }
  } finally {
    await handle.close()
  }
  const after = await lstatOrNull(file)
  if (!after?.isFile() || after.isSymbolicLink() || after.dev !== result.dev || after.ino !== result.ino) {
    fail('CLOUD_ARTIFACT_IO', 'An existing artifact changed while it was being verified', { path: file })
  }
  return result
}

async function inspectTarget(item, root, expectedDigest) {
  await checkedDirectory(item.parent, root)
  return readRegularFile(item.target, item.entry.size, expectedDigest)
}

async function stageFile(item, root) {
  await checkedDirectory(item.parent, root)
  const temporary = path.join(item.parent, `.cloud-artifact-${process.pid}-${randomUUID()}.tmp`)
  let handle
  let created = false
  let ready = false
  try {
    handle = await fsp.open(temporary, 'wx', 0o600)
    created = true
    await handle.writeFile(item.bytes)
    await handle.sync()
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size !== item.entry.size) {
      fail('CLOUD_ARTIFACT_IO', 'The staged artifact is incomplete', { path: temporary })
    }
    await handle.close()
    handle = undefined

    const staged = await lstatOrNull(temporary)
    if (!staged?.isFile() || staged.isSymbolicLink() || staged.size !== item.entry.size) {
      fail('CLOUD_ARTIFACT_IO', 'The staged artifact is not a regular file', { path: temporary })
    }
    // Re-check after writing as well as before publishing. If a local process
    // swapped a parent for a link, cleanup below removes the staged file from
    // the resolved directory rather than leaving an escaped write behind.
    await checkedDirectory(item.parent, root)
    ready = true
    return { temporary, dev: staged.dev, ino: staged.ino }
  } catch (error) {
    if (error instanceof CloudArtifactError) throw error
    fail('CLOUD_ARTIFACT_IO', 'Cannot stage an artifact', { path: temporary, cause: error })
  } finally {
    await handle?.close()
    if (created && !ready) await fsp.unlink(temporary).catch(() => {})
  }
}

async function publishFile(item, root, staged) {
  const { temporary } = staged
  try {
    try {
      await fsp.link(temporary, item.target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await inspectTarget(item, root, item.entry.sha256)
      if (existing) return false
      // The conflicting path disappeared between link() and inspection; retry
      // the exclusive publication rather than replacing anything.
      await fsp.link(temporary, item.target)
    }

    const published = await lstatOrNull(item.target)
    if (!published?.isFile() || published.isSymbolicLink()
      || published.dev !== staged.dev || published.ino !== staged.ino) {
      if (published && !published.isSymbolicLink() && published.dev === staged.dev && published.ino === staged.ino) {
        await fsp.unlink(item.target).catch(() => {})
      }
      fail('CLOUD_ARTIFACT_IO', 'The published artifact changed during commit', { path: item.target })
    }
    try {
      await checkedDirectory(item.parent, root)
    } catch (error) {
      await fsp.unlink(item.target).catch(() => {})
      throw error
    }
    return true
  } catch (error) {
    if (error instanceof CloudArtifactError) throw error
    fail('CLOUD_ARTIFACT_IO', 'Cannot atomically publish an artifact', { path: item.target, cause: error })
  } finally {
    await fsp.unlink(temporary).catch(() => {})
  }
}

async function rollback(created) {
  for (const item of [...created].reverse()) {
    const stat = await lstatOrNull(item.target)
    if (stat?.isFile() && !stat.isSymbolicLink() && stat.dev === item.dev && stat.ino === item.ino) {
      await fsp.unlink(item.target).catch(() => {})
    }
  }
}

/**
 * Validate and atomically land a cloud Worker finalize result.
 *
 * Entry paths are relative POSIX paths beneath
 * `<real workspace>/cloud-artifacts/<runId>/`. Returned artifact paths are
 * absolute. `at` preserves `finalizedAt`; when it is absent, `now()` supplies
 * the fallback timestamp. Reusing an existing file requires the same size and
 * SHA-256 digest. A different existing file is never overwritten.
 *
 * @param {{ result: object, workspace: string, runId: string, now?: () => number|string|Date }} input
 * @returns {Promise<{ artifactId: string, workspace: string, artifacts: Array<{kind: string, path: string, bytes: number, sha256: string, at: string}>, totalBytes: number }>}
 */
export async function finalizeCloudArtifacts({ result, workspace, runId, now } = {}) {
  if (typeof runId !== 'string' || runId.length > 128 || !RUN_ID.test(runId)) {
    fail('CLOUD_ARTIFACT_INVALID_INPUT', 'runId must be a filesystem-safe identifier')
  }
  if (now !== undefined && typeof now !== 'function') {
    fail('CLOUD_ARTIFACT_INVALID_INPUT', 'now must be a function')
  }
  const realWorkspace = await workspaceRoot(workspace)
  const { artifactId, manifest, at } = validateFinalizeResult(result, now)
  const entries = manifest.entries.map(entry => ({
    ...entry,
    bytes: Buffer.from(entry.content, 'base64'),
  }))
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0)
  if (totalBytes > MAX_CLOUD_ARTIFACT_BYTES) {
    fail('CLOUD_ARTIFACT_TOTAL_BYTES', `Decoded artifacts exceed the ${MAX_CLOUD_ARTIFACT_BYTES}-byte total limit`)
  }
  if (entries.length === 0) return { artifactId, workspace: realWorkspace, artifacts: [], totalBytes: 0 }

  const root = path.join(realWorkspace, 'cloud-artifacts', runId)
  const targets = targetsFor(root, entries)
  await ensureDirectories(realWorkspace, ['cloud-artifacts', runId], realWorkspace)

  // Preflight every destination before staging the first file. Invalid later
  // entries and known conflicts therefore cannot leave a partial batch.
  for (const item of targets) {
    const relativeParent = path.relative(root, item.parent)
    const parts = relativeParent === '' ? [] : relativeParent.split(path.sep)
    await ensureDirectories(root, parts, root)
    await inspectTarget(item, root, item.entry.sha256)
  }

  const created = []
  try {
    for (const item of targets) {
      const staged = await stageFile(item, root)
      const published = await publishFile(item, root, staged)
      if (published) created.push({ target: item.target, dev: staged.dev, ino: staged.ino })
    }
  } catch (error) {
    await rollback(created)
    throw error
  }

  return {
    artifactId,
    workspace: realWorkspace,
    artifacts: targets.map(item => ({
      kind: artifactKind(item.entry.path),
      path: item.target,
      bytes: item.entry.size,
      sha256: item.entry.sha256,
      at,
    })),
    totalBytes,
  }
}
