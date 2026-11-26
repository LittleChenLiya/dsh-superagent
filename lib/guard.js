/**
 * The worker safety guard: a path and command policy enforced on the host's
 * tool-call pipeline for superagent children only.
 *
 * The host runs every tool call through `tools/pre-execute` and its monotonic
 * `ctx.tools.guard()` layer. A child agent inherits the session's filesystem and
 * credentials, so this module is the one place that decides whether a worker may
 * touch a path or run a command. It is deliberately a separate file with no
 * host imports: `lib/index.js` registers the hook and `lib/orchestrator.js`
 * only records the outcome on the run.
 *
 * Design notes that are not obvious from the code:
 * - Deny rules win over allow roots. Allowing a broader workspace never opens
 *   `~/.ssh`, `.git/config`, or a system directory for writing.
 * - A path is checked twice: lexically (so a target that does not exist yet is
 *   still caught) and through `realpath` on its deepest existing ancestor (so a
 *   symlink inside the workspace cannot smuggle a write outside it).
 * - Commands are parsed, not pattern-blocked wholesale. `rm -rf build` stays a
 *   normal build step; `rm -rf /`, `rm -rf ~`, and `rm -rf .` do not.
 * - An explicit `guard.allowCommands` entry is the only way through a denial,
 *   and every use of one is recorded on the run.
 *
 * @module dsh-superagent/guard
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Credential locations that are never readable or writable by a worker. */
const CREDENTIAL_NAMES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.git-credentials',
  '.docker/config.json',
  '.kube/config',
  '.config/gcloud',
  '.config/gh/hosts.yml',
  '.azure',
]

/** System locations that a worker may read but never write. */
const WINDOWS_SYSTEM_WRITE = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
]

const POSIX_SYSTEM_WRITE = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/System',
  '/Library',
  '/Applications',
]

/**
 * Commands that are destructive regardless of their target. Each rule is a
 * named policy decision so a report can say which rule stopped the call.
 */
const HARD_COMMAND_RULES = [
  {
    id: 'cmd/disk-format',
    reason: 'formats or repartitions a disk or volume',
    test: text => /\b(mkfs(\.\w+)?|wipefs|diskpart|clear-disk|format-volume)\b/i.test(text)
      || /\bformat(\.com)?\s+[a-z]:/i.test(text)
      || /\bdd\b[^|;&]*\bof=\/dev\/(sd|hd|nvme|disk|mmcblk)\w*/i.test(text),
  },
  {
    id: 'cmd/system-scheduler',
    reason: 'changes a system-wide scheduled task, service, or login item',
    test: text => /\bschtasks(\.exe)?\s+\/(create|change|delete|run)\b/i.test(text)
      || /\b(register|set|new|unregister)-scheduledtask\b/i.test(text)
      || /\bcrontab\s+[^|;&]*-r\b/i.test(text)
      || /\bsystemctl\s+(enable|disable|mask|unmask)\b/i.test(text)
      || /\blaunchctl\s+(load|unload|bootstrap|bootout|enable|disable)\b/i.test(text)
      || /\bsc(\.exe)?\s+(create|delete|config)\b/i.test(text),
  },
  {
    id: 'cmd/system-registry',
    reason: 'writes a machine-wide registry or boot configuration key',
    test: text => /\breg(\.exe)?\s+(add|delete|import)\b[^|;&]*\bHK(LM|EY_LOCAL_MACHINE|CR|EY_CLASSES_ROOT)\b/i.test(text)
      || /\breg(\.exe)?\s+(add|delete|import)\b[^|;&]*\\Run\b/i.test(text)
      || /\b(set|new|remove)-itemproperty\b[^|;&]*\bHK(LM|EY_LOCAL_MACHINE|CR|EY_CLASSES_ROOT)\b/i.test(text),
  },
  {
    id: 'cmd/permission-nuke',
    reason: 'grants world-writable access or replaces ownership of a system path',
    test: text => /\bchmod\s+(-[a-z]*r[a-z]*\s+)?(777|a\+rwx)\s+\/(\s|$)/i.test(text)
      || /\bchown\s+-[a-z]*r[a-z]*\s+\S+\s+\/(\s|$)/i.test(text)
      || /\bicacls\b[^|;&]*\/(grant|setowner)\b[^|;&]*\b(everyone|users)\b[^|;&]*\/t\b/i.test(text),
  },
]

