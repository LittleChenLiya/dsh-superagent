import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(path.join(root, 'lib', 'client.js'), 'utf8')

/**
 * Phase 1 acceptance: every console capability the panel promises must be
 * reached by the panel itself, not left to a second page.
 */
test('the panel sends through one router and keeps project selection local to the composer', () => {
  assert.ok(source.includes("call('/message',"))
  assert.ok(source.includes("call('/router')"))
  assert.ok(source.includes("call('/projects',"))
  assert.ok(!source.includes("call('/sessions')"))
  assert.ok(!source.includes("call('/session/switch'"))
  assert.ok(!source.includes('编辑助理名称'))
})

test('the panel reaches upload, answers and run-level cancel', () => {
  assert.ok(source.includes("call('/upload'"), 'upload comes from POST /upload')
  assert.ok(source.includes('type: \'file\''), 'the composer carries a file picker')
  assert.ok(source.includes("call('/answer'"), 'answers come from POST /answer')
  assert.ok(source.includes('/cancel`'), 'run-level cancel targets POST /runs/:id/cancel')
})

test('the panel previews artifacts and renders attention', () => {
  assert.ok(source.includes('${API}/artifact?path='), 'artifacts open through the console artifact route')
  assert.ok(source.includes('/artifact/reveal'), 'artifacts can be shown in the file manager')
  assert.ok(source.includes('download=1'), 'artifacts can be downloaded')
  assert.ok(source.includes('artifactsOf'), 'run reports are parsed into artifact rows')
  assert.ok(source.includes('run.attention'), 'runs expose the questions waiting for a person')
  assert.ok(source.includes("type: 'artifact'") && source.includes('previewBusy'), 'clicking an artifact previews it in place')
  assert.ok(source.includes("sandbox: ''"), 'HTML previews run inside a sandboxed frame')
})

test('questions and plans are answerable from the shared inbox', () => {
  assert.ok(source.includes("call('/answer'"), 'the answer path is wired')
  assert.ok(source.includes('item.options'), 'plan confirmations render one-tap options')
  assert.ok(source.includes("item.source === 'plan'"), 'plan confirmations say so')
  assert.ok(source.includes("call('/notices/read'"), 'pending inbox items can be marked read')
  assert.ok(source.includes("frame.action === 'expired'"), 'an expired approval explains itself instead of vanishing')
})

test('the run list is clickable instead of a dead list', () => {
  assert.ok(source.includes('onOpen(card.run.id, card.run.parentSessionId)'), 'each run card opens its detail in the correct scope')
  assert.ok(source.includes("className: 'dsa-rowitem'") && source.includes("type: 'button'"), 'run rows are buttons')
  assert.ok(source.includes("waiting ? 'waiting' : task.status"), 'a run waiting on a person turns amber')
  assert.ok(source.includes("'待决定'"), 'the waiting row says what it is waiting for')
})

test('sessions are cards that fit two or three per row and carry their own question', () => {
  assert.ok(source.includes('repeat(auto-fill,minmax(118px,1fr))'), 'the rail fits two or three cards')
  assert.ok(source.includes('.dsa-session-card{'))
  assert.ok(source.includes('.dsa-session-ask{'), 'a question has its own block inside the card')
  assert.ok(source.includes('questionLine(attention.item?.question, 48)'), 'the card renders the question itself')
  assert.ok(!source.includes('正在调度'), 'the rail does not narrate a session count')
  assert.ok(!source.includes('dsa-session-summary'), 'no summary strip sits above the session cards')
})
