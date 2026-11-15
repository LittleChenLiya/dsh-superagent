/**
 * Static HTML report for dsh-superagent runs.
 *
 * `report` turns whatever is on disk into one file that can be mailed, attached
 * to a README, or opened from a USB stick: inline CSS, inline SVG, no script,
 * no font, no image, no network. The output is a pure string, so the layout is
 * testable without a browser.
 *
 * The charts are hand-built SVG rather than a chart library for the same reason
 * the watch panel is hand-built ANSI: the package ships zero runtime
 * dependencies.
 *
 * @module dsh-superagent/report
 */
import { ACTIVE_STATUSES } from './store.js'
import { callsOf, formatCount, formatDuration } from './watch.js'

const STATUS_HEX = {
  queued: '#64748b',
  planning: '#0284c7',
  running: '#0284c7',
  aggregating: '#0284c7',
  completed: '#15803d',
  partial: '#b45309',
  failed: '#b91c1c',
  cancelled: '#7e22ce',
  interrupted: '#c2410c',
}

const STATUS_ORDER = ['running', 'planning', 'aggregating', 'queued', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']

/** Phase opacity inside a run bar: plan is fainter, merge is medium. */
const PHASE_OPACITY = { plan: 0.38, work: 1, merge: 0.66 }
const PHASE_LABEL = { plan: 'plan', work: 'work', merge: 'merge' }

const SVG_FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO_FONT = "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace"

/**
 * Escape text for HTML text nodes and double-quoted attributes.
 * @param {unknown} value - raw value.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]))
}

/** Parse an ISO timestamp, or null when absent/unusable. */
function timeOf(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** `$0.0225`, `$1.24`, `<$0.0001`, or `—`. */
function money(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  if (value < 0.0001) return '<$0.0001'
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

/** `2026-11-14 07:52:05` in UTC, matching the axis. */
function stampUtc(ms) {
  if (!Number.isFinite(ms)) return '—'
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

/** Axis label: seconds when the window is short, minute precision when long. */
function axisLabel(ms, span) {
  const date = new Date(ms)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  const ss = String(date.getUTCSeconds()).padStart(2, '0')
  if (span > 24 * 3600_000) {
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(date.getUTCDate()).padStart(2, '0')
    return `${mo}-${dd} ${hh}:${mm}`
  }
  return `${hh}:${mm}:${ss}`
}

/** Six-ish evenly spaced ticks that land on round wall-clock values. */
export function axisTicks(start, end) {
  const span = Math.max(1, end - start)
  const steps = [
    1000, 2000, 5000, 10_000, 15_000, 30_000,
    60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
    3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
  ]
  const target = span / 6
  const step = steps.find(candidate => candidate >= target) ?? steps[steps.length - 1]
  const ticks = []
  for (let tick = Math.ceil(start / step) * step; tick <= end; tick += step) ticks.push(tick)
  // A window shorter than one step can contain no round boundary at all.
  return { ticks: ticks.length > 0 ? ticks : [start, end], step }
}

/** Truncate to an approximate pixel width at the given font size. */
function clipTo(text, width, fontSize = 11) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const max = Math.max(1, Math.floor(width / (fontSize * 0.58)))
  if (value.length <= max) return value
  if (max <= 1) return '…'
  return `${value.slice(0, max - 1)}…`
}

/** Short run id for a narrow block: the time stamp alone is ambiguous. */
function shortId(id) {
  const value = String(id ?? '')
  return value.length <= 12 ? value : `…${value.slice(-9)}`
}

/**
 * Derive the three visible phases from recorded timestamps.
 *
 * The run file records status, not phase boundaries, so the boundaries come
 * from the subtasks: planning ends when the first worker starts, work ends when
 * the last worker reports, and merging covers the remainder. The report states
 * this derivation in its footnote rather than implying the phases are exact.
 *
 * @param {object} run - run record.
 * @param {number} now - wall clock for a run that has not finished.
 */
export function phasesOf(run, now) {
  const created = timeOf(run?.createdAt) ?? timeOf(run?.startedAt) ?? now
  const started = timeOf(run?.startedAt) ?? created
  const finished = timeOf(run?.finishedAt) ?? now
  const subtasks = Array.isArray(run?.subtasks) ? run.subtasks : []
  const starts = subtasks.map(subtask => timeOf(subtask.startedAt)).filter(value => value !== null)
  const ends = subtasks.map(subtask => timeOf(subtask.finishedAt)).filter(value => value !== null)
  const firstWork = starts.length > 0 ? Math.min(...starts) : started
  const lastWork = ends.length > 0 ? Math.max(...ends) : (starts.length > 0 ? Math.min(...starts) : finished)
  const planEnd = Math.min(Math.max(firstWork, started), finished)
  const workEnd = Math.min(Math.max(lastWork, planEnd), finished)
  return [
    { kind: 'plan', start: started, end: planEnd },
    { kind: 'work', start: planEnd, end: workEnd },
    { kind: 'merge', start: workEnd, end: finished },
  ].filter(phase => phase.end > phase.start)
}

/**
 * Greedy interval-graph colouring: a run takes the first lane whose previous
 * run has already ended, otherwise it opens a new lane. Two overlapping runs
 * therefore never share a lane, and the lane count is the true peak
 * concurrency of the selected window.
 *
 * @param {Array<{ start: number, end: number }>} items - spans, sorted by start.
 * @returns {number} number of lanes used.
 */
export function assignLanes(items) {
  const laneEnds = []
  for (const item of items) {
    let lane = laneEnds.findIndex(end => end <= item.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(item.end)
    } else {
      laneEnds[lane] = item.end
    }
    item.lane = lane
  }
  return laneEnds.length
}

/** Worker colours, by subtask order; cycled when a run has more workers. */
const WORKER_COLORS = ['#0f766e', '#0284c7', '#7c3aed', '#b45309', '#be185d', '#15803d', '#475569', '#a16207']

/** `40%`, or `0.4%` for a sliver rather than a misleading `0%`. */
function percent(share) {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const value = share * 100
  if (value < 1) return `${value.toFixed(1)}%`
  return `${value.toFixed(0)}%`
}

/**
 * Attempts recorded for one worker.
 *
 * A subtask that never started records zero; a worker that is about to run has
 * not spent an attempt yet, so the value is clamped to at least one only when
 * the caller is describing work that did happen.
 *
 * @param {object} subtask - worker record.
 */
export function attemptsOf(subtask) {
  return Math.max(0, Number(subtask?.attempts) || 0)
}

/**
 * The causal chain for the workers that needed more than one attempt, or that
 * ended in failure.
 *
 * The run file keeps one error per worker, not one per attempt, so a chain can
 * say how many attempts were spent and what the last error was, but not what
 * each earlier attempt said. The section states that limitation instead of
 * inventing per-attempt text. A self-heal round resets the worker's counter, so
 * its recorded attempts describe the latest round; the round itself is
 * reported from `run.selfHeal`.
 *
 * @param {object} run - run record.
 * @returns {Array<object>} one entry per retried or failed worker.
 */
export function retryChainsOf(run) {
  const subtasks = Array.isArray(run?.subtasks) ? run.subtasks : []
  const cap = Math.max(1, Number(run?.limits?.attempts) || 1)
  const chains = []
  for (const subtask of subtasks) {
    const attempts = attemptsOf(subtask)
    const failed = subtask?.status === 'failed'
    if (attempts < 2 && !(failed && attempts >= 1)) continue
    chains.push({
      index: Number(subtask.index) || chains.length + 1,
      title: String(subtask.title ?? ''),
      attempts: Math.max(1, attempts),
      cap,
      status: String(subtask.status ?? 'pending'),
      error: String(subtask.error ?? ''),
      stopReason: String(subtask.stopReason ?? ''),
      recovered: subtask?.status === 'completed' && attempts > 1,
      startedAt: timeOf(subtask.startedAt),
      finishedAt: timeOf(subtask.finishedAt),
    })
  }
  return chains
}

/**
 * Wall-time share of every worker in a run.
 *
 * `share` is the worker's own span over the run's wall clock, so shares of
 * parallel workers can add up to more than 100%; `parallelism` is that sum and
 * is the run's effective worker concurrency. A worker still running counts to
 * `now`.
 *
 * @param {{ duration: number, subtasks: object[] }} item - prepared run.
 * @param {number} [now] - wall clock.
 */
export function workerShares(item, now = Date.now()) {
  const wall = Math.max(0, Number(item?.duration) || 0)
  const workers = []
  for (const subtask of item?.subtasks ?? []) {
    const start = timeOf(subtask.startedAt)
    if (start === null) continue
    const end = timeOf(subtask.finishedAt) ?? (subtask.status === 'running' ? now : null)
    const span = end === null ? 0 : Math.max(0, end - start)
    workers.push({
      index: Number(subtask.index) || workers.length + 1,
      title: String(subtask.title ?? ''),
      status: String(subtask.status ?? 'pending'),
      attempts: attemptsOf(subtask),
      span,
      share: wall > 0 ? span / wall : 0,
    })
  }
  const busy = workers.reduce((sum, worker) => sum + worker.span, 0)
  return { wall, workers, busy, parallelism: wall > 0 ? busy / wall : 0 }
}

/**
 * Normalise run files into what the page needs, in chronological order.
 * @param {object[]} runs - run records from the store.
 * @param {number} now - wall clock.
 */
export function prepare(runs, now) {
  const items = []
  for (const run of runs ?? []) {
    if (!run || !run.id) continue
    const start = timeOf(run.startedAt) ?? timeOf(run.createdAt) ?? now
    const end = timeOf(run.finishedAt) ?? now
    const live = ACTIVE_STATUSES.has(run.status)
    const phases = phasesOf(run, now)
    const calls = callsOf(run)
    const cost = Number.isFinite(run.cost?.total) && run.cost?.complete !== false ? run.cost.total : null
    items.push({
      run,
      id: String(run.id),
      status: String(run.status ?? 'unknown'),
      start,
      end: Math.max(end, start),
      live,
      phases,
      calls,
      cost,
      tokens: run.usage?.totalTokens ?? 0,
      duration: Math.max(0, end - start),
      parent: String(run.parentSessionId ?? ''),
      goal: String(run.goal ?? ''),
      error: String(run.error ?? ''),
      subtasks: Array.isArray(run.subtasks) ? run.subtasks : [],
    })
  }
  items.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
  return items
}

/** Totals used by the cards and the one-line summary. */
function summarize(items) {
  const byStatus = {}
  let calls = 0
  let tokens = 0
  let cost = 0
  let priced = 0
  let unpriced = 0
  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
    calls += item.calls
    tokens += item.tokens
    if (item.cost !== null) {
      cost += item.cost
      priced += 1
    } else if (item.calls > 0) {
      unpriced += 1
    }
  }
  const start = items.length > 0 ? Math.min(...items.map(item => item.start)) : 0
  const end = items.length > 0 ? Math.max(...items.map(item => item.end)) : 0
  return { byStatus, calls, tokens, cost, priced, unpriced, start, end, span: Math.max(0, end - start) }
}

/**
 * Timeline: one row per run, a bar split into plan/work/merge, and an explicit
 * marker for the runs that did not complete, because a flat bar alone hides
 * whether an early end was success or damage.
 */
function timelineSvg(items, options) {
  const width = 1240
  const left = 292
  // The right edge is reserved for the outcome marker, so a run that ends at
  // the very last instant still has room for "✕ failed" instead of silently
  // losing the annotation.
  const right = 176
  const top = 54
  const rowHeight = 30
  const height = top + items.length * rowHeight + 26
  const start = options.start
  const end = options.end
  const span = Math.max(1, end - start)
  const track = width - left - right
  const x = time => left + ((time - start) / span) * track
  const { ticks } = options
  const parts = []

  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="timeline-title timeline-desc">`)
  parts.push('<title id="timeline-title">Run timeline</title>')
  parts.push(`<desc id="timeline-desc">${escapeHtml(`${items.length} runs from ${stampUtc(start)} to ${stampUtc(end)} UTC, each bar split into planning, work, and merge phases.`)}</desc>`)

  for (const tick of ticks) {
    const gx = x(tick).toFixed(1)
    parts.push(`<line x1="${gx}" y1="${top - 18}" x2="${gx}" y2="${height - 20}" stroke="#eef1f5" stroke-width="1"/>`)
    parts.push(`<text x="${gx}" y="${top - 26}" text-anchor="middle" class="axis" fill="#94a3b8">${escapeHtml(axisLabel(tick, span))}</text>`)
  }

  items.forEach((item, index) => {
    const y = top + index * rowHeight
    const color = STATUS_HEX[item.status] ?? '#64748b'
    if (index % 2 === 1) {
      parts.push(`<rect x="8" y="${y}" width="${width - 16}" height="${rowHeight - 1}" rx="4" fill="#fbfcfe"/>`)
    }
    parts.push(`<line x1="16" y1="${y + rowHeight - 0.5}" x2="${width - 16}" y2="${y + rowHeight - 0.5}" stroke="#f1f5f9" stroke-width="1"/>`)
    parts.push(`<text x="16" y="${y + 13}" class="id" fill="#0f172a">${escapeHtml(item.id)}</text>`)
    parts.push(`<text x="16" y="${y + 25}" class="meta" fill="${color}">${escapeHtml(item.status.toUpperCase())} · ${escapeHtml(formatDuration(item.duration))}</text>`)

    const phases = item.phases.length > 0
      ? item.phases
      // A run that started and ended in the same millisecond has no positive
      // span to draw; keep a tick so the row is not silently blank.
      : [{ kind: 'work', start: item.start, end: item.start }]
    for (const phase of phases) {
      const px = x(phase.start)
      // A sub-second run on a multi-hour axis is a hairline. Give it three
      // pixels so it stays visible and clickable instead of disappearing.
      const pw = Math.max(3, x(phase.end) - px)
      const opacity = PHASE_OPACITY[phase.kind] ?? 0.6
      parts.push(`<rect x="${px.toFixed(1)}" y="${y + 6}" width="${pw.toFixed(1)}" height="11" rx="3" fill="${color}" opacity="${opacity}"><title>${escapeHtml(`${PHASE_LABEL[phase.kind]} · ${formatDuration(phase.end - phase.start)}`)}</title></rect>`)
    }

    // Subtask boundaries inside the work phase: a thin white notch is enough
    // to show whether workers overlapped or ran one after another.
    const notches = new Set()
    for (const subtask of item.subtasks) {
      for (const edge of [timeOf(subtask.startedAt), timeOf(subtask.finishedAt)]) {
        if (edge !== null) notches.add(edge)
      }
    }
    for (const notch of notches) {
      if (notch <= start || notch >= end) continue
      const nx = x(notch)
      const barStart = x(item.start)
      const barEnd = x(item.end)
      if (nx <= barStart + 2 || nx >= barEnd - 2) continue
      parts.push(`<line x1="${nx.toFixed(1)}" y1="${y + 7}" x2="${nx.toFixed(1)}" y2="${y + 16}" stroke="#ffffff" stroke-width="1" opacity="0.55"/>`)
    }

    if (item.live) {
      parts.push(`<line x1="${(x(item.end) + 3).toFixed(1)}" y1="${y + 5}" x2="${(x(item.end) + 3).toFixed(1)}" y2="${y + 18}" stroke="${color}" stroke-width="2" stroke-dasharray="2 2"/>`)
    }

    const markers = {
      failed: '✕ failed',
      cancelled: '⊘ cancelled',
      interrupted: '! interrupted',
      partial: '△ partial',
    }
    const marker = markers[item.status]
    if (marker) {
      const available = width - 16 - (x(item.end) + 8)
      parts.push(`<text x="${(x(item.end) + 8).toFixed(1)}" y="${y + 15}" class="mark" fill="${color}">${escapeHtml(clipTo(marker, Math.max(40, available), 10))}</text>`)
    }
  })

  parts.push('</svg>')
  return parts.join('')
}

/**
 * Swimlanes: the same runs placed on the minimum number of lanes so that
 * overlaps are visible as horizontal neighbours instead of hidden in a
 * chronological list.
 */
function lanesSvg(items, options) {
  const lanes = options.lanes
  const laneHeight = 40
  const width = 1240
  const left = 92
  const right = 48
  const top = 44
  const height = top + Math.max(1, lanes) * laneHeight + 34
  const start = options.start
  const end = options.end
  const span = Math.max(1, end - start)
  const track = width - left - right
  const x = time => left + ((time - start) / span) * track
  const parts = []

  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="lanes-title lanes-desc">`)
  parts.push('<title id="lanes-title">Concurrency swimlanes</title>')
  parts.push(`<desc id="lanes-desc">${escapeHtml(`Runs placed on ${lanes} lane${lanes === 1 ? '' : 's'}; overlapping runs never share a lane, so the lane count is the peak concurrency.`)}</desc>`)

  for (let lane = 0; lane < Math.max(1, lanes); lane++) {
    const y = top + lane * laneHeight
    parts.push(`<rect x="${left}" y="${y + 5}" width="${track}" height="${laneHeight - 10}" rx="6" fill="#f8fafc"/>`)
    parts.push(`<text x="${left - 12}" y="${y + laneHeight / 2 + 4}" text-anchor="end" class="axis" fill="#94a3b8">lane ${lane + 1}</text>`)
  }

  for (const tick of options.ticks) {
    const gx = x(tick).toFixed(1)
    parts.push(`<line x1="${gx}" y1="${top}" x2="${gx}" y2="${height - 26}" stroke="#eef1f5" stroke-width="1"/>`)
    parts.push(`<text x="${gx}" y="${height - 10}" text-anchor="middle" class="axis" fill="#94a3b8">${escapeHtml(axisLabel(tick, span))}</text>`)
  }

  for (const item of items) {
    const color = STATUS_HEX[item.status] ?? '#64748b'
    const y = top + item.lane * laneHeight + 9
    const bx = x(item.start)
    const bw = Math.max(4, x(item.end) - bx)
    parts.push(`<rect x="${bx.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${laneHeight - 18}" rx="4" fill="${color}" opacity="${item.live ? 0.55 : 0.88}"><title>${escapeHtml(`${item.id} · ${item.status} · ${formatDuration(item.duration)}`)}</title></rect>`)
    if (bw > 74) {
      parts.push(`<text x="${(bx + 7).toFixed(1)}" y="${y + 14}" class="lane-label" fill="#ffffff">${escapeHtml(shortId(item.id))}</text>`)
    }
  }

  parts.push('</svg>')
  return parts.join('')
}

/** Round a value up to a 1/2/5 × 10^n axis maximum. */
function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const scaled = value / power
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return factor * power
}

