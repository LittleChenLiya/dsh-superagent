import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AutomationRuleError,
  AutomationStateError,
  DEFAULT_AUTOMATION_RULE,
  buildAutomationExecutionInput,
  completeAutomationExecution,
  createAutomationRuleStore,
  normalizeAutomationRule,
  previewAutomationRule,
  shouldNotifyAutomation,
} from '../lib/automation-rules.js'

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const iso = value => new Date(value).toISOString()

async function fixture(t, label, now = () => NOW) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `automation-rules-${label}-`))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'state', 'rules.json')
  return { directory, file, store: createAutomationRuleStore({ file, now }) }
}

function rule(extra = {}) {
  return {
    name: 'Daily report',
    trigger: { type: 'cron', cron: '0 9 * * *', timeZone: 'UTC' },
    action: { type: 'run', prompt: 'Write a report' },
    output: { relativePath: 'reports/daily.md' },
    notify: { events: ['completed', 'failed'] },
    budget: { maxRuns: 10, maxModelCalls: 20, maxTokens: 1000, maxCost: 100 },
    ...extra,
  }
}

function executionRecord(status = 'queued') {
  return {
    id: 'exec-1', ruleId: 'rule-1', ruleRevision: 1, idempotencyKey: 'delivery-1', status,
    scheduledAt: '2026-03-01T12:00:00.000Z', startedAt: '2026-03-01T12:00:01.000Z', finishedAt: null,
    recordedAt: '2026-03-01T12:00:01.000Z', action: { type: 'run', prompt: 'Write a report' },
    output: { relativePath: 'reports/daily.md' }, usage: { modelCalls: 0, tokens: 0, cost: 0 },
    result: { requestId: 'router-1' }, error: null,
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

test('default and normalization support every trigger/action form and default to disabled', () => {
  assert.ok(Object.isFrozen(DEFAULT_AUTOMATION_RULE))
  assert.equal(DEFAULT_AUTOMATION_RULE.enabled, false)
  assert.equal(DEFAULT_AUTOMATION_RULE.output.relativePath, 'artifacts/automation.md')

  const normalized = normalizeAutomationRule(rule({
    trigger: { type: 'every', everyMs: 60_000 },
    action: { type: 'task', taskId: 'task-1', prompt: 'Create a task' },
    output: { relativePath: 'reports\\task.md' },
    notify: { events: [] },
  }))
  assert.equal(normalized.enabled, false)
  assert.equal(normalized.revision, 1)
  assert.deepEqual(normalized.trigger, { type: 'every', everyMs: 60_000 })
  assert.deepEqual(normalized.action, { type: 'task', taskId: 'task-1', prompt: 'Create a task' })
  assert.equal(normalized.output.relativePath, 'reports/task.md')
  assert.deepEqual(normalized.notify.events, [])

  const followup = normalizeAutomationRule(rule({
    trigger: { type: 'source', source: 'github', eventTypes: ['issues', 'pull_request'] },
    action: { type: 'followup', taskId: 'task-1', phaseId: 'phase-1', prompt: 'Follow up' },
  }))
  assert.equal(followup.trigger.type, 'source')
  assert.equal(followup.action.phaseId, 'phase-1')

  assert.throws(() => normalizeAutomationRule(rule({ trigger: { type: 'cron', cron: 'bad' } })), AutomationRuleError)
  assert.throws(() => normalizeAutomationRule(rule({ trigger: { type: 'every', everyMs: 0 } })), /integer/)
  assert.throws(() => normalizeAutomationRule(rule({ trigger: { type: 'source', source: 'github', cron: '* * * * *' } })), /must not/)
  assert.throws(() => normalizeAutomationRule(rule({ action: { type: 'task', prompt: 'x' } })), /taskId/)
  assert.throws(() => normalizeAutomationRule(rule({ notify: { events: ['unknown'] } })), /unknown/)
})

test('preview returns three future cron occurrences across local midnight and timezone date boundaries', () => {
  const input = deepFreeze(rule({
    trigger: { type: 'cron', cron: '0 23 * * *', timeZone: 'America/Los_Angeles' },
  }))
  const before = structuredClone(input)
  const preview = previewAutomationRule(input, { now: '2026-03-02T05:00:00.000Z', sources: [] })
  assert.equal(preview.valid, true, JSON.stringify(preview.errors))
  assert.deepEqual(preview.triggerTimes, [
    '2026-03-02T07:00:00.000Z',
    '2026-03-03T07:00:00.000Z',
    '2026-03-04T07:00:00.000Z',
  ])
  assert.deepEqual(input, before)
  assert.ok(preview.warnings.some(warning => warning.includes('workspace.write')))
})

test('preview returns future every occurrences, source samples, permission warnings and errors without I/O', async t => {
  const context = await fixture(t, 'preview')
  const every = previewAutomationRule(rule({ trigger: { type: 'every', everyMs: 15 * 60_000 } }), {
    now: NOW,
    sources: [{ permissions: ['automation.run', 'workspace.write', 'notification.send'] }],
  })
  assert.deepEqual(every.triggerTimes, [
    '2026-03-01T12:15:00.000Z', '2026-03-01T12:30:00.000Z', '2026-03-01T12:45:00.000Z',
  ])
  assert.deepEqual(every.warnings, [])

  const samples = deepFreeze([
    { source: 'github', type: 'issues', id: 1 },
    { source: 'github', type: 'pull_request', id: 2 },
    { source: 'github', type: 'issues', id: 3 },
    { source: 'github', type: 'issues', id: 4 },
    { source: 'gitlab', type: 'issues', id: 5 },
  ])
  const source = rule({
    trigger: { type: 'source', source: 'github', eventTypes: ['issues'] },
    action: { type: 'followup', taskId: 'task-1', prompt: 'Follow up' },
  })
  const sourcePreview = previewAutomationRule(source, { now: NOW, sources: samples })
  assert.equal(sourcePreview.valid, true)
  assert.deepEqual(sourcePreview.triggerTimes, [])
  assert.deepEqual(sourcePreview.matches.map(sample => sample.id), [1, 3, 4])
  assert.ok(sourcePreview.warnings.some(warning => warning.includes('automation.followup')))
  assert.ok(sourcePreview.warnings.some(warning => warning.includes('source.read')))

  const invalid = previewAutomationRule({ ...source, output: { relativePath: '../escape' } }, { now: NOW, sources: samples })
  assert.equal(invalid.valid, false)
  assert.equal(invalid.errors[0].path, 'rule')
  assert.equal(invalid.matches.length, 0)
  assert.equal(await fsp.access(context.file).then(() => true, () => false), false)
  assert.deepEqual(await fsp.readdir(context.directory), [])
})

test('absolute, traversal, UNC, drive and ambiguous output paths are rejected', () => {
  const invalidPaths = [
    '/etc/passwd', '\\etc\\passwd', 'C:\\Windows\\win.ini', 'C:relative.txt',
    '\\\\server\\share\\file', '../outside', 'reports/../../outside', 'reports\\..\\outside',
    './report', 'reports//report', 'reports/file.', 'reports/file ', 'reports/a:b', '~/.config',
    'bad\u0000path', '',
  ]
  for (const relativePath of invalidPaths) {
    assert.throws(() => normalizeAutomationRule(rule({ output: { relativePath } })), AutomationRuleError, relativePath)
  }
  assert.equal(normalizeAutomationRule(rule({ output: { relativePath: 'reports/nested/报告.md' } })).output.relativePath,
    'reports/nested/报告.md')
})

test('buildAutomationExecutionInput freezes output/notify contracts and augments the prompt without I/O', () => {
  const input = deepFreeze(rule({
    output: { relativePath: 'reports\\daily.md' },
    notify: { events: ['started', 'completed', 'failed', 'cancelled', 'budget'] },
    budget: { maxRuns: 3, maxModelCalls: 7, maxTokens: 800, maxCost: 9 },
  }))
  const before = structuredClone(input)
  const built = buildAutomationExecutionInput({
    rule: input, now: '2026-03-01T12:00:00Z', project: 'D:/work/project',
  })
  assert.deepEqual(built.output, { relativePath: 'reports/daily.md' })
  assert.deepEqual(built.notify, { events: ['started', 'completed', 'failed', 'cancelled', 'budget'] })
  assert.ok(built.prompt.startsWith('Write a report\n'))
  assert.match(built.prompt, /output\.relativePath/)
  assert.match(built.prompt, /reports\/daily\.md/)
  assert.match(built.prompt, /"maxModelCalls": 7/)
  assert.match(built.prompt, /"maxTokens": 800/)
  assert.match(built.prompt, /"maxCost": 9/)
  assert.match(built.prompt, /"project": "D:\/work\/project"/)
  assert.match(built.prompt, /"scheduledAt": "2026-03-01T12:00:00\.000Z"/)
  assert.match(built.prompt, /Never claim success/)
  assert.deepEqual(input, before)

  built.output.relativePath = 'changed.md'
  built.notify.events.push('completed')
  assert.deepEqual(input, before)
  assert.deepEqual(buildAutomationExecutionInput({ rule: input, now: NOW }).output, { relativePath: 'reports/daily.md' })
  assert.throws(() => buildAutomationExecutionInput({ rule: input }), /now is required/)
  assert.throws(() => buildAutomationExecutionInput({ rule: input, now: NOW, project: 42 }), /project must be a string/)
})

test('completeAutomationExecution aggregates real subtask usage and is idempotent', () => {
  const execution = deepFreeze(executionRecord('running'))
  const before = structuredClone(execution)
  const run = deepFreeze({
    id: 'run-123', status: 'completed', finishedAt: '2026-03-01T12:05:00.000Z', report: 'Real report',
    usage: { modelCalls: 999, totalTokens: 9999 }, cost: { totalMicros: 9999 },
    subtasks: [
      { usage: { modelCalls: 2, totalTokens: 20 }, cost: { totalMicros: 3 } },
      { usage: { modelCalls: 1, inputTokens: 4, outputTokens: 6, cacheReadTokens: 2 }, cost: { total: 0.000002 } },
    ],
  })
  const completed = completeAutomationExecution({ execution, run })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.finishedAt, '2026-03-01T12:05:00.000Z')
  assert.equal(completed.runId, 'run-123')
  assert.equal(completed.result, 'Real report')
  assert.equal(completed.error, null)
  assert.deepEqual(completed.usage, { modelCalls: 3, tokens: 32, cost: 5 })
  assert.equal(completed.recordedAt, execution.recordedAt)
  assert.deepEqual(execution, before)

  const repeated = completeAutomationExecution({
    execution: completed,
    run: { ...run, id: 'run-late', status: 'failed', finishedAt: '2026-03-01T12:06:00.000Z', error: 'late error' },
    error: 'late observer error',
  })
  assert.deepEqual(repeated, completed)
  assert.notStrictEqual(repeated, completed)
  assert.equal(completed.runId, 'run-123')
})

test('completeAutomationExecution maps terminal run outcomes explicitly and never invents success', () => {
  const cases = [
    ['completed', 'completed'],
    ['partial', 'failed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'failed'],
    ['stopped', 'failed'],
    ['budget-stopped', 'budget-stopped'],
  ]
  for (const [runStatus, expected] of cases) {
    const completed = completeAutomationExecution({
      execution: executionRecord(),
      run: { id: 'run-1', status: runStatus, finishedAt: iso(NOW), report: 'Partial evidence', error: 'real error' },
    })
    assert.equal(completed.status, expected, runStatus)
    assert.equal(completed.result, 'Partial evidence')
    assert.equal(completed.error, 'real error')
  }

  for (const runStatus of ['queued', 'planning', 'running', 'aggregating', 'unknown']) {
    assert.equal(completeAutomationExecution({
      execution: executionRecord(), run: { id: 'run-1', status: runStatus }, error: 'not terminal',
    }), null)
  }

  const structured = completeAutomationExecution({
    execution: executionRecord(), error: 'observer error',
    run: { id: 'run-2', status: 'failed', finishedAt: NOW, result: { code: 'E_REAL' }, report: 'ignored', error: 'run error' },
  })
  assert.deepEqual(structured.result, { code: 'E_REAL' })
  assert.equal(structured.error, 'observer error')
  assert.deepEqual(structured.usage, { modelCalls: 0, tokens: 0, cost: 0 })
})

test('completeAutomationExecution falls back to run usage without double-counting subtasks', () => {
  const fallback = completeAutomationExecution({
    execution: executionRecord('queued'),
    run: {
      id: 'run-fallback', status: 'cancelled', finishedAt: NOW, subtasks: [],
      usage: { modelCalls: 4, totalTokens: 40 }, cost: { totalMicros: 7 },
    },
  })
  assert.deepEqual(fallback.usage, { modelCalls: 4, tokens: 40, cost: 7 })

  const measured = completeAutomationExecution({
    execution: executionRecord('queued'),
    run: {
      id: 'run-measured', status: 'completed', finishedAt: NOW,
      usage: { modelCalls: 100, totalTokens: 1000 }, cost: { totalMicros: 100 },
      subtasks: [{ usage: { modelCalls: 2, tokens: 30 }, cost: 0.000004 }],
    },
  })
  assert.deepEqual(measured.usage, { modelCalls: 2, tokens: 30, cost: 4 })
})

test('shouldNotifyAutomation selects each lifecycle event independently', () => {
  const selected = events => rule({ notify: { events } })
  const cases = [
    ['started', ['started']],
    ['completed', ['completed']],
    ['failed', ['failed']],
    ['cancelled', ['cancelled']],
    ['budget-stopped', ['budget']],
  ]
  for (const [status, matchingEvents] of cases) {
    for (const event of ['started', 'completed', 'failed', 'cancelled', 'budget']) {
      assert.equal(shouldNotifyAutomation(selected([event]), status), matchingEvents.includes(event), `${status}: ${event}`)
    }
  }
  assert.equal(shouldNotifyAutomation(selected(['started']), 'running'), false)
  assert.equal(shouldNotifyAutomation(selected(['completed']), 'partial'), false)
  for (const status of ['failed', 'partial', 'interrupted', 'stopped']) {
    assert.equal(shouldNotifyAutomation(selected(['failed']), status), true, status)
  }
  assert.equal(shouldNotifyAutomation(selected(['budget']), 'budget'), true)
  assert.equal(shouldNotifyAutomation(selected([]), 'completed'), false)
  assert.equal(shouldNotifyAutomation(selected(['completed']), 'not-a-status'), false)
  assert.equal(shouldNotifyAutomation(selected(['completed']), undefined), false)
})

test('budget-stopped completion preserves its outcome through notification selection and persistence', async t => {
  const context = await fixture(t, 'budget-stopped')
  const budgetRule = await context.store.create(rule({ notify: { events: ['budget'] }, enabled: true }))
  const execution = await context.store.recordExecution(budgetRule.id, {
    idempotencyKey: 'budget-run', status: 'running', startedAt: NOW,
  })
  const completed = completeAutomationExecution({
    execution,
    run: { id: 'run-budget', status: 'budget-stopped', finishedAt: NOW, error: { message: 'token budget reached' } },
  })
  assert.equal(completed.status, 'budget-stopped')
  assert.equal(shouldNotifyAutomation(budgetRule, completed.status), true)
  assert.equal(shouldNotifyAutomation(rule({ notify: { events: ['failed'] } }), completed.status), false)

  const saved = await context.store.completeExecution(budgetRule.id, execution.id, {
    status: completed.status, finishedAt: completed.finishedAt, runId: completed.runId,
    usage: completed.usage, result: completed.result, error: completed.error,
  })
  assert.equal(saved.status, 'budget-stopped')
  assert.equal(shouldNotifyAutomation(budgetRule, saved.status), true)
  const repeated = await context.store.completeExecution(budgetRule.id, execution.id, {
    status: 'failed', error: { message: 'late failure must not replace the outcome' },
  })
  assert.deepEqual(repeated, saved)
  const restarted = createAutomationRuleStore({ file: context.file, now: () => NOW })
  assert.deepEqual((await restarted.listExecutions({ ruleId: budgetRule.id }))[0], saved)
})

test('started is an explicit start notification, not a completion or running notification', () => {
  const startedRule = rule({ notify: { events: ['started'] } })
  assert.equal(shouldNotifyAutomation(startedRule, 'started'), true)
  assert.equal(shouldNotifyAutomation(startedRule, 'running'), false)
  assert.equal(completeAutomationExecution({
    execution: executionRecord('queued'), run: { id: 'run-starting', status: 'started' },
  }), null)
  for (const status of ['completed', 'failed', 'cancelled', 'budget-stopped']) {
    assert.equal(shouldNotifyAutomation(startedRule, status), false, status)
  }
})

test('execution completion is durable and idempotent', async t => {
  const context = await fixture(t, 'completion')
  const created = await context.store.create(rule())
  await context.store.toggle(created.id, { revision: 1 })
  const execution = await context.store.recordExecution(created.id, {
    idempotencyKey: 'exec-key', status: 'queued', startedAt: NOW,
  })
  const completed = await context.store.completeExecution(created.id, execution.id, {
    status: 'completed', finishedAt: NOW, runId: 'run-1', usage: { modelCalls: 2, tokens: 30, cost: 4 },
    result: { summary: 'done' },
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.runId, 'run-1')
  assert.deepEqual(completed.usage, { modelCalls: 2, tokens: 30, cost: 4 })
  const repeated = await context.store.completeExecution(created.id, execution.id, {
    status: 'failed', error: { message: 'late failure' },
  })
  assert.deepEqual(repeated, completed)
  const restarted = createAutomationRuleStore({ file: context.file, now: () => NOW })
  assert.deepEqual((await restarted.listExecutions({ ruleId: created.id }))[0], completed)
})

test('CRUD defaults disabled, persists atomically and survives restart', async t => {
  const context = await fixture(t, 'restart')
  const created = await context.store.create(rule())
  assert.equal(created.enabled, false)
  assert.equal(created.revision, 1)
  assert.match(created.id, /^rule_/)
  assert.equal(created.createdAt, iso(NOW))

  const enabled = await context.store.toggle(created.id, { revision: 1 })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.revision, 2)
  const updated = await context.store.update(created.id, { name: 'Renamed' }, { revision: 2 })
  assert.equal(updated.name, 'Renamed')
  assert.equal(updated.revision, 3)

  const restarted = createAutomationRuleStore({ file: context.file, now: () => NOW })
  assert.deepEqual(await restarted.get(created.id), updated)
  assert.deepEqual(await restarted.list(), [updated])
  const raw = JSON.parse(await fsp.readFile(context.file, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.rules[0].revision, 3)
  assert.deepEqual((await fsp.readdir(path.dirname(context.file))).sort(), ['rules.json'])

  const removed = await restarted.remove(created.id, { revision: 3 })
  assert.equal(removed.id, created.id)
  assert.equal(await restarted.get(created.id), null)
  assert.deepEqual(await restarted.list(), [])
})

test('stale revisions conflict across store instances without changing state bytes', async t => {
  const context = await fixture(t, 'revision')
  const created = await context.store.create(rule())
  const other = createAutomationRuleStore({ file: context.file, now: () => NOW })
  const before = await fsp.readFile(context.file, 'utf8')
  await assert.rejects(other.update(created.id, { name: 'Stale' }, { revision: 0 }), {
    code: 'revision-conflict', expectedRevision: 1, actualRevision: 0,
  })
  await assert.rejects(other.toggle(created.id, { revision: 0 }), { code: 'revision-conflict' })
  await assert.rejects(other.remove(created.id, { revision: 0 }), { code: 'revision-conflict' })
  assert.equal(await fsp.readFile(context.file, 'utf8'), before)

  const results = await Promise.allSettled([
    context.store.update(created.id, { name: 'Left' }, { revision: 1 }),
    other.update(created.id, { name: 'Right' }, { revision: 1 }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected').reason
  assert.equal(rejected.code, 'revision-conflict')
  assert.equal(rejected.expectedRevision, 2)
  assert.equal((await context.store.get(created.id)).revision, 2)

  const disabled = await other.toggle(created.id, false, { revision: 2 })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.revision, 3)
})

test('execution recording is idempotent across concurrent calls, disable and restart', async t => {
  const context = await fixture(t, 'idempotent')
  const created = await context.store.create(rule({ enabled: true }))
  const input = {
    idempotencyKey: 'delivery-123',
    status: 'completed',
    scheduledAt: '2026-03-01T12:00:00.000Z',
    startedAt: '2026-03-01T12:00:01.000Z',
    finishedAt: '2026-03-01T12:00:02.000Z',
    runId: 'run-123',
    usage: { modelCalls: 2, tokens: 20, cost: 1 },
    result: { ok: true },
  }
  const other = createAutomationRuleStore({ file: context.file, now: () => NOW })
  const results = await Promise.all([
    context.store.recordExecution(created.id, input),
    other.recordExecution(created.id, input),
  ])
  assert.equal(results[0].id, results[1].id)
  assert.equal(results[0].runId, 'run-123')
  assert.deepEqual(results[0], results[1])
  assert.equal((await context.store.listExecutions(created.id)).length, 1)

  const toggled = await context.store.toggle(created.id, { revision: created.revision })
  const restarted = createAutomationRuleStore({ file: context.file, now: () => NOW })
  assert.deepEqual(await restarted.recordExecution(created.id, { ...input, usage: { tokens: 999 } }), results[0])
  assert.equal((await restarted.listExecutions()).length, 1)
  await assert.rejects(restarted.recordExecution(created.id, { ...input, idempotencyKey: 'new-delivery' }), {
    code: 'rule-disabled',
  })
  assert.equal(toggled.enabled, false)
})

test('disabled is the create default and execution budgets are enforced', async t => {
  const context = await fixture(t, 'budget')
  const created = await context.store.create(rule({
    budget: { maxRuns: 2, maxModelCalls: 10, maxTokens: 100, maxCost: 10 },
  }))
  const execution = (key, tokens) => ({
    idempotencyKey: key, status: 'failed', usage: { modelCalls: 1, tokens, cost: 1 }, error: 'failed',
  })
  await assert.rejects(context.store.recordExecution(created.id, execution('disabled', 10)), { code: 'rule-disabled' })
  await context.store.toggle(created.id, { revision: 1 })
  await context.store.recordExecution(created.id, execution('one', 60))
  await context.store.recordExecution(created.id, execution('two', 40))
  await assert.rejects(context.store.recordExecution(created.id, execution('three', 1)), { code: 'budget-limit' })
  assert.equal((await context.store.listExecutions({ ruleId: created.id })).length, 2)
  assert.throws(() => normalizeAutomationRule(rule({ budget: { maxRuns: 0 } })), /integer/)
})

test('rule capacity is bounded and removing a rule frees capacity', async t => {
  const context = await fixture(t, 'capacity')
  const at = iso(NOW)
  const rules = Array.from({ length: 1000 }, (_, index) => normalizeAutomationRule(rule({
    id: `rule_${index}`, name: `Rule ${index}`, createdAt: at, updatedAt: at,
  })))
  await fsp.mkdir(path.dirname(context.file), { recursive: true })
  await fsp.writeFile(context.file, JSON.stringify({ version: 1, rules, executions: [], updatedAt: at }))

  await assert.rejects(context.store.create(rule()), { code: 'rule-limit' })
  await context.store.remove('rule_0', { revision: 1 })
  const created = await context.store.create(rule({ name: 'Replacement' }))
  assert.equal(created.name, 'Replacement')
  assert.equal((await context.store.list()).length, 1000)
})

test('malformed state is preserved and reads/previews have no side effects', async t => {
  const context = await fixture(t, 'invalid-state')
  assert.deepEqual(await context.store.list(), [])
  assert.deepEqual(await context.store.listExecutions(), [])
  assert.equal(await context.store.get('rule_missing'), null)
  assert.equal(await fsp.access(context.file).then(() => true, () => false), false)

  await fsp.mkdir(path.dirname(context.file), { recursive: true })
  await fsp.writeFile(context.file, '{broken')
  await assert.rejects(context.store.list(), AutomationStateError)
  await assert.rejects(context.store.create(rule()), AutomationStateError)
  assert.equal(await fsp.readFile(context.file, 'utf8'), '{broken')
})
