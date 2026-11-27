import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'

import {
  approveExecutionSpec,
  approvePlan,
  computePlanDigest,
  createCandidatePlanPreview,
  createPlanPreview,
  PlanPreviewError,
  previewPlan,
} from '../lib/plan-preview.js'

const ROOT = path.resolve('virtual-workspace').replaceAll('\\', '/')
const MODEL = 'test/model'
const PRICE = { input: 2, output: 4, cacheRead: 1, currency: 'CNY' }

function fixture() {
  return {
    goal: { id: 'goal-1', title: '准备发布', description: '生成并检查发布说明' },
    plan: {
      subtasks: [
        { id: 'research', title: '调研', model: MODEL, inputTokens: 1000, outputTokens: 500, capabilities: ['analysis'] },
        { id: 'draft', title: '起草', model: MODEL, dependsOn: ['research'], inputTokens: 1000, outputTokens: 500 },
        { id: 'review', title: '复核', model: MODEL, dependsOn: ['draft'], inputTokens: 1000, outputTokens: 500 },
      ],
    },
    limits: { maxModelCalls: 10, maxTokens: 10_000, maxCost: 1, maxTasks: 10 },
    capabilities: ['analysis', `model.${MODEL}`],
    pricing: { [MODEL]: PRICE },
    workspace: { root: ROOT, cwd: '.', sandbox: 'workspace', environment: { LANG: 'C' } },
    permissionPolicy: {
      allowedPermissions: ['read', 'write', 'execute', 'network'],
      allowedPaths: ['.'],
      deniedPaths: ['secret'],
    },
  }
}

function candidateFixture() {
  return {
    goal: { id: 'goal-2', title: '候选发布', description: '起草并复核发布说明' },
    project: { id: 'project-1', name: 'release-closeout' },
    subtasks: [
      { id: 'draft', title: '起草', inputTokens: 1000, outputTokens: 500 },
      {
        id: 'review', title: '复核', dependsOn: ['draft'], inputTokens: 1000, outputTokens: 500,
        operations: [{ type: 'fs.read', path: 'README.md' }],
      },
    ],
    capabilities: ['analysis', `model.${MODEL}`, 'read'],
    budget: { maxCost: 1, currency: 'CNY' },
    model: { name: MODEL, pricing: PRICE },
    permissionScope: {
      tools: ['read'], allow: ['read', `model.${MODEL}`], deny: ['network', 'shell.execute'], approvalMode: 'manual',
    },
    runtime: { cwd: ROOT, isolation: 'workspace', provider: 'host', environment: { LANG: 'C' } },
  }
}

function hasIssue(preview, code, severity = 'block') {
  return preview.issues.some(item => item.code === code && item.severity === severity)
}

function throwsCode(callback, code) {
  assert.throws(callback, error => {
    assert.ok(error instanceof PlanPreviewError)
    assert.equal(error.code, code)
    return true
  })
}

