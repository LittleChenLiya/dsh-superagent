/**
 * Cross-run memory for dsh-superagent.
 *
 * A run is stateless by design: planner and workers start empty, and a finished
 * run leaves only its state file behind. That is good for isolation and bad for
 * continuity — the next run cannot know which approach was already rejected or
 * which step left a trap. This module keeps a small, curated notebook between
 * runs without turning the state directory into a growing pile of logs:
 *
 * - Exact activity history is *derived* from the run store at planning time
 *   (which runs existed, how they ended). Nothing is copied into memory for it.
 * - Durable knowledge (decisions, pitfalls, next steps) is written only when a
 *   run's aggregator emits a fenced `memory` block. One short entry per topic.
 * - Reads are bounded: at most `maxEntries` notes, each shortened, inside a
 *   fixed character budget. The notebook is a digest, never the full file.
 * - A note is refuted, not deleted silently: a newer entry with the same `key`
 *   supersedes it, a `retracted` entry drops it, and the `superagent_memory`
 *   tool can list, set, or forget a key by hand.
 * - Entries older than `maxAgeDays` are ignored and then compacted away, so a
 *   stale conclusion cannot become a permanent bias.
 *
 * Storage is `<stateDir>/memory/<scope>.jsonl`, one JSON object per line. The
 * directory is created with a `.gitignore` containing `*`, so even a state
 * directory that points inside a repository cannot be committed by accident.
 * The package `files` whitelist never ships this directory.
 *
 * Writes append one short line with a single `write` call (atomic for a small
 * buffer on a local filesystem) while holding a lock file, so a concurrent
 * append and a compaction cannot drop each other's lines. Compaction replaces
 * the file from a temp file under the same lock. Two runs finishing at the same
 * time therefore serialise instead of overwriting; the per-key resolution is by
 * timestamp, so order alone never changes a conclusion.
 *
 * @module dsh-superagent/memory
 */
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLock } from './lock.js'

/** Kinds a note may declare. Anything else is stored as `note`. */
export const MEMORY_KINDS = new Set(['dispatch', 'decision', 'pitfall', 'next', 'note'])

/** Longest note kept; longer text is cut, not rejected. */
export const MAX_ENTRY_CHARS = 400

/** Longest key; keys are lowercase slugs so a later note can match an older one. */
export const MAX_KEY_CHARS = 48

/** File-level limits; crossing either one triggers compaction. */
const MAX_FILE_BYTES = 128 * 1024
const MAX_FILE_LINES = 400

/** How long a writer waits for another process's lock before failing open. */
const LOCK_RETRIES = 10
const LOCK_RETRY_DELAY_MS = 50

const DEFAULT_MAX_AGE_DAYS = 30
const DEFAULT_MAX_ENTRIES = 60
const DEFAULT_DIGEST_ENTRIES = 12
const DEFAULT_DIGEST_CHARS = 1600

const SCOPE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MEMORY_FENCE = /```memory[^\n]*\n([\s\S]*?)```/i

/**
 * Coerce a configured scope into a safe file name. Anything unrecognised falls
 * back to `default` instead of producing a path from user input.
 * @param {unknown} value - configured scope.
 * @returns {string} a scope that matches `SCOPE_PATTERN`.
 */
export function normalizeScope(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return SCOPE_PATTERN.test(text) ? text : 'default'
}

/**
 * Remove the shapes of secret that a model is most likely to paste into a note:
 * API keys, bearer headers, known token prefixes, long hex/base64 blobs, email
 * addresses, and absolute home paths. Redaction happens before storage, so a
 * file that is copied or backed up later cannot leak the original.
 *
 * @param {unknown} value - text to clean.
 * @returns {string} text with secrets replaced by markers.
 */
export function redact(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '[redacted-token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted-blob]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hex]')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[redacted-email]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gi, '%USERPROFILE%')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '~')
}

/**
 * Turn arbitrary text into one bounded line: redacted, no newlines, trimmed.
 * @param {unknown} value - source text.
 * @param {number} [limit] - maximum characters.
 * @returns {string} a single line.
 */
