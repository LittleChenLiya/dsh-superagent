const MAX_FACTS = 2000
const DAY = 24 * 60 * 60 * 1000
const compact = (text, limit) => String(text ?? '').trim().replace(/\s+/gu, ' ').slice(0, limit)
const normalized = text => compact(text, 500).normalize('NFKC').toLowerCase()

/**
 * Facts are the durable half of the work graph. One record ties a workspace
 * (`project`), a task and optionally a phase to a subject/value pair, and says
 * who put it there:
 *
 * - `origin: 'user'` — an explicit confirmation or withdrawal by the person.
 * - `origin: 'run'` — an observation copied from a finished run (evidence).
 * - `origin: 'external'` — an event delivered by GitHub or Feishu.
 *
 * External text and model suggestions are stored as data (`value`), never as
 * instructions. Only an explicit user action can confirm or revoke a decision.
 */
export const SCHEMA_VERSION = 2

export function factKey(fact) {
  return JSON.stringify([fact.project ?? null, fact.taskId, fact.phaseId ?? null, fact.kind, fact.key])
}

/** Latest confirmed values only. A tombstone or an expiry never revives an older value. */
export function currentFacts(records, at = Date.now()) {
  return [...new Map((records ?? []).map(record => [factKey(record), record])).values()]
    .filter(record => !record.revoked && (!record.expiresAt || record.expiresAt > at))
}

function validFromOf(fact) {
  return fact.validFrom ?? fact.confirmedAt ?? fact.observedAt ?? null
}

/** All facts that currently apply to one task, optionally narrowed to a phase. */
export function activeFacts(records, { project, taskId, phaseId = null, kinds = null, at = Date.now() } = {}) {
  return currentFacts(records, at).filter(fact => fact.taskId === taskId
    && (project === undefined || fact.project === project)
    && (!phaseId || fact.phaseId === phaseId)
    && (!kinds || kinds.includes(fact.kind)))
}

/** Old state files load as-is; this migration is idempotent, so a retry is safe. */
export function migrateState(state, options = {}) {
  if (!state || typeof state !== 'object') return false
  let changed = false
  if (state.version !== SCHEMA_VERSION) {
    state.version = SCHEMA_VERSION
    changed = true
  }
  const facts = Array.isArray(state.facts) ? state.facts : []
  for (const fact of facts) {
    if (!fact.origin) {
      fact.origin = fact.source === 'run' || fact.source === 'run-observed'
        ? 'run' : fact.source === 'external' ? 'external' : 'user'
      changed = true
    }
    if (fact.validFrom === undefined) {
      fact.validFrom = validFromOf(fact)
      changed = true
    }
  }
  state.facts = facts.slice(-MAX_FACTS)
  if (!state.outcomes || typeof state.outcomes !== 'object') {
    state.outcomes = {}
    changed = true
  }
  if (!state.phaseOutcomes || typeof state.phaseOutcomes !== 'object') {
    state.phaseOutcomes = {}
    // Only a state written by an older build needs the one-time backfill
    // boundary. A brand-new state starts after the boundary, so its first
    // finished phase still produces a receipt.
    state.phaseOutcomesSeeded = options.freshState === true
    changed = true
  }
  if (!state.metrics || typeof state.metrics !== 'object') {
    state.metrics = { classifyCalls: 0, clarifications: 0, receipts: 0, appends: 0, sourceEvents: 0 }
    changed = true
  }
  return changed
}

/**
 * Append one fact. The newest record for a key wins, so a correction needs no
 * special path. A withdrawal without a phase writes one tombstone per existing
 * variant of that key, so a phase-scoped value cannot survive it.
 */
export function putFact(state, proposal, command) {
  const records = state.facts ??= []
  const base = {
    source: 'user-message', origin: 'user', confirmedAt: command.at, validFrom: command.at,
    ...proposal, id: command.id,
  }
  if (base.revoked && !base.phaseId) {
    const keys = new Set(records
      .filter(record => record.project === base.project && record.taskId === base.taskId
        && record.kind === base.kind && record.key === base.key)
      .map(record => factKey(record)))
    keys.add(factKey(base))
    for (const key of keys) {
      const prior = records.findLast(record => factKey(record) === key)
      records.push({ ...base, phaseId: prior?.phaseId ?? null, ...(prior ? { replaces: prior.id } : {}) })
    }
  } else {
    const prior = records.findLast(record => factKey(record) === factKey(base))
    records.push({ ...base, ...(prior ? { replaces: prior.id } : {}) })
  }
  state.facts = records.slice(-MAX_FACTS)
  return state.facts
}

