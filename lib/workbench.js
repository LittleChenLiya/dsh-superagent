/**
 * Local workspace panel for dsh-superagent.
 *
 * The panel is an IDE-shaped view over one directory on the machine that runs
 * the host: a file tree, a plain-text editor, a diff preview before saving, and
 * the list of files an earlier run touched. It deliberately does not ask the
 * host for an API — the plugin owns the filesystem access itself.
 *
 * Safety properties, in order of importance:
 *
 * - Off unless `workbenchPort` is configured.
 * - Bound to 127.0.0.1, never a routable interface.
 * - Every request needs `Authorization: Bearer <token>`. The token is random
 *   per process and written to `<stateDir>/workbench.json` with mode 0600.
 * - Every path is resolved, then realpath-resolved, then checked against the
 *   configured workspace root. A symlink that points outside is refused, and
 *   the reason is sent back instead of an empty 404.
 * - The plugin state directory is always refused, so the panel cannot read the
 *   control-plane token that lives next to its own.
 * - The `Host` header must name the loopback address, which blocks DNS
 *   rebinding; no CORS headers are sent.
 * - Binary files and files above the edit limit are readable only as metadata.
 * - Saving requires the hash and mtime the editor read, so a file changed by
 *   another process is never overwritten silently.
 *
 * @module dsh-superagent/workbench
 */
import { execFile } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fsp from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { ACTIVE_STATUSES, TERMINAL_STATUSES } from './store.js'

const execFileAsync = promisify(execFile)

/** Bodies are editor text plus a little JSON; nothing here uploads a file. */
const BODY_LIMIT = 2 * 1024 * 1024
/** Above this a file is shown as a read-only size hint instead of an editor. */
export const MAX_EDIT_BYTES = 512 * 1024
/** One directory listing is capped so a generated folder cannot pin the host. */
const TREE_LIMIT = 2000
const SNAPSHOT_LIMIT = 4000
const REQUEST_TIMEOUT_MS = 30_000
const DISCOVERY_FILE = 'workbench.json'
const ROUTE_HINT = 'GET / serves the panel; the JSON API is under /api.'
/** Directories a change snapshot never walks into. */
const SNAPSHOT_SKIP = new Set(['.git', '.hg', '.svn', 'node_modules'])

/** Error shape used by the routing layer to choose a status code. */
export class WorkbenchError extends Error {
  constructor(status, message, { id = 'bad-request', hint } = {}) {
    super(message)
    this.status = status
    this.id = id
    this.hint = hint
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sameToken(given, expected) {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A NUL byte in the head of a file is the cheap, stable binary signal. */
export function looksBinary(buffer) {
  const head = buffer.subarray(0, 8000)
  return head.includes(0)
}

/** Send JSON with the headers every response in this module shares. */
export function send(res, status, payload, extra = {}) {
  if (res.headersSent) return
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  if (res.headersSent) return
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(text)
}

export function errorPayload(error) {
  if (error instanceof WorkbenchError) {
    return {
      ok: false,
      error: { id: error.id, summary: error.message, hint: error.hint ?? null, detail: error.message },
    }
  }
  const code = error?.code ? `${error.code}: ` : ''
  return {
    ok: false,
    error: { id: 'internal', summary: `${code}${error?.message ?? String(error)}`, hint: null },
  }
}

export function statusFor(error) {
  return error instanceof WorkbenchError ? error.status : 500
}

/** Read one request body as text, refusing anything above the cap. */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new WorkbenchError(413, `request body is larger than ${limit} bytes`, {
          id: 'body-too-large',
          hint: 'the editor sends text only; keep one save under the documented limit.',
        }))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', fail)
    req.on('aborted', () => fail(new WorkbenchError(400, 'the client aborted the request', { id: 'aborted' })))
  })
}

