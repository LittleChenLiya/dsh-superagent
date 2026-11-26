import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateNotificationCenter,
  buildDailyBrief,
  buildInbox,
  collectNotifications,
  isQuietHours,
  nextBriefTime,
} from '../lib/notification-center.js'
import { DEFAULT_NOTIFY_PREFERENCES, validateNotifyPreferences } from '../lib/notify-preferences.js'

const at = value => Date.parse(value)
const quiet = (overrides = {}) => ({
  enabled: true, start: '22:00', end: '08:00', timeZone: 'UTC', except: [], ...overrides,
})

function run(overrides = {}) {
  return {
    id: 'run-1',
    goal: 'Ship the release',
    status: 'completed',
    createdAt: '2026-11-14T08:00:00.000Z',
    finishedAt: '2026-11-14T10:00:00.000Z',
    parentSessionId: 'session-a',
    attention: { items: [] },
    ...overrides,
  }
}

function goal(overrides = {}) {
  return {
    id: 'g-release-1',
    title: 'Release goal',
    goal: 'Ship every release',
    status: 'running',
    createdAt: '2026-11-14T07:00:00.000Z',
    ownerSessionId: 'session-a',
    decisions: [],
    ...overrides,
  }
}

test('quiet hours are start-inclusive, end-exclusive, cross midnight, and honour exceptions', () => {
  const config = quiet()
  assert.equal(isQuietHours(at('2026-11-14T21:59:59.999Z'), config), false)
  assert.equal(isQuietHours(at('2026-11-14T22:00:00.000Z'), config), true)
  assert.equal(isQuietHours(at('2026-11-15T00:00:00.000Z'), config), true)
  assert.equal(isQuietHours(at('2026-11-15T07:59:59.999Z'), config), true)
  assert.equal(isQuietHours(at('2026-11-15T08:00:00.000Z'), config), false)
  assert.equal(isQuietHours(at('2026-11-15T08:00:00.000Z'), config, 'failed'), false)
  assert.equal(isQuietHours(at('2026-11-15T08:00:00.000Z'), quiet({ except: ['failed'] }), 'failed'), false)
  assert.equal(isQuietHours(at('2026-11-15T23:00:00.000Z'), quiet({ enabled: false })), false)
})

test('quiet hours use the configured IANA zone rather than the host zone', () => {
  const shanghai = quiet({ start: '09:00', end: '17:00', timeZone: 'Asia/Shanghai' })
  assert.equal(isQuietHours(at('2026-11-14T00:59:59.999Z'), shanghai), false)
  assert.equal(isQuietHours(at('2026-11-14T01:00:00.000Z'), shanghai), true)
  assert.equal(isQuietHours(at('2026-11-14T08:59:59.999Z'), shanghai), true)
  assert.equal(isQuietHours(at('2026-11-14T09:00:00.000Z'), shanghai), false)
  assert.equal(isQuietHours(at('2026-11-14T01:00:00.000Z'), quiet({
    start: '09:00', end: '17:00', timeZone: 'America/New_York',
  })), false)
  assert.throws(() => isQuietHours(at('2026-11-14T01:00:00.000Z'), quiet({ timeZone: 'Bad/Zone' })), /IANA/)
})

test('next brief time is strictly later and follows the brief time zone', () => {
  const brief = { enabled: true, time: '09:00', timeZone: 'Asia/Shanghai', channels: ['inbox'] }
  assert.equal(nextBriefTime(at('2026-11-14T00:59:59.999Z'), brief), '2026-11-14T01:00:00.000Z')
  assert.equal(nextBriefTime(at('2026-11-14T01:00:00.000Z'), brief), '2026-11-15T01:00:00.000Z')
  assert.equal(nextBriefTime(at('2026-11-14T01:00:01.000Z'), brief), '2026-11-15T01:00:00.000Z')
  assert.equal(nextBriefTime(at('2026-11-14T01:00:00.000Z'), { ...brief, enabled: false }), null)
  assert.equal(nextBriefTime(brief, at('2026-11-14T00:00:00.000Z')), '2026-11-14T01:00:00.000Z')
})

