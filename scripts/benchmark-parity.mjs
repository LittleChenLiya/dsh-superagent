import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unsuccessfulStatuses = new Set(['failed', 'skipped', 'cancelled', 'canceled', 'approval-denied', 'timed-out'])

const stubCases = [
  { id: 'simple-qa', prompt: '用一句话解释什么是依赖注入', checks: [{ type: 'contains', value: '依赖注入' }] },
  { id: 'file-edit', prompt: '在工作区写入 artifacts/result.txt', artifact: 'artifacts/result.txt',
    checks: [{ type: 'file', path: 'artifacts/result.txt', minBytes: 1 }] },
  { id: 'multi-task', prompt: '总结三项任务的状态', checks: [{ type: 'contains', value: '三项任务' }] },
  {
    id: 'browser-capability-degradation',
    prompt: '使用浏览器检查页面，并在浏览器不可用时说明限制',
    stubResult: {
      status: 'degraded',
      output: '浏览器能力不可用；已基于现有信息完成分析并报告限制。',
      limitations: [{ code: 'browser-unavailable', message: '当前环境没有可用的浏览器能力' }],
    },
    checks: [
      { type: 'status', equals: 'degraded' },
      { type: 'jsonPath', path: 'limitations.0.code', equals: 'browser-unavailable' },
      { type: 'contains', value: '浏览器能力不可用' },
    ],
  },
  {
    id: 'approval-denial-retry',
    prompt: '申请执行任务，第一次审批拒绝后重试',
    maxAttempts: 2,
    retryStatuses: ['approval-denied'],
    stubAttempts: [
      { status: 'approval-denied', output: '审批已拒绝，任务尚未执行。' },
      { status: 'completed', output: '重试已获批准，任务完成。' },
    ],
    checks: [
      { type: 'status', equals: 'completed' },
      { type: 'jsonPath', path: 'attempts.0.status', equals: 'approval-denied' },
      { type: 'jsonPath', path: 'attempts.1.status', equals: 'completed' },
      { type: 'contains', value: '重试已获批准' },
    ],
  },
  {
    id: 'workspace-isolation',
    prompt: '分别在两个项目中写入只有本项目可以访问的产物',
    workspaces: [
      { id: 'project-a', artifact: 'artifacts/only-project-a.txt', artifactContent: 'project-a\n',
        stubResult: { output: 'project-a 已完成本项目产物。' } },
      { id: 'project-b', artifact: 'artifacts/only-project-b.txt', artifactContent: 'project-b\n',
        stubResult: { output: 'project-b 已完成本项目产物。' } },
    ],
    checks: [
      { type: 'fileContains', workspace: 'project-a', path: 'artifacts/only-project-a.txt', equals: 'project-a\n' },
      { type: 'fileContains', workspace: 'project-b', path: 'artifacts/only-project-b.txt', equals: 'project-b\n' },
      { type: 'file', workspace: 'project-a', path: 'artifacts/only-project-b.txt', exists: false },
      { type: 'file', workspace: 'project-b', path: 'artifacts/only-project-a.txt', exists: false },
    ],
  },
  {
    id: 'artifact-content',
    prompt: '将正确答案写入 artifacts/report.json',
    artifact: 'artifacts/report.json',
    artifactContent: '{"answer":42,"items":["alpha","beta"]}\n',
    checks: [
      { type: 'file', path: 'artifacts/report.json', minBytes: 1 },
      { type: 'fileContains', path: 'artifacts/report.json', equals: '{"answer":42,"items":["alpha","beta"]}\n' },
    ],
  },
  {
    id: 'child-provider-fallback',
    prompt: '调用子提供器，失败时回退到本地提供器',
    stubResult: {
      status: 'completed',
      output: '子提供器调用失败，已回退到本地提供器并完成。',
      provider: { primary: 'child-provider', primaryStatus: 'failed', selected: 'local-fallback', fallback: true },
    },
    checks: [
      { type: 'status', equals: 'completed' },
      { type: 'jsonPath', path: 'provider.primaryStatus', equals: 'failed' },
      { type: 'jsonPath', path: 'provider.selected', equals: 'local-fallback' },
      { type: 'jsonPath', path: 'provider.fallback', equals: true },
      { type: 'contains', value: '回退' },
    ],
  },
]