export async function readJson(req) {
  const text = (await readBody(req)).trim()
  if (!text) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new WorkbenchError(400, `request body is not JSON: ${error?.message ?? error}`, {
      id: 'bad-json',
      hint: 'send a JSON object.',
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkbenchError(400, 'request body must be a JSON object', { id: 'bad-json' })
  }
  return parsed
}

/**
 * Split text into diff lines, remembering whether the final newline exists.
 * @param {string} text - input.
 * @returns {{ lines: string[], finalNewline: boolean }} lines without the
 *   trailing empty element.
 */
function splitLines(text) {
  if (text === '') return { lines: [], finalNewline: false }
  const finalNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (finalNewline) lines.pop()
  return { lines, finalNewline }
}

/**
 * Myers difference over two line arrays. Bounded by the number of lines, which
 * is already bounded by the edit size cap, so no O(n*m) table is allocated.
 *
 * @param {string[]} before - old lines.
 * @param {string[]} after - new lines.
 * @returns {{ type: ' ' | '-' | '+', line: string }[]} edit script.
 */
function diffOps(before, after) {
  const n = before.length
  const m = after.length
  if (n === 0) return after.map(line => ({ type: '+', line }))
  if (m === 0) return before.map(line => ({ type: '-', line }))
  const max = n + m
  const trace = []
  const v = new Map()
  v.set(1, 0)
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -Infinity) < (v.get(k + 1) ?? -Infinity))
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }

  const ops = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const previous = trace[d]
    const k = x - y
    const down = k === -d || (k !== d && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity))
    const prevK = down ? k + 1 : k - 1
    const prevX = previous.get(prevK) ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: ' ', line: before[x - 1] })
      x--
      y--
    }
    if (x === prevX) {
      ops.push({ type: '+', line: after[y - 1] })
      y--
    } else {
      ops.push({ type: '-', line: before[x - 1] })
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: ' ', line: before[x - 1] })
    x--
    y--
  }
  while (x > 0) ops.push({ type: '-', line: before[--x] })
  while (y > 0) ops.push({ type: '+', line: after[--y] })
  ops.reverse()
  return ops
}

/**
 * Render a unified diff between two strings.
 *
 * A small hand-written implementation keeps the package dependency-free; it is
 * used both for the save preview and for a run's changed files.
 *
 * @param {string} beforeText - original content.
 * @param {string} afterText - proposed content.
 * @param {{ path?: string, context?: number }} [options] - header path and context lines.
 * @returns {string} unified diff, or an empty string when nothing changed.
 */
export function createUnifiedDiff(beforeText, afterText, options = {}) {
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  const ops = diffOps(before.lines, after.lines)
  let oldNo = 1
  let newNo = 1
  for (const op of ops) {
    op.oldNo = op.type === '+' ? null : oldNo++
    op.newNo = op.type === '-' ? null : newNo++
  }
  const changes = ops
    .map((op, index) => (op.type === ' ' ? -1 : index))
    .filter(index => index >= 0)
  if (changes.length === 0) return ''

  const context = Math.max(0, Math.trunc(options.context ?? 3))
  const runs = []
  for (const index of changes) {
    const last = runs.at(-1)
    if (last && index - last.end <= context * 2 + 1) last.end = index
    else runs.push({ start: index, end: index })
  }

  const header = [
    `--- a/${options.path ?? 'file'}`,
    `+++ b/${options.path ?? 'file'}`,
  ]
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === '+') added++
    if (op.type === '-') removed++
  }
  header.push(`# ${added} added, ${removed} removed`)

  const body = []
  for (const run of runs) {
    const from = Math.max(0, run.start - context)
    const to = Math.min(ops.length - 1, run.end + context)
    const hunk = ops.slice(from, to + 1)
    const oldCount = hunk.filter(op => op.type !== '+').length
    const newCount = hunk.filter(op => op.type !== '-').length
    const firstOld = hunk.find(op => op.oldNo !== null)?.oldNo
    const firstNew = hunk.find(op => op.newNo !== null)?.newNo
    const oldStart = oldCount > 0 ? firstOld : (hunk[0].oldNo ?? 1) - 1
    const newStart = newCount > 0 ? firstNew : (hunk[0].newNo ?? 1) - 1
    body.push(`@@ -${Math.max(0, oldStart)},${oldCount} +${Math.max(0, newStart)},${newCount} @@`)
    for (const op of hunk) body.push(`${op.type}${op.line}`)
  }
  return `${[...header, ...body].join('\n')}\n`
}

