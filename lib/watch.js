/**
 * Live terminal panel for dsh-superagent.
 *
 * The panel is a pure renderer plus a poll loop: it reads the same durable run
 * files the host writes and draws one line per run, so it works from another
 * process, survives a host restart, and never needs IPC.
 *
 * There is no dependency here on purpose — the package is a zero-dependency
 * plugin, and a monitoring aid is not a reason to pull in an ANSI toolkit. The
 * escape sequences used are the small, stable subset: alternate screen, hide
 * cursor, cursor home, erase line, and SGR colours.
 *
 * @module dsh-superagent/watch
 */
import { formatMoney } from './cost.js'
import { ACTIVE_STATUSES, createStore, resolveStateRoot } from './store.js'

/** Refresh cadence. A run file is small, so one read per second is cheap. */
export const DEFAULT_INTERVAL_MS = 1000

const COLUMNS = {
  id: 20,
  status: 12,
  calls: 8,
  elapsed: 7,
  parent: 9,
}

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

/**
 * What the run is doing right now, or how it ended. One short phrase, because
 * the panel's job is to answer "is it stuck?" at a glance.
 * @param {object} run - run record.
 */
export function activityOf(run) {
  const subtasks = Array.isArray(run?.subtasks) ? run.subtasks : []
  const completed = subtasks.filter(subtask => subtask.status === 'completed').length
  const running = subtasks.filter(subtask => subtask.status === 'running')
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
      return `partial report · ${completed}/${subtasks.length} subtasks`
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
  // Integer micro-units keep a long-running panel's total exactly additive.
  let costMicros = 0
  let currency = null
  const currencies = new Set()
  let unpriced = false
  let active = 0
  let failed = 0
  for (const run of runs ?? []) {
    calls += callsOf(run)
    tokens += run?.usage?.totalTokens ?? 0
    if (run?.cost) {
      costMicros += Number.isFinite(run.cost.totalMicros)
        ? run.cost.totalMicros
        : Math.round((run.cost.total ?? 0) * 1e6)
      const code = run.cost.currency ?? 'USD'
      currencies.add(code)
      currency = currency ?? code
      if (run.cost.complete === false) unpriced = true
    } else if ((run?.usage?.modelCalls ?? 0) > 0) {
      unpriced = true
    }
    if (ACTIVE_STATUSES.has(run?.status)) active += 1
    if (run?.status === 'failed') failed += 1
  }
  return {
    calls,
    tokens,
    cost: costMicros / 1e6,
    costMicros,
    currency: currencies.size === 1 ? currency : null,
    mixedCurrency: currencies.size > 1,
    unpriced,
    active,
    failed,
    total: (runs ?? []).length,
  }
}

/** Header + column names, reused by every frame so the layout never shifts. */
function headerRow(color) {
  const cells = [
    pad('RUN ID', COLUMNS.id),
    pad('STATUS', COLUMNS.status),
    pad('CALLS', COLUMNS.calls),
    pad('ELAPSED', COLUMNS.elapsed),
    pad('ACTIVITY', 32),
    'PARENT',
  ]
  return paint('2', ` ${cells.join(' ')}`, color)
}

function rule(width, color) {
  return paint('2', ` ${'─'.repeat(Math.max(0, width - 2))}`, color)
}

/**
 * Render one complete frame, with no trailing newline.
 *
 * Kept pure so the layout can be asserted in tests without a terminal.
 *
 * @param {object[]} runs - run records.
 * @param {{ now?: number, width?: number, color?: boolean, stateRoot?: string, intervalMs?: number, columns?: number }} [options]
 * @returns {string} frame text, ANSI-painted only when `color` is true.
 */
export function renderFrame(runs, options = {}) {
  const now = options.now ?? Date.now()
  const width = Math.max(60, options.width ?? 100)
  const color = options.color === true
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const list = orderRuns(runs)
  const totals = totalsOf(list)
  const activityWidth = Math.max(
    20,
    width - (COLUMNS.id + COLUMNS.status + COLUMNS.calls + COLUMNS.elapsed + COLUMNS.parent + 6),
  )

  const clock = new Date(now).toISOString().slice(11, 19)
  const headline = [
    paint('1', 'dsh-superagent', color),
    paint('2', '·', color),
    `${totals.total} run${totals.total === 1 ? '' : 's'}`,
    totals.active > 0 ? paint('6', `${totals.active} active`, color) : paint('2', 'idle', color),
    paint('2', `· ${clock}Z`, color),
  ].join(' ')

  const lines = [headline, rule(width, color)]
  if (list.length === 0) {
    lines.push('')
    lines.push(paint('2', '  no runs recorded yet', color))
    lines.push(paint('2', `  state: ${options.stateRoot ?? '-'}`, color))
    lines.push('')
    lines.push(paint('2', '  start one with the superagent_start tool; this panel updates itself.', color))
  } else {
    lines.push(headerRow(color))
    for (const run of list) {
      const elapsed = elapsedOf(run, now)
      const calls = callsOf(run)
      const cap = run?.limits?.maxModelCalls ?? 0
      const callsText = cap > 0 ? `${calls}/${cap}` : String(calls)
      const status = STATUS_LABEL[run.status] ?? String(run.status ?? '?')
      const activity = activityOf(run)
      const row = [
        ` ${paint('1', pad(run.id, COLUMNS.id), color)}`,
        ` ${paint(String(STATUS_COLOR[run.status] ?? 0), pad(status, COLUMNS.status), color)}`,
        ` ${pad(callsText, COLUMNS.calls)}`,
        ` ${pad(elapsed === null ? '-' : formatDuration(elapsed), COLUMNS.elapsed)}`,
        ` ${pad(activity, activityWidth)}`,
        ` ${paint('2', pad(parentLabel(run), COLUMNS.parent), color)}`,
      ].join('')
      lines.push(row.replace(/\s+$/, ''))
    }
  }

  // An unpriced panel says so. Printing 0.0000 there would look like "this run
  // was free", when the truth is "no price is configured for its model".
  const shown = formatMoney({ totalMicros: totals.costMicros, currency: totals.currency ?? 'USD' })
  const money = totals.unpriced
    ? (totals.costMicros > 0 ? `${shown}+` : 'unpriced')
    : shown
  const summary = [
    paint('2', 'calls', color),
    `${totals.calls}`,
    paint('2', 'tokens', color),
    formatCount(totals.tokens),
    paint('2', 'cost', color),
    money,
    totals.failed > 0 ? paint('1', `${totals.failed} failed`, color) : null,
  ].filter(Boolean).join(' ')

  const footer = [
    paint('2', `${summary} · refreshing every ${interval >= 1000 ? `${interval / 1000}s` : `${interval}ms`} · Ctrl-C to quit`, color),
  ].join('')

  lines.push(rule(width, color))
  lines.push(footer)
  return lines.join('\n')
}

/** Status + progress fingerprint; a change here is worth an immediate repaint. */
export function signatureOf(runs) {
  return orderRuns(runs)
    .map(run => [
      run.id,
      run.status,
      callsOf(run),
      (run.subtasks ?? []).filter(subtask => subtask.status === 'running').length,
      (run.subtasks ?? []).filter(subtask => subtask.status === 'completed').length,
    ].join(':'))
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
 * @param {{ stateDir?: string, intervalMs?: number, once?: boolean, out?: NodeJS.WriteStream | { write: Function, isTTY?: boolean, columns?: number }, now?: () => number }} [options]
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
      const signature = signatureOf(runs)
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