export function cleanText(value, limit = MAX_ENTRY_CHARS) {
  const text = redact(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  // Slice by code point so a cut never leaves a lone surrogate behind.
  return [...text].slice(0, limit).join('')
}

/**
 * @param {unknown} value - proposed key.
 * @returns {string} lowercase slug, possibly empty.
 */
export function slugKey(value) {
  return redact(String(value ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_KEY_CHARS)
}

/**
 * True when `child` is `parent` or inside it. Used to refuse a memory directory
 * that would end up inside the installed package.
 * @param {string} child - absolute path to test.
 * @param {string} parent - absolute path to compare against.
 */
export function isInside(child, parent) {
  const from = path.resolve(parent)
  const to = path.resolve(child)
  const relative = path.relative(from, to)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizeEntry(item) {
  if (!item || typeof item !== 'object') return null
  const status = item.status === 'retracted' ? 'retracted' : 'active'
  const kind = MEMORY_KINDS.has(item.kind) ? item.kind : 'note'
  const text = status === 'retracted' ? '' : cleanText(item.text)
  const key = slugKey(item.key) || slugKey(text.slice(0, 48)) || `${kind}-${randomBytes(3).toString('hex')}`
  if (status === 'active' && !text) return null
  return { key, kind, status, text }
}

function tsOf(record) {
  const value = Date.parse(record?.ts ?? '')
  return Number.isFinite(value) ? value : 0
}

/**
 * Resolve raw lines into the notes a reader should see.
 *
 * Records are applied oldest-first, so a newer entry wins on the same key and a
 * `retracted` entry removes it. Timestamps are used rather than file order
 * because a shared state directory can be written by two clocks. TTL is applied
 * after resolution: because a tombstone is newer than its target, an expired
 * tombstone cannot resurrect an older active entry.
 *
 * @param {object[]} records - parsed lines.
 * @param {{ now?: number, maxAgeDays?: number }} [options] - clock and TTL.
 * @returns {object[]} active entries, newest first.
 */
export function effectiveEntries(records, { now = Date.now(), maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const active = new Map()
  const ordered = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record && typeof record === 'object' && typeof record.key === 'string')
    .sort((a, b) => (tsOf(a.record) - tsOf(b.record)) || (a.index - b.index))
  for (const { record, index } of ordered) {
    if (record.status === 'retracted') active.delete(record.key)
    else active.set(record.key, { record, index })
  }
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86400000 : -Infinity
  return [...active.values()]
    .filter(({ record }) => tsOf(record) >= cutoff)
    // Newest first. Notes written in the same millisecond keep reverse line
    // order, so a later line is treated as newer rather than older.
    .sort((a, b) => (tsOf(b.record) - tsOf(a.record)) || (b.index - a.index))
    .map(({ record }) => record)
}

function ageText(ts, now) {
  const days = Math.max(0, Math.floor((now - ts) / 86400000))
  if (days === 0) return 'today'
  return `${days}d`
}

function capLine(text, limit) {
  const points = [...text]
  return points.length <= limit ? text : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/**
 * Pull the fenced `memory` block out of an aggregator report.
 *
 * The block is removed from the report whether or not it parses: the user asked
 * for a report, not for the plugin's notebook syntax. A malformed block is
 * reported through `error` so the run record shows why no note was written.
 *
 * @param {unknown} text - final report.
 * @returns {{ report: string, entries: object[], found: boolean, error?: string }}
 */
export function extractMemoryBlock(text) {
  if (typeof text !== 'string' || !text) return { report: typeof text === 'string' ? text : '', entries: [], found: false }
  const match = MEMORY_FENCE.exec(text)
  if (!match) return { report: text, entries: [], found: false }
  const report = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  let parsed
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return { report, entries: [], found: true, error: 'the memory block was not valid JSON' }
  }
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
  const entries = []
  for (const item of raw) {
    const entry = normalizeEntry(item)
    if (entry) entries.push(entry)
  }
  if (raw.length > 0 && entries.length === 0) {
    return { report, entries, found: true, error: 'the memory block had no usable entry' }
  }
  return { report, entries, found: true }
}

/**
 * Build the memory notebook bound to one state root.
 *
 * @param {string} root - absolute state directory (`<root>/memory` is used).
 * @param {object} [options] - collaborators.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @param {() => number} [options.now] - clock, injectable for tests.
 */
export function createMemory(root, { warn = () => {}, now = () => Date.now() } = {}) {
  const dir = path.join(root, 'memory')
  const fileOf = scope => path.join(dir, `${normalizeScope(scope)}.jsonl`)
  const lockOf = scope => path.join(dir, `${normalizeScope(scope)}.lock`)
  /** Per-scope write chain, so two settles in this process cannot interleave. */
  const chains = new Map()

  /**
   * Create the directory and make it git-invisible even inside a repository.
   * A `*` in a nested .gitignore ignores every file here, including the
   * notebook, without editing the repository's own .gitignore.
   */
  async function initDir() {
    await fsp.mkdir(dir, { recursive: true })
    const ignore = path.join(dir, '.gitignore')
    try {
      await fsp.access(ignore)
    } catch {
      await fsp.writeFile(ignore, '*\n', 'utf8')
    }
  }

  function serialize(scope, task) {
    const previous = chains.get(scope) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    chains.set(scope, next.catch(() => {}))
    return next
  }

  async function readRecords(file) {
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { records: [], bad: 0, bytes: 0 }
      throw error
    }
    const records = []
    let bad = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') records.push(parsed)
        else bad++
      } catch {
        // A process killed mid-append leaves one truncated line; skipping it is
        // the whole reason for the JSONL format.
        bad++
      }
    }
    return { records, bad, bytes: Buffer.byteLength(text, 'utf8') }
  }

  /**
   * Rewrite the file with the newest notes. The caller already holds the scope
   * lock; acquiring it here as well would deadlock against that same writer.
   */
  async function compactLocked(scope, { maxEntries, maxAgeDays }) {
    try {
      const file = fileOf(scope)
      const { records } = await readRecords(file)
      // Keep the newest notes but write them oldest-first, so the file stays in
      // append order and a same-millisecond tie is still resolved by line order.
      const keep = effectiveEntries(records, { now: now(), maxAgeDays })
        .slice(0, maxEntries)
        .reverse()
      const body = keep.map(record => `${JSON.stringify(record)}\n`).join('')
      const tmp = path.join(dir, `.${normalizeScope(scope)}.${process.pid}.${Date.now()}.tmp`)
      await fsp.writeFile(tmp, body, 'utf8')
      await fsp.rename(tmp, file)
      return true
    } catch (error) {
      warn(`cannot compact memory scope "${scope}": ${error?.message ?? error}`)
      return false
    }
  }

  async function append(scope, records) {
    if (records.length === 0) return 0
    const file = fileOf(scope)
    const body = records.map(record => `${JSON.stringify(record)}\n`).join('')
    // One write for the whole batch: a concurrent append either lands before or
    // after this buffer, never inside it on a local filesystem.
    const handle = await fsp.open(file, 'a')
    try {
      await handle.write(body)
    } finally {
      await handle.close()
    }
    return records.length
  }

  return {
    root,
    dir,
    fileOf,

    /** Create the directory and make it git-invisible even inside a repository. */
    async init() {
      await initDir()
    },

    /**
     * Read the notebook's current notes.
     * @param {{ scope?: string, maxAgeDays?: number }} [options] - read options.
     */
    async read({ scope = 'default', maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
      const file = fileOf(scope)
      const { records, bad, bytes } = await readRecords(file)
      return {
        entries: effectiveEntries(records, { now: now(), maxAgeDays }),
        bad,
        bytes,
        path: file,
      }
    },

    /**
     * Append the notes a finished run produced. Idempotent per run id: a resume
     * settles the same run again and must not duplicate its notes.
     *
     * @param {{ scope?: string, runId: string, entries: object[], maxEntries?: number, maxAgeDays?: number }} options - note batch.
     * @returns {Promise<{ written: number, skipped: number, reason: string | null }>}
     */
    async write({ scope = 'default', runId, entries, maxEntries = DEFAULT_MAX_ENTRIES, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
      const normalized = (Array.isArray(entries) ? entries : []).map(normalizeEntry).filter(Boolean)
      if (normalized.length === 0) return { written: 0, skipped: 0, reason: 'no usable entry' }
      const key = normalizeScope(scope)
      return serialize(key, async () => {
        await initDir()
        // One lock for the whole read/dedupe/append/compaction sequence. Without
        // it a compaction in another process could rename the file between this
        // writer's read and append and silently drop the new line.
        const release = await acquireFileLock(lockOf(key), {
          now,
          retries: LOCK_RETRIES,
          retryDelayMs: LOCK_RETRY_DELAY_MS,
        })
        if (!release) {
          warn(`memory scope "${key}" is locked by another process; appended without compaction`)
        }
        try {
          const file = fileOf(key)
          const { records } = await readRecords(file)
          if (runId && records.some(record => record?.runId === runId)) {
            return { written: 0, skipped: normalized.length, reason: 'this run already wrote its notes' }
          }
          const ts = new Date(now()).toISOString()
          const batch = normalized.map(entry => ({
            v: 1,
            id: randomBytes(4).toString('hex'),
            ts,
            runId: runId ?? null,
            ...entry,
          }))
          const written = await append(key, batch)
          let bytes = 0
          try {
            bytes = (await fsp.stat(file)).size
          } catch {
            // A missing stat only means compaction cannot be sized this round.
          }
          if (release && (bytes > MAX_FILE_BYTES || records.length + batch.length > MAX_FILE_LINES)) {
            await compactLocked(key, { maxEntries, maxAgeDays })
          }
          return { written, skipped: normalized.length - written, reason: null }
        } finally {
          await release?.()
        }
      })
    },

    /**
     * Record one note by hand (the `superagent_memory` tool's `set`).
     * @param {{ scope?: string, key: string, kind?: string, text: string, runId?: string }} options - note.
     */
    async set({ scope = 'default', key, kind = 'note', text, runId = null } = {}) {
      const entry = normalizeEntry({ key, kind, text })
      if (!entry) return { written: 0, reason: 'a note needs non-empty text' }
      const result = await this.write({ scope, runId: runId ?? `manual-${randomBytes(3).toString('hex')}`, entries: [entry] })
      return { written: result.written, reason: result.reason }
    },

    /**
     * Retract a note by key. The tombstone is itself a line, so a later
     * compaction that drops the old note also drops the tombstone.
     * @param {{ scope?: string, key: string }} options - key to forget.
     */
    async forget({ scope = 'default', key } = {}) {
      const slug = slugKey(key)
      if (!slug) return { forgotten: false, reason: 'a key is required' }
      const result = await this.write({
        scope,
        runId: `forget-${randomBytes(3).toString('hex')}`,
        entries: [{ key: slug, kind: 'note', status: 'retracted' }],
      })
      return { forgotten: result.written > 0, reason: result.reason }
    },

    /**
     * Bounded digest injected into prompts. Never the whole file.
     * @param {{ scope?: string, maxEntries?: number, maxChars?: number, maxAgeDays?: number }} [options] - digest limits.
     * @returns {Promise<string>} note lines, or an empty string.
     */
    async digest({
      scope = 'default',
      maxEntries = DEFAULT_DIGEST_ENTRIES,
      maxChars = DEFAULT_DIGEST_CHARS,
      maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    } = {}) {
      const { entries } = await this.read({ scope, maxAgeDays })
      if (entries.length === 0) return ''
      const picked = entries.slice(0, maxEntries)
      const perEntry = Math.max(100, Math.floor(maxChars / Math.max(1, picked.length)) - 28)
      const lines = []
      let used = 0
      let omitted = 0
      for (const entry of picked) {
        const line = `- [${ageText(tsOf(entry), now())}] ${entry.kind} ${entry.key}: ${capLine(entry.text, perEntry)}`
        if (used + line.length + 1 > maxChars) {
          omitted++
          continue
        }
        lines.push(line)
        used += line.length + 1
      }
      if (lines.length === 0) return ''
      if (omitted > 0) lines.push(`- (+${omitted} more; call superagent_memory action="list" to read them)`)
      return lines.join('\n')
    },

    /**
     * Rows for the `superagent_memory` tool.
     * @param {{ scope?: string, limit?: number, maxAgeDays?: number }} [options] - list options.
     */
    async list({ scope = 'default', limit = 20, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
      const { entries, bad, bytes, path: file } = await this.read({ scope, maxAgeDays })
      return { entries: entries.slice(0, limit), total: entries.length, bad, bytes, path: file }
    },

    /**
     * Size and count for `superagent_list`.
     * @param {{ scope?: string, maxAgeDays?: number }} [options] - stats options.
     */
    async stats({ scope = 'default', maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
      const { entries, bytes, path: file } = await this.read({ scope, maxAgeDays })
      return { entries: entries.length, bytes, path: file }
    },

    /** Defaults exposed so the orchestrator and tests agree on one set of limits. */
    defaults: {
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxAgeDays: DEFAULT_MAX_AGE_DAYS,
      digestEntries: DEFAULT_DIGEST_ENTRIES,
      digestChars: DEFAULT_DIGEST_CHARS,
    },
  }
}
