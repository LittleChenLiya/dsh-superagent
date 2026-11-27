import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runParityBenchmark } from '../scripts/benchmark-parity.mjs'

test('routed tasks default to direct execution and bypass the planner', async () => {
  const [host, router] = await Promise.all([
    fsp.readFile(new URL('../lib/index.js', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../lib/router.js', import.meta.url), 'utf8'),
  ])
  assert.ok(host.includes("const direct = action === 'task' && execution !== 'planned' && !approvedPhases && !batch"))
  assert.ok(host.includes("mode: 'direct'"))
  assert.ok(router.includes("execution: raw.execution === 'planned' ? 'planned' : 'direct'"))
})

function fakeRunner(body) {
  return {
    command: process.execPath,
    args: ['-e', `
      let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', async () => {
        const request = JSON.parse(input)
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const emit = value => console.log(JSON.stringify({
          durationMs: 1,
          usage: { modelCalls: 1, totalTokens: 1, cost: 0 },
          ...value,
        }))
        try {
          ${body}
        } catch (error) {
          console.error(error)
          process.exitCode = 1
        }
      })
    `],
  }
}

const resultRunner = result => fakeRunner(`emit(${JSON.stringify(result)})`)

async function createTempRoot(t, prefix = 'superagent-parity-') {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }))
  return tempRoot
}

test('parity benchmark passes equal runners and blocks a worse superagent', async t => {
  const tempRoot = await createTempRoot(t)
  const cases = [{ id: 'qa', prompt: 'answer', checks: [{ type: 'contains', value: 'ok' }] }]
  const equal = await runParityBenchmark({ cases, tempRoot, runners: { baseline: resultRunner({ status: 'completed', output: 'ok' }), superagent: resultRunner({ status: 'completed', output: 'ok' }) } })
  assert.equal(equal.ok, true)
  assert.equal(equal.summary.baseline.successes, 1)
  assert.equal(equal.summary.superagent.successes, 1)
  assert.equal(equal.cases[0].baseline.passed, true)
  assert.equal(equal.cases[0].superagent.passed, true)

  const worse = await runParityBenchmark({ cases, tempRoot, runners: { baseline: resultRunner({ status: 'completed', output: 'ok' }), superagent: resultRunner({ status: 'completed', output: 'missing' }) } })
  assert.equal(worse.ok, false)
  assert.match(worse.violations[0], /below baseline/)
  assert.equal(worse.summary.superagent.successes, 0)
})

test('parity gate compares scores even when both runners fail the same case', async t => {
  const tempRoot = await createTempRoot(t)
  const cases = [{ id: 'partial', prompt: 'answer', checks: [
    { type: 'contains', value: 'first' },
    { type: 'contains', value: 'second' },
  ] }]
  const report = await runParityBenchmark({ cases, tempRoot, runners: {
    baseline: resultRunner({ status: 'completed', output: 'first' }),
    superagent: resultRunner({ status: 'completed', output: 'neither' }),
  } })
  assert.equal(report.summary.baseline.successes, 0)
  assert.equal(report.summary.superagent.successes, 0)
  assert.equal(report.summary.baseline.score, 0.5)
  assert.equal(report.summary.superagent.score, 0)
  assert.equal(report.ok, false)
  assert.ok(report.violations.some(violation => /total score 0 below baseline 0.5/.test(violation)))
})

test('parity gate fails on fewer successes even when numeric scores are equal', async t => {
  const tempRoot = await createTempRoot(t)
  const cases = [{ id: 'success-count', prompt: 'answer', checks: [] }]
  const report = await runParityBenchmark({ cases, tempRoot, runners: {
    baseline: resultRunner({ status: 'completed', output: 'ok' }),
    superagent: resultRunner({ status: 'skipped', output: 'ok' }),
  } })
  assert.equal(report.summary.baseline.score, report.summary.superagent.score)
  assert.equal(report.summary.baseline.successes, 1)
  assert.equal(report.summary.superagent.successes, 0)
  assert.equal(report.ok, false)
  assert.ok(report.violations.some(violation => /succeeded 0 times below baseline 1/.test(violation)))
})

