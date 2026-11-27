/**
 * Read-only aggregation of the files and pages produced by durable runs.
 *
 * This module deliberately knows nothing about sessions, HTTP, or the store.
 * Callers provide the runs and the session-to-workspace projection they have
 * already authorised; the same descriptors can therefore be used by the global
 * console and by a single-run detail view.
 *
 * @module dsh-superagent/artifacts
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { WorkbenchError } from './workbench.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_CURSOR = 4096
const ARTIFACT_ID = /^art_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/
const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|\\\\)/i
const FILE_EXTENSION = /\.([a-z0-9][a-z0-9._-]{0,31})$/i

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function timeValue(value) {
  if (value instanceof Date) value = value.toISOString()
  const raw = stringValue(value)
  if (!raw || !Number.isFinite(Date.parse(raw))) return null
  return new Date(raw).toISOString()
}

function boundary(value, name) {
  const millis = Date.parse(value instanceof Date ? value.toISOString() : stringValue(value))
  if (!Number.isFinite(millis)) {
    throw new WorkbenchError(400, `${name} must be a valid date`, { id: 'invalid-artifact-date' })
  }
  return millis
}

function projectFor(mapping, sessionId) {
  const value = mapping instanceof Map
    ? mapping.get(sessionId)
    : mapping && Object.hasOwn(mapping, sessionId) ? mapping[sessionId] : null
  if (!value) return null
  if (typeof value === 'string') {
    const cwd = value.trim()
    if (!cwd) return null
    return { name: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd, cwd }
  }
  if (typeof value !== 'object') return null
  const cwd = stringValue(value.cwd) || null
  const name = stringValue(value.name) || (cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd : null)
  return name || cwd ? { name: name || cwd, cwd } : null
}

function isWebUrl(value) {
  return /^https?:\/\//i.test(value)
}

/** Resolve a local report link without doing any filesystem IO. */
function localPath(value, base) {
  const raw = value.replace(/\\/g, '/')
  if (WINDOWS_ABSOLUTE.test(value)) return path.win32.normalize(value)
  if (!base) return path.posix.normalize(raw)
  if (WINDOWS_ABSOLUTE.test(base)) return path.win32.resolve(base, value)
  if (path.posix.isAbsolute(base)) return path.posix.resolve(base, raw)
  if (path.posix.isAbsolute(raw)) return path.posix.resolve(raw)
  return path.resolve(base, value)
}

function identityFor(value) {
  const normalized = value.replace(/\\/g, '/')
  // Windows paths are case-insensitive. POSIX paths and URL paths are not.
  return WINDOWS_ABSOLUTE.test(value) || /^[a-z]:\//i.test(normalized)
    ? normalized.toLowerCase()
    : normalized
}

