import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildEvidenceCenter, collectEvidenceCards, EVIDENCE_CATEGORIES } from '../lib/evidence-center.js'
import { stampCheck } from '../lib/goal.js'

const AT = '2026-11-25T10:00:00.000Z'
const ROOT = path.join(os.tmpdir(), 'evidence-center-workspace')

function run(overrides = {}) {
  return {
    id: 'run-evidence',
    goal: 'Ship a verified report',
    status: 'completed',
    createdAt: '2026-11-25T09:00:00.000Z',
    finishedAt: AT,
    workspace: { base: ROOT },
    subtasks: [],
    report: '',
    ...overrides,
  }
}

function machineCheck(overrides = {}) {
  return {
    id: 'check-tests',
    text: 'Run the test suite',
    source: 'command',
    command: 'npm test',
    ok: true,
    exitCode: 0,
    durationMs: 42,
    checkedAt: AT,
    detail: 'all tests passed',
    ...overrides,
  }
}

function withCheck(check, round = 2) {
  return run({ goalMode: { rounds: [{ round, checks: [check] }] } })
}

function review(verdict, overrides = {}) {
  return {
    subtaskId: 'review-w1',
    childId: `child-${verdict}`,
    status: verdict,
    verdict,
    evidence: verdict === 'pass' ? ['inspected report.md; required section exists'] : [],
    issues: verdict === 'fail' ? ['required chart is absent'] : [],
    startedAt: '2026-11-25T09:59:00.000Z',
    finishedAt: AT,
    ...overrides,
  }
}

test('machine checks are passed or failed only when their durable receipt matches', () => {
  const passing = stampCheck('run-evidence', 2, machineCheck(), AT)
  const failing = stampCheck('run-evidence', 2, machineCheck({
    id: 'check-lint', text: 'Lint', ok: false, exitCode: 1, detail: 'lint failed',
  }), AT)
  const result = buildEvidenceCenter(withCheck(passing))
  assert.equal(result.cards.length, 1)
  const card = result.cards[0]
  assert.equal(card.category, 'machine')
  assert.equal(card.kind, 'command')
  assert.equal(card.status, 'passed')
  assert.equal(card.receipt, passing.receipt)
  assert.equal(card.receiptStatus, 'verified')
  assert.equal(card.at, AT)
  assert.equal(card.basis.summary, 'all tests passed')
  assert.deepEqual(card.basis.details.slice(0, 3), ['command: npm test', 'exit code: 0', 'duration ms: 42'])
  assert.equal(card.confidence.level, 'verified')
  assert.deepEqual(card.confidence.rules, ['machine-result-with-matching-receipt'])
  assert.match(card.confidence.explanation, /not a statistical probability/)

  const failed = buildEvidenceCenter(run({ goalMode: { rounds: [{ round: 2, checks: [passing, failing] }] } }))
  assert.deepEqual(failed.cards.map(item => item.status), ['failed', 'passed'])
  assert.equal(failed.summary.byStatus.failed, 1)
})

test('missing, corrupt, tampered, and explicitly broken machine receipts are unverified', () => {
  const stamped = stampCheck('run-evidence', 2, machineCheck(), AT)
  const cases = [
    machineCheck(),
    { ...stamped, receipt: 'not-a-digest' },
    { ...stamped, detail: 'tampered after checking' },
    { ...stamped, integrity: false },
    stampCheck('another-run', 2, machineCheck(), AT),
  ]
  for (const check of cases) {
    const card = buildEvidenceCenter(withCheck(check)).cards[0]
    assert.equal(card.status, 'unverified', JSON.stringify(check))
    assert.equal(card.confidence.level, 'none')
    assert.equal(card.confidence.probability, false)
    assert.match(card.confidence.explanation, /receipt/)
  }
  const unknownRound = buildEvidenceCenter(run({ acceptance: { checks: [stamped] } })).cards[0]
  assert.equal(unknownRound.status, 'unverified')
  assert.equal(unknownRound.receiptStatus, 'unverifiable')
})

