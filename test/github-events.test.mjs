import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BODY_LIMIT,
  TITLE_LIMIT,
  normalizeGitHubEvent,
} from '../lib/sources/github-events.js'

const RECEIVED = '2026-11-21T09:30:00+08:00'
const RECEIVED_ISO = '2026-11-21T01:30:00.000Z'
const SHA = 'a'.repeat(40)

const REPO_A = { id: 101, name: 'widget', full_name: 'acme/widget', owner: { login: 'acme' } }
const REPO_B = { id: 202, name: 'widget', full_name: 'other/widget', owner: { login: 'other' } }

function issuePayload({ issue = {}, repository = REPO_A, sender = { login: 'alice' }, action = 'opened' } = {}) {
  return {
    action,
    issue: {
      number: 7,
      title: 'Flaky retry in sync',
      body: 'The sync step retries forever.',
      html_url: 'https://github.com/acme/widget/issues/7',
      state: 'open',
      user: { login: 'alice' },
      ...issue,
    },
    repository,
    sender,
  }
}

function commentPayload({ issue = {}, comment = {}, repository = REPO_A, sender = { login: 'bob' } } = {}) {
  return {
    action: 'created',
    issue: {
      number: 7,
      title: 'Flaky retry in sync',
      body: 'The sync step retries forever.',
      html_url: 'https://github.com/acme/widget/issues/7',
      state: 'open',
      user: { login: 'alice' },
      ...issue,
    },
    comment: {
      id: 9001,
      body: 'Still happens on main.',
      html_url: 'https://github.com/acme/widget/issues/7#issuecomment-9001',
      user: { login: 'bob' },
      ...comment,
    },
    repository,
    sender,
  }
}

function checkRunPayload({ run = {}, repository = REPO_A, sender = { login: 'github-actions[bot]' } } = {}) {
  return {
    action: 'completed',
    check_run: {
      id: 555,
      name: 'unit tests',
      head_sha: SHA,
      status: 'completed',
      conclusion: 'failure',
      html_url: 'https://github.com/acme/widget/runs/555',
      check_suite: { id: 42, pull_requests: [] },
      ...run,
    },
    repository,
    sender,
  }
}

function normalize(event, payload, deliveryId = 'delivery-1', receivedAt = RECEIVED) {
  return normalizeGitHubEvent({ event, deliveryId, payload, receivedAt })
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

test('an opened issue becomes a github work event', () => {
  assert.deepEqual(normalize('issues', issuePayload()), {
    source: 'github',
    eventId: 'github:delivery-1',
    type: 'issues.opened',
    repository: { id: 101, fullName: 'acme/widget' },
    anchor: { kind: 'issue', id: 7 },
    actor: { login: 'alice' },
    receivedAt: RECEIVED_ISO,
    objectId: 'github:101:issue:7',
    subject: {
      number: 7,
      title: 'Flaky retry in sync',
      body: 'The sync step retries forever.',
      url: 'https://github.com/acme/widget/issues/7',
    },
  })
})

test('a comment and its issue resolve to the same work object', () => {
  const issue = normalize('issues', issuePayload(), 'delivery-a')
  const comment = normalize('issue_comment', commentPayload(), 'delivery-b')

  assert.deepEqual(comment.anchor, issue.anchor)
  assert.equal(comment.objectId, issue.objectId)
  assert.notEqual(comment.eventId, issue.eventId)
  assert.equal(comment.type, 'issue_comment.created')
  assert.equal(comment.subject.number, 7)
  assert.equal(comment.subject.commentId, 9001)
  assert.equal(comment.subject.title, 'Flaky retry in sync')
  assert.equal(comment.subject.body, 'Still happens on main.')
  assert.equal(comment.subject.url, 'https://github.com/acme/widget/issues/7#issuecomment-9001')
  assert.equal(comment.actor.login, 'bob')
})

test('a comment on a pull request anchors to the pull request', () => {
  const record = normalize('issue_comment', commentPayload({
    issue: { pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/7' } },
  }))
  const plain = normalize('issue_comment', commentPayload())

  assert.deepEqual(record.anchor, { kind: 'pull_request', id: 7 })
  assert.equal(record.objectId, 'github:101:pull_request:7')
  assert.notEqual(record.objectId, plain.objectId)
})

test('an opened pull request reported as issues/opened anchors to the pull request', () => {
  const record = normalize('issues', issuePayload({
    issue: { pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/7' } },
  }))
  assert.equal(record.type, 'issues.opened')
  assert.deepEqual(record.anchor, { kind: 'pull_request', id: 7 })
})

test('a completed check run without a pull request parses on its own id', () => {
  const record = normalize('check_run', checkRunPayload())

  assert.equal(record.type, 'check_run.completed')
  assert.deepEqual(record.anchor, { kind: 'check_run', id: 555 })
  assert.equal(record.objectId, 'github:101:check_run:555')
  assert.deepEqual(record.subject, {
    name: 'unit tests',
    headSha: SHA,
    conclusion: 'failure',
    url: 'https://github.com/acme/widget/runs/555',
  })
  assert.equal(record.actor.login, 'github-actions[bot]')
})

test('an invalid head_sha or conclusion is dropped instead of guessed', () => {
  const record = normalize('check_run', checkRunPayload({
    run: { head_sha: 'abc123', conclusion: 'exploded' },
  }))
  assert.equal(record.subject.headSha, null)
  assert.equal(record.subject.conclusion, null)
  assert.deepEqual(record.anchor, { kind: 'check_run', id: 555 })

  const missing = normalize('check_run', checkRunPayload({ run: { head_sha: undefined, conclusion: undefined } }))
  assert.equal(missing.subject.headSha, null)
  assert.equal(missing.subject.conclusion, null)
})

test('unsupported event and action pairs return null', () => {
  const pairs = [
    ['issues', 'closed'],
    ['issues', 'edited'],
    ['issues', 'reopened'],
    ['issue_comment', 'edited'],
    ['issue_comment', 'deleted'],
    ['check_run', 'created'],
    ['check_run', 'rerequested'],
    ['pull_request', 'opened'],
    ['check_suite', 'completed'],
    ['push', 'created'],
    ['issues', undefined],
  ]

  for (const [event, action] of pairs) {
    const payload = { ...issuePayload(), action }
    assert.equal(normalize(event, payload), null, `${event}/${action}`)
  }

  assert.equal(
    normalizeGitHubEvent({ event: 'issues', deliveryId: 'd', payload: { repository: REPO_A }, receivedAt: RECEIVED }),
    null,
  )
})

test('a delivery missing a key field returns null', () => {
  const payloads = [
    ['no input', undefined],
    ['no payload', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED }],
    ['no delivery id', { event: 'issues', payload: issuePayload(), receivedAt: RECEIVED }],
    ['blank delivery id', { event: 'issues', deliveryId: '  ', payload: issuePayload(), receivedAt: RECEIVED }],
    ['no repository', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED, payload: { ...issuePayload(), repository: undefined } }],
    ['repository without id', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED, payload: issuePayload({ repository: { full_name: 'acme/widget' } }) }],
    ['repository without full_name', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED, payload: issuePayload({ repository: { id: 101 } }) }],
    ['full_name without owner', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED, payload: issuePayload({ repository: { id: 101, full_name: 'widget' } }) }],
    ['no issue', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED, payload: { ...issuePayload(), issue: undefined } }],
    ['issue without number', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED, payload: issuePayload({ issue: { number: undefined } }) }],
    ['issue number as text', { event: 'issues', deliveryId: 'd', receivedAt: RECEIVED, payload: issuePayload({ issue: { number: '7' } }) }],
    ['comment without id', { event: 'issue_comment', deliveryId: 'd', receivedAt: RECEIVED, payload: commentPayload({ comment: { id: 0 } }) }],
    ['check_run without id', { event: 'check_run', deliveryId: 'd', receivedAt: RECEIVED, payload: checkRunPayload({ run: { id: undefined } }) }],
  ]

  for (const [name, input] of payloads) {
    assert.equal(normalizeGitHubEvent(input), null, name)
  }
})