/** Count a diff's added and removed lines, for a compact preview label. */
export function diffStats(diff) {
  let added = 0
  let removed = 0
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

/** Compare two absolute paths case-insensitively on Windows. */
function isInside(parent, child) {
  const base = process.platform === 'win32' ? parent.toLowerCase() : parent
  const target = process.platform === 'win32' ? child.toLowerCase() : child
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`)
}

/** Walk one workspace without reading file contents, for change detection. */
async function snapshotTree(root, { stateRoot, maxFiles = SNAPSHOT_LIMIT } = {}) {
  const files = new Map()
  const stack = ['']
  let truncated = false
  while (stack.length > 0) {
    const relative = stack.pop()
    const absolute = relative ? path.join(root, relative) : root
    let entries
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.size >= maxFiles) {
        truncated = true
        break
      }
      if (SNAPSHOT_SKIP.has(entry.name)) continue
      const childAbs = path.join(absolute, entry.name)
      if (stateRoot && isInside(stateRoot, childAbs)) continue
      const childRel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        stack.push(childRel)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fsp.stat(childAbs)
        files.set(childRel, { size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // A file removed mid-walk is simply not part of this snapshot.
      }
    }
  }
  return { files, truncated }
}

/** Compare two snapshots into the list persisted on the run record. */
function changedFiles(before, after) {
  const paths = new Set([...before.files.keys(), ...after.files.keys()])
  const changes = []
  for (const file of paths) {
    const old = before.files.get(file)
    const now = after.files.get(file)
    if (!old && now) changes.push({ path: file, change: 'added', beforeBytes: 0, afterBytes: now.size })
    else if (old && !now) changes.push({ path: file, change: 'deleted', beforeBytes: old.size, afterBytes: 0 })
    else if (old && now && (old.size !== now.size || old.mtimeMs !== now.mtimeMs)) {
      changes.push({ path: file, change: 'modified', beforeBytes: old.size, afterBytes: now.size })
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path))
  return changes
}

/**
 * Record which workspace files changed while a run was active.
 *
 * The orchestrator already persists one JSON record per run; this tracker wraps
 * the store's `write` so the record itself carries `changes`, which is exactly
 * what the panel reads later. The orchestrator file stays untouched and a run
 * started while the panel is off simply has no `changes` field.
 *
 * @param {object} options - dependencies.
 * @param {object} options.store - store returned by `createStore`.
 * @param {string} options.root - absolute workspace root.
 * @param {string} options.stateRoot - plugin state directory, excluded from snapshots.
 * @param {(message: string) => void} [options.warn] - diagnostics sink.
 * @returns {{ store: object }} the wrapped store.
 */
export function createRunChangeTracker({ store, root, stateRoot, warn = () => {} }) {
  const snapshots = new Map()
  let queue = Promise.resolve()

  async function track(run) {
    if (!run || typeof run.id !== 'string') return
    if (!snapshots.has(run.id) && ACTIVE_STATUSES.has(run.status)) {
      snapshots.set(run.id, await snapshotTree(root, { stateRoot }))
      return
    }
    if (TERMINAL_STATUSES.has(run.status) && !run.changes) {
      const before = snapshots.get(run.id)
      snapshots.delete(run.id)
      if (!before) {
        run.changes = {
          root,
          recordedAt: new Date().toISOString(),
          files: [],
          incomplete: true,
          note: 'no snapshot was taken before this run started (it predates the workbench or resumed in another process), '
            + 'so changed files cannot be attributed',
        }
        return
      }
      const after = await snapshotTree(root, { stateRoot })
      run.changes = {
        root,
        recordedAt: new Date().toISOString(),
        files: changedFiles(before, after),
        truncated: before.truncated || after.truncated,
      }
    }
  }

  const wrapped = {
    ...store,
    async write(run) {
      try {
        await track(run)
      } catch (error) {
        warn(`cannot record changed files for run ${run?.id ?? '?'}: ${error?.message ?? error}`)
      }
      return store.write(run)
    },
  }
  // Keep snapshot walks from overlapping when several runs write together.
  const sequential = wrapped.write
  wrapped.write = async run => {
    const next = queue.catch(() => {}).then(() => sequential(run))
    queue = next
    return next
  }
  return { store: wrapped }
}

/**
 * Ask git for the working-tree diff of one path.
 *
 * `git diff HEAD` already normalizes line endings the same way the checkout
 * did, so a CRLF working tree does not turn into a whole-file diff. It also
 * covers staged, unstaged, and deleted tracked files; untracked files produce
 * an empty patch and are handled by the caller.
 *
 * @param {string} root - repository root.
 * @param {string} relative - path relative to the root.
 * @returns {Promise<{ patch: string|null, available: boolean, reason: string|null }>}
 */
async function gitPatch(root, relative) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'diff', 'HEAD', '--no-color', '--', relative], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
    })
    return { patch: stdout, available: true, reason: null }
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim()
    const missingRepo = /not a git repository|not recognized as an internal|ENOENT/i.test(detail)
    return { patch: null, available: !missingRepo, reason: detail || 'git could not diff this path' }
  }
}

/** Whether git tracks a path, used to explain an empty diff. */
async function gitTracks(root, relative) {
  try {
    await execFileAsync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relative], {
      maxBuffer: 1024 * 1024,
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8',
    })
    return true
  } catch {
    return false
  }
}

/**
 * Create the panel. Nothing is bound until `start()` is called.
 *
 * @param {object} options - dependencies.
 * @param {number} options.port - 1–65535, or 0 for an ephemeral port.
 * @param {string} options.root - absolute workspace root; everything outside is refused.
 * @param {string} options.stateRoot - plugin state directory; always refused.
 * @param {object} [options.store] - run store, used by the run views.
 * @param {string} options.version - plugin version reported by `/api/health`.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 */
export function createWorkbench({ port, root, stateRoot, store, version, log = () => {} }) {
  const token = randomBytes(32).toString('base64url')
  const instanceId = randomBytes(6).toString('hex')
  const discoveryPath = path.join(stateRoot, DISCOVERY_FILE)
  const startedAt = new Date().toISOString()
  let realRoot = null
  let realStateRoot = null
  let boundPort = null
  let server = null
  let html = null
  let writeSeq = 0
  let starting = null
  let stopRequested = false
  let closing = null

  const url = () => `http://127.0.0.1:${boundPort}`
  const allowedHosts = () => new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
    `[::1]:${boundPort}`,
  ])

  function authorize(req, { allowQuery = false } = {}) {
    if (!boundPort) {
      throw new WorkbenchError(503, 'the workbench is not listening yet', { id: 'not-ready' })
    }
    const host = String(req.headers.host ?? '').toLowerCase()
    if (!allowedHosts().has(host)) {
      throw new WorkbenchError(403, `unexpected Host header "${host}"; the workbench answers only on 127.0.0.1 and localhost`, {
        id: 'forbidden-host',
        hint: `open ${boundPort ? url() : 'the URL in the discovery file'} directly.`,
      })
    }
    const header = String(req.headers.authorization ?? '')
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    let given = match?.[1] ?? ''
    if (!given && allowQuery) {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
      if (query) given = query
    }
    if (!given || !sameToken(given, token)) {
      throw new WorkbenchError(401, 'missing or wrong access token', {
        id: 'unauthorized',
        hint: `read the "token" field in ${discoveryPath}, then open "url?token=<token>" once. `
          + 'The token is regenerated each time the host starts.',
      })
    }
  }

  /**
   * Resolve a client path inside the workspace.
   *
   * Absolute paths, drive letters, traversal, and symlinks that leave the root
   * all fail with a readable reason. The plugin state directory is refused even
   * though it may sit inside the root.
   */
  async function resolvePath(input) {
    const raw = typeof input === 'string' ? input : ''
    if (raw.includes('\0')) {
      throw new WorkbenchError(400, 'the path contains a NUL byte', { id: 'bad-path' })
    }
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')) {
      throw new WorkbenchError(403, `"${raw}" is an absolute path; the workbench only serves paths inside its root`, {
        id: 'outside-root',
        hint: `use a path relative to ${root}.`,
      })
    }
    const candidate = path.resolve(realRoot, raw || '.')
    if (!isInside(realRoot, candidate)) {
      throw new WorkbenchError(403, `"${raw}" resolves outside the workspace root ${root}`, {
        id: 'outside-root',
        hint: 'the panel cannot read or write anything above its configured root.',
      })
    }
    let real
    try {
      real = await fsp.realpath(candidate)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new WorkbenchError(404, `"${raw}" does not exist`, { id: 'not-found' })
      }
      throw error
    }
    if (!isInside(realRoot, real)) {
      throw new WorkbenchError(403, `"${raw}" is a link that points outside the workspace root ${root}`, {
        id: 'outside-root',
        hint: 'links are followed only when the target stays inside the configured root.',
      })
    }
    if (realStateRoot && isInside(realStateRoot, real)) {
      throw new WorkbenchError(403, `"${raw}" is inside the plugin state directory`, {
        id: 'protected-path',
        hint: 'run state and access tokens are not readable through the panel.',
      })
    }
    const relative = path.relative(realRoot, candidate).split(path.sep).join('/')
    return { relative, absolute: real }
  }

  async function statTarget(input, wanted) {
    const resolved = await resolvePath(input)
    const stat = await fsp.stat(resolved.absolute)
    if (wanted === 'dir' && !stat.isDirectory()) {
      throw new WorkbenchError(400, `"${resolved.relative}" is not a directory`, { id: 'not-a-directory' })
    }
    if (wanted === 'file' && !stat.isFile()) {
      throw new WorkbenchError(400, `"${resolved.relative}" is not a regular file`, { id: 'not-a-file' })
    }
    return { ...resolved, stat }
  }

  async function listTree(input) {
    const { relative, absolute } = await statTarget(input ?? '.', 'dir')
    const dirents = await fsp.readdir(absolute, { withFileTypes: true })
    const entries = []
    for (const dirent of dirents) {
      if (entries.length >= TREE_LIMIT) break
      const childAbs = path.join(absolute, dirent.name)
      if (realStateRoot && isInside(realStateRoot, childAbs)) continue
      const childRel = relative ? `${relative}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        entries.push({ name: dirent.name, path: childRel, type: 'dir' })
        continue
      }
      if (dirent.isSymbolicLink()) {
        entries.push({ name: dirent.name, path: childRel, type: 'link' })
        continue
      }
      if (!dirent.isFile()) continue
      let stat = null
      try {
        stat = await fsp.stat(childAbs)
      } catch {
        // A file removed between readdir and stat is left out.
      }
      entries.push({
        name: dirent.name,
        path: childRel,
        type: 'file',
        size: stat?.size ?? null,
        mtimeMs: stat?.mtimeMs ?? null,
      })
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : b.type === 'dir' ? 1 : 0))
    return { path: relative, entries, truncated: dirents.length > entries.length }
  }

  async function readFileInfo(input) {
    const { relative, absolute, stat } = await statTarget(input, 'file')
    if (stat.size > MAX_EDIT_BYTES) {
      return {
        path: relative,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        readOnly: 'too-large',
        note: `this file is ${stat.size} bytes, above the ${MAX_EDIT_BYTES}-byte edit limit; the panel will not open it`,
        content: null,
        hash: null,
      }
    }
    const buffer = await fsp.readFile(absolute)
    if (looksBinary(buffer)) {
      return {
        path: relative,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        readOnly: 'binary',
        note: 'this looks like a binary file, so it is shown as metadata only',
        content: null,
        hash: sha256(buffer),
      }
    }
    return {
      path: relative,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      readOnly: null,
      note: null,
      content: buffer.toString('utf8'),
      hash: sha256(buffer),
    }
  }

  async function preview(body) {
    const content = body?.content
    if (typeof content !== 'string') {
      throw new WorkbenchError(400, 'content must be a string', { id: 'bad-content' })
    }
    const info = await readFileInfo(body.path)
    if (info.readOnly) {
      throw new WorkbenchError(409, info.note, { id: `read-only-${info.readOnly}` })
    }
    const diff = createUnifiedDiff(info.content, content, { path: info.path })
    return { path: info.path, diff, stats: diffStats(diff), identical: diff === '' }
  }

  async function save(body) {
    const content = body?.content
    if (typeof content !== 'string') {
      throw new WorkbenchError(400, 'content must be a string', { id: 'bad-content' })
    }
    const { relative, absolute, stat } = await statTarget(body.path, 'file')
    if (stat.size > MAX_EDIT_BYTES) {
      throw new WorkbenchError(409, `"${relative}" is above the ${MAX_EDIT_BYTES}-byte edit limit`, {
        id: 'read-only-too-large',
      })
    }
    const current = await fsp.readFile(absolute)
    if (looksBinary(current)) {
      throw new WorkbenchError(409, `"${relative}" is a binary file; the panel cannot edit it`, { id: 'read-only-binary' })
    }
    if (typeof body.expectedHash !== 'string' || !body.expectedHash) {
      throw new WorkbenchError(400, 'expectedHash is required; open the file first so the panel can detect external edits', {
        id: 'missing-baseline',
        hint: 'reload the file in the editor before saving.',
      })
    }
    if (!Number.isFinite(body.expectedMtimeMs)) {
      throw new WorkbenchError(400, 'expectedMtimeMs is required; open the file first so the panel can detect external edits', {
        id: 'missing-baseline',
        hint: 'reload the file in the editor before saving.',
      })
    }
    if (stat.mtimeMs !== body.expectedMtimeMs || sha256(current) !== body.expectedHash) {
      throw new WorkbenchError(409, `"${relative}" changed on disk after it was opened; refusing to overwrite it`, {
        id: 'external-change',
        hint: 'reload the file to see the other change, then reapply your edit.',
      })
    }
    const buffer = Buffer.from(content, 'utf8')
    if (buffer.length > MAX_EDIT_BYTES) {
      throw new WorkbenchError(413, `the new content is above the ${MAX_EDIT_BYTES}-byte edit limit`, {
        id: 'save-too-large',
      })
    }
    const directory = path.dirname(absolute)
    const tmp = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${++writeSeq}.wb.tmp`)
    await fsp.writeFile(tmp, buffer, { flag: 'wx' })
    try {
      await fsp.rename(tmp, absolute)
    } catch (error) {
      await fsp.unlink(tmp).catch(() => {})
      throw error
    }
    const after = await fsp.stat(absolute)
    return {
      path: relative,
      size: after.size,
      mtimeMs: after.mtimeMs,
      hash: sha256(buffer),
    }
  }

  async function listRuns({ limit } = {}) {
    if (!store || typeof store.list !== 'function') return { runs: [], note: 'run storage is not available in this process' }
    const rows = Math.max(1, Math.min(100, Number(limit) || 30))
    const runs = await store.list()
    return {
      runs: runs.slice(0, rows).map(run => ({
        id: run.id,
        goal: run.goal,
        status: run.status,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt ?? null,
        parentSessionId: run.parentSessionId ?? null,
        changedFiles: Array.isArray(run.changes?.files) ? run.changes.files.length : null,
        changesIncomplete: run.changes?.incomplete === true,
      })),
    }
  }

  async function readRun(runId) {
    if (!store || typeof store.read !== 'function') {
      throw new WorkbenchError(503, 'run storage is not available in this process', { id: 'no-store' })
    }
    let run = null
    try {
      run = await store.read(runId)
    } catch (error) {
      throw new WorkbenchError(500, `cannot read run ${runId}: ${error?.message ?? error}`, { id: 'run-read-failed' })
    }
    if (!run) throw new WorkbenchError(404, `no run ${runId} in this state directory`, { id: 'unknown-run' })
    return run
  }

  async function runDiff(runId, requestedPath) {
    const run = await readRun(runId)
    const changes = Array.isArray(run.changes?.files) ? run.changes.files : []
    const entry = changes.find(item => item.path === requestedPath)
    if (!entry) {
      throw new WorkbenchError(404, `"${requestedPath ?? ''}" is not recorded as changed by run ${runId}`, {
        id: 'not-in-run',
        hint: changes.length > 0 ? `changed files: ${changes.map(item => item.path).join(', ')}` : 'this run recorded no changed files',
      })
    }
    const runRoot = typeof run.changes?.root === 'string' ? run.changes.root : null
    if (!runRoot || !isInside(realRoot, runRoot) || !isInside(runRoot, realRoot)) {
      return {
        path: entry.path,
        change: entry.change,
        diff: null,
        note: `the run recorded ${runRoot ?? 'no workspace root'}, which is not the root this panel serves`,
      }
    }
    // A run record is local state, but a path in it still has to satisfy the
    // same boundary as a path from the browser.
    const candidate = path.resolve(realRoot, entry.path)
    if (!isInside(realRoot, candidate) || (realStateRoot && isInside(realStateRoot, candidate))) {
      return {
        path: entry.path,
        change: entry.change,
        diff: null,
        note: 'the run record points outside the workspace this panel serves',
      }
    }
    const git = await gitPatch(realRoot, entry.path)
    if (git.patch && git.patch.trim()) {
      const patch = git.patch.endsWith('\n') ? git.patch : `${git.patch}\n`
      return {
        path: entry.path,
        change: entry.change,
        diff: patch,
        stats: diffStats(patch),
        baseline: 'git HEAD',
        note: null,
      }
    }
    if (git.available && await gitTracks(realRoot, entry.path)) {
      return {
        path: entry.path,
        change: entry.change,
        diff: '',
        stats: { added: 0, removed: 0 },
        baseline: 'git HEAD',
        note: 'the file matches git HEAD, so the recorded change is no longer present in the working tree',
      }
    }

    const current = await fsp.readFile(path.join(realRoot, entry.path)).catch(() => null)
    if (!current) {
      return {
        path: entry.path,
        change: entry.change,
        diff: null,
        note: `no baseline: ${git.reason ?? 'git has no copy and the file is gone'}`,
      }
    }
    const diff = createUnifiedDiff('', current.toString('utf8'), { path: entry.path })
    return {
      path: entry.path,
      change: entry.change,
      diff,
      stats: diffStats(diff),
      baseline: null,
      note: `no git baseline (${git.reason ?? 'the file is untracked'}); the diff shows the whole file as added`,
    }
  }

  async function handle(req, res) {
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
        if (method !== 'GET') {
          throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed', hint: ROUTE_HINT })
        }
        // The one page load may carry the token in the query string, because a
        // browser cannot set an Authorization header on navigation. The page
        // moves it into sessionStorage and strips it from the address bar.
        authorize(req, { allowQuery: true })
        sendText(res, 200, html, 'text/html; charset=utf-8', {
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        return
      }

      authorize(req)
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts[0] !== 'api' || parts.length < 2) {
        throw new WorkbenchError(404, `no route for ${method} ${parsed.pathname}`, { id: 'not-found', hint: ROUTE_HINT })
      }

      if (parts[1] === 'health' && parts.length === 2) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        send(res, 200, {
          ok: true,
          data: {
            service: 'dsh-superagent-workbench',
            version,
            root: realRoot,
            pid: process.pid,
            startedAt,
            limits: { maxEditBytes: MAX_EDIT_BYTES },
          },
        })
        return
      }

      if (parts[1] === 'tree' && parts.length === 2) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        send(res, 200, { ok: true, data: await listTree(parsed.searchParams.get('path') ?? '.') })
        return
      }

      if (parts[1] === 'file' && parts.length === 2) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        send(res, 200, { ok: true, data: await readFileInfo(parsed.searchParams.get('path')) })
        return
      }

      if (parts[1] === 'preview' && parts.length === 2) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        send(res, 200, { ok: true, data: await preview(await readJson(req)) })
        return
      }

      if (parts[1] === 'save' && parts.length === 2) {
        if (method !== 'POST') throw new WorkbenchError(405, 'only POST is allowed here', { id: 'method-not-allowed' })
        send(res, 200, { ok: true, data: await save(await readJson(req)) })
        return
      }

      if (parts[1] === 'runs' && parts.length <= 3) {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        if (parts.length === 2) {
          send(res, 200, { ok: true, data: await listRuns({ limit: parsed.searchParams.get('limit') }) })
          return
        }
        let runId
        try {
          runId = decodeURIComponent(parts[2])
        } catch {
          throw new WorkbenchError(400, 'the run id is not valid percent-encoding', { id: 'bad-run-id' })
        }
        if (parts.length === 3) {
          const run = await readRun(runId)
          send(res, 200, {
            ok: true,
            data: {
              id: run.id,
              goal: run.goal,
              status: run.status,
              createdAt: run.createdAt,
              finishedAt: run.finishedAt ?? null,
              changes: run.changes ?? null,
            },
          })
          return
        }
      }

      if (parts[1] === 'runs' && parts.length === 4 && parts[3] === 'diff') {
        if (method !== 'GET') throw new WorkbenchError(405, 'only GET is allowed here', { id: 'method-not-allowed' })
        let runId
        try {
          runId = decodeURIComponent(parts[2])
        } catch {
          throw new WorkbenchError(400, 'the run id is not valid percent-encoding', { id: 'bad-run-id' })
        }
        const filePath = parsed.searchParams.get('path')
        if (!filePath) throw new WorkbenchError(400, 'path is required', { id: 'missing-path' })
        send(res, 200, { ok: true, data: await runDiff(runId, filePath) })
        return
      }

      throw new WorkbenchError(404, `no route for ${method} ${parsed.pathname}`, { id: 'not-found', hint: ROUTE_HINT })
    } catch (error) {
      if (statusFor(error) >= 500) log(`workbench request failed: ${error?.message ?? error}`)
      send(res, statusFor(error), errorPayload(error))
    }
  }

  async function writeDiscovery() {
    const doc = {
      service: 'dsh-superagent-workbench',
      version,
      url: url(),
      token,
      root: realRoot,
      pid: process.pid,
      instanceId,
      startedAt,
    }
    const tmp = `${discoveryPath}.${process.pid}.${instanceId}.tmp`
    const handle = await fsp.open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
    await fsp.rename(tmp, discoveryPath)
    try {
      await fsp.chmod(discoveryPath, 0o600)
    } catch {
      // Windows ignores most mode bits; the file's ACL still applies.
    }
  }

  async function removeDiscovery() {
    try {
      const current = JSON.parse(await fsp.readFile(discoveryPath, 'utf8'))
      if (current?.instanceId !== instanceId) return
      await fsp.unlink(discoveryPath)
    } catch {
      // Already gone, or replaced by another instance.
    }
    await fsp.unlink(`${discoveryPath}.${process.pid}.${instanceId}.tmp`).catch(() => {})
  }

  async function closeServer() {
    if (!server) return
    const instance = server
    server = null
    boundPort = null
    await new Promise(resolve => {
      instance.close(() => resolve())
      instance.closeAllConnections?.()
    })
  }

  return {
    discoveryPath,
    get token() {
      return token
    },
    get port() {
      return boundPort
    },
    get url() {
      return boundPort ? url() : null
    },

    /** Bind the loopback port, load the page, and publish the discovery file. */
    async start() {
      if (server) return { port: boundPort, url: url() }
      if (starting) return starting
      if (stopRequested) throw new Error('the workbench has been stopped; a new instance is required')
      const run = (async () => {
        realRoot = await fsp.realpath(root)
        realStateRoot = await fsp.realpath(stateRoot).catch(() => path.resolve(stateRoot))
        html = await fsp.readFile(new URL('../public/workbench.html', import.meta.url), 'utf8')
        const instance = createServer((req, res) => {
          handle(req, res).catch(error => {
            log(`workbench handler crashed: ${error?.message ?? error}`)
            send(res, 500, errorPayload(error))
          })
        })
        instance.requestTimeout = REQUEST_TIMEOUT_MS
        instance.headersTimeout = 10_000
        instance.keepAliveTimeout = 5_000
        instance.maxConnections = 64
        await new Promise((resolve, reject) => {
          const onError = error => reject(error)
          instance.once('error', onError)
          instance.listen(port, '127.0.0.1', () => {
            instance.off('error', onError)
            resolve()
          })
        })
        server = instance
        boundPort = instance.address().port
        if (stopRequested) {
          await closeServer()
          throw new Error('the workbench was stopped before it finished starting')
        }
        try {
          await writeDiscovery()
        } catch (error) {
          await closeServer()
          throw new Error(`cannot write the discovery file ${discoveryPath}: ${error?.message ?? error}`)
        }
        log(`workbench listening on ${url()} (token in ${discoveryPath})`)
        return { port: boundPort, url: url() }
      })()
      starting = run
      try {
        return await run
      } finally {
        if (starting === run) starting = null
      }
    },

    /** Close the socket and remove this process's discovery file. */
    async stop() {
      stopRequested = true
      if (starting) {
        try {
          await starting
        } catch {
          // A start that failed has nothing to close.
        }
      }
      if (closing) return closing
      closing = (async () => {
        await closeServer()
        await removeDiscovery()
      })()
      return closing
    },
  }
}
