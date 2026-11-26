/**
 * Read-only notification aggregation.
 *
 * Runs, goals, approvals and artifact descriptors are supplied by the caller;
 * this module neither owns their state nor starts work. Every inbox entry and
 * daily brief is derived from one snapshot, so there is no model call, delivery
 * side effect, or second task-status store to drift out of sync.
 *
 * @module dsh-superagent/notification-center
 */
import { createHash } from 'node:crypto'
import { localToEpoch, zonedParts } from './cron.js'
import {
  DEFAULT_NOTIFY_PREFERENCES,
  NOTIFICATION_EVENTS,
  validateNotifyPreferences,
} from './notify-preferences.js'

const COMPLETED_STATUSES = new Set(['completed', 'partial'])
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'interrupted', 'stopped', 'budget-stopped'])
const PENDING_APPROVAL_STATUSES = new Set(['pending', 'waiting', 'requested', 'open'])
const CLOSED_APPROVAL_STATUSES = new Set([
  'approved', 'allowed', 'allowed-once', 'rejected', 'denied', 'cancelled',
  'expired', 'resolved', 'answered', 'closed',
])
const TERMINAL_GOAL_STATUSES = new Set([
  'completed', 'partial', 'failed', 'cancelled', 'stopped', 'budget-stopped',
])

