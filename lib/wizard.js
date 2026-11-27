/**
 * First-use wizard for the conversation console.
 *
 * Everything here is written for a user who has never opened a terminal:
 * environment checks explain themselves, the API key is verified against the
 * real endpoint before anything is written, and the profile patch is edited
 * with a backup that can be restored from the page. The module never returns,
 * logs, or puts an API key into a file under the repository; it is handed to
 * the host's credential store and the configuration only names the reference.
 *
 * The patch editor intentionally understands just the two entries the wizard
 * owns (`llm-pi-ai` and `agent-default-model`). It edits those in place and
 * leaves every other line, comment, and entry untouched.
 *
 * @module dsh-superagent/wizard
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { computeCost, formatMoney } from './cost.js'
import { WorkbenchError } from './workbench.js'

export const WIZARD_DEFAULTS = Object.freeze({
  provider: 'deepseek-official',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
})

const META_FILE = 'wizard.json'
const BACKUP_DIR = path.join('wizard', 'backups')
const BACKUP_LIMIT = 10
const PROBE_TIMEOUT_MS = 8_000
const TRIAL_TIMEOUT_MS = 120_000
const TRIAL_FILE = 'wizard-trial.txt'
const TRIAL_PROMPT = [
  '这是一次安装自检。请只在这个临时目录里操作，不要访问其他目录：',
  `1. 创建文件 ${TRIAL_FILE}，内容写 ok；`,
  '2. 读回这个文件，确认内容。',
  '做完后用一句话说明结果。',
].join('\n')

/** @param {unknown} value @returns {string} */
function messageOf(value) {
  return value instanceof Error ? value.message : String(value)
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

function summarizeArgs(value) {
  if (value === undefined || value === null) return ''
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 180)
}

