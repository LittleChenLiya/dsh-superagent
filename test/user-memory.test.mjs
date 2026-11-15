import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createUserMemory,
  effectiveUserRecords,
  extractUserMemoryBlock,
  redactPhones,
  sanitizeUserText,
} from '../lib/user-memory.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { apply } from '../lib/index.js'

const BASE_CONFIG = {
  maxSubtasks: 6,
  maxParallel: 3,
  maxActiveRuns: 2,
  attempts: 2,
  deadlineMinutes: 60,
  resultCapBytes: 32 * 1024,
  maxModelCallsPerRun: 0,
  maxTokensPerRun: 0,
}

async function withRoot(fn) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'superagent-user-memory-'))
  try {
    return await fn(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

function memoryStore() {
  const runs = new Map()
  return {
    runs,
    owner: null,
    async init() {},
    async list() { return [...runs.values()].map(run => structuredClone(run)) },
    async read(id) {
      const run = runs.get(id)
      return run ? structuredClone(run) : null
    },
    async write(run) { runs.set(run.id, structuredClone(run)) },
    async requestCancel() { return true },
    async hasCancelRequest() { return false },
    async clearCancel() {},
    async readOwner() { return null },
    async writeOwner() {},
    async acquireLock() { return { acquired: true, holder: null } },
    async readLock() { return null },
    async releaseLock() {},
  }
}

function completed(text) {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

function makeSpawner(handle) {
  let seq = 0
  const calls = []
  const spawnChild = async spec => {
    const childId = `child-${++seq}`
    calls.push({ label: spec.label, prompt: spec.prompt, childId })
    return {
      childId,
      result: Promise.resolve().then(() => handle(spec, childId)),
      dispose: async () => {},
    }
  }
  return { spawnChild, calls }
}

test('the three categories are stored and searched apart', async () => {
  await withRoot(async root => {
    const userMemory = createUserMemory(root)
    await userMemory.writeBlock({
      runId: 'run-1',
      block: {
        facts: [{ key: 'stack', text: 'the service is Node 24 with pnpm' }],
        preferences: [{ key: 'reporting', text: 'no progress pings; only the final result' }],
        decisions: [{
          key: 'package-manager',
          choice: 'pnpm',
          rejected: 'npm',
          reason: 'the repository already has a pnpm lockfile',
          rollback: 'delete pnpm-lock.yaml and run npm install',
        }],
      },
    })

    const facts = await userMemory.recall({ category: 'fact', query: 'pnpm lockfile' })
    assert.equal(facts.matched, 1)
    assert.equal(facts.entries[0].key, 'stack')
    assert.equal(facts.entries[0].text, 'the service is Node 24 with pnpm')

    const preferences = await userMemory.recall({ category: 'preference', query: 'pnpm lockfile' })
    assert.equal(preferences.matched, 0, 'a fact is never returned as a preference')

    const decisions = await userMemory.recall({ category: 'decision', query: 'pnpm lockfile' })
    assert.equal(decisions.matched, 1)
    assert.equal(decisions.entries[0].key, 'package-manager')

    // The files themselves are separate, so nothing relies on a filter alone.
    const files = await fsp.readdir(userMemory.dir)
    assert.ok(files.includes('facts.jsonl'))
    assert.ok(files.includes('preferences.jsonl'))
    assert.ok(files.includes('decisions.jsonl'))
    assert.doesNotMatch(await fsp.readFile(userMemory.fileOf('fact'), 'utf8'), /progress pings/)
  })
})

test('a decision stores its rationale and a decision without a reason is refused', async () => {
  await withRoot(async root => {
    const userMemory = createUserMemory(root)
    const good = await userMemory.record({
      category: 'decision',
      runId: 'run-9',
      entry: {
        key: 'queue',
        choice: 'a file-backed queue',
        rejected: 'redis',
        reason: 'no extra service to operate for this scale',
        rollback: 'swap the driver behind the Queue interface',
      },
    })
    assert.equal(good.written, 1)
    const bad = await userMemory.record({
      category: 'decision',
      entry: { key: 'bare', choice: 'do it this way' },
    })
    assert.equal(bad.written, 0)

    const recalled = await userMemory.recall({ category: 'decision', query: 'redis' })
    const [entry] = recalled.entries
    assert.equal(entry.choice, 'a file-backed queue')
    assert.equal(entry.rejected, 'redis')
    assert.equal(entry.reason, 'no extra service to operate for this scale')
    assert.equal(entry.rollback, 'swap the driver behind the Queue interface')
    assert.equal(entry.source.runId, 'run-9')
    assert.ok(entry.source.ts)

    const digest = await userMemory.digest({ query: 'redis' })
    assert.match(digest, /^Decisions \(with rationale\):/m)
    assert.match(digest, /chose a file-backed queue; rejected redis; why no extra service/)
    assert.match(digest, /rollback swap the driver behind the Queue interface/)
    assert.match(digest, /run run-9/)
  })
})

test('user-level writes are redacted before they reach the file', async () => {
  await withRoot(async root => {
    const userMemory = createUserMemory(root)
    await userMemory.writeBlock({
      runId: 'run-pii',
      block: {
        facts: [{
          key: 'contact',
          text: 'reach out at someone@example.com or +86 138 0013 8000 from C:\\Users\\alice\\work',
        }],
        preferences: [{ key: 'key', text: 'the old key was sk-abcdefgh12345678' }],
      },
    })
    const raw = `${await fsp.readFile(userMemory.fileOf('fact'), 'utf8')}`
      + `${await fsp.readFile(userMemory.fileOf('preference'), 'utf8')}`
    assert.doesNotMatch(raw, /someone@example\.com/)
    assert.doesNotMatch(raw, /138/)
    assert.doesNotMatch(raw, /alice/)
    assert.doesNotMatch(raw, /sk-abcdefgh/)
    assert.match(raw, /\[redacted-email\]/)
    assert.match(raw, /\[redacted-phone\]/)
    assert.match(raw, /\[redacted-key\]/)
    assert.match(raw, /%USERPROFILE%/)

    // The redaction helpers are also usable on their own.
    assert.equal(redactPhones('call 13800138000 now'), 'call [redacted-phone] now')
    assert.doesNotMatch(sanitizeUserText('mail me at a@b.co'), /a@b\.co/)
  })
})

test('forget by key, by run and by time range deletes records for real', async () => {
  await withRoot(async root => {
    let clock = Date.parse('2026-01-10T00:00:00.000Z')
    const userMemory = createUserMemory(root, { now: () => clock })
    await userMemory.record({ category: 'fact', runId: 'run-old', entry: { key: 'stack', text: 'uses pnpm' } })
    await userMemory.record({ category: 'preference', runId: 'run-old', entry: { key: 'tone', text: 'terse replies' } })
    clock = Date.parse('2026-06-10T00:00:00.000Z')
    await userMemory.record({ category: 'decision', runId: 'run-new', entry: { key: 'db', choice: 'postgres', reason: 'team knows it' } })
    await userMemory.record({ category: 'fact', runId: 'run-new', entry: { key: 'deploy', text: 'staging is eu-west' } })

    // By key: gone from every category and from the file itself.
    assert.equal((await userMemory.forget({ key: 'stack' })).deleted, 1)
    assert.equal((await userMemory.recall({ category: 'fact', query: 'pnpm' })).matched, 0)
    assert.doesNotMatch(await fsp.readFile(userMemory.fileOf('fact'), 'utf8'), /uses pnpm/)

    // By time range: only the June entries.
    const ranged = await userMemory.forget({
      after: '2026-06-01T00:00:00.000Z',
      before: '2026-06-30T23:59:59.000Z',
    })
    assert.equal(ranged.deleted, 2)
    assert.equal((await userMemory.stats()).total, 1)

    // By run: the remaining January preference belonged to run-old.
    assert.equal((await userMemory.forget({ runId: 'run-old' })).deleted, 1)
    const stats = await userMemory.stats()
    assert.deepEqual(stats, { fact: 0, preference: 0, decision: 0, total: 0, path: stats.path })

    // Nothing is left as a tombstone that a later search could observe.
    for (const category of ['fact', 'preference', 'decision']) {
      assert.equal((await userMemory.list({ category })).total, 0)
      assert.equal(await fsp.readFile(userMemory.fileOf(category), 'utf8').catch(() => ''), '')
    }

    // An unfiltered forget must refuse instead of wiping the profile.
    await userMemory.record({ category: 'fact', entry: { key: 'kept', text: 'still here' } })
    const refused = await userMemory.forget({})
    assert.equal(refused.deleted, 0)
    assert.match(refused.reason, /required/)
    assert.equal((await userMemory.list({ category: 'fact' })).total, 1)
  })
})

test('a newer record with the same key supersedes the older one', async () => {
  const now = Date.parse('2026-11-15T00:00:00.000Z')
  const entries = effectiveUserRecords([
    { key: 'stack', category: 'fact', text: 'old', ts: '2026-11-01T00:00:00.000Z' },
    { key: 'stack', category: 'fact', text: 'new', ts: '2026-11-10T00:00:00.000Z' },
  ], { now, maxAgeDays: 365 })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].text, 'new')
})

test('the user-memory fence is parsed and stripped from the report', () => {
  const report = [
    '# Result',
    '',
    'Done.',
    '',
    '```user-memory',
    JSON.stringify({
      facts: [{ key: 'stack', text: 'pnpm' }],
      preferences: [],
      decisions: [{ key: 'db', choice: 'postgres', rejected: 'sqlite', reason: 'ops', rollback: 'flip env' }],
    }),
    '```',
  ].join('\n')
  const parsed = extractUserMemoryBlock(report)
  assert.equal(parsed.found, true)
  assert.doesNotMatch(parsed.report, /```user-memory/)
  assert.match(parsed.report, /Done\./)
  assert.equal(parsed.block.facts.length, 1)
  assert.equal(parsed.block.decisions[0].reason, 'ops')

  const broken = extractUserMemoryBlock('text\n\n```user-memory\nnot json\n```')
  assert.equal(broken.found, true)
  assert.match(broken.error, /valid JSON/)
  assert.equal(extractUserMemoryBlock('no fence').found, false)
})

test('the second run reads what the first run stored, and it reaches the prompt', async () => {
  await withRoot(async root => {
    const store = memoryStore()
    const userMemory = createUserMemory(root)
    const { spawnChild, calls } = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({
          subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }],
        }))
      }
      if (spec.label === 'superagent-aggregate') {
        return completed([
          '# Done',
          '',
          'Both subtasks finished.',
          '',
          '```user-memory',
          JSON.stringify({
            facts: [{ key: 'stack', text: 'the service uses Node 24 and pnpm' }],
            preferences: [{ key: 'reporting', text: 'no mid-task progress reports; only the final result' }],
            decisions: [{
              key: 'queue',
              choice: 'file-backed queue',
              rejected: 'redis',
              reason: 'no extra service to operate',
              rollback: 'swap the driver behind the Queue interface',
            }],
          }),
          '```',
        ].join('\n'))
      }
      return completed(`result for ${spec.label}`)
    })
    const orchestrator = createOrchestrator({
      store,
      config: BASE_CONFIG,
      spawnChild,
      readUsage: async () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1, models: {} }),
      userMemory,
      notify: () => {},
      log: () => {},
    })

    const first = await orchestrator.start({ goal: 'pick a queue implementation', parentSessionId: 's1', parent: { id: 's1' } })
    const finished = await orchestrator.status(first.id, 10)
    assert.equal(finished.status, 'completed')
    assert.doesNotMatch(finished.report, /```user-memory/)
    assert.equal(finished.userMemoryWrite.written, 3)
    assert.equal((await userMemory.stats()).total, 3)

    const second = await orchestrator.start({ goal: 'add a retry policy to the worker', parentSessionId: 's1', parent: { id: 's1' } })
    await orchestrator.status(second.id, 10)
    const plans = calls.filter(call => call.label === 'superagent-plan')
    const prompt = plans[plans.length - 1].prompt
    assert.match(prompt, /User profile learned across tasks/)
    assert.match(prompt, /no mid-task progress reports; only the final result/)
    assert.match(prompt, /chose file-backed queue; rejected redis; why no extra service to operate/)
    assert.match(prompt, /rollback swap the driver behind the Queue interface/)
    assert.match(prompt, /the service uses Node 24 and pnpm/)
  })
})

test('without the profile enabled the prompts and the state directory are unchanged', async () => {
  await withRoot(async root => {
    const store = memoryStore()
    const { spawnChild, calls } = makeSpawner(async spec => {
      if (spec.label === 'superagent-plan') {
        return completed(JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }, { title: 'B', prompt: 'do B' }] }))
      }
      return completed('done')
    })
    const orchestrator = createOrchestrator({
      store,
      config: BASE_CONFIG,
      spawnChild,
      readUsage: async () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1, models: {} }),
      notify: () => {},
      log: () => {},
    })
    const run = await orchestrator.start({ goal: 'a task', parentSessionId: 's1', parent: { id: 's1' } })
    await orchestrator.status(run.id, 10)
    for (const call of calls) {
      assert.doesNotMatch(call.prompt, /User profile learned across tasks/)
      assert.doesNotMatch(call.prompt, /```user-memory/)
    }
    await assert.rejects(fsp.access(path.join(root, 'user-memory')), /ENOENT/)
  })
})

test('the plugin default config creates no user-memory directory and no user-memory tool', async () => {
  await withRoot(async root => {
    const tools = new Map()
    const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, get: () => undefined }
    apply(ctx, { stateDir: root })
    // Every registered tool is one of the documented set; the user profile adds
    // no tool of its own, it only widens superagent_memory.
    assert.equal(tools.size, 12)
    assert.equal(tools.has('superagent_memory'), true)
    const result = await tools.get('superagent_memory').execute({ action: 'list', layer: 'user' }, {
      agent: { id: 'session-1' },
    })
    assert.match(result, /user-level memory is off/)
    await assert.rejects(fsp.access(path.join(root, 'user-memory')), /ENOENT/)
  })
})