test('next brief handles a spring-forward gap and a fall-back offset change without inventing a local time', () => {
  const gap = { enabled: true, time: '02:30', timeZone: 'America/New_York', channels: ['push'] }
  assert.equal(nextBriefTime(at('2026-03-07T12:00:00.000Z'), gap), '2026-03-09T06:30:00.000Z')
  const brief = { ...gap, time: '09:00' }
  assert.equal(nextBriefTime(at('2026-10-30T14:00:00.000Z'), brief), '2026-10-31T13:00:00.000Z')
  assert.equal(nextBriefTime(at('2026-10-31T14:00:00.000Z'), brief), '2026-11-01T14:00:00.000Z')
  assert.equal(nextBriefTime(at('2026-11-01T14:00:00.000Z'), brief), '2026-11-02T14:00:00.000Z')

  const repeated = { ...brief, time: '01:30' }
  assert.equal(nextBriefTime(at('2026-11-01T05:00:00.000Z'), repeated), '2026-11-01T05:30:00.000Z')
  assert.equal(nextBriefTime(at('2026-11-01T05:45:00.000Z'), repeated), '2026-11-01T06:30:00.000Z')
  assert.equal(nextBriefTime(at('2026-11-01T06:30:00.000Z'), repeated), '2026-11-02T06:30:00.000Z')
})

test('inbox aggregates all five sources, marks reads, and sorts deterministically', () => {
  const input = {
    now: at('2026-11-14T12:00:00.000Z'),
    runs: [run(), run({
      id: 'run-decision', status: 'running', createdAt: '2026-11-14T09:00:00.000Z', finishedAt: null,
      attention: { at: '2026-11-14T11:00:00.000Z', items: [
        { id: 'q1', question: 'Which database?', options: ['Postgres', 'SQLite'], askedAt: '2026-11-14T11:00:00.000Z' },
        { id: 'q2', question: 'Already answered', answer: 'yes' },
      ] },
    })],
    goals: [goal({
      id: 'g-open', status: 'needs-decision',
      decisions: [
        { id: 'd1', question: 'Approve launch?', options: ['yes', 'no'], createdAt: '2026-11-14T10:30:00.000Z' },
        { id: 'd2', question: 'Retired', answer: 'yes', createdAt: '2026-11-14T10:30:00.000Z' },
      ],
    })],
    approvals: [
      { id: 'ap1', toolName: 'shell', reason: 'Run deployment', ownerSessionId: 'session-a', askedAt: '2026-11-14T11:30:00.000Z', expiresAt: '2026-11-14T13:00:00.000Z' },
      { id: 'ap2', toolName: 'old', askedAt: '2026-11-14T08:00:00.000Z', expiresAt: '2026-11-14T09:00:00.000Z' },
    ],
    artifacts: [
      { id: 'art1', runId: 'run-1', name: 'report.pdf', kind: 'pdf', href: '/reports/report.pdf', at: '2026-11-14T10:15:00.000Z' },
      { id: 'art2', runId: 'run-1', name: 'notes.md', at: '2026-11-14T09:15:00.000Z' },
    ],
    readIds: new Set(['run:run-1:added', 'artifact:art1']),
  }
  const before = structuredClone({ ...input, readIds: [...input.readIds] })
  const inbox = buildInbox(input)
  assert.deepEqual(inbox.map(item => item.id), [
    'approval:ap1',
    'run:run-decision:q1',
    'goal:g-open:d1',
    'artifact:art1',
    'run:run-1:completed',
    'artifact:art2',
    'run:run-decision:added',
    'run:run-1:added',
    'goal:g-open:added',
  ])
  assert.equal(inbox.find(item => item.id === 'artifact:art1').read, true)
  assert.equal(inbox.find(item => item.id === 'run:run-1:added').read, true)
  assert.equal(inbox.find(item => item.id === 'approval:ap1').read, false)
  assert.equal(inbox.some(item => item.id === 'approval:ap2'), false)
  assert.equal(inbox.some(item => item.id === 'goal:g-open:d2'), false)
  assert.deepEqual({ ...input, readIds: [...input.readIds] }, before)
})

