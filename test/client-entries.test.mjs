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
test('the panel sends through one router and keeps workspace selection local to the composer', () => {
  assert.ok(source.includes("call('/message',"))
  assert.ok(source.includes("call('/router')"))
  assert.ok(source.includes("call('/projects',"))
  assert.ok(!source.includes("call('/sessions')"))
  assert.ok(!source.includes("call('/session/switch'"))
  assert.ok(!source.includes('编辑助理名称'))
  assert.ok(source.includes("const PANEL_LABEL = '全局助理'"))
  assert.ok(source.includes('工作区文件夹绝对路径'))
  assert.ok(!source.includes('项目助理'))
  assert.ok(!source.includes('项目专属助理'))
  assert.ok(!source.includes('项目文件夹'))
})

test('the global workbench reaches artifacts, automation, and all six rail tabs', () => {
  assert.ok(source.includes('call(`/artifacts?${artifactQuery(query)}`)'))
  assert.ok(source.includes("call('/schedules')"))
  assert.ok(source.includes("label: '概览'") && source.includes("label: '自动化'") && source.includes("label: '更多'"))
  assert.ok(source.includes('dsa-workbench-badge'))
  assert.ok(source.includes('暂无自动化执行记录'))
  assert.ok(source.includes('ownerSessionId ?? descriptor.owner'))
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
  assert.ok(source.includes('onClick: () => onOpen(task.id, task.parentSessionId ?? task.ownerSessionId)'), 'each run row opens its detail in the correct scope')
  assert.ok(source.includes("className: 'dsa-rowitem'") && source.includes("type: 'button'"), 'run rows are buttons')
  assert.ok(source.includes("waiting ? 'waiting' : task.status"), 'a run waiting on a person turns amber')
  assert.ok(source.includes("'等你决定'"), 'the waiting row says what it is waiting for')
})

test('the More hub reaches every first-batch integration and reserves second-batch entry points', () => {
  const labels = ['通知中心', '能力中心', '记忆中心', '运行时视图', '质量证据', '成本中心', 'Agent 档案', '设备配对', '计划预览', '分享', '市场', '云端 Worker']
  for (const label of labels) assert.ok(source.includes(`label: '${label}'`), `${label} has a native More entry`)
  for (const route of ['/notifications/preferences', '/notifications', '/capabilities', '/memory', '/runtime-view',
    '/evidence?limit=100', '/cost', '/profiles?includeDisabled=true', '/device/status', '/plan-preview',
    '/voice/transcribe', '/shares', '/automations', '/market', '/cloud-worker']) {
    assert.ok(source.includes(route), `the client reaches ${route}`)
  }
  assert.ok(source.includes("method: 'PATCH'"), 'notification preferences save through PATCH')
  assert.ok(source.includes('expectedSettingsRevision'), 'MCP changes carry optimistic settings revisions')
  assert.ok(source.includes("action: 'update'") && source.includes("action: 'forget'"), 'memory writes use the console action contract')
  assert.ok(source.includes("action: 'capture'") && source.includes("action: 'takeover'")
    && source.includes("action: 'release'") && source.includes("action: 'stop'"), 'runtime controls are wired')
  assert.ok(source.includes('planFromRun(current, run)'), 'plan preview is built from run subtasks')
  assert.ok(source.includes('artifactIds: [artifactId]'), 'artifact sharing names explicit artifact ids')
})

test('the second-batch More panels expose real actions, confirmations and safe handoffs', () => {
  for (const action of ['previewAutomation', 'saveAutomation', 'automationAction', 'loadAutomationExecutions',
    'shareArtifact', 'removeShare', 'searchMarket', 'marketDetail', 'marketHandoff', 'importMarketSkill',
    'refreshCloudWorker', 'submitCloudWorker', 'cloudWorkerAction', 'openOriginalArtifact', 'continueArtifact',
    'previewCandidatePlan', 'suggestRoute', 'updateRuntimePanel', 'updateMcpDraft', 'updatePlanDraft', 'updateRouteDraft']) {
    assert.ok(source.includes(`${action}:`), `${action} has a client action`)
  }
  for (const action of ['create', 'update', 'remove', 'toggle', 'preview', 'run-now']) {
    assert.ok(source.includes(`action: '${action}'`) || source.includes(`action, id`), `automation action ${action} is wired`)
  }
  assert.ok(source.includes("action: 'install-handoff'"), 'market installation stays a handoff')
  assert.ok(source.includes('executed:'), 'handoff results expose whether anything executed')
  assert.doesNotMatch(source, /marketInstallCommand\([^)]*\)[\s\S]{0,200}(exec|spawn|fetch)\(/, 'the displayed install command is never executed')
  assert.ok(source.includes('expectedRevision'), 'automation writes carry revisions')
  assert.ok(source.includes('idempotencyKey'), 'manual runs and Worker writes carry idempotency keys')
  assert.ok(source.includes("confirmLabel: '确认分享'") && source.includes("confirmLabel: '确认删除'")
    && source.includes("confirmLabel: '确认导入'") && source.includes("confirmLabel: '确认提交'"), 'mutations ask for confirmation')
  assert.ok(!source.includes('第二批服务尚未接入'), 'the second batch is no longer a placeholder')
  for (const label of ['产物开始日期', '产物结束日期', '在原任务打开', '新对话继续', '模型：', '权限：', 'IM：',
    '实时画面', 'runtime-view/events', '执行前候选计划', '权限范围', '运行环境', '模型路由建议', '按需加载', '停用 Skill']) {
    assert.ok(source.includes(label), `${label} is wired`)
  }
})

test('voice capture is browser-native PCM16 WAV and never sends a message', () => {
  assert.ok(source.includes('navigator.mediaDevices.getUserMedia'))
  assert.ok(source.includes('recorder.start(250)'))
  assert.ok(source.includes('context.decodeAudioData'))
  assert.ok(source.includes('view.setUint32(24, 16_000, true)'), 'WAV samples are 16kHz')
  assert.ok(source.includes('view.setUint16(22, 1, true)'), 'WAV is mono')
  assert.ok(source.includes('view.setUint16(34, 16, true)'), 'WAV is PCM16')
  assert.ok(source.includes('releaseVoiceStream(session.stream)'), 'recording always releases microphone tracks')
  assert.ok(source.includes('if (!current(session)) return null'), 'late transcription results are discarded')
  assert.doesNotMatch(source, /voice\/transcribe[\s\S]{0,400}call\('\/message'/, 'voice transcription cannot submit chat')
})
