/**
 * Host lifecycle adapter for reviewed local Skill imports.
 *
 * Imported Skills are documentation-only: this adapter never evaluates their
 * Markdown, follows links into resources, invokes tools, or executes commands.
 * Every load revalidates the imported directory and root SKILL.md on demand.
 *
 * @module dsh-superagent/imported-skills
 */

import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  HARD_MAX_FILE_BYTES,
  HARD_MAX_FILES,
  HARD_MAX_SKILL_BYTES,
  HARD_MAX_SKILL_MD_BYTES,
  SkillImportError,
  assertSafeRelativePath,
  parseSkillFrontmatter,
} from './skill-import.js'

export const IMPORTED_SKILL_PROVIDER = 'dsh-superagent-imported'
export const IMPORTED_SKILL_RANK = 900

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

function fail(code, message, status = 400, details = {}, options) {
  throw new SkillImportError(code, message, status, details, options)
}

function sameLocation(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function lstatOrNull(file) {
  try {
    return await fsp.lstat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function canonicalPath(value) {
  const resolved = path.resolve(value)
  try {
    return await fsp.realpath(resolved)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const parent = path.dirname(resolved)
    if (parent === resolved) return resolved
    return path.join(await canonicalPath(parent), path.basename(resolved))
  }
}

/** Refuse links in every component, including a swapped-in parent directory. */
async function assertDirectoryChain(directory) {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  let cursor = parsed.root
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = await lstatOrNull(cursor)
    if (!stat) fail('SKILL_NOT_FOUND', 'Imported Skill directory does not exist', 404)
    if (stat.isSymbolicLink()) fail('SYMLINK_FORBIDDEN', 'Imported Skill directory and its ancestors must not be symbolic links', 403)
    if (!stat.isDirectory()) fail('NOT_A_DIRECTORY', 'Imported Skill directory component is not a directory')
  }
  let real
  try {
    real = await fsp.realpath(resolved)
  } catch (error) {
    fail('SKILL_NOT_FOUND', 'Imported Skill directory could not be resolved', 404, {}, { cause: error })
  }
  if (!sameLocation(real, await canonicalPath(resolved))) fail('PATH_TRAVERSAL', 'Imported Skill directory escaped its declared path', 403)
  return real
}

function validateManifestLimits(record) {
  if (!Array.isArray(record.files) || record.files.length > HARD_MAX_FILES) {
    fail('CORRUPT_MANIFEST', 'Imported Skill manifest exceeds its file-count limit', 413)
  }
  let total = 0
  for (const file of record.files) {
    assertSafeRelativePath(file?.path)
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > HARD_MAX_FILE_BYTES
        || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail('CORRUPT_MANIFEST', 'Imported Skill manifest contains an invalid size or digest', 413)
    }
    total += file.bytes
    if (total > HARD_MAX_SKILL_BYTES) fail('SKILL_TOO_LARGE', 'Imported Skill exceeds its total-byte limit', 413)
  }
  if (record.totalBytes !== undefined && record.totalBytes !== total) {
    fail('CORRUPT_MANIFEST', 'Imported Skill manifest total size is inconsistent')
  }
}

async function readSkillMarkdown(directory, record) {
  const entry = record.files.find(file => file.path === 'SKILL.md')
  if (!entry) fail('MISSING_SKILL_MD', 'Imported Skill manifest has no root SKILL.md')
  if (entry.bytes > HARD_MAX_SKILL_MD_BYTES) fail('FILE_TOO_LARGE', 'SKILL.md exceeds its hard size limit', 413)

  const file = path.join(directory, 'SKILL.md')
  const stat = await lstatOrNull(file)
  if (!stat) fail('MISSING_SKILL_MD', 'Imported Skill SKILL.md is missing', 404)
  if (stat.isSymbolicLink()) fail('SYMLINK_FORBIDDEN', 'Imported Skill SKILL.md must not be a symbolic link', 403)
  if (!stat.isFile()) fail('FILE_TYPE_FORBIDDEN', 'Imported Skill SKILL.md must be a regular file')
  if (stat.size > HARD_MAX_SKILL_MD_BYTES) fail('FILE_TOO_LARGE', 'SKILL.md exceeds its hard size limit', 413)
  if (stat.size !== entry.bytes) fail('SKILL_DIGEST_MISMATCH', 'SKILL.md size does not match the imported manifest', 409)

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await fsp.open(file, flags)
  } catch (error) {
    if (error?.code === 'ELOOP') fail('SYMLINK_FORBIDDEN', 'Imported Skill SKILL.md changed into a symbolic link', 403)
    throw error
  }
  let bytes
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) {
      fail('SOURCE_CHANGED', 'SKILL.md changed identity or type before it could be read', 409)
    }
    const buffer = Buffer.alloc(entry.bytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > entry.bytes) fail('FILE_TOO_LARGE', 'SKILL.md grew beyond its imported size while being read', 413)
    const after = await handle.stat()
    if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail('SOURCE_CHANGED', 'SKILL.md changed while it was being read', 409)
    }
    bytes = buffer.subarray(0, length)
  } finally {
    await handle.close()
  }

  const after = await lstatOrNull(file)
  if (!after || after.isSymbolicLink() || !after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino) {
    fail('SOURCE_CHANGED', 'SKILL.md changed after it was read', 409)
  }
  await assertDirectoryChain(directory)
  const realFile = await fsp.realpath(file)
  if (!sameLocation(path.join(directory, 'SKILL.md'), realFile)) {
    fail('PATH_TRAVERSAL', 'SKILL.md escaped its imported directory', 403)
  }
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    fail('SKILL_DIGEST_MISMATCH', 'SKILL.md digest does not match the imported manifest', 409)
  }
  let markdown
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    fail('INVALID_UTF8', 'SKILL.md must contain valid UTF-8', 400, {}, { cause: error })
  }
  return { file, markdown }
}