test('preview builds a stable subtask DAG and exact call, token, and cost estimates', () => {
  const input = fixture()
  input.plan.subtasks.splice(1, 0, {
    id: 'assets', title: '素材', model: MODEL, inputTokens: 1000, outputTokens: 500,
  })
  input.plan.subtasks.find(task => task.id === 'review').dependsOn = ['draft', 'assets']
  const before = structuredClone(input)
  const preview = createPlanPreview(input)

  assert.equal(preview.status, 'ready')
  assert.equal(preview.canApprove, true)
  assert.equal(preview.dag.acyclic, true)
  assert.deepEqual(preview.dag.roots, ['research', 'assets'])
  assert.deepEqual(preview.dag.executionOrder, ['research', 'assets', 'draft', 'review'])
  assert.deepEqual(preview.dag.levels, [
    { id: 'research', level: 0 }, { id: 'assets', level: 0 },
    { id: 'draft', level: 1 }, { id: 'review', level: 2 },
  ])
  assert.deepEqual(preview.dag.tasks.find(task => task.id === 'review').dependsOn, ['assets', 'draft'])
  assert.equal(preview.estimate.modelCalls, 4)
  assert.deepEqual(preview.estimate.tokens, { input: 4000, output: 2000, cacheRead: 0, total: 6000 })
  assert.equal(preview.estimate.cost.complete, true)
  assert.equal(preview.estimate.cost.currency, 'CNY')
  assert.equal(preview.estimate.cost.totalMicros, 16_000)
  assert.equal(preview.estimate.cost.total, 0.016)
  assert.equal(preview.estimate.byTask.length, 4)
  assert.ok(preview.estimate.budget.every(check => check.withinBudget))
  assert.equal(preview.runtime.cwd, ROOT)
  assert.equal(preview.runtime.mode, 'preview')
  assert.deepEqual(preview.permissionScope.filesystemRoots, { read: [ROOT], write: [ROOT] })
  assert.equal(preview.sideEffects, 'none')
  assert.equal(preview.executionStarted, false)
  assert.deepEqual(input, before, 'preview must not mutate its inputs')
  assert.equal(previewPlan, createPlanPreview)
  assert.equal(approveExecutionSpec, approvePlan)
})