function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function epoch(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(new Date(value).getTime()) ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clockValue(value = () => Date.now()) {
  const at = epoch(typeof value === 'function' ? value() : value)
  if (at === null) throw new TypeError('notification center now must be a valid date or epoch millisecond value')
  return at
}

function iso(at) {
  return at === null ? null : new Date(at).toISOString()
}

function localDate(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function nextCivilDay(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/**
 * All real instants for one local wall-clock minute. Usually there is one;
 * during a fall-back transition there can be two. Offsets are sampled through
 * Intl around the requested day, avoiding private offset APIs while handling
 * spring-forward gaps and unusual date-line offset changes.
 */
function localTimeCandidates(parts, hour, minute, timeZone) {
  const wanted = { ...parts, hour, minute }
  const desired = Date.UTC(wanted.year, wanted.month - 1, wanted.day, hour, minute)
  const matches = candidate => {
    const actual = zonedParts(candidate, timeZone)
    return actual.year === wanted.year && actual.month === wanted.month && actual.day === wanted.day
      && actual.hour === hour && actual.minute === minute && actual.second === 0
  }
  const found = new Set()
  const midpoint = localToEpoch(wanted, timeZone)
  if (midpoint !== null && matches(midpoint)) found.add(midpoint)
  const offsets = new Set()
  for (let delta = -30; delta <= 30; delta++) {
    const actual = zonedParts(desired + delta * 3_600_000, timeZone)
    offsets.add(Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
      - (desired + delta * 3_600_000))
  }
  for (const offset of offsets) {
    const candidate = desired - offset
    if (matches(candidate)) found.add(candidate)
  }
  return [...found].sort((left, right) => left - right)
}

/** First real instant of a local calendar day, including zones that skip midnight. */
function localDayStart(parts, timeZone) {
  for (let minute = 0; minute < 24 * 60; minute++) {
    const at = localToEpoch({ ...parts, hour: Math.floor(minute / 60), minute: minute % 60 }, timeZone)
    if (at !== null && localDate(zonedParts(at, timeZone)) === localDate(parts)) return at
  }
  return null
}

function dayWindow(at, timeZone) {
  const parts = zonedParts(at, timeZone)
  const start = localDayStart(parts, timeZone)
  let next = nextCivilDay(parts)
  let end = localDayStart(next, timeZone)
  // A whole civil date can disappear after a time-zone rule change. Move to the
  // next date that exists instead of looping on a non-existent midnight.
  for (let attempt = 0; end === null && attempt < 3; attempt++) {
    next = nextCivilDay(next)
    end = localDayStart(next, timeZone)
  }
  if (start === null || end === null) throw new RangeError(`cannot resolve a daily brief window in ${timeZone}`)
  return { date: localDate(parts), start, end }
}

function preferencesOf(input) {
  return validateNotifyPreferences(input === undefined ? DEFAULT_NOTIFY_PREFERENCES : input)
}

function looksLikeQuietHours(value) {
  return Boolean(value && typeof value === 'object'
    && ('enabled' in value || 'start' in value || 'end' in value || 'quietHours' in value))
}

/**
 * Whether an instant falls in the configured quiet window.
 *
 * The window is start-inclusive and end-exclusive. When start is later than
 * end it crosses midnight. An event named in `except` is never quieted.
 *
 * @param {number|string|Date} at instant to test
 * @param {object} quietHours quiet-hours object (a full preference object is also accepted)
 * @param {string} [event] notification event, used for `except`
 * @returns {boolean}
 */
export function isQuietHours(at, quietHours = DEFAULT_NOTIFY_PREFERENCES.quietHours, event = null) {
  // Also accept (quietHours, at, event), useful when wiring a config object
  // directly into a scheduler without a wrapper.
  if (looksLikeQuietHours(at) && !looksLikeQuietHours(quietHours)) [at, quietHours] = [quietHours, at]
  const millis = clockValue(at)
  const source = quietHours?.quietHours ?? quietHours ?? DEFAULT_NOTIFY_PREFERENCES.quietHours
  const config = validateNotifyPreferences({ quietHours: source }).quietHours
  if (!config.enabled || (event && config.except.includes(event))) return false
  const parts = zonedParts(millis, config.timeZone)
  const minute = parts.hour * 60 + parts.minute
  const [startHour, startMinute] = config.start.split(':').map(Number)
  const [endHour, endMinute] = config.end.split(':').map(Number)
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  return start < end ? minute >= start && minute < end : minute >= start || minute < end
}

/**
 * Next enabled daily-brief instant, strictly after `after`.
 *
 * The result is an ISO string (or null when briefs are disabled), ready to
 * persist or return from an HTTP API. As with cron.js, a wall-clock time that
 * does not exist on a spring-forward day is skipped rather than invented.
 *
 * @param {number|string|Date} after
 * @param {object} dailyBrief daily-brief object (a full preference object is also accepted)
 * @returns {string|null}
 */
export function nextBriefTime(after, dailyBrief = DEFAULT_NOTIFY_PREFERENCES.dailyBrief) {
  if (looksLikeQuietHours(after) && !looksLikeQuietHours(dailyBrief)) [after, dailyBrief] = [dailyBrief, after]
  const millis = clockValue(after)
  const source = dailyBrief?.dailyBrief ?? dailyBrief ?? DEFAULT_NOTIFY_PREFERENCES.dailyBrief
  const config = validateNotifyPreferences({ dailyBrief: source }).dailyBrief
  if (!config.enabled) return null
  const [hour, minute] = config.time.split(':').map(Number)
  let parts = zonedParts(millis, config.timeZone)
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = localTimeCandidates(parts, hour, minute, config.timeZone).find(value => value > millis)
    if (candidate !== undefined) return iso(candidate)
    parts = nextCivilDay(parts)
  }
  return null
}

/** Epoch-millisecond companion for timer APIs. */
export function nextBriefTimeMs(after, dailyBrief) {
  const next = nextBriefTime(after, dailyBrief)
  return next === null ? null : Date.parse(next)
}

function actionableAttention(run, item) {
  if (!item || item.answer) return false
  if (!run?.origin?.routed) return true
  if (item.handoff || item.source === 'workspace-merge') return true
  if (item.source === 'planner') return false
  const blocker = item.blocker
  if (!blocker || !['user-fact', 'user-choice'].includes(blocker.type)) return false
  if (typeof blocker.checked !== 'string' || typeof blocker.consequence !== 'string') return false
  return blocker.type === 'user-fact' || new Set(arrayOf(item.options)).size >= 2
}

function sessionOf(record) {
  return text(record?.ownerSessionId) || text(record?.parentSessionId) || null
}

function titleOf(record) {
  return text(record?.title) || text(record?.goal) || text(record?.name) || text(record?.id, 'Untitled task')
}

function notification(id, event, fields) {
  return { id, event, at: fields.at ?? null, read: false, ...fields }
}

function taskNotifications(task, kind) {
  const id = text(task?.id)
  if (!id) return []
  const taskId = id
  const base = {
    taskId,
    taskKind: kind,
    sessionId: sessionOf(task),
    goalId: kind === 'goal' ? id : text(task?.origin?.goalId) || null,
    runId: kind === 'run' ? id : null,
    taskTitle: titleOf(task),
  }
  const created = epoch(task.createdAt)
  const finished = epoch(task.finishedAt) ?? epoch(task.updatedAt) ?? created
  const result = [notification(`${kind}:${id}:added`, 'added', {
    ...base, title: 'New task', body: titleOf(task), at: iso(created),
  })]
  if (COMPLETED_STATUSES.has(task.status)) {
    result.push(notification(`${kind}:${id}:completed`, 'completed', {
      ...base, title: 'Task completed', body: titleOf(task), at: iso(finished), status: task.status,
    }))
  } else if (FAILED_STATUSES.has(task.status)) {
    result.push(notification(`${kind}:${id}:failed`, 'failed', {
      ...base, title: 'Task needs attention', body: titleOf(task), at: iso(finished), status: task.status,
    }))
  }
  return result
}

function approvalPending(item, now) {
  if (!item || typeof item !== 'object') return false
  if (item.answer || item.decision || item.outcome || item.resolvedAt || item.answeredAt) return false
  const status = text(item.status).toLowerCase()
  if (CLOSED_APPROVAL_STATUSES.has(status) || (status && !PENDING_APPROVAL_STATUSES.has(status))) return false
  const expires = epoch(item.expiresAt)
  return expires === null || expires > now
}

function approvalNotification(item, now) {
  const id = text(item?.id)
  if (!id || !approvalPending(item, now)) return null
  const tool = text(item.toolName, 'Tool approval')
  const reason = text(item.reason) || text(item.question) || 'A tool is waiting for a decision.'
  return notification(`approval:${id}`, 'approval', {
    kind: 'approval',
    approvalId: id,
    sessionId: sessionOf(item),
    runId: text(item.runId) || null,
    title: tool,
    body: reason,
    question: text(item.question) || null,
    at: iso(epoch(item.askedAt) ?? epoch(item.createdAt)),
  })
}

function artifactNotification(item) {
  if (!item || typeof item !== 'object') return null
  const target = text(item.href) || text(item.path)
  const name = text(item.name) || target.split(/[\\/]/).filter(Boolean).pop() || ''
  if (!text(item.id) && !target && !name) return null
  name ||= 'Artifact'
  const identity = text(item.id) || `local-${createHash('sha256')
    .update(JSON.stringify([text(item.runId), target, name])).digest('hex').slice(0, 24)}`
  const runId = text(item.runId) || null
  return notification(`artifact:${identity}`, 'artifact', {
    kind: 'artifact',
    artifactId: identity,
    runId,
    sessionId: sessionOf(item),
    title: name,
    body: target || name,
    href: target || null,
    artifactKind: text(item.kind) || null,
    at: iso(epoch(item.at) ?? epoch(item.finishedAt) ?? epoch(item.createdAt)),
  })
}

function uniqueById(rows) {
  const byId = new Map()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id) continue
    const previous = byId.get(row.id)
    if (!previous || (epoch(row.at) ?? -Infinity) > (epoch(previous.at) ?? -Infinity)) byId.set(row.id, row)
  }
  return [...byId.values()]
}