function namesOf(task, aliases) {
  return [task.id, task.title || task.goal, ...(aliases.get(task.id) ?? [])].filter(Boolean)
}

function mentions(text, name) {
  if (name.length < 2) return false
  let start = text.indexOf(name)
  while (start >= 0) {
    const end = start + name.length
    if ((!/^[a-z0-9]/i.test(name) || !/[a-z0-9]/i.test(text[start - 1] ?? ''))
      && (!/[a-z0-9]$/i.test(name) || !/[a-z0-9]/i.test(text[end] ?? ''))) return true
    start = text.indexOf(name, start + 1)
  }
  return false
}

/** The phase a message names, if any. A phase belongs to exactly one task. */
function phaseNamedIn(text, task) {
  const phases = (task?.phases ?? []).filter(phase => typeof phase.title === 'string' && phase.title.length > 1)
  return (phases.find(phase => mentions(normalized(text), normalized(phase.title))) ?? null)?.id ?? null
}

export function workingContext(catalog, command, state, at = Date.now()) {
  const tasks = catalog.tasks.filter(task => !task.phase && (!command.project || task.project === command.project))
  const facts = currentFacts(state.facts, at)
  const aliases = new Map()
  for (const fact of facts) {
    if (fact.kind !== 'alias') continue
    const task = tasks.find(candidate => candidate.id === fact.taskId && candidate.project === fact.project)
    if (!task) continue
    aliases.set(task.id, [...(aliases.get(task.id) ?? []), fact.value])
  }
  const explicit = tasks.filter(task => namesOf(task, aliases).some(name => mentions(normalized(command.text), normalized(name))))
  const recent = state.commands.slice(0, state.commands.findIndex(entry => entry.id === command.id))
    .findLast(entry => entry.done && entry.focusTaskId && entry.project === command.project && command.at - entry.at < 2 * DAY)
  const focus = recent && tasks.find(task => task.id === recent.focusTaskId)
  const followFocus = !explicit.length && /^(?:刚才(?:那个|那项|的任务|那件事)|上(?:一个|一项)(?:任务)?)[，、,:：\s]/u.test(command.text)
  return { tasks, facts, aliases, explicit, bound: explicit.length === 1 ? explicit[0] : followFocus ? focus : null }
}

export function answeredDecisions(task) {
  return (task.decisions ?? []).filter(item => item.answer && item.answeredAt)
    .slice(-8).map(item => ({ id: item.id, question: item.question, answer: item.answerText ?? item.answer,
      phaseId: item.phaseId, answeredAt: item.answeredAt, key: item.key ?? item.source?.key ?? null }))
}

export function confirmedDecisions(task, facts) {
  if (!task) return []
  const saved = facts.filter(fact => fact.kind === 'decision' && fact.taskId === task.id && fact.project === task.project)
  return [...(task.confirmedDecisions ?? answeredDecisions(task)).map(item => ({
    subject: item.question, value: item.answer, confirmedAt: item.answeredAt, source: 'task-answer', sourceId: item.id,
    phaseId: item.phaseId ?? null, key: item.key ?? null,
  })), ...saved.map(item => ({
    subject: item.subject, value: item.value, confirmedAt: item.confirmedAt, source: item.source, sourceId: item.id,
    phaseId: item.phaseId ?? null, origin: item.origin ?? 'user', validFrom: validFromOf(item),
    expiresAt: item.expiresAt ?? null, replaces: item.replaces ?? null,
  }))].sort((left, right) => Number(new Date(left.confirmedAt)) - Number(new Date(right.confirmedAt))).slice(-6)
}