test('a valid approval produces a normalised execution spec without starting it', () => {
  const preview = createPlanPreview(fixture())
  const spec = approvePlan(preview, { planDigest: preview.planDigest, approvedBy: 'tester' })

  assert.equal(spec.kind, 'execution-spec')
  assert.equal(spec.state, 'approved')
  assert.equal(spec.planDigest, preview.planDigest)
  assert.equal(spec.approvedBy, 'tester')
  assert.deepEqual(spec.dag.executionOrder, ['research', 'draft', 'review'])
  assert.equal(spec.runtime.mode, 'execute')
  assert.equal(spec.executionStarted, false)
  assert.equal(computePlanDigest(preview), preview.planDigest)
  assert.match(preview.planDigest, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(approvePlan(preview, preview.planDigest), { ...spec, approvedBy: null })
})

test('digest is canonical and bound to plan content and approval inputs', () => {
  const first = fixture()
  const second = {
    permissionPolicy: first.permissionPolicy,
    workspace: first.workspace,
    pricing: first.pricing,
    capabilities: first.capabilities,
    limits: first.limits,
    plan: first.plan,
    goal: first.goal,
  }
  const a = createPlanPreview(first)
  const b = createPlanPreview(second)
  assert.equal(a.planDigest, b.planDigest, 'object key order must not affect the digest')
  assert.notEqual(a.planDigest, computePlanDigest({ ...first, limits: { ...first.limits, maxCost: 2 } }))

  const changedPlan = structuredClone(a)
  changedPlan.dag.tasks[0].description = 'tampered derived plan'
  throwsCode(() => approvePlan(changedPlan, { planDigest: a.planDigest }), 'PLAN_TAMPERED')

  const changedSource = structuredClone(a)
  changedSource.inputSnapshot.plan.subtasks[0].title = 'tampered source'
  throwsCode(() => approvePlan(changedSource, { planDigest: a.planDigest }), 'PLAN_DIGEST_MISMATCH')

  const changedDigest = structuredClone(a)
  changedDigest.planDigest = 'sha256:' + '0'.repeat(64)
  throwsCode(() => approvePlan(changedDigest, { planDigest: changedDigest.planDigest }), 'PLAN_DIGEST_MISMATCH')
  throwsCode(() => approvePlan(a, { planDigest: 'sha256:' + '0'.repeat(64) }), 'PLAN_DIGEST_MISMATCH')
  throwsCode(() => approvePlan(a, {}), 'PLAN_DIGEST_REQUIRED')
})

test('a missing model price blocks approval instead of becoming a zero-cost plan', () => {
  const input = fixture()
  input.pricing = {}
  const preview = createPlanPreview(input)

  assert.equal(preview.status, 'blocked')
  assert.ok(hasIssue(preview, 'pricing_missing'))
  assert.ok(hasIssue(preview, 'budget_unverified', 'warning'))
  assert.equal(preview.estimate.complete, false)
  assert.equal(preview.estimate.cost.complete, false)
  assert.deepEqual(preview.estimate.cost.unpriced, [MODEL])
  assert.equal(preview.estimate.byTask[0].cost.records[0].amountMicros, null)
  throwsCode(() => approvePlan(preview, { planDigest: preview.planDigest }), 'PLAN_BLOCKED')
})

test('missing model and operation capabilities are explicit blockers', () => {
  const modelMissing = fixture()
  modelMissing.capabilities = ['analysis']
  const preview = createPlanPreview(modelMissing)
  assert.equal(preview.status, 'blocked')
  assert.ok(hasIssue(preview, 'capability_missing'))
  assert.ok(preview.capabilities.missing.includes(`model.${MODEL}`))

  const operationMissing = fixture()
  operationMissing.plan.subtasks = [{
    id: 'write', operations: [{ type: 'fs.write', path: 'src/output.md' }],
  }]
  operationMissing.capabilities = ['filesystem.read']
  const operationPreview = createPlanPreview(operationMissing)
  assert.equal(operationPreview.status, 'blocked')
  assert.ok(operationPreview.capabilities.missing.includes('filesystem.write'))
  assert.ok(hasIssue(operationPreview, 'capability_missing'))
})

test('nested capability and permission aliases normalize to the same scope', () => {
  const input = fixture()
  input.capabilities = { fs: { read: true, write: true }, models: [MODEL] }
  input.permissionPolicy = {
    permissions: { filesystem: { read: true, write: true } },
    paths: { read: ['.'], write: ['src'], denied: ['secret'] },
  }
  input.plan.subtasks = [{
    id: 'write', model: MODEL, inputTokens: 10, outputTokens: 5,
    operations: [{ type: 'fs.write', path: 'src/out.md' }],
  }]
  const preview = createPlanPreview(input)
  assert.equal(preview.status, 'ready')
  assert.ok(preview.capabilities.available.includes('filesystem.write'))
  assert.ok(preview.capabilities.available.includes(`models.${MODEL}`))
  assert.deepEqual(preview.permissionScope.filesystemRoots, {
    read: [ROOT], write: [`${ROOT}/src`],
  })
  assert.equal(preview.runtime.pathEnforcement.symlinks, 'revalidate-or-reject-before-use')
})

test('dependency cycles and missing dependencies block execution ordering', () => {
  const cyclic = fixture()
  cyclic.plan.subtasks[0].dependsOn = ['review']
  const cyclePreview = createPlanPreview(cyclic)
  assert.equal(cyclePreview.status, 'blocked')
  assert.equal(cyclePreview.dag.acyclic, false)
  assert.deepEqual(cyclePreview.dag.executionOrder, [])
  assert.ok(hasIssue(cyclePreview, 'dependency_cycle'))
  assert.ok(cyclePreview.issues.find(item => item.code === 'dependency_cycle').cycle.length >= 3)

  const missing = fixture()
  missing.plan.subtasks[0].dependsOn = ['not-there']
  const missingPreview = createPlanPreview(missing)
  assert.equal(missingPreview.status, 'blocked')
  assert.ok(hasIssue(missingPreview, 'dependency_missing'))
  assert.deepEqual(missingPreview.dag.executionOrder, [])
})

test('workspace escapes, denied paths, and paths outside policy roots all block', () => {
  const cases = [
    { operation: { type: 'fs.read', path: '../outside.txt' }, policy: {}, reason: 'outside_workspace' },
    { operation: { type: 'fs.read', path: path.resolve(ROOT, '..', 'outside.txt') }, policy: {}, reason: 'outside_workspace' },
    { operation: { type: 'fs.read', path: 'secret/token.txt' }, policy: { deniedPaths: ['secret'] }, reason: 'denied_path' },
    { operation: { type: 'fs.write', path: 'README.md' }, policy: { allowedPaths: ['src'] }, reason: 'outside_allowed_paths' },
    { operation: { type: 'fs.write', path: 'src/ok.md' }, policy: { writePaths: [] }, reason: 'outside_allowed_paths' },
    { operation: { type: 'fs.read', path: 'file:///etc/passwd' }, policy: {}, reason: 'invalid_path' },
  ]
  for (const { operation, policy, reason } of cases) {
    const input = fixture()
    input.plan.subtasks = [{ id: 'paths', operations: [operation] }]
    input.permissionPolicy = { allowedPermissions: ['read', 'write'], ...policy }
    const preview = createPlanPreview(input)
    assert.equal(preview.status, 'blocked', reason)
    const blocker = preview.issues.find(item => item.code === 'path_not_allowed')
    assert.ok(blocker, reason)
    if (reason === 'invalid_path') assert.equal(blocker.path, operation.path)
    else if (reason === 'outside_workspace') assert.equal(blocker.path.startsWith(`${ROOT}/`), false)
    else assert.ok(blocker.path.startsWith(`${ROOT}/`))
    assert.equal(blocker.reason, reason)
  }
})

test('shell commands cannot smuggle an absolute path outside the workspace', () => {
  const input = fixture()
  input.plan.subtasks = [{
    id: 'shell',
    operations: [{ type: 'shell.execute', command: `cat "${path.resolve(ROOT, '..', 'outside.txt')}"` }],
  }]
  input.capabilities.push('shell.execute')
  const preview = createPlanPreview(input)
  assert.equal(preview.status, 'blocked')
  assert.ok(hasIssue(preview, 'path_not_allowed'))
  assert.ok(hasIssue(preview, 'shell_command_review', 'warning'))
})

test('permission denial and budget or usage limit overruns block approval', () => {
  const denied = fixture()
  denied.plan.subtasks = [{ id: 'write', operations: [{ type: 'fs.write', path: 'src/out.md' }] }]
  denied.permissionPolicy.allowedPermissions = ['read']
  denied.capabilities.push('filesystem.write')
  const deniedPreview = createPlanPreview(denied)
  assert.equal(deniedPreview.status, 'blocked')
  assert.ok(hasIssue(deniedPreview, 'permission_not_allowed'))

  for (const [limits, code] of [
    [{ maxCost: 0.01 }, 'budget_exceeded'],
    [{ maxCost: { CNY: 0.01 } }, 'budget_exceeded'],
    [{ maxCostMicros: 11_999 }, 'budget_exceeded'],
    [{ maxModelCalls: 2 }, 'model_call_limit_exceeded'],
    [{ maxTokens: 4499 }, 'token_limit_exceeded'],
    [{ maxTasks: 2 }, 'task_limit_exceeded'],
  ]) {
    const preview = createPlanPreview({ ...fixture(), limits })
    assert.equal(preview.status, 'blocked', code)
    assert.ok(hasIssue(preview, code), code)
  }
})

test('destructive actions and shell expansions require explicit confirmation', () => {
  const input = fixture()
  input.plan.subtasks = [{
    id: 'cleanup',
    operations: [{ type: 'delete', path: 'old.md' }],
  }]
  input.capabilities.push('filesystem.write')
  const preview = createPlanPreview(input)
  assert.equal(preview.status, 'needs_confirmation')
  assert.equal(preview.pendingConfirmations.length, 1)
  const confirmation = preview.pendingConfirmations[0].id
  throwsCode(() => approvePlan(preview, { planDigest: preview.planDigest }), 'CONFIRMATION_REQUIRED')
  const spec = approvePlan(preview, { planDigest: preview.planDigest, confirmations: [{ id: confirmation }] })
  assert.deepEqual(spec.approval.confirmations, [confirmation])

  const shell = fixture()
  shell.plan.subtasks = [{ id: 'shell', operations: [{ type: 'shell.execute', command: 'cat "$HOME/file"' }] }]
  shell.capabilities.push('shell.execute')
  const shellPreview = createPlanPreview(shell)
  assert.equal(shellPreview.status, 'needs_confirmation')
  assert.ok(shellPreview.pendingConfirmations.some(item => item.id.endsWith(':shell-expansion:0')))
})

test('duplicate ids, invalid estimates, and invalid workspaces fail closed', () => {
  const duplicate = fixture()
  duplicate.plan.subtasks[1].id = 'research'
  const duplicatePreview = createPlanPreview(duplicate)
  assert.equal(duplicatePreview.status, 'blocked')
  assert.ok(hasIssue(duplicatePreview, 'duplicate_task_id'))
  assert.deepEqual(duplicatePreview.dag.executionOrder, [])

  const invalidTokens = fixture()
  invalidTokens.plan.subtasks[0].inputTokens = -1
  assert.ok(hasIssue(createPlanPreview(invalidTokens), 'invalid_token_estimate'))

  const invalidWorkspace = createPlanPreview({ ...fixture(), workspace: 'relative/workspace' })
  assert.equal(invalidWorkspace.status, 'blocked')
  assert.ok(hasIssue(invalidWorkspace, 'workspace_required'))
  assert.doesNotThrow(() => createPlanPreview({ goal: 'x', plan: [], workspace: null }))
})

test('candidate preview exposes a DAG, estimate, explicit permissions, and runtime without side effects', () => {
  const input = candidateFixture()
  const before = structuredClone(input)
  const preview = createCandidatePlanPreview(input)

  assert.equal(preview.kind, 'candidate-plan-preview')
  assert.equal(preview.status, 'ready')
  assert.equal(preview.canApprove, true)
  assert.equal(preview.dag.acyclic, true)
  assert.deepEqual(preview.dag.executionOrder, ['draft', 'review'])
  assert.equal(preview.estimate.modelCalls, 2)
  assert.deepEqual(preview.estimate.tokens, { input: 2000, output: 1000, cacheRead: 0, total: 3000 })
  assert.equal(preview.estimate.cost.currency, 'CNY')
  assert.equal(preview.estimate.cost.totalMicros, 8000)
  assert.equal(preview.estimate.budgetConfigured, true)
  assert.ok(preview.estimate.budget.every(check => check.withinBudget))
  assert.deepEqual(preview.permissionScope.tools, ['filesystem.read'])
  assert.deepEqual(preview.permissionScope.allow, ['filesystem.read', `model.${MODEL}`])
  assert.deepEqual(preview.permissionScope.deny, ['network', 'shell.execute'])
  assert.equal(preview.permissionScope.approvalMode, 'manual')
  assert.deepEqual(preview.permissionScope.filesystemRoots, { read: [ROOT], write: [] })
  assert.equal(preview.runtime.cwd, ROOT)
  assert.equal(preview.runtime.isolation, 'workspace')
  assert.equal(preview.runtime.provider, 'host')
  assert.equal(preview.runtime.platform, null)
  assert.equal(preview.runtime.shell, null)
  assert.deepEqual(preview.runtime.environment, { LANG: 'C' })
  assert.equal(preview.sideEffects, 'none')
  assert.equal(preview.executionStarted, false)
  assert.equal(computePlanDigest(input), preview.planDigest)
  assert.equal(computePlanDigest(preview), preview.planDigest)
  assert.deepEqual(input, before, 'candidate preview must not mutate its inputs')
})

test('candidate preview fills an empty allow list from normalized tools and preserves deny and approval mode', () => {
  const input = candidateFixture()
  input.subtasks = [{
    id: 'update',
    operations: [
      { type: 'read_file', path: 'README.md' },
      { type: 'edit', path: 'README.md' },
    ],
  }]
  input.capabilities.push('filesystem.write')
  input.permissionScope = {
    tools: ['read_file', 'write', 'edit'],
    allow: [],
    deny: ['network.request'],
    approvalMode: 'policy',
  }
  const before = structuredClone(input)
  const preview = createCandidatePlanPreview(input)

  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.permissionScope.tools, ['filesystem.read', 'filesystem.write'])
  assert.deepEqual(preview.permissionScope.allow, ['filesystem.read', 'filesystem.write'])
  assert.deepEqual(preview.permissionScope.deny, ['network'])
  assert.equal(preview.permissionScope.approvalMode, 'policy')
  assert.deepEqual(preview.permissionScope.filesystemRoots, { read: [ROOT], write: [ROOT] })
  const credential = approvePlan(preview, { planDigest: preview.planDigest })
  assert.deepEqual(credential.permissionScope, preview.permissionScope)
  assert.deepEqual(input, before, 'normalizing generated permissions must not mutate the input')
})

