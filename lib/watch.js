/**
 * Live terminal panel for dsh-superagent.
 *
 * The panel is a pure renderer plus a poll loop: it reads the same durable run
 * files the host writes and draws one line per run, so it works from another
 * process, survives a host restart, and never needs IPC.
 *
 * Two questions matter more than the raw numbers: who is running beside whom,
 * and who is waiting on what. Overlapping runs therefore share a coloured
 * gutter label, and a waiting row leads with its cause (a full slot, a full
 * worker pool, or a retry backoff) before the ordinary activity phrase.
 *
 * There is no dependency here on purpose — the package is a zero-dependency
 * plugin, and a monitoring aid is not a reason to pull in an ANSI toolkit. The
 * escape sequences used are the small, stable subset: alternate screen, hide
 * cursor, cursor home, erase line, and SGR colours.
 *
 * @module dsh-superagent/watch
 */
import { ACTIVE_STATUSES, createStore, resolveStateRoot } from './store.js'

/** Refresh cadence. A run file is small, so one read per second is cheap. */
export const DEFAULT_INTERVAL_MS = 1000

/** Width of the concurrency gutter, including its trailing space. */
const GUTTER = 3

/** Gutter colours, one per overlapping group, cycled when there are many. */
const GROUP_COLORS = [6, 3, 5, 2, 4]

const STATUS_COLOR = {
  queued: 2,
  planning: 6,
  running: 6,
  aggregating: 6,
  completed: 2,
  partial: 3,
  failed: 1,
  cancelled: 5,
  interrupted: 3,
}

const STATUS_LABEL = {
  queued: 'queued',
  planning: 'planning',
  running: 'running',
  aggregating: 'aggregating',
  completed: 'completed',
  partial: 'partial',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
}

/** Medium-width labels, all within ten cells. */
const STATUS_MEDIUM = {
  queued: 'queued',
  planning: 'plan',
  running: 'running',
  aggregating: 'aggreg.',
  completed: 'done',
  partial: 'partial',
  failed: 'failed',
  cancelled: 'cancel',
  interrupted: 'interrupt',
}

/** Compact and narrow labels: the word is kept, vowels are not. */
const STATUS_SHORT = {
  queued: 'que',
  planning: 'plan',
  running: 'run',
  aggregating: 'agg',
  completed: 'done',
  partial: 'part',
  failed: 'FAIL',
  cancelled: 'cncl',
  interrupted: 'intr',
}

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  hide: '\u001b[?25l',
  show: '\u001b[?25h',
  altOn: '\u001b[?1049h',
  altOff: '\u001b[?1049l',
  home: '\u001b[H',
  clearLine: '\u001b[K',
  clearScreen: '\u001b[2J',
}

/**
 * Paint text only when colour is on, so a piped frame stays parseable.
 * @param {string | number} code - SGR code.
 * @param {string} text - content.
 * @param {boolean} color - whether ANSI is allowed.
 */
function paint(code, text, color) {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text
}

/** Cell count of a string that may already carry SGR escapes. */
function visibleLength(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').length
}

/**
 * Shorten to `width` cells, appending an ellipsis when it does not fit.
 * @param {string} text - input.
 * @param {number} width - maximum cells.
 */
export function clip(text, width) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (width <= 0) return ''
  if (value.length <= width) return value
  if (width === 1) return '…'
  return `${value.slice(0, width - 1)}…`
}

/**
 * Pad to a fixed cell count, clipping first so a long value cannot push the
 * following columns out of alignment.
 * @param {string} text - value.
 * @param {number} width - target cells.
 */
export function pad(text, width) {
  const value = clip(text, width)
  return value + ' '.repeat(Math.max(0, width - value.length))
}