test('reviewer pass, fail, malformed, and inconsistent results stay distinct', () => {
  const invalid = review('pass', { evidence: 'not an array' })
  const inconsistent = review('pass', { status: 'unverified', error: 'reviewer stopped early' })
  const record = run({ subtasks: [
    { id: 'w1', title: 'Write report', review: review('pass') },
    { id: 'w2', title: 'Draw chart', review: review('fail') },
    { id: 'w3', title: 'Broken result', review: invalid },
    { id: 'w4', title: 'Stopped result', review: inconsistent },
  ] })
  const result = buildEvidenceCenter(record)
  assert.equal(result.summary.byCategory.reviewer, 4)
  assert.deepEqual(result.summary.byStatus, { passed: 1, failed: 1, unverified: 2, recorded: 0 })
  const cards = new Map(result.cards.map(card => [card.subtaskId, card]))
  assert.equal(cards.get('w1').confidence.level, 'reviewed')
  assert.equal(cards.get('w1').basis.evidence[0], 'inspected report.md; required section exists')
  assert.equal(cards.get('w2').status, 'failed')
  assert.deepEqual(cards.get('w2').basis.issues, ['required chart is absent'])
  assert.equal(cards.get('w3').status, 'unverified')
  assert.match(cards.get('w3').basis.summary, /invalid|incomplete/)
  assert.equal(cards.get('w4').status, 'unverified')
  assert.match(cards.get('w4').confidence.explanation, /invalid|inconsistent|cancelled/)
})

test('a reviewer verdict without concrete evidence has an explicitly limited level', () => {
  const card = buildEvidenceCenter(run({ subtasks: [{ id: 'w1', review: review('pass', { evidence: [] }) }] })).cards[0]
  assert.equal(card.status, 'passed')
  assert.equal(card.confidence.level, 'limited')
  assert.deepEqual(card.confidence.rules, ['independent-review-without-concrete-evidence'])
  assert.match(card.confidence.explanation, /no concrete evidence/)
})

test('model acceptance is labelled as a model judgment, never as a machine pass', () => {
  const judged = machineCheck({ id: 'judge', source: 'model', ok: true, command: undefined, exitCode: null, detail: 'report meets the contract' })
  const failed = { ...judged, id: 'judge-fail', ok: false, detail: 'citation is missing' }
  const result = buildEvidenceCenter(run({ goalMode: { rounds: [{ round: 1, checks: [judged, failed] }] } }))
  assert.deepEqual(result.cards.map(card => card.category), ['model', 'model'])
  assert.deepEqual(result.cards.map(card => card.status), ['failed', 'passed'])
  for (const card of result.cards) {
    assert.equal(card.confidence.level, 'model-judged')
    assert.deepEqual(card.confidence.rules, ['explicit-model-judgment'])
    assert.match(card.confidence.explanation, /not a statistical probability/)
    assert.equal(card.receiptStatus, 'not-required')
  }
  const malformed = buildEvidenceCenter(run({ acceptance: { checks: [{ source: 'model', ok: 'yes' }] } })).cards[0]
  assert.equal(malformed.status, 'unverified')
})

test('subtask deliverable declarations and producer verification are not fake receipts', () => {
  const file = path.join(ROOT, 'reports', 'out.md')
  const record = run({ subtasks: [{
    id: 'w1',
    deliverables: [{ path: 'reports/out.md', minBytes: 10 }, { path: 'reports/declared-only.md' }],
    deliverableCheck: {
      at: AT,
      root: ROOT,
      items: [{ path: 'reports/out.md', status: 'verified', bytes: 120, reason: 'nonempty file' }],
    },
  }] })
  const result = buildEvidenceCenter(record)
  assert.equal(result.cards.length, 2)
  assert.ok(result.cards.every(card => card.category === 'machine' && card.kind === 'deliverable'))
  assert.ok(result.cards.every(card => card.status === 'unverified'))
  assert.ok(result.cards.every(card => card.receipt === null && card.receiptStatus === 'missing'))
  const checked = result.cards.find(card => card.provenance === 'deliverable-check')
  assert.equal(checked.artifact.href, file)
  assert.equal(checked.artifact.name, 'out.md')
  assert.match(checked.confidence.explanation, /receipt is missing/)
  const declared = result.cards.find(card => card.provenance === 'deliverable-declaration')
  assert.match(declared.basis.summary, /declaration is not proof/)
})