test('candidate preview fails closed for missing permissions or runtime and only warns for a missing budget', () => {
  const noPermissions = candidateFixture()
  delete noPermissions.permissionScope
  const permissionPreview = createCandidatePlanPreview(noPermissions)
  assert.equal(permissionPreview.status, 'blocked')
  assert.ok(hasIssue(permissionPreview, 'permission_scope_required'))
  assert.deepEqual(
    { tools: permissionPreview.permissionScope.tools, allow: permissionPreview.permissionScope.allow, deny: permissionPreview.permissionScope.deny, approvalMode: permissionPreview.permissionScope.approvalMode },
    { tools: null, allow: null, deny: null, approvalMode: null },
  )

  const noAllow = candidateFixture()
  delete noAllow.permissionScope.allow
  const noAllowPreview = createCandidatePlanPreview(noAllow)
  assert.equal(noAllowPreview.status, 'blocked')
  assert.ok(hasIssue(noAllowPreview, 'permission_scope_incomplete'))
  assert.equal(noAllowPreview.permissionScope.allow, null)

  const noRuntime = candidateFixture()
  delete noRuntime.runtime
  const runtimePreview = createCandidatePlanPreview(noRuntime)
  assert.equal(runtimePreview.status, 'blocked')
  assert.ok(hasIssue(runtimePreview, 'runtime_required'))
  assert.equal(runtimePreview.runtime.cwd, null)
  assert.equal(runtimePreview.runtime.isolation, null)
  assert.equal(runtimePreview.runtime.provider, null)

  const partialRuntime = candidateFixture()
  delete partialRuntime.runtime.provider
  const partialPreview = createCandidatePlanPreview(partialRuntime)
  assert.equal(partialPreview.status, 'blocked')
  assert.ok(hasIssue(partialPreview, 'runtime_incomplete'))
  assert.equal(partialPreview.runtime.provider, null)

  const noBudget = candidateFixture()
  delete noBudget.budget
  const budgetPreview = createCandidatePlanPreview(noBudget)
  assert.equal(budgetPreview.status, 'ready')
  assert.ok(hasIssue(budgetPreview, 'budget_missing', 'warning'))
  assert.equal(budgetPreview.budget, null)
  assert.equal(budgetPreview.estimate.budgetConfigured, false)
  assert.deepEqual(budgetPreview.estimate.budget, [])
})

