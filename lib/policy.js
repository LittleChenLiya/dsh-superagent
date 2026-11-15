/**
 * Permission policy for dsh-superagent runs.
 *
 * A policy is a small JSON file a person edits by hand, so every rejection has
 * to say *where* the problem is: a schema error without a line number turns a
 * typo into an afternoon of guessing. The file is parsed by a position-aware
 * reader instead of `JSON.parse` for exactly that reason, and `//` / `#` line
 * comments are stripped (with their newlines kept) so the file can explain
 * itself.
 *
 * The policy only ever tightens. Nothing here relaxes a deny rule; an explicit
 * allow entry can lift a `confirm` or a per-run `deny`, and the caller records
 * that as an override so the audit trail shows who permitted it.
 *
 * @module dsh-superagent/policy
 */
import fsp from 'node:fs/promises'

/** Decisions a policy can return, from loosest to strictest. */
export const LEVELS = ['allow', 'confirm', 'deny']

/** Action kinds a policy can talk about. `*` is accepted as a suffix wildcard. */
export const ACTION_KINDS = [
  'run.start',
  'run.resume',
  'path.read',
  'path.write',
  'command.exec',
  'tool.call',
  'network',
  'attention',
]

const RUN_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z_-]{3,63}$/
const MAX_ERRORS = 20
const COMPOSITE_COMMAND = /(?:&&|\|\||[;|`]|\$\(|\n)/

/** One invalid line of a policy file. */
export class PolicyError extends Error {
  /**
   * @param {string} file - display name of the policy file.
   * @param {{ line: number, column: number, path: string, message: string }[]} errors - findings.
   * @param {string} source - file text, used for a caret line.
   */
  constructor(file, errors, source = '') {
    const head = `${file}: ${errors.length} problem${errors.length === 1 ? '' : 's'} in the permission policy`
    const body = errors.map(problem => {
      const caret = source ? `\n    ${source.split('\n')[problem.line - 1] ?? ''}` : ''
      const pointer = caret ? `\n    ${' '.repeat(Math.max(0, problem.column - 1))}^` : ''
      return `  ${file}:${problem.line}:${problem.column} [${problem.path}] ${problem.message}${caret}${pointer}`
    })
    super([head, ...body].join('\n'))
    this.name = 'PolicyError'
    this.file = file
    this.errors = errors
  }
}

/**
 * Remove comments from JSON text without moving any character: comment bytes
 * become spaces, newlines survive. A `//` inside a string is left alone.
 * @param {string} text - raw file text.
 * @returns {string} text with comments blanked.
 */
export function stripComments(text) {
  let out = ''
  let index = 0
  let inString = false
  let escaped = false
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      index++
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index++
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length) {
        const current = text[index]
        out += current === '\n' ? '\n' : ' '
        index++
        if (current === '\n') break
      }
      continue
    }
    if (char === '/' && next === '*') {
      out += '  '
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        out += text[index] === '\n' ? '\n' : ' '
        index++
      }
      if (index < text.length) {
        out += '  '
        index += 2
      }
      continue
    }
    if (char === '#') {
      while (index < text.length) {
        const current = text[index]
        out += current === '\n' ? '\n' : ' '
        index++
        if (current === '\n') break
      }
      continue
    }
    out += char
    index++
  }
  return out
}

/**
 * Minimal position-aware JSON reader. It is deliberately strict: trailing
 * commas and unquoted keys are rejected, because a policy file that only
 * *nearly* parses is a policy the user believes is in force but is not.
 */
