/**
 * Inert local Skill importer.
 *
 * A Skill is a directory with a root SKILL.md. Only documentation and inert
 * asset/template files are accepted. The complete source is scanned before any
 * destination write; symlinks, traversal, oversized files and executable file
 * types are refused. Import never evaluates Markdown, invokes a tool, runs a
 * command, installs a dependency, or executes Skill code.
 *
 * @module dsh-superagent/skill-import
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_MAX_SKILL_BYTES = 1024 * 1024
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024
export const DEFAULT_MAX_SKILL_MD_BYTES = 64 * 1024
export const DEFAULT_MAX_FILES = 100
export const DEFAULT_MAX_DEPTH = 8
export const HARD_MAX_SKILL_BYTES = 16 * 1024 * 1024
export const HARD_MAX_FILE_BYTES = 1024 * 1024
export const HARD_MAX_SKILL_MD_BYTES = 128 * 1024
export const HARD_MAX_FILES = 1000
export const HARD_MAX_DEPTH = 32

export const SKILL_FILE_ALLOWLIST = Object.freeze({
  root: Object.freeze(['SKILL.md', 'README.md', 'LICENSE', 'NOTICE']),
  references: Object.freeze(['.md', '.txt']),
  assets: Object.freeze(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']),
  templates: Object.freeze(['.md', '.txt', '.json', '.yaml', '.yml']),
})

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export class SkillImportError extends Error {
  constructor(code, message, status = 400, details = {}, options) {
    super(message, options)
    this.name = 'SkillImportError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function fail(code, message, status = 400, details = {}, options) {
  throw new SkillImportError(code, message, status, details, options)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function integerOption(value, fallback, maximum, label) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    fail('INVALID_LIMIT', `${label} must be an integer between 1 and ${maximum}`)
  }
  return result
}

function validateSkillName(value) {
  if (typeof value !== 'string' || value.length > 64 || !SKILL_NAME.test(value)) {
    fail('INVALID_SKILL_NAME', 'Skill name must be 1-64 lowercase letters, digits, or single hyphens')
  }
  return value
}

/**
 * Validate one archive/manifest-relative path without touching the filesystem.
 * Both POSIX and Windows absolute/traversal forms are rejected.
 */
export function assertSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || CONTROL.test(value)) {
    fail('PATH_TRAVERSAL', 'Skill path is empty, too long, or contains control characters')
  }
  if (value.includes('\\') || value.includes(':') || value.includes('%') || value.startsWith('/')
      || /^[A-Za-z]/.test(value) && /^[A-Za-z]:/.test(value)) {
    fail('PATH_TRAVERSAL', `Skill path is not a portable relative path: ${value}`)
  }
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..'
      || segment.endsWith(' ') || segment.endsWith('.') || WINDOWS_DEVICE.test(segment))
      || path.posix.normalize(value) !== value) {
    fail('PATH_TRAVERSAL', `Skill path contains traversal or an unsafe segment: ${value}`)
  }
  return value
}

/** Backwards-friendly explicit name for callers that validate archive entries. */
export const validateSkillRelativePath = assertSafeRelativePath

function inside(root, candidate) {
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

async function assertNoSymlinkDirectory(directory, { create = true } = {}) {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  let cursor = parsed.root
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const part of parts) {
    cursor = path.join(cursor, part)
    let stat = await lstatOrNull(cursor)
    if (!stat && create) {
      try {
        await fsp.mkdir(cursor, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      stat = await lstatOrNull(cursor)
    }
    if (!stat) return null
    if (stat.isSymbolicLink()) fail('SYMLINK_FORBIDDEN', 'Skill destination and every existing ancestor must not be symbolic links', 403, { path: cursor })
    if (!stat.isDirectory()) fail('NOT_A_DIRECTORY', 'Skill destination ancestor is not a directory', 400, { path: cursor })
  }
  const stat = await lstatOrNull(resolved)
  if (stat?.isSymbolicLink()) fail('SYMLINK_FORBIDDEN', 'Skill destination must not be a symbolic link', 403)
  if (stat && !stat.isDirectory()) fail('NOT_A_DIRECTORY', 'Skill destination must be a directory')
  return resolved
}

function scalarValue(raw, field, lineNumber) {
  let value = raw.trim()
  if (!value) return ''
  let quote = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      value = value.slice(0, index).trimEnd()
      break
    }
  }
  if (quote) fail('INVALID_FRONTMATTER', `unterminated quote for ${field} on line ${lineNumber}`)
  value = value.trim()
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) fail('INVALID_FRONTMATTER', `invalid single-quoted ${field}`)
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'string') throw new Error('not a string')
      return parsed
    } catch (error) {
      fail('INVALID_FRONTMATTER', `invalid double-quoted ${field}`, 400, {}, { cause: error })
    }
  }
  if (/^[&*!]/.test(value) || value === '>' || value === '|' || /^[>|][+-]?$/.test(value)
      || value.startsWith('[') || value.startsWith('{')) {
    fail('INVALID_FRONTMATTER', `${field} must be a plain or quoted scalar`)
  }
  return value
}