test('candidate permission, capability, and budget checks block instead of inventing access or cost', () => {
  const denied = candidateFixture()
  denied.permissionScope.deny.push('filesystem.read')
  const deniedPreview = createCandidatePlanPreview(denied)
  assert.equal(deniedPreview.status, 'blocked')
  assert.ok(hasIssue(deniedPreview, 'tool_denied'))
  assert.ok(hasIssue(deniedPreview, 'permission_not_allowed'))

  const outOfScope = candidateFixture()
  outOfScope.permissionScope.tools = []
  const scopePreview = createCandidatePlanPreview(outOfScope)
  assert.equal(scopePreview.status, 'blocked')
  assert.ok(hasIssue(scopePreview, 'tool_not_in_scope'))

  const noCapabilities = candidateFixture()
  delete noCapabilities.capabilities
  const capabilityPreview = createCandidatePlanPreview(noCapabilities)
  assert.equal(capabilityPreview.status, 'blocked')
  assert.ok(hasIssue(capabilityPreview, 'capability_missing'))

  const overBudget = candidateFixture()
  overBudget.budget.maxCost = 0.001
  const budgetPreview = createCandidatePlanPreview(overBudget)
  assert.equal(budgetPreview.status, 'blocked')
  assert.ok(hasIssue(budgetPreview, 'budget_exceeded'))

  const invalidBudget = candidateFixture()
  invalidBudget.budget.maxCost = -1
  assert.ok(hasIssue(createCandidatePlanPreview(invalidBudget), 'invalid_limits'))

  const emptyBudget = candidateFixture()
  emptyBudget.budget = {}
  assert.ok(hasIssue(createCandidatePlanPreview(emptyBudget), 'invalid_budget'))

  const wrongCurrency = candidateFixture()
  wrongCurrency.budget = { maxCostUsd: 1 }
  const currencyPreview = createCandidatePlanPreview(wrongCurrency)
  assert.equal(currencyPreview.status, 'blocked')
  assert.ok(hasIssue(currencyPreview, 'budget_currency_missing'))

  const usdBudget = candidateFixture()
  usdBudget.model.pricing = { ...PRICE, currency: 'USD' }
  usdBudget.budget = { maxCostUsd: 1 }
  assert.equal(createCandidatePlanPreview(usdBudget).status, 'ready')

  const noProject = candidateFixture()
  delete noProject.project
  assert.ok(hasIssue(createCandidatePlanPreview(noProject), 'project_required'))

  const unpriced = candidateFixture()
  delete unpriced.model.pricing
  const unpricedPreview = createCandidatePlanPreview(unpriced)
  assert.equal(unpricedPreview.status, 'blocked')
  assert.ok(hasIssue(unpricedPreview, 'pricing_missing'))
  assert.equal(unpricedPreview.estimate.cost.complete, false)
  assert.ok(unpricedPreview.estimate.budget.every(check => check.withinBudget === null))
  assert.equal(unpricedPreview.estimate.cost.totalMicros, null)

  delete unpriced.budget
  const unverifiedPreview = createCandidatePlanPreview(unpriced)
  assert.equal(unverifiedPreview.status, 'ready')
  assert.ok(hasIssue(unverifiedPreview, 'pricing_missing', 'warning'))
  assert.ok(hasIssue(unverifiedPreview, 'budget_missing', 'warning'))
  assert.equal(unverifiedPreview.estimate.cost.totalMicros, null)
})