function cleanLinkTarget(raw) {
  let value = raw.trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  // Markdown escapes are common in paths containing spaces or parentheses.
  value = value.replace(/\\([\\`*_[\]{}()#+.!<>-])/g, '$1')
  return value.replace(/[.,;:，。；：]+$/, '')
}

function candidateTarget(raw, base, decodePath = false) {
  let value = cleanLinkTarget(raw)
  if (!value || value.startsWith('#') || value.startsWith('//')) return null
  if (isWebUrl(value)) {
    try {
      const url = new URL(value)
      url.hash = ''
      return { kind: 'url', href: url.href, path: null, identity: url.href }
    } catch {
      return null
    }
  }
  // A drive prefix is a path, not a URL scheme. Every other scheme (including
  // javascript:, data:, and file:) is not a console artifact.
  if (URL_SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null
  if (decodePath) {
    try {
      value = decodeURIComponent(value)
    } catch {
      // A literal percent sign is valid in a local filename.
    }
  }
  const target = localPath(value, base)
  return { kind: 'file', href: target, path: target, identity: identityFor(target) }
}

function reportLinks(report) {
  const text = typeof report === 'string' ? report : ''
  const links = []
  const seen = new Set()
  const push = raw => {
    const target = candidateTarget(raw, null, true)
    if (!target || seen.has(target.identity)) return
    seen.add(target.identity)
    links.push({ href: target.href, label: null })
  }

  // Inline Markdown links and images, including an optional quoted title.
  for (const match of text.matchAll(/!?\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
    const target = candidateTarget(match[2], null, true)
    if (!target || seen.has(target.identity)) continue
    seen.add(target.identity)
    links.push({ href: target.href, label: match[1].trim() || null })
  }
  // Reference-style links use definitions elsewhere in the same report.
  const definitions = new Map()
  for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/gm)) {
    definitions.set(match[1].trim().toLowerCase(), match[2])
  }
  for (const match of text.matchAll(/!?\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const key = (match[2] || match[1]).trim().toLowerCase()
    const target = definitions.get(key)
    if (!target) continue
    const parsed = candidateTarget(target, null, true)
    if (!parsed || seen.has(parsed.identity)) continue
    seen.add(parsed.identity)
    links.push({ href: parsed.href, label: match[1].trim() || null })
  }
  // Reports also contain bare URLs and explicit ./ ../ ~/ or absolute paths.
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>)\]}|]+/gi)) push(match[0])
  const withoutUrls = text.replace(/https?:\/\/[^\s"'`<>)\]}|]+/gi, match => ' '.repeat(match.length))
  for (const match of withoutUrls.matchAll(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)[^\s"'`<>|]+?\.(?:html?|md|pdf|docx?|xlsx?|csv|tsv|json|ya?ml|txt|log|png|jpe?g|gif|webp|svg|zip|pptx?|py|js|mjs|css)\b/gi)) push(match[0])
  return links
}

function baseFor(run, project) {
  return stringValue(run.workspace?.base)
    || stringValue(run.goalMode?.cwd)
    || project?.cwd
    || null
}

function artifactName(value) {
  const cleaned = String(value ?? '').replace(/[\\/]+$/, '')
  return cleaned.split(/[\\/]/).pop() || cleaned
}

function inferredKind(href) {
  if (isWebUrl(href)) return FILE_EXTENSION.exec(new URL(href).pathname)?.[1]?.toLowerCase() || 'link'
  return FILE_EXTENSION.exec(href)?.[1]?.toLowerCase() || 'file'
}

function stableId(runId, identity) {
  const owner = Buffer.from(runId, 'utf8').toString('base64url')
  const digest = createHash('sha256').update(JSON.stringify([runId, identity])).digest('base64url')
  return `art_${owner}.${digest}`
}

/** Parse an id emitted by this module. Invalid ids are not filesystem paths. */
export function parseArtifactId(id) {
  const raw = stringValue(id)
  const match = ARTIFACT_ID.exec(raw)
  if (!match) return null
  let runId
  try {
    runId = Buffer.from(match[1], 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!RUN_ID.test(runId) || Buffer.from(runId, 'utf8').toString('base64url') !== match[1]) return null
  return { runId, digest: match[2] }
}

function descriptor(run, project, item, source) {
  const runId = stringValue(run.id)
  const ownerSessionId = stringValue(run.parentSessionId) || stringValue(run.ownerSessionId) || null
  const createdAt = timeValue(run.createdAt)
  const finishedAt = timeValue(run.finishedAt)
  const at = timeValue(item.at) || finishedAt || createdAt
  const bytes = Number.isFinite(item.bytes) && item.bytes >= 0 ? Math.floor(item.bytes) : null
  const kind = stringValue(item.kind) || inferredKind(item.href)
  return {
    id: stableId(runId, item.identity),
    runId,
    ownerSessionId,
    project,
    goal: stringValue(run.goal) || null,
    runStatus: stringValue(run.status) || null,
    name: stringValue(item.name) || artifactName(item.href),
    kind,
    source,
    href: item.href,
    path: item.path,
    bytes,
    at,
    createdAt,
    finishedAt,
  }
}

/**
 * Merge and sort every artifact without applying query filters or a page cap.
 * Single-id reads use this so a run with more than one page of artifacts can
 * still resolve any id returned by the list endpoint.
 *
 * @param {Array<object>} runs - durable run records (already scoped by caller).
 * @param {Map<string, object>|object<string, object>} sessionProjects - visible workspace projection.
 * @returns {Array<object>} all descriptors, newest first.
 */
export function collectArtifacts(runs, sessionProjects = {}) {
  const rows = Array.isArray(runs) ? runs : []
  const merged = new Map()
  for (const run of rows) {
    const runId = stringValue(run?.id)
    if (!run || !runId) continue
    const project = projectFor(sessionProjects, stringValue(run.parentSessionId) || stringValue(run.ownerSessionId))
    const base = baseFor(run, project)
    const add = (raw, declared = null, link = null) => {
      const target = candidateTarget(raw, base)
      if (!target) return
      if (!declared && base && target.kind === 'file') {
        const rawText = String(raw)
        const relativeLink = !path.isAbsolute(rawText) && !WINDOWS_ABSOLUTE.test(rawText) && !isWebUrl(rawText)
        const relative = path.relative(base, target.path)
        if (relativeLink && (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))) return
      }
      const key = `${runId}\0${target.identity}`
      const previous = merged.get(key)
      if (previous && (previous.source === 'declared' || !declared)) return
      const source = declared ? 'declared' : 'report'
      const item = declared
        ? { ...target, name: declared.name, kind: declared.kind, bytes: declared.bytes, at: declared.at }
        : { ...target, name: link?.label, kind: null, bytes: null, at: null }
      merged.set(key, { sort: descriptor(run, project, item, source), source })
    }
    for (const artifact of Array.isArray(run.artifacts) ? run.artifacts : []) {
      if (!artifact || typeof artifact !== 'object') continue
      const raw = stringValue(artifact.href) || stringValue(artifact.path)
      if (raw) add(raw, artifact)
    }
    for (const link of reportLinks(run.report)) add(link.href, null, link)
  }
  const artifacts = [...merged.values()].map(entry => entry.sort).sort((left, right) => {
    const l = Date.parse(left.finishedAt ?? left.at ?? left.createdAt ?? '') || 0
    const r = Date.parse(right.finishedAt ?? right.at ?? right.createdAt ?? '') || 0
    return r - l || left.id.localeCompare(right.id)
  })
  const versions = new Map()
  for (const artifact of artifacts) {
    if (!artifact.path) continue
    const key = `${artifact.project?.cwd ?? ''}\0${path.normalize(artifact.path)}`
    const rows = versions.get(key) ?? []
    rows.push(artifact)
    versions.set(key, rows)
  }
  return artifacts.map(artifact => {
    if (!artifact.path) return artifact
    const rows = versions.get(`${artifact.project?.cwd ?? ''}\0${path.normalize(artifact.path)}`) ?? []
    if (rows.length < 2) return artifact
    return { ...artifact, versionCount: rows.length, versions: rows.map(item => ({
      id: item.id, runId: item.runId, ownerSessionId: item.ownerSessionId, href: item.href,
      at: item.at ?? item.finishedAt ?? item.createdAt, goal: item.goal, runStatus: item.runStatus,
    })) }
  })
}

/**
 * Local files referenced by one or more runs, including declared artifacts and
 * paths found in Markdown reports. URLs are omitted because an archive cannot
 * make an external resource self-contained. The result is deduplicated by the
 * same normalized identity used by `collectArtifacts`.
 *
 * @param {Array<object>} runs - durable run records.
 * @param {Map<string, object>|object<string, object>} [sessionProjects] - visible workspace projection.
 * @returns {Array<{ path: string, href: string, name: string, source: string, kind: string }>} local references.
 */
export function collectLocalArtifacts(runs, sessionProjects = {}) {
  const seen = new Set()
  const files = []
  for (const artifact of collectArtifacts(runs, sessionProjects)) {
    if (!artifact.path || seen.has(artifact.path)) continue
    seen.add(artifact.path)
    files.push({
      path: artifact.path,
      href: artifact.href,
      name: artifact.name || artifactName(artifact.path),
      source: artifact.source,
      kind: artifact.kind,
    })
  }
  return files
}

/**
 * Merge declared run artifacts with links found in their Markdown reports.
 * Declared artifacts win when both sources name the same normalised target.
 *
 * @param {Array<object>} runs - durable run records (already scoped by caller).
 * @param {Map<string, object>|object<string, object>} sessionProjects - visible workspace projection.
 * @param {object} [options] - q, kind, project, from, to, cursor, and limit.
 * @returns {{artifacts: Array<object>, nextCursor: string|null}}
 */
export function listArtifacts(runs, sessionProjects = {}, options = {}) {
  const query = stringValue(options.q).toLowerCase()
  const terms = query.split(/\s+/).filter(Boolean)
  const kind = stringValue(options.kind).toLowerCase()
  const project = stringValue(options.project).toLowerCase()
  const from = options.from == null || options.from === '' ? null : boundary(options.from, 'from')
  const to = options.to == null || options.to === '' ? null : boundary(options.to, 'to')
  if (from !== null && to !== null && from > to) {
    throw new WorkbenchError(400, 'from must not be later than to', { id: 'invalid-artifact-date' })
  }
  const rawLimit = options.limit == null || options.limit === '' ? DEFAULT_LIMIT : options.limit
  if (!/^\d+$/.test(String(rawLimit))) {
    throw new WorkbenchError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`, { id: 'invalid-artifact-limit' })
  }
  const limit = Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new WorkbenchError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`, { id: 'invalid-artifact-limit' })
  }

  let artifacts = collectArtifacts(runs, sessionProjects).filter(sort => {
    if (kind && sort.kind.toLowerCase() !== kind) return false
    if (project && ![sort.project?.name, sort.project?.cwd].some(value => value?.toLowerCase() === project)) return false
    if (terms.length) {
      const haystack = `${sort.id} ${sort.runId} ${sort.ownerSessionId ?? ''} ${sort.project?.name ?? ''} ${sort.project?.cwd ?? ''} ${sort.goal ?? ''} ${sort.name} ${sort.kind} ${sort.href}`.toLowerCase()
      if (terms.some(term => !haystack.includes(term))) return false
    }
    const millis = Date.parse(sort.finishedAt ?? sort.at ?? sort.createdAt ?? '')
    if (from !== null && (!Number.isFinite(millis) || millis < from)) return false
    if (to !== null && (!Number.isFinite(millis) || millis > to)) return false
    return true
  })

  let start = 0
  const cursor = stringValue(options.cursor)
  if (cursor) {
    if (cursor.length > MAX_CURSOR) {
      throw new WorkbenchError(400, 'cursor is too long', { id: 'invalid-artifact-cursor' })
    }
    start = artifacts.findIndex(artifact => artifact.id === cursor)
    if (start < 0) {
      throw new WorkbenchError(400, 'cursor does not match this artifact query', { id: 'invalid-artifact-cursor' })
    }
    start += 1
  }
  const page = artifacts.slice(start, start + limit)
  const nextCursor = start + page.length < artifacts.length ? page.at(-1)?.id ?? null : null
  return { artifacts: page, nextCursor }
}