/** `950ms`, `12s`, `3m04s`, `1h02m`. */
export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '-'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** `5.4k`, `1.2M`, `840`. */
export function formatCount(value) {
  const number = Number(value) || 0
  if (number < 1000) return String(number)
  if (number < 1_000_000) return `${(number / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(number / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** First non-empty line of an error, for a one-row outcome. */
function firstLine(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  return value.split(/\r?\n/, 1)[0]
}

/** Last dash-separated segment of a run id: the part that fits a narrow cell. */
function runTail(run) {
  const parts = String(run?.id ?? '').split('-')
  return parts[parts.length - 1] || String(run?.id ?? '')
}

/** Parent session label: the uuid tail is what the user recognises. */
export function parentLabel(run) {
  const id = String(run?.parentSessionId ?? '').trim()
  if (!id) return '-'
  const tail = id.replace(/^session-/, '')
  return tail.slice(0, 8)
}

/** Calls spent, matching the orchestrator's `spentCalls` (measured beats counted). */
export function callsOf(run) {
  return Math.max(run?.usage?.modelCalls ?? 0, run?.counters?.spawns ?? 0)
}

/** Elapsed wall-clock; a live run counts to `now`, a finished one stops at `finishedAt`. */
export function elapsedOf(run, now) {
  const start = Date.parse(run?.startedAt ?? run?.createdAt ?? '')
  if (!Number.isFinite(start)) return null
  const end = ACTIVE_STATUSES.has(run?.status)
    ? now
    : Date.parse(run?.finishedAt ?? '') || now
  return Math.max(0, end - start)
}

/** Half-open lifetime of a run, used for overlap detection. */
function spanOf(run, now) {
  const start = Date.parse(run?.createdAt ?? run?.startedAt ?? '')
  if (!Number.isFinite(start)) return null
  const end = ACTIVE_STATUSES.has(run?.status)
    ? now
    : Date.parse(run?.finishedAt ?? '') || now
  return { start, end: Math.max(start, end) }
}

/**
 * Cluster runs into connected groups of overlapping lifetimes.
 *
 * Two runs that were alive at the same moment end up in the same group, and
 * overlap is transitive: if A overlaps B and B overlaps C, one group covers
 * all three. A run that never overlapped anything is its own group and is left
 * out of the gutter, so the panel only spends visual noise on real parallelism.
 *
 * @param {object[]} runs - run records.
 * @param {number} [now] - wall clock for live runs.
 * @returns {object[][]} groups, each sorted by start time.
 */
export function overlapGroups(runs, now = Date.now()) {
  const entries = []
  for (const run of runs ?? []) {
    const span = spanOf(run, now)
    if (span) entries.push({ run, span })
  }
  entries.sort((a, b) => a.span.start - b.span.start || String(a.run.id).localeCompare(String(b.run.id)))
  const groups = []
  let open = null
  for (const entry of entries) {
    if (open && entry.span.start < open.end) {
      open.items.push(entry.run)
      open.end = Math.max(open.end, entry.span.end)
    } else {
      open = { end: entry.span.end, items: [entry.run] }
      groups.push(open)
    }
  }
  return groups.map(group => group.items)
}

/**
 * Gutter label per run for the groups that actually contain more than one run.
 * @param {object[]} runs - run records.
 * @param {number} [now] - wall clock.
 * @returns {Map<string, { label: string, color: number, size: number }>}
 */
export function groupingOf(runs, now = Date.now()) {
  const map = new Map()
  const groups = overlapGroups(runs, now).filter(group => group.length > 1)
  groups.forEach((group, index) => {
    const label = index < 9
      ? String(index + 1)
      : index < 35
        ? String.fromCharCode(65 + index - 9)
        : '#'
    const meta = { label, color: GROUP_COLORS[index % GROUP_COLORS.length], size: group.length }
    for (const run of group) map.set(run.id, meta)
  })
  return map
}

/**
 * Why a run is not making progress, in the run store's own terms.
 *
 * Only observable facts are used, so the panel never guesses a cause it cannot
 * see: a queued run is waiting for an active-run slot (the other active runs are
 * its candidates), a pending worker behind a full `maxParallel` pool is waiting
 * for a slot inside its own run, and a pending worker that already burned an
 * attempt is in retry backoff.
 *
 * @param {object} run - run record.
 * @param {{ runs?: object[], now?: number }} [options] - sibling runs and clock.
 * @returns {{ kind: 'slot' | 'parallel' | 'retry', text: string } | null}
 */
export function waitingOf(run, options = {}) {
  if (!run) return null
  const runs = options.runs ?? []
  const subtasks = Array.isArray(run.subtasks) ? run.subtasks : []

  if (run.status === 'queued') {
    // Only a run that is actually working holds a slot; other queued runs are
    // waiting beside this one, not blocking it.
    const active = runs
      .filter(other => other.id !== run.id && ACTIVE_STATUSES.has(other.status) && other.status !== 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const queued = runs
      .filter(other => other.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    const position = queued.findIndex(other => other.id === run.id) + 1
    // Most specific fact first, so a narrow terminal truncates the tail rather
    // than the answer: the slot holders are what the user can act on.
    const parts = ['waiting for a slot']
    if (active.length > 0) parts.push(`${active.length} active`)
    if (active.length > 0) parts.push(`← ${active.slice(0, 2).map(runTail).join(',')}`)
    if (position > 1) parts.push(`#${position}`)
    return { kind: 'slot', text: parts.join(' · ') }
  }

  if (!ACTIVE_STATUSES.has(run.status)) return null

  const running = subtasks.filter(subtask => subtask.status === 'running')
  const pending = subtasks.filter(subtask => subtask.status === 'pending')
  const retrying = pending.filter(subtask => Number(subtask.attempts) > 0)
  if (retrying.length > 0) {
    const cap = Number(run.limits?.attempts) || 0
    const used = Math.max(...retrying.map(subtask => Number(subtask.attempts) || 0))
    return { kind: 'retry', text: `retry ${used}${cap > 0 ? `/${cap}` : ''} backoff` }
  }

  const parallel = Number(run.limits?.maxParallel)
  if (pending.length > 0 && Number.isFinite(parallel) && parallel > 0 && running.length >= parallel) {
    return { kind: 'parallel', text: `worker pool full ${running.length}/${parallel} · ${pending.length} waiting` }
  }
  return null
}