/** Evidence copied back from finished runs and external events, newest first. */
export function taskEvidence(task, facts, at = Date.now()) {
  if (!task) return []
  return currentFacts(facts, at)
    .filter(fact => fact.taskId === task.id && fact.project === task.project
      && (fact.kind === 'evidence' || fact.kind === 'source'))
    .sort((left, right) => Number(new Date(validFromOf(left))) - Number(new Date(validFromOf(right))))
    .slice(-12)
    .map(fact => ({
      id: fact.id, kind: fact.kind, source: fact.source, origin: fact.origin ?? 'run',
      subject: compact(fact.subject, 80), value: compact(fact.value, 260),
      phaseId: fact.phaseId ?? null, at: validFromOf(fact), observedAt: fact.observedAt ?? null,
      sourceId: fact.sourceId ?? null, objectId: fact.payload?.objectId ?? null,
      payload: fact.payload ?? null,
    }))
}

/** Everything the task card needs, without exposing unrelated facts. */
export function taskContext(task, facts, at = Date.now()) {
  if (!task) return { taskId: null, aliases: [], decisions: [], evidence: [], sources: [] }
  const scoped = currentFacts(facts, at).filter(fact => fact.taskId === task.id && fact.project === task.project)
  return {
    taskId: task.id,
    aliases: scoped.filter(fact => fact.kind === 'alias').map(fact => fact.value).slice(-6),
    decisions: confirmedDecisions(task, scoped),
    evidence: taskEvidence(task, scoped),
    sources: scoped.filter(fact => fact.origin === 'external' || fact.kind === 'source')
      .slice(-6).map(fact => ({ id: fact.id, subject: compact(fact.subject, 80), value: compact(fact.value, 200),
        source: fact.source, sourceId: fact.sourceId ?? null, at: validFromOf(fact) })),
  }
}

/** Compare accepted phases with later changes to the inputs they depended on. */
export function taskImpact(task, facts, at = Date.now()) {
  const phases = task.phases ?? []
  const byId = new Map(phases.map(phase => [phase.id, phase]))
  const accepted = phases.filter(phase => phase.status === 'completed' && phase.finishedAt)
  const scoped = (facts ?? []).filter(fact => fact.taskId === task.id && fact.project === task.project)
  const previous = new Map()
  const changes = []
  for (const fact of scoped) {
    const key = factKey(fact)
    const prior = previous.get(key)
    previous.set(key, fact)
    const time = new Date(fact.observedAt ?? validFromOf(fact)).getTime()
    if (!Number.isFinite(time) || time > at) continue
    if (fact.kind === 'decision' && fact.origin === 'user'
      && (fact.revoked ? prior && !prior.revoked : !prior || prior.revoked || prior.value !== fact.value)) {
      changes.push({ time, phaseId: fact.phaseId,
        reason: `已确认的决定${fact.revoked ? '已撤回' : '有更新'}：${compact(fact.subject || fact.key, 80)}` })
    } else if (fact.kind === 'source' && fact.origin === 'external') {
      changes.push({ time, phaseId: fact.phaseId, reason: `绑定来源有更新：${compact(fact.subject, 80)}` })
    }
  }
  for (const phase of accepted) {
    changes.push({ time: Date.parse(phase.finishedAt), phaseId: phase.id, downstreamOnly: true,
      reason: `上游阶段重新验收：${phase.title}` })
  }
  const reReview = []
  const canContinue = []
  for (const phase of accepted) {
    const upstream = new Set()
    const pending = [...(phase.dependsOn ?? [])]
    while (pending.length) {
      const id = pending.pop()
      if (upstream.has(id)) continue
      upstream.add(id)
      pending.push(...(byId.get(id)?.dependsOn ?? []))
    }
    const finished = Date.parse(phase.finishedAt)
    const change = changes.filter(item => item.time > finished && item.time <= at
      && (!item.phaseId || upstream.has(item.phaseId) || (!item.downstreamOnly && item.phaseId === phase.id)))
      .sort((left, right) => right.time - left.time)[0]
    const entry = { phaseId: phase.id, title: phase.title, runId: phase.runId ?? null }
    if (change) reReview.push({ ...entry, reason: change.reason, changedAt: new Date(change.time).toISOString() })
    else canContinue.push(entry)
  }
  return reReview.length ? { reReview, canContinue } : null
}

function exactTargets(text, work) {
  const ref = normalized(text)
  return work.tasks.filter(task => namesOf(task, work.aliases).some(name => normalized(name) === ref))
}

