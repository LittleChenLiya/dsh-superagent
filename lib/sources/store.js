/**
 * Durable store for source deliveries and their bindings.
 *
 * Two identities are kept apart on purpose:
 *
 * - An event is keyed by `source:instance:deliveryId`. A redelivery from the
 *   same instance therefore resolves to the same record, which is what makes
 *   acknowledgement and recovery idempotent.
 * - A work object is keyed inside the event (`objectId`, e.g.
 *   `github:101:issue:7`) and is what a binding points at. Two repositories
 *   can both have issue #7 without sharing a binding.
 *
 * The file is replaced atomically under the package's advisory file lock. It
 * holds no credentials; secrets stay in the environment.
 *
 * @module dsh-superagent/sources-store
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { acquireFileLock } from '../lock.js'

const MAX_EVENTS = 5000
const MAX_BINDINGS = 500

async function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      if (attempt >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 25 * attempt))
    }
  }
}

const empty = () => ({ version: 1, instances: {}, events: {}, bindings: [], updatedAt: null })

function normalize(state) {
  const value = state && typeof state === 'object' ? state : empty()
  value.version = 1
  value.instances = value.instances && typeof value.instances === 'object' ? value.instances : {}
  value.events = value.events && typeof value.events === 'object' ? value.events : {}
  value.bindings = Array.isArray(value.bindings) ? value.bindings : []
  return value
}

export function bindingId({ source, instanceId, objectId }) {
  return createHash('sha256').update(`${source}:${instanceId}:${objectId}`).digest('hex').slice(0, 24)
}

/** Stable request id reused by every retry of the same delivery. */
export function requestIdFor(eventKey) {
  return `evt-${createHash('sha256').update(eventKey).digest('hex').slice(0, 40)}`
}

export function createSourceStore({ root, now = () => Date.now(), log = () => {} }) {
  const file = path.join(root, 'sources.json')
  let writes = Promise.resolve()

  async function read() {
    try {
      return normalize(JSON.parse(await fsp.readFile(file, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`sources: cannot read ${file}: ${error?.message ?? error}`)
      return empty()
    }
  }

  function mutate(update) {
    const write = writes.then(async () => {
      await fsp.mkdir(root, { recursive: true })
      const release = await acquireFileLock(`${file}.lock`, { retries: 30 })
      if (!release) throw new Error('来源记录暂时无法写入')
      try {
        const state = await read()
        if (!update(state)) return state
        state.updatedAt = new Date(now()).toISOString()
        const events = Object.entries(state.events)
        if (events.length > MAX_EVENTS) {
          const removable = events.filter(([, event]) => event.status !== 'registered' && event.status !== 'dispatching')
            .sort((left, right) => Number(left[1].at ?? 0) - Number(right[1].at ?? 0))
          for (const [key] of removable.slice(0, events.length - MAX_EVENTS)) delete state.events[key]
        }
        state.bindings = state.bindings.slice(-MAX_BINDINGS)
        const tmp = `${file}.${randomUUID()}.tmp`
        try {
          await fsp.writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
          await renameWithRetry(tmp, file)
        } finally {
          await fsp.unlink(tmp).catch(() => {})
        }
        return state
      } finally {
        await release()
      }
    })
    writes = write.catch(() => {})
    return write
  }

  return {
    file,
    read,
    async snapshot() {
      const state = await read()
      const counts = {}
      for (const event of Object.values(state.events)) {
        counts[event.status] = (counts[event.status] ?? 0) + 1
      }
      return {
        instances: state.instances,
        bindings: state.bindings.filter(binding => !binding.revokedAt).slice(-80),
        counts,
        recent: Object.values(state.events).sort((left, right) => Number(right.at ?? 0) - Number(left.at ?? 0)).slice(0, 20),
        updatedAt: state.updatedAt,
      }
    },
    async registerInstance(instance) {
      return mutate(state => {
        state.instances[`${instance.source}:${instance.instanceId}`] = {
          ...instance, registeredAt: state.instances[`${instance.source}:${instance.instanceId}`]?.registeredAt
            ?? new Date(now()).toISOString(),
        }
        return true
      })
    },
    /**
     * Persist a delivery before it is acknowledged. A replay returns the
     * existing record with `created: false`; the caller must not dispatch it
     * again.
     */
    async registerEvent(key, record) {
      let created = false
      let saved = null
      await mutate(state => {
        if (state.events[key]) {
          saved = state.events[key]
          return false
        }
        created = true
        saved = { ...record, key, at: now(), status: record.status ?? 'registered' }
        state.events[key] = saved
        return true
      })
      return { created, record: saved }
    },
    async updateEvent(key, patch) {
      return mutate(state => {
        const event = state.events[key]
        if (!event) return false
        Object.assign(event, patch, { updatedAt: new Date(now()).toISOString() })
        return true
      })
    },
    async getEvent(key) {
      return (await read()).events[key] ?? null
    },
    async pendingEvents(statuses = ['registered', 'dispatching']) {
      const state = await read()
      return Object.entries(state.events)
        .filter(([, event]) => statuses.includes(event.status))
        .sort((left, right) => Number(left[1].at ?? 0) - Number(right[1].at ?? 0))
        .map(([key, event]) => ({ key, ...event }))
    },
    async findBinding({ source, instanceId, objectId }) {
      const state = await read()
      return state.bindings.find(binding => !binding.revokedAt && binding.source === source
        && binding.instanceId === instanceId && binding.objectId === objectId) ?? null
    },
    async listBindings() {
      const state = await read()
      return state.bindings.filter(binding => !binding.revokedAt)
    },
    async putBinding(input) {
      const id = bindingId(input)
      let binding = null
      await mutate(state => {
        const existing = state.bindings.find(item => item.id === id)
        binding = {
          ...(existing ?? {}), ...input, id, source: input.source, instanceId: input.instanceId,
          objectId: input.objectId, revokedAt: null, createdAt: existing?.createdAt ?? new Date(now()).toISOString(),
        }
        if (existing) Object.assign(existing, binding)
        else state.bindings.push(binding)
        return true
      })
      return binding
    },
    async revokeBinding(id) {
      let binding = null
      await mutate(state => {
        binding = state.bindings.find(item => item.id === id && !item.revokedAt) ?? null
        if (!binding) return false
        binding.revokedAt = new Date(now()).toISOString()
        return true
      })
      return binding
    },
  }
}