function sortNotifications(rows) {
  return rows.sort((left, right) => (epoch(right.at) ?? -Infinity) - (epoch(left.at) ?? -Infinity)
    || left.id.localeCompare(right.id))
}

/**
 * Derive every notification from one authorised snapshot.
 *
 * A phase run whose `origin.goalId` names a supplied long goal is represented
 * by that goal, not counted again as an independent task. Internal planning
 * runs are omitted as well. Inputs are never mutated.
 *
 * @param {object} [input]
 * @param {object[]} [input.runs]
 * @param {object[]} [input.goals]
 * @param {object[]} [input.approvals]
 * @param {object[]} [input.artifacts]
 * @param {string[]|Set<string>} [input.readIds]
 * @param {number|string|Date|(() => number)} [input.now]
 * @returns {object[]} all activity, newest first
 */
export function collectNotifications({
  runs = [], goals = [], approvals = [], artifacts = [], now = () => Date.now(),
} = {}) {
  const at = clockValue(now)
  const goalRows = arrayOf(goals).filter(goal => goal && typeof goal === 'object')
  const goalIds = new Set(goalRows.map(goal => text(goal.id)).filter(Boolean))
  const goalStatuses = new Map(goalRows.map(goal => [text(goal.id), text(goal.status)]))
  const runRows = []
  const seenRuns = new Set()
  for (const run of arrayOf(runs)) {
    const runId = text(run?.id)
    if (!run || typeof run !== 'object' || !runId || seenRuns.has(runId)) continue
    seenRuns.add(runId)
    if (run.origin?.role !== 'decompose') runRows.push(run)
  }
  // If the goal record itself is unavailable, several phase runs still name
  // the same logical task. Pick one deterministic representative for task
  // lifecycle notices; unique attention questions from every phase remain.
  const phaseRepresentatives = new Map()
  for (const run of runRows) {
    const goalId = text(run.origin?.goalId)
    if (!goalId || goalIds.has(goalId)) continue
    const previous = phaseRepresentatives.get(goalId)
    const rank = run => epoch(run.finishedAt) ?? epoch(run.updatedAt) ?? epoch(run.createdAt) ?? -Infinity
    if (!previous || rank(run) > rank(previous)
      || (rank(run) === rank(previous) && text(run.id).localeCompare(text(previous.id)) < 0)) {
      phaseRepresentatives.set(goalId, run)
    }
  }
  const rows = []
  const seenGoals = new Set()
  const goalQuestionIds = new Map()
  const goalQuestionKeys = new Map()

  for (const goal of goalRows) {
    const goalId = text(goal.id)
    if (!goalId || seenGoals.has(goalId)) continue
    seenGoals.add(goalId)
    rows.push(...taskNotifications(goal, 'goal'))
    const bound = new Set()
    const keys = new Set()
    for (const decision of arrayOf(goal.decisions)) {
      if (!decision || decision.answer || decision.retiredAt) continue
      const id = text(decision.id)
      if (!id) continue
      if (decision.source?.attentionId) bound.add(`${text(decision.source.runId)}:${decision.source.attentionId}`)
      for (const link of arrayOf(decision.linked)) {
        if (link?.runId && link?.attentionId) bound.add(`${text(link.runId)}:${text(link.attentionId)}`)
      }
      const key = text(decision.key) || text(decision.source?.key)
      if (key) keys.add(key)
      rows.push(notification(`goal:${goalId}:${id}`, 'decision', {
        kind: 'decision',
        taskId: goalId,
        taskKind: 'goal',
        goalId,
        sessionId: sessionOf(goal),
        title: titleOf(goal),
        body: text(decision.question) || text(decision.summary) || 'A decision is required.',
        question: text(decision.question) || null,
        options: arrayOf(decision.options).map(String),
        decisionId: id,
        at: iso(epoch(decision.createdAt) ?? epoch(goal.updatedAt) ?? epoch(goal.createdAt)),
      }))
    }
    goalQuestionIds.set(goalId, bound)
    goalQuestionKeys.set(goalId, keys)
  }

  for (const run of runRows) {
    const runId = text(run.id)
    const originGoalId = text(run.origin?.goalId)
    const representedByGoal = Boolean(originGoalId && goalIds.has(originGoalId))
    const representsPhase = phaseRepresentatives.get(originGoalId) === run
    if (!representedByGoal && (!originGoalId || representsPhase)) rows.push(...taskNotifications(run, 'run'))
    if (run.status === 'cancelled' || TERMINAL_GOAL_STATUSES.has(goalStatuses.get(originGoalId))) continue
    for (const item of arrayOf(run.attention?.items)) {
      if (!actionableAttention(run, item)) continue
      const id = text(item.id)
      if (!id) continue
      if (originGoalId && goalQuestionIds.get(originGoalId)?.has(`${runId}:${id}`)) continue
      const key = text(item.key)
      if (key && goalQuestionKeys.get(originGoalId)?.has(key)) continue
      rows.push(notification(`run:${runId}:${id}`, 'decision', {
        kind: 'decision',
        taskId: runId,
        taskKind: 'run',
        goalId: originGoalId || null,
        runId,
        sessionId: sessionOf(run),
        title: titleOf(run),
        body: text(item.question) || 'A decision is required.',
        question: text(item.question) || null,
        options: arrayOf(item.options).map(String),
        decisionId: id,
        at: iso(epoch(item.askedAt) ?? epoch(run.attention?.at) ?? epoch(run.updatedAt) ?? epoch(run.createdAt)),
      }))
    }
  }

  for (const approval of arrayOf(approvals)) {
    const row = approvalNotification(approval, at)
    if (row) rows.push(row)
  }
  for (const artifact of arrayOf(artifacts)) {
    const row = artifactNotification(artifact)
    if (row) rows.push(row)
  }
  return sortNotifications(uniqueById(rows))
}

