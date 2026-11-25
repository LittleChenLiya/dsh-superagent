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
  assert.ok(source.includes("className: 'dsa-inbox-msg'"), 'pending items are spoken in the conversation')
  assert.ok(source.includes("frame.action === 'expired'"), 'an expired approval explains itself instead of vanishing')
})

test('every run card opens its detail in place instead of replacing the list', () => {
  assert.ok(source.includes("'dsa-run-inline'"), 'a run card renders the shared run body inside itself')
  assert.ok(source.includes("renderRunDetail: run => h(RunDetail,"), 'the card and the takeover view share one run body')
  assert.ok(!source.includes("onOpen(card.run.id, card.run.parentSessionId)"),
    'a left click no longer swaps the whole list for a run page')
  assert.ok(source.includes("className: 'dsa-rowitem'") && source.includes("type: 'button'"), 'run rows are buttons')
  assert.ok(source.includes("waiting ? 'waiting' : task.status"), 'a run waiting on a person turns amber')
  assert.ok(source.includes("'待决定'"), 'the waiting row says what it is waiting for')
})

test('sessions are cards that fit two or three per row and carry their own question', () => {
  assert.ok(source.includes('repeat(auto-fill,minmax(min(118px,100%),1fr))'),
    'the rail fits two or three normal cards and permits one narrow track')
  assert.ok(source.includes('.dsa-session-card{'))
  assert.ok(source.includes('.dsa-session-ask{'), 'a question has its own block inside the card')
  assert.ok(source.includes("humanNote(questionText(attention.item?.question), 44) || '待处理'"), 'the card renders the question itself, in Chinese, without a URL')
  assert.ok(!source.includes('正在调度'), 'the rail does not narrate a session count')
  assert.ok(!source.includes('dsa-session-summary'), 'no summary strip sits above the session cards')
  assert.ok(source.includes('.dsa-session-detail{grid-column:1/-1'), 'the detail spans the full grid width')
  assert.ok(source.includes("style: { gridColumn: '1 / -1' }"), 'the detail pins its full-row span')
  assert.ok(!source.includes('grid-auto-flow:dense'), 'expanding never re-packs or reorders cards')
  assert.ok(!source.includes('.dsa-session-card[data-open=true]{grid-column'), 'the open card stays in its own cell')
  assert.ok(!source.includes('.dsa-session-card[data-open=true]{height:auto'), 'the open card keeps its card size')
})

test('a finished goal never keeps a live-looking card or a duplicated run card', () => {
  assert.ok(source.includes("const GOAL_OVER = new Set(['completed', 'cancelled'])"),
    'the goal state overrides a phase left behind as running')
  assert.ok(source.includes('GOAL_OVER.has(goal.status)'), 'a cancelled or completed goal has no live phase card')
  assert.ok(source.includes('phase.currentRunId ?? phase.runId'), 'a phase run is found through currentRunId')
  assert.ok(source.includes('...(Array.isArray(phase.runIds) ? phase.runIds : [])'),
    'every run a phase used is claimed, so it cannot reappear as a second card')
})

test('a card status reads as a sentence and the dot is never the only signal', () => {
  assert.ok(source.includes("running: '正在执行'"), 'a running card says what it is doing')
  assert.ok(source.includes("cancelled: '已取消'"), 'a cancelled card says it was cancelled')
  assert.ok(source.includes("completed: '已完成'"), 'a completed card says it is done')
  assert.ok(source.includes("if (status === 'partial') return 'warning'"), 'partial is not painted green')
  assert.ok(!source.includes("status === 'completed' || status === 'partial'"),
    'green now means completed only, so the colour matches the words')
})

test('the red line says what happened, and the raw ledger stays in details', () => {
  assert.ok(source.includes('plainFailure({'), 'cards build their failure line through one plain-language helper')
  assert.ok(!source.includes('FAILURE_NEXT'), 'the card carries no how-to paragraph')
  assert.ok(!source.includes('可打开详情'), 'no instruction paragraph on the card')
  assert.ok(source.includes('machine-checked by the plugin'), 'machine-check tags are stripped from the card line')
  assert.ok(source.includes('没完成：'), 'the line opens with what happened, in Chinese')
  assert.ok(!source.includes('humanNote(run.report ?? run.output, 40)'),
    'an agent report ledger line never reaches the card')
})

test('the rail refreshes on focus, on a settled event, and when the task state changes', () => {
  assert.ok(source.includes("window.addEventListener('focus'"), 'returning to the window refreshes the rail')
  assert.ok(source.includes("document.addEventListener('visibilitychange'"), 'returning to the tab refreshes the rail')
  assert.ok(source.includes('seesSettled'), 'a run or goal reaching its end is detected')
  assert.ok(source.includes("if (frame.type === 'runs' && seesSettled(before, frame))"),
    'a settled event pulls the authoritative workbench immediately')
})

test('message timestamps wait for hover and receipts stay out of the reading line', () => {
  assert.ok(source.includes("className: 'dsa-time'"), 'both roles render a send time element')
  assert.ok(source.includes('message.at'), 'the time comes from the router timestamp, not the render clock')
  assert.ok(source.includes('.dsa-msg:hover .dsa-time') && source.includes('.dsa-msg:focus-within .dsa-time'),
    'the time is revealed on hover or keyboard focus')
  assert.ok(source.includes('.dsa-msg[data-role=user] .dsa-msg-meta{flex-direction:row-reverse}'),
    'a user message aligns its time to the right')
  assert.ok(source.includes("className: ack ? 'dsa-msg dsa-ack' : 'dsa-msg'"), 'short instant acks take the quiet receipt style')
  assert.ok(!source.includes("dsa-feed-open'"), 'the chat card no longer repeats a 报告 text next to its arrow')
})

test('optional composer tools fold into one quiet menu', () => {
  assert.ok(source.includes("'aria-label': '更多'"), 'the composer has a single more button')
  assert.ok(source.includes("className: 'dsa-card-menu dsa-tool-menu'"), 'the extra tools open in one menu')
  assert.ok(source.includes("}, props.uploading ? '上传中…' : '添加文件')"), 'file upload is a menu item')
  assert.ok(source.includes("withContext ? '✓ 沿用最近对话' : '沿用最近对话'"), 'recent context is a menu item')
  assert.ok(source.includes("'插入批量清单'"), 'the batch template is a menu item')
  assert.ok(!source.includes("'aria-label': '添加文件'") && !source.includes("'aria-label': '沿用最近对话'"),
    'the old always-visible tool buttons are gone')
})