function readJsonPath(value, jsonPath) {
  if (jsonPath === '$') return { found: true, value }
  if (typeof jsonPath !== 'string' || !jsonPath) return { found: false, value: undefined }
  const parts = jsonPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let current = value
  for (const part of parts) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function') || !Object.hasOwn(current, part)) {
      return { found: false, value: undefined }
    }
    current = current[part]
  }
  return { found: true, value: current }
}

async function evaluate(result, testcase, cwd, attempts = []) {
  const output = String(result?.output ?? '')
  const failures = []
  const earned = { count: 0 }
  const checks = testcase.checks ?? []
  for (const check of checks) {
    let failure = null
    if (check.type === 'contains') {
      if (!output.includes(check.value)) failure = `missing ${JSON.stringify(check.value)}`
    } else if (check.type === 'notContains') {
      if (output.includes(check.value)) failure = `unexpected ${JSON.stringify(check.value)}`
    } else if (check.type === 'regex') {
      try {
        if (!new RegExp(check.pattern, check.flags ?? 'u').test(output)) failure = `regex ${check.pattern}`
      } catch (error) {
        failure = `invalid regex ${check.pattern}: ${error.message}`
      }
    } else if (check.type === 'status') {
      const allowed = Array.isArray(check.values) ? check.values : [check.values ?? check.equals ?? check.value]
      if (!allowed.includes(result?.status ?? 'completed')) failure = `status ${result?.status ?? 'completed'} not in ${JSON.stringify(allowed)}`
    } else if (check.type === 'jsonPath') {
      const usesAttempts = typeof check.path === 'string' && (check.path === 'attempts' || check.path.startsWith('attempts.') || check.path.startsWith('attempts['))
      const source = usesAttempts ? attempts : result
      const sourcePath = usesAttempts ? (check.path === 'attempts' ? '$' : check.path.slice('attempts'.length).replace(/^\./, '')) : check.path
      const actual = readJsonPath(source, sourcePath)
      const hasExpected = Object.hasOwn(check, 'equals') || Object.hasOwn(check, 'value')
      const expected = Object.hasOwn(check, 'equals') ? check.equals : check.value
      if (!actual.found) failure = `missing json path ${check.path}`
      else if (!hasExpected) failure = `json path ${check.path} has no expected value`
      else if (!isDeepStrictEqual(actual.value, expected)) failure = `json path ${check.path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual.value)}`
    } else if (check.type === 'file' || check.type === 'fileContains') {
      const file = path.resolve(cwd, check.path)
      let stat
      try {
        stat = await fsp.stat(file)
      } catch (error) {
        if (check.exists === false && error.code === 'ENOENT') {
          earned.count += 1
          continue
        }
        failure = `file ${check.path}`
      }
      if (!failure && check.exists === false) failure = `unexpected file ${check.path}`
      else if (!failure && check.type === 'file' && (!stat.isFile() || stat.size < (check.minBytes ?? 1))) failure = `file ${check.path}`
      else if (!failure && check.type === 'fileContains') {
        try {
          if (!stat.isFile()) failure = `file ${check.path}`
          else {
            const content = await fsp.readFile(file, 'utf8')
            if (Object.hasOwn(check, 'equals') && content !== check.equals) failure = `file content ${check.path}: expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(content)}`
            else if (!Object.hasOwn(check, 'equals') && !content.includes(check.value)) failure = `file ${check.path} missing ${JSON.stringify(check.value)}`
          }
        } catch (error) {
          failure = `file content ${check.path}: ${error.message}`
        }
      }
    } else failure = `unknown check type ${check.type}`
    if (failure) failures.push(failure)
    else earned.count += 1
  }
  const total = Math.max(1, checks.length)
  const status = result?.status ?? 'completed'
  return {
    passed: failures.length === 0 && !unsuccessfulStatuses.has(status),
    score: (total - failures.length) / total,
    failures,
    earned: earned.count,
    total,
  }
}

function parseResult(stdout) {
  const lines = String(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value === 'object') return value
    } catch {}
  }
  throw new Error('runner did not return a JSON result')
}

