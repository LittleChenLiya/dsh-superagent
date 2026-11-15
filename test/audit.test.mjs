/**
 * Policy and audit tests.
 *
 * The cases follow what a user actually needs to trust this layer: a policy
 * that tightens, an approval that leaves a trace, a log that survives parallel
 * writers, and an export that can be handed to someone else.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AUDIT_VERSION, createAuditor, createAuditLog, filterEvents, toCsv } from '../lib/audit.js'
import { commandMatches, createPolicyLoader, decide, parsePolicy, pathMatches } from '../lib/policy.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createStore } from '../lib/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUDIT_MODULE = pathToFileURL(path.join(HERE, '..', 'lib', 'audit.js')).href

async function tempDir(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `superagent-${label}-`))
}

async function writePolicy(dir, body, name = 'policy.json') {
  const file = path.join(dir, name)
  await fsp.writeFile(file, body, 'utf8')
  return file
}

const POLICY = `{
  // Paths are matched at any directory boundary, so this works wherever the
  // workspace is mounted.
  "version": 1,
  "defaultLevel": "confirm",
  "paths": { "allow": ["src/**"], "deny": ["**/.env"] },
  "commands": { "allow": ["git status"], "deny": ["rm -rf"] },
  "confirm": { "actions": ["path.write"] },
  "runs": { "run-blocked1": { "level": "deny", "note": "stopped by hand" } }
}`

test('a policy file reports schema problems with the line they are on', async () => {
  const dir = await tempDir('policy-lines')
  try {
    const file = await writePolicy(dir, `{
  "version": 1,
  "defaultLevel": "maybe",
  "paths": { "allow": ["src/**"], "deny": [42] },
  "extra": true
}`)
    const loader = createPolicyLoader({ file })
    const { policy, error } = await loader.get()
    assert.equal(policy, null)
    assert.ok(error, 'an invalid policy must surface as an error, not as "no policy"')
    const found = error.errors.map(item => ({ line: item.line, path: item.path, message: item.message }))
    assert.deepEqual(found.map(item => item.line), [3, 4, 5])
    assert.match(found[0].message, /allow \| confirm \| deny/)
    assert.match(found[1].path, /paths\.deny\[0\]/)
    assert.match(found[1].message, /must be a string/)
    assert.match(found[2].message, /unknown key/)
    // The message itself points at the column, so the user can jump there.
    assert.match(error.message, /policy\.json:3:/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('comments are allowed and do not move line numbers', () => {
  const text = `{
  // a comment
  "defaultLevel": "allow" /* inline */,
  "paths": { "deny": ["**/.env"] }
}`
  const policy = parsePolicy(text, { file: 'p.json' })
  assert.equal(policy.defaultLevel, 'allow')
  assert.deepEqual(policy.paths.deny, ['**/.env'])
  // A `//` inside a string is data, not a comment.
  const kept = parsePolicy('{ "note": "see http://example.com" }')
  assert.equal(kept.note, 'see http://example.com')
})

test('matching is boundary-aware for paths and prefix-exact for commands', () => {
  assert.equal(pathMatches('src/**', 'C:\\repo\\src\\deep\\a.js'), true)
  assert.equal(pathMatches('src/**', 'C:/repo/xsrc/a.js'), false)
  assert.equal(pathMatches('**/.env', 'C:/repo/a/.env'), true)
  assert.equal(commandMatches('git status', 'git status --short').matched, true)
  assert.equal(commandMatches('git status', 'git statusx').matched, false)
  assert.equal(commandMatches('npm test*', 'npm test -- --runInBand').matched, true)
})