function stripFrontmatter(markdown) {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  // parseSkillFrontmatter has already established that both delimiters exist.
  const lines = normalized.split('\n')
  let end = 1
  while (end < lines.length && lines[end] !== '---') end += 1
  return lines.slice(end + 1).join('\n')
}

function candidateFor(record, providerName) {
  return {
    name: record.name,
    description: record.description,
    path: path.join(record.directory, 'SKILL.md'),
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: providerName,
    rank: IMPORTED_SKILL_RANK,
    locator: record.name,
    resourceBase: { kind: 'directory', path: record.directory },
  }
}

function clockFrom(now) {
  if (typeof now === 'function') return now
  if (now instanceof Date) return () => now.toISOString()
  return () => new Date().toISOString()
}

/**
 * Register a synchronous host provider with asynchronous, on-demand loading.
 * The caller owns invalidation after SkillImporter.setEnabled/import changes.
 */
export function createImportedSkillProvider({ skills, importer, name = IMPORTED_SKILL_PROVIDER, now } = {}) {
  if (typeof skills?.registerProvider !== 'function') return { supported: false }
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || CONTROL.test(name)) {
    fail('INVALID_PROVIDER_NAME', 'Imported Skill provider name must be a short, non-empty string')
  }
  const clock = clockFrom(now)
  const stamp = () => clock()
  let control
  let disposed = false
  const state = {
    registeredAt: stamp(),
    disposedAt: null,
    lastListAt: null,
    lastGetAt: null,
    lastInvalidateAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lists: 0,
    gets: 0,
    invalidations: 0,
    errors: 0,
  }

  function assertActive() {
    if (disposed) fail('PROVIDER_DISPOSED', 'Imported Skill provider has been disposed', 409)
  }

  function recordError(error) {
    state.errors += 1
    state.lastErrorAt = stamp()
    state.lastErrorCode = error?.code ?? 'IMPORTED_SKILL_ERROR'
  }

  const provider = Object.freeze({
    name,
    async list() {
      assertActive()
      state.lists += 1
      state.lastListAt = stamp()
      try {
        const records = await importer.list()
        return records.filter(record => record?.enabled === true
          && typeof record.name === 'string' && SKILL_NAME.test(record.name)
          && typeof record.description === 'string' && record.description.length > 0
          && record.description.length <= 1000 && !CONTROL.test(record.description)
          && typeof record.directory === 'string' && path.isAbsolute(record.directory))
          .map(record => candidateFor(record, name))
      } catch (error) {
        recordError(error)
        throw error
      }
    },
    async get(candidate) {
      assertActive()
      state.gets += 1
      state.lastGetAt = stamp()
      try {
        const locator = candidate?.locator
        if (typeof locator !== 'string' || locator.length > 64 || !SKILL_NAME.test(locator)) {
          fail('INVALID_CANDIDATE', 'Imported Skill candidate.locator must be a valid Skill name')
        }
        const record = await importer.get(locator)
        if (record?.enabled !== true) fail('SKILL_DISABLED', `Imported Skill ${locator} is disabled`, 403, { name: locator })
        if (typeof importer.skillsDir !== 'string' || !importer.skillsDir.trim()
            || typeof record.directory !== 'string' || !path.isAbsolute(record.directory)) {
          fail('CORRUPT_MANIFEST', 'Imported Skill manifest has no safe local directory')
        }
        const root = path.resolve(importer.skillsDir)
        const expected = path.join(root, locator)
        const declared = path.resolve(record.directory)
        if (!sameLocation(await canonicalPath(expected), await canonicalPath(declared))) {
          fail('PATH_TRAVERSAL', 'Imported Skill manifest directory escapes its managed root', 403)
        }
        validateManifestLimits(record)
        const directory = await assertDirectoryChain(expected)
        const { file, markdown } = await readSkillMarkdown(directory, record)
        const frontmatter = parseSkillFrontmatter(markdown)
        if (frontmatter.name !== record.name || frontmatter.description !== record.description) {
          fail('CORRUPT_MANIFEST', 'SKILL.md frontmatter does not match the imported manifest', 409)
        }
        return {
          name: record.name,
          description: record.description,
          path: file,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: name,
          resourceBase: { kind: 'directory', path: directory },
          content: stripFrontmatter(markdown),
          metadata: { ...frontmatter.metadata },
        }
      } catch (error) {
        recordError(error)
        throw error
      }
    },
  })

  // Registration and provider delivery are deliberately synchronous.
  const disposer = skills.registerProvider(current => {
    control = current
    return provider
  })

  function invalidate() {
    assertActive()
    state.invalidations += 1
    state.lastInvalidateAt = stamp()
    try {
      return control?.invalidate()
    } catch (error) {
      recordError(error)
      throw error
    }
  }

  function dispose() {
    if (disposed) return undefined
    disposed = true
    state.disposedAt = stamp()
    return typeof disposer === 'function' ? disposer() : undefined
  }

  function status() {
    return Object.freeze({
      supported: true,
      name,
      registered: !disposed,
      disposed,
      registeredAt: state.registeredAt,
      disposedAt: state.disposedAt,
      lastListAt: state.lastListAt,
      lastGetAt: state.lastGetAt,
      lastInvalidateAt: state.lastInvalidateAt,
      lastErrorAt: state.lastErrorAt,
      lastErrorCode: state.lastErrorCode,
      lists: state.lists,
      gets: state.gets,
      invalidations: state.invalidations,
      errors: state.errors,
    })
  }

  return Object.freeze({ supported: true, provider, dispose, invalidate, status })
}