function splitInlineList(value) {
  const text = value.trim()
  if (!text.startsWith('[') || !text.endsWith(']')) {
    return text.split(',').map(part => scalarValue(part, 'allowed-tools', 1)).filter(Boolean)
  }
  const inner = text.slice(1, -1).trim()
  if (!inner) return []
  const values = []
  let start = 0
  let quote = null
  let escaped = false
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
    } else if (char === '"' || char === "'") quote = char
    else if (char === ',') {
      values.push(scalarValue(inner.slice(start, index), 'allowed-tools', 1))
      start = index + 1
    }
  }
  if (quote) fail('INVALID_FRONTMATTER', 'unterminated quote in allowed-tools')
  values.push(scalarValue(inner.slice(start), 'allowed-tools', 1))
  return values
}

/** Parse the deliberately small, data-only YAML frontmatter subset used by Skills. */
export function parseSkillFrontmatter(markdown) {
  if (typeof markdown !== 'string') fail('INVALID_FRONTMATTER', 'SKILL.md must contain UTF-8 text')
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (text.includes('\r') || CONTROL.test(text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n')))) {
    fail('INVALID_FRONTMATTER', 'SKILL.md contains unsupported control characters')
  }
  const lines = text.split('\n')
  if (lines[0] !== '---') fail('MISSING_FRONTMATTER', 'SKILL.md must start with YAML frontmatter delimited by ---')
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      end = index
      break
    }
  }
  if (end === -1) fail('INVALID_FRONTMATTER', 'SKILL.md frontmatter has no closing --- delimiter')
  const fields = new Map()
  const allowedTools = []
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) fail('INVALID_FRONTMATTER', `nested YAML is not supported on line ${index + 1}`)
    const match = /^([a-z][a-z0-9-]*):(?:\s+(.*))?$/.exec(line)
    if (!match) fail('INVALID_FRONTMATTER', `invalid frontmatter entry on line ${index + 1}`)
    const key = match[1]
    if (fields.has(key)) fail('INVALID_FRONTMATTER', `duplicate frontmatter key: ${key}`)
    let raw = match[2] ?? ''
    if (key === 'allowed-tools' && raw.trim().startsWith('[')) {
      const tools = splitInlineList(raw.trim())
      fields.set(key, raw.trim())
      allowedTools.push(...tools)
      continue
    }
    if (/^[>|][+-]?$/.test(raw.trim())) {
      const block = []
      let cursor = index + 1
      while (cursor < end && (!lines[cursor].trim() || /^\s/.test(lines[cursor]))) {
        block.push(lines[cursor].trim())
        cursor += 1
      }
      raw = block.join(' ').trim()
      index = cursor - 1
    }
    const value = scalarValue(raw, key, index + 1)
    fields.set(key, value)
    if (key === 'allowed-tools') allowedTools.push(...splitInlineList(value))
  }
  if (!fields.has('name')) fail('MISSING_FRONTMATTER', 'SKILL.md frontmatter requires name')
  if (!fields.has('description')) fail('MISSING_FRONTMATTER', 'SKILL.md frontmatter requires description')
  const name = validateSkillName(fields.get('name'))
  const description = fields.get('description').replace(/\s+/g, ' ').trim()
  if (!description || description.length > 1000 || CONTROL.test(description)) {
    fail('INVALID_FRONTMATTER', 'description must be 1-1000 characters without control characters')
  }
  if (allowedTools.length > 32 || allowedTools.some(tool => !tool || tool.length > 80 || CONTROL.test(tool))) {
    fail('INVALID_FRONTMATTER', 'allowed-tools must contain at most 32 short, non-empty names')
  }
  return {
    name,
    description,
    declaredTools: Object.freeze([...new Set(allowedTools)]),
    metadata: Object.freeze(Object.fromEntries(fields)),
  }
}