test('long-goal phase runs deduplicate by origin.goalId and internal planners never enter the inbox', () => {
  const longGoal = goal({ id: 'g-one', status: 'completed', finishedAt: '2026-11-14T11:00:00.000Z' })
  const rows = collectNotifications({
    now: at('2026-11-14T12:00:00.000Z'),
    goals: [longGoal],
    runs: [
      run({ id: 'phase-1', origin: { kind: 'long-goal', goalId: 'g-one', phaseId: 'p1' }, attention: { items: [{ id: 'stale', question: 'Stale phase question' }] } }),
      run({ id: 'phase-2', origin: { kind: 'long-goal', goalId: 'g-one', phaseId: 'p2' } }),
      run({ id: 'plan-1', origin: { kind: 'long-goal', goalId: 'g-one', role: 'decompose' } }),
      run({ id: 'phase-other', origin: { kind: 'long-goal', goalId: 'g-missing', phaseId: 'p1' } }),
      run({ id: 'standalone', origin: { kind: 'scheduled' } }),
    ],
  })
  assert.deepEqual(rows.filter(item => item.event === 'added').map(item => item.taskId).sort(), [
    'g-one', 'phase-other', 'standalone',
  ].sort())
  assert.equal(rows.find(item => item.taskId === 'phase-other').goalId, 'g-missing')
  assert.equal(rows.some(item => item.taskId === 'g-one' && item.taskKind === 'goal'), true)
  assert.equal(rows.some(item => item.taskId === 'phase-1'), false)
  assert.equal(rows.some(item => item.taskId === 'phase-2'), false)
  assert.equal(rows.some(item => item.taskId === 'plan-1'), false)
  assert.equal(rows.some(item => item.id === 'run:phase-1:stale'), false, 'terminal goals do not revive stale phase questions')
})

test('goal cards suppress duplicate run questions by bound question id and explicit key', () => {
  const rows = collectNotifications({
    goals: [goal({
      id: 'g-dedupe', status: 'needs-decision',
      decisions: [{
        id: 'd1', key: 'database-choice', question: 'Which database?', createdAt: '2026-11-14T10:00:00.000Z',
        source: { runId: 'r1', attentionId: 'q1' },
        linked: [{ runId: 'r2', attentionId: 'q2' }],
      }],
    })],
    runs: [
      run({ id: 'r1', origin: { goalId: 'g-dedupe' }, attention: { items: [{ id: 'q1', question: 'Duplicate' }] } }),
      run({ id: 'r2', origin: { goalId: 'g-dedupe' }, attention: { items: [{ id: 'q2', question: 'Duplicate linked' }] } }),
      run({ id: 'r3', origin: { goalId: 'g-dedupe' }, attention: { items: [{ id: 'q3', key: 'database-choice', question: 'Duplicate key' }] } }),
    ],
  })
  assert.deepEqual(rows.filter(item => item.event === 'decision').map(item => item.id), ['goal:g-dedupe:d1'])
})

test('event modes and global channels filter inbox without altering the aggregate', () => {
  const input = {
    now: at('2026-11-14T12:00:00.000Z'),
    runs: [run()],
    preferences: {
      events: { added: 'off', completed: 'push', failed: 'off', decision: 'off', approval: 'off', artifact: 'off' },
      channels: ['inbox', 'push'],
    },
  }
  assert.deepEqual(buildInbox(input), [])
  const result = aggregateNotificationCenter(input)
  assert.deepEqual(result.inbox, [])
  assert.deepEqual(result.notifications.map(item => item.event), ['completed', 'added'])
  assert.equal(result.unreadCount, 0)
  assert.deepEqual(buildInbox({ ...input, preferences: { channels: ['push'] } }), [])
})

test('daily brief uses the local calendar day, counts categories, and keeps its own channel policy', () => {
  const input = {
    now: at('2026-11-14T16:30:00.000Z'), // 2026-11-15 00:30 in Shanghai
    preferences: {
      events: { added: 'off', completed: 'off' },
      dailyBrief: { enabled: true, time: '09:00', timeZone: 'Asia/Shanghai', channels: ['inbox', 'push'] },
    },
    runs: [
      run({ id: 'today', createdAt: '2026-11-14T16:00:00.000Z', finishedAt: '2026-11-14T16:10:00.000Z' }),
      run({ id: 'yesterday', createdAt: '2026-11-14T15:59:59.999Z', finishedAt: '2026-11-14T15:59:59.999Z' }),
      run({ id: 'failed', status: 'failed', createdAt: '2026-11-14T16:20:00.000Z', finishedAt: '2026-11-14T16:25:00.000Z' }),
    ],
    approvals: [{ id: 'ap', toolName: 'shell', askedAt: '2026-11-14T16:28:00.000Z' }],
    artifacts: [{ id: 'art', name: 'brief.md', at: '2026-11-14T16:29:00.000Z' }],
    readIds: ['artifact:art'],
  }
  const brief = buildDailyBrief(input)
  assert.equal(brief.date, '2026-11-15')
  assert.equal(brief.timeZone, 'Asia/Shanghai')
  assert.equal(brief.generatedAt, '2026-11-14T16:30:00.000Z')
  assert.equal(brief.nextAt, '2026-11-15T01:00:00.000Z')
  assert.deepEqual(brief.channels, ['inbox', 'push'])
  assert.deepEqual(brief.summary, {
    added: 2, completed: 1, failed: 1, decisions: 0, approvals: 1, artifacts: 1, needsDecision: 1,
  })
  assert.equal(brief.items.some(item => item.taskId === 'yesterday'), false)
  assert.equal(brief.items.find(item => item.id === 'artifact:art').read, true)
  assert.match(brief.text, /Daily brief — 2026-11-15/)
  assert.match(brief.text, /need decision 1/)
  assert.match(brief.text, /report\.pdf|Ship the release|brief\.md/)
})