test('a policy only tightens: deny wins, explicit allow leaves a relaxed trace', async () => {
  const dir = await tempDir('policy-tighten')
  try {
    const file = await writePolicy(dir, POLICY)
    const auditor = createAuditor({ dir: path.join(dir, 'audit'), policyFile: file, sync: false })

    const allowed = await auditor.gate({ runId: 'run-allow1', kind: 'path.write', target: 'C:/repo/src/a.js' })
    assert.equal(allowed.decision, 'allow')
    assert.equal(allowed.rule, 'paths.allow[0]')
    assert.equal(allowed.relaxedFrom, 'confirm', 'the allow entry beat the confirm requirement and says so')

    const held = await auditor.gate({ runId: 'run-allow1', kind: 'path.write', target: 'C:/repo/docs/a.md' })
    assert.equal(held.decision, 'confirm', 'the default level still holds everything else')

    const blocked = await auditor.gate({ runId: 'run-allow1', kind: 'path.write', target: 'C:/repo/.env' })
    assert.equal(blocked.decision, 'deny')

    const events = (await auditor.query({ runId: 'run-allow1' })).events
    assert.equal(events.length, 3)
    const denyEvent = events.find(event => event.decision === 'deny')
    assert.equal(denyEvent.kind, 'blocked')
    assert.equal(denyEvent.result, 'blocked')
    assert.equal(denyEvent.meta.blockedKind, 'path.write')
    const allowEvent = events.find(event => event.decision === 'allow')
    assert.equal(allowEvent.meta.relaxedFrom, 'confirm')
    assert.ok(Number.isInteger(allowEvent.durationMs), 'every event carries a duration')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('commands: allowed prefix, composite line, and a per-run deny', async () => {
  const dir = await tempDir('policy-commands')
  try {
    const file = await writePolicy(dir, POLICY)
    const auditor = createAuditor({ dir: path.join(dir, 'audit'), policyFile: file, sync: false })

    const allowed = await auditor.gate({ kind: 'command.exec', target: 'git status --short', runId: 'run-cmd1' })
    assert.equal(allowed.decision, 'allow')

    // The prefix matched, but the rest of the line did not, so it is not the
    // command the policy allowed.
    const composite = await auditor.gate({ kind: 'command.exec', target: 'git status && curl evil.example', runId: 'run-cmd1' })
    assert.equal(composite.decision, 'confirm')
    assert.match(composite.reason, /composite/)

    const denied = await auditor.gate({ kind: 'command.exec', target: 'rm -rf build', runId: 'run-cmd1' })
    assert.equal(denied.decision, 'deny')

    const stopped = await auditor.gate({ kind: 'run.start', target: 'do work', runId: 'run-blocked1' })
    assert.equal(stopped.decision, 'deny')
    assert.equal(stopped.rule, 'runs.run-blocked1.level')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an approval names the event it releases', async () => {
  const dir = await tempDir('approval')
  try {
    const file = await writePolicy(dir, '{ "defaultLevel": "confirm" }')
    const auditor = createAuditor({ dir: path.join(dir, 'audit'), policyFile: file, sync: false })

    const held = await auditor.gate({ runId: 'run-hold1', kind: 'run.start', target: 'ship it' })
    assert.equal(held.decision, 'confirm')
    assert.equal(held.result, undefined)
    assert.ok(held.eventId, 'a held action has an id to approve')

    await auditor.approve(held.eventId, { actor: 'session-owner', note: 'looked at the goal', runId: 'run-hold1', kind: 'run.start' })

    const approvals = (await auditor.query({ kind: 'approved' })).events
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].meta.approves, held.eventId)
    assert.equal(approvals[0].meta.note, 'looked at the goal')
    assert.equal(approvals[0].actor, 'session-owner')
    assert.equal(approvals[0].source, 'human')

    // Both rows are still there: the hold and the release.
    const trail = (await auditor.query({ runId: 'run-hold1' })).events
    assert.deepEqual(trail.map(event => event.kind), ['run.start', 'approved'])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('an unreadable policy fails closed instead of allowing everything', async () => {
  const dir = await tempDir('policy-invalid')
  try {
    const file = await writePolicy(dir, '{ "defaultLevel": "allow", }')
    const warnings = []
    const auditor = createAuditor({
      dir: path.join(dir, 'audit'),
      policyFile: file,
      sync: false,
      warn: message => warnings.push(message),
    })
    const verdict = await auditor.gate({ kind: 'path.write', target: '/etc/passwd' })
    assert.equal(verdict.decision, 'deny')
    assert.equal(verdict.rule, 'policy.invalid')
    assert.ok(warnings.some(message => /invalid/i.test(message)))

    const events = (await auditor.query({})).events
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'blocked')
    assert.equal(events[0].result, 'blocked')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('the guard hook can only tighten the policy', async () => {
  const dir = await tempDir('guard')
  try {
    const auditor = createAuditor({ dir: path.join(dir, 'audit'), policy: parsePolicy('{}'), sync: false })
    auditor.attachGuard(request => (request.kind === 'command.exec' && /rm\s+-rf/.test(request.target)
      ? { decision: 'deny', rule: 'shell', reason: 'recursive delete' }
      : null))

    const blocked = await auditor.gate({ kind: 'command.exec', target: 'rm -rf /', runId: 'run-guard1' })
    assert.equal(blocked.decision, 'deny')
    assert.equal(blocked.source, 'guard')
    assert.match(blocked.rule, /^guard\./)

    const untouched = await auditor.gate({ kind: 'tool.call', target: 'read_file', runId: 'run-guard1' })
    assert.equal(untouched.decision, 'allow')
    assert.equal(untouched.source, 'policy')

    // A guard that says "allow" cannot lift a policy deny.
    const denying = createAuditor({
      dir: path.join(dir, 'audit2'),
      policy: parsePolicy('{ "paths": { "deny": ["**/.env"] } }'),
      sync: false,
      guard: () => ({ decision: 'allow' }),
    })
    const stillDenied = await denying.gate({ kind: 'path.write', target: '/repo/.env' })
    assert.equal(stillDenied.decision, 'deny')

    // A throwing guard is a block, not a pass.
    const throwing = createAuditor({
      dir: path.join(dir, 'audit3'),
      policy: parsePolicy('{}'),
      sync: false,
      guard: () => {
        throw new Error('boom')
      },
    })
    assert.equal((await throwing.gate({ kind: 'tool.call', target: 'x' })).decision, 'deny')

    // The `{ blocked, rule, reason }` shape a tool-call guard already returns
    // needs no adapter.
    const shaped = createAuditor({
      dir: path.join(dir, 'audit4'),
      policy: parsePolicy('{}'),
      sync: false,
      guard: () => ({ blocked: true, rule: 'path/outside-allowlist', reason: 'outside every allowed root' }),
    })
    const shapedVerdict = await shaped.gate({ kind: 'path.write', target: '/tmp/x' })
    assert.equal(shapedVerdict.decision, 'deny')
    assert.equal(shapedVerdict.rule, 'guard.path/outside-allowlist')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('without a policy every action is allowed, exactly as before', async () => {
  const dir = await tempDir('no-policy')
  try {
    const auditor = createAuditor({ dir: path.join(dir, 'audit'), sync: false })
    const verdict = await auditor.gate({ kind: 'command.exec', target: 'rm -rf /' })
    assert.equal(verdict.decision, 'allow')
    assert.equal(verdict.rule, 'no-policy')
    const events = (await auditor.query({})).events
    assert.equal(events.length, 1)
    assert.equal(events[0].v, AUDIT_VERSION)
    assert.equal(events[0].rule, 'no-policy')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('parallel appends from several processes keep every line whole', async () => {
  const dir = await tempDir('concurrent')
  const script = path.join(dir, 'writer.mjs')
  try {
    await fsp.writeFile(script, `
import { createAuditor } from ${JSON.stringify(AUDIT_MODULE)}
const [dir, prefix, count] = process.argv.slice(2)
const auditor = createAuditor({ dir })
for (let i = 0; i < Number(count); i++) {
  await auditor.record({
    runId: \`\${prefix}-run\${i % 4}\`,
    subtaskId: \`subtask-\${i % 3}\`,
    actor: prefix,
    kind: 'tool.call',
    action: 'append',
    target: \`\${prefix}:event:\${i}\`,
    result: 'ok',
    durationMs: i,
  })
}
`, 'utf8')

    const auditor = createAuditor({ dir })
    await Promise.all(Array.from({ length: 40 }, (_, i) => auditor.record({
      runId: `main-run${i % 4}`,
      actor: 'main',
      kind: 'path.write',
      target: `main:event:${i}`,
      result: 'ok',
      durationMs: i,
    })))

    const children = ['alpha', 'beta', 'gamma'].map(prefix => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, dir, prefix, '30'], { stdio: 'inherit' })
      child.on('error', reject)
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${prefix} exited ${code}`))))
    }))
    await Promise.all(children)

    const log = createAuditLog({ dir })
    const { events, invalid, torn } = await log.read()
    assert.equal(invalid, 0, 'no line was spliced by a concurrent writer')
    assert.equal(torn, 0)
    assert.equal(events.length, 40 + 3 * 30)
    assert.equal(new Set(events.map(event => event.id)).size, events.length, 'every event has its own id')
    const alpha = events.filter(event => event.actor === 'alpha')
    assert.equal(alpha.length, 30)
    assert.deepEqual(alpha.map(event => event.target), Array.from({ length: 30 }, (_, i) => `alpha:event:${i}`))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a damaged line is reported and skipped, not allowed to hide the log', async () => {
  const dir = await tempDir('damaged')
  try {
    const auditor = createAuditor({ dir, sync: false })
    await auditor.record({ runId: 'run-damaged1', kind: 'tool.call', target: 'first' })
    await fsp.appendFile(auditor.file, '{"this is": not json}\n', 'utf8')
    await auditor.record({ runId: 'run-damaged1', kind: 'tool.call', target: 'second' })
    await fsp.appendFile(auditor.file, '{"torn": tr', 'utf8')

    const result = await auditor.query({ runId: 'run-damaged1' })
    assert.equal(result.events.length, 2)
    assert.equal(result.invalid, 1)
    assert.equal(result.torn, 1)
    assert.deepEqual(result.events.map(event => event.target), ['first', 'second'])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('queries filter by run, time, kind and result, and export as one file', async () => {
  const dir = await tempDir('export')
  try {
    const auditor = createAuditor({ dir, sync: false })
    const rows = [
      { at: '2026-11-15T09:00:00.000Z', runId: 'run-export1', kind: 'tool.call', decision: 'allow', result: 'ok', target: 'read, "quoted"' },
      { at: '2026-11-15T10:00:00.000Z', runId: 'run-export1', kind: 'path.write', decision: 'allow', result: 'ok', target: 'src/a.js', durationMs: 7 },
      { at: '2026-11-15T11:00:00.000Z', runId: 'run-export1', kind: 'blocked', decision: 'deny', result: 'blocked', target: '/etc/passwd' },
      { at: '2026-11-15T12:00:00.000Z', runId: 'run-export2', kind: 'tool.call', decision: 'allow', result: 'ok', target: 'other' },
    ]
    for (const row of rows) await auditor.record(row)

    const byTime = await auditor.query({ runId: 'run-export1', since: '2026-11-15T09:30:00Z', until: '2026-11-15T11:30:00Z' })
    assert.deepEqual(byTime.events.map(event => event.target), ['src/a.js', '/etc/passwd'])

    const byResult = await auditor.query({ runId: 'run-export1', result: 'blocked' })
    assert.equal(byResult.events.length, 1)

    const newest = await auditor.query({ runId: 'run-export1', order: 'desc', limit: 2 })
    assert.deepEqual(newest.events.map(event => event.kind), ['blocked', 'path.write'])

    const kinds = await auditor.query({ kind: ['path.write', 'blocked'] })
    assert.equal(kinds.events.length, 2)

    const all = await auditor.query({})
    assert.equal(filterEvents(all.events, { target: 'passwd' }).length, 1)

    const jsonl = await auditor.export({ runId: 'run-export1', format: 'jsonl', outFile: path.join(dir, 'out', 'delivery.jsonl') })
    assert.equal(jsonl.count, 3)
    const lines = (await fsp.readFile(jsonl.path, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 3)
    for (const line of lines) assert.equal(JSON.parse(line).runId, 'run-export1')

    const csv = await auditor.export({ runId: 'run-export1', format: 'csv', outFile: path.join(dir, 'out', 'delivery.csv') })
    const text = await fsp.readFile(csv.path, 'utf8')
    assert.match(text, /^at,id,runId,subtaskId,actor,kind,action,target,decision,result,durationMs,rule,source,meta\n/)
    assert.match(text, /"read, ""quoted"""/, 'commas and quotes are escaped for a spreadsheet')
    assert.equal(text.trim().split('\n').length, 4)

    assert.match(toCsv([{ target: 'a\nb' }]), /"a\nb"/, 'a newline inside a cell stays quoted')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('the plugin refuses a start the policy denies and records it', async () => {
  const dir = await tempDir('plugin-deny')
  try {
    const store = createStore(path.join(dir, 'state'))
    await store.init()
    const auditor = createAuditor({
      dir: path.join(dir, 'audit'),
      policy: parsePolicy('{ "runs": { "run-any": { "level": "allow" } }, "defaultLevel": "deny" }'),
      sync: false,
    })
    const orchestrator = createOrchestrator({
      store,
      audit: auditor,
      log: () => {},
      config: {
        maxSubtasks: 4,
        maxParallel: 2,
        maxActiveRuns: 2,
        attempts: 1,
        deadlineMinutes: 5,
        maxModelCallsPerRun: 0,
        maxTokensPerRun: 0,
        resultCapBytes: 4096,
        autoResumeRounds: 0,
      },
      readUsage: async () => null,
      notify: async () => ({ delivered: false, reason: 'test' }),
      async spawnChild() {
        throw new Error('a denied start must not spawn anything')
      },
    })

    await assert.rejects(
      () => orchestrator.start({ goal: 'refused goal', parentSessionId: 'session-1', parent: { id: 'session-1' } }),
      /permission policy/i,
    )

    const events = (await auditor.query({})).events
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'blocked')
    assert.equal(events[0].target, 'refused goal')
    assert.match(events[0].rule, /defaultLevel/)
    assert.equal((await store.list()).length, 0, 'a denied start leaves no run behind')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a start held for confirmation needs approve_policy, which is logged', async () => {
  const dir = await tempDir('plugin-confirm')
  try {
    const store = createStore(path.join(dir, 'state'))
    await store.init()
    const auditor = createAuditor({
      dir: path.join(dir, 'audit'),
      policy: parsePolicy('{ "defaultLevel": "confirm" }'),
      sync: false,
    })
    const orchestrator = createOrchestrator({
      store,
      audit: auditor,
      log: () => {},
      config: {
        maxSubtasks: 2,
        maxParallel: 2,
        maxActiveRuns: 2,
        attempts: 1,
        deadlineMinutes: 5,
        maxModelCallsPerRun: 0,
        maxTokensPerRun: 0,
        resultCapBytes: 4096,
        autoResumeRounds: 0,
      },
      readUsage: async () => null,
      notify: async () => ({ delivered: false, reason: 'test' }),
      async spawnChild(spec) {
        const text = spec.label === 'superagent-plan'
          ? JSON.stringify({ subtasks: [{ title: 'A', prompt: 'do A' }] })
          : 'done'
        return {
          childId: `child-${spec.label}`,
          result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    })

    await assert.rejects(
      () => orchestrator.start({ goal: 'needs a nod', parentSessionId: 'session-1', parent: { id: 'session-1' } }),
      /approve_policy/,
    )

    const run = await orchestrator.start({
      goal: 'needs a nod',
      parentSessionId: 'session-1',
      parent: { id: 'session-1' },
      approvePolicy: true,
    })
    assert.match(run.status, /^(queued|planning|running)$/, 'the approved start is accepted')
    const finished = await orchestrator.status(run.id, 10)
    assert.equal(finished.status, 'completed')

    const trail = (await auditor.query({ runId: run.id })).events
    assert.deepEqual(trail.map(event => event.kind), ['run.start', 'approved', 'run.finish'])
    assert.equal(trail[0].decision, 'confirm')
    assert.equal(trail[1].meta.approves, trail[0].id)
    assert.equal(trail[2].result, 'completed')
    assert.ok(Number.isInteger(trail[2].durationMs))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('the shipped example policy parses', async () => {
  const text = await fsp.readFile(path.join(HERE, '..', 'docs', 'policy.example.json'), 'utf8')
  const policy = parsePolicy(text, { file: 'policy.example.json' })
  assert.equal(policy.version, 1)
  assert.ok(policy.paths.deny.includes('**/.env'))
  assert.ok(policy.commands.allow.includes('npm test'))
  assert.ok(policy.confirm.actions.includes('network'))
})

test('decide prefers deny over allow regardless of order in the file', () => {
  const policy = parsePolicy(`{
    "paths": { "allow": ["src/**"], "deny": ["src/**/secret.js"] }
  }`)
  assert.equal(decide(policy, { kind: 'path.write', target: '/repo/src/secret.js' }).decision, 'deny')
  assert.equal(decide(policy, { kind: 'path.write', target: '/repo/src/open.js' }).decision, 'allow')
  // Reads are governed by the same path rules unless the policy names them.
  assert.equal(decide(policy, { kind: 'path.read', target: '/repo/notes.md' }).decision, 'allow')
})