function allowedFile(relative) {
  assertSafeRelativePath(relative)
  const parts = relative.split('/')
  if (parts.length === 1) return SKILL_FILE_ALLOWLIST.root.includes(parts[0])
  const directory = parts[0]
  const extensions = SKILL_FILE_ALLOWLIST[directory]
  if (!extensions) return false
  return extensions.includes(path.posix.extname(relative).toLowerCase())
}

function decodeMarkdown(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    fail('INVALID_UTF8', 'SKILL.md must be valid UTF-8', 400, {}, { cause: error })
  }
}

async function readRegularFileNoFollow(file, stat, maxFileBytes) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await fsp.open(file, flags)
  } catch (error) {
    if (error?.code === 'ELOOP') fail('SYMLINK_FORBIDDEN', 'Skill source file changed into a symbolic link', 403)
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size > maxFileBytes) {
      fail('SOURCE_CHANGED', 'Skill source file changed type, identity, or exceeded its file limit during scanning')
    }
    const buffer = Buffer.alloc(maxFileBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxFileBytes) fail('FILE_TOO_LARGE', `Skill file exceeds ${maxFileBytes} bytes`, 413)
    const after = await handle.stat()
    if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail('SOURCE_CHANGED', 'Skill source file changed while it was being read')
    }
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

async function scanSource(sourceDirectory, options) {
  if (typeof sourceDirectory !== 'string' || !sourceDirectory.trim()) fail('INVALID_SOURCE', 'sourceDirectory must be a non-empty local path')
  const sourcePath = path.resolve(sourceDirectory)
  const sourceStat = await lstatOrNull(sourcePath)
  if (!sourceStat) fail('SOURCE_NOT_FOUND', 'local Skill source directory does not exist', 404, { path: sourcePath })
  if (sourceStat.isSymbolicLink()) fail('SYMLINK_FORBIDDEN', 'local Skill source root must not be a symbolic link', 403)
  if (!sourceStat.isDirectory()) fail('NOT_A_DIRECTORY', 'local Skill source must be a directory')
  let root
  try {
    root = await fsp.realpath(sourcePath)
  } catch (error) {
    fail('SOURCE_NOT_FOUND', 'local Skill source directory could not be resolved', 404, {}, { cause: error })
  }
  const files = []
  const byPath = new Map()
  let totalBytes = 0
  let skillMarkdown = null

  const walk = async (directory, depth) => {
    if (depth > options.maxDepth) fail('DEPTH_LIMIT', `Skill directory nesting exceeds ${options.maxDepth}`, 413)
    const realDirectory = await fsp.realpath(directory)
    if (!inside(root, realDirectory)) fail('PATH_TRAVERSAL', 'Skill source directory escaped its root', 403)
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const relative = path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/')
      assertSafeRelativePath(relative)
      const full = path.join(root, ...relative.split('/'))
      const stat = await fsp.lstat(full)
      if (stat.isSymbolicLink()) fail('SYMLINK_FORBIDDEN', `Skill source contains a symbolic link: ${relative}`, 403, { path: relative })
      if (stat.isDirectory()) {
        const top = relative.split('/')[0]
        if (depth === 0 && !own(SKILL_FILE_ALLOWLIST, top)) {
          fail('DIRECTORY_NOT_ALLOWED', `Skill directory is not allowlisted: ${relative}`, 400, { path: relative })
        }
        await walk(full, depth + 1)
        continue
      }
      if (!stat.isFile()) fail('FILE_TYPE_FORBIDDEN', `Skill source contains a non-regular file: ${relative}`, 400, { path: relative })
      if (relative === '.DS_Store') continue
      if (!allowedFile(relative)) fail('FILE_NOT_ALLOWED', `Skill file is not allowlisted: ${relative}`, 400, { path: relative })
      if (relative.split('/').length > options.maxDepth) fail('DEPTH_LIMIT', `Skill path nesting exceeds ${options.maxDepth}`, 413)
      if (files.length >= options.maxFiles) fail('TOO_MANY_FILES', `Skill contains more than ${options.maxFiles} files`, 413)
      if (stat.size > options.maxFileBytes) fail('FILE_TOO_LARGE', `Skill file ${relative} exceeds ${options.maxFileBytes} bytes`, 413, { path: relative })
      if (totalBytes + stat.size > options.maxSkillBytes) fail('SKILL_TOO_LARGE', `Skill exceeds ${options.maxSkillBytes} total bytes`, 413)
      const realFile = await fsp.realpath(full)
      if (!inside(root, realFile)) fail('PATH_TRAVERSAL', `Skill file escaped its root: ${relative}`, 403)
      const bytes = await readRegularFileNoFollow(full, stat, options.maxFileBytes)
      const after = await fsp.lstat(full)
      if (after.isSymbolicLink() || !after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino) {
        fail('SOURCE_CHANGED', `Skill source changed after scanning: ${relative}`)
      }
      totalBytes += bytes.length
      if (totalBytes > options.maxSkillBytes) fail('SKILL_TOO_LARGE', `Skill exceeds ${options.maxSkillBytes} total bytes`, 413)
      const record = {
        path: relative,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      files.push(record)
      byPath.set(relative, bytes)
      if (relative === 'SKILL.md') {
        if (bytes.length > options.maxSkillMdBytes) fail('FILE_TOO_LARGE', `SKILL.md exceeds ${options.maxSkillMdBytes} bytes`, 413)
        skillMarkdown = decodeMarkdown(bytes)
      }
    }
  }

  await walk(root, 0)
  if (!skillMarkdown) fail('MISSING_SKILL_MD', 'local Skill requires a root-level SKILL.md', 400)
  const frontmatter = parseSkillFrontmatter(skillMarkdown)
  return { root, frontmatter, files: Object.freeze(files), byPath, totalBytes }
}

