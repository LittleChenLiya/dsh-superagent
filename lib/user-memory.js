/**
 * User-level memory for dsh-superagent.
 *
 * `memory.js` answers "what did the last run learn about this task". That is a
 * run notebook: it is ranked against one goal and it is meant to age out. This
 * module answers a different question — "who is this person, what do they want,
 * and why did we choose this before" — and it has to survive across unrelated
 * tasks, so it is stored apart and read apart:
 *
 * - Three categories, three files: `facts` (durable technical context such as
 *   the stack or the environment), `preferences` (how the user wants work done)
 *   and `decisions` (a choice plus what was rejected, why, and how to undo it).
 *   A search opens one category file, so a fact can never be returned as a
 *   preference just because the words match.
 * - A decision is only stored when it has a choice and a reason. A conclusion
 *   without its rationale teaches the next run nothing, so the reason is part
 *   of the record and part of every digest line.
 * - Everything is redacted before it is written, by default: credentials,
 *   emails, phone numbers, and usernames inside home paths. The profile is meant
 *   to be readable by a future model, not to be a copy of the user's secrets.
 * - Forgetting is a real deletion: the matching lines are removed from the file
 *   under a lock and the file is replaced. There is no tombstone to leak the
 *   value back through a later search. Three filters are supported — a key, a
 *   run id, and a time range — and at least one is required, so a bare "forget"
 *   cannot wipe the profile by accident.
 *
 * The module is off by default (`memoryUserProfile: false`): unless the operator
 * enables it, nothing here is constructed, no directory is created, and the
 * existing run notebook behaves exactly as before. It has no dependencies and
 * reuses `memory.js` primitives (redaction, slug keys, tokenising, scoring) so
 * both layers agree on what a key is and how relevance is measured.
 *
 * @module dsh-superagent/user-memory
 */
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { acquireFileLock } from './lock.js'
import { cleanText, normalizeTags, scoreEntry, slugKey } from './memory.js'

/** The three categories, in the order a digest prints them. */
export const USER_MEMORY_CATEGORIES = Object.freeze(['fact', 'preference', 'decision'])

/** One file per category, so a search can never read across categories. */
const CATEGORY_FILES = Object.freeze({
  fact: 'facts.jsonl',
  preference: 'preferences.jsonl',
  decision: 'decisions.jsonl',
})

/** Longest value kept per decision field. A decision is a sentence, not a log. */
const MAX_CHOICE_CHARS = 200
const MAX_REJECTED_CHARS = 160
const MAX_REASON_CHARS = 240
const MAX_ROLLBACK_CHARS = 200

/** File-level limits; crossing either one, or `maxEntries`, triggers compaction. */
const MAX_FILE_BYTES = 128 * 1024
const MAX_FILE_LINES = 400

/** How long a writer waits for another process's lock before failing open. */
const LOCK_RETRIES = 10
const LOCK_RETRY_DELAY_MS = 50

/** Defaults; a profile is long-lived, so it expires far more slowly than a run note. */
export const USER_MEMORY_DEFAULTS = Object.freeze({
  maxEntries: 200,
  maxAgeDays: 365,
  digestEntries: 8,
  digestChars: 1200,
})

const USER_MEMORY_FENCE = /```user-memory[^\n]*\n([\s\S]*?)```/i

/**
 * Redact the shapes that identify a person but are not secrets in the API-key
 * sense: phone numbers. The credential, email and home-path rules live in
 * `memory.redact`, which `cleanText` applies after this step.
 *
 * @param {unknown} value - text that may contain a phone number.
 * @returns {string} the text with phone numbers replaced by a marker.
 */
export function redactPhones(value) {
  if (typeof value !== 'string') return ''
  return value
    // Mainland Chinese mobile numbers, with or without a +86 prefix.
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, '[redacted-phone]')
    // Grouped international numbers such as +1 415 555 0100.
    .replace(/(?<!\d)\+?\d{1,3}[-\s]\d{3,4}[-\s]\d{4}(?!\d)/g, '[redacted-phone]')
}

/**
 * One bounded, redacted line. Applied to every field of every user-level
 * record, so a caller cannot bypass redaction by writing a decision instead of
 * a note.
 *
 * @param {unknown} value - source text.
 * @param {number} [limit] - maximum characters.
 * @returns {string} a clean single line.
 */
export function sanitizeUserText(value, limit) {
  return cleanText(redactPhones(String(value ?? '')), limit)
}