test('latency and cost are reported but do not fail parity', async t => {
  const tempRoot = await createTempRoot(t)
  const cases = [{ id: 'metrics', prompt: 'answer', checks: [{ type: 'contains', value: 'ok' }] }]
  const report = await runParityBenchmark({ cases, tempRoot, runners: {
    baseline: resultRunner({ status: 'completed', output: 'ok', durationMs: 1, usage: { cost: 0, totalTokens: 1 } }),
    superagent: resultRunner({ status: 'completed', output: 'ok', durationMs: 900000, usage: { cost: 12345, totalTokens: 999999 } }),
  } })
  assert.equal(report.ok, true)
  assert.deepEqual(report.violations, [])
  assert.equal(report.summary.baseline.durationMs, 1)
  assert.equal(report.summary.superagent.durationMs, 900000)
  assert.equal(report.summary.baseline.usage.cost, 0)
  assert.equal(report.summary.superagent.usage.cost, 12345)
})

test('legacy runner request and response protocol remains backward compatible', async t => {
  const tempRoot = await createTempRoot(t)
  const legacyRunner = fakeRunner(`
    const keys = Object.keys(request).sort()
    if (JSON.stringify(keys) !== JSON.stringify(['caseId', 'prompt', 'workdir'])) throw new Error('unexpected request fields: ' + keys)
    emit({ status: 'completed', output: 'legacy protocol ok' })
  `)
  const cases = [{ id: 'legacy', prompt: 'answer', checks: [{ type: 'contains', value: 'legacy protocol ok' }] }]
  const report = await runParityBenchmark({ cases, tempRoot, runners: { baseline: legacyRunner, superagent: legacyRunner } })
  assert.equal(report.ok, true)
  assert.ok(report.cases.every(row => row.baseline.passed && row.superagent.passed))
})

test('browser-required work degrades with a reported limitation instead of skipping', async t => {
  const tempRoot = await createTempRoot(t)
  const testcase = {
    id: 'browser-required',
    prompt: 'inspect the page with a browser',
    checks: [
      { type: 'status', equals: 'degraded' },
      { type: 'jsonPath', path: 'limitations[0].code', equals: 'browser-unavailable' },
      { type: 'contains', value: '浏览器不可用' },
    ],
  }
  const degradedRunner = resultRunner({ status: 'degraded', output: '浏览器不可用，已报告限制。', limitations: [{ code: 'browser-unavailable' }] })
  const degraded = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: degradedRunner, superagent: degradedRunner } })
  assert.equal(degraded.ok, true)
  assert.equal(degraded.cases[0].superagent.status, 'degraded')
  assert.equal(degraded.cases[0].superagent.passed, true)
  assert.deepEqual(degraded.cases[0].superagent.limitations, [{ code: 'browser-unavailable' }])

  const skipped = await runParityBenchmark({ cases: [testcase], tempRoot, runners: {
    baseline: degradedRunner,
    superagent: resultRunner({ status: 'skipped', output: '浏览器不可用，已报告限制。', limitations: [{ code: 'browser-unavailable' }] }),
  } })
  assert.equal(skipped.ok, false)
  assert.equal(skipped.cases[0].superagent.status, 'skipped')
  assert.equal(skipped.cases[0].superagent.passed, false)
  assert.match(skipped.cases[0].superagent.failures[0], /status skipped/)
})