/**
 * What the run is doing right now, or how it ended. One short phrase, because
 * the panel's job is to answer "is it stuck?" at a glance.
 * @param {object} run - run record.
 */
export function activityOf(run) {
  const subtasks = Array.isArray(run?.subtasks) ? run.subtasks : []
  const completed = subtasks.filter(subtask => subtask.status === 'completed').length
  const running = subtasks.filter(subtask => subtask.status === 'running')
  const failed = subtasks.filter(subtask => subtask.status === 'failed').length
  switch (run?.status) {
    case 'queued':
      return 'waiting for an active-run slot'
    case 'planning':
      return 'planner is decomposing the goal'
    case 'running':
      if (running.length > 0) {
        return `${running.length} running · ${running[0].title ?? 'subtask'}`
      }
      if (subtasks.length > 0) return `${completed}/${subtasks.length} subtasks done`
      return 'starting the first subtask'
    case 'aggregating':
      return `merging ${completed || subtasks.length} report(s)`
    case 'completed':
      return `report ready · ${completed}/${subtasks.length} subtasks`
    case 'partial':
      return `partial report · ${completed}/${subtasks.length} subtasks${failed > 0 ? ` · ${failed} failed` : ''}`
    case 'failed':
      return firstLine(run.error) || 'failed without a recorded error'
    case 'cancelled':
      return 'cancelled by request'
    case 'interrupted':
      return 'host went away · resume to continue'
    default:
      return STATUS_LABEL[run?.status] ?? String(run?.status ?? 'unknown')
  }
}

/**
 * Order for display: live work first (oldest first, so rows do not reorder
 * while you watch them), then finished runs newest-first.
 * @param {object[]} runs - run records.
 */
export function orderRuns(runs) {
  const list = [...(runs ?? [])]
  const active = list.filter(run => ACTIVE_STATUSES.has(run.status))
  const done = list.filter(run => !ACTIVE_STATUSES.has(run.status))
  active.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  done.sort((a, b) => String(b.finishedAt ?? b.createdAt).localeCompare(String(a.finishedAt ?? a.createdAt)))
  return [...active, ...done]
}