test('an explicitly authenticated deliverable receipt can verify its recorded result', () => {
  const check = { path: 'reports/out.md', status: 'verified', receipt: 'receipt-signed-by-checker', receiptVerified: true }
  const card = buildEvidenceCenter(run({ subtasks: [{ id: 'w1', deliverables: [{ path: check.path }], deliverableCheck: { at: AT, items: [check] } }] })).cards[0]
  assert.equal(card.status, 'passed')
  assert.equal(card.receiptStatus, 'verified')
  assert.equal(card.confidence.level, 'verified')
})

test('report citations and links deduplicate normalised URLs and remain source evidence', () => {
  const citation = { url: 'https://example.com/docs?utm_source=run#intro', title: 'Documentation', claim: 'documents the release rule', at: '2026-11-25T09:30:00.000Z' }
  const record = run({
    citations: [citation],
    report: [
      '[Docs](https://example.com/docs?utm_medium=report#intro)',
      '[Docs again](https://example.com/docs)',
      '[Docs reference][docs]',
      '[docs]: https://example.com/docs#top',
    ].join('\n'),
  })
  const result = buildEvidenceCenter(record)
  assert.equal(result.cards.length, 1)
  const card = result.cards[0]
  assert.equal(card.category, 'source')
  assert.equal(card.status, 'recorded')
  assert.equal(card.artifact.href, 'https://example.com/docs')
  assert.equal(card.at, citation.at)
  assert.match(card.provenance, /run/)
  assert.equal(card.confidence.level, 'referenced')
  assert.match(card.confidence.explanation, /link alone does not prove/)
})

test('local links resolve inside the run root and reject traversal, absolute escapes, and unsafe schemes', () => {
  const inside = path.join(ROOT, 'report.md')
  const outside = path.join(path.dirname(ROOT), 'secret.md')
  const record = run({
    artifacts: [{ name: 'Declared', path: inside }],
    report: [
      '[Report](./report.md)',
      '[Report section](./report.md#intro)',
      '[Encoded traversal](%2e%2e/secret.md)',
      `[Absolute escape](${outside})`,
      '[Script](javascript:alert(1))',
      '[File scheme](file:///etc/passwd)',
      '[Anchor](#section)',
    ].join('\n'),
  })
  const result = buildEvidenceCenter(record)
  assert.equal(result.cards.length, 1)
  assert.equal(result.cards[0].artifact.href, inside)
  assert.equal(result.cards[0].artifact.kind, 'md')
  assert.equal(result.cards[0].provenance, 'run,report-link')
})

test('explicit allowed roots constrain every local source, including audit targets', () => {
  const allowed = path.join(os.tmpdir(), 'evidence-allowed')
  const record = run({
    workspace: { base: path.join(os.tmpdir(), 'evidence-run-root') },
    report: `[Allowed](../evidence-allowed/a.md)\n[Not allowed](${path.join(os.tmpdir(), 'evidence-denied', 'b.md')})`,
    auditEvents: [{ id: 'evt-1', runId: 'run-evidence', at: AT, kind: 'path.write', target: path.join(allowed, 'a.md'), result: 'ok' }],
  })
  const result = buildEvidenceCenter(record, { allowedRoots: [allowed] })
  assert.equal(result.cards.length, 2)
  assert.ok(result.cards.every(card => card.links.every(link => link.href === path.join(allowed, 'a.md'))))
})