test('candidate approval returns only an exact-digest-bound credential and never an execution spec', () => {
  const preview = createCandidatePlanPreview(candidateFixture())
  const credential = approvePlan(preview, { planDigest: preview.planDigest, approvedBy: 'tester' })

  assert.equal(credential.kind, 'plan-approval-credential')
  assert.equal(credential.state, 'approved')
  assert.equal(credential.planDigest, preview.planDigest)
  assert.equal(credential.approvedBy, 'tester')
  assert.deepEqual(credential.permissionScope, preview.permissionScope)
  assert.deepEqual(credential.runtime, preview.runtime)
  assert.equal(credential.executionStarted, false)
  assert.equal('dag' in credential, false)
  assert.equal('estimate' in credential, false)
  assert.deepEqual(approvePlan(preview, preview.planDigest), { ...credential, approvedBy: null })

  throwsCode(() => approvePlan(preview, { planDigest: 'sha256:' + '0'.repeat(64) }), 'PLAN_DIGEST_MISMATCH')
  throwsCode(() => approvePlan(preview, {}), 'PLAN_DIGEST_REQUIRED')

  const changedRuntime = structuredClone(preview)
  changedRuntime.runtime.provider = 'other'
  throwsCode(() => approvePlan(changedRuntime, { planDigest: preview.planDigest }), 'PLAN_TAMPERED')

  const changedSource = structuredClone(preview)
  changedSource.inputSnapshot.subtasks[0].title = 'tampered source'
  throwsCode(() => approvePlan(changedSource, { planDigest: preview.planDigest }), 'PLAN_DIGEST_MISMATCH')

  const blocked = createCandidatePlanPreview({ ...candidateFixture(), runtime: {} })
  throwsCode(() => approvePlan(blocked, { planDigest: blocked.planDigest }), 'PLAN_BLOCKED')
})