/** A reference name is a POSIX shell identifier, matching the host seam. */
export function credentialRefFor(provider) {
  const name = String(provider ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${name || 'PROVIDER'}_API_KEY`
}

/** Only ever show a short mask; the stored value is never read back. */
export function maskKey(value) {
  const text = String(value ?? '')
  if (!text) return null
  if (text.length <= 8) return '••••'
  return `${text.slice(0, 3)}…${text.slice(-4)}`
}

function normalizeProvider(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return WIZARD_DEFAULTS.provider
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(raw)) {
    throw new WorkbenchError(400, '提供商名只能包含小写字母、数字和短横线，并以字母开头。', {
      id: 'bad-provider',
      hint: '例如 deepseek-official、openai、my-gateway。',
    })
  }
  return raw
}

function normalizeBaseURL(value) {
  const raw = String(value ?? '').trim()
  if (!raw) {
    throw new WorkbenchError(400, 'baseURL 不能为空。', {
      id: 'bad-base-url',
      hint: 'OpenAI 兼容端点通常形如 https://example.com/v1。',
    })
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new WorkbenchError(400, 'baseURL 不是合法的网址。', {
      id: 'bad-base-url',
      hint: '需要以 http:// 或 https:// 开头，例如 https://api.deepseek.com/v1。',
    })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkbenchError(400, 'baseURL 只支持 http 或 https。', { id: 'bad-base-url' })
  }
  if (parsed.username || parsed.password) {
    throw new WorkbenchError(400, 'baseURL 里不能带用户名或密码。', {
      id: 'bad-base-url',
      hint: 'API key 请填在 key 输入框里，它会被存到宿主凭据库。',
    })
  }
  return raw.replace(/\/+$/, '')
}

function normalizeInput(input = {}, inherited = {}) {
  const model = String(input.model ?? inherited.model ?? '').trim()
  if (!model) {
    throw new WorkbenchError(400, '模型名不能为空。', {
      id: 'bad-model',
      hint: '填提供商控制台里显示的模型 id，例如 deepseek-flash。',
    })
  }
  if (model.length > 200) {
    throw new WorkbenchError(400, '模型名太长了。', { id: 'bad-model' })
  }
  const provider = normalizeProvider(input.provider ?? inherited.provider)
  return {
    provider,
    baseURL: normalizeBaseURL(input.baseURL ?? inherited.baseURL),
    model,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
  }
}

// ---------------------------------------------------------------------------
// Small line-based YAML editor for the two profile entries the wizard owns.
// ---------------------------------------------------------------------------

function indentOf(line) {
  return line.length - line.trimStart().length
}

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

function yamlScalar(value) {
  const text = String(value)
  return /^[A-Za-z0-9._/@+-]+$/.test(text) ? text : JSON.stringify(text)
}

function entryBlocks(lines) {
  const starts = []
  for (let index = 0; index < lines.length; index++) {
    if (/^-\s/.test(lines[index])) starts.push(index)
  }
  return starts.map((start, position) => ({ start, end: starts[position + 1] ?? lines.length }))
}

function findEntry(lines, id) {
  for (const block of entryBlocks(lines)) {
    const match = /^-\s+id:\s*(.+?)\s*$/.exec(lines[block.start])
    if (match && unquote(match[1]) === id) return block
  }
  return null
}

function sectionEnd(lines, headerIndex, limit, indent) {
  for (let index = headerIndex + 1; index < limit; index++) {
    if (!lines[index].trim()) continue
    if (indentOf(lines[index]) <= indent) return index
  }
  return limit
}

function findChild(lines, start, end, indent, key) {
  const pattern = new RegExp(`^ {${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*)$`)
  for (let index = start; index < end; index++) {
    const match = pattern.exec(lines[index])
    if (match) return { index, value: unquote(match[1]) }
  }
  return null
}

function trimInsertion(lines, start, end) {
  let at = end
  while (at > start + 1 && !lines[at - 1].trim()) at -= 1
  return at
}

function replaceScalar(line, key, value) {
  const pattern = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*)(.*?)(\\s+#.*)?$`)
  const match = pattern.exec(line)
  if (!match) return `${' '.repeat(indentOf(line))}${key}: ${yamlScalar(value)}`
  return `${match[1]}${yamlScalar(value)}${match[3] ?? ''}`
}

function setChild(lines, start, end, indent, key, value, { keepExisting = false, beforeKey = null } = {}) {
  const found = findChild(lines, start, end, indent, key)
  if (found) {
    if (!keepExisting && found.value !== String(value)) {
      lines[found.index] = replaceScalar(lines[found.index], key, value)
    }
    return false
  }
  const before = beforeKey ? findChild(lines, start, end, indent, beforeKey) : null
  const at = before ? before.index : trimInsertion(lines, start, end)
  lines.splice(at, 0, `${' '.repeat(indent)}${key}: ${yamlScalar(value)}`)
  return true
}

function findProviderBlock(lines, entry, provider) {
  const providers = findChild(lines, entry.start, entry.end, 4, 'providers')
  if (!providers) return null
  const providersEnd = sectionEnd(lines, providers.index, entry.end, 4)
  for (let index = providers.index + 1; index < providersEnd; index++) {
    if (!lines[index].trim()) continue
    if (indentOf(lines[index]) !== 6) continue
    const match = /^ {6}([A-Za-z0-9._-]+):\s*(?:#.*)?$/.exec(lines[index])
    if (!match || unquote(match[1]) !== provider) continue
    let end = providersEnd
    for (let next = index + 1; next < providersEnd; next++) {
      if (lines[next].trim() && indentOf(lines[next]) <= 6) {
        end = next
        break
      }
    }
    return { start: index, end }
  }
  return null
}

function providerBlockLines(provider, { ref, baseURL, model }) {
  return [
    `      ${provider}:`,
    `        apiKeyEnv: ${yamlScalar(ref)}`,
    `        displayName: ${yamlScalar(provider)}`,
    '        api: openai-completions',
    `        baseURL: ${yamlScalar(baseURL)}`,
    '        models:',
    `          - id: ${yamlScalar(model)}`,
  ]
}

function ensureEntry(lines, id) {
  const found = findEntry(lines, id)
  if (found) return { entry: found, created: false }
  if (lines.length > 0 && lines[lines.length - 1].trim()) lines.push('')
  const start = lines.length
  lines.push(`- id: ${id}`)
  return { entry: { start, end: lines.length }, created: true }
}

function ensureConfig(lines, id) {
  let entry = findEntry(lines, id)
  const existing = findChild(lines, entry.start, entry.end, 2, 'config')
  if (existing) return { entry, config: existing }
  lines.splice(entry.start + 1, 0, '  config:')
  entry = findEntry(lines, id)
  return { entry, config: findChild(lines, entry.start, entry.end, 2, 'config') }
}

function ensureProviders(lines, id) {
  const ensured = ensureConfig(lines, id)
  const configEnd = sectionEnd(lines, ensured.config.index, ensured.entry.end, 2)
  const existing = findChild(lines, ensured.config.index, configEnd, 4, 'providers')
  if (existing) return { entry: ensured.entry, providers: existing }
  const at = trimInsertion(lines, ensured.config.index, configEnd)
  lines.splice(at, 0, '    providers:')
  const entry = findEntry(lines, id)
  return { entry, providers: findChild(lines, entry.start, entry.end, 4, 'providers') }
}

/**
 * Merge the wizard's provider and default-model settings into one patch text.
 *
 * @param {string} text - current `cordis.patch.yml`, or an empty string.
 * @param {object} input - normalized `{ provider, baseURL, model }`.
 * @returns {{ text: string, changes: object, summary: string[], previous: object | null }}
 */
export function mergeWizardPatch(text, input) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const ref = credentialRefFor(input.provider)
  const changes = {
    createdEntries: [],
    createdProvider: false,
    addedModel: false,
    previousDefault: null,
    defaultChanged: false,
  }

  const llmEntry = findEntry(lines, 'llm-pi-ai')
  const previous = readDefaultModelFromLines(lines)
  changes.previousDefault = previous

  const createdLlm = llmEntry === null
  const created = ensureEntry(lines, 'llm-pi-ai')
  if (createdLlm) changes.createdEntries.push('llm-pi-ai')
  if (createdLlm) {
    const ensured = ensureProviders(lines, 'llm-pi-ai')
    const providersEnd = sectionEnd(lines, ensured.providers.index, ensured.entry.end, 4)
    const at = trimInsertion(lines, ensured.providers.index, providersEnd)
    lines.splice(at, 0, ...providerBlockLines(input.provider, { ref, baseURL: input.baseURL, model: input.model }))
    changes.createdProvider = true
    changes.addedModel = true
  } else {
    const entry = created.entry
    const existing = findProviderBlock(lines, entry, input.provider)
    if (!existing) {
      const ensured = ensureProviders(lines, 'llm-pi-ai')
      const providersEnd = sectionEnd(lines, ensured.providers.index, ensured.entry.end, 4)
      const at = trimInsertion(lines, ensured.providers.index, providersEnd)
      lines.splice(at, 0, ...providerBlockLines(input.provider, { ref, baseURL: input.baseURL, model: input.model }))
      changes.createdProvider = true
      changes.addedModel = true
    } else {
      // Re-find after every insertion: the line array shifts under us.
      for (const [key, value, options] of [
        ['apiKeyEnv', ref, {}],
        ['displayName', input.provider, { keepExisting: true }],
        ['api', 'openai-completions', { keepExisting: true }],
        ['baseURL', input.baseURL, {}],
      ]) {
        const block = findProviderBlock(lines, findEntry(lines, 'llm-pi-ai'), input.provider)
        setChild(lines, block.start, block.end, 8, key, value, { beforeKey: 'models', ...options })
      }
      let block = findProviderBlock(lines, findEntry(lines, 'llm-pi-ai'), input.provider)
      let models = findChild(lines, block.start, block.end, 8, 'models')
      if (!models) {
        const at = trimInsertion(lines, block.start, block.end)
        lines.splice(at, 0, '        models:')
        block = findProviderBlock(lines, findEntry(lines, 'llm-pi-ai'), input.provider)
        models = findChild(lines, block.start, block.end, 8, 'models')
      }
      const modelsEnd = sectionEnd(lines, models.index, block.end, 8)
      const hasModel = lines
        .slice(models.index + 1, modelsEnd)
        .some(line => /^\s+-\s+id:\s*/.test(line) && unquote(line.replace(/^\s+-\s+id:\s*/, '')) === input.model)
      if (!hasModel) {
        const at = trimInsertion(lines, models.index, modelsEnd)
        lines.splice(at, 0, `          - id: ${yamlScalar(input.model)}`)
        changes.addedModel = true
      }
    }
  }

  const defaultEntry = findEntry(lines, 'agent-default-model')
  if (!defaultEntry) {
    changes.createdEntries.push('agent-default-model')
    if (lines.length > 0 && lines[lines.length - 1].trim()) lines.push('')
    lines.push('- id: agent-default-model', '  config:', `    provider: ${yamlScalar(input.provider)}`, `    model: ${yamlScalar(input.model)}`)
  } else {
    const ensured = ensureConfig(lines, 'agent-default-model')
    const configEnd = sectionEnd(lines, ensured.config.index, ensured.entry.end, 2)
    setChild(lines, ensured.config.index, configEnd, 4, 'provider', input.provider)
    const afterProvider = ensureConfig(lines, 'agent-default-model')
    setChild(
      lines,
      afterProvider.config.index,
      sectionEnd(lines, afterProvider.config.index, afterProvider.entry.end, 2),
      4,
      'model',
      input.model,
    )
  }

  changes.defaultChanged = !previous
    || previous.provider !== input.provider
    || previous.model !== input.model

  const summary = summarizeMerge(input, changes, ref)
  const merged = lines.join('\n')
  return {
    text: merged.endsWith('\n') ? merged : `${merged}\n`,
    changes,
    summary,
    previous,
  }
}

function readDefaultModelFromLines(lines) {
  const entry = findEntry(lines, 'agent-default-model')
  if (!entry) return null
  const config = findChild(lines, entry.start, entry.end, 2, 'config')
  if (!config) return null
  const configEnd = sectionEnd(lines, config.index, entry.end, 2)
  const provider = findChild(lines, config.index, configEnd, 4, 'provider')
  const model = findChild(lines, config.index, configEnd, 4, 'model')
  if (!provider?.value || !model?.value) return null
  return { provider: provider.value, model: model.value }
}

/** Read the profile's current default model without exposing anything else. */
export function readDefaultModel(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  return readDefaultModelFromLines(lines)
}

/** Read one provider route (`baseURL` and model ids) from a patch text. */
export function readProviderRoute(text, provider) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const entry = findEntry(lines, 'llm-pi-ai')
  if (!entry) return null
  const block = findProviderBlock(lines, entry, provider)
  if (!block) return null
  const baseURL = findChild(lines, block.start, block.end, 8, 'baseURL')?.value ?? null
  const models = findChild(lines, block.start, block.end, 8, 'models')
  const ids = []
  if (models) {
    const end = sectionEnd(lines, models.index, block.end, 8)
    for (const line of lines.slice(models.index + 1, end)) {
      const match = /^\s+-\s+id:\s*(.+?)\s*$/.exec(line)
      if (match) ids.push(unquote(match[1]))
    }
  }
  return { baseURL, models: ids }
}

