/**
 * Read-only installation checks for dsh-superagent.
 *
 * Two real releases failed in the same shape: the package installed cleanly and
 * then did nothing. One shipped an `index.js` that imported `lib/memory.js`,
 * `lib/notify.js`, and `lib/lock.js` while `package.json` `files` left them out,
 * so `npm pack` produced 15 files and the first `import` threw. Another profile
 * was left half-unpacked by an interrupted install: `package.json` said 0.9.1
 * while only five of eleven `lib` files existed, so the host could not mount
 * the plugin and nothing said why.
 *
 * `doctor` compares the three layers that have to agree — what the code
 * imports, what `files` promises, and what is actually on disk — plus the
 * profile wiring and the registered tool count. It only reads: no install, no
 * mount, no edit to the profile. The one write-free exception is the optional
 * registry comparison, which downloads one public tarball to hash it.
 *
 * @module dsh-superagent/doctor
 */
import { exec, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

export const PACKAGE_NAME = '@xiangyixie/dsh-superagent'

/** Tools this package version must register for the plugin to be complete. */
export const TOOL_NAMES = [
  'superagent_start',
  'superagent_status',
  'superagent_list',
  'superagent_cancel',
  'superagent_resume',
  'superagent_followup',
  'superagent_inject',
  'superagent_answer',
  'superagent_memory',
  'superagent_template',
  'superagent_schedule',
  'superagent_goal',
  'superagent_audit',
]

/** Files npm always includes, whether or not `files` lists them. */
const ALWAYS_PACKED = new Set(['package.json'])

/**
 * Relative import specifiers: `import x from './y.js'`, `export … from './y.js'`,
 * and `import './y.js'`. Only specifiers that start with `.` are package files;
 * bare names are built-ins or dependencies and are not ours to ship.
 */
const RELATIVE_IMPORT = /\b(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g

export function normalizeRel(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Remove comments while keeping string literals intact. A doc comment that
 * mentions an import path must not become a dependency of the package.
 */
export function stripComments(source) {
  const text = String(source)
  let out = ''
  let state = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const next = text[index + 1]
    if (state === null) {
      if (char === '/' && next === '/') {
        state = 'line'
        index += 1
      } else if (char === '/' && next === '*') {
        state = 'block'
        index += 1
      } else {
        if (char === "'" || char === '"' || char === '`') state = char
        out += char
      }
    } else if (state === 'line') {
      if (char === '\n') {
        state = null
        out += char
      }
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        state = null
        index += 1
      } else if (char === '\n') {
        out += char
      }
    } else {
      out += char
      if (char === '\\') {
        if (index + 1 < text.length) out += text[++index]
      } else if (char === state) {
        state = null
      }
    }
  }
  return out
}

/** Every relative specifier a source file mentions, in order, without duplicates. */
export function scanRelativeImports(source) {
  const found = new Set()
  for (const match of stripComments(source).matchAll(RELATIVE_IMPORT)) {
    if (match[1].startsWith('..') || match[1].startsWith('./')) found.add(match[1])
  }
  return [...found]
}

/**
 * Tool names a plugin entry point registers.
 *
 * The registration call is split at `ctx.tools.register(` and the first `name:`
 * in each chunk is the tool. That survives reformatting far better than one
 * giant regular expression, and it still counts a registration whose body the
 * parser would reject.
 */
export function readRegisteredTools(source) {
  const names = []
  for (const chunk of String(source).split('ctx.tools.register(').slice(1)) {
    const match = /name:\s*['"]([^'"]+)['"]/.exec(chunk)
    if (match) names.push(match[1])
  }
  return names
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim())
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return 0
}

function satisfiesToken(token, version) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(token)
  if (!match) return false
  const target = {
    major: Number(match[2]),
    minor: Number(match[3] ?? 0),
    patch: Number(match[4] ?? 0),
  }
  const relation = compareVersions(version, target)
  switch (match[1] ?? '=') {
    case '>=': return relation >= 0
    case '>': return relation > 0
    case '<=': return relation <= 0
    case '<': return relation < 0
    case '=': return relation === 0
    case '^': {
      if (relation < 0) return false
      const ceiling = target.major > 0
        ? { major: target.major + 1, minor: 0, patch: 0 }
        : { major: 0, minor: target.minor + 1, patch: 0 }
      return compareVersions(version, ceiling) < 0
    }
    case '~': {
      if (relation < 0) return false
      return compareVersions(version, { major: target.major, minor: target.minor + 1, patch: 0 }) < 0
    }
    default: return false
  }
}

