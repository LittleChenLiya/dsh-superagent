/**
 * Token accounting for child sessions.
 *
 * The subagent seam does not expose usage on a result, but every model call is
 * recorded in the child's durable session log. This module reads that log and
 * sums the recorded token counts, so a run reports measured numbers instead of
 * estimates.
 *
 * @module dsh-superagent/usage
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress every zstd frame in a buffer.
 *
 * Session logs append one frame per flush, and the one-shot API only decodes
 * the first frame, so frames are split on the zstd magic number and decoded
 * independently. A slice that fails to decode is counted and skipped.
 *
 * @param {Buffer} buffer - raw session file.
 * @returns {{ text: string, failed: number }} decoded UTF-8 text and failure count.
 */
function decodeFrames(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') return { text: '', failed: 1 }
  const starts = []
  let at = 0
  while ((at = buffer.indexOf(ZSTD_MAGIC, at)) !== -1) {
    starts.push(at)
    at += ZSTD_MAGIC.length
  }
  if (starts.length === 0) return { text: '', failed: 1 }
  const parts = []
  let failed = 0
  for (let index = 0; index < starts.length; index++) {
    const slice = buffer.subarray(starts[index], starts[index + 1] ?? buffer.length)
    try {
      parts.push(zlib.zstdDecompressSync(slice).toString('utf8'))
    } catch {
      failed++
    }
  }
  return { text: parts.join('\n'), failed }
}

/**
 * Sum usage events from one decoded session log.
 * @param {string} text - newline-delimited session events.
 */
function sumUsage(text) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    models: {},
  }
  for (const line of text.split('\n')) {
    if (!line || !line.includes('usage')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event?.data
    const recorded = data?.usage
    if (!recorded || typeof recorded !== 'object') continue
    const inputTokens = Number(recorded.inputTokens) || 0
    const outputTokens = Number(recorded.outputTokens) || 0
    if (inputTokens === 0 && outputTokens === 0) continue
    usage.inputTokens += inputTokens
    usage.outputTokens += outputTokens
    usage.cacheReadTokens += Number(recorded.cacheReadTokens) || 0
    usage.totalTokens += Number(recorded.totalTokens) || inputTokens + outputTokens
    usage.modelCalls++
    const source = data?.message?.source
    if (source?.kind === 'model') {
      const key = `${source.provider ?? '?'}/${source.model ?? '?'}`
      const entry = usage.models[key] ?? (usage.models[key] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 })
      entry.inputTokens += inputTokens
      entry.outputTokens += outputTokens
      entry.cacheReadTokens += Number(recorded.cacheReadTokens) || 0
      entry.calls++
    }
  }
  return usage
}

/**
 * Build a reader that maps a child session id to its recorded usage.
 *
 * @param {object} options - reader options.
 * @param {string} options.sessionsRoot - absolute `$DSH_HOME/sessions`.
 * @param {(message: string) => void} [options.warn] - diagnostics sink.
 * @returns {(childId: string) => Promise<object | null>} usage reader.
 */
export function createUsageReader({ sessionsRoot, warn = () => {} }) {
  /** @type {Map<string, string>} */
  const fileCache = new Map()

  async function locate(childId) {
    if (fileCache.has(childId)) return fileCache.get(childId)
    let workspaces
    try {
      workspaces = await fsp.readdir(sessionsRoot, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of workspaces) {
      if (!entry.isDirectory()) continue
      // Root sessions live in `session-<id>`; child sessions use the bare id.
      for (const folder of [`session-${childId}`, childId]) {
        const dir = path.join(sessionsRoot, entry.name, folder)
        let names
        try {
          names = await fsp.readdir(dir)
        } catch {
          continue
        }
        const file = names.find(name => name.startsWith('session.') && name.endsWith('.zstd'))
        if (!file) continue
        const resolved = path.join(dir, file)
        fileCache.set(childId, resolved)
        return resolved
      }
    }
    return null
  }

  return async function readUsage(childId) {
    if (!childId) return null
    const file = await locate(childId)
    if (!file) return null
    let buffer
    try {
      buffer = await fsp.readFile(file)
    } catch (error) {
      warn(`usage: cannot read session log for ${childId}: ${error?.message ?? error}`)
      return null
    }
    const { text, failed } = decodeFrames(buffer)
    if (failed > 0) warn(`usage: ${failed} session frame(s) failed to decode for ${childId}`)
    const usage = sumUsage(text)
    if (usage.modelCalls === 0) return null
    return usage
  }
}
