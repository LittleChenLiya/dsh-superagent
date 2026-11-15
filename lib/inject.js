/**
 * Live delivery of one instruction into a running child agent.
 *
 * The host has four input boundaries on an Agent: `send`, `followup`, `steer`,
 * and `inject` (dsh-agent `runtime-types.d.ts`). `steer` is the one this module
 * uses: the running driver claims it at its next pre-step, so the message is
 * part of the child's next model request. When a steer arrives after the child
 * already decided to stop, `agent-loop` sees a non-empty next-step inbox and
 * runs one more turn instead of closing (`index.js`, turn loop) — so a live,
 * uncancelled child always consumes it.
 *
 * Two host faces reach that inbox:
 *   1. `subagents.sendMessage(parent, childId, content, { signal })` — the
 *      documented, admission-checked path between adjacent Agents. Preferred.
 *   2. `agent.steer(message)` on the live child — the Agent API itself, used
 *      only when the service method is absent (a host built without it).
 *
 * Delivery is async: it lands at a step boundary, never in the middle of a
 * model call. The watcher below measures that boundary by polling the child's
 * inbox projection; `INJECT_POLL_MS` is the resolution of every measured
 * figure, so it is reported with the number instead of hidden.
 *
 * @module dsh-superagent/inject
 */
import { randomUUID } from 'node:crypto'

/** Default poll period, in milliseconds, for the inbox claim. */
export const INJECT_POLL_MS = 25

/**
 * The ids still waiting at either inbox boundary of one live child.
 * @param {object | null | undefined} agent - live child Agent.
 * @returns {Set<string>} pending message ids.
 */
export function pendingIds(agent) {
  const ids = new Set()
  const inbox = agent?.inbox
  for (const list of [inbox?.nextStep, inbox?.nextTurn]) {
    for (const message of list ?? []) {
      if (message?.id !== undefined) ids.add(String(message.id))
    }
  }
  return ids
}

/**
 * Build the host-facing steer function.
 *
 * `subagents` and `agents` are getters, not services, because the subagent
 * service can register after this plugin and can disappear while the host
 * shuts down; reading it at call time keeps both states observable.
 *
 * @param {object} deps - host accessors.
 * @param {() => object | undefined} deps.getSubagents - current subagent service.
 * @param {() => object | undefined} deps.getAgents - current agent registry.
 * @param {(message: string) => void} [deps.log]
 * @returns {(spec: { parent: object, childId: string, text: string, signal?: AbortSignal }) => Promise<{ messageId: string, via: string }>}
 */
export function createChildSteerer({ getSubagents, getAgents, log = () => {} }) {
  return async function steerChild({ parent, childId, text, signal }) {
    const service = typeof getSubagents === 'function' ? getSubagents() : undefined
    const registry = typeof getAgents === 'function' ? getAgents() : undefined
    const live = registry && typeof registry.get === 'function' ? registry.get(childId) : undefined
    if (!live) {
      const error = new Error(
        `child session ${childId} is no longer live in this host, so no inbox exists to carry the instruction`,
      )
      error.code = 'inject-child-gone'
      throw error
    }
    const content = [{ type: 'text', text }]
    const options = { signal: signal ?? new AbortController().signal }
    if (service && typeof service.sendMessage === 'function') {
      const messageId = await service.sendMessage(parent, childId, content, options)
      return { messageId: String(messageId), via: 'subagents.sendMessage' }
    }
    if (typeof live.steer === 'function') {
      const messageId = `inject-${randomUUID()}`
      live.steer({ id: messageId, role: 'user', content, source: { kind: 'user' } })
      return { messageId, via: 'agent.steer' }
    }
    const error = new Error(
      'this host exposes no live channel into a running child: neither subagents.sendMessage nor Agent.steer exists',
    )
    error.code = 'inject-unsupported'
    log(`live injection is unsupported by this host: ${error.message}`)
    throw error
  }
}

/**
 * Watch one accepted message until it leaves the child's inbox or the child
 * disappears.
 *
 * Absence from the inbox is the claim signal: the step boundary removes the
 * message before building its model request. The same absence also appears if
 * the activation is cancelled or disposed, so the caller passes that evidence
 * (`onGone`, or a run-level abort check) rather than assuming delivery.
 *
 * @param {object} deps - watcher dependencies.
 * @param {(childId: string) => object | null | undefined} deps.resolveChild - live child lookup.
 * @param {number} [deps.intervalMs] - poll period, defaults to `INJECT_POLL_MS`.
 * @param {() => number} [deps.now] - clock, injectable for tests.
 * @returns {(childId: string, messageId: string, handlers: { onClaimed?: (at: number) => void, onGone?: () => void }) => { stop: () => void, check: () => void }}
 */
export function createChildWatcher({ resolveChild, intervalMs = INJECT_POLL_MS, now = () => Date.now() }) {
  const period = Math.max(5, Number(intervalMs) || INJECT_POLL_MS)
  return function watch(childId, messageId, handlers = {}) {
    let timer = null
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
    }
    const check = () => {
      if (stopped) return
      let agent = null
      try {
        agent = resolveChild(childId)
      } catch {
        agent = null
      }
      if (!agent) {
        stop()
        handlers.onGone?.()
        return
      }
      if (pendingIds(agent).has(String(messageId))) return
      stop()
      handlers.onClaimed?.(now())
    }
    timer = setInterval(check, period)
    timer.unref?.()
    return { stop, check }
  }
}