/**
 * Test a plain semver range against a version. Supports `||`, space-separated
 * conjunctions, and the comparators an `engines` field actually uses. Anything
 * it cannot parse fails closed, because "unknown range" must not read as "fine".
 */
export function satisfiesRange(range, version) {
  const parsed = parseVersion(version)
  if (!parsed) return false
  const text = String(range ?? '').trim()
  if (!text || text === '*') return true
  return text.split('||').some(part => {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    return tokens.length === 0 || tokens.every(token => satisfiesToken(token, parsed))
  })
}

async function exists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

export async function readPackageJson(packageRoot) {
  const file = path.join(packageRoot, 'package.json')
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error?.message ?? error}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error?.message ?? error}`)
  }
}

function exportTargets(exportsField) {
  const targets = []
  const walk = value => {
    if (typeof value === 'string') targets.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(exportsField)
  return targets
}

/** Resolve `./x.js` written in `fromRel` to a repo-relative path that exists. */
async function resolveLocalFile(packageRoot, fromRel, specifier) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier))
  if (joined.startsWith('..')) return null
  const candidates = [joined]
  if (!path.posix.extname(joined)) candidates.push(`${joined}.js`, `${joined}/index.js`)
  for (const candidate of candidates) {
    if (await exists(path.join(packageRoot, candidate))) return candidate
  }
  return joined
}

/**
 * Expand a wildcard export target (`locale/*.json`) against disk. A pattern
 * without `*` is returned unchanged; a `*` outside the final path segment is
 * left literal, because only single-segment patterns are used today.
 */
async function expandWildcard(packageRoot, rel) {
  const star = rel.indexOf('*')
  if (star < 0) return [rel]
  const slash = rel.lastIndexOf('/', star)
  const dir = slash < 0 ? '.' : rel.slice(0, slash)
  const pattern = slash < 0 ? rel : rel.slice(slash + 1)
  if (pattern.includes('/')) return [rel]
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').split('*').join('[^/]*')
  const matcher = new RegExp(`^${escaped}$`)
  let names
  try {
    names = await fsp.readdir(path.join(packageRoot, dir))
  } catch {
    return [rel]
  }
  const matches = names
    .filter(name => matcher.test(name))
    .sort()
    .map(name => (dir === '.' ? name : `${dir}/${name}`))
  return matches.length > 0 ? matches : [rel]
}

/**
 * Files the package cannot run without: entry points plus everything they
 * import, transitively. `package.json` is included because `index.js` reads its
 * version, but npm always packs it, so it needs no `files` entry.
 */
export async function requiredFiles(packageRoot) {
  const pkg = await readPackageJson(packageRoot)
  const roots = new Set()
  const addRoot = value => {
    if (typeof value === 'string' && value.trim()) roots.add(normalizeRel(value.trim()))
  }
  addRoot(pkg.main)
  for (const value of Object.values(pkg.bin ?? {})) addRoot(value)
  exportTargets(pkg.exports).forEach(addRoot)
  addRoot(pkg.dsh?.bundle?.patch)
  if (roots.size === 0) addRoot('lib/index.js')

  const entries = new Set()
  for (const root of roots) {
    for (const rel of await expandWildcard(packageRoot, root)) entries.add(rel)
  }

  const required = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const rel = queue.shift()
    if (required.has(rel)) continue
    required.add(rel)
    if (!rel.endsWith('.js')) continue
    let source
    try {
      source = await fsp.readFile(path.join(packageRoot, rel), 'utf8')
    } catch {
      continue
    }
    for (const specifier of scanRelativeImports(source)) {
      const resolved = await resolveLocalFile(packageRoot, rel, specifier)
      if (resolved && !required.has(resolved)) queue.push(resolved)
    }
  }
  return [...required].sort()
}