async function runRunner(runner, testcase, cwd, timeoutMs, { attempt = 1, maxAttempts = 1, workspace } = {}) {
  const input = { prompt: testcase.prompt, caseId: testcase.id, workdir: cwd }
  if (workspace) input.workspaceId = workspace.id
  if (maxAttempts > 1) Object.assign(input, { attempt, maxAttempts })
  const child = spawn(runner.command, runner.args ?? [], { cwd: runner.cwd ?? root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  child.stdin.end(JSON.stringify(input))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  if (code !== 0) throw new Error(`runner exited ${code}: ${stderr.slice(-800)}`)
  return parseResult(stdout)
}

async function runStubRunner(testcase, cwd, { attempt = 1, workspace } = {}) {
  const artifact = workspace?.artifact ?? (testcase.workspaces?.length ? null : testcase.artifact)
  if (artifact) {
    const file = path.join(cwd, artifact)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, workspace?.artifactContent ?? testcase.artifactContent ?? 'stub artifact\n')
  }
  return {
    status: 'completed',
    output: `stub: ${testcase.prompt}`,
    durationMs: 1,
    usage: { modelCalls: 1, totalTokens: 10, cost: 0 },
    ...testcase.stubResult,
    ...workspace?.stubResult,
    ...testcase.stubAttempts?.[attempt - 1],
  }
}

async function executeRunner(runner, testcase, cwd, options, stub, timeoutMs) {
  const maxAttempts = Math.max(1, Number(testcase.maxAttempts) || 1)
  const retryStatuses = new Set(testcase.retryStatuses ?? [])
  const attempts = []
  let result
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = stub
      ? await runStubRunner(testcase, cwd, { ...options, attempt })
      : await runRunner(runner, testcase, cwd, timeoutMs, { ...options, attempt, maxAttempts })
    attempts.push(result)
    if (attempt === maxAttempts || !retryStatuses.has(result?.status)) break
  }
  return { result, attempts }
}

function attemptSummary(attempts) {
  return attempts.map(attempt => ({
    status: attempt?.status ?? null,
    durationMs: attempt?.durationMs ?? null,
    usage: attempt?.usage ?? null,
  }))
}

function sumValues(values) {
  const numeric = values.filter(value => typeof value === 'number' && Number.isFinite(value))
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) : null
}

function sumUsage(attemptGroups) {
  const usages = attemptGroups.flat().map(attempt => attempt?.usage).filter(Boolean)
  if (!usages.length) return null
  const total = {}
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value
      else if (!Object.hasOwn(total, key)) total[key] = value
    }
  }
  return total
}

async function runImplementation(runner, testcase, implementationRoot, { stub, timeoutMs }) {
  const hasWorkspaces = Array.isArray(testcase.workspaces) && testcase.workspaces.length > 0
  const workspaces = hasWorkspaces ? testcase.workspaces : [null]
  const rows = []
  for (const workspace of workspaces) {
    const cwd = workspace ? path.join(implementationRoot, workspace.id) : implementationRoot
    await fsp.mkdir(cwd, { recursive: true })
    const { result, attempts } = await executeRunner(runner, testcase, cwd, { workspace }, stub, timeoutMs)
    const checks = (testcase.checks ?? []).filter(check => !hasWorkspaces
      ? !check.workspace
      : !check.workspace || check.workspace === workspace.id)
    const evaluation = await evaluate(result, { ...testcase, checks }, cwd, attempts)
    rows.push({
      id: workspace?.id ?? 'default',
      status: result?.status ?? null,
      passed: evaluation.passed,
      score: evaluation.score,
      durationMs: sumValues(attempts.map(attempt => attempt?.durationMs)),
      usage: sumUsage([attempts]),
      failures: evaluation.failures,
      ...(result?.limitations ? { limitations: result.limitations } : {}),
      attempts: attemptSummary(attempts),
      earned: evaluation.earned,
      total: evaluation.total,
    })
  }
  const earned = rows.reduce((sum, row) => sum + row.earned, 0)
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  const passed = rows.every(row => row.passed)
  const statuses = rows.map(row => row.status)
  const limitations = rows.flatMap(row => row.limitations ?? [])
  return {
    status: statuses.every(status => status === statuses[0]) ? statuses[0] : 'mixed',
    passed,
    score: total ? earned / total : 1,
    durationMs: sumValues(rows.map(row => row.durationMs)),
    usage: sumUsage(rows.map(row => row.attempts)),
    failures: rows.flatMap(row => row.failures.map(failure => `${row.id === 'default' ? '' : `${row.id}: `}${failure}`)),
    limitations: limitations.length ? limitations : null,
    attempts: rows.flatMap(row => row.attempts),
    ...(hasWorkspaces ? { workspaces: rows.map(({ earned: _earned, total: _total, ...row }) => row) } : {}),
  }
}