function summarizeMerge(input, changes, ref) {
  const summary = []
  if (changes.createdEntries.includes('llm-pi-ai')) {
    summary.push('新增 llm-pi-ai 配置段（OpenAI 兼容提供方）。')
  }
  if (changes.createdProvider) {
    summary.push(`新增提供方 ${input.provider}，地址 ${input.baseURL}，模型 ${input.model}。`)
  } else {
    summary.push(`更新提供方 ${input.provider} 的地址与密钥引用${changes.addedModel ? `，并新增模型 ${input.model}` : ''}。`)
  }
  if (changes.previousDefault) {
    const same = changes.previousDefault.provider === input.provider
      && changes.previousDefault.model === input.model
    summary.push(same
      ? `默认模型保持 ${input.provider}/${input.model}。`
      : `默认模型从 ${changes.previousDefault.provider}/${changes.previousDefault.model} 改为 ${input.provider}/${input.model}。`)
  } else {
    summary.push(`把默认模型设为 ${input.provider}/${input.model}。`)
  }
  summary.push(`密钥写入宿主凭据库，配置里只出现引用名 ${ref}。`)
  summary.push('保留文件里其余条目和注释；写入前自动备份。')
  return summary
}

// ---------------------------------------------------------------------------
// Wizard implementation
// ---------------------------------------------------------------------------