/**
 * Cumulative step chart. Events land at each run's end time, so the curve
 * answers "how much had this window spent by 09:15?" without pretending to
 * know the intra-run shape that the run files do not record.
 *
 * @param {Array<{ t: number, value: number }>} events - sorted by time.
 * @param {{ start: number, end: number, color: string, ticks: number[], formatter?: (value: number) => string, empty?: string, title: string }} options
 */
function curveSvg(events, options) {
  const width = 620
  const height = 220
  const left = 58
  const right = 16
  const top = 20
  const bottom = 38
  const plotW = width - left - right
  const plotH = height - top - bottom
  const start = options.start
  const end = options.end
  const span = Math.max(1, end - start)
  const x = time => left + ((time - start) / span) * plotW
  const eventsWithValue = events.filter(event => Number.isFinite(event.value))
  const total = eventsWithValue.reduce((sum, event) => sum + event.value, 0)
  const max = niceMax(total)
  const y = value => top + plotH - (value / max) * plotH
  const format = options.formatter ?? (value => formatCount(value))
  const parts = []

  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title)}">`)
  parts.push(`<rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" fill="#f8fafc" rx="6"/>`)

  for (let index = 0; index <= 4; index++) {
    const value = (max / 4) * index
    const gy = y(value).toFixed(1)
    parts.push(`<line x1="${left}" y1="${gy}" x2="${left + plotW}" y2="${gy}" stroke="#e8edf3" stroke-width="1"/>`)
    parts.push(`<text x="${left - 10}" y="${Number(gy) + 4}" text-anchor="end" class="axis" fill="#94a3b8">${escapeHtml(format(value))}</text>`)
  }

  for (const tick of options.ticks) {
    const gx = x(tick).toFixed(1)
    parts.push(`<line x1="${gx}" y1="${top}" x2="${gx}" y2="${top + plotH}" stroke="#eef1f5" stroke-width="1"/>`)
    parts.push(`<text x="${gx}" y="${height - 12}" text-anchor="middle" class="axis" fill="#94a3b8">${escapeHtml(axisLabel(tick, span))}</text>`)
  }

  if (eventsWithValue.length === 0) {
    parts.push(`<text x="${(left + plotW / 2).toFixed(1)}" y="${(top + plotH / 2).toFixed(1)}" text-anchor="middle" class="empty">${escapeHtml(options.empty ?? 'no data')}</text>`)
    parts.push('</svg>')
    return parts.join('')
  }

  let cursor = 0
  let path = `M ${x(start).toFixed(1)} ${y(0).toFixed(1)}`
  for (const event of eventsWithValue) {
    cursor += event.value
    path += ` H ${x(event.t).toFixed(1)} V ${y(cursor).toFixed(1)}`
  }
  path += ` H ${x(end).toFixed(1)}`

  parts.push(`<path d="${path} V ${y(0).toFixed(1)} H ${x(start).toFixed(1)} Z" fill="${options.color}" opacity="0.10"/>`)
  parts.push(`<path d="${path}" fill="none" stroke="${options.color}" stroke-width="2" stroke-linejoin="round"/>`)

  let running = 0
  for (const event of eventsWithValue) {
    running += event.value
    parts.push(`<circle cx="${x(event.t).toFixed(1)}" cy="${y(running).toFixed(1)}" r="3" fill="#ffffff" stroke="${options.color}" stroke-width="2"><title>${escapeHtml(`${stampUtc(event.t)} · ${format(event.value)} (total ${format(running)})`)}</title></circle>`)
  }

  parts.push('</svg>')
  return parts.join('')
}