function parseTree(text) {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)

  const positionOf = index => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (lineStarts[mid] <= index) low = mid
      else high = mid - 1
    }
    return { line: low + 1, column: index - lineStarts[low] + 1 }
  }

  let index = 0

  const fail = (message, at = index) => {
    const { line, column } = positionOf(Math.min(at, text.length))
    const error = new SyntaxError(message)
    error.line = line
    error.column = column
    error.at = at
    throw error
  }

  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index])) index++
  }

  const parseString = () => {
    const start = index
    index++
    let value = ''
    while (index < text.length) {
      const char = text[index]
      if (char === '"') {
        index++
        const { line, column } = positionOf(start)
        return { kind: 'string', value, line, column }
      }
      if (char === '\\') {
        const escape = text[index + 1]
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
        if (escape in simple) {
          value += simple[escape]
          index += 2
          continue
        }
        if (escape === 'u') {
          const hex = text.slice(index + 2, index + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid \\u escape in a string', index)
          value += String.fromCharCode(parseInt(hex, 16))
          index += 6
          continue
        }
        fail('invalid escape in a string', index)
      }
      if (char === '\n') fail('a string is missing its closing quote', start)
      value += char
      index++
    }
    fail('a string is missing its closing quote', start)
    return null
  }

  const parseValue = () => {
    skipSpace()
    const start = index
    const char = text[index]
    if (char === '{') {
      const { line, column } = positionOf(start)
      index++
      const entries = []
      skipSpace()
      if (text[index] === '}') {
        index++
        return { kind: 'object', entries, line, column }
      }
      for (;;) {
        skipSpace()
        if (text[index] !== '"') fail('expected a quoted key')
        const keyStart = index
        const keyNode = parseString()
        skipSpace()
        if (text[index] !== ':') fail('expected ":" after a key')
        index++
        const node = parseValue()
        const { line: keyLine, column: keyColumn } = positionOf(keyStart)
        entries.push({ key: keyNode.value, keyLine, keyColumn, node })
        skipSpace()
        if (text[index] === ',') {
          index++
          skipSpace()
          if (text[index] === '}') fail('trailing commas are not allowed')
          continue
        }
        if (text[index] === '}') {
          index++
          return { kind: 'object', entries, line, column }
        }
        fail('expected "," or "}" in an object')
      }
    }
    if (char === '[') {
      const { line, column } = positionOf(start)
      index++
      const items = []
      skipSpace()
      if (text[index] === ']') {
        index++
        return { kind: 'array', items, line, column }
      }
      for (;;) {
        items.push(parseValue())
        skipSpace()
        if (text[index] === ',') {
          index++
          skipSpace()
          if (text[index] === ']') fail('trailing commas are not allowed')
          continue
        }
        if (text[index] === ']') {
          index++
          return { kind: 'array', items, line, column }
        }
        fail('expected "," or "]" in an array')
      }
    }
    if (char === '"') return parseString()
    const literal = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(index))
    if (!literal) fail(`unexpected character ${JSON.stringify(char ?? 'end of file')}`)
    index += literal[0].length
    const { line, column } = positionOf(start)
    if (literal[0] === 'true' || literal[0] === 'false') {
      return { kind: 'boolean', value: literal[0] === 'true', line, column }
    }
    if (literal[0] === 'null') return { kind: 'null', value: null, line, column }
    return { kind: 'number', value: Number(literal[0]), line, column }
  }

  const root = parseValue()
  skipSpace()
  if (index < text.length) fail('unexpected text after the top-level value')
  return { root, positionOf }
}

function valueOf(node) {
  if (node.kind === 'object') {
    const value = {}
    for (const entry of node.entries) value[entry.key] = valueOf(entry.node)
    return value
  }
  if (node.kind === 'array') return node.items.map(valueOf)
  return node.value
}

/**
 * Validate one policy tree and return the plain object a decision reads.
 * Every problem carries the line and column of the token that caused it.
 */