test('approval denial is retried and the final result must complete', async t => {
  const tempRoot = await createTempRoot(t)
  const testcase = {
    id: 'approval-retry',
    prompt: 'perform the approved task',
    maxAttempts: 2,
    retryStatuses: ['approval-denied'],
    checks: [
      { type: 'status', equals: 'completed' },
      { type: 'jsonPath', path: 'attempts.0.status', equals: 'approval-denied' },
      { type: 'jsonPath', path: 'attempts.1.status', equals: 'completed' },
      { type: 'contains', value: 'retry approved' },
    ],
  }
  const retryRunner = fakeRunner(`
    if (![1, 2].includes(request.attempt) || request.maxAttempts !== 2) throw new Error('missing retry metadata')
    emit(request.attempt === 1
      ? { status: 'approval-denied', output: 'approval denied' }
      : { status: 'completed', output: 'retry approved; task completed' })
  `)
  const report = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: retryRunner, superagent: retryRunner } })
  assert.equal(report.ok, true)
  assert.deepEqual(report.cases[0].superagent.attempts.map(attempt => attempt.status), ['approval-denied', 'completed'])
  assert.equal(report.cases[0].superagent.durationMs, 2)

  const deniedRunner = resultRunner({ status: 'approval-denied', output: 'approval denied' })
  const denied = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: retryRunner, superagent: deniedRunner } })
  assert.equal(denied.ok, false)
  assert.equal(denied.cases[0].superagent.attempts.length, 2)
  assert.equal(denied.cases[0].superagent.passed, false)
})

test('two-project workspace isolation checks both owned content and cross-project absence', async t => {
  const tempRoot = await createTempRoot(t)
  const testcase = {
    id: 'workspace-isolation',
    prompt: 'write a project-local artifact',
    workspaces: [{ id: 'project-a' }, { id: 'project-b' }],
    checks: [
      { type: 'fileContains', workspace: 'project-a', path: 'artifacts/only-project-a.txt', equals: 'project-a\n' },
      { type: 'fileContains', workspace: 'project-b', path: 'artifacts/only-project-b.txt', equals: 'project-b\n' },
      { type: 'file', workspace: 'project-a', path: 'artifacts/only-project-b.txt', exists: false },
      { type: 'file', workspace: 'project-b', path: 'artifacts/only-project-a.txt', exists: false },
    ],
  }
  const isolatedRunner = fakeRunner(`
    if (!['project-a', 'project-b'].includes(request.workspaceId)) throw new Error('missing workspaceId')
    await fs.mkdir(path.join(request.workdir, 'artifacts'), { recursive: true })
    await fs.writeFile(path.join(request.workdir, 'artifacts', 'only-' + request.workspaceId + '.txt'), request.workspaceId + '\\n')
    emit({ status: 'completed', output: request.workspaceId + ' isolated' })
  `)
  const report = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: isolatedRunner, superagent: isolatedRunner } })
  assert.equal(report.ok, true)
  assert.deepEqual(report.cases[0].superagent.workspaces.map(workspace => workspace.id), ['project-a', 'project-b'])
  assert.ok(report.cases[0].superagent.workspaces.every(workspace => workspace.passed))

  const leakingRunner = fakeRunner(`
    const other = request.workspaceId === 'project-a' ? 'project-b' : 'project-a'
    await fs.mkdir(path.join(request.workdir, 'artifacts'), { recursive: true })
    await fs.writeFile(path.join(request.workdir, 'artifacts', 'only-' + request.workspaceId + '.txt'), request.workspaceId + '\\n')
    await fs.writeFile(path.join(request.workdir, 'artifacts', 'only-' + other + '.txt'), other + '\\n')
    emit({ status: 'completed', output: 'leaked ' + other })
  `)
  const leaked = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: isolatedRunner, superagent: leakingRunner } })
  assert.equal(leaked.ok, false, JSON.stringify(leaked))
  assert.ok(leaked.cases[0].superagent.failures.some(failure => failure.includes('unexpected file')))
})