/** Outcome word and symbol for the last recorded attempt of a worker. */
function outcomeOf(chain) {
  if (chain.status === 'completed') return { symbol: '✓', tone: 'ok', text: chain.recovered ? `recovered on attempt ${chain.attempts}` : 'completed' }
  if (chain.status === 'failed') return { symbol: '✕', tone: 'bad', text: `failed after ${chain.attempts} attempt${chain.attempts === 1 ? '' : 's'}` }
  if (chain.status === 'running') return { symbol: '▶', tone: 'live', text: `running · attempt ${chain.attempts}` }
  return { symbol: '…', tone: 'idle', text: `still open · ${chain.attempts} attempt${chain.attempts === 1 ? '' : 's'} spent` }
}

/**
 * Failure and retry chains: which worker failed, how many attempts it burned,
 * and what it ended as. Only runs that actually retried or failed are listed,
 * so a healthy window says so in one line instead of drawing empty boxes.
 */
function retriesSection(items) {
  const blocks = []
  for (const item of [...items].sort((a, b) => b.end - a.end)) {
    const chains = retryChainsOf(item.run)
    const heal = item.run?.selfHeal
    if (chains.length === 0 && !heal) continue
    const attempts = chains.reduce((sum, chain) => sum + chain.attempts, 0)
    const color = STATUS_HEX[item.status] ?? '#64748b'
    blocks.push([
      '<article class="retry">',
      '<div class="retry-head">',
      `<span class="chip" style="background:${color}">${escapeHtml(item.status.toUpperCase())}</span>`,
      `<span class="rid">${escapeHtml(item.id)}</span>`,
      `<span class="when">${escapeHtml(stampUtc(item.start))} UTC · ${escapeHtml(formatDuration(item.duration))}</span>`,
      `<span class="tally">${chains.length} worker${chains.length === 1 ? '' : 's'} · ${attempts} attempt${attempts === 1 ? '' : 's'}</span>`,
      '</div>',
      heal
        ? `<div class="selfheal">self-heal round ${escapeHtml(String(heal.rounds ?? 1))} · retried ${escapeHtml(String(heal.retried ?? 0))} · recovered ${escapeHtml(String(heal.recovered ?? 0))}${heal.model ? ` · on <code>${escapeHtml(heal.model)}</code>` : ''}</div>`
        : '',
      item.run?.recovery?.previousStatus
        ? `<div class="selfheal">resumed after an earlier <code>${escapeHtml(String(item.run.recovery.previousStatus))}</code> attempt</div>`
        : '',
      ...chains.map(chain => {
        const outcome = outcomeOf(chain)
        const steps = []
        for (let attempt = 1; attempt <= chain.attempts; attempt++) {
          const last = attempt === chain.attempts
          const tone = last ? outcome.tone : 'bad'
          steps.push(`<span class="step ${tone}">${attempt} ${last ? outcome.symbol : '✕'}</span>`)
        }
        return [
          '<div class="retry-worker">',
          `<div class="worker-head"><span class="widx">#${escapeHtml(String(chain.index))}</span> ${escapeHtml(chain.title)}`,
          `<span class="outcome ${outcome.tone}">${escapeHtml(outcome.text)}</span></div>`,
          `<div class="chain">${steps.join('<span class="arrow">→</span>')}</div>`,
          chain.error
            ? `<div class="worker-error"><code>${escapeHtml(chain.error)}</code></div>`
            : chain.stopReason
              ? `<div class="worker-error">child stopped with reason <code>${escapeHtml(chain.stopReason)}</code></div>`
              : '',
          '</div>',
        ].join('')
      }),
      '</article>',
    ].join(''))
    if (blocks.length === 12) break
  }

  if (blocks.length === 0) {
    return '<p class="hint">No retries and no failed workers in this window: every started worker finished on its first attempt.</p>'
  }
  const note = blocks.length > 0 && items.length > blocks.length
    ? `<p class="hint">Showing the ${blocks.length} most recent runs with retries or failures.</p>`
    : ''
  return `<div class="retries">${blocks.join('')}</div>${note}`
}