function summarize(rows, side) {
  return {
    successes: rows.filter(row => row[side].passed).length,
    score: rows.reduce((sum, row) => sum + row[side].score, 0),
    durationMs: sumValues(rows.map(row => row[side].durationMs)),
    usage: sumUsage(rows.map(row => [{ usage: row[side].usage }])),
  }
}

export async function runParityBenchmark(config, { stub = false, timeoutMs = 120000 } = {}) {
  const cases = config.cases?.length ? config.cases : stubCases
  const rows = []
  const violations = []
  const tempRoot = config.tempRoot ?? path.join(root, '.benchmark-tmp')
  await fsp.mkdir(tempRoot, { recursive: true })
  for (const testcase of cases) {
    const caseRoot = await fsp.mkdtemp(path.join(tempRoot, 'parity-'))
    try {
      const baselineRoot = path.join(caseRoot, 'baseline')
      const superagentRoot = path.join(caseRoot, 'superagent')
      await fsp.mkdir(baselineRoot, { recursive: true })
      await fsp.mkdir(superagentRoot, { recursive: true })
      const baseline = await runImplementation(config.runners?.baseline, testcase, baselineRoot, { stub, timeoutMs })
      const superagent = await runImplementation(config.runners?.superagent, testcase, superagentRoot, { stub, timeoutMs })
      const row = {
        id: testcase.id,
        baseline: { status: baseline.status, passed: baseline.passed, score: baseline.score,
          durationMs: baseline.durationMs, usage: baseline.usage, failures: baseline.failures,
          ...(baseline.limitations ? { limitations: baseline.limitations } : {}),
          ...(baseline.workspaces ? { workspaces: baseline.workspaces } : baseline.attempts.length > 1 ? { attempts: baseline.attempts } : {}) },
        superagent: { status: superagent.status, passed: superagent.passed, score: superagent.score,
          durationMs: superagent.durationMs, usage: superagent.usage, failures: superagent.failures,
          ...(superagent.limitations ? { limitations: superagent.limitations } : {}),
          ...(superagent.workspaces ? { workspaces: superagent.workspaces } : superagent.attempts.length > 1 ? { attempts: superagent.attempts } : {}) },
      }
      rows.push(row)
      if (baseline.score > superagent.score) {
        violations.push(`${testcase.id}: superagent scored ${superagent.score} below baseline ${baseline.score}`)
      } else if (baseline.passed && !superagent.passed) {
        violations.push(`${testcase.id}: superagent did not succeed while baseline did`)
      }
    } finally {
      await fsp.rm(caseRoot, { recursive: true, force: true })
    }
  }
  const summary = { baseline: summarize(rows, 'baseline'), superagent: summarize(rows, 'superagent') }
  if (summary.superagent.successes < summary.baseline.successes) {
    violations.push(`superagent succeeded ${summary.superagent.successes} times below baseline ${summary.baseline.successes}`)
  }
  if (summary.superagent.score < summary.baseline.score) {
    violations.push(`superagent total score ${summary.superagent.score} below baseline ${summary.baseline.score}`)
  }
  return { ok: violations.length === 0, violations, summary, cases: rows }
}

async function main() {
  const args = process.argv.slice(2)
  const stub = args.includes('--stub')
  const configIndex = args.indexOf('--config')
  const outIndex = args.indexOf('--out')
  const config = configIndex >= 0 ? JSON.parse(await fsp.readFile(path.resolve(args[configIndex + 1]), 'utf8')) : {}
  const report = await runParityBenchmark(config, { stub })
  const json = JSON.stringify(report, null, 2)
  if (outIndex >= 0) await fsp.writeFile(path.resolve(args[outIndex + 1]), `${json}\n`)
  console.log(json)
  if (!report.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