function matchesFilesEntry(rel, entry) {
  const pattern = normalizeRel(entry).replace(/\/+$/, '')
  if (!pattern) return false
  if (!pattern.includes('*')) return rel === pattern || rel.startsWith(`${pattern}/`)
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${escaped}$`).test(rel) || new RegExp(`^${escaped}/`).test(rel)
}

/**
 * Compare one package directory's imports, `files` whitelist, and disk contents.
 * @param {string} packageRoot - absolute package directory.
 */
export async function auditLayout(packageRoot) {
  const pkg = await readPackageJson(packageRoot)
  const required = await requiredFiles(packageRoot)
  const declared = Array.isArray(pkg.files) ? pkg.files.map(normalizeRel) : []

  const missingFromDisk = []
  for (const rel of required) {
    if (!(await exists(path.join(packageRoot, rel)))) missingFromDisk.push(rel)
  }
  const uncovered = required.filter(rel => !ALWAYS_PACKED.has(rel)
    && !declared.some(entry => matchesFilesEntry(rel, entry)))

  const missingDeclared = []
  for (const entry of declared) {
    if (entry.includes('*')) continue
    if (!(await exists(path.join(packageRoot, entry)))) missingDeclared.push(entry)
  }

  let libOnDisk = 0
  try {
    const entries = await fsp.readdir(path.join(packageRoot, 'lib'), { withFileTypes: true })
    libOnDisk = entries.filter(entry => entry.isFile() && entry.name.endsWith('.js')).length
  } catch {
    libOnDisk = 0
  }
  const libDeclared = declared.filter(entry => /^lib\/[^/*]+\.js$/.test(entry)).length

  return {
    packageRoot,
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    engines: pkg.engines ?? {},
    declared,
    required,
    missingFromDisk,
    uncovered,
    missingDeclared,
    libOnDisk,
    libDeclared,
  }
}

/** Paths of everything `npm pack` would include, via a dry run (no tarball). */
export function packFileList(packageRoot) {
  const args = 'pack --dry-run --json --ignore-scripts'
  const options = { cwd: packageRoot, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }
  return new Promise((resolve, reject) => {
    const done = (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`npm pack --dry-run failed: ${(stderr || error.message || '').trim()}`))
        return
      }
      try {
        const start = stdout.indexOf('[')
        const parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout)
        resolve((parsed[0]?.files ?? []).map(file => normalizeRel(file.path)))
      } catch (parseError) {
        reject(new Error(`cannot parse npm pack JSON: ${parseError.message}`))
      }
    }
    // npm is a .cmd shim on Windows, which needs a shell; the command string is
    // composed only of literals, so there is nothing to escape.
    if (process.platform === 'win32') exec(`npm ${args}`, options, done)
    else execFile('npm', args.split(' '), options, done)
  })
}

/**
 * The CI guard: every file the code imports must appear in the tarball, and
 * every plain `files` entry must actually be packed. A `files` entry npm cannot
 * find is silently skipped, which is how an import ships a promise instead of a
 * module.
 * @param {{ packageRoot: string, packed: string[] }} input - dry-run file list.
 */
export async function auditPackedFiles({ packageRoot, packed }) {
  const layout = await auditLayout(packageRoot)
  const shipped = new Set(packed.map(normalizeRel))
  const missing = layout.required.filter(rel => !ALWAYS_PACKED.has(rel) && !shipped.has(rel))
  const notPacked = layout.declared.filter(entry => !entry.includes('*')
    && !ALWAYS_PACKED.has(entry)
    && !shipped.has(entry))
  return { ...layout, packed: [...shipped], missing, notPacked }
}

function readTarString(header, start, length) {
  return header.toString('utf8', start, start + length).replace(/\0.*$/s, '').trimEnd()
}

/**
 * Minimal ustar reader: only what a published npm tarball contains. Returns
 * regular files with their bytes, so hashes can be compared without unpacking
 * to disk.
 */
export function readTarEntries(buffer) {
  const data = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer
  const entries = []
  let offset = 0
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const size = Number.parseInt(readTarString(header, 124, 12), 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    offset += 512
    const fullName = normalizeRel(prefix ? `${prefix}/${name}` : name)
    if (type === '0' || type === '\0' || type === '7') {
      entries.push({ name: fullName.replace(/^package\//, ''), data: data.subarray(offset, offset + size) })
    }
    offset += Math.ceil(size / 512) * 512
  }
  return entries
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Compare the files of the installed copy with the published tarball for the
 * same version. Networks are optional: an unreachable registry degrades this
 * check to a warning with the command that would confirm it by hand.
 * @param {object} input - package directory, fetch implementation, timeout.
 */
export async function auditRegistry({ packageRoot, fetchImpl = globalThis.fetch, timeoutMs = 8000, profileName = null } = {}) {
  const pkg = await readPackageJson(packageRoot)
  const name = pkg.name ?? PACKAGE_NAME
  const version = pkg.version ?? '0.0.0'
  const registry = String(pkg.publishConfig?.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
  const metadataUrl = `${registry}/${name.replace('/', '%2F')}/${version}`
  const offlineFix = `npm view ${name}@${version} dist.tarball`

  if (typeof fetchImpl !== 'function') {
    return { status: 'warn', detail: ['no fetch implementation; registry comparison skipped'], fix: offlineFix }
  }
  try {
    const metaResponse = await fetchImpl(metadataUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!metaResponse.ok) throw new Error(`registry returned HTTP ${metaResponse.status}`)
    const meta = await metaResponse.json()
    const tarballUrl = meta?.dist?.tarball
    if (!tarballUrl) throw new Error('registry metadata has no dist.tarball')

    const tarResponse = await fetchImpl(tarballUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (!tarResponse.ok) throw new Error(`tarball returned HTTP ${tarResponse.status}`)
    const tarball = Buffer.from(await tarResponse.arrayBuffer())
    const published = new Map(readTarEntries(tarball).map(entry => [entry.name, sha256(entry.data)]))

    const missing = []
    const different = []
    let compared = 0
    for (const [file, digest] of published) {
      // package.json is rewritten by tooling on some installs; the version field
      // is checked by the layout audit instead of by byte equality.
      if (file === 'package.json') continue
      let local
      try {
        local = await fsp.readFile(path.join(packageRoot, file))
      } catch {
        missing.push(file)
        continue
      }
      compared += 1
      if (sha256(local) !== digest) different.push(file)
    }

    const extra = []
    for (const file of await listFilesRecursive(packageRoot)) {
      if (file === 'package.json') continue
      if (!published.has(file)) extra.push(file)
    }

    if (missing.length > 0 || different.length > 0) {
      const detail = []
      if (missing.length > 0) {
        detail.push(`${missing.length} published file(s) are missing from the installed copy:`)
        detail.push(...missing.slice(0, 8).map(file => `  ${file}`))
      }
      if (different.length > 0) {
        detail.push(`${different.length} file(s) differ from ${name}@${version}:`)
        detail.push(...different.slice(0, 8).map(file => `  ${file}`))
      }
      return {
        status: 'fail',
        detail,
        fix: 'this copy is not the published artifact; reinstall it from the registry:\n'
          + reinstallCommand(profileName, version)
          + '\n# if it came from a local tarball, rebuild that tarball and reinstall it instead',
      }
    }
    const detail = [`${compared} file(s) match ${name}@${version} by sha256`]
    if (extra.length > 0) detail.push(`${extra.length} local file(s) are not in the published tarball: ${extra.slice(0, 5).join(', ')}`)
    return { status: extra.length > 0 ? 'warn' : 'pass', detail }
  } catch (error) {
    return {
      status: 'warn',
      detail: [`registry comparison skipped: ${error?.message ?? error}`, 'offline is fine; the other checks still ran'],
      fix: offlineFix,
    }
  }
}

async function listFilesRecursive(root) {
  const found = []
  const walk = async dir => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) found.push(normalizeRel(path.relative(root, abs)))
    }
  }
  await walk(root)
  return found.sort()
}

/** Resolve `--profile web` to `<DSH_HOME>/profiles/web`; a path is used as-is. */
export function resolveProfileDir(profile, dshHome) {
  if (!profile) return null
  if (profile === '.' || profile === '..' || profile.includes('/') || profile.includes('\\')) {
    return path.resolve(profile)
  }
  return path.join(dshHome, 'profiles', profile)
}

/**
 * Infer the profile from a package path such as
 * `<DSH_HOME>/profiles/web/node_modules/@xiangyixie/dsh-superagent`.
 */
export function inferProfileDir(packageRoot) {
  const parts = path.resolve(packageRoot).split(path.sep)
  const index = parts.lastIndexOf('profiles')
  if (index < 0 || index + 1 >= parts.length) return null
  const name = parts[index + 1]
  if (!name || name === 'node_modules') return null
  return parts.slice(0, index + 2).join(path.sep)
}

function reinstallCommand(profileName, version) {
  return `dsh plugin --profile ${profileName ?? '<profile>'} add ${PACKAGE_NAME}@${version ?? '<version>'}`
}

function cleanCopyCommand(packageDir) {
  return process.platform === 'win32'
    ? `Remove-Item -Recurse -Force "${packageDir}"`
    : `rm -rf "${packageDir}"`
}

function check(id, title, status, detail = [], fix = null) {
  return { id, title, status, detail, fix }
}

function checkNodeEngine(layout, nodeVersion) {
  const range = layout.engines?.node
  if (!range) {
    return check('node-engine', 'Node version', 'warn', ['package.json declares no engines.node, so no minimum is enforced'])
  }
  if (satisfiesRange(range, nodeVersion)) {
    return check('node-engine', 'Node version', 'pass', [`v${nodeVersion} satisfies "${range}"`])
  }
  return check('node-engine', 'Node version', 'fail', [
    `installed Node is v${nodeVersion}, but package.json requires "${range}"`,
    'the host and this package are running on an unsupported Node; imports can fail at startup',
  ], `install Node ${range} (or newer) and run the host on it:\nnode --version`)
}

function checkFilesCoverage(layout, { profileName }) {
  const detail = []
  if (layout.uncovered.length > 0) {
    detail.push(`${layout.uncovered.length} imported file(s) are not matched by package.json "files":`)
    detail.push(...layout.uncovered.slice(0, 8).map(file => `  ${file}`))
    if (layout.uncovered.length > 8) detail.push(`  ... and ${layout.uncovered.length - 8} more`)
  }
  if (layout.missingFromDisk.length > 0) {
    detail.push(`${layout.missingFromDisk.length} imported file(s) do not exist on disk:`)
    detail.push(...layout.missingFromDisk.slice(0, 8).map(file => `  ${file}`))
  }
  if (detail.length === 0) {
    return check('package-files', 'Package files', 'pass', [
      `${layout.required.length} file(s) reachable from the entry points; all are shipped by "files"`,
    ])
  }
  const fixLines = []
  if (layout.uncovered.length > 0) {
    fixLines.push('add the missing entry to "files" in package.json, then pack and reinstall:')
    fixLines.push(...layout.uncovered.slice(0, 8).map(file => `  "${file}"`))
    fixLines.push('npm pack --dry-run --json')
  }
  if (layout.missingFromDisk.length > 0) {
    fixLines.push('restore the file from git, or reinstall a complete copy:')
    fixLines.push(reinstallCommand(profileName, layout.version))
  }
  return check('package-files', 'Package files', 'fail', detail, fixLines.join('\n'))
}

function checkInstalledCopy(layout, { profileName }) {
  if (layout.missingDeclared.length === 0 && layout.libDeclared <= layout.libOnDisk) {
    return check('installed-copy', 'Installed copy', 'pass', [
      `package.json ${layout.version ?? '(no version)'} declares ${layout.declared.length} packed file(s); `
      + `${layout.libOnDisk} lib file(s) on disk`,
    ])
  }
  const detail = [
    `package.json says version ${layout.version ?? '(none)'} and "files" lists ${layout.libDeclared} lib file(s), `
    + `but only ${layout.libOnDisk} are on disk`,
  ]
  if (layout.missingDeclared.length > 0) {
    detail.push(`${layout.missingDeclared.length} declared file(s) are absent:`)
    detail.push(...layout.missingDeclared.slice(0, 8).map(file => `  ${file}`))
    if (layout.missingDeclared.length > 8) detail.push(`  ... and ${layout.missingDeclared.length - 8} more`)
  }
  detail.push('this is what an interrupted install leaves behind: package.json is complete, the unpacked tree is not')
  return check('installed-copy', 'Installed copy', 'fail', detail, [
    'remove the partial copy and install it again:',
    cleanCopyCommand(layout.packageRoot),
    reinstallCommand(profileName, layout.version),
  ].join('\n'))
}

function checkSyntax(packageRoot, required, { profileName, version }) {
  return new Promise(resolve => {
    const files = required.filter(file => file.endsWith('.js'))
    const broken = []
    const verify = index => {
      if (index >= files.length) {
        if (broken.length === 0) {
          resolve(check('syntax', 'File syntax', 'pass', [`${files.length} shipped JavaScript file(s) parse`]))
          return
        }
        resolve(check('syntax', 'File syntax', 'fail', [
          `${broken.length} shipped file(s) cannot be parsed (truncated by a partial unpack or a broken build):`,
          ...broken.map(item => `  ${item.file}: ${item.reason}`),
        ], `reinstall a complete copy:\n${reinstallCommand(profileName, version)}`))
        return
      }
      const file = files[index]
      execFile(process.execPath, ['--check', path.join(packageRoot, file)], { timeout: 20_000 }, (error, _stdout, stderr) => {
        if (error) {
          const reason = String(stderr || error.message).split('\n').find(line => line.trim()) ?? 'parse error'
          broken.push({ file, reason: reason.replace(/^.*?Error:\s*/, '').trim() })
        }
        verify(index + 1)
      })
    }
    verify(0)
  })
}

async function checkTools(packageDir, expected, { profileName, version }) {
  const entry = path.join(packageDir, 'lib', 'index.js')
  let source
  try {
    source = await fsp.readFile(entry, 'utf8')
  } catch {
    return check('tools', 'Registered tools', 'fail', [
      `cannot read ${entry}`,
      'without the entry point the host mounts no tools at all',
    ], `reinstall a complete copy:\n${reinstallCommand(profileName, version)}`)
  }
  const names = readRegisteredTools(source)
  const missing = expected.filter(name => !names.includes(name))
  const extra = names.filter(name => !expected.includes(name))
  if (missing.length === 0 && extra.length === 0) {
    return check('tools', 'Registered tools', 'pass', [`${names.length}/${expected.length} expected tools are registered`])
  }
  const detail = [`registered ${names.length} of ${expected.length} expected tools`]
  if (missing.length > 0) detail.push(`missing: ${missing.join(', ')}`)
  if (extra.length > 0) detail.push(`unexpected: ${extra.join(', ')}`)
  return check('tools', 'Registered tools', 'fail', detail, [
    'this copy registers a different tool set than the version claims; reinstall it:',
    reinstallCommand(profileName, version),
  ].join('\n'))
}

async function checkPatchFile(packageDir, pkg, { profileName }) {
  const patchRel = pkg?.dsh?.bundle?.patch
  if (typeof patchRel !== 'string' || !patchRel.trim()) {
    return check('patch', 'Bundle patch', 'fail', [
      'package.json has no dsh.bundle.patch, so the host has no row to mount',
    ], `reinstall a complete copy:\n${reinstallCommand(profileName, pkg?.version)}`)
  }
  const file = path.join(packageDir, normalizeRel(patchRel))
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return check('patch', 'Bundle patch', 'fail', [
      `package.json points at ${patchRel}, but that file is not in the package`,
    ], `reinstall a complete copy:\n${reinstallCommand(profileName, pkg?.version)}`)
  }
  const namesPackage = text.includes(pkg?.name ?? PACKAGE_NAME)
  const inserts = /(^|\n)\s*-\s*insert:/.test(text)
  if (!inserts || !namesPackage) {
    return check('patch', 'Bundle patch', 'fail', [
      `${patchRel} does not insert a row for ${pkg?.name ?? PACKAGE_NAME}`,
      'without the row the plugin is installed but never mounted',
    ], `reinstall a complete copy:\n${reinstallCommand(profileName, pkg?.version)}`)
  }
  return check('patch', 'Bundle patch', 'pass', [`${patchRel} inserts the plugin row at profile scope`])
}

async function checkProfile(profileDir, profileName) {
  if (!(await exists(profileDir))) {
    return check('profile', 'DSH profile', 'fail', [
      `no profile at ${profileDir}`,
      'nothing is installed there, so no superagent tool can exist in it',
    ], `${reinstallCommand(profileName, null)}\n# if DSH_HOME points elsewhere, pass the full path: --profile "<path>"`)
  }
  const detail = []
  try {
    await readPackageJson(profileDir)
  } catch (error) {
    return check('profile', 'DSH profile', 'fail', [String(error.message)], [
      'make the profile readable, then reinstall the plugin:',
      reinstallCommand(profileName, null),
    ].join('\n'))
  }
  const hasNodeModules = await exists(path.join(profileDir, 'node_modules'))
  const hasRoot = await exists(path.join(profileDir, 'cordis.yml'))
  if (!hasNodeModules) {
    detail.push('node_modules is missing, so no plugin copy is installed')
  }
  if (!hasRoot) {
    detail.push('cordis.yml is missing; the host composes an empty root, which usually still works')
  }
  if (!hasNodeModules) {
    return check('profile', 'DSH profile', 'fail', detail, [
      'install the plugin into this profile:',
      reinstallCommand(profileName, null),
    ].join('\n'))
  }
  return check('profile', 'DSH profile', hasRoot ? 'pass' : 'warn', detail.length > 0
    ? detail
    : [`${profileDir} has package.json, cordis.yml, and node_modules`])
}

