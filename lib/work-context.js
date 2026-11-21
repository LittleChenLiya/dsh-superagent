const MAX_FACTS = 1200
const DAY = 24 * 60 * 60 * 1000
const compact = (text, limit) => String(text ?? '').trim().replace(/\s+/gu, ' ').slice(0, limit)
const normalized = text => compact(text, 500).normalize('NFKC').toLowerCase()

function factKey(fact) {
  return JSON.stringify([fact.project ?? null, fact.taskId, fact.kind, fact.key])
}

/** Latest confirmed values only. A tombstone or an expiry never revives an older value. */
export function currentFacts(records, at = Date.now()) {
  return [...new Map((records ?? []).map(record => [factKey(record), record])).values()]
    .filter(record => !record.revoked && (!record.expiresAt || record.expiresAt > at))
}

export function putFact(state, proposal, command) {
  const records = state.facts ??= []
  const prior = records.findLast(fact => factKey(fact) === factKey(proposal))
  records.push({ ...proposal, id: command.id, source: 'user-message',
    confirmedAt: command.at, ...(prior ? { replaces: prior.id } : {}) })
  state.facts = records.slice(-MAX_FACTS)
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
      phaseId: item.phaseId, answeredAt: item.answeredAt }))
}

export function confirmedDecisions(task, facts) {
  if (!task) return []
  const saved = facts.filter(fact => fact.kind === 'decision' && fact.taskId === task.id && fact.project === task.project)
  return [...(task.confirmedDecisions ?? answeredDecisions(task)).map(item => ({
    subject: item.question, value: item.answer, confirmedAt: item.answeredAt, source: 'task-answer', sourceId: item.id,
    phaseId: item.phaseId,
  })), ...saved.map(item => ({
    subject: item.subject, value: item.value, confirmedAt: item.confirmedAt, source: item.source, sourceId: item.id,
  }))].sort((left, right) => Number(new Date(left.confirmedAt)) - Number(new Date(right.confirmedAt))).slice(-6)
}

function exactTargets(text, work) {
  const ref = normalized(text)
  return work.tasks.filter(task => namesOf(task, work.aliases).some(name => normalized(name) === ref))
}

function targetQuestion(ref, matches) {
  return { action: 'clarify', text: matches.length ? `有 ${matches.length} 项工作叫「${ref}」。请选择工作区或使用任务编号。`
    : `找不到「${ref}」。请使用任务名称、别名或编号。`, taskIds: matches.slice(0, 4).map(task => task.id) }
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
    const fact = { project: task.project, taskId: task.id, kind: alias ? 'alias' : 'decision',
      key: normalized(subject), subject, value, revoked, expiresAt: days ? input.at + Number(days) * DAY : null }
    return { action: 'save-fact', project: task.project, target: task.id, fact }
  }

  const read = text.match(/^\/(状态|方案)\s+([^\r\n]+)$/u)
    ?? text.match(/^(.{1,90}?)(?:现在)?(?:到哪了|进展如何)[？?。]?$/u)
  const decisionRead = !read && text.match(/^(.{1,90}?)(?:的)?(?:当前方案|定了什么方案)[？?。]?$/u)
  if (!read && !decisionRead) return null
  const slash = text.startsWith('/')
  const ref = (slash ? read[2] : (read ?? decisionRead)[1]).trim()
  const matches = exactTargets(ref, work)
  if (!matches.length && !slash) return null
  if (matches.length !== 1) return targetQuestion(ref, matches)
  const task = matches[0]
  return { action: decisionRead || (slash && read[1] === '方案') ? 'facts' : 'status',
    target: task.id, project: task.project, text: ref }
}