test('Windows and POSIX boundaries are checked with their own path semantics', () => {
  const windows = buildEvidenceCenter({ report: '[Inside](C:\\work\\docs\\a.md)\n[Escape](D:\\secret\\a.md)' }, { allowedRoots: 'C:\\work' })
  assert.equal(windows.cards.length, 1)
  assert.equal(windows.cards[0].artifact.href, 'C:\\work\\docs\\a.md')
  const posix = buildEvidenceCenter({ report: '[Inside](/work/docs/a.md)\n[Escape](/etc/passwd)' }, { allowedRoots: '/work' })
  assert.equal(posix.cards.length, 1)
  assert.equal(posix.cards[0].artifact.href, '/work/docs/a.md')
})

test('audit events are source records, scoped by run, and never become quality passes', () => {
  const events = [
    { id: 'evt-ok', runId: 'run-evidence', at: AT, kind: 'path.write', action: 'write', target: './report.md', result: 'ok', actor: 'worker' },
    { id: 'evt-deny', runId: 'run-evidence', at: '2026-11-25T10:01:00.000Z', kind: 'blocked', action: 'command', decision: 'deny', result: 'blocked', meta: { reason: 'policy denied command' } },
    { id: 'evt-foreign', runId: 'run-foreign', at: AT, kind: 'run.finish', result: 'ok' },
  ]
  const result = buildEvidenceCenter({ runs: [run()], auditEvents: events })
  assert.equal(result.cards.length, 2)
  assert.deepEqual(result.cards.map(card => card.status), ['failed', 'recorded'])
  assert.ok(result.cards.every(card => card.category === 'source' && card.kind === 'audit'))
  assert.equal(result.cards[0].confidence.level, 'recorded')
  assert.match(result.cards[0].confidence.explanation, /does not by itself prove quality/)
  assert.equal(result.cards[1].artifact.href, path.join(ROOT, 'report.md'))
})

test('bundle-level reviewers and sources aggregate without requiring a durable run', () => {
  const result = buildEvidenceCenter({
    reviewers: [{ ...review('pass'), runId: 'run-bundle' }],
    citations: [{ url: 'https://example.com/source', title: 'Source' }],
  }, { runId: 'run-bundle' })
  assert.deepEqual(result.cards.map(card => card.category).sort(), ['reviewer', 'source'])
  assert.ok(result.cards.every(card => card.runId === 'run-bundle'))
})

test('text, list sizes, card counts, and truncation are bounded and disclosed', () => {
  const reviews = Array.from({ length: 130 }, (_, index) => review(index % 2 ? 'fail' : 'pass', {
    childId: `child-${index}`,
    subtaskId: `review-w${index}`,
    evidence: [Array.from({ length: 20 }, () => `evidence-${index}-${'x'.repeat(1000)}`).join(' ')],
    issues: Array.from({ length: 20 }, (_, issue) => `issue-${issue}-${'y'.repeat(1000)}`),
  }))
  const result = buildEvidenceCenter(run({ subtasks: [{ id: 'w1', reviews }] }), { limit: 7 })
  assert.equal(result.summary.total, 130)
  assert.equal(result.summary.returned, 7)
  assert.equal(result.summary.omitted, 123)
  assert.equal(result.summary.truncated, true)
  assert.equal(result.cards.length, 7)
  for (const card of result.cards) {
    assert.ok(card.title.length <= 180)
    assert.ok(card.basis.summary.length <= 600)
    assert.ok(card.basis.evidence.length <= 8)
    assert.ok(card.basis.issues.length <= 8)
    assert.ok(card.basis.evidence.every(item => item.length <= 300))
    assert.ok(card.links.length <= 12)
  }
  assert.equal(buildEvidenceCenter(run({ subtasks: [{ id: 'w1', reviews }] }), { limit: 0 }).cards.length, 0)
  assert.throws(() => buildEvidenceCenter([], { limit: 501 }), /0 to 500/)
})