function readSet(readIds) {
  return new Set(readIds instanceof Set
    ? [...readIds].filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
    : arrayOf(readIds).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))
}

function inboxRows(notifications, preferences, readIds) {
  if (!preferences.channels.includes('inbox')) return []
  return notifications.filter(item => {
    const mode = preferences.events[item.event]
    return mode === 'inbox' || mode === 'both'
  }).map(item => ({ ...item, read: readIds.has(item.id), mode: preferences.events[item.event] }))
}

/** Build the inbox projection, including read flags but never mutating readIds. */
export function buildInbox(input = {}) {
  const preferences = preferencesOf(input.preferences)
  const readIds = readSet(input.readIds)
  return inboxRows(collectNotifications(input), preferences, readIds)
}

function emptySummary() {
  return { added: 0, completed: 0, failed: 0, decisions: 0, approvals: 0, artifacts: 0, needsDecision: 0 }
}

function briefSummary(items) {
  const summary = emptySummary()
  for (const item of items) {
    if (item.event === 'decision') summary.decisions++
    else if (item.event === 'approval') summary.approvals++
    else if (item.event === 'artifact') summary.artifacts++
    else if (Object.hasOwn(summary, item.event)) summary[item.event]++
  }
  summary.needsDecision = summary.decisions + summary.approvals
  return summary
}