function importOptions(options) {
  if (!isRecord(options)) fail('INVALID_OPTIONS', 'Skill import options must be an object')
  if (own(options, 'enabled') && typeof options.enabled !== 'boolean') fail('INVALID_OPTIONS', 'enabled must be a boolean')
  return {
    maxSkillBytes: integerOption(options.maxSkillBytes, DEFAULT_MAX_SKILL_BYTES, HARD_MAX_SKILL_BYTES, 'maxSkillBytes'),
    maxFileBytes: integerOption(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES, 'maxFileBytes'),
    maxSkillMdBytes: integerOption(options.maxSkillMdBytes, DEFAULT_MAX_SKILL_MD_BYTES, HARD_MAX_SKILL_MD_BYTES, 'maxSkillMdBytes'),
    maxFiles: integerOption(options.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES, 'maxFiles'),
    maxDepth: integerOption(options.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH, 'maxDepth'),
  }
}

/** Inspect and validate a local Skill without writing or executing anything. */
export async function inspectLocalSkill(sourceDirectory, options = {}) {
  const scanned = await scanSource(sourceDirectory, importOptions(options))
  return Object.freeze({
    name: scanned.frontmatter.name,
    description: scanned.frontmatter.description,
    declaredTools: scanned.frontmatter.declaredTools,
    files: scanned.files,
    totalBytes: scanned.totalBytes,
    permissionsPreview: previewPermissions(scanned.frontmatter, scanned.files),
    execution: 'never-automatic',
  })
}

export function previewPermissions(frontmatter, files = []) {
  const declared = Array.isArray(frontmatter?.declaredTools) ? frontmatter.declaredTools : []
  const requested = declared.filter((tool, index) => typeof tool === 'string' && tool.length <= 80 && !CONTROL.test(tool)).slice(0, 32)
  const read = files.map(file => typeof file === 'string' ? file : file?.path)
    .filter(file => typeof file === 'string').map(assertSafeRelativePath)
  return Object.freeze({
    requested: Object.freeze([...new Set(requested)]),
    effective: Object.freeze([]),
    filesystem: Object.freeze({ read: Object.freeze(read), write: Object.freeze([]) }),
    network: 'not-granted',
    commands: Object.freeze([]),
    execution: 'never-automatic',
    requiresReview: true,
  })
}