async function checkBundle(profileDir, packageName, profileName, version) {
  try {
    const pkg = await readPackageJson(profileDir)
    const bundles = pkg?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(packageName)) {
      return check('bundle', 'Profile registration', 'pass', [
        `dsh.profile.bundles includes ${packageName}`,
      ])
    }
    return check('bundle', 'Profile registration', 'fail', [
      `${packageName} is not in dsh.profile.bundles, so its cordis.patch.yml is never loaded`,
      'the installed files are fine; the profile simply does not mount them',
    ], `${reinstallCommand(profileName, version)}\n# then confirm the row appears:\ndsh --profile ${profileName ?? '<profile>'} --dump-config`)
  } catch (error) {
    return check('bundle', 'Profile registration', 'fail', [String(error.message)])
  }
}

async function checkVersionDrift(packageRoot, targetDir, profileName) {
  if (path.resolve(packageRoot) === path.resolve(targetDir)) return null
  try {
    const checkout = await readPackageJson(packageRoot)
    const installed = await readPackageJson(targetDir)
    if (checkout.version === installed.version) return null
    return check('version', 'Version match', 'warn', [
      `installed copy is ${installed.version}, this checkout is ${checkout.version}`,
      `${targetDir} did not come from this source tree; reinstall it before trusting a fix here`,
    ], reinstallCommand(profileName, checkout.version))
  } catch {
    return null
  }
}