test('artifact checks validate exact content rather than existence alone', async t => {
  const tempRoot = await createTempRoot(t)
  const expected = '{"answer":42,"items":["alpha","beta"]}\n'
  const testcase = {
    id: 'artifact-content',
    prompt: 'write the exact report',
    checks: [
      { type: 'file', path: 'artifacts/report.json', minBytes: 1 },
      { type: 'fileContains', path: 'artifacts/report.json', equals: expected },
    ],
  }
  const artifactRunner = content => fakeRunner(`
    await fs.mkdir(path.join(request.workdir, 'artifacts'), { recursive: true })
    await fs.writeFile(path.join(request.workdir, 'artifacts', 'report.json'), ${JSON.stringify(content)})
    emit({ status: 'completed', output: 'artifact written' })
  `)
  const correctRunner = artifactRunner(expected)
  const correct = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: correctRunner, superagent: correctRunner } })
  assert.equal(correct.ok, true)
  assert.equal(correct.cases[0].superagent.passed, true)

  const incorrect = await runParityBenchmark({ cases: [testcase], tempRoot, runners: {
    baseline: correctRunner,
    superagent: artifactRunner('{"answer":0}\n'),
  } })
  assert.equal(incorrect.ok, false)
  assert.match(incorrect.cases[0].superagent.failures[0], /file content artifacts\/report.json/)
})

test('child-provider failure must select and report the fallback provider', async t => {
  const tempRoot = await createTempRoot(t)
  const testcase = {
    id: 'child-provider-fallback',
    prompt: 'use a child provider with fallback',
    checks: [
      { type: 'status', equals: 'completed' },
      { type: 'jsonPath', path: 'provider.primaryStatus', equals: 'failed' },
      { type: 'jsonPath', path: 'provider.selected', equals: 'local-fallback' },
      { type: 'jsonPath', path: 'provider.fallback', equals: true },
      { type: 'contains', value: 'fallback completed' },
    ],
  }
  const fallbackRunner = resultRunner({
    status: 'completed',
    output: 'child provider failed; fallback completed',
    provider: { primary: 'child-provider', primaryStatus: 'failed', selected: 'local-fallback', fallback: true },
  })
  const report = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: fallbackRunner, superagent: fallbackRunner } })
  assert.equal(report.ok, true)
  assert.equal(report.cases[0].superagent.passed, true)

  const noFallbackRunner = resultRunner({
    status: 'completed',
    output: 'child provider failed; fallback completed',
    provider: { primary: 'child-provider', primaryStatus: 'failed', selected: 'child-provider', fallback: false },
  })
  const noFallback = await runParityBenchmark({ cases: [testcase], tempRoot, runners: { baseline: fallbackRunner, superagent: noFallbackRunner } })
  assert.equal(noFallback.ok, false)
  assert.ok(noFallback.cases[0].superagent.failures.some(failure => failure.includes('provider.selected')))
})

test('stub parity smoke covers all eight deterministic cases', async t => {
  const tempRoot = await createTempRoot(t, 'superagent-parity-stub-')
  const report = await runParityBenchmark({ tempRoot }, { stub: true })
  assert.equal(report.ok, true)
  assert.deepEqual(report.cases.map(row => row.id), [
    'simple-qa',
    'file-edit',
    'multi-task',
    'browser-capability-degradation',
    'approval-denial-retry',
    'workspace-isolation',
    'artifact-content',
    'child-provider-fallback',
  ])
  assert.ok(report.cases.every(row => row.baseline.passed && row.superagent.passed))
  assert.equal(report.summary.baseline.successes, 8)
  assert.equal(report.summary.superagent.score, 8)
  assert.equal(report.cases.find(row => row.id === 'browser-capability-degradation').superagent.status, 'degraded')
  assert.deepEqual(report.cases.find(row => row.id === 'approval-denial-retry').superagent.attempts.map(attempt => attempt.status), ['approval-denied', 'completed'])
  assert.equal(report.cases.find(row => row.id === 'workspace-isolation').superagent.workspaces.length, 2)
})