function validate(root, file, source) {
  const errors = []
  const add = (node, path, message) => {
    if (errors.length >= MAX_ERRORS) return
    errors.push({ line: node?.line ?? 1, column: node?.column ?? 1, path, message })
  }
  const keyOf = (entry, path) => {
    const node = { line: entry.keyLine, column: entry.keyColumn }
    return { node, path }
  }

  if (root.kind !== 'object') {
    add(root, '$', 'the policy must be a JSON object')
    throw new PolicyError(file, errors, source)
  }

  const seen = new Map()
  for (const entry of root.entries) {
    if (seen.has(entry.key)) {
      const spot = keyOf(entry, entry.key)
      add(spot.node, spot.path, `duplicate key; the earlier value was already set on line ${seen.get(entry.key)}`)
    } else {
      seen.set(entry.key, entry.keyLine)
    }
  }

  const knownRoot = ['version', 'defaultLevel', 'paths', 'commands', 'confirm', 'runs', 'note']
  for (const entry of root.entries) {
    if (!knownRoot.includes(entry.key)) {
      const spot = keyOf(entry, entry.key)
      add(spot.node, spot.path, `unknown key; expected one of ${knownRoot.join(', ')}`)
      continue
    }
    const path = entry.key
    const node = entry.node
    if (entry.key === 'version') {
      if (node.kind !== 'number' || node.value !== 1) add(node, path, 'must be the number 1')
      continue
    }
    if (entry.key === 'note') {
      if (node.kind !== 'string') add(node, path, 'must be a string')
      continue
    }
    if (entry.key === 'defaultLevel') {
      if (node.kind !== 'string' || !LEVELS.includes(node.value)) {
        add(node, path, `must be one of ${LEVELS.join(' | ')}`)
      }
      continue
    }
    if (entry.key === 'paths' || entry.key === 'commands') {
      if (node.kind !== 'object') {
        add(node, path, 'must be an object with allow and/or deny arrays')
        continue
      }
      const known = ['allow', 'deny']
      for (const child of node.entries) {
        if (!known.includes(child.key)) {
          const spot = keyOf(child, `${path}.${child.key}`)
          add(spot.node, spot.path, `unknown key; expected ${known.join(' or ')}`)
          continue
        }
        const listPath = `${path}.${child.key}`
        if (child.node.kind !== 'array') {
          add(child.node, listPath, 'must be an array of strings')
          continue
        }
        child.node.items.forEach((item, i) => {
          const itemPath = `${listPath}[${i}]`
          if (item.kind !== 'string') {
            add(item, itemPath, 'must be a string')
            return
          }
          if (!item.value.trim()) add(item, itemPath, 'must not be empty')
        })
      }
      continue
    }
    if (entry.key === 'confirm') {
      if (node.kind !== 'object') {
        add(node, path, 'must be an object with an actions array')
        continue
      }
      for (const child of node.entries) {
        if (child.key !== 'actions') {
          const spot = keyOf(child, `${path}.${child.key}`)
          add(spot.node, spot.path, 'unknown key; expected actions')
          continue
        }
        if (child.node.kind !== 'array') {
          add(child.node, `${path}.actions`, 'must be an array of action kinds')
          continue
        }
        child.node.items.forEach((item, i) => {
          const itemPath = `${path}.actions[${i}]`
          if (item.kind !== 'string') {
            add(item, itemPath, 'must be a string')
            return
          }
          const wildcard = item.value.endsWith('*')
          const base = wildcard ? item.value.slice(0, -1) : item.value
          const known = ACTION_KINDS.includes(item.value)
            || (wildcard && ACTION_KINDS.some(kind => kind.startsWith(base)))
          if (!known) {
            add(item, itemPath, `unknown action kind; expected one of ${ACTION_KINDS.join(', ')} (or "path.*")`)
          }
        })
      }
      continue
    }
    if (entry.key === 'runs') {
      if (node.kind !== 'object') {
        add(node, path, 'must be an object keyed by run id')
        continue
      }
      for (const child of node.entries) {
        const runPath = `${path}.${child.key}`
        const spot = keyOf(child, runPath)
        if (!RUN_ID_PATTERN.test(child.key)) {
          add(spot.node, runPath, 'is not a run id (letters, digits, "-" or "_", 4-64 characters)')
          continue
        }
        if (child.node.kind !== 'object') {
          add(child.node, runPath, 'must be an object with level and/or note')
          continue
        }
        for (const setting of child.node.entries) {
          const settingPath = `${runPath}.${setting.key}`
          if (setting.key === 'level') {
            if (setting.node.kind !== 'string' || !LEVELS.includes(setting.node.value)) {
              add(setting.node, settingPath, `must be one of ${LEVELS.join(' | ')}`)
            }
          } else if (setting.key === 'note') {
            if (setting.node.kind !== 'string') add(setting.node, settingPath, 'must be a string')
          } else {
            const settingSpot = keyOf(setting, settingPath)
            add(settingSpot.node, settingPath, 'unknown key; expected level or note')
          }
        }
      }
    }
  }

  if (errors.length > 0) throw new PolicyError(file, errors, source)

  const policy = valueOf(root)
  return {
    version: policy.version ?? 1,
    defaultLevel: policy.defaultLevel ?? 'allow',
    paths: { allow: policy.paths?.allow ?? [], deny: policy.paths?.deny ?? [] },
    commands: { allow: policy.commands?.allow ?? [], deny: policy.commands?.deny ?? [] },
    confirm: { actions: policy.confirm?.actions ?? [] },
    runs: policy.runs ?? {},
    note: typeof policy.note === 'string' ? policy.note : null,
    source: file,
  }
}