/** Absolute system locations used to stop a command that writes through a variable. */
const SYSTEM_WRITE_MARKERS = [
  /[a-z]:[\\/]windows[\\/]/i,
  /[a-z]:[\\/]program files( \(x86\))?[\\/]/i,
  /[a-z]:[\\/]programdata[\\/]/i,
  /%systemroot%/i,
  /%programfiles%/i,
  /%windir%/i,
  /\$env:(systemroot|windir|programfiles)\b/i,
  /(^|[\s"'])\/etc\//,
  /(^|[\s"'])\/usr\//,
  /(^|[\s"'])\/bin\//,
  /(^|[\s"'])\/sbin\//,
  /(^|[\s"'])\/boot\//,
  /(^|[\s"'])\/System\//,
  /(^|[\s"'])\/Library\//,
]

/** Credential fragments that make a command an obvious credential read. */
const CREDENTIAL_MARKERS = [
  /(^|[\s"'/\\])\.ssh[\\/]/i,
  /(^|[\s"'/\\])\.aws[\\/]/i,
  /(^|[\s"'/\\])\.gnupg[\\/]/i,
  /(^|[\s"'/\\])\.npmrc\b/i,
  /(^|[\s"'/\\])\.netrc\b/i,
  /(^|[\s"'/\\])\.git-credentials\b/i,
  /(^|[\s"'/\\])\.kube[\\/]config\b/i,
  /(^|[\s"'/\\])\.docker[\\/]config\.json\b/i,
  /(^|[\s"'/\\])\.config[\\/]gcloud\b/i,
  /\bid_(rsa|dsa|ecdsa|ed25519)\b/i,
]

/** `.git/config` and `.git/hooks` can run code on the next git command. */
const GIT_CONTROL_SEGMENTS = new Set(['config', 'hooks'])

const MAX_DETAIL = 240

const READ = 'filesystem.read'
const WRITE = 'filesystem.write'
const EXECUTE = 'shell.execute'
const NETWORK = 'network'
const ABSTRACT_PERMISSIONS = new Set([READ, WRITE, EXECUTE, NETWORK])

/** Abstract aliases accepted from plans and permission scopes. */
const PERMISSION_ALIASES = {
  read: READ,
  file: READ,
  'file.read': READ,
  'fs.read': READ,
  readfile: READ,
  'workspace.read': READ,
  write: WRITE,
  'file.write': WRITE,
  'fs.write': WRITE,
  writefile: WRITE,
  'workspace.write': WRITE,
  edit: WRITE,
  create: WRITE,
  delete: WRITE,
  remove: WRITE,
  move: WRITE,
  copy: WRITE,
  shell: EXECUTE,
  command: EXECUTE,
  execute: EXECUTE,
  net: NETWORK,
  http: NETWORK,
  fetch: NETWORK,
  web: NETWORK,
  browser: NETWORK,
  'network.access': NETWORK,
  'network.request': NETWORK,
}

/** Host tools whose effects fit the abstract execution categories. */
const READ_TOOLS = new Set([
  'read', 'read_file', 'readfile', 'read_image',
  'list', 'list_files', 'list_directory', 'list_dir', 'ls', 'tree',
  'search_files', 'file_search', 'find', 'find_files', 'glob',
  'grep', 'ripgrep', 'code_search', 'workspace_search',
])
const WRITE_TOOLS = new Set([
  'write', 'write_file', 'writefile', 'edit', 'edit_file', 'multiedit',
  'create', 'create_file', 'create_directory', 'mkdir',
  'delete', 'delete_file', 'remove', 'remove_file',
  'move', 'move_file', 'copy', 'copy_file', 'rename', 'rename_file',
  'apply_patch', 'str_replace_editor', 'notebookedit',
])
const SHELL_TOOLS = new Set([
  'bash', 'pwsh', 'powershell', 'terminal', 'terminal_send', 'run_command',
  'shell', 'exec', 'execute', 'execute_command', 'exec_command',
])
const NETWORK_TOOLS = new Set([
  'web', 'web_search', 'websearch', 'search_web', 'browser', 'browser_use',
  'http', 'http_request', 'fetch', 'web_fetch', 'curl', 'wget', 'download',
])

/** Normalize one abstract permission, retaining namespace wildcards. */
function permissionName(value) {
  const name = String(value ?? '').trim().toLowerCase()
  return PERMISSION_ALIASES[name] ?? name
}

/** Missing lists are unrestricted; present lists are normalized and deduplicated. */
function permissionList(value) {
  if (value === undefined || value === null) return null
  const entries = Array.isArray(value) ? value : [value]
  return [...new Set(entries
    .filter(entry => typeof entry === 'string')
    .map(permissionName)
    .filter(Boolean)
    .flatMap(name => {
      if (ABSTRACT_PERMISSIONS.has(name) || name === '*' || /^(filesystem|shell|network)\.\*$/.test(name)) return [name]
      const mapped = toolPermissions(name, {})
      return mapped.length > 0 ? mapped : [name]
    }))]
}

function permissionMatches(patterns, permission) {
  return patterns.some(pattern => pattern === '*'
    || pattern === permission
    || pattern === `${permission.split('.')[0]}.*`)
}

/** Copy only the contract fields the guard needs, accepting opaque runtime metadata. */
function normalizeExecutionContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null
  const scope = contract.permissionScope && typeof contract.permissionScope === 'object'
    ? contract.permissionScope
    : {}
  return {
    permissionScope: {
      tools: permissionList(scope.tools),
      allow: permissionList(scope.allow),
      deny: permissionList(scope.deny) ?? [],
      approvalMode: scope.approvalMode ?? null,
    },
    runtime: contract.runtime ?? null,
    planDigest: contract.planDigest ?? null,
  }
}

/** Map common host names (including namespaced variants) to abstract permissions. */
function toolPermissions(name, args) {
  const full = String(name ?? '').trim().toLowerCase().replaceAll('-', '_')
  const short = full.split(/(?:[.:/\\]+|__)/).filter(Boolean).at(-1) ?? full
  if (short === 'search') return [READ, NETWORK]
  if (short === 'str_replace_editor' && args?.command === 'view') return [READ]
  if (READ_TOOLS.has(full) || READ_TOOLS.has(short)) return [READ]
  if (WRITE_TOOLS.has(full) || WRITE_TOOLS.has(short)) return [WRITE]
  if (SHELL_TOOLS.has(full) || SHELL_TOOLS.has(short)) return [EXECUTE]
  if (NETWORK_TOOLS.has(full) || NETWORK_TOOLS.has(short)
    || /^(web|browser|http|fetch)_/.test(short)) return [NETWORK]
  return []
}

/** Contract checks tighten global policy and cannot be overridden by it. */
function checkExecutionContract(contract, name, args) {
  if (!contract) return null
  const permissions = toolPermissions(name, args)
  const scope = contract.permissionScope
  if (permissions.length === 0) {
    const allowed = scope.tools ?? scope.allow
    if (allowed !== null && !permissionMatches(allowed, '*')) {
      return { blocked: true, rule: 'contract/tool-not-approved',
        reason: `${name || 'this tool'} is outside the approved permission scope`, detail: truncate(name) }
    }
    return null
  }
  // A shell has a primary shell.execute category, but read/write denials also
  // close this generic route to the filesystem.
  const denialPermissions = permissions.includes(EXECUTE) ? [READ, WRITE, EXECUTE] : permissions
  const denied = denialPermissions.find(permission => permissionMatches(scope.deny, permission))
  if (denied) {
    return {
      blocked: true,
      rule: 'contract/permission-denied',
      reason: `the execution contract denies ${denied}, required by ${name || 'this tool'}`,
      detail: truncate(name),
    }
  }
  for (const field of ['tools', 'allow']) {
    const allowed = scope[field]
    if (allowed === null) continue
    const missing = permissions.find(permission => !permissionMatches(allowed, permission))
    if (missing) {
      return {
        blocked: true,
        rule: 'contract/tool-not-allowed',
        reason: `${name || 'this tool'} requires ${missing}, outside permissionScope.${field}`,
        detail: truncate(name),
      }
    }
  }
  return null
}

/** True when `target` is `root` or lies below it. */
function contained(root, target, platform) {
  const P = platform === 'win32' ? path.win32 : path.posix
  const normalize = value => {
    const normalized = P.normalize(value)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const r = normalize(root)
  const t = normalize(target)
  if (r === t) return true
  const relative = P.relative(r, t)
  return relative !== '' && !relative.startsWith('..') && !P.isAbsolute(relative)
}

/** True when the path is a filesystem root (`C:\` or `/`). */
function isFilesystemRoot(target, platform) {
  const P = platform === 'win32' ? path.win32 : path.posix
  return P.parse(target).root === target
}

/** Expand `~`, `%VAR%`, and `$VAR` without treating an unknown variable as a path. */
function expandPath(value, { platform, homedir, env }) {
  const P = platform === 'win32' ? path.win32 : path.posix
  let expanded = value
  if (expanded === '~' || /^~[\\/]/.test(expanded)) expanded = P.join(homedir, expanded.slice(1))
  if (platform === 'win32') {
    expanded = expanded.replace(/%([^%]+)%/g, (match, name) => {
      const key = Object.keys(env ?? {}).find(candidate => candidate.toLowerCase() === name.toLowerCase())
      return key === undefined ? match : env[key]
    })
  } else {
    expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
      const name = braced ?? bare
      return env?.[name] ?? match
    })
  }
  return expanded
}

/**
 * Resolve a path from a tool argument against the child's workspace.
 * @returns {string | null} an absolute normalized path, or null when the value
 * is not a path at all (a flag, a URL, a null device, or empty).
 */
function resolveTarget(raw, { cwd, platform, homedir, env }) {
  const P = platform === 'win32' ? path.win32 : path.posix
  let value = String(raw ?? '').trim()
  if (!value) return null
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim()
  }
  if (!value || value === '-' || /^(nul|\/dev\/null)$/i.test(value)) return null
  // A lone shell operator (`^`, `&`, `=`, `>`) is not a path. Raw command
  // scanning can surface one when PowerShell or a quoted script body contains
  // it; resolving that against cwd used to produce a bogus `C:\^` target.
  if (/^[^\w./\\~:$@%+()[\]{}'-]+$/.test(value)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null
  value = expandPath(value, { platform, homedir, env })
  // An unresolved variable is not a literal path. Treating it as one would
  // resolve it inside the workspace and silently allow a write elsewhere.
  if (/%[^%]+%|\$\{?[A-Za-z_]/.test(value)) return null
  // `path.win32.isAbsolute('/x')` is true but means "on the current drive".
  // Resolve it against the child workspace so the compared path is real.
  const driveRelative = platform === 'win32' && /^[\\/]/.test(value) && !/^[\\/]{2}/.test(value)
  if (driveRelative || !P.isAbsolute(value)) {
    if (!cwd) return null
    value = P.resolve(cwd, value)
  }
  const normalized = P.normalize(value)
  if (isFilesystemRoot(normalized, platform)) return normalized
  return normalized.replace(/[\\/]+$/, '') || normalized
}

/**
 * Resolve the deepest existing ancestor so a symlink cannot hide a target.
 * A path that does not exist yet is returned unchanged.
 */
function realPathOf(target, platform) {
  const P = platform === 'win32' ? path.win32 : path.posix
  let current = target
  const tail = []
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current)
      const complete = tail.length === 0 ? real : P.join(real, ...tail.reverse())
      return P.normalize(complete)
    } catch {
      const parent = P.dirname(current)
      if (parent === current) return target
      tail.push(P.basename(current))
      current = parent
    }
  }
}

/** True for `*`, `./*`, `**`, or any target that means "everything in a directory". */
function isWholeDirectoryGlob(target) {
  return /^(\.?[\\/])?(\*{1,2}|\.\*)$/.test(target.trim())
}

/** Match a path against one compiled path rule. */
function pathRuleMatches(rule, target, mode, context) {
  if (!rule.modes.includes(mode)) return false
  if (rule.kind === 'git-control') {
    const segments = target.split(/[\\/]+/).map(segment => segment.toLowerCase())
    const index = segments.lastIndexOf('.git')
    return index >= 0 && GIT_CONTROL_SEGMENTS.has(segments[index + 1] ?? '')
  }
  return rule.roots.some(root => contained(root, target, context.platform))
}

/**
 * Deny rules that apply to one path. The temp directory is checked after
 * credentials and git control but before the system rule: on service accounts
 * `%TEMP%` can live under `C:\Windows\TEMP`, and a worker must still be able to
 * write its scratch files there.
 */
function pathDenial(policy, resolved, mode, context) {
  const real = realPathOf(resolved, context.platform)
  for (const rule of policy.pathRules) {
    if (rule.id === 'path/system-directory') continue
    if (pathRuleMatches(rule, resolved, mode, context) || pathRuleMatches(rule, real, mode, context)) {
      return { rule: rule.id, reason: `${rule.reason}: ${resolved}` }
    }
  }
  if (mode === 'write' && context.tmpdir && contained(context.tmpdir, resolved, context.platform)) {
    return null
  }
  for (const rule of policy.pathRules) {
    if (rule.id !== 'path/system-directory') continue
    if (pathRuleMatches(rule, resolved, mode, context) || pathRuleMatches(rule, real, mode, context)) {
      return { rule: rule.id, reason: `${rule.reason}: ${resolved}` }
    }
  }
  return null
}

/** Evaluate one path for one mode and return a denial or null. */
function checkPath(policy, resolved, mode, context) {
  const real = realPathOf(resolved, context.platform)
  const denial = pathDenial(policy, resolved, mode, context)
  if (denial) return denial
  if (mode !== 'write') return null
  if (isFilesystemRoot(resolved, context.platform)) {
    return { rule: 'path/system-directory', reason: `refuses to write to the filesystem root: ${resolved}` }
  }
  const roots = context.allowRoots
  const lexicalInside = roots.some(root => contained(root, resolved, context.platform))
  const realInside = roots.some(root => contained(realPathOf(root, context.platform), real, context.platform))
  if (lexicalInside && realInside) return null
  const shown = roots.slice(0, 3).join(', ') + (roots.length > 3 ? ', …' : '')
  return {
    rule: 'path/outside-allowlist',
    reason: `${resolved} is outside every allowed write root (${shown || 'none'})`,
  }
}

/** Whether a destructive delete target is safe: strictly inside one allow root. */
function destructiveTargetVerdict(policy, target, context) {
  const resolved = resolveTarget(target, context)
  if (!resolved) {
    // A literal relative name (`build`, `node_modules`) is safe; a variable or
    // an unresolved expression is refused because its scope cannot be proven.
    return /[*?$%]/.test(target)
      ? { rule: 'cmd/recursive-force-delete', reason: `the delete target "${target}" cannot be proven to stay inside the workspace` }
      : null
  }
  if (isWholeDirectoryGlob(target)) {
    return { rule: 'cmd/recursive-force-delete', reason: `the delete target "${target}" would wipe an entire allowed directory` }
  }
  const denied = pathDenial(policy, resolved, 'write', context)
  if (denied) return denied
  if (isFilesystemRoot(resolved, context.platform)) {
    return { rule: 'cmd/recursive-force-delete', reason: `refuses to delete a filesystem root: ${resolved}` }
  }
  const home = context.platform === 'win32' ? context.homedir.toLowerCase() : context.homedir
  const targetPath = context.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (home === targetPath) {
    return { rule: 'cmd/recursive-force-delete', reason: `refuses to delete the home directory: ${resolved}` }
  }
  // Deny when the target contains an allowed root: deleting `.` or `..` takes
  // the workspace with it, even though the target itself looks local.
  if (context.allowRoots.some(root => contained(resolved, root, context.platform))) {
    return { rule: 'cmd/recursive-force-delete', reason: `the delete target contains an allowed write root: ${resolved}` }
  }
  if (!context.allowRoots.some(root => contained(root, resolved, context.platform))) {
    return { rule: 'cmd/recursive-force-delete', reason: `${resolved} is outside every allowed write root` }
  }
  return null
}

/** Split a command line into independently evaluated segments, ignoring operators inside quotes. */
function segmentsOf(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      current += char
      if (char === quote && command[index - 1] !== '\\') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const pair = command.slice(index, index + 2)
    if (pair === '&&' || pair === '||') {
      segments.push(current)
      current = ''
      index += 1
      continue
    }
    if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map(segment => segment.trim()).filter(Boolean)
}

/** Character ranges that sit inside a single- or double-quoted run. */
function quotedRanges(text) {
  const ranges = []
  let quote = null
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === quote && text[index - 1] !== '\\') {
        ranges.push([start, index + 1])
        quote = null
      }
    } else if (char === '"' || char === "'") {
      quote = char
      start = index
    }
  }
  if (quote) ranges.push([start, text.length])
  return ranges
}

/** Tokenize one segment, keeping quoted strings as one token. */
function tokensOf(segment) {
  const tokens = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

function isFlagToken(token, platform) {
  if (!token) return true
  if (token.startsWith('-')) return true
  if (/^[0-9]?[>&]/.test(token)) return true
  if (platform === 'win32' && /^\/[a-z?]{1,2}$/i.test(token)) return true
  return false
}

/** Extract candidate write targets from one shell segment. */
function writeTargetsOf(segment, platform) {
  const targets = []
  const push = value => {
    if (value && !isFlagToken(value, platform)) targets.push(value)
  }
  // `> path`, `>> path`, but not `2>&1`, and never a `>` that lives inside a
  // quoted script body such as `node -e "const f = a => a + 1"`.
  const quoted = quotedRanges(segment)
  const insideQuotes = index => quoted.some(([start, end]) => index >= start && index < end)
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] !== '>' || insideQuotes(index)) continue
    if (segment[index - 1] === '&') continue
    const match = /^>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(segment.slice(index))
    if (match) push(match[1] ?? match[2] ?? match[3])
  }
  for (const match of segment.matchAll(/\btee\s+(?:-a\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)) {
    push(match[1] ?? match[2] ?? match[3])
  }
  for (const match of segment.matchAll(/\b(?:set-content|add-content|out-file|new-item)\b/gi)) {
    const after = segment.slice(match.index ?? 0)
    const named = /-(?:path|filepath|literalpath)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(after)
    if (named) {
      push(named[1] ?? named[2] ?? named[3])
      continue
    }
    const tokens = tokensOf(after).slice(1).filter(token => !isFlagToken(token, platform))
    if (tokens.length > 0) push(tokens.at(-1))
  }
  for (const match of segment.matchAll(/\[io\.file\]::(?:writealltext|writeallbytes|appendalltext|appendallbytes)\(\s*("([^"]+)"|'([^']+)')/gi)) {
    push(match[2] ?? match[3])
  }
  const tokens = tokensOf(segment)
  const head = (tokens[0] ?? '').toLowerCase()
  if (['cp', 'copy', 'install', 'robocopy', 'xcopy', 'rsync', 'ln'].includes(head)) {
    const positional = tokens.slice(1).filter(token => !isFlagToken(token, platform))
    if (positional.length >= 2) push(positional.at(-1))
  }
  if (['mv', 'move', 'move-item', 'rename-item', 'rename'].includes(head)) {
    // Moving away from a path modifies it too, so both ends are checked.
    for (const token of tokens.slice(1)) push(token)
  }
  if (['touch', 'mkdir', 'md', 'new-item'].includes(head)) {
    for (const token of tokens.slice(1)) push(token)
  }
  if (['rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item'].includes(head)) {
    for (const token of tokens.slice(1)) push(token)
  }
  if (['chmod', 'chown', 'chattr', 'attrib', 'icacls'].includes(head)) {
    for (const token of tokens.slice(1)) {
      if (!/^[0-7]{3,4}$/.test(token) && !/^[+=-][rwxXst]+$/.test(token)) push(token)
    }
  }
  return targets
}

/** Extract delete targets from a recursive/forced delete segment. */
function recursiveDeleteTargets(segment, platform) {
  const tokens = tokensOf(segment)
  const head = (tokens[0] ?? '').toLowerCase()
  if (head === 'rm') {
    const flags = tokens.slice(1).filter(token => token.startsWith('-')).join(' ')
    const recursive = /(^|\s)-[a-z]*r/i.test(flags) || /--recursive\b/i.test(flags)
    const force = /(^|\s)-[a-z]*f/i.test(flags) || /--force\b/i.test(flags)
    if (recursive && force) {
      return tokens.slice(1).filter(token => !isFlagToken(token, platform))
    }
    return null
  }
  if (head === 'remove-item') {
    const recursive = tokens.some(token => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(token) || token === '-recurse')
    const force = tokens.some(token => /^-fo?r?c?e?$/i.test(token) || token === '-force')
    if (recursive && force) {
      const named = /-(?:path|literalpath)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(segment)
      if (named) return [named[1] ?? named[2] ?? named[3]]
      const values = tokens.slice(1).filter(token => !isFlagToken(token, platform) && !/^-(path|literalpath)$/i.test(token))
      return values
    }
    return null
  }
  if (['del', 'erase', 'rd', 'rmdir'].includes(head)) {
    const recursive = tokens.some(token => /^\/s$/i.test(token))
    if (recursive) {
      const values = tokens.slice(1).filter(token => !isFlagToken(token, platform))
      // `del /s /q` without a target deletes the current directory contents.
      return values.length > 0 ? values : ['.']
    }
  }
  return null
}

/** Compile one user-supplied command pattern, ignoring an invalid regex. */
function compilePattern(entry, index, prefix, warn) {
  const raw = typeof entry === 'string' ? { pattern: entry } : entry
  if (!raw || typeof raw.pattern !== 'string' || raw.pattern.length === 0) return null
  try {
    return {
      id: `${prefix}/${String(raw.id ?? index + 1).replace(/[^a-zA-Z0-9._-]/g, '-')}`,
      pattern: new RegExp(raw.pattern, 'i'),
      reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : null,
    }
  } catch (error) {
    warn(`guard: ignoring invalid ${prefix} pattern ${JSON.stringify(raw.pattern)}: ${error?.message ?? error}`)
    return null
  }
}

/** Resolve user config and the built-in defaults into one policy. */
function resolvePolicy({ config, cwd, homedir, platform, env, tmpdir, warn }) {
  const P = platform === 'win32' ? path.win32 : path.posix
  const raw = config && typeof config === 'object' ? config : {}
  const credentials = CREDENTIAL_NAMES.map(name => P.join(homedir, ...name.split('/')))
  const systemWrite = platform === 'win32' ? WINDOWS_SYSTEM_WRITE : POSIX_SYSTEM_WRITE
  const extraDeny = (Array.isArray(raw.denyPaths) ? raw.denyPaths : [])
    .map(entry => resolveTarget(entry, { cwd, platform, homedir, env }))
    .filter(Boolean)
  const extraRoots = (Array.isArray(raw.allowWriteRoots) ? raw.allowWriteRoots : [])
    .map(entry => resolveTarget(entry, { cwd, platform, homedir, env }))
    .filter(Boolean)
  const baseRoots = [P.normalize(tmpdir), ...extraRoots]
    .filter(Boolean)
    .map(entry => P.normalize(entry))
  return {
    baseRoots: [...new Set(baseRoots)],
    pathRules: [
      { id: 'path/credentials', kind: 'roots', modes: ['read', 'write'], roots: credentials, reason: 'credential store' },
      { id: 'path/git-control', kind: 'git-control', modes: ['read', 'write'], roots: [], reason: 'repository control data' },
      {
        id: 'path/system-directory',
        kind: 'roots',
        modes: ['write'],
        roots: systemWrite,
        reason: 'system directory',
      },
      { id: 'path/user-denied', kind: 'roots', modes: ['read', 'write'], roots: extraDeny, reason: 'path denied by guard.denyPaths' },
    ],
    hardCommands: HARD_COMMAND_RULES,
    denyCommands: (Array.isArray(raw.denyCommands) ? raw.denyCommands : [])
      .map((entry, index) => compilePattern(entry, index, 'cmd/custom', warn))
      .filter(Boolean),
    allowCommands: (Array.isArray(raw.allowCommands) ? raw.allowCommands : [])
      .map((entry, index) => compilePattern(entry, index, 'allow', warn))
      .filter(Boolean),
    // Browser and desktop tools registered by the runtime-control layer belong
    // to the parent session. A worker that calls them would be driving the
    // user's screen behind the parent's back, so they are refused unless the
    // profile says otherwise.
    allowRuntimeTools: raw.allowRuntimeTools === true,
    maxEvents: Math.min(200, Math.max(1, Number.isFinite(Number(raw.maxEvents)) ? Math.trunc(Number(raw.maxEvents)) : 50)),
  }
}

/** Evaluate one shell command and return a denial or null. */
function checkCommand(policy, command, context) {
  const original = String(command ?? '')
  if (!original.trim()) return null
  const platform = context.platform
  const segments = segmentsOf(original)

  // An allow entry is checked first, but the denial is still computed so the
  // audit event can name the rule the user chose to override.
  let denial = null
  for (const rule of policy.hardCommands) {
    if (rule.test(original)) {
      denial = { rule: rule.id, reason: rule.reason }
      break
    }
  }
  for (const rule of policy.denyCommands) {
    if (!denial && rule.pattern.test(original)) {
      denial = { rule: rule.id, reason: rule.reason ?? 'denied by guard.denyCommands' }
    }
  }
  for (const marker of CREDENTIAL_MARKERS) {
    if (!denial && marker.test(original)) {
      denial = { rule: 'cmd/credential-access', reason: 'reads a credential store that workers may not touch' }
    }
  }
  for (const segment of segments) {
    const targets = recursiveDeleteTargets(segment, platform)
    if (targets === null) continue
    if (targets.length === 0) {
      denial = { rule: 'cmd/recursive-force-delete', reason: 'recursive forced delete without a provable target' }
      break
    }
    for (const target of targets) {
      const verdict = destructiveTargetVerdict(policy, target, context)
      if (verdict) {
        denial = verdict
        break
      }
    }
    if (denial) break
  }
  if (!denial) {
    for (const segment of segments) {
      for (const target of writeTargetsOf(segment, platform)) {
        const cleaned = target.replace(/^["']|["']$/g, '')
        const resolved = resolveTarget(target, context)
        if (resolved) {
          const verdict = checkPath(policy, resolved, 'write', context)
          if (verdict) {
            denial = verdict
            break
          }
          continue
        }
        // Unresolved variables (`$env:SystemRoot`, `%WINDIR%`) cannot be
        // resolved to a path, so fall back to the literal system markers.
        if (SYSTEM_WRITE_MARKERS.some(marker => marker.test(cleaned))) {
          denial = { rule: 'cmd/system-write', reason: `writes into a system directory: ${cleaned}` }
          break
        }
      }
      if (denial) break
    }
  }

  for (const rule of policy.allowCommands) {
    if (!rule.pattern.test(original)) continue
    return { denial: null, allow: { rule: rule.id, reason: rule.reason, overridden: denial?.rule ?? null } }
  }
  return { denial, allow: null }
}

/** Return the file paths a tool call will write or read. */
function toolPaths(name, args) {
  const list = []
  const add = (value, mode) => {
    if (typeof value === 'string' && value.trim()) list.push({ path: value, mode })
  }
  switch (name) {
    case 'write':
    case 'edit':
      add(args.file_path, 'write')
      break
    case 'read':
    case 'read_image':
      add(args.file_path, 'read')
      break
    case 'str_replace_editor':
      add(args.path, args.command === 'view' ? 'read' : 'write')
      break
    case 'create_worktree':
      add(args.path, 'write')
      break
    case 'apply_patch': {
      const input = typeof args.input === 'string' ? args.input : ''
      for (const match of input.matchAll(/^\*\*\*\s+(?:Add|Update|Delete) File:\s*(.+)$/gm)) {
        add(match[1].trim(), 'write')
      }
      for (const match of input.matchAll(/^\*\*\*\s+Move to:\s*(.+)$/gm)) {
        add(match[1].trim(), 'write')
      }
      break
    }
    default:
      break
  }
  return list
}

/** Check every path a file tool touches. */
function checkFileTool(policy, name, args, context) {
  for (const entry of toolPaths(name, args)) {
    const resolved = resolveTarget(entry.path, context)
    if (!resolved) continue
    const verdict = checkPath(policy, resolved, entry.mode, context)
    if (verdict) return { ...verdict, detail: resolved }
  }
  return null
}

/**
 * Build the guard.
 *
 * @param {object} [options]
 * @param {object} [options.config] - the `guard` block from `cordis.patch.yml`.
 * @param {string} [options.cwd] - fallback workspace when a child session has none.
 * @param {string} [options.homedir]
 * @param {string} [options.platform] - `process.platform` by default.
 * @param {object} [options.env] - environment used to expand `%VAR%`.
 * @param {(message: string) => void} [options.warn]
 * @param {() => number} [options.now]
 */
const TASK_BROWSER_TOOLS = new Set([
  'browser_open', 'browser_elements', 'browser_click', 'browser_type',
  'browser_screenshot', 'browser_wait', 'browser_await_human', 'browser_close',
])

export function createGuard(options = {}) {
  const {
    config = {},
    cwd = process.cwd(),
    homedir = os.homedir(),
    tmpdir = os.tmpdir(),
    platform = process.platform,
    env = process.env,
    warn = () => {},
    now = () => Date.now(),
  } = options
  const enabled = !(config?.enabled === false || /^(false|0|off|no)$/i.test(String(config?.enabled ?? '')))
  const policy = resolvePolicy({ config, cwd, homedir, platform, env, tmpdir, warn })
  const P = platform === 'win32' ? path.win32 : path.posix

  /** childId → { runId, label, executionContract } */
  const children = new Map()
  /** runId → counters and the bounded event list. */
  const runs = new Map()
  const runOrder = []

  function bucketFor(runId) {
    let bucket = runs.get(runId)
    if (!bucket) {
      bucket = { blocked: 0, allowed: 0, byRule: {}, events: [], omitted: 0 }
      runs.set(runId, bucket)
      runOrder.push(runId)
      if (runOrder.length > 500) {
        const oldest = runOrder.shift()
        if (oldest !== undefined) runs.delete(oldest)
      }
    }
    return bucket
  }

  function record(runId, event) {
    if (!runId) return
    const bucket = bucketFor(runId)
    if (event.decision === 'blocked') bucket.blocked += 1
    else bucket.allowed += 1
    bucket.byRule[event.rule] = (bucket.byRule[event.rule] ?? 0) + 1
    if (bucket.events.length < policy.maxEvents) bucket.events.push(event)
    else bucket.omitted += 1
  }

  function contextFor(exec, binding) {
    const sessionCwd = exec?.agent?.session?.header?.cwd
    const workspace = typeof sessionCwd === 'string' && sessionCwd.trim() ? sessionCwd : cwd
    return {
      cwd: workspace,
      homedir,
      platform,
      env,
      tmpdir: P.normalize(tmpdir),
      allowRoots: [...new Set([P.normalize(workspace), ...(binding?.allowRoots ?? []), ...policy.baseRoots])],
    }
  }

  function evaluate(exec, binding) {
    const name = typeof exec?.name === 'string' ? exec.name : ''
    let args = exec?.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = {}
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { blocked: false, rule: null, reason: null, detail: null }
    }
    const contractDenial = checkExecutionContract(binding.executionContract, name, args)
    if (contractDenial) return contractDenial
    const context = contextFor(exec, binding)

    if (/^(browser|desktop)_/.test(name) && !policy.allowRuntimeTools
      && !(binding.browserScope && TASK_BROWSER_TOOLS.has(name))) {
      return {
        blocked: true,
        rule: 'guard/runtime-tool',
        reason: 'worker agents may not drive the browser or the desktop; runtime control belongs to the parent session '
          + '(set guard.allowRuntimeTools to change this)',
        detail: truncate(name),
      }
    }

    let denial = null
    if (name === 'bash' || name === 'pwsh' || name === 'terminal_send') {
      const command = typeof args.command === 'string'
        ? args.command
        : (typeof args.text === 'string' ? args.text : '')
      const workdir = typeof args.workdir === 'string' && args.workdir.trim() ? args.workdir : null
      const commandContext = workdir
        ? { ...context, cwd: resolveTarget(workdir, context) ?? context.cwd }
        : context
      const verdict = checkCommand(policy, command, commandContext)
      if (verdict.allow) {
        return {
          blocked: false,
          rule: verdict.allow.rule,
          reason: verdict.allow.reason,
          detail: truncate(command),
          explicitAllow: true,
          overridden: verdict.allow.overridden,
        }
      }
      denial = verdict.denial
      if (!denial) {
        // Even a read-only command may not run inside a credential directory.
        const resolvedWorkdir = workdir ? resolveTarget(workdir, context) : null
        if (resolvedWorkdir) {
          const workdirVerdict = checkPath(policy, resolvedWorkdir, 'read', context)
          if (workdirVerdict) denial = workdirVerdict
        }
      }
      if (denial) return { blocked: true, rule: denial.rule, reason: denial.reason, detail: truncate(command) }
      return { blocked: false, rule: null, reason: null, detail: truncate(command) }
    }

    const fileVerdict = checkFileTool(policy, name, args, context)
    if (fileVerdict) {
      return { blocked: true, rule: fileVerdict.rule, reason: fileVerdict.reason, detail: truncate(fileVerdict.detail ?? '') }
    }
    return { blocked: false, rule: null, reason: null, detail: null }
  }

  return {
    enabled,

    /**
     * Associate a spawned child with its run, so blocked calls can be attributed.
     * An optional executionContract adds normalized abstract permission checks;
     * it never relaxes the global path and command policy.
     */
    bindChild(childId, binding = {}) {
      if (!childId) return
      children.set(childId, {
        runId: binding.runId ?? null,
        label: binding.label ?? null,
        browserScope: binding.browserScope ?? null,
        allowRoots: (Array.isArray(binding.allowRoots) ? binding.allowRoots : [])
          .filter(entry => typeof entry === 'string' && entry.trim())
          .map(entry => P.normalize(entry)),
        executionContract: normalizeExecutionContract(binding.executionContract),
      })
    },

    /** Forget a child once its activation is disposed. */
    unbindChild(childId) {
      children.delete(childId)
    },

    browserScope(childId) {
      return children.get(childId)?.browserScope ?? null
    },

    /**
     * Evaluate one host tool call. Returns `{ blocked: false }` for any agent
     * this guard does not own.
     *
     * @param {{ name?: string, arguments?: unknown, agent?: { id?: string, session?: object } }} exec
     */
    checkToolCall(exec) {
      const childId = exec?.agent?.id
      const binding = childId ? children.get(childId) : undefined
      if (!enabled || !binding) return { blocked: false, rule: null, reason: null }
      let verdict
      try {
        verdict = evaluate(exec, binding)
      } catch (error) {
        // A guard bug must not become a silent pass-through.
        verdict = {
          blocked: true,
          rule: 'guard/internal-error',
          reason: `the guard could not evaluate this call (${error?.message ?? error})`,
          detail: truncate(exec?.name ?? ''),
        }
      }
      if (!verdict.blocked && !verdict.explicitAllow) return verdict
      record(binding.runId, {
        at: new Date(now()).toISOString(),
        decision: verdict.blocked ? 'blocked' : 'allowed',
        rule: verdict.rule,
        tool: exec?.name ?? 'unknown',
        label: binding.label,
        detail: verdict.detail,
        reason: verdict.reason,
        overridden: verdict.overridden ?? null,
      })
      return {
        ...verdict,
        label: binding.label,
        reasonText: verdict.blocked
          ? `[guard] blocked ${exec?.name ?? 'tool'}: rule ${verdict.rule} — ${verdict.reason}. The call did not run. `
            + (verdict.rule.startsWith('contract/')
              ? 'Ask the user to approve a revised execution contract before retrying.'
              : 'Use a path inside the workspace, or ask the user to add a guard.allowWriteRoots or guard.allowCommands entry.')
          : null,
      }
    },

    /** Counters and events for one run, or null when nothing happened. */
    snapshot(runId) {
      const bucket = runs.get(runId)
      if (!bucket) return null
      return {
        blocked: bucket.blocked,
        allowed: bucket.allowed,
        byRule: { ...bucket.byRule },
        events: bucket.events.map(event => ({ ...event })),
        omitted: bucket.omitted,
      }
    },

    /** Markdown section appended to a finished run's report. */
    reportSection(runId) {
      const bucket = runs.get(runId)
      if (!bucket || bucket.blocked + bucket.allowed === 0) return null
      const lines = ['## Safety guard', '']
      const parts = []
      if (bucket.blocked > 0) parts.push(`${bucket.blocked} tool call(s) blocked`)
      if (bucket.allowed > 0) parts.push(`${bucket.allowed} explicit allow(s) recorded`)
      lines.push(`${parts.join('; ')}.`)
      if (Object.keys(bucket.byRule).length > 0) {
        lines.push('', `Rules: ${Object.entries(bucket.byRule).map(([rule, count]) => `${rule} ×${count}`).join(', ')}.`)
      }
      for (const event of bucket.events) {
        const who = event.label ? ` ${event.label}` : ''
        const detail = event.detail ? ` \`${event.detail.replaceAll('`', "'")}\`` : ''
        lines.push('', `- ${event.decision}${who} · ${event.tool}${detail} — ${event.rule}: ${event.reason ?? ''}`.trim())
      }
      if (bucket.omitted > 0) lines.push('', `${bucket.omitted} further event(s) were counted but not listed (guard.maxEvents).`)
      return lines.join('\n')
    },
  }
}

function truncate(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text
}