test('brief can render a historical day and disabled briefs return null', () => {
  const input = {
    now: at('2026-11-16T12:00:00.000Z'),
    date: at('2026-11-14T12:00:00.000Z'),
    runs: [run()],
  }
  assert.equal(buildDailyBrief(input).date, '2026-11-14')
  assert.equal(buildDailyBrief({ ...input, preferences: { dailyBrief: { enabled: false } } }), null)
})

test('duplicate records and artifact identities are stable; malformed records are ignored', () => {
  const input = {
    runs: [run(), run({ id: 'run-1', goal: 'Duplicate copy' }), null, {}, run({ id: 'bad attention', status: 'running', attention: { items: [null, {}, { id: 'q', answer: 'done' }] } })],
    goals: [goal(), goal({ id: 'g-release-1', title: 'Duplicate' })],
    approvals: [{ id: 'ap', status: 'approved' }, { id: 'open', status: 'pending' }, null],
    artifacts: [
      { runId: 'r', name: 'same.md', path: '/same.md' },
      { runId: 'r', name: 'same.md', path: '/same.md' },
      null,
      {},
    ],
  }
  const first = collectNotifications(input)
  const second = collectNotifications(input)
  assert.deepEqual(first, second)
  assert.equal(new Set(first.map(item => item.id)).size, first.length)
  assert.equal(first.filter(item => item.taskId === 'run-1').length, 2)
  assert.equal(first.filter(item => item.event === 'artifact').length, 1)
  assert.equal(first.some(item => item.id === 'approval:ap'), false)
  assert.equal(first.some(item => item.id === 'approval:open'), true)
})

test('aggregation is pure: inputs stay unchanged and no model, orchestrator, or network is called', () => {
  const calls = []
  const input = {
    now: at('2026-11-14T12:00:00.000Z'),
    runs: [run()],
    goals: [goal()],
    approvals: [{ id: 'ap', toolName: 'shell', askedAt: '2026-11-14T11:00:00.000Z' }],
    artifacts: [{ id: 'art', name: 'result.md', at: '2026-11-14T11:30:00.000Z' }],
    readIds: ['run:run-1:added'],
    model: { call: () => calls.push('model') },
    orchestrator: { start: () => calls.push('start'), status: () => calls.push('status') },
  }
  const snapshot = JSON.stringify(input)
  const model = input.model
  const orchestrator = input.orchestrator
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { calls.push('fetch'); throw new Error('network forbidden') }
  try {
    const first = aggregateNotificationCenter(input)
    const second = aggregateNotificationCenter(input)
    assert.deepEqual(first, second)
    assert.equal(JSON.stringify(input), snapshot)
    assert.equal(input.model, model)
    assert.equal(input.orchestrator, orchestrator)
    assert.deepEqual(calls, [])
    assert.equal(first.dailyBrief.summary.completed, 1)
    assert.equal(first.unreadCount, first.inbox.length - 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('invalid clocks and preference fields fail loudly instead of silently using host time', () => {
  assert.throws(() => buildInbox({ now: 'not-a-date' }), /valid date/)
  assert.throws(() => buildDailyBrief({ now: NaN }), /valid date/)
  assert.throws(() => buildInbox({ now: 1e20 }), /valid date/)
  assert.throws(() => nextBriefTime('bad', DEFAULT_NOTIFY_PREFERENCES.dailyBrief), /valid date/)
  assert.throws(() => aggregateNotificationCenter({ preferences: { maxPushPerHour: '3' } }), /maxPushPerHour/)
  assert.throws(() => aggregateNotificationCenter({ preferences: null }), /must be an object/)
  assert.deepEqual(validateNotifyPreferences(), DEFAULT_NOTIFY_PREFERENCES)
})