/**
 * Parse and validate policy text.
 * @param {string} text - file contents, comments allowed.
 * @param {{ file?: string }} [options] - display name used in errors.
 * @returns {object} frozen policy.
 * @throws {PolicyError} with one entry per problem, each carrying line and column.
 */
export function parsePolicy(text, { file = 'audit-policy.json' } = {}) {
  const stripped = stripComments(String(text ?? ''))
  const trimmed = stripped.trim()
  if (!trimmed) throw new PolicyError(file, [{ line: 1, column: 1, path: '$', message: 'the policy file is empty' }], stripped)
  let tree
  try {
    tree = parseTree(stripped)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new PolicyError(
        file,
        [{ line: error.line ?? 1, column: error.column ?? 1, path: '$', message: `not valid JSON: ${error.message}` }],
        stripped,
      )
    }
    throw error
  }
  return Object.freeze(validate(tree.root, file, stripped))
}

/**
 * Load a policy file, re-reading it when its mtime changes so an edit takes
 * effect without restarting the host. A read or parse failure is returned, not
 * thrown: the caller must keep the *previous* behaviour of failing closed and
 * telling the user, which it can only do with the error in hand.
 */
export function createPolicyLoader({ file, warn = () => {} } = {}) {
  let cached = null
  let cachedMtime = -1
  let lastError = null
  return {
    file,
    /**
     * @returns {Promise<{ policy: object | null, error: PolicyError | Error | null, stale: boolean }>}
     */
    async get() {
      if (!file) return { policy: null, error: null, stale: false }
      let stat
      try {
        stat = await fsp.stat(file)
      } catch (error) {
        // A missing file is the documented "no policy" state, not a problem.
        if (error?.code === 'ENOENT') return { policy: null, error: null, stale: false }
        lastError = error
        return { policy: null, error, stale: cached !== null }
      }
      if (cached && stat.mtimeMs === cachedMtime) return { policy: cached, error: null, stale: false }
      try {
        const text = await fsp.readFile(file, 'utf8')
        const policy = parsePolicy(text, { file })
        cached = policy
        cachedMtime = stat.mtimeMs
        lastError = null
        return { policy, error: null, stale: false }
      } catch (error) {
        lastError = error
        warn(`permission policy ${file} is invalid and stays in force as "deny": ${error?.message ?? error}`)
        return { policy: null, error, stale: cached !== null }
      }
    },
    /** Last parse error, for status output. */
    get error() {
      return lastError
    },
  }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Convert a glob into a regular expression body; `**` spans separators. */
function globBody(pattern) {
  let body = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        body += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        body += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      body += '[^/]'
      continue
    }
    body += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return body
}