/** Totals for the footer: calls, tokens, priced cost, and whether any price is missing. */
export function totalsOf(runs) {
  let calls = 0
  let tokens = 0
  let cost = 0
  let unpriced = false
  let active = 0
  let failed = 0
  for (const run of runs ?? []) {
    calls += callsOf(run)
    tokens += run?.usage?.totalTokens ?? 0
    if (run?.cost) {
      cost += run.cost.total ?? 0
      if (run.cost.complete === false) unpriced = true
    } else if ((run?.usage?.modelCalls ?? 0) > 0) {
      unpriced = true
    }
    if (ACTIVE_STATUSES.has(run?.status)) active += 1
    if (run?.status === 'failed') failed += 1
  }
  return { calls, tokens, cost, unpriced, active, failed, total: (runs ?? []).length }
}

/**
 * Column sets, widest first. The first one whose fixed columns plus a readable
 * activity column fit the terminal wins; the narrowest fallback stacks id and
 * activity onto two lines instead of squeezing them together.
 */
const TIERS = [
  {
    name: 'wide',
    min: 22,
    cells: [['gutter', GUTTER], ['id', 20], ['status', 12], ['calls', 8], ['elapsed', 7], ['workers', 9], ['activity', 0], ['parent', 8]],
  },
  {
    name: 'standard',
    min: 16,
    cells: [['gutter', GUTTER], ['id', 16], ['status', 10], ['calls', 7], ['elapsed', 6], ['workers', 7], ['activity', 0]],
  },
  {
    name: 'compact',
    min: 10,
    cells: [['gutter', GUTTER], ['id', 12], ['status', 8], ['elapsed', 6], ['workers', 6], ['activity', 0]],
  },
  {
    name: 'narrow',
    min: 10,
    cells: [['gutter', GUTTER], ['id', 9], ['status', 5], ['elapsed', 5], ['activity', 0]],
  },
]

/**
 * Pick the widest column set that still leaves a usable activity column.
 * @param {number} width - terminal columns.
 */
function layoutFor(width) {
  for (const tier of TIERS) {
    const fixed = tier.cells.reduce((sum, [, cells]) => sum + cells, 0)
    const separators = tier.cells.length - 1
    const activity = width - fixed - separators
    if (activity >= tier.min) return { ...tier, activity }
  }
  // Below this, a single-line row cannot hold an id and a reason at once.
  return { name: 'tiny', cells: [['gutter', GUTTER], ['id', 0], ['status', 6], ['elapsed', 6]], min: 6, activity: 0 }
}

/** Status text for the chosen width. */
function statusText(status, tier) {
  if (tier === 'wide') return STATUS_LABEL[status] ?? String(status ?? '?')
  if (tier === 'standard') return STATUS_MEDIUM[status] ?? String(status ?? '?')
  return STATUS_SHORT[status] ?? String(status ?? '?')
}

/**
 * Run id for a narrow cell: the head and the tail survive, the middle does not.
 * Run ids share their date prefix, so a left truncation would leave every row
 * looking identical exactly when the panel is too narrow to compare columns.
 */