test('candidate confirmations remain explicit while status stays ready or blocked', () => {
  const input = candidateFixture()
  input.permissionScope.tools.push('filesystem.write')
  input.permissionScope.allow.push('filesystem.write')
  input.capabilities.push('filesystem.write')
  input.subtasks = [{ id: 'cleanup', operations: [{ type: 'delete', path: 'old.md' }] }]
  delete input.model
  const preview = createCandidatePlanPreview(input)

  assert.equal(preview.status, 'ready')
  assert.ok(hasIssue(preview, 'confirmation_required', 'warning'))
  assert.equal(preview.pendingConfirmations.length, 1)
  const confirmation = preview.pendingConfirmations[0].id
  throwsCode(() => approvePlan(preview, { planDigest: preview.planDigest }), 'CONFIRMATION_REQUIRED')
  const credential = approvePlan(preview, { planDigest: preview.planDigest, confirmations: [confirmation] })
  assert.deepEqual(credential.approval.confirmations, [confirmation])
  assert.equal(credential.executionStarted, false)
})

test('preview and approval have no model, filesystem, network, timer, or process side effects', async t => {
  const calls = []
  const patches = [
    [fs, 'writeFile'], [fs, 'writeFileSync'], [fs, 'appendFile'], [fs, 'appendFileSync'],
    [fs, 'mkdir'], [fs, 'mkdirSync'], [fs, 'rename'], [fs, 'renameSync'], [fs, 'rm'], [fs, 'rmSync'],
    [fs, 'unlink'], [fs, 'unlinkSync'], [fs, 'readFile'], [fs, 'readFileSync'], [fs, 'readdir'], [fs, 'readdirSync'],
    [fsp, 'writeFile'], [fsp, 'appendFile'], [fsp, 'mkdir'], [fsp, 'rename'], [fsp, 'rm'], [fsp, 'unlink'], [fsp, 'readFile'], [fsp, 'readdir'],
    [childProcess, 'spawn'], [childProcess, 'spawnSync'], [childProcess, 'exec'], [childProcess, 'execSync'], [childProcess, 'fork'],
    [http, 'request'], [https, 'request'], [net, 'connect'], [net, 'createConnection'],
    [globalThis, 'fetch'], [globalThis, 'setTimeout'], [globalThis, 'setInterval'],
    [process, 'exit'],
  ]
  const originals = new Map()
  for (const [object, key] of patches) {
    originals.set(object, key, Object.getOwnPropertyDescriptor(object, key))
    object[key] = (...args) => { calls.push(`${object === globalThis ? 'global' : 'builtin'}.${key}`); return undefined }
  }
  syncBuiltinESMExports()
  t.after(() => {
    for (const [object, key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(object, key, descriptor)
      else delete object[key]
    }
    syncBuiltinESMExports()
  })

  let modelCalls = 0
  let startedRuns = 0
  const module = await import(`../lib/plan-preview.js?no-side-effects=${Date.now()}`)
  const input = fixture()
  input.generate = () => { modelCalls += 1 }
  input.startRun = () => { startedRuns += 1 }
  const preview = module.createPlanPreview(input)
  const spec = module.approvePlan(preview, { planDigest: preview.planDigest })
  const candidatePreview = module.createCandidatePlanPreview(candidateFixture())
  const credential = module.approvePlan(candidatePreview, { planDigest: candidatePreview.planDigest })
  assert.equal(spec.executionStarted, false)
  assert.equal(credential.kind, 'plan-approval-credential')
  assert.equal(credential.executionStarted, false)
  assert.equal(modelCalls, 0)
  assert.equal(startedRuns, 0)
  assert.deepEqual(calls, [])
})