/**
 * Create the first-use wizard.
 *
 * @param {object} options - dependencies.
 * @param {string} options.stateRoot - plugin state directory (holds meta + backups).
 * @param {string} options.version - plugin version.
 * @param {() => object | null} [options.getProfile] - host `profileContext`.
 * @param {() => object | undefined} [options.getCredentials] - host credential seam.
 * @param {() => object | null} [options.getDefaultModel] - current host model selection.
 * @param {() => object | null} [options.getSessionController] - host session service.
 * @param {(sessionId: string) => Promise<object[] | null>} [options.listTools] - session tools.
 * @param {object} [options.pricing] - plugin price table.
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch for tests.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 */
export function createWizard({
  stateRoot,
  version,
  getProfile = () => null,
  getCredentials = () => undefined,
  getDefaultModel = () => null,
  getSessionController = () => null,
  listTools = async () => null,
  pricing = {},
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  if (!stateRoot) throw new Error('createWizard needs a stateRoot')
  const metaPath = path.join(stateRoot, META_FILE)
  const backupRoot = path.join(stateRoot, BACKUP_DIR)
  let writeQueue = Promise.resolve()
  let trialInFlight = null

  function serialize(task) {
    const run = writeQueue.then(task, task)
    writeQueue = run.then(() => {}, () => {})
    return run
  }

  async function readMeta() {
    try {
      const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.version === 1) return parsed
    } catch {
      // A missing or damaged sidecar is not an error: the wizard can rebuild it.
    }
    return { version: 1, backups: [] }
  }

  async function writeMeta(meta) {
    await fsp.mkdir(stateRoot, { recursive: true })
    const tmp = `${metaPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await fsp.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(tmp, metaPath)
    try {
      await fsp.chmod(metaPath, 0o600)
    } catch {
      // Windows ignores most mode bits; the file's ACL still applies.
    }
  }

  function profileInfo() {
    let profile = null
    try {
      profile = getProfile?.() ?? null
    } catch (error) {
      return {
        ok: false,
        reason: `读取 profile 位置失败：${messageOf(error)}`,
        name: null,
        dir: null,
        patchPath: null,
      }
    }
    const dir = typeof profile?.dir === 'string' && profile.dir ? profile.dir : null
    if (!dir) {
      return {
        ok: false,
        reason: '宿主没有提供 profileContext，向导不知道要把配置写到哪里。',
        name: null,
        dir: null,
        patchPath: null,
      }
    }
    return {
      ok: true,
      reason: null,
      name: typeof profile.name === 'string' ? profile.name : path.basename(dir),
      dir,
      patchPath: typeof profile.patchPath === 'string' && profile.patchPath
        ? profile.patchPath
        : path.join(dir, 'cordis.patch.yml'),
    }
  }

  async function readPatch(info) {
    try {
      return await fsp.readFile(info.patchPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return ''
      throw error
    }
  }

  function hostSelection() {
    try {
      const selection = getDefaultModel?.()
      if (!selection || typeof selection !== 'object') return null
      const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
      const model = typeof selection.model === 'string' ? selection.model.trim() : ''
      return provider && model ? { provider, model } : null
    } catch {
      return null
    }
  }

  function inheritedForm(patchText, meta) {
    const patchDefault = readDefaultModel(patchText)
    const host = hostSelection()
    const provider = patchDefault?.provider ?? meta.provider ?? host?.provider ?? WIZARD_DEFAULTS.provider
    const model = patchDefault?.model ?? meta.model ?? host?.model ?? WIZARD_DEFAULTS.model
    const route = readProviderRoute(patchText, provider)?.baseURL
    const baseURL = route ?? (meta.provider === provider ? meta.baseURL : null)
      ?? (provider === WIZARD_DEFAULTS.provider ? WIZARD_DEFAULTS.baseURL : null)
    return { provider, model, baseURL, source: patchDefault ? 'patch' : meta.provider ? 'meta' : host ? 'host' : 'fallback' }
  }

  async function patchWritable(info) {
    try {
      await fsp.access(info.patchPath, fsConstants.W_OK)
      return { ok: true, reason: null }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, reason: `${info.patchPath} 不可写：${messageOf(error)}` }
      }
      try {
        await fsp.access(info.dir, fsConstants.W_OK)
        return { ok: true, reason: null }
      } catch (inner) {
        return { ok: false, reason: `${info.dir} 不可写：${messageOf(inner)}` }
      }
    }
  }

  async function writeAtomic(file, text) {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
    let handle
    try {
      handle = await fsp.open(tmp, 'w', 0o600)
      await handle.writeFile(text, 'utf8')
      await handle.sync?.()
    } finally {
      await handle?.close()
    }
    try {
      await fsp.rename(tmp, file)
    } catch (error) {
      await fsp.unlink(tmp).catch(() => {})
      throw error
    }
  }

  async function ensureBackupDir() {
    await fsp.mkdir(backupRoot, { recursive: true })
  }

  function backupId(now) {
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
    return `${stamp}-${randomBytes(3).toString('hex')}`
  }

  async function saveBackup(info, text, summary, now) {
    await ensureBackupDir()
    const id = backupId(now)
    const file = path.join(backupRoot, `${id}.yml`)
    await fsp.writeFile(file, text, 'utf8')
    try {
      await fsp.chmod(file, 0o600)
    } catch {
      // See writeMeta.
    }
    return {
      id,
      file,
      createdAt: now.toISOString(),
      patchPath: info.patchPath,
      summary: summary.slice(0, 6),
    }
  }

  async function pruneBackups(meta) {
    const keep = meta.backups.slice(0, BACKUP_LIMIT)
    const drop = meta.backups.slice(BACKUP_LIMIT)
    meta.backups = keep
    for (const entry of drop) {
      if (entry?.file) await fsp.unlink(entry.file).catch(() => {})
    }
  }

  function credentialService() {
    let service
    try {
      service = getCredentials?.()
    } catch {
      service = undefined
    }
    return service && typeof service.set === 'function' ? service : null
  }

  async function describeRef(ref) {
    const service = credentialService()
    if (!service) return { configured: false, writable: false, source: null, available: false }
    try {
      const info = await service.describe(ref)
      return {
        configured: info?.configured === true,
        writable: info?.writable === true,
        source: info?.source ?? null,
        available: true,
      }
    } catch (error) {
      return { configured: false, writable: false, source: null, available: false, reason: messageOf(error) }
    }
  }

  async function resolveRef(ref) {
    const service = credentialService()
    if (!service || typeof service.resolve !== 'function') return null
    try {
      return (await service.resolve(ref))?.value ?? null
    } catch {
      return null
    }
  }

  function networkError(error, baseURL) {
    const code = error?.cause?.code ?? error?.code ?? ''
    const host = (() => {
      try {
        return new URL(baseURL).host
      } catch {
        return baseURL
      }
    })()
    if (error?.name === 'AbortError') {
      return new WorkbenchError(422, `连接 ${host} 超过 ${PROBE_TIMEOUT_MS / 1000} 秒没有响应。`, {
        id: 'base-timeout',
        hint: '确认这个地址能从本机访问；公司网络或代理环境下，可能需要先配置代理。',
      })
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new WorkbenchError(422, `找不到 ${host}（域名解析失败）。`, {
        id: 'base-unreachable',
        hint: '检查 baseURL 的域名是否拼错，以及本机是否能正常上网。',
      })
    }
    if (code === 'ECONNREFUSED') {
      return new WorkbenchError(422, `连接 ${host} 被拒绝。`, {
        id: 'base-unreachable',
        hint: '检查 baseURL 的端口和协议（http/https），以及服务是否已经启动。',
      })
    }
    if (String(code).startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      return new WorkbenchError(422, `连接 ${host} 时 TLS 证书校验失败。`, {
        id: 'base-tls',
        hint: '确认 baseURL 使用受信任的 https 证书；如果是内网自签名证书，需要先在系统里信任它。',
      })
    }
    return new WorkbenchError(422, `连不上 ${host}（网络不通，或者地址写错了）。`, {
      id: 'base-unreachable',
      hint: '检查地址拼写、网络和代理设置。OpenAI 兼容端点通常以 /v1 结尾。',
    })
  }

  function keyRejected(status) {
    return new WorkbenchError(422, `API key 被端点拒绝（HTTP ${status}）。`, {
      id: 'key-rejected',
      hint: '检查 key 是否复制完整、是否属于这个提供商；确认后重新粘贴。',
    })
  }

  function modelMissing(model, ids) {
    const examples = Array.isArray(ids) && ids.length > 0 ? ids.slice(0, 5).join('、') : ''
    return new WorkbenchError(422, `端点里没有模型「${model}」。`, {
      id: 'model-missing',
      hint: examples
        ? `可用的模型示例：${examples}。也可以去提供商控制台确认模型 id。`
        : '检查模型名是否拼写正确，或先在提供商控制台确认这个模型已经开通。',
    })
  }

  function httpFailure(status, detail) {
    const suffix = detail ? ` 端点返回：${detail}` : ''
    let hint = '查看提供商状态页，或确认 baseURL 指向一个 OpenAI 兼容接口。'
    if (status === 429) hint = '请求太频繁，等几十秒再试。'
    if (status >= 500) hint = '端点自己出错了，稍后重试；如果一直这样，换一个 baseURL 或联系提供商。'
    return new WorkbenchError(422, `端点返回 HTTP ${status}。${suffix}`, { id: 'endpoint-http', hint })
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    timer.unref?.()
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function snippet(response) {
    try {
      const text = (await response.text()).replace(/\s+/g, ' ').trim()
      return text.slice(0, 200)
    } catch {
      return ''
    }
  }

  /**
   * Verify one route and its key without writing anything.
   *
   * `GET /models` answers all three failure modes cheaply. An endpoint that
   * does not implement it falls back to a one-token chat completion, which is
   * the only way left to distinguish "wrong path" from "unknown model".
   */
  async function probeRoute({ provider, baseURL, model, apiKey }) {
    let modelsResponse
    try {
      modelsResponse = await fetchWithTimeout(`${baseURL}/models`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      })
    } catch (error) {
      throw networkError(error, baseURL)
    }
    if (modelsResponse.status === 401 || modelsResponse.status === 403) {
      throw keyRejected(modelsResponse.status)
    }
    if (modelsResponse.ok) {
      let document = null
      try {
        document = await modelsResponse.json()
      } catch {
        document = null
      }
      if (document) {
        const ids = Array.isArray(document.data)
          ? document.data.map(entry => entry?.id).filter(id => typeof id === 'string' && id)
          : []
        if (ids.length > 0) {
          if (!ids.includes(model)) throw modelMissing(model, ids)
          return { checked: 'models', models: ids.slice(0, 8), provider }
        }
      }
    } else if (modelsResponse.status !== 404 && modelsResponse.status !== 405) {
      throw httpFailure(modelsResponse.status, await snippet(modelsResponse))
    }

    let chatResponse
    try {
      chatResponse = await fetchWithTimeout(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
          stream: false,
        }),
      })
    } catch (error) {
      throw networkError(error, baseURL)
    }
    if (chatResponse.ok) return { checked: 'chat', models: [], provider }
    const detail = await snippet(chatResponse)
    if (chatResponse.status === 401 || chatResponse.status === 403) throw keyRejected(chatResponse.status)
    if (chatResponse.status === 404) {
      throw new WorkbenchError(422, '在 baseURL 后面找不到 chat/completions 接口。', {
        id: 'endpoint-invalid',
        hint: 'OpenAI 兼容端点通常以 /v1 结尾，例如 https://example.com/v1；检查地址是否少了一段。',
      })
    }
    if (chatResponse.status === 400 && /model/i.test(detail)) throw modelMissing(model, [])
    throw httpFailure(chatResponse.status, detail)
  }

  function credentialRef(input, meta) {
    if (meta?.provider === input.provider && typeof meta?.ref === 'string' && meta.ref) return meta.ref
    return credentialRefFor(input.provider)
  }

  async function resolveApiKey(input, meta) {
    if (input.apiKey) return { key: input.apiKey, source: 'input', ref: credentialRef(input, meta) }
    const ref = credentialRef(input, meta)
    const value = await resolveRef(ref)
    if (!value) {
      await describeRef(ref)
      throw new WorkbenchError(422, '还没有可用的 API key。', {
        id: 'missing-key',
        hint: '在向导里填一次 key，再点“检查并预览”。它只会写进宿主凭据库。',
      })
    }
    return { key: value, source: 'stored', ref }
  }

  /** Build the full plan, including the text that would be written. */
  async function prepare(body) {
    const profile = profileInfo()
    if (!profile.ok) {
      throw new WorkbenchError(503, profile.reason, {
        id: 'profile-unavailable',
        hint: '确认宿主提供了 profileContext；这个向导不会猜配置文件的位置。',
      })
    }
    const writable = await patchWritable(profile)
    if (!writable.ok) {
      throw new WorkbenchError(503, writable.reason, {
        id: 'patch-readonly',
        hint: '检查这个文件的权限，或把宿主换到当前用户可写的 profile。',
      })
    }
    const meta = await readMeta()
    const before = await readPatch(profile)
    const inherited = inheritedForm(before, meta)
    if (!body?.baseURL && !inherited.baseURL) {
      throw new WorkbenchError(422, `宿主模型 ${inherited.provider}/${inherited.model} 没有可用的 baseURL。`, {
        id: 'base-url-required',
        hint: '请填写该提供商的实际 OpenAI 兼容地址；向导不会把未知提供商猜成 DeepSeek 官方端点。',
      })
    }
    const input = normalizeInput(body, inherited)
    const { key, source, ref } = await resolveApiKey(input, meta)
    const probe = await probeRoute({ provider: input.provider, baseURL: input.baseURL, model: input.model, apiKey: key })
    const merged = mergeWizardPatch(before, input)
    return {
      input,
      profile,
      meta,
      ref,
      inheritedFrom: inherited.source,
      keySource: source,
      keyMask: maskKey(key),
      probe,
      before,
      merged,
    }
  }

  function publicPlan(plan) {
    return {
      provider: plan.input.provider,
      baseURL: plan.input.baseURL,
      model: plan.input.model,
      key: {
        ref: plan.ref,
        source: plan.keySource,
        configured: true,
        writable: credentialService() !== null,
        mask: plan.keyMask ?? null,
        verified: true,
        checked: plan.probe.checked,
      },
      summary: plan.merged.summary,
      changes: plan.merged.changes,
      previous: plan.merged.previous,
      inheritedFrom: plan.inheritedFrom,
      target: {
        profile: plan.profile.name,
        patchPath: plan.profile.patchPath,
        exists: plan.before.length > 0,
      },
      note: '密钥只写入宿主凭据库；页面不会显示完整值，日志里也不会出现。',
    }
  }

  async function preview(body) {
    const plan = await prepare(body)
    return publicPlan(plan)
  }

  async function save(body) {
    return serialize(async () => {
      const plan = await prepare(body)
      const service = credentialService()
      if (!service) {
        throw new WorkbenchError(503, '宿主没有提供凭据库，向导不会把 key 写进配置文件。', {
          id: 'credentials-unavailable',
          hint: '这个 profile 缺少 dsh-credentials；先启用它，或使用宿主的环境变量方式配置 key。',
        })
      }
      const meta = plan.meta
      const beforeHadKey = await describeRef(plan.ref)
      let keyPersisted = null
      try {
        if (plan.input.apiKey) await service.set(plan.ref, plan.input.apiKey)
      } catch (error) {
        throw new WorkbenchError(503, `key 没能写入宿主凭据库：${messageOf(error)}`, {
          id: 'credential-write-failed',
          hint: '检查 $DSH_HOME 下的凭据存储是否可写，然后重试。',
        })
      }
      if (plan.input.apiKey) {
        const after = await describeRef(plan.ref)
        // The managed store reports itself as `file`; environment layers use
        // their own names (`env`, `project-env`, `user-env`).
        keyPersisted = after.source === 'file'
      }

      const now = new Date()
      let backup = null
      let written = false
      try {
        backup = await saveBackup(plan.profile, plan.before, plan.merged.summary, now)
        await writeAtomic(plan.profile.patchPath, plan.merged.text)
        written = true
      } catch (error) {
        if (!written && backup) {
          await writeAtomic(plan.profile.patchPath, plan.before).catch(() => {})
        }
        if (plan.input.apiKey && !beforeHadKey.configured) {
          try {
            await service.unset?.(plan.ref)
          } catch {
            // The old value is already gone; the failed write is what matters.
          }
        }
        throw new WorkbenchError(500, `配置没有写成功：${messageOf(error)}`, {
          id: 'patch-write-failed',
          hint: '文件已按备份恢复（如果存在备份）；稍后可以重试。',
        })
      }

      meta.version = 1
      meta.provider = plan.input.provider
      meta.baseURL = plan.input.baseURL
      meta.model = plan.input.model
      meta.ref = plan.ref
      if (plan.input.apiKey) meta.mask = maskKey(plan.input.apiKey)
      meta.verifiedAt = now.toISOString()
      meta.verification = {
        provider: plan.input.provider,
        baseURL: plan.input.baseURL,
        model: plan.input.model,
        ok: true,
        checked: plan.probe.checked,
        at: now.toISOString(),
      }
      meta.backups = Array.isArray(meta.backups) ? meta.backups : []
      if (backup) meta.backups.unshift(backup)
      await pruneBackups(meta)
      await writeMeta(meta)

      const view = publicPlan(plan)
      const modelLive = await waitForConfiguredModel()
      return {
        ...view,
        key: { ...view.key, persisted: keyPersisted },
        saved: true,
        backup: backup
          ? { id: backup.id, createdAt: backup.createdAt }
          : null,
        restartHint: modelLive
          ? null
          : '宿主还没切换到新模型。如果试跑时模型没变，重启宿主后再试一次。',
      }
    })
  }

  async function rollback(id) {
    return serialize(async () => {
      const meta = await readMeta()
      const key = String(id ?? '').trim()
      if (!/^[0-9a-z-]+$/i.test(key)) {
        throw new WorkbenchError(400, '备份编号不合法。', { id: 'bad-backup-id' })
      }
      const entry = (meta.backups ?? []).find(item => item?.id === key)
      if (!entry) {
        throw new WorkbenchError(404, `找不到备份 ${key}。`, {
          id: 'unknown-backup',
          hint: '刷新页面看当前可用的备份；备份最多保留 10 份。',
        })
      }
      const profile = profileInfo()
      if (!profile.ok) throw new WorkbenchError(503, profile.reason, { id: 'profile-unavailable' })
      let text
      try {
        text = await fsp.readFile(entry.file, 'utf8')
      } catch (error) {
        throw new WorkbenchError(404, `备份文件读不到：${messageOf(error)}`, { id: 'backup-missing' })
      }
      try {
        await writeAtomic(profile.patchPath, text)
      } catch (error) {
        throw new WorkbenchError(500, `回滚没有写成功：${messageOf(error)}`, { id: 'rollback-failed' })
      }
      meta.lastRollbackAt = new Date().toISOString()
      meta.verification = null
      await writeMeta(meta)
      return {
        restored: true,
        id: key,
        patchPath: profile.patchPath,
        summary: '已恢复到写入前的配置。API key 仍留在宿主凭据库中；如需删除，请在凭据设置里移除。',
      }
    })
  }

  async function trialStatusInfo(status, sessionId) {
    if (!sessionId) return { ok: false, value: '还没有会话', hint: '先在页面上完成初始化（或点“重新检查”）。' }
    if (typeof listTools !== 'function') return { ok: false, value: '宿主不能枚举工具', hint: null }
    try {
      const tools = await listTools(sessionId)
      if (!Array.isArray(tools)) return { ok: false, value: '读不到工具清单', hint: '宿主没有返回这个会话的工具。' }
      const names = tools.map(tool => tool?.name).filter(name => typeof name === 'string')
      const core = names.filter(name => /^(bash|pwsh|read|write|edit|glob|grep)$/.test(name))
      return {
        ok: names.length > 0,
        value: `${names.length} 个`,
        hint: core.length > 0 ? `含 ${core.slice(0, 4).join('、')}` : null,
      }
    } catch (error) {
      return { ok: false, value: '读取工具清单失败', hint: messageOf(error) }
    }
  }

  async function status({ sessionId = null, probe = false } = {}) {
    const profile = profileInfo()
    const writable = profile.ok ? await patchWritable(profile) : { ok: false, reason: profile.reason }
    const meta = await readMeta()
    let patchText = ''
    if (profile.ok) {
      try {
        patchText = await readPatch(profile)
      } catch {
        patchText = ''
      }
    }
    const patchDefault = readDefaultModel(patchText)
    const hostModel = hostSelection()
    // Explicit wizard-owned state wins. With no patch/meta, inherit the live
    // host route rather than pairing a host provider with a guessed endpoint.
    const inherited = inheritedForm(patchText, meta)
    const form = {
      provider: inherited.provider,
      model: inherited.model,
      baseURL: inherited.baseURL,
    }
    const ref = credentialRefFor(form.provider)
    const keyInfo = await describeRef(ref)
    let keyMask = meta.ref === ref ? meta.mask ?? null : null
    if (!keyMask && keyInfo.configured) {
      const value = await resolveRef(ref)
      if (value) keyMask = maskKey(value)
    }
    const verification = meta.verification
      && meta.verification.provider === form.provider
      && meta.verification.model === form.model
      ? meta.verification
      : null

    let liveVerification = null
    if (probe && form.baseURL && keyInfo.configured) {
      const apiKey = await resolveRef(ref)
      if (apiKey) {
        try {
          const result = await probeRoute({ provider: form.provider, baseURL: form.baseURL, model: form.model, apiKey })
          liveVerification = { ok: true, at: new Date().toISOString(), checked: result.checked }
        } catch (error) {
          liveVerification = {
            ok: false,
            at: new Date().toISOString(),
            code: error?.id ?? 'probe-failed',
            message: messageOf(error),
            hint: error?.hint ?? null,
          }
        }
        if (liveVerification.ok) {
          meta.verification = { provider: form.provider, baseURL: form.baseURL, model: form.model, ...liveVerification }
        } else {
          meta.verification = { provider: form.provider, baseURL: form.baseURL, model: form.model, ...liveVerification }
        }
        meta.ref = ref
        if (!meta.provider) {
          meta.provider = form.provider
          meta.baseURL = form.baseURL
          meta.model = form.model
        }
        await writeMeta(meta).catch(() => {})
      } else {
        liveVerification = { ok: false, message: '凭据库里有记录，但读不出值。', hint: '重新填一次 key。' }
      }
    }
    const effectiveVerification = liveVerification ?? verification
    const toolInfo = await trialStatusInfo(status, sessionId)
    const modelOk = Boolean(form.provider && form.model)
    const modelWritten = Boolean(patchDefault?.provider && patchDefault?.model)
    const modelInherited = inherited.source === 'host'

    const environment = [
      {
        id: 'host',
        label: '宿主会话服务',
        ok: typeof getSessionController?.() === 'object' && getSessionController?.() !== null,
        value: getSessionController?.() ? '已就绪' : '不可用',
        hint: getSessionController?.() ? null : '这个宿主没有挂载 sessionController；需要一个带会话能力的 Web profile。',
        action: { kind: 'retry', label: '点这里处理' },
      },
      {
        id: 'plugin',
        label: '插件版本',
        ok: typeof version === 'string' && version.length > 0,
        value: version || '未知',
        hint: null,
        action: null,
      },
      {
        id: 'tools',
        label: '工具注册',
        ok: toolInfo.ok,
        value: toolInfo.value,
        hint: toolInfo.hint,
        action: toolInfo.ok ? null : { kind: 'retry', label: '点这里处理' },
      },
      {
        id: 'model',
        label: '当前模型',
        ok: modelOk,
        value: hostModel?.provider && hostModel?.model
          ? `${hostModel.provider} / ${hostModel.model}`
          : (modelOk ? `${form.provider} / ${form.model}` : '未配置'),
        hint: modelOk ? null : '还没有读到默认模型；下一步填写即可。',
        action: modelOk ? null : { kind: 'step', step: 2, label: '点这里处理' },
      },
      {
        id: 'config',
        label: '配置文件',
        ok: profile.ok && writable.ok,
        value: profile.ok ? profile.patchPath : '未知位置',
        hint: profile.ok ? (writable.ok ? null : writable.reason) : profile.reason,
        action: profile.ok && writable.ok ? null : { kind: 'retry', label: '点这里处理' },
      },
      {
        id: 'key',
        label: 'API key',
        ok: keyInfo.configured && (effectiveVerification?.ok !== false),
        value: keyInfo.configured
          ? `${keyMask ?? '已保存（内容不可回读）'} · ${effectiveVerification?.ok === true ? '已验证' : effectiveVerification?.ok === false ? '未通过' : '未验证'}`
          : '未配置',
        hint: keyInfo.configured
          ? (effectiveVerification?.ok === false ? effectiveVerification.message : null)
          : '在这一步填一次 key；它只会写进宿主凭据库。',
        action: keyInfo.configured && effectiveVerification?.ok !== false
          ? null
          : { kind: 'step', step: 2, label: '点这里处理' },
      },
    ]

    return {
      environment,
      needsSetup: !keyInfo.configured || !modelOk || !(modelWritten || modelInherited) || !profile.ok || !writable.ok,
      provider: form.provider,
      baseURL: form.baseURL,
      model: form.model,
      inheritedFrom: inherited.source,
      defaults: { ...WIZARD_DEFAULTS },
      key: {
        ref,
        configured: keyInfo.configured,
        writable: keyInfo.writable,
        available: keyInfo.available,
        source: keyInfo.source,
        mask: keyMask,
        verified: effectiveVerification?.ok === true,
        verification: effectiveVerification,
      },
      profile: profile.ok
        ? { name: profile.name, dir: profile.dir, patchPath: profile.patchPath, writable: writable.ok }
        : { name: null, dir: null, patchPath: null, writable: false, reason: profile.reason },
      backups: (meta.backups ?? []).map(entry => ({
        id: entry.id,
        createdAt: entry.createdAt,
        summary: Array.isArray(entry.summary) ? entry.summary : [],
      })),
      lastTrial: meta.lastTrial ?? null,
      version,
    }
  }

  function addUsage(usage, recorded, source) {
    if (!recorded || typeof recorded !== 'object') return
    const inputTokens = Number(recorded.inputTokens) || 0
    const outputTokens = Number(recorded.outputTokens) || 0
    if (inputTokens === 0 && outputTokens === 0) return
    usage.inputTokens += inputTokens
    usage.outputTokens += outputTokens
    usage.cacheReadTokens += Number(recorded.cacheReadTokens) || 0
    usage.totalTokens += Number(recorded.totalTokens) || inputTokens + outputTokens
    usage.modelCalls += 1
    if (source?.kind === 'model') {
      const key = `${source.provider ?? '?'}/${source.model ?? '?'}`
      const entry = usage.models[key] ?? (usage.models[key] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        calls: 0,
      })
      entry.inputTokens += inputTokens
      entry.outputTokens += outputTokens
      entry.cacheReadTokens += Number(recorded.cacheReadTokens) || 0
      entry.calls += 1
    }
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  function currentSelection() {
    try {
      const selection = getDefaultModel?.()
      if (!selection || typeof selection !== 'object') return null
      return {
        provider: typeof selection.provider === 'string' ? selection.provider : null,
        model: typeof selection.model === 'string' ? selection.model : null,
      }
    } catch {
      return null
    }
  }

  // The patch layer hot-reloads, but a session created in the same tick can
  // still see the old provider. Wait until the host reports the model we just
  // wrote so the trial is not a race.
  async function waitForConfiguredModel(timeoutMs = 4000) {
    const meta = await readMeta().catch(() => ({}))
    if (!meta.provider || !meta.model) return true
    const matches = selection =>
      selection?.provider === meta.provider && selection?.model === meta.model
    if (matches(currentSelection())) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(150)
      if (matches(currentSelection())) return true
    }
    return false
  }

  async function runTrial() {
    const session = getSessionController?.()
    if (!session || typeof session.create !== 'function' || typeof session.prompt !== 'function' || typeof session.follow !== 'function') {
      throw new WorkbenchError(503, '宿主没有可用的会话服务，没法试跑。', {
        id: 'trial-unavailable',
        hint: '先让宿主的 sessionController 正常工作，再打开向导。',
      })
    }
    let dir
    let sessionId = null
    let created
    await waitForConfiguredModel()
    try {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-superagent-wizard-'))
      created = await session.create({ cwd: dir })
      sessionId = created?.sessionId ?? null
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionController.create returned no sessionId')
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new WorkbenchError(502, `试跑没能建立临时会话：${messageOf(error)}`, {
        id: 'trial-session-failed',
        hint: '先在对话页发一句话确认会话能启动，再回来试跑。',
      })
    }

    const startedAt = Date.now()
    const controller = new AbortController()
    const events = []
    let readError = null
    let timedOut = false
    let turnEnded = false
    const loop = (async () => {
      try {
        for await (const frame of session.follow({
          address: { kind: 'session', sessionId },
          assistantStream: false,
        }, controller.signal)) {
          if (frame?.type !== 'event' || !frame.event) continue
          events.push(frame.event)
          if (frame.event.type === 'turn/end') {
            turnEnded = true
            break
          }
        }
      } catch (error) {
        if (error?.name !== 'AbortError') readError = error
      }
    })()
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, TRIAL_TIMEOUT_MS)
    timer.unref?.()
    let promptError = null
    try {
      await session.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: TRIAL_PROMPT }],
      }, controller.signal)
      await Promise.race([
        loop,
        new Promise(resolve => {
          const wait = setTimeout(resolve, TRIAL_TIMEOUT_MS + 1_000)
          wait.unref?.()
        }),
      ])
    } catch (error) {
      promptError = error
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    await loop.catch(() => {})

    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      modelCalls: 0,
      models: {},
    }
    const subtasks = []
    const byCallId = new Map()
    let assistantText = ''
    let reason = null
    for (const event of events) {
      const data = event?.data && typeof event.data === 'object' ? event.data : {}
      if (event.type === 'tool/call') {
        const step = {
          index: subtasks.length + 1,
          title: typeof data.name === 'string' ? data.name : 'tool',
          detail: summarizeArgs(data.arguments),
          status: 'running',
        }
        subtasks.push(step)
        if (typeof data.callId === 'string') byCallId.set(data.callId, step)
      } else if (event.type === 'tool/result') {
        const callId = data.callId ?? data.message?.toolCallId ?? data.message?.source?.callId
        const step = byCallId.get(callId)
        if (step) {
          step.status = data.message?.isError === true ? 'failed' : 'completed'
          const text = contentText(data.message?.content).slice(0, 500)
          if (text) step.detail = text
        }
      } else if (event.type === 'assistant/message') {
        assistantText += contentText(data.message?.content)
        addUsage(usage, data.usage, data.message?.source)
      } else if (event.type === 'turn/end') {
        reason = data.reason?.kind ?? 'ended'
      }
    }

    let file = { name: TRIAL_FILE, exists: false, bytes: 0, preview: null, verified: false }
    try {
      const content = await fsp.readFile(path.join(dir, TRIAL_FILE), 'utf8')
      file = {
        name: TRIAL_FILE,
        exists: true,
        bytes: Buffer.byteLength(content),
        preview: content.slice(0, 200),
        verified: content.trim().toLowerCase().includes('ok'),
      }
    } catch {
      // Missing file is reported, never invented.
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})

    const cost = computeCost(usage, pricing)
    const costView = cost
      ? {
        text: formatMoney(cost),
        complete: cost.complete === true,
        unpriced: Array.isArray(cost.unpriced) ? cost.unpriced : [],
      }
      : null
    const failed = Boolean(readError || promptError) || reason === 'error'
    const ok = file.verified && !failed && !timedOut
    let hint = null
    if (!ok) {
      if (timedOut) {
        hint = '试跑超过 120 秒没有结束。可能是模型端点在排队或网络很慢；可以重试，或先在对话页发一句话确认模型能响应。'
      } else if (promptError || readError) {
        hint = `模型调用失败：${messageOf(promptError ?? readError)}。回到第 2 步检查 key、地址和模型名。`
      } else if (!file.exists) {
        hint = '模型回复了，但没有在临时目录创建约定文件。可以让它重试，或到对话页看看工具是否可用。'
      } else if (!file.verified) {
        hint = `文件创建了，但内容不是约定的 ok（读到：${file.preview ?? '空'}）。`
      } else if (failed) {
        hint = `这一轮以 ${reason ?? '异常'} 结束，文件虽然存在，但状态不算成功。`
      }
    }
    const result = {
      ok,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      sessionId,
      reason,
      timedOut,
      message: assistantText.trim().slice(0, 800),
      subtasks,
      file,
      usage,
      cost: costView,
      hint,
    }
    const meta = await readMeta()
    meta.lastTrial = {
      at: result.at,
      ok: result.ok,
      tokens: usage.totalTokens,
      cost: costView?.text ?? null,
      subtasks: subtasks.length,
      elapsedMs: result.elapsedMs,
    }
    await writeMeta(meta).catch(error => log(`wizard: cannot record the trial result: ${messageOf(error)}`))
    return result
  }

  async function trial() {
    if (trialInFlight) {
      throw new WorkbenchError(409, '试跑已经在进行，等它结束再看结果。', { id: 'trial-busy' })
    }
    trialInFlight = runTrial()
    try {
      return await trialInFlight
    } finally {
      trialInFlight = null
    }
  }

  return { status, preview, save, rollback, trial }
}