function briefText(date, summary, items) {
  const lines = [
    `Daily brief — ${date}`,
    `Added ${summary.added}; completed ${summary.completed}; failed ${summary.failed}; `
      + `need decision ${summary.needsDecision}; artifacts ${summary.artifacts}.`,
  ]
  for (const item of items) {
    const label = item.event === 'decision' || item.event === 'approval' ? 'Decision' : item.event
    lines.push(`- [${label}] ${item.title}${item.body && item.body !== item.title ? `: ${item.body}` : ''}`)
  }
  if (items.length === 0) lines.push('No notification activity in this period.')
  return lines.join('\n')
}

/**
 * Generate a deterministic brief for the local day containing `now` (or the
 * optional `date` instant). The brief includes activity even when an event's
 * inbox mode is off; its own channels control whether it is delivered.
 */
export function buildDailyBrief(input = {}) {
  const preferences = preferencesOf(input.preferences)
  if (!preferences.dailyBrief.enabled) return null
  const at = clockValue(input.now)
  const requested = input.date === undefined ? at : clockValue(input.date)
  const window = dayWindow(requested, preferences.dailyBrief.timeZone)
  const notifications = collectNotifications({ ...input, now: at })
  const readIds = readSet(input.readIds)
  const items = notifications.filter(item => {
    const itemAt = epoch(item.at)
    return itemAt !== null && itemAt >= window.start && itemAt < window.end
  }).map(item => ({ ...item, read: readIds.has(item.id) }))
  const summary = briefSummary(items)
  return {
    id: `daily-brief:${window.date}`,
    date: window.date,
    timeZone: preferences.dailyBrief.timeZone,
    generatedAt: iso(at),
    nextAt: nextBriefTime(at, preferences.dailyBrief),
    channels: preferences.dailyBrief.channels.filter(channel => preferences.channels.includes(channel)),
    summary,
    items,
    text: briefText(window.date, summary, items),
  }
}

/**
 * Aggregate one snapshot into inbox and daily-brief API shapes.
 * `notifications` retains push-only events for a caller's delivery policy;
 * this pure function does not reserve hourly budget or send anything.
 */
export function aggregateNotificationCenter(input = {}) {
  const at = clockValue(input.now)
  const preferences = preferencesOf(input.preferences)
  const notifications = collectNotifications({ ...input, now: at })
  const readIds = readSet(input.readIds)
  const marked = notifications.map(item => ({ ...item, read: readIds.has(item.id) }))
  const inbox = inboxRows(marked, preferences, readIds)
  const dailyBrief = buildDailyBrief({ ...input, now: at })
  const window = dayWindow(at, preferences.dailyBrief.timeZone)
  const today = marked.filter(item => {
    const itemAt = epoch(item.at)
    return itemAt !== null && itemAt >= window.start && itemAt < window.end
  })
  return {
    generatedAt: iso(at),
    notifications: marked,
    inbox,
    dailyBrief,
    summary: briefSummary(today),
    unreadCount: inbox.filter(item => !item.read).length,
    quiet: isQuietHours(at, preferences.quietHours),
    nextBriefAt: nextBriefTime(at, preferences.dailyBrief),
  }
}

/** Common verb aliases for HTTP/tool adapters. */
export const generateInbox = buildInbox
export const generateDailyBrief = buildDailyBrief
export const collectNotificationCenter = aggregateNotificationCenter

export default {
  NOTIFICATION_EVENTS,
  isQuietHours,
  nextBriefTime,
  nextBriefTimeMs,
  collectNotifications,
  buildInbox,
  buildDailyBrief,
  aggregateNotificationCenter,
  generateInbox,
  generateDailyBrief,
  collectNotificationCenter,
}