const isWindows = process.platform === 'win32'

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

/**
 * Does one path pattern cover this target?
 *
 * A relative pattern (`src/**`) matches at any directory boundary of an
 * absolute target, so the same policy works no matter where the workspace is
 * mounted. On Windows the comparison ignores case, which is how the filesystem
 * itself behaves.
 */
export function pathMatches(pattern, target) {
  const raw = String(pattern ?? '').trim()
  if (!raw) return false
  const normalizedPattern = normalizePath(raw)
  const normalizedTarget = normalizePath(target)
  if (!normalizedTarget) return false
  const flags = isWindows ? 'i' : ''
  const absolute = /^[A-Za-z]:\//.test(normalizedPattern) || normalizedPattern.startsWith('/')
  if (absolute) {
    try {
      return new RegExp(`^${globBody(normalizedPattern)}$`, flags).test(normalizedTarget)
    } catch {
      return false
    }
  }
  try {
    // `**/x`, `x`, and `a/**/x` all have to work at a boundary; anchoring with
    // a slash-or-start prefix is what keeps `rc/a.js` from matching `src/a.js`.
    return new RegExp(`(?:^|/)${globBody(normalizedPattern)}$`, flags).test(normalizedTarget)
  } catch {
    return false
  }
}

/**
 * Match one command against one entry of a command list.
 *
 * A bare entry is a *prefix*: `git status` allows `git status --short` but not
 * `git statusx`. An entry containing `*` or `?` is a glob over the whole line.
 * @returns {{ matched: boolean, exact: boolean }} what the entry covered.
 */
export function commandMatches(entry, command) {
  const pattern = String(entry ?? '').trim()
  const line = String(command ?? '').trim()
  if (!pattern || !line) return { matched: false, exact: false }
  const flags = isWindows ? 'i' : ''
  if (pattern.includes('*') || pattern.includes('?')) {
    try {
      const regex = new RegExp(`^${globBody(pattern)}$`, flags)
      return { matched: regex.test(line), exact: regex.test(line) }
    } catch {
      return { matched: false, exact: false }
    }
  }
  const equal = flags ? pattern.toLowerCase() === line.toLowerCase() : pattern === line
  if (equal) return { matched: true, exact: true }
  const prefix = flags ? line.toLowerCase().startsWith(`${pattern.toLowerCase()} `) : line.startsWith(`${pattern} `)
  return { matched: prefix, exact: false }
}

function matchCategory(actions, kind) {
  for (const entry of actions) {
    if (entry === kind) return entry
    if (entry.endsWith('*') && kind.startsWith(entry.slice(0, -1))) return entry
  }
  return null
}

function stricter(a, b) {
  const rank = { allow: 0, confirm: 1, deny: 2 }
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b
}

/**
 * Decide one action against a policy.
 *
 * Precedence, strictest first:
 *   1. a `deny` pattern for the target -> deny
 *   2. an explicit `allow` pattern -> allow, tagged with what it relaxed
 *   3. the action kind listed under `confirm.actions` -> confirm
 *   4. the run's level, else the policy default level
 *
 * @param {object | null} policy - parsed policy, or null for "no policy".
 * @param {{ kind: string, target?: string, runId?: string }} request - action under review.
 * @returns {{ decision: 'allow'|'confirm'|'deny', rule: string, reason: string, relaxedFrom: string|null, match: string|null }}
 */