function categoryOf(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'facts') return 'fact'
  if (text === 'preferences') return 'preference'
  if (text === 'decisions') return 'decision'
  return USER_MEMORY_CATEGORIES.includes(text) ? text : null
}

/**
 * The searchable projection of a decision. Scoring works on `key`, `tags` and
 * `text`, so a decision has to present its rationale as its text: a search for
 * "sqlite" must find the decision that rejected it, not only the choice.
 *
 * @param {object} record - a decision record.
 * @returns {string} key and rationale joined into one line.
 */
function decisionText(record) {
  return [record.choice, record.rejected, record.reason, record.rollback].filter(Boolean).join('; ')
}

function normalizeRecord(category, item) {
  if (!item || typeof item !== 'object') return null
  const tags = normalizeTags(item.tags)
  if (category === 'decision') {
    const choice = sanitizeUserText(item.choice, MAX_CHOICE_CHARS)
    const rejected = sanitizeUserText(item.rejected, MAX_REJECTED_CHARS)
    const reason = sanitizeUserText(item.reason, MAX_REASON_CHARS)
    const rollback = sanitizeUserText(item.rollback, MAX_ROLLBACK_CHARS)
    // A decision without its rationale is exactly the note this module exists
    // to avoid, so it is refused rather than stored as a bare conclusion.
    if (!choice || !reason) return null
    const key = slugKey(item.key) || slugKey(choice) || `decision-${randomBytes(3).toString('hex')}`
    return { key, category, choice, rejected, reason, rollback, tags }
  }
  const text = sanitizeUserText(item.text)
  if (!text) return null
  const key = slugKey(item.key) || slugKey(text.slice(0, 48)) || `${category}-${randomBytes(3).toString('hex')}`
  return { key, category, text, tags }
}

function tsOf(record) {
  const value = Date.parse(record?.ts ?? '')
  return Number.isFinite(value) ? value : 0
}

function msOf(value) {
  if (value === undefined || value === null || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Resolve raw lines into live records: a newer record with the same key wins,
 * and records older than the TTL are ignored. There is no tombstone here —
 * forgetting rewrites the file — so this is only supersession plus age.
 *
 * @param {object[]} records - parsed lines.
 * @param {{ now?: number, maxAgeDays?: number }} [options] - clock and TTL.
 * @returns {object[]} active records, newest first.
 */
export function effectiveUserRecords(records, { now = Date.now(), maxAgeDays = USER_MEMORY_DEFAULTS.maxAgeDays } = {}) {
  const active = new Map()
  const ordered = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record && typeof record === 'object' && typeof record.key === 'string')
    .sort((a, b) => (tsOf(a.record) - tsOf(b.record)) || (a.index - b.index))
  for (const { record, index } of ordered) active.set(record.key, { record, index })
  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 86400000 : -Infinity
  return [...active.values()]
    .filter(({ record }) => tsOf(record) >= cutoff)
    .sort((a, b) => (tsOf(b.record) - tsOf(a.record)) || (b.index - a.index))
    .map(({ record }) => record)
}

/**
 * Pull the fenced `user-memory` block out of an aggregator report.
 *
 * The block is removed whether or not it parses, because it is plugin syntax
 * the user did not ask to see. A malformed block is reported through `error`
 * so the run record can say why nothing was stored.
 *
 * @param {unknown} text - final report.
 * @returns {{ report: string, found: boolean, error?: string, block: { facts: object[], preferences: object[], decisions: object[] } }}
 */
export function extractUserMemoryBlock(text) {
  const empty = { facts: [], preferences: [], decisions: [] }
  if (typeof text !== 'string' || !text) return { report: typeof text === 'string' ? text : '', found: false, block: empty }
  const match = USER_MEMORY_FENCE.exec(text)
  if (!match) return { report: text, found: false, block: empty }
  const report = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  let parsed
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return { report, found: true, error: 'the user-memory block was not valid JSON', block: empty }
  }
  const list = key => (Array.isArray(parsed?.[key]) ? parsed[key] : [])
  const block = { facts: list('facts'), preferences: list('preferences'), decisions: list('decisions') }
  if (block.facts.length + block.preferences.length + block.decisions.length === 0) {
    return { report, found: true, error: 'the user-memory block had no usable entry', block }
  }
  return { report, found: true, block }
}

/**
 * Build the user-level profile bound to one state root.
 *
 * @param {string} root - absolute state directory (`<root>/user-memory` is used).
 * @param {object} [options] - collaborators.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @param {() => number} [options.now] - clock, injectable for tests.
 */