test('an invalid receivedAt returns null', () => {
  const values = [undefined, null, '', 'not-a-date', '2026-13-01T00:00:00Z', Number.NaN, Number.POSITIVE_INFINITY, {}]

  for (const receivedAt of values) {
    assert.equal(
      normalizeGitHubEvent({ event: 'issues', deliveryId: 'd', payload: issuePayload(), receivedAt }),
      null,
      String(receivedAt),
    )
  }
})

test('replaying a delivery keeps the same ids and a new delivery does not', () => {
  const first = normalize('issues', issuePayload(), 'delivery-42')
  const replay = normalize('issues', issuePayload(), 'delivery-42')
  const next = normalize('issues', issuePayload(), 'delivery-43')

  assert.deepEqual(replay, first)
  assert.equal(next.eventId.startsWith('github:'), true)
  assert.notEqual(next.eventId, first.eventId)
  assert.equal(next.objectId, first.objectId)
  assert.deepEqual(next.anchor, first.anchor)
})

test('the same issue number in another repository is a different object', () => {
  const mine = normalize('issues', issuePayload())
  const theirs = normalize('issues', issuePayload({ repository: REPO_B }), 'delivery-2')

  assert.equal(theirs.anchor.id, mine.anchor.id)
  assert.equal(theirs.repository.id, 202)
  assert.equal(theirs.repository.fullName, 'other/widget')
  assert.notEqual(theirs.objectId, mine.objectId)
})

test('titles and bodies are truncated to fixed limits without splitting characters', () => {
  const title = '修'.repeat(TITLE_LIMIT + 25)
  const body = '😀'.repeat(BODY_LIMIT + 3)

  const issue = normalize('issues', issuePayload({ issue: { title, body } }))
  assert.equal(issue.subject.title, '修'.repeat(TITLE_LIMIT))
  assert.equal(issue.subject.body, '😀'.repeat(BODY_LIMIT))

  const comment = normalize('issue_comment', commentPayload({ comment: { body } }))
  assert.equal(comment.subject.body, '😀'.repeat(BODY_LIMIT))
})

test('a missing body stays null and a missing title stays null', () => {
  const record = normalize('issues', issuePayload({ issue: { title: null, body: null } }))
  assert.equal(record.subject.title, null)
  assert.equal(record.subject.body, null)
})

test('actor is the sender login, or null when the delivery has none', () => {
  assert.equal(normalize('issues', issuePayload({ sender: {} })).actor, null)
  assert.equal(normalize('check_run', checkRunPayload({ sender: { login: '  ' } })).actor, null)

  const payload = issuePayload()
  delete payload.sender
  assert.equal(normalize('issues', payload).actor, null)
})

test('the payload is read-only input', () => {
  const payload = deepFreeze(structuredClone(issuePayload()))
  const record = normalize('issues', payload, 'delivery-9')

  assert.equal(record.eventId, 'github:delivery-9')
  assert.equal(record.subject.title, 'Flaky retry in sync')
})

test('a Date receivedAt is normalized to the same ISO instant', () => {
  const record = normalizeGitHubEvent({
    event: 'issues',
    deliveryId: 'd',
    payload: issuePayload(),
    receivedAt: new Date('2026-11-21T01:30:00Z'),
  })
  assert.equal(record.receivedAt, RECEIVED_ISO)
})