/**
 * Run every check and return structured results. Rendering is separate so the
 * CLI and the tests see the same verdicts.
 * @param {object} [options] - paths, offline switch, and injectable fetch.
 */
export async function runDoctor(options = {}) {
  const packageRoot = path.resolve(options.packageRoot ?? process.cwd())
  const dshHome = options.dshHome ?? process.env.DSH_HOME?.trim() ?? path.join(os.homedir(), '.dsh')
  const profileDir = options.profile === undefined
    ? inferProfileDir(packageRoot)
    : resolveProfileDir(options.profile, dshHome)
  const profileName = profileDir ? path.basename(profileDir) : null
  const nodeVersion = options.nodeVersion ?? process.versions.node

  let pkg
  try {
    pkg = await readPackageJson(packageRoot)
  } catch (error) {
    return {
      packageRoot,
      profileDir,
      profileName,
      targetDir: packageRoot,
      version: null,
      nodeVersion,
      ok: false,
      checks: [check('package', 'Package', 'fail', [String(error.message)], 'run this command from an installed copy or pass --package <dir>')],
    }
  }
  const packageName = pkg.name ?? PACKAGE_NAME
  const candidate = profileDir
    ? path.join(profileDir, 'node_modules', ...packageName.split('/'))
    : null
  const installedDir = candidate && await exists(candidate) ? candidate : null
  const targetDir = installedDir ?? packageRoot
  const targetPkg = installedDir ? await readPackageJson(installedDir).catch(() => pkg) : pkg

  const layout = await auditLayout(targetDir)
  const checks = []
  checks.push(checkNodeEngine(layout, nodeVersion))
  checks.push(checkFilesCoverage(layout, { profileName }))
  checks.push(checkInstalledCopy(layout, { profileName }))
  checks.push(await checkSyntax(targetDir, layout.required, { profileName, version: targetPkg.version }))
  if (options.online === false) {
    checks.push(check('registry', 'Registry match', 'warn', ['registry comparison skipped (--offline)'], `npm view ${packageName}@${targetPkg.version} dist.tarball`))
  } else {
    const registry = await auditRegistry({
      packageRoot: targetDir,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.registryTimeoutMs,
      profileName,
    })
    checks.push(check('registry', 'Registry match', registry.status, registry.detail, registry.fix ?? null))
  }
  checks.push(await checkTools(targetDir, options.expectedTools ?? TOOL_NAMES, { profileName, version: targetPkg.version }))
  checks.push(await checkPatchFile(targetDir, targetPkg, { profileName }))
  if (profileDir) {
    checks.push(await checkProfile(profileDir, profileName))
    checks.push(await checkBundle(profileDir, packageName, profileName, targetPkg.version))
    const drift = await checkVersionDrift(packageRoot, targetDir, profileName)
    if (drift) checks.push(drift)
  } else {
    checks.push(check('profile', 'DSH profile', 'warn', [
      'no profile given, so profile wiring was not checked',
      'run again with --profile <name> (for example: --profile web)',
    ]))
  }
  const counts = { pass: 0, warn: 0, fail: 0 }
  for (const item of checks) counts[item.status] += 1
  return {
    packageRoot,
    profileDir,
    profileName,
    targetDir,
    version: targetPkg.version ?? null,
    nodeVersion,
    checks,
    counts,
    ok: counts.fail === 0,
  }
}

