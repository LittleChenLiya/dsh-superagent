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
test('the panel reaches sessions, history and switching', () => {
  assert.ok(source.includes("call('/sessions')"), 'history comes from GET /sessions')
  assert.ok(source.includes("call('/session',"), 'new conversation comes from POST /session')
  assert.ok(source.includes("call('/session/switch'"), 'switching comes from POST /session/switch')
  assert.ok(source.includes("'aria-label': '会话'"), 'the title bar carries a 会话 entry')
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
})

test('questions and plans are answerable where the user already is', () => {
  assert.ok(source.includes("call('/answer'"), 'the answer path is wired')
  assert.ok(source.includes('item.options'), 'plan confirmations render one-tap options')
  assert.ok(source.includes("item.source === 'plan'"), 'plan confirmations say so')
  assert.ok(source.includes('unread'), 'new questions raise an unread count')
})

test('the run list is clickable instead of a dead list', () => {
  assert.ok(source.includes('onClick: () => props.onOpen?.(run.id)'), 'each run row opens its detail')
  assert.ok(source.includes("className: 'dsa-rowitem'") && source.includes("type: 'button'"), 'run rows are buttons')
})
