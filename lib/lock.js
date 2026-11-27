import fsp from 'node:fs/promises'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

export const DEFAULT_STALE_MS = 30 * 1000

export function pidAlive(pid) {
  const number = Number(pid)
  if (!Number.isInteger(number) || number <= 0) return null
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function readPayload(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeExclusive(file, content) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fsp.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.link(temporary, file)
        return
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
        await new Promise(resolve => setTimeout(resolve, 20 * attempt))
      }
    }
  } finally {
    await fsp.unlink(temporary).catch(() => {})
  }
}

function staleState(payload, { staleMs, now, reclaimDead, reclaimStale = true }) {
  const age = now() - Date.parse(payload?.at ?? '')
  const local = payload?.hostname === os.hostname()
  const alive = local && pidAlive(payload?.pid) === true
  const dead = reclaimDead && local && pidAlive(payload?.pid) === false
  const expired = reclaimStale && (!Number.isFinite(age) || age > staleMs)
  return { alive, stale: dead || (expired && !alive) }
}

async function acquireBreakLock(file, options) {
  const breakFile = `${file}.break`
  const { retries, retryDelayMs, sleep } = options
  for (let round = 0; round <= Math.max(retries, 20); round++) {
    if (round > 0) await sleep(retryDelayMs)
    const payload = {
      pid: process.pid,
      hostname: os.hostname(),
      at: new Date(options.now()).toISOString(),
      token: randomUUID(),
    }
    try {
      await writeExclusive(breakFile, `${JSON.stringify(payload)}\n`)
      return async () => {
        const current = await readPayload(breakFile)
        if (current?.token !== payload.token) return
        try {
          await fsp.unlink(breakFile)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      const current = await readPayload(breakFile)
      if (!current) {
        try { await fsp.access(breakFile) } catch (error) { if (error?.code === 'ENOENT') continue; throw error }
        throw new Error(`stale lock breaker ${breakFile}; remove it only after confirming its holder is gone`)
      }
      if (!staleState(current, options).stale) continue
      try { await fsp.unlink(breakFile) } catch (error) { if (error?.code !== 'ENOENT') throw error }
      continue
    }
  }
  return null
}

export async function releaseFileLock(file, token, options = {}) {
  const expected = options.expected
  if (!token && !expected) return false
  const releaseBreak = await acquireBreakLock(file, {
    staleMs: DEFAULT_STALE_MS,
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    reclaimDead: true,
    ...options,
    retries: 20,
    retryDelayMs: 5,
  })
  if (!releaseBreak) throw new Error(`cannot release ${file}: its lock breaker is busy`)
  try {
    const current = await readPayload(file)
    const matches = token
      ? current?.token === token
      : current && current.pid === expected.pid && current.hostname === expected.hostname && current.at === expected.at
    if (!matches) return true
    try {
      await fsp.unlink(file)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw error
    }
  } finally {
    await releaseBreak().catch(() => {})
  }
}

export async function acquireFileLock(
  file,
  {
    staleMs = DEFAULT_STALE_MS,
    now = () => Date.now(),
    retries = 0,
    retryDelayMs = 50,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    reclaimDead = true,
    reclaimStale = true,
    holder = null,
  } = {},
) {
  const options = { staleMs, now, retries, retryDelayMs, sleep, reclaimDead, reclaimStale }
  for (let round = 0; round <= retries; round++) {
    if (round > 0) await sleep(retryDelayMs)
    let contended = false
    const payload = {
      pid: holder?.pid ?? process.pid,
      hostname: holder?.hostname ?? os.hostname(),
      at: holder?.at ?? new Date(now()).toISOString(),
      token: randomUUID(),
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeExclusive(file, `${JSON.stringify(payload)}\n`)
        return async () => {
          await releaseFileLock(file, payload.token, options)
        }
      } catch (error) {
        if (error?.code !== 'EEXIST') return null
        const existing = await readPayload(file)
        if (!staleState(existing, options).stale) {
          contended = true
          break
        }
        const releaseBreak = await acquireBreakLock(file, { ...options, reclaimStale: true, retries: 0 })
        if (!releaseBreak) {
          contended = true
          break
        }
        try {
          const current = await readPayload(file)
          if (!current) continue
          if (!staleState(current, options).stale) {
            contended = true
            break
          }
          try {
            await fsp.unlink(file)
          } catch (error) {
            if (error?.code !== 'ENOENT') return null
          }
        } finally {
          await releaseBreak().catch(() => {})
        }
      }
    }
    if (!contended) return null
  }
  return null
}