function shortId(id, width) {
  const value = String(id ?? '')
  if (value.length <= width) return value
  if (width <= 1) return '…'
  const tail = Math.max(2, Math.floor((width - 1) / 2))
  const head = width - 1 - tail
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

/**
 * Worker column: what the pool is doing now, or what it ended with.
 *
 * A live run shows running and pending counts because that is the pool's
 * pressure; a finished run shows completed and failed counts because that is
 * its outcome. `0▶` or `0✓` on a row with no workers would answer a question
 * nobody asked, so an empty pool is left blank.
 */
function workersOf(run) {
  const subtasks = Array.isArray(run?.subtasks) ? run.subtasks : []
  const running = subtasks.filter(subtask => subtask.status === 'running').length
  const pending = subtasks.filter(subtask => subtask.status === 'pending').length
  const completed = subtasks.filter(subtask => subtask.status === 'completed').length
  const failed = subtasks.filter(subtask => subtask.status === 'failed').length
  const parts = []
  if (ACTIVE_STATUSES.has(run?.status)) {
    if (running > 0) parts.push(`${running}▶`)
    if (pending > 0) parts.push(`${pending}·`)
  } else if (completed > 0) {
    parts.push(`${completed}✓`)
  }
  if (failed > 0) parts.push(`${failed}✕`)
  return parts.join(' ')
}

/** Column names, with a shorter spelling when the column itself is narrow. */
function headerFor(layout, color) {
  const labels = {
    gutter: ['', ''],
    id: ['RUN ID', 'ID'],
    status: ['STATUS', 'ST'],
    calls: ['CALLS', 'CALLS'],
    elapsed: ['ELAPSED', 'TIME'],
    workers: ['WORKERS', 'WKRS'],
    activity: ['ACTIVITY / WAITING ON', 'ACTIVITY'],
    parent: ['PARENT', 'PARENT'],
  }
  const cells = layout.cells.map(([key, width]) => {
    const cellWidth = key === 'activity' ? layout.activity : width
    const [long, short] = labels[key] ?? [key, key]
    return pad(long.length <= cellWidth ? long : short, cellWidth)
  })
  return paint('2', cells.join(' '), color)
}

function rule(width, color) {
  return paint('2', ` ${'─'.repeat(Math.max(0, width - 2))}`, color)
}

/** Gutter cell: a shared label and colour for runs alive at the same time. */
function gutterOf(group, color) {
  if (!group) return ' '.repeat(GUTTER)
  const text = `▐${group.label}`
  return paint(group.color, `${text}${' '.repeat(Math.max(0, GUTTER - text.length))}`, color)
}

/**
 * Render one complete frame, with no trailing newline.
 *
 * Kept pure so the layout can be asserted in tests without a terminal, and so
 * every tier can be checked for the promise that no line exceeds the terminal
 * width.
 *
 * @param {object[]} runs - run records.
 * @param {{ now?: number, width?: number, rows?: number, color?: boolean, stateRoot?: string, intervalMs?: number }} [options]
 * @returns {string} frame text, ANSI-painted only when `color` is true.
 */
export function renderFrame(runs, options = {}) {
  const now = options.now ?? Date.now()
  const width = Math.max(24, Math.floor(options.width ?? 100))
  const color = options.color === true
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const list = orderRuns(runs)
  const totals = totalsOf(list)
  const groups = groupingOf(list, now)
  const layout = layoutFor(width)

  const clock = new Date(now).toISOString().slice(11, 19)
  const headline = [
    paint('1', 'dsh-superagent', color),
    paint('2', '·', color),
    `${totals.total} run${totals.total === 1 ? '' : 's'}`,
    totals.active > 0 ? paint('6', `${totals.active} active`, color) : paint('2', 'idle', color),
    paint('2', `· ${clock}Z`, color),
  ].join(' ')
  const headlineText = visibleLength(headline) <= width
    ? headline
    : paint('2', clip(`dsh-superagent · ${totals.total} run${totals.total === 1 ? '' : 's'} · ${totals.active} active · ${clock}Z`, width), color)

  const lines = [headlineText, rule(width, color)]
  if (list.length === 0) {
    lines.push('')
    lines.push(paint('2', `  ${clip('no runs recorded yet', width - 2)}`, color))
    lines.push(paint('2', `  ${clip(`state: ${options.stateRoot ?? '-'}`, width - 2)}`, color))
    lines.push('')
    lines.push(paint('2', `  ${clip('start one with the superagent_start tool; this panel updates itself.', width - 2)}`, color))
  } else {
    // A live panel is bounded by the terminal height; a one-shot frame is not,
    // so `--once` and log capture keep every row.
    const budget = Number.isFinite(options.rows) ? Math.max(1, Math.floor(options.rows) - 6) : Infinity
    const visible = list.slice(0, budget)
    const hidden = list.length - visible.length

    if (layout.name !== 'tiny') lines.push(headerFor(layout, color))
    for (const run of visible) {
      const why = waitingOf(run, { runs: list, now })
      const activity = activityOf(run)
      // A queued run's only fact is its wait, so repeating "waiting for an
      // active-run slot" after the concrete reason would just spend cells.
      const activityText = why
        ? (run.status === 'queued' ? why.text : `${why.text} · ${activity}`)
        : activity
      const elapsed = elapsedOf(run, now)
      const calls = callsOf(run)
      const cap = run?.limits?.maxModelCalls ?? 0
      const callsText = cap > 0 ? `${calls}/${cap}` : String(calls)
      const group = groups.get(run.id)
      const status = statusText(run.status, layout.name)
      const statusColor = STATUS_COLOR[run.status] ?? 0
      const elapsedText = elapsed === null ? '-' : formatDuration(elapsed)

      if (layout.name === 'tiny') {
        // gutter + sep + id + sep + status + sep + elapsed = width
        const idWidth = Math.max(4, width - GUTTER - 3 - 6 - 6)
        const top = [
          gutterOf(group, color),
          ` ${paint('1', pad(shortId(run.id, idWidth), idWidth), color)}`,
          ` ${paint(String(statusColor), pad(status, 6), color)}`,
          ` ${pad(elapsedText, 6)}`,
        ].join('')
        lines.push(top.replace(/\s+$/, ''))
        lines.push(`  ${paint('2', '└', color)} ${clip(activityText, Math.max(1, width - 4))}`)
        continue
      }

      const cells = layout.cells.map(([key, cellWidth]) => {
        switch (key) {
          case 'gutter':
            return gutterOf(group, color)
          case 'id':
            return paint('1', pad(shortId(run.id, cellWidth), cellWidth), color)
          case 'status':
            return paint(String(statusColor), pad(status, cellWidth), color)
          case 'calls':
            return pad(callsText, cellWidth)
          case 'elapsed':
            return pad(elapsedText, cellWidth)
          case 'workers':
            return pad(workersOf(run), cellWidth)
          case 'activity':
            return pad(activityText, layout.activity)
          case 'parent':
            return paint('2', pad(parentLabel(run), cellWidth), color)
          default:
            return pad('', cellWidth)
        }
      })
      lines.push(cells.join(' ').replace(/\s+$/, ''))
    }

    if (hidden > 0) {
      lines.push(paint('2', `  ${clip(`… ${hidden} more run(s) · enlarge the terminal to see them`, width - 2)}`, color))
    }
  }

  const money = totals.unpriced ? `$${totals.cost.toFixed(4)}+` : `$${totals.cost.toFixed(4)}`
  const summary = [
    `calls ${totals.calls}`,
    `${formatCount(totals.tokens)} tok`,
    `cost ${money}`,
    totals.failed > 0 ? paint('1', `${totals.failed} failed`, color) : null,
  ].filter(Boolean).join(' · ')
  const legend = list.length > 0 && groups.size > 0
    ? ' · ▐n overlapping · ▶ running · · pending'
    : ''
  const footer = paint('2', clip(`${summary} · ${interval >= 1000 ? `${interval / 1000}s` : `${interval}ms`} refresh · Ctrl-C quit${legend}`, width), color)

  lines.push(rule(width, color))
  lines.push(footer)
  return lines.join('\n')
}

/** Status + progress + blocking fingerprint; a change here is worth an immediate repaint. */
export function signatureOf(runs, now = Date.now()) {
  const groups = groupingOf(runs, now)
  return orderRuns(runs)
    .map(run => {
      const subtasks = Array.isArray(run.subtasks) ? run.subtasks : []
      const attempts = subtasks.reduce((sum, subtask) => sum + (Number(subtask.attempts) || 0), 0)
      return [
        run.id,
        run.status,
        callsOf(run),
        subtasks.filter(subtask => subtask.status === 'running').length,
        subtasks.filter(subtask => subtask.status === 'completed').length,
        attempts,
        groups.get(run.id)?.label ?? '-',
      ].join(':')
    })
    .join('|')
}

/**
 * Run the panel until interrupted.
 *
 * When stdout is a terminal the frame is drawn in the alternate screen and the
 * cursor is hidden; both are restored on every exit path, including SIGINT,
 * SIGTERM, an uncaught exception, and `EPIPE` from a closed pipe. `once`
 * deliberately skips the alternate screen so its frame stays readable after
 * the process exits. When output is a pipe, each change is appended as a plain
 * frame instead, which keeps `watch --once | ...` and log capture useful.
 *
 * @param {{ stateDir?: string, intervalMs?: number, once?: boolean, out?: NodeJS.WriteStream | { write: Function, isTTY?: boolean, columns?: number, rows?: number }, now?: () => number }} [options]
 * @returns {Promise<void>} resolves after cleanup.
 */
export async function watch(options = {}) {
  const out = options.out ?? process.stdout
  const intervalMs = Math.max(200, Number(options.intervalMs) || DEFAULT_INTERVAL_MS)
  const once = options.once === true
  const tty = out.isTTY === true
  // `--once` prints one frame for a pipe or a log. Entering the alternate
  // screen for that would draw it and then erase it on exit, so a person who
  // runs it in a terminal would see nothing at all.
  const altScreen = tty && !once
  const color = options.color ?? tty
  const now = options.now ?? Date.now
  const store = createStore(resolveStateRoot(options.stateDir))
  await store.init()

  let stopped = false
  let cleaned = false
  let timer = null
  let wake = null
  let lastFrame = ''
  let lastSignature = null

  const draw = runs => {
    const frame = renderFrame(runs, {
      now: now(),
      width: out.columns || 100,
      // A one-shot frame goes to a log or a pipe, where nothing scrolls: only a
      // live alternate-screen panel is bounded by the terminal height.
      rows: altScreen ? out.rows : undefined,
      color,
      stateRoot: store.root,
      intervalMs,
    })
    if (altScreen) {
      // Home + per-line erase avoids a full-screen flash and keeps the panel
      // from leaving ghost rows when a run disappears.
      out.write(`${ANSI.home}${frame.split('\n').map(line => `${line}${ANSI.clearLine}`).join('\n')}\n${ANSI.clearLine}`)
    } else if (frame !== lastFrame) {
      out.write(`${frame}\n`)
      lastFrame = frame
    }
  }

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    wake = null
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (altScreen) out.write(`${ANSI.show}${ANSI.altOff}`)
  }

  /**
   * Ctrl-C ends the panel. The loop is woken rather than the process killed so
   * the `finally` below restores the terminal *before* Node exits; calling
   * `process.exit` here could drop the pending un-hide/un-alt-screen write.
   */
  const onSignal = () => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    if (wake) wake()
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  if (out.on) out.on('error', error => {
    if (error?.code === 'EPIPE') {
      cleanup()
      process.exit(0)
    }
    throw error
  })

  if (altScreen) out.write(`${ANSI.altOn}${ANSI.hide}`)

  try {
    while (!stopped) {
      let runs
      try {
        runs = await store.list()
      } catch (error) {
        const problem = [
          'dsh-superagent watch',
          '',
          `cannot read ${store.root}`,
          error?.message ?? String(error),
        ].join('\n')
        if (altScreen) out.write(`${ANSI.home}${problem.split('\n').map(line => `${line}${ANSI.clearLine}`).join('\n')}`)
        else out.write(`${problem}\n`)
        if (once) return
        await new Promise(resolve => {
          wake = resolve
          timer = setTimeout(resolve, intervalMs)
        })
        continue
      }
      draw(runs)
      if (once) return
      // A status transition (planning -> running -> aggregating) can happen
      // inside one interval. Re-read at once when the fingerprint moved, then
      // settle back to the normal cadence so an idle panel costs one read/s.
      const signature = signatureOf(runs, now())
      const moved = signature !== lastSignature
      lastSignature = signature
      await new Promise(resolve => {
        wake = resolve
        timer = setTimeout(resolve, moved ? Math.min(200, intervalMs) : intervalMs)
      })
    }
  } finally {
    cleanup()
  }
}