function targetQuestion(ref, matches) {
  return { action: 'clarify', text: matches.length ? `有 ${matches.length} 项工作叫「${ref}」。请选择工作区或使用任务编号。`
    : `找不到「${ref}」。请使用任务名称、别名或编号。`, taskIds: matches.slice(0, 4).map(task => task.id) }
}

const ASK_FOR_DECISIONS = /(?:哪些|有什么|还有什么|有没有)(?:事|任务|地方)?(?:还)?(?:需要|要)我(?:来)?(?:决定|拍板|定)|(?:需要|要)我(?:决定|拍板|定)的(?:事|任务|地方)|哪些(?:事|任务)需要(?:决定|拍板)/u

/** A read-only question: name the pending decisions and their options, nothing else. */
export function asksForDecisions(text) {
  return ASK_FOR_DECISIONS.test(String(text ?? ''))
}

function parseWrite(text) {
  const command = text.match(/^\/(别名|决定|撤销决定|撤销别名)\s+([^\r\n]+)$/u)
  if (command) return { operation: command[1], parts: command[2].split('|').map(part => part.trim()) }
  const alias = text.match(/^把(.{1,90}?)叫做[「“]?([^「」“”！？?。]{2,40}?)[」”]?[。]?$/u)
  if (alias) return { operation: '别名', parts: alias.slice(1) }
  const decision = text.match(/^记下\s*(.{1,90}?)的(.{1,60}?)[：:]\s*(.{1,420})$/u)
  if (decision) return { operation: '决定', parts: decision.slice(1) }
  return null
}

export function workAction(input, work) {
  const text = input.text
  const write = parseWrite(text)
  if (write) {
    const { operation, parts } = write
    const alias = operation.endsWith('别名')
    const revoked = operation.startsWith('撤销')
    const [ref, rawSubject, rawValue, rawExpiry] = parts
    const expiry = alias ? rawValue : rawExpiry
    const days = expiry?.match(/^(\d{1,3})(?:d|天)$/u)?.[1]
    const subject = compact(rawSubject, 60)
    const value = alias ? subject : compact(rawValue, 420)
    if (!ref || !subject || (!revoked && !value) || (alias && subject.length < 2)
      || parts.length > (revoked ? 2 : alias ? 3 : 4)
      || (expiry && (!days || Number(days) < 1 || Number(days) > 365))) {
      return { action: 'clarify', text: '可用「/别名 任务 | 别名」或「/决定 任务 | 主题 | 已确认的内容」。最后可加「| 7天」。' }
    }
    const matches = exactTargets(ref, work)
    if (matches.length !== 1) return targetQuestion(ref, matches)
    const task = matches[0]
    if (alias && !revoked && exactTargets(subject, work).some(other => other.project === task.project && other.id !== task.id)) {
      return { action: 'clarify', text: '这个别名在当前工作区已指向另一项任务，请换一个。' }
    }
    // A decision that names a phase belongs to that phase. Without a phase it
    // applies to the task, and only that scope reaches the execution line.
    const phaseId = !alias && task.phases?.length ? phaseNamedIn(text, task) : null
    const fact = { project: task.project, taskId: task.id, kind: alias ? 'alias' : 'decision',
      key: normalized(subject), subject, value, revoked, phaseId,
      expiresAt: days ? input.at + Number(days) * DAY : null }
    return { action: 'save-fact', project: task.project, target: task.id, fact }
  }

  const read = text.match(/^\/(状态|方案|证据)\s+([^\r\n]+)$/u)
    ?? text.match(/^(.{1,90}?)(?:现在)?(?:到哪了|进展如何)[？?。]?$/u)
  const decisionRead = !read && text.match(/^(.{1,90}?)(?:的)?(?:当前方案|定了什么方案)[？?。]?$/u)
  if (!read && !decisionRead) return null
  const slash = text.startsWith('/')
  const ref = (slash ? read[2] : (read ?? decisionRead)[1]).trim()
  const matches = exactTargets(ref, work)
  if (!matches.length && !slash) return null
  if (matches.length !== 1) return targetQuestion(ref, matches)
  const task = matches[0]
  const action = read && slash && read[1] === '证据' ? 'evidence'
    : decisionRead || (slash && read[1] === '方案') ? 'facts' : 'status'
  return { action, target: task.id, project: task.project, text: ref }
}