async function ensureChildDirectory(parent, relativeDirectory) {
  let cursor = parent
  for (const segment of relativeDirectory.split('/').filter(Boolean)) {
    assertSafeRelativePath(segment)
    cursor = path.join(cursor, segment)
    let stat = await lstatOrNull(cursor)
    if (!stat) {
      try {
        await fsp.mkdir(cursor, { mode: 0o700 })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      stat = await lstatOrNull(cursor)
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('DESTINATION_CHANGED', 'Skill destination contains a symbolic link or non-directory', 403)
    }
  }
}

function manifestRecord(scanned, target, enabled, now) {
  return {
    schemaVersion: 1,
    kind: 'skill',
    origin: 'local',
    remote: false,
    name: scanned.frontmatter.name,
    description: scanned.frontmatter.description,
    directory: target,
    sourceDirectory: scanned.root,
    importedAt: now,
    enabled,
    status: enabled ? 'imported' : 'imported-disabled',
    disabledReason: enabled ? null : 'disabled-by-user',
    declaredTools: [...scanned.frontmatter.declaredTools],
    files: scanned.files.map(file => ({ ...file })),
    totalBytes: scanned.totalBytes,
    permissionsPreview: previewPermissions(scanned.frontmatter, scanned.files),
    execution: 'never-automatic',
  }
}

/**
 * Import a local Skill directory into skillsDir/name. Existing imports are
 * never overwritten. The default is enabled locally but remains completely
 * inert; remote market Skills are disabled by default by market-client.js.
 */
export async function importLocalSkill(sourceDirectory, options = {}) {
  const limits = importOptions(options)
  if (typeof options.skillsDir !== 'string' || !options.skillsDir.trim()) fail('INVALID_DESTINATION', 'skillsDir must be a non-empty local directory')
  const scanned = await scanSource(sourceDirectory, limits)
  const requestedSkillsRoot = path.resolve(options.skillsDir)
  if (inside(scanned.root, requestedSkillsRoot)) fail('OVERLAPPING_PATHS', 'skillsDir must not be inside the Skill source directory')
  const skillsRoot = await assertNoSymlinkDirectory(requestedSkillsRoot, { create: true })
  if (inside(scanned.root, skillsRoot)) fail('OVERLAPPING_PATHS', 'skillsDir must not be inside the Skill source directory')
  const target = path.join(skillsRoot, scanned.frontmatter.name)
  assertSafeRelativePath(scanned.frontmatter.name)
  const existing = await lstatOrNull(target)
  if (existing) fail('SKILL_ALREADY_EXISTS', `Skill ${scanned.frontmatter.name} is already imported; imports never overwrite`, 409, { name: scanned.frontmatter.name })
  const enabled = options.enabled ?? true
  const now = options.now instanceof Date ? options.now.toISOString() : new Date().toISOString()
  let created = false
  try {
    try {
      await fsp.mkdir(target, { mode: 0o700 })
    } catch (error) {
      if (error?.code === 'EEXIST') {
        fail('SKILL_ALREADY_EXISTS', `Skill ${scanned.frontmatter.name} is already imported; imports never overwrite`, 409, { name: scanned.frontmatter.name })
      }
      throw error
    }
    created = true
    for (const file of scanned.files) {
      const directory = path.posix.dirname(file.path)
      if (directory !== '.') await ensureChildDirectory(target, directory)
      const destination = path.join(target, ...file.path.split('/'))
      await fsp.writeFile(destination, scanned.byPath.get(file.path), { flag: 'wx', mode: 0o600 })
    }
    const record = manifestRecord(scanned, target, enabled, now)
    await fsp.writeFile(path.join(target, 'skill.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return record
  } catch (error) {
    if (created) await fsp.rm(target, { recursive: true, force: true })
    throw error
  }
}

export const importSkillDirectory = importLocalSkill
export const importSkillFromDirectory = importLocalSkill

function validateManifest(record, expectedName) {
  if (!isRecord(record) || record.schemaVersion !== 1 || record.kind !== 'skill' || record.origin !== 'local'
      || record.remote !== false || record.name !== expectedName || typeof record.enabled !== 'boolean'
      || record.execution !== 'never-automatic' || !Array.isArray(record.files)) {
    fail('CORRUPT_MANIFEST', `local Skill manifest is invalid: ${expectedName}`, 400)
  }
  validateSkillName(record.name)
  const seen = new Set()
  for (const file of record.files) {
    if (!isRecord(file)) fail('CORRUPT_MANIFEST', 'manifest file entry must be an object')
    assertSafeRelativePath(file.path)
    if (seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail('CORRUPT_MANIFEST', 'manifest file entry has an invalid path, size, duplicate, or digest')
    }
    seen.add(file.path)
  }
  return record
}

async function readManifestNoFollow(file, stat) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  let handle
  try {
    handle = await fsp.open(file, flags)
  } catch (error) {
    if (error?.code === 'ELOOP') fail('SYMLINK_FORBIDDEN', 'imported Skill manifest must not be a symbolic link', 403)
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size || before.size > 2 * 1024 * 1024) {
      fail('CORRUPT_MANIFEST', 'imported Skill manifest changed or exceeded its size limit')
    }
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > 2 * 1024 * 1024) fail('CORRUPT_MANIFEST', 'imported Skill manifest exceeded its size limit')
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail('CORRUPT_MANIFEST', 'imported Skill manifest changed while it was being read')
    }
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

async function readManifest(skillsRoot, name) {
  validateSkillName(name)
  const root = await assertNoSymlinkDirectory(skillsRoot, { create: false })
  if (!root) fail('SKILL_NOT_FOUND', `Skill ${name} is not imported`, 404, { name })
  const target = path.join(root, name)
  const stat = await lstatOrNull(target)
  if (!stat) fail('SKILL_NOT_FOUND', `Skill ${name} is not imported`, 404, { name })
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('SYMLINK_FORBIDDEN', 'imported Skill directory must not be a symbolic link', 403)
  const manifest = path.join(target, 'skill.json')
  const manifestStat = await lstatOrNull(manifest)
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) fail('CORRUPT_MANIFEST', 'imported Skill manifest is missing or unsafe')
  if (manifestStat.size > 2 * 1024 * 1024) fail('CORRUPT_MANIFEST', 'imported Skill manifest is too large')
  let record
  try {
    record = JSON.parse(decodeMarkdown(await readManifestNoFollow(manifest, manifestStat)))
  } catch (error) {
    if (error instanceof SkillImportError) throw error
    fail('CORRUPT_MANIFEST', 'imported Skill manifest is not valid JSON', 400, {}, { cause: error })
  }
  return validateManifest(record, name)
}

