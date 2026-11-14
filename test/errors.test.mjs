import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyError, describeError, summarizeError } from '../lib/errors.js'

test('a Windows sandbox launch failure is explained as a host problem', () => {
  const text = '[error: windows-acl-run: --temp is not an existing directory]'
  const { id, summary, hint } = classifyError(text)
  assert.equal(id, 'sandbox')
  assert.match(summary, /sandbox could not start a child process/)
  assert.match(hint, /not your goal and not your API key/)
  assert.match(hint, /diagnose-windows-sandbox-acl/)
})

test('quota, budget, auth, network and disk errors each get their own next step', () => {
  assert.equal(classifyError('quota exceeded: 2 active run(s) and maxActiveRuns is 2.').id, 'quota')
  assert.equal(classifyError('budget exceeded: model-call budget reached (80/80 calls)').id, 'budget')
  assert.equal(classifyError('401 Unauthorized: invalid api key').id, 'auth')
  assert.equal(classifyError('fetch failed').id, 'network')
  assert.equal(classifyError("EPERM: operation not permitted, rename 'a' -> 'b'").id, 'filesystem')
})

test('an unknown run points at longhaul_list', () => {
  const { id, hint } = classifyError('unknown run 20260101T000000-abcd; call longhaul_list')
  assert.equal(id, 'unknown-run')
  assert.match(hint, /longhaul_list/)
})

test('a host API shape error is called a version mismatch', () => {
  const { id, hint } = classifyError("Cannot read properties of undefined (reading 'maxDepth')")
  assert.equal(id, 'host-api')
  assert.match(hint, /version/)
})

test('an unclassified error keeps the original text and offers one safe action', () => {
  const { id, summary, detail } = classifyError('something nobody has seen before')
  assert.equal(id, 'unclassified')
  assert.equal(summary, 'something nobody has seen before')
  assert.equal(detail, 'something nobody has seen before')
})

test('describeError always returns summary, hint and the untouched detail', () => {
  const text = describeError(new Error("Cannot read properties of undefined (reading 'maxDepth')"))
  const lines = text.split('\n')
  assert.match(lines[0], /^\[error\] /)
  assert.match(lines[1], /^hint: /)
  assert.match(lines[2], /^detail: Cannot read properties of undefined \(reading 'maxDepth'\)$/)
})

test('summarizeError is one sentence for run listings', () => {
  const line = summarizeError('quota exceeded: 1 active run(s) and maxActiveRuns is 1.')
  assert.equal(line, 'the run was not started because the active-run limit is already in use')
  assert.doesNotMatch(line, /\n/)
})

test('classifyError tolerates empty input', () => {
  assert.equal(classifyError(undefined).detail, 'unknown error')
  assert.equal(classifyError('').id, 'unclassified')
})