const STATUS_COLOR = { pass: '32', warn: '33', fail: '31' }
const STATUS_LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }

/**
 * Human report: one block per check, then the exact commands that fix what is
 * broken. Commands sit on their own lines so they can be copied verbatim.
 */
export function renderReport(result, { color = false } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)
  const lines = [
    `dsh-superagent doctor${result.version ? ` ${result.version}` : ''}`,
    `node v${result.nodeVersion} · ${process.platform}`,
    `package: ${result.targetDir}`,
    result.profileDir
      ? `profile:  ${result.profileDir}`
      : 'profile:  not specified (pass --profile <name> to check a DSH profile)',
    '',
  ]
  for (const item of result.checks) {
    lines.push(`${paint(STATUS_COLOR[item.status], `[${STATUS_LABEL[item.status]}]`)} ${item.title}`)
    for (const detail of item.detail ?? []) lines.push(`       ${detail}`)
    if (item.fix) {
      lines.push('       fix:')
      for (const fixLine of item.fix.split('\n')) lines.push(`       ${fixLine}`)
    }
  }
  const { pass, warn, fail } = result.counts
  lines.push('', `${fail} failed, ${warn} warning(s), ${pass} passed`)
  lines.push(fail === 0
    ? 'no blocking problem found: this copy matches what it claims to be'
    : 'blocking checks failed; run the fix lines above, then re-run doctor')
  return lines.join('\n')
}
