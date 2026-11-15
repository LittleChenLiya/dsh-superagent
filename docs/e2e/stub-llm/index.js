/**
 * Deterministic in-process model for the end-to-end harness in `docs/e2e`.
 *
 * This package is never published (it is not in the npm `files` list). It
 * exists so the real DSH host, its real subagent service, its real session
 * logs, and the real `dsh-superagent` plugin can be exercised on a machine
 * with no model credential. It is an OpenAI-free Cordis plugin: it registers
 * the `e2e-stub` route on the host's `llm` service and streams fixed chunks.
 *
 * Behaviour is selected by markers in the task text (`[e2e:start-wait]`, …)
 * and by the role prompts `dsh-superagent` writes. Nothing here imports the
 * plugin under test; the only contract is the host's LLM seam.
 */

export const name = 'dsh-e2e-stub-llm'
export const inject = ['llm']

const PLANNER_MARK = 'You are the planner for a long-horizon autonomous run.'
const WORKER_MARK = 'You are one worker in a long-horizon autonomous run.'
const AGGREGATOR_MARK = 'You are the aggregator of a long-horizon autonomous run.'

const GOAL = 'Compare two sorting strategies on the stub fixture and report one number for each.'

function textOf(message) {
  return (message?.content ?? [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function allText(messages) {
  return messages.map(textOf).join('\n')
}

function lastToolText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'tool') return textOf(message)
  }
  return ''
}

function runIdFrom(text) {
  const match = /\brun (\d{8}T\d{6}-[0-9a-f]{4})\b/.exec(text)
  return match ? match[1] : null
}

function delay(ms) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}

function workerDelay(title) {
  const base = Number(process.env.E2E_WORKER_DELAY_MS ?? 300)
  const alpha = Number(process.env.E2E_ALPHA_DELAY_MS ?? Math.min(base, 300))
  return title === 'Alpha' ? alpha : base
}

function usageChunk(inputTokens, outputTokens, cacheReadTokens = 0) {
  return { type: 'usage', usage: { inputTokens, outputTokens, cacheReadTokens } }
}

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
}

function* toolChunks(id, tool, args) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: JSON.stringify(args) }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: JSON.stringify(args) } }
}

function planText() {
  return JSON.stringify({
    subtasks: [
      {
        title: 'Alpha',
        prompt: 'Measure sorting strategy A on the stub fixture. Report the single number you measured and how you measured it.',
      },
      {
        title: 'Beta',
        prompt: 'Measure sorting strategy B on the stub fixture. Report the single number you measured and how you measured it.',
      },
    ],
  })
}

function workerText(prompt) {
  const match = /Your assigned subtask \(([^)]+)\)/.exec(prompt)
  const title = match ? match[1] : 'Unknown'
  return [
    `## ${title}`,
    `${title.toUpperCase()}-REPORT: measured ${title === 'Alpha' ? 3 : 7} operations on the stub fixture.`,
    `method: deterministic stub, subtask ${title}`,
  ].join('\n')
}

class StubAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'E2E Stub Model' }
  }

  providerRetryPolicy() {
    return undefined
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
  }

  async * stream(options) {
    const messages = options?.messages ?? []
    const text = allText(messages)
    const toolResults = messages.filter(message => message?.role === 'tool')

    if (text.includes(PLANNER_MARK)) {
      await delay(30)
      yield* textChunks(planText())
      yield usageChunk(120, 30)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (text.includes(WORKER_MARK)) {
      const title = /Your assigned subtask \(([^)]+)\)/.exec(text)?.[1] ?? 'Beta'
      if (process.env.E2E_CHILD_ATTEMPT === '1' && title === 'Alpha' && !toolResults.length) {
        // Try to start a nested run from inside a worker. Whatever the host
        // answers (refused, or unknown tool) is reported by the worker.
        yield* toolChunks('call-child-start', 'superagent_start', { goal: 'nested run from a child' })
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (process.env.E2E_INJECT === '1' && title === 'Alpha' && !toolResults.length) {
        // Hold the step open long enough for the parent to inject mid-flight,
        // then take one tool step so a second pre-step really exists.
        await delay(Number(process.env.E2E_INJECT_STEP_MS ?? 4000))
        yield* toolChunks('call-child-list', 'superagent_list', {})
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (process.env.E2E_INJECT === '1' && title === 'Alpha') {
        const seen = /INJECT-MARKER/.test(text) ? 'yes' : 'no'
        yield* textChunks(`ALPHA-REPORT: measured 3 operations.\nINJECT-SEEN: ${seen}`)
        yield usageChunk(400, 100, 64)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      await delay(workerDelay(title))
      const attempt = process.env.E2E_CHILD_ATTEMPT === '1' && title === 'Alpha'
      yield* textChunks(attempt ? `CHILD-ATTEMPT-RESULT: ${lastToolText(messages)}` : workerText(text))
      yield usageChunk(400, 100, 64)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (text.includes(AGGREGATOR_MARK)) {
      await delay(30)
      const parts = ['FINAL REPORT: both strategies were measured.']
      if (text.includes('ALPHA-REPORT')) parts.push('Alpha: 3 operations.')
      if (text.includes('BETA-REPORT')) parts.push('Beta: 7 operations.')
      // The real aggregator writes its notebook in a fenced block; mirror that
      // shape only when the harness asks, so the default transcript stays clean.
      if (process.env.E2E_MEMORY_NOTE) {
        parts.push('', '```memory', JSON.stringify({
          entries: [{
            key: process.env.E2E_MEMORY_KEY ?? 'stub-next-step',
            kind: 'next',
            text: process.env.E2E_MEMORY_NOTE,
          }],
        }), '```')
      }
      yield* textChunks(parts.join('\n'))
      yield usageChunk(500, 120)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // Main session: drive one superagent tool sequence per task marker.
    const kind = /\[e2e:([a-z-]+)/.exec(text)?.[1] ?? 'plain'
    const step = toolResults.length
    if (kind === 'start-wait') {
      if (step === 0) {
        yield* toolChunks('call-start-wait', 'superagent_start', { goal: GOAL, wait_seconds: 150 })
        yield usageChunk(60, 12)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textChunks(`stub finished: ${lastToolText(messages).split('\n').slice(0, 4).join(' | ')}`)
      yield usageChunk(80, 16)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'budget') {
      if (step === 0) {
        yield* toolChunks('call-start-budget', 'superagent_start', {
          goal: GOAL, max_subtasks: 4, max_parallel: 2, wait_seconds: 150,
        })
        yield usageChunk(60, 12)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textChunks(`stub finished: ${lastToolText(messages).split('\n').slice(0, 4).join(' | ')}`)
      yield usageChunk(80, 16)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'exit') {
      if (step === 0) {
        yield* toolChunks('call-start-exit', 'superagent_start', {
          goal: GOAL, max_subtasks: 2, max_parallel: 2, wait_seconds: 0,
        })
        yield usageChunk(60, 12)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      await delay(Number(process.env.E2E_EXIT_DELAY_MS ?? 1500))
      yield* textChunks(`run started in the background: ${runIdFrom(lastToolText(messages)) ?? 'unknown'}`)
      yield usageChunk(20, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'cancel') {
      if (step === 0) {
        yield* toolChunks('call-start-cancel', 'superagent_start', {
          goal: GOAL, max_subtasks: 2, max_parallel: 2, wait_seconds: 0,
        })
        yield usageChunk(60, 12)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (step === 1) {
        const runId = runIdFrom(lastToolText(messages))
        if (runId) {
          await delay(Number(process.env.E2E_CANCEL_DELAY_MS ?? 1200))
          globalThis.__cancelAt = Date.now()
          yield* toolChunks('call-cancel', 'superagent_cancel', { run_id: runId })
          yield usageChunk(40, 8)
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
      }
      const latency = globalThis.__cancelAt ? `cancel tool returned after ${Date.now() - globalThis.__cancelAt}ms; ` : ''
      yield* textChunks(`${latency}cancel sequence finished: ${lastToolText(messages)}`)
      yield usageChunk(20, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'notify') {
      if (step === 0) {
        yield* toolChunks('call-start-notify', 'superagent_start', {
          goal: GOAL, max_subtasks: 2, max_parallel: 2, wait_seconds: 0,
        })
        yield usageChunk(60, 12)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (step === 1) {
        // Stay in the turn without polling, so the run settles while the
        // session is still live and notify has to use followup().
        await delay(Number(process.env.E2E_NOTIFY_WAIT_MS ?? 3000))
        yield* toolChunks('call-list', 'superagent_list', {})
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textChunks(`notify sequence finished: ${lastToolText(messages)}`)
      yield usageChunk(20, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'inject') {
      if (step === 0) {
        yield* toolChunks('call-start-inject', 'superagent_start', {
          goal: GOAL, max_subtasks: 2, max_parallel: 2, wait_seconds: 0,
        })
        yield usageChunk(60, 12)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (step === 1) {
        const runId = runIdFrom(lastToolText(messages))
        await delay(Number(process.env.E2E_INJECT_DELAY_MS ?? 1200))
        globalThis.__injectIssued = Date.now()
        yield* toolChunks('call-inject', 'superagent_inject', {
          run_id: runId,
          message: 'INJECT-MARKER: cap Alpha at one measured number.',
          wait_seconds: 15,
        })
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const wall = globalThis.__injectIssued ? Date.now() - globalThis.__injectIssued : -1
      yield* textChunks(
        `INJECT-E2E: tool wall ${wall}ms\n${lastToolText(messages).split('\n').slice(0, 8).join('\n')}`,
      )
      yield usageChunk(20, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'memory') {
      if (step === 0) {
        yield* toolChunks('call-memory-list', 'superagent_memory', { action: 'list' })
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textChunks(lastToolText(messages))
      yield usageChunk(20, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'status') {
      const requested = /run=(\d{8}T\d{6}-[0-9a-f]{4})/.exec(text)?.[1] ?? null
      if (step === 0) {
        yield* toolChunks('call-status-only', 'superagent_status', { run_id: requested, wait_seconds: 150 })
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textChunks(lastToolText(messages))
      yield usageChunk(20, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (kind === 'resume') {
      const requested = /run=(\d{8}T\d{6}-[0-9a-f]{4})/.exec(text)?.[1] ?? null
      if (step === 0) {
        yield* toolChunks('call-status', 'superagent_status', { run_id: requested, wait_seconds: 0 })
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (step === 1 && /interrupted|failed/.test(lastToolText(messages))) {
        yield* toolChunks('call-resume', 'superagent_resume', { run_id: requested, wait_seconds: 150 })
        yield usageChunk(40, 8)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* textChunks(`resume sequence finished: ${lastToolText(messages)}`)
      yield usageChunk(20, 5)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    yield* textChunks('stub model: no scenario marker in this request')
    yield usageChunk(10, 2)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Mount the stub on the host's llm service.
 * @param {object} ctx - Cordis context carrying `llm`.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter(['e2e-stub'], new StubAdapter())
  console.error('[e2e-stub-llm] registered route e2e-stub')
}