export class SkillImporter {
  constructor({ skillsDir, ...defaults } = {}) {
    if (typeof skillsDir !== 'string' || !skillsDir.trim()) fail('INVALID_DESTINATION', 'skillsDir is required')
    this.skillsDir = path.resolve(skillsDir)
    this.defaults = importOptions(defaults)
    if (own(defaults, 'enabled') && typeof defaults.enabled !== 'boolean') fail('INVALID_OPTIONS', 'enabled must be a boolean')
    this.defaults.enabled = defaults.enabled ?? true
  }

  import(sourceDirectory, options = {}) {
    return importLocalSkill(sourceDirectory, { ...this.defaults, ...options, skillsDir: this.skillsDir })
  }

  async list() {
    const root = await assertNoSymlinkDirectory(this.skillsDir, { create: false })
    if (!root) return Object.freeze([])
    const entries = await fsp.readdir(root, { withFileTypes: true })
    const names = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort()
    const records = []
    for (const name of names) records.push(await readManifest(root, name))
    return Object.freeze(records)
  }

  async get(name) {
    return readManifest(this.skillsDir, name)
  }

  async preview(name) {
    const record = await readManifest(this.skillsDir, name)
    return previewPermissions(record, record.files)
  }

  async setEnabled(name, enabled) {
    if (typeof enabled !== 'boolean') fail('INVALID_OPTIONS', 'enabled must be a boolean')
    const record = await readManifest(this.skillsDir, name)
    record.enabled = enabled
    record.status = enabled ? 'imported' : 'imported-disabled'
    record.disabledReason = enabled ? null : 'disabled-by-user'
    const target = path.join(path.resolve(this.skillsDir), name)
    const temporary = path.join(target, `.skill.json.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
    const manifest = path.join(target, 'skill.json')
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      const before = await lstatOrNull(target)
      if (!before || before.isSymbolicLink() || !before.isDirectory()) fail('DESTINATION_CHANGED', 'imported Skill directory changed during update', 403)
      await fsp.rename(temporary, manifest)
    } finally {
      await fsp.rm(temporary, { force: true })
    }
    return record
  }
}

export function createSkillImporter(options) {
  return new SkillImporter(options)
}