test('secrets are redacted from evidence text and URL credentials/query parameters', () => {
  const email = 'person@example.com'
  const token = 'sk_abcdefghijklmnopqrstuvwxyz'
  const secret = 'Bearer abcdefghijklmnopqrstuvwxyz'
  const record = run({
    subtasks: [{ id: 'w1', review: review('pass', { evidence: [`contact ${email}`, `credential ${token}`, `authorization ${secret}`] }) }],
    citations: [{ url: 'https://user:password@example.com/a?access_token=abcdef&safe=yes', title: `Contact ${email}` }],
  })
  const json = JSON.stringify(buildEvidenceCenter(record))
  for (const value of [email, token, secret, 'user:password@', 'access_token=abcdef']) assert.equal(json.includes(value), false, value)
  assert.match(json, /redacted/)
  const source = buildEvidenceCenter(record).cards.find(card => card.category === 'source')
  assert.equal(source.artifact.href, 'https://example.com/a?access_token=%5Bredacted%5D&safe=yes')
})

test('malformed timestamps, report objects, and non-file audit targets are handled without invention', () => {
  const record = run({
    report: {
      text: '[Report](https://example.com/report)',
      citations: [{ url: 'https://example.com/report', title: 'Report citation' }],
    },
    auditEvents: [
      { id: 'evt-approval', runId: 'run-evidence', at: new Date(NaN), kind: 'approved', action: 'approve', target: 'evt-held', result: 'approved' },
    ],
  })
  const result = buildEvidenceCenter({ runs: [record], auditEvents: { events: [record.auditEvents[0]] } })
  assert.equal(result.cards.length, 2, 'the same audit event is deduplicated and the report citation/link is one source')
  const audit = result.cards.find(card => card.kind === 'audit')
  assert.equal(audit.at, null)
  assert.equal(audit.artifact, null, 'an approval event id is not a file path')
  const source = result.cards.find(card => card.category === 'source' && card.kind !== 'audit')
  assert.equal(source.artifact.href, 'https://example.com/report')
  assert.match(source.provenance, /citation/)
  assert.match(source.provenance, /report-link/)
})

test('empty or declaration-free completed runs do not invent evidence', () => {
  for (const input of [[], {}, [run()], { runs: [run()], auditEvents: [], citations: [], report: '' }]) {
    const result = buildEvidenceCenter(input)
    assert.deepEqual(result.cards, [])
    assert.deepEqual(result.summary, {
      total: 0, returned: 0, omitted: 0, truncated: false,
      byCategory: { machine: 0, model: 0, reviewer: 0, source: 0 },
      byStatus: { passed: 0, failed: 0, unverified: 0, recorded: 0 },
    })
    assert.equal(result.confidencePolicy.probability, false)
  }
})

test('aggregation is deterministic, does not mutate input, and supports category filters', () => {
  const stamped = stampCheck('run-evidence', 1, machineCheck(), AT)
  const input = run({
    goalMode: { rounds: [{ round: 1, checks: [stamped, { ...machineCheck({ id: 'model-judgment' }), source: 'model', command: undefined }] }] },
    subtasks: [{ id: 'w1', review: review('pass') }],
    report: '[Source](https://example.com/a)',
  })
  const before = structuredClone(input)
  const first = buildEvidenceCenter(input)
  const second = collectEvidenceCards(input)
  assert.deepEqual(first, second)
  assert.deepEqual(input, before)
  assert.deepEqual(new Set(first.cards.map(card => card.category)), new Set(EVIDENCE_CATEGORIES))
  assert.ok(buildEvidenceCenter(input, { category: 'reviewer' }).cards.every(card => card.category === 'reviewer'))
  assert.ok(buildEvidenceCenter(input, { status: 'failed' }).cards.every(card => card.status === 'failed'))
  assert.throws(() => buildEvidenceCenter(input, { category: 'unknown' }), /unknown evidence category/)
})