export function createUserMemory(root, { warn = () => {}, now = () => Date.now() } = {}) {
  const dir = path.join(root, 'user-memory')
  const fileOf = category => path.join(dir, CATEGORY_FILES[category])
  const lockOf = category => path.join(dir, `${category}.lock`)
  /** Per-category write chain, so two records in this process cannot interleave. */
  const chains = new Map()

  async function initDir() {
    await fsp.mkdir(dir, { recursive: true })
    const ignore = path.join(dir, '.gitignore')
    try {
      await fsp.access(ignore)
    } catch {
      await fsp.writeFile(ignore, '*\n', 'utf8')
    }
  }

  function serialize(category, task) {
    const previous = chains.get(category) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    chains.set(category, next.catch(() => {}))
    return next
  }

  async function readRecords(category) {
    let text
    try {
      text = await fsp.readFile(fileOf(category), 'utf8')
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
        bad++
      }
    }
    return { records, bad, bytes: Buffer.byteLength(text, 'utf8') }
  }

  /** Rewrite one category file with an exact set of records, under its lock. */
  async function rewriteLocked(category, records) {
    const file = fileOf(category)
    const body = records.map(record => `${JSON.stringify(record)}\n`).join('')
    const tmp = path.join(dir, `.${category}.${process.pid}.${Date.now()}.tmp`)
    await fsp.writeFile(tmp, body, 'utf8')
    await fsp.rename(tmp, file)
  }

  async function compactLocked(category, { maxEntries, maxAgeDays }) {
    try {
      const { records } = await readRecords(category)
      const keep = effectiveUserRecords(records, { now: now(), maxAgeDays })
        .slice(0, maxEntries)
        .reverse()
      await rewriteLocked(category, keep)
      return true
    } catch (error) {
      warn(`cannot compact user memory category "${category}": ${error?.message ?? error}`)
      return false
    }
  }

  async function appendLocked(category, records) {
    if (records.length === 0) return 0
    const file = fileOf(category)
    await initDir()
    const body = records.map(record => `${JSON.stringify(record)}\n`).join('')
    const handle = await fsp.open(file, 'a')
    try {
      await handle.write(body)
    } finally {
      await handle.close()
    }
    return records.length
  }

  /**
   * Write a batch into one category. Exposed through the per-category helpers
   * below so a caller cannot pass a category that has no file.
   */
  async function writeCategory(category, entries, { runId = null, maxEntries = USER_MEMORY_DEFAULTS.maxEntries, maxAgeDays = USER_MEMORY_DEFAULTS.maxAgeDays } = {}) {
    const normalized = (Array.isArray(entries) ? entries : [])
      .map(item => normalizeRecord(category, item))
      .filter(Boolean)
    if (normalized.length === 0) return { written: 0, reason: 'no usable entry' }
    return serialize(category, async () => {
      await initDir()
      const release = await acquireFileLock(lockOf(category), {
        now,
        retries: LOCK_RETRIES,
        retryDelayMs: LOCK_RETRY_DELAY_MS,
      })
      if (!release) warn(`user memory category "${category}" is locked by another process; appended without compaction`)
      try {
        const ts = new Date(now()).toISOString()
        const batch = normalized.map(entry => ({
          v: 1,
          id: randomBytes(4).toString('hex'),
          ts,
          runId: runId ?? null,
          ...entry,
        }))
        const written = await appendLocked(category, batch)
        let bytes = 0
        try {
          bytes = (await fsp.stat(fileOf(category))).size
        } catch {
          // A missing stat only means compaction cannot be sized this round.
        }
        const { records } = await readRecords(category)
        const total = records.length + batch.length
        if (release && (bytes > MAX_FILE_BYTES || total > MAX_FILE_LINES || total > maxEntries)) {
          await compactLocked(category, { maxEntries, maxAgeDays })
        }
        return { written, reason: null }
      } finally {
        await release?.()
      }
    })
  }

  /** Search one category. Never reads another category's file. */
  async function recallCategory(category, {
    query = '',
    tags = [],
    maxEntries = USER_MEMORY_DEFAULTS.digestEntries,
    maxAgeDays = USER_MEMORY_DEFAULTS.maxAgeDays,
  } = {}) {
    const at = now()
    const { records } = await readRecords(category)
    const entries = effectiveUserRecords(records, { now: at, maxAgeDays })
    const wanted = normalizeTags(tags)
    const text = typeof query === 'string' ? query : ''
    const searching = text.trim().length > 0 || wanted.length > 0
    const scored = entries.map(record => {
      const view = category === 'decision'
        ? { key: record.key, tags: record.tags, ts: record.ts, text: decisionText(record) }
        : record
      return { record, ...scoreEntry(view, { query: text, tags: wanted, now: at }) }
    })
    const hits = searching ? scored.filter(item => item.keyword > 0 || item.tag > 0) : scored
    hits.sort((a, b) => b.score - a.score)
    return {
      category,
      searching,
      total: entries.length,
      matched: hits.length,
      entries: hits.slice(0, Math.max(1, maxEntries)).map(({ record, score, keyword, tag, ageDays, matchedTerms }) => ({
        key: record.key,
        category,
        ...(category === 'decision'
          ? {
              choice: record.choice ?? '',
              rejected: record.rejected ?? '',
              reason: record.reason ?? '',
              rollback: record.rollback ?? '',
            }
          : { text: record.text ?? '' }),
        tags: normalizeTags(record.tags),
        score,
        keyword,
        tag,
        ageDays,
        matchedTerms,
        source: { runId: record.runId ?? null, ts: record.ts ?? null },
      })),
    }
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
     * Record one fact, preference or decision.
     * @param {object} options - `category` plus the fields that category needs.
     */
    async record({ category, entry, runId = null, maxEntries, maxAgeDays } = {}) {
      const key = categoryOf(category)
      if (!key) return { written: 0, reason: `category must be one of ${USER_MEMORY_CATEGORIES.join(', ')}` }
      return writeCategory(key, [entry], { runId, maxEntries, maxAgeDays })
    },

    /**
     * Store the three lists of a parsed `user-memory` block.
     * @param {{ runId: string, block: { facts?: object[], preferences?: object[], decisions?: object[] }, maxEntries?: number, maxAgeDays?: number }} options - block.
     * @returns {Promise<{ fact: number, preference: number, decision: number, skipped: number }>}
     */
    async writeBlock({ runId = null, block = {}, maxEntries, maxAgeDays } = {}) {
      const result = { fact: 0, preference: 0, decision: 0, skipped: 0 }
      const jobs = [
        ['fact', block.facts],
        ['preference', block.preferences],
        ['decision', block.decisions],
      ]
      for (const [category, items] of jobs) {
        if (!Array.isArray(items) || items.length === 0) continue
        const written = await writeCategory(category, items, { runId, maxEntries, maxAgeDays })
        result[category] += written.written
        result.skipped += items.length - written.written
      }
      return result
    },

    /**
     * Search one category.
     * @param {{ category: string, query?: string, tags?: unknown, maxEntries?: number, maxAgeDays?: number }} options - query.
     */
    async recall({ category, query = '', tags = [], maxEntries, maxAgeDays } = {}) {
      const key = categoryOf(category)
      if (!key) return { category: null, searching: false, total: 0, matched: 0, entries: [], reason: 'unknown category' }
      return recallCategory(key, { query, tags, maxEntries, maxAgeDays })
    },

    /**
     * Bounded, category-labelled digest for prompts. Facts, preferences and
     * decisions are printed under separate headings, and a decision line always
     * carries what was rejected, why, and how to roll back.
     *
     * @param {{ query?: string, maxEntries?: number, maxChars?: number, maxAgeDays?: number, categories?: string[] }} [options] - digest.
     * @returns {Promise<string>} digest text, or an empty string.
     */
    async digest({
      query = '',
      maxEntries = USER_MEMORY_DEFAULTS.digestEntries,
      maxChars = USER_MEMORY_DEFAULTS.digestChars,
      maxAgeDays = USER_MEMORY_DEFAULTS.maxAgeDays,
      categories = USER_MEMORY_CATEGORIES,
    } = {}) {
      const wanted = categories.map(categoryOf).filter(Boolean)
      const headings = { fact: 'Facts', preference: 'Preferences', decision: 'Decisions (with rationale)' }
      const sections = []
      const share = Math.max(120, Math.floor(maxChars / Math.max(1, wanted.length)))
      for (const category of wanted) {
        const recalled = await recallCategory(category, { query, maxEntries, maxAgeDays })
        let items = recalled.entries
        if (items.length === 0 && recalled.searching) {
          // An unfamiliar goal must not hide who the user is: fall back to the
          // newest entries, exactly as the run notebook does.
          const { records } = await readRecords(category)
          items = effectiveUserRecords(records, { now: now(), maxAgeDays })
            .slice(0, maxEntries)
            .map(record => ({
              ...record,
              ageDays: (now() - tsOf(record)) / 86400000,
            }))
        }
        if (items.length === 0) continue
        const lines = []
        let used = 0
        for (const item of items.slice(0, maxEntries)) {
          const age = Number.isFinite(item.ageDays) ? `${Math.max(0, Math.floor(item.ageDays))}d` : '?'
          const body = category === 'decision'
            ? `chose ${item.choice}; rejected ${item.rejected || 'nothing recorded'}; `
              + `why ${item.reason}; rollback ${item.rollback || 'not recorded'}`
            : item.text
          const line = `- [${age}] ${category} ${item.key} `
            + `(run ${item.source?.runId ?? item.runId ?? 'manual'}, `
            + `${String(item.source?.ts ?? item.ts ?? '').slice(0, 10)}): ${body}`
          if (used + line.length + 1 > share) break
          lines.push(line)
          used += line.length + 1
        }
        if (lines.length > 0) sections.push(`${headings[category]}:\n${lines.join('\n')}`)
      }
      const text = sections.join('\n\n')
      return text.length > maxChars ? `${[...text].slice(0, Math.max(0, maxChars - 1)).join('')}…` : text
    },

    /**
     * Physical deletion. At least one filter is required, and only matching
     * lines are rewritten away — there is no tombstone left behind, so a later
     * search cannot observe the deleted value.
     *
     * @param {{ key?: string, runId?: string, before?: string | number | Date, after?: string | number | Date, category?: string }} [options] - filters.
     * @returns {Promise<{ deleted: number, categories: string[], reason: string | null }>}
     */
    async forget({ key, runId, before, after, category } = {}) {
      const slug = key === undefined || key === null || key === '' ? null : slugKey(key)
      const run = typeof runId === 'string' && runId.trim() ? runId.trim() : null
      const from = msOf(after)
      const to = msOf(before)
      if (!slug && !run && from === null && to === null) {
        return { deleted: 0, categories: [], reason: 'a key, a run id, or a time range is required' }
      }
      if ((after !== undefined && from === null) || (before !== undefined && to === null)) {
        return { deleted: 0, categories: [], reason: 'before/after must be a date or a timestamp' }
      }
      const targets = category ? [categoryOf(category)].filter(Boolean) : [...USER_MEMORY_CATEGORIES]
      if (targets.length === 0) return { deleted: 0, categories: [], reason: 'unknown category' }
      const match = record => {
        if (slug && record.key !== slug) return false
        if (run && record.runId !== run) return false
        const ts = tsOf(record)
        if (from !== null && ts < from) return false
        if (to !== null && ts > to) return false
        return true
      }
      let deleted = 0
      const touched = []
      for (const target of targets) {
        const count = await serialize(target, async () => {
          await initDir()
          const release = await acquireFileLock(lockOf(target), {
            now,
            retries: LOCK_RETRIES,
            retryDelayMs: LOCK_RETRY_DELAY_MS,
          })
          if (!release) warn(`user memory category "${target}" is locked by another process; deleting without hands-off compaction`)
          try {
            const { records } = await readRecords(target)
            const keep = records.filter(record => !match(record))
            const removed = records.length - keep.length
            if (removed > 0) await rewriteLocked(target, keep)
            return removed
          } finally {
            await release?.()
          }
        })
        if (count > 0) {
          deleted += count
          touched.push(target)
        }
      }
      return { deleted, categories: touched, reason: null }
    },

    /**
     * Every live record in one category, newest first.
     * @param {{ category: string, limit?: number, maxAgeDays?: number }} options - read.
     */
    async list({ category, limit = 50, maxAgeDays = USER_MEMORY_DEFAULTS.maxAgeDays } = {}) {
      const key = categoryOf(category)
      if (!key) return { category: null, entries: [], total: 0, path: dir }
      const { records } = await readRecords(key)
      const entries = effectiveUserRecords(records, { now: now(), maxAgeDays })
      return { category: key, entries: entries.slice(0, limit), total: entries.length, path: fileOf(key) }
    },

    /** Active counts per category, for status lines and tests. */
    async stats({ maxAgeDays = USER_MEMORY_DEFAULTS.maxAgeDays } = {}) {
      const counts = {}
      for (const category of USER_MEMORY_CATEGORIES) {
        const { records } = await readRecords(category)
        counts[category] = effectiveUserRecords(records, { now: now(), maxAgeDays }).length
      }
      return { ...counts, total: counts.fact + counts.preference + counts.decision, path: dir }
    },

    defaults: USER_MEMORY_DEFAULTS,
  }
}