export function decide(policy, request = {}) {
  const kind = String(request.kind ?? '')
  if (!policy) {
    return { decision: 'allow', rule: 'no-policy', reason: 'no permission policy is configured', relaxedFrom: null, match: null }
  }
  const isPath = kind.startsWith('path.')
  const isCommand = kind === 'command.exec'
  const target = isPath ? normalizePath(request.target) : String(request.target ?? '')

  if (isPath && target) {
    for (let i = 0; i < policy.paths.deny.length; i++) {
      if (pathMatches(policy.paths.deny[i], target)) {
        return {
          decision: 'deny',
          rule: `paths.deny[${i}]`,
          reason: `${target} matches the deny pattern ${JSON.stringify(policy.paths.deny[i])}`,
          relaxedFrom: null,
          match: policy.paths.deny[i],
        }
      }
    }
    for (let i = 0; i < policy.paths.allow.length; i++) {
      if (pathMatches(policy.paths.allow[i], target)) {
        const base = baseLevelFor(policy, request.runId, kind)
        const category = matchCategory(policy.confirm.actions, kind)
        const relaxedFrom = stricter(base, category ? 'confirm' : 'allow')
        return {
          decision: 'allow',
          rule: `paths.allow[${i}]`,
          reason: `${target} matches the explicit allow pattern ${JSON.stringify(policy.paths.allow[i])}`,
          relaxedFrom: relaxedFrom === 'allow' ? null : relaxedFrom,
          match: policy.paths.allow[i],
        }
      }
    }
  }

  if (isCommand && target) {
    for (let i = 0; i < policy.commands.deny.length; i++) {
      if (commandMatches(policy.commands.deny[i], target).matched) {
        return {
          decision: 'deny',
          rule: `commands.deny[${i}]`,
          reason: `the command matches the deny pattern ${JSON.stringify(policy.commands.deny[i])}`,
          relaxedFrom: null,
          match: policy.commands.deny[i],
        }
      }
    }
    for (let i = 0; i < policy.commands.allow.length; i++) {
      const hit = commandMatches(policy.commands.allow[i], target)
      if (!hit.matched) continue
      const base = baseLevelFor(policy, request.runId, kind)
      const category = matchCategory(policy.confirm.actions, kind)
      // A composite line (`a && b`) that only matched a prefix is not the
      // command the user allowed; it may not be lifted above "confirm".
      const composite = COMPOSITE_COMMAND.test(target) && !hit.exact
      const relaxedFrom = composite
        ? 'confirm'
        : stricter(base, category ? 'confirm' : 'allow')
      return {
        decision: composite ? 'confirm' : 'allow',
        rule: `commands.allow[${i}]`,
        reason: composite
          ? `the command only matches the prefix of ${JSON.stringify(policy.commands.allow[i])}, so the rest of a composite line needs confirmation`
          : `the command matches the explicit allow entry ${JSON.stringify(policy.commands.allow[i])}`,
        relaxedFrom: relaxedFrom === 'allow' ? null : relaxedFrom,
        match: policy.commands.allow[i],
      }
    }
  }

  const category = matchCategory(policy.confirm.actions, kind)
  if (category) {
    return {
      decision: 'confirm',
      rule: `confirm.actions[${policy.confirm.actions.indexOf(category)}]`,
      reason: `${kind} is listed as requiring confirmation`,
      relaxedFrom: null,
      match: category,
    }
  }

  const level = baseLevelFor(policy, request.runId, kind)
  return {
    decision: level,
    rule: request.runId && policy.runs?.[request.runId]?.level ? `runs.${request.runId}.level` : 'defaultLevel',
    reason: level === 'allow'
      ? 'nothing in the policy restricts this action'
      : `${kind} falls back to the ${level} level`,
    relaxedFrom: null,
    match: null,
  }
}

function baseLevelFor(policy, runId) {
  const perRun = runId ? policy.runs?.[runId]?.level : null
  const level = perRun ?? policy.defaultLevel ?? 'allow'
  // A policy that somehow carries an unknown level must not degrade to allow.
  return LEVELS.includes(level) ? level : 'deny'
}