/**
 * Worker time share: how the run's wall clock was distributed across its
 * workers. Shares are per worker against the run's wall clock, so parallel
 * workers add up past 100%; the parallelism factor is that sum.
 */
function workersSection(items, now) {
  const rows = []
  for (const item of [...items].sort((a, b) => b.duration - a.duration)) {
    const shares = workerShares(item, now)
    if (shares.workers.length === 0) continue
    const color = STATUS_HEX[item.status] ?? '#64748b'
    const segments = []
    let cursor = 0
    shares.workers.forEach((worker, index) => {
      const wx = shares.busy > 0 ? (worker.span / shares.busy) * 1080 : 0
      const fill = WORKER_COLORS[index % WORKER_COLORS.length]
      if (wx > 0) {
        segments.push(`<rect x="${cursor.toFixed(1)}" y="4" width="${Math.max(1, wx).toFixed(1)}" height="18" rx="3" fill="${fill}"><title>${escapeHtml(`${worker.title} · ${formatDuration(worker.span)} · ${percent(worker.share)} of the run's wall clock`)}</title></rect>`)
      }
      cursor += wx
    })
    const listed = shares.workers.slice(0, 6)
    const rest = shares.workers.length - listed.length
    rows.push([
      '<div class="workers-run">',
      '<div class="workers-head">',
      `<span class="chip" style="background:${color}">${escapeHtml(item.status)}</span>`,
      `<span class="rid">${escapeHtml(item.id)}</span>`,
      `<span class="when">wall ${escapeHtml(formatDuration(shares.wall))} · workers busy ${escapeHtml(formatDuration(shares.busy))} · ${shares.parallelism.toFixed(2)}× parallel</span>`,
      '</div>',
      `<svg viewBox="0 0 1080 26" role="img" aria-label="${escapeHtml(`${shares.workers.length} workers of ${item.id} by share of total worker time`)}">`,
      '<rect x="0" y="4" width="1080" height="18" rx="6" fill="#f1f5f9"/>',
      segments.join(''),
      '</svg>',
      '<ul class="worker-list">',
      ...listed.map((worker, index) => {
        const fill = WORKER_COLORS[index % WORKER_COLORS.length]
        const outcome = worker.status === 'completed' ? 'done' : worker.status === 'failed' ? 'failed' : worker.status
        return [
          '<li>',
          `<i class="swatch" style="background:${fill}"></i>`,
          `<span class="wtitle">#${escapeHtml(String(worker.index))} ${escapeHtml(worker.title)}</span>`,
          `<span class="wmeta">${escapeHtml(outcome)}${worker.attempts > 1 ? ` · ${escapeHtml(String(worker.attempts))} attempts` : ''} · ${escapeHtml(formatDuration(worker.span))} · ${escapeHtml(percent(worker.share))}</span>`,
          '</li>',
        ].join('')
      }),
      rest > 0 ? `<li class="more">+${rest} more worker${rest === 1 ? '' : 's'} in the bar above</li>` : '',
      '</ul>',
      '</div>',
    ].join(''))
    if (rows.length === 10) break
  }

  if (rows.length === 0) {
    return '<p class="hint">No worker timings recorded: these runs never started a subtask, or their subtasks carry no <code>startedAt</code>.</p>'
  }
  return `<div class="workers">${rows.join('')}</div>`
}

/** One stat card. */
function card(label, value, note, accent) {
  return [
    '<div class="card">',
    `<div class="card-label">${escapeHtml(label)}</div>`,
    `<div class="card-value"${accent ? ` style="color:${accent}"` : ''}>${escapeHtml(value)}</div>`,
    `<div class="card-note">${escapeHtml(note)}</div>`,
    '</div>',
  ].join('')
}

const CSS = `
:root {
  color-scheme: light;
  --ink: #0f172a;
  --muted: #64748b;
  --line: #e5e9f0;
  --card: #ffffff;
  --accent: #0f766e;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #f4f6fa;
  background-image: radial-gradient(900px 420px at 12% -8%, #e6f2f1 0%, rgba(230,242,241,0) 70%),
                    radial-gradient(760px 380px at 96% 4%, #eef0fb 0%, rgba(238,240,251,0) 66%);
  color: var(--ink);
  font: 14px/1.55 ${SVG_FONT};
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 1280px; margin: 0 auto; padding: 44px 32px 64px; }
.masthead { margin-bottom: 26px; }
.eyebrow {
  font: 600 11px/1 ${MONO_FONT};
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--accent);
}
h1 { font-size: 34px; line-height: 1.15; letter-spacing: -.02em; margin: 12px 0 8px; }
.lede { margin: 0; max-width: 760px; color: #475569; font-size: 15px; }
.meta { margin-top: 14px; font: 12px/1.5 ${MONO_FONT}; color: #7c8899; }
.cards { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin: 26px 0 22px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px 13px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.card-label { font: 600 10px/1 ${MONO_FONT}; letter-spacing: .12em; text-transform: uppercase; color: #8b98a9; }
.card-value { font-size: 26px; font-weight: 650; letter-spacing: -.02em; margin: 9px 0 4px; font-variant-numeric: tabular-nums; }
.card-note { font-size: 11.5px; color: var(--muted); }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px 16px; margin-bottom: 18px; box-shadow: 0 1px 2px rgba(15,23,42,.04); }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 18px; margin-bottom: 10px; flex-wrap: wrap; }
.panel h2 { font-size: 15px; letter-spacing: -.01em; margin: 0; }
.panel .hint { font-size: 12px; color: var(--muted); }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11.5px; color: #5b6b7f; margin: 4px 0 6px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
figure { margin: 0; overflow-x: auto; }
svg { display: block; width: 100%; height: auto; min-width: 720px; }
svg text { font-family: ${SVG_FONT}; }
svg .axis { font-family: ${MONO_FONT}; font-size: 10px; }
svg .id { font-family: ${MONO_FONT}; font-size: 11px; font-weight: 600; }
svg .meta { font-family: ${MONO_FONT}; font-size: 9.5px; letter-spacing: .04em; }
svg .mark { font-size: 10px; font-weight: 600; }
svg .lane-label { font-family: ${MONO_FONT}; font-size: 9.5px; }
svg .empty { font-size: 12px; fill: #94a3b8; }
.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.charts .panel { margin-bottom: 18px; }
.charts svg { min-width: 0; }
.failures { display: grid; gap: 10px; }
.failure { border: 1px solid var(--line); border-left: 3px solid #b91c1c; border-radius: 8px; padding: 10px 13px; background: #fff; }
.failure.cancelled { border-left-color: #7e22ce; }
.failure.interrupted { border-left-color: #c2410c; }
.failure.partial { border-left-color: #b45309; }
.failure-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font: 600 11.5px/1.4 ${MONO_FONT}; }
.failure-head .chip { font-size: 9.5px; letter-spacing: .06em; padding: 2px 7px; border-radius: 999px; color: #fff; }
.failure-body { margin-top: 6px; font-size: 12.5px; color: #475569; }
.failure-body code { font-family: ${MONO_FONT}; font-size: 11.5px; background: #f4f6fa; padding: 1px 5px; border-radius: 4px; }
.failure .when { color: #8b98a9; font-weight: 400; }
.retries { display: grid; gap: 12px; }
.retry { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; background: #fff; }
.retry-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font: 600 11.5px/1.4 ${MONO_FONT}; }
.retry-head .when, .retry-head .tally { color: #8b98a9; font-weight: 400; }
.selfheal { margin-top: 9px; font-size: 12px; color: #475569; border-left: 3px solid #b45309; padding: 2px 0 2px 9px; }
.selfheal code { font-family: ${MONO_FONT}; font-size: 11.5px; background: #f4f6fa; padding: 1px 5px; border-radius: 4px; }
.retry-worker { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #eef1f5; }
.worker-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #1e293b; flex-wrap: wrap; }
.worker-head .widx { font: 600 10.5px ${MONO_FONT}; color: #8b98a9; }
.worker-head .outcome { font: 600 10px ${MONO_FONT}; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; }
.outcome.ok { color: #15803d; background: #dcfce7; }
.outcome.bad { color: #b91c1c; background: #fee2e2; }
.outcome.live { color: #0284c7; background: #e0f2fe; }
.outcome.idle { color: #b45309; background: #fef3c7; }
.chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.step { font: 600 11px ${MONO_FONT}; padding: 3px 9px; border-radius: 6px; border: 1px solid transparent; }
.step.ok { color: #15803d; background: #f0fdf4; border-color: #bbf7d0; }
.step.bad { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }
.step.live { color: #0284c7; background: #f0f9ff; border-color: #bae6fd; }
.step.idle { color: #b45309; background: #fffbeb; border-color: #fde68a; }
.arrow { color: #cbd5e1; font-size: 12px; }
.worker-error { margin-top: 7px; font-size: 12px; color: #475569; }
.worker-error code { font-family: ${MONO_FONT}; font-size: 11.5px; background: #fef2f2; color: #991b1b; padding: 1px 5px; border-radius: 4px; }
.workers { display: grid; gap: 16px; }
.workers-run { border-top: 1px solid #f1f4f8; padding-top: 12px; }
.workers-run:first-child { border-top: 0; padding-top: 0; }
.workers-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font: 600 11.5px/1.4 ${MONO_FONT}; margin-bottom: 8px; }
.workers-head .when { color: #8b98a9; font-weight: 400; }
.workers svg { min-width: 0; }
.worker-list { list-style: none; margin: 10px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 5px 20px; }
.worker-list li { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #334155; min-width: 0; }
.worker-list .wtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.worker-list .wmeta { margin-left: auto; color: #8b98a9; font: 11px ${MONO_FONT}; white-space: nowrap; }
.worker-list .more { color: #8b98a9; font-size: 11.5px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; font: 600 10px/1 ${MONO_FONT}; letter-spacing: .1em; text-transform: uppercase; color: #8b98a9; padding: 0 10px 9px; border-bottom: 1px solid var(--line); }
td { padding: 10px; border-bottom: 1px solid #f1f4f8; vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num { text-align: right; font-family: ${MONO_FONT}; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.id { font-family: ${MONO_FONT}; font-size: 11.5px; white-space: nowrap; }
.goal { display: block; max-width: 520px; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { display: inline-block; padding: 2px 8px; border-radius: 999px; font: 600 10px/1.6 ${MONO_FONT}; letter-spacing: .05em; color: #fff; }
footer { margin-top: 26px; color: #8b98a9; font-size: 11.5px; line-height: 1.7; }
footer code { font-family: ${MONO_FONT}; }
@media (max-width: 1100px) {
  .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 680px) {
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .charts { grid-template-columns: 1fr; }
  .page { padding: 28px 16px 44px; }
  h1 { font-size: 26px; }
}
@media print {
  body { background: #fff; }
  .page { max-width: none; padding: 0; }
  .panel, .card { box-shadow: none; break-inside: avoid; }
}
`

/**
 * Build the full report.
 *
 * @param {object[]} runs - run records, any order.
 * @param {{ title?: string, generatedAt?: number, now?: number, subtitle?: string }} [options]
 * @returns {string} a complete HTML document with no external references.
 */
export function buildReport(runs, options = {}) {
  const now = options.now ?? Date.now()
  const generatedAt = options.generatedAt ?? now
  const items = prepare(runs, now)
  const summary = summarize(items)
  const start = summary.start
  const end = summary.end
  const span = Math.max(1, summary.span)
  const { ticks } = axisTicks(start, end)
  const laneCount = assignLanes(items)
  const title = options.title ?? 'Superagent run report'
  const finished = items.filter(item => !ACTIVE_STATUSES.has(item.status)).length
  const windowText = items.length > 0 ? `${stampUtc(start)} → ${stampUtc(end)} UTC` : 'no runs'

  const events = items
    .filter(item => item.calls > 0)
    .map(item => ({ t: item.end, value: item.calls }))
    .sort((a, b) => a.t - b.t)
  const costEvents = items
    .filter(item => item.cost !== null && item.cost > 0)
    .map(item => ({ t: item.end, value: item.cost }))
    .sort((a, b) => a.t - b.t)

  const problemRuns = items
    .filter(item => ['failed', 'cancelled', 'interrupted', 'partial'].includes(item.status))
    .sort((a, b) => b.end - a.end)

  const statusCards = [
    card('Runs', String(items.length), `${finished} finished · ${items.length - finished} live`),
    card('Completed', String(summary.byStatus.completed ?? 0), `${summary.byStatus.partial ?? 0} partial`, '#15803d'),
    card('Failed', String(summary.byStatus.failed ?? 0), `${summary.byStatus.cancelled ?? 0} cancelled · ${summary.byStatus.interrupted ?? 0} interrupted`, '#b91c1c'),
    card('Model calls', formatCount(summary.calls), 'measured from child sessions'),
    card('Tokens', formatCount(summary.tokens), 'input + cache + output'),
    card('Cost', summary.priced === 0 ? 'unpriced' : money(summary.cost), summary.priced === 0 ? 'no configured price for these models' : `${summary.priced}/${items.length} runs priced`, '#0f766e'),
  ].join('')

  const cards = [
    '<section class="cards">',
    statusCards,
    '</section>',
  ].join('')

  const legend = [
    '<div class="legend">',
    `<span><i class="swatch" style="background:${STATUS_HEX.running}"></i> planning / running / aggregating</span>`,
    `<span><i class="swatch" style="background:${STATUS_HEX.completed}"></i> completed</span>`,
    `<span><i class="swatch" style="background:${STATUS_HEX.failed}"></i> failed</span>`,
    `<span><i class="swatch" style="background:${STATUS_HEX.cancelled}"></i> cancelled</span>`,
    `<span><i class="swatch" style="background:${STATUS_HEX.interrupted}"></i> interrupted</span>`,
    '<span><i class="swatch" style="background:#94a3b8;opacity:.38"></i> plan</span>',
    '<span><i class="swatch" style="background:#94a3b8"></i> work</span>',
    '<span><i class="swatch" style="background:#94a3b8;opacity:.66"></i> merge</span>',
    '</div>',
  ].join('')

  const failures = problemRuns.length === 0
    ? '<p class="hint">No failed, cancelled, interrupted, or partial runs in this window.</p>'
    : [
      '<div class="failures">',
      ...problemRuns.map(item => {
        const color = STATUS_HEX[item.status] ?? '#64748b'
        const detail = item.error
          ? escapeHtml(item.error)
          : item.status === 'cancelled'
            ? `Cancelled after ${escapeHtml(formatDuration(item.duration))}, ${escapeHtml(String(item.calls))} call(s) spent.`
            : item.status === 'interrupted'
              ? `The host went away after ${escapeHtml(formatDuration(item.duration))}; resume it with <code>superagent_resume</code>.`
              : `Ended after ${escapeHtml(formatDuration(item.duration))} without a recorded error.`
        return [
          `<div class="failure ${escapeHtml(item.status)}">`,
          `<div class="failure-head"><span class="chip" style="background:${color}">${escapeHtml(item.status.toUpperCase())}</span>`,
          `<span>${escapeHtml(item.id)}</span>`,
          `<span class="when">${escapeHtml(stampUtc(item.start))} UTC · ${escapeHtml(formatDuration(item.duration))}</span></div>`,
          `<div class="failure-body">${detail}</div>`,
          '</div>',
        ].join('')
      }),
      '</div>',
    ].join('')

  const rows = [...items].reverse().map(item => {
    const color = STATUS_HEX[item.status] ?? '#64748b'
    return [
      '<tr>',
      `<td class="id">${escapeHtml(item.id)}</td>`,
      `<td><span class="chip" style="background:${color}">${escapeHtml(item.status)}</span><span class="goal" title="${escapeHtml(item.goal)}">${escapeHtml(item.goal)}</span></td>`,
      `<td class="num">${escapeHtml(item.calls ? String(item.calls) : '—')}</td>`,
      `<td class="num">${escapeHtml(item.tokens ? formatCount(item.tokens) : '—')}</td>`,
      `<td class="num">${escapeHtml(money(item.cost))}</td>`,
      `<td class="num">${escapeHtml(formatDuration(item.duration))}</td>`,
      `<td class="id">${escapeHtml(item.parent.replace(/^session-/, '').slice(0, 8) || '—')}</td>`,
      '</tr>',
    ].join('')
  })

  const pricedNote = items.length === 0
    ? 'No runs matched this window.'
    : summary.unpriced > 0
      ? `Cost covers ${summary.priced} of ${items.length} runs; models without a configured price are left out rather than estimated.`
      : `Cost covers all ${items.length} runs at the prices configured by the operator.`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="page">
  <header class="masthead">
    <div class="eyebrow">dsh-superagent · run report</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="lede">${escapeHtml(options.subtitle ?? `${items.length} run${items.length === 1 ? '' : 's'} of model-planned parallel subtasks, rendered from the durable run store.`)}</p>
    <div class="meta">${escapeHtml(windowText)} · generated ${escapeHtml(stampUtc(generatedAt))} UTC · peak concurrency ${laneCount} · ${formatCount(summary.calls)} model calls</div>
  </header>
  ${cards}
  <section class="panel" id="timeline">
    <div class="panel-head"><h2>Timeline</h2><span class="hint">one row per run · phases derived from subtask timestamps · ${escapeHtml(formatDuration(summary.span))} window</span></div>
    ${legend}
    <figure>${timelineSvg(items, { start, end, ticks })}</figure>
  </section>
  <section class="panel" id="lanes">
    <div class="panel-head"><h2>Concurrency</h2><span class="hint">${laneCount} lane${laneCount === 1 ? '' : 's'} · overlapping runs never share a lane</span></div>
    <figure>${lanesSvg(items, { start, end, ticks, lanes: laneCount })}</figure>
  </section>
  <section class="panel" id="retries">
    <div class="panel-head"><h2>Failure &amp; retry chains</h2><span class="hint">which worker failed · attempts spent · what it ended as</span></div>
    ${retriesSection(items)}
    <p class="hint">A run file keeps the latest error per worker, so earlier attempts are counted but cannot quote their own message. A self-heal round resets a worker's attempt counter, which is why its steps describe the latest round.</p>
  </section>
  <div class="charts">
    <section class="panel" id="calls">
      <div class="panel-head"><h2>Model calls</h2><span class="hint">cumulative at each run's end</span></div>
      <figure>${curveSvg(events, { start, end, ticks, color: '#0284c7', title: 'Cumulative model calls', empty: 'no model calls recorded' })}</figure>
      <p class="hint">${escapeHtml(`${summary.calls} calls across ${items.length} run(s), measured from child session usage logs.`)}</p>
    </section>
    <section class="panel" id="cost">
      <div class="panel-head"><h2>Cost</h2><span class="hint">cumulative at each run's end</span></div>
      <figure>${curveSvg(costEvents, { start, end, ticks, color: '#0f766e', title: 'Cumulative cost', formatter: value => money(value), empty: 'no priced runs' })}</figure>
      <p class="hint">${escapeHtml(pricedNote)}</p>
    </section>
  </div>
  <section class="panel" id="workers">
    <div class="panel-head"><h2>Worker time share</h2><span class="hint">each worker's span against the run's wall clock · bar = share of total worker time</span></div>
    ${workersSection(items, now)}
  </section>
  <section class="panel" id="failures">
    <div class="panel-head"><h2>Failures &amp; cancellations</h2><span class="hint">every run that did not complete normally</span></div>
    ${failures}
  </section>
  <section class="panel" id="runs">
    <div class="panel-head"><h2>Runs</h2><span class="hint">newest first · times in UTC</span></div>
    <div class="table-wrap">
    <table>
      <thead><tr><th>Run</th><th>Status &amp; goal</th><th style="text-align:right">Calls</th><th style="text-align:right">Tokens</th><th style="text-align:right">Cost</th><th style="text-align:right">Duration</th><th>Parent</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    </div>
  </section>
  <footer>
    Self-contained report: inline CSS and inline SVG, no scripts, no external fonts or images, no network access.
    Phases are inferred from <code>startedAt</code>/<code>finishedAt</code> of the run and its subtasks; a run file does not record phase boundaries directly.
    Cost is computed only from operator-configured prices — unpriced models are reported as unpriced, never as zero.
    Generated by <code>dsh-superagent-report</code> from <code>${escapeHtml(items.length)}</code> run file(s).
  </footer>
</main>
</body>
</html>
`
}
