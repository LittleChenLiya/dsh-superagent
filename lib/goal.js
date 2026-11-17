/**
 * Goal mode: keep a run going until its acceptance conditions are met, or until
 * a hard stop means a human has to decide.
 *
 * This module owns everything goal-specific: validating the acceptance spec,
 * running the machine-checkable part so the verdict rests on a real exit code
 * instead of a model's claim, judging only the conditions no machine can check,
 * deciding whether a round made progress, and writing the stop report.
 *
 * The orchestrator owns scheduling, budget, and notification; nothing here
 * wakes a session. That separation is what makes "one notification at the end,
 * none between rounds" a property of the wiring rather than a promise.
 *
 * @module dsh-superagent/goal
 */
import { exec, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Rounds a goal run may take when the caller names no cap. */
export const DEFAULT_MAX_ROUNDS = 5
/** Wall-clock cap when the caller names none, in minutes. */
export const DEFAULT_MAX_WALL_CLOCK_MINUTES = 60
/** Identical failing rounds tolerated before the loop calls it a stall. */
export const DEFAULT_NO_PROGRESS_ROUNDS = 2
/** Acceptance conditions are few by design; a long list is a badly framed goal. */
export const MAX_ACCEPTANCE_ITEMS = 12
/** Upper bound on one machine check, in seconds. */
const MAX_CHECK_TIMEOUT_S = 900
const DEFAULT_CHECK_TIMEOUT_S = 120
/** Output kept from one check; the tail is where the failure is. */
const CHECK_OUTPUT_CHARS = 3000
/** Untracked files hashed for the change fingerprint; a bound, not a promise. */
const UNTRACKED_MAX = 50

/** Collapse arbitrary text into one bounded line, like the orchestrator does. */
function oneLine(value, maxChars = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return [...text].slice(0, maxChars).join('')
}

/** Keep the end of a command's output: that is where the error is. */
function tail(value, maxChars = CHECK_OUTPUT_CHARS) {
  const text = String(value ?? '').trim()
  if (text.length <= maxChars) return text
  return `…${text.slice(-maxChars)}`
}

function numberIn(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number, got ${JSON.stringify(value)}`)
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function requiredText(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${label} is required`)
  return text
}

/**
 * Validate one machine check.
 *
 * A bare string is accepted as a command because that is how people write an
 * acceptance condition ("run npm test"); everything else is an explicit object
 * so a condition cannot silently become a different kind of check later.
 *
 * @param {unknown} raw - check from the caller.
 * @param {number} index - position, used in error messages.
 * @returns {object | null} normalized check, or null for a model-judged item.
 */
function normalizeCheck(raw, index) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'string') {
    return { type: 'command', command: raw.trim(), cwd: null, timeoutSeconds: DEFAULT_CHECK_TIMEOUT_S }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`acceptance[${index}].check must be a command string or an object`)
  }
  const type = String(raw.type ?? '').trim().toLowerCase()
  if (type === 'command') {
    return {
      type: 'command',
      command: requiredText(raw.command, `acceptance[${index}].check.command`),
      cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
      timeoutSeconds: numberIn(
        raw.timeoutSeconds,
        DEFAULT_CHECK_TIMEOUT_S,
        1,
        MAX_CHECK_TIMEOUT_S,
        `acceptance[${index}].check.timeoutSeconds`,
      ),
    }
  }
  if (type === 'file') {
    return {
      type: 'file',
      path: requiredText(raw.path, `acceptance[${index}].check.path`),
      mustExist: raw.mustExist !== false,
    }
  }
  throw new Error(
    `acceptance[${index}].check.type ${JSON.stringify(raw.type)} is unknown; use "command" or "file", `
    + 'or omit check to have the acceptance model judge the condition',
  )
}

/** One acceptance condition: an id, the text a person reads, and an optional check. */
function normalizeAcceptanceEntry(raw, index, seen) {
  const source = typeof raw === 'string' ? { text: raw } : raw
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`acceptance[${index}] must be a string or an object with "text"`)
  }
  const text = requiredText(source.text ?? source.description ?? source.condition, `acceptance[${index}].text`)
  const id = oneLine(source.id, 40) || `a${index + 1}`
  if (seen.has(id)) throw new Error(`acceptance ids must be unique; "${id}" appears twice`)
  seen.add(id)
  return { id, text: oneLine(text, 600), check: normalizeCheck(source.check, index) }
}

/**
 * Canonical goal spec.
 *
 * Limits can only narrow what the operator allows: a caller naming a round
 * count below 1 gets 1 rather than an unbounded loop. `cwd` is resolved once
 * here so every round checks and fingerprints the same workspace.
 *
 * @param {unknown} value - requested goal mode.
 * @returns {object} normalized spec.
 */
export function normalizeGoalSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('goal_mode requires an object with acceptance conditions and optional limits')
  }
  const entries = Array.isArray(value.acceptance) ? value.acceptance : []
  if (entries.length === 0) {
    throw new Error('goal_mode requires at least one acceptance condition; without one, the run cannot know it is done')
  }
  if (entries.length > MAX_ACCEPTANCE_ITEMS) {
    throw new Error(`goal_mode accepts at most ${MAX_ACCEPTANCE_ITEMS} acceptance conditions`)
  }
  const seen = new Set()
  const acceptance = entries.map((entry, index) => normalizeAcceptanceEntry(entry, index, seen))
  const budget = value.budget && typeof value.budget === 'object'
    ? {
        maxModelCalls: value.budget.maxModelCalls === undefined || value.budget.maxModelCalls === null
          ? null
          : numberIn(value.budget.maxModelCalls, null, 0, 10000, 'budget.maxModelCalls'),
        maxTokens: value.budget.maxTokens === undefined || value.budget.maxTokens === null
          ? null
          : numberIn(value.budget.maxTokens, null, 0, 1e12, 'budget.maxTokens'),
      }
    : null
  return {
    acceptance,
    maxRounds: numberIn(value.maxRounds, DEFAULT_MAX_ROUNDS, 1, 20, 'maxRounds'),
    maxWallClockMinutes: numberIn(
      value.maxWallClockMinutes,
      DEFAULT_MAX_WALL_CLOCK_MINUTES,
      1,
      720,
      'maxWallClockMinutes',
    ),
    noProgressRounds: numberIn(value.noProgressRounds, DEFAULT_NO_PROGRESS_ROUNDS, 1, 10, 'noProgressRounds'),
    budget: budget && (budget.maxModelCalls !== null || budget.maxTokens !== null) ? budget : null,
    cwd: typeof value.cwd === 'string' && value.cwd.trim() ? path.resolve(value.cwd.trim()) : null,
  }
}

/** Run one command and resolve with the outcome instead of throwing. */
function execCommand(command, options) {
  return new Promise(resolve => {
    const started = Date.now()
    exec(command, { ...options, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, durationMs: Date.now() - started })
    })
  })
}

/** Machine check: a command whose exit code is the verdict. */
async function checkCommand(item, base, signal) {
  const check = item.check
  const cwd = check.cwd ? path.resolve(base, check.cwd) : base
  const started = Date.now()
  if (signal?.aborted) {
    return {
      id: item.id,
      text: item.text,
      source: 'command',
      ok: false,
      exitCode: null,
      durationMs: 0,
      detail: 'not run: the run was stopping when this check was due',
    }
  }
  const outcome = await execCommand(check.command, {
    cwd,
    timeout: check.timeoutSeconds * 1000,
    signal: signal ?? undefined,
  })
  const timedOut = Boolean(outcome.error?.killed)
  const exitCode = outcome.error
    ? (typeof outcome.error.code === 'number' ? outcome.error.code : null)
    : 0
  const ok = !outcome.error
  const output = tail(outcome.stderr || '') || tail(outcome.stdout || '')
  let detail
  if (ok) detail = `exit 0 in ${outcome.durationMs} ms`
  else if (timedOut) detail = `timed out after ${check.timeoutSeconds}s`
  else if (exitCode === null) detail = oneLine(outcome.error?.message ?? 'the command could not be started', 500)
  else detail = `exit ${exitCode}${output ? `: ${oneLine(output, 600)}` : ''}`
  return {
    id: item.id,
    text: item.text,
    source: 'command',
    command: check.command,
    ok,
    exitCode,
    durationMs: outcome.durationMs ?? (Date.now() - started),
    detail,
  }
}

/** Machine check: does a path exist (or, with mustExist false, is it gone). */
async function checkFile(item, base) {
  const target = path.resolve(base, item.check.path)
  let exists = true
  try {
    await fsp.access(target)
  } catch {
    exists = false
  }
  const ok = item.check.mustExist ? exists : !exists
  return {
    id: item.id,
    text: item.text,
    source: 'file',
    path: target,
    ok,
    exitCode: null,
    durationMs: 0,
    detail: exists ? 'the file exists' : 'the file is missing',
  }
}

/**
 * Run every machine-checkable acceptance condition in order.
 *
 * Conditions without a check are returned with `ok: null` and `source: "model"`
 * — they are not silently treated as passed. The command's real exit code and a
 * bounded tail of its output are recorded on each item, so the report can say
 * what was actually run and what it printed.
 *
 * @param {object} goalSpec - normalized goal spec.
 * @param {{ signal?: AbortSignal | null }} [options] - abort signal of the run.
 * @returns {Promise<object[]>} one result per acceptance condition, in order.
 */
export async function runChecks(goalSpec, { signal = null } = {}) {
  const base = goalSpec.cwd ?? process.cwd()
  const results = []
  for (const item of goalSpec.acceptance) {
    if (!item.check) {
      results.push({ id: item.id, text: item.text, source: 'model', ok: null, exitCode: null, durationMs: 0, detail: null })
      continue
    }
    results.push(item.check.type === 'file'
      ? await checkFile(item, base)
      : await checkCommand(item, base, signal))
  }
  return results
}

/** Run one read-only git command in a workspace. */
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Fingerprint the workspace so two rounds can be compared.
 *
 * Status and diffs alone miss an edit that rewrites an untracked file, which is
 * exactly the shape of a first attempt. Untracked file contents are therefore
 * hashed as well, up to a bound. A directory that is not a git repository gives
 * `null`: "cannot tell" must never be reported as "nothing changed".
 *
 * @param {string | null} cwd - workspace to fingerprint.
 * @returns {Promise<string | null>} hex digest, or null outside a repository.
 */
export async function fingerprintWorkspace(cwd) {
  if (!cwd) return null
  try {
    const [status, diff, staged, untrackedRaw] = await Promise.all([
      git(cwd, ['status', '--porcelain=v1', '-uall']),
      git(cwd, ['diff']),
      git(cwd, ['diff', '--cached']),
      git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    const hash = createHash('sha256')
    hash.update(status).update('\0').update(diff).update('\0').update(staged)
    const untracked = untrackedRaw.split('\0').filter(Boolean).sort().slice(0, UNTRACKED_MAX)
    for (const file of untracked) {
      hash.update('\0').update(file).update('\0')
      try {
        const data = await fsp.readFile(path.join(cwd, file))
        hash.update(createHash('sha256').update(data).digest('hex'))
      } catch {
        hash.update('unreadable')
      }
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

/** True when at least one condition is checked by the runtime itself. */
export function hasMachineChecks(goalSpec) {
  return (goalSpec?.acceptance ?? []).some(item => Boolean(item.check))
}

/**
 * The goal text every prompt in a round sees.
 *
 * Round one gets the acceptance conditions too, not only the failure feedback:
 * a worker that does not know what will be checked cannot aim at it. The
 * original `run.goal` stays untouched on the record, so dedupe, status, and the
 * report keep showing what the user asked for.
 *
 * @param {object} run - run record.
 * @returns {string} goal plus acceptance conditions plus, after a failed round, the feedback.
 */
export function roundGoal(run) {
  const goalMode = run?.goalMode
  if (!goalMode) return String(run?.goal ?? '')
  const conditions = (goalMode.acceptance ?? []).map(item => {
    const how = item.check
      ? `checked by the runtime (${item.check.type === 'command' ? `\`${item.check.command}\`` : `file ${item.check.path}`})`
      : 'judged by an independent acceptance model from your report'
    return `- [${item.id}] ${item.text} (${how})`
  })
  const parts = [
    String(run.goal ?? ''),
    '',
    'Acceptance conditions for this goal. The run is only finished when every one holds:',
    ...conditions,
  ]
  const feedback = goalMode.nextInstruction
  if (feedback) parts.push('', feedback)
  return parts.join('\n')
}

/**
 * Prompt for the independent acceptance judge.
 *
 * The judge sees the machine results but is not asked to re-run them: an exit
 * code is not an opinion. It judges only the listed model-only conditions, and
 * its `next` is the concrete change the following round must make.
 *
 * @param {object} run - run record.
 * @param {object} round - round record being judged.
 * @param {object[]} checks - machine and model check results.
 * @returns {string} prompt for the child.
 */
export function verifierPrompt(run, round, checks) {
  const judged = checks.filter(check => check.source === 'model')
  const machine = checks.filter(check => check.source !== 'model')
  return [
    'You are the independent acceptance judge of a long-horizon autonomous run.',
    'You did not do the work, so judge the evidence instead of trusting a claim that it is done.',
    '',
    'Goal:',
    roundGoal({ ...run, goalMode: { ...run.goalMode, nextInstruction: null } }),
    '',
    `Round ${round.round} report:`,
    capText(round.report ?? '(the round produced no report)', 8000),
    '',
    ...(machine.length > 0
      ? [
          'Conditions the runtime already checked by machine (do not re-judge these; the exit codes are final):',
          ...machine.map(check => `- ${check.ok ? 'PASS' : 'FAIL'} [${check.id}] ${check.text}: ${check.detail ?? ''}`),
          '',
        ]
      : []),
    'Conditions only you can judge:',
    ...judged.map(check => `- [${check.id}] ${check.text}`),
    '',
    'Rules:',
    '- Mark a condition met only when the report contains concrete evidence (the requested text itself, an artifact path, or a check result). A phrase quoted only from the goal or instructions is not a deliverable.',
    '- "achieved" is true only when every condition listed above is met.',
    '- "next" must say what to change in the next round: the file, the approach, or the missing evidence. Never write',
    '  "try again" or "improve it"; that is what the next round must not hear.',
    '',
    'Return ONLY this JSON object, with no prose and no code fences:',
    '{"achieved":false,"failed":[{"id":"a1","why":"one concrete reason"}],"next":"the concrete change for the next round"}',
  ].join('\n')
}

function capText(value, maxChars) {
  const text = String(value ?? '')
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…`
}

/** Pull a JSON object out of a fenced block, or out of the reply itself. */
function jsonCandidates(text) {
  const candidates = []
  for (const match of String(text ?? '').matchAll(/```[^\n]*\n([\s\S]*?)```/g)) candidates.push(match[1])
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  return candidates
}

/**
 * Parse the acceptance judge's verdict.
 *
 * An unusable reply is reported as an error instead of being read as "not
 * achieved": the difference between "the work failed" and "the judge failed"
 * decides whether another round is worth spending.
 *
 * @param {string} text - child reply.
 * @returns {{ verdict: { achieved: boolean, failed: object[], next: string | null } | null, error: string | null }}
 */
export function parseVerdict(text) {
  let lastError = 'the acceptance judge returned no JSON object'
  for (const candidate of jsonCandidates(text)) {
    let parsed
    try {
      parsed = JSON.parse(candidate)
    } catch (error) {
      lastError = `the acceptance judge returned invalid JSON: ${error?.message ?? error}`
      continue
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.achieved !== 'boolean') {
      lastError = 'the acceptance judge JSON has no boolean "achieved" field'
      continue
    }
    const failed = Array.isArray(parsed.failed)
      ? parsed.failed
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => ({ id: oneLine(entry.id, 40), why: oneLine(entry.why ?? entry.reason, 600) }))
        .filter(entry => entry.id)
      : []
    return {
      verdict: {
        achieved: parsed.achieved,
        failed,
        next: oneLine(parsed.next, 700) || null,
      },
      error: null,
    }
  }
  return { verdict: null, error: lastError }
}

/**
 * Decide whether a failed round shows progress.
 *
 * Two different failures are possible and they deserve different answers:
 * a round that changed no file cannot be repeated into a different outcome, so
 * it is a stall immediately; a round that changed something but failed the same
 * condition gets `noProgressRounds` attempts before the loop stops.
 *
 * @param {object} input - round evidence.
 * @param {object | null} input.previous - previous round record, or null.
 * @param {object[]} input.failed - failed conditions of this round.
 * @param {boolean | null} input.changed - whether the workspace fingerprint moved.
 * @param {boolean} input.machineChecked - whether the spec has machine checks.
 * @param {number} input.noProgressRounds - identical failing rounds tolerated.
 * @returns {{ signature: string, streak: number, stalled: string | null }}
 */
export function assessRound({ previous = null, failed = [], changed = null, machineChecked = false, noProgressRounds = 1 }) {
  const signature = failed.map(item => item.id).sort().join('|')
  if (failed.length === 0) return { signature, streak: 0, stalled: null }
  if (machineChecked && changed === false) {
    return { signature, streak: 1, stalled: 'no-changes' }
  }
  const same = Boolean(previous) && previous.failedSignature === signature
  const streak = same ? Math.max(1, Number(previous.streak) || 1) + 1 : 1
  return {
    signature,
    streak,
    stalled: same && streak >= noProgressRounds ? 'no-progress' : null,
  }
}

/**
 * The instruction the next round is built from.
 *
 * This is what makes round two different from round one: the exact conditions
 * that failed, what the check said, and the change the judge asked for. A
 * generic "try again" is deliberately not produced.
 *
 * @param {number} roundNumber - round that just failed.
 * @param {object[]} failed - failed conditions.
 * @param {string | null} next - concrete change from the judge, when there is one.
 * @returns {string} instruction appended to the next round's goal.
 */
export function buildRoundInstruction(roundNumber, failed, next = null) {
  return [
    `Previous round (round ${roundNumber}) did not meet the acceptance conditions.`,
    'Still failing:',
    ...failed.map(item => `- [${item.id}] ${item.text} — ${item.why}`),
    '',
    next
      ? `Do this differently in this round: ${next}`
      : 'Do this differently in this round: change the approach or the files that produced the failure above; '
        + 'repeating the same work will produce the same result.',
    'Do not repeat the previous attempt. The acceptance step will check the same conditions again.',
  ].join('\n')
}

const STOP_LABELS = {
  rounds: 'max rounds reached',
  'wall-clock': 'wall-clock limit reached',
  budget: 'budget reached',
  'no-changes': 'no progress: the round changed nothing',
  'no-progress': 'no progress: the same acceptance condition failed again',
  'needs-decision': 'a decision from you is required',
  aborted: 'the run was stopped before the goal was reached',
}

/** One line naming a stop reason. */
export function stopLabel(stop) {
  if (!stop) return 'none'
  return `${STOP_LABELS[stop.reason] ?? stop.reason}${stop.detail ? ` (${stop.detail})` : ''}`
}

/** What a human should do next, when a round could not get there alone. */
function nextStep(run) {
  const goalMode = run.goalMode
  const stop = goalMode.stop
  const failed = goalMode.rounds.at(-1)?.failed ?? []
  if (stop?.reason === 'needs-decision') {
    return 'answer the pending question with superagent_answer, then resume the run'
  }
  if (stop?.reason === 'budget') {
    return `the budget is fixed for this run (${stop.detail ?? 'model calls or tokens'}); start a new run with a `
      + 'higher goal budget, or raise the configured cap and start again'
  }
  if (stop?.reason === 'no-changes') {
    const id = failed[0]?.id
    return `the last round changed no file${id ? `, so ${id} cannot pass by re-running` : ''}; say what to change with `
      + 'superagent_followup, or fix the acceptance condition if it is not achievable by editing this workspace'
  }
  if (stop?.reason === 'no-progress') {
    const id = failed[0]?.id
    return `${id ? `${id} failed again with changes in between` : 'the same condition failed again'}; inspect the `
      + 'check output, decide whether the condition or the approach is wrong, then resume with a concrete instruction'
  }
  if (stop?.reason === 'rounds' || stop?.reason === 'wall-clock') {
    return 'call superagent_resume for another max_rounds allowance, or start a new run with a wider limit'
  }
  return goalMode.rounds.at(-1)?.next ?? 'inspect the last round and resume with a concrete instruction'
}

/**
 * Compose the user-facing report of a goal run.
 *
 * The report answers the three things a person needs after an unattended run:
 * why it stopped, what was already tried, and what they should do next. The last
 * round's own report is kept at the end, so the evidence is still readable.
 *
 * @param {object} run - run record with `goalMode`.
 * @returns {string} Markdown report.
 */
export function composeGoalReport(run) {
  const goalMode = run.goalMode
  const rounds = goalMode.rounds ?? []
  const last = rounds.at(-1)
  const checks = last?.checks ?? []
  const passed = checks.filter(check => check.ok === true).length
  const achieved = goalMode.achieved === true
  const lines = []
  if (achieved) {
    lines.push('# Goal achieved', '')
  } else {
    lines.push(`# Goal not reached — stopped: ${stopLabel(goalMode.stop)}`, '')
  }
  lines.push(`Goal: ${oneLine(run.goal, 500)}`, '')
  lines.push(
    `Rounds: ${rounds.length} of ${goalMode.maxRounds}; `
    + `${checks.length > 0 ? `acceptance ${passed} of ${checks.length} met` : 'acceptance not evaluated'}; `
    + `wall-clock limit ${goalMode.maxWallClockMinutes} min`,
  )
  lines.push('')
  if (checks.length > 0) {
    lines.push('Acceptance conditions:')
    for (const check of checks) {
      const source = check.source === 'model' ? 'judged by the acceptance model' : 'machine-checked by the plugin'
      lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} [${check.id}] ${check.text} (${source})`)
      if (check.command) lines.push(`  ran \`${check.command}\`: ${check.detail ?? ''}`)
      else if (check.detail) lines.push(`  ${check.detail}`)
    }
    lines.push('')
  }
  if (rounds.length > 0) {
    lines.push('Tried:')
    for (const round of rounds) {
      const subtasks = round.subtasks ?? {}
      const changed = round.changed === null || round.changed === undefined
        ? 'change unknown'
        : round.changed ? 'workspace changed' : 'workspace unchanged'
      const failed = round.failed?.length > 0 ? round.failed.map(item => item.id).join(', ') : 'nothing'
      lines.push(
        `- round ${round.round}: ${subtasks.completed ?? 0}/${subtasks.total ?? 0} subtask(s) completed; ${changed}; `
        + `failed: ${failed}`,
      )
      if (round.next) lines.push(`  next: ${round.next}`)
    }
    lines.push('')
  }
  if (!achieved) {
    lines.push('Next step for a human:', `- ${nextStep(run)}`, '')
  }
  if (last?.report) {
    lines.push('Last round report:', '', capText(last.report, 4000))
  }
  return lines.join('\n').trim()
}

/**
 * Status lines for a goal run, used by the tool reply and `superagent_status`.
 *
 * @param {object | null} goalMode - run's goal mode record.
 * @returns {string[]} zero or more lines.
 */
export function describeGoal(goalMode) {
  if (!goalMode || !Array.isArray(goalMode.acceptance)) return []
  const rounds = goalMode.rounds ?? []
  const last = rounds.at(-1)
  const state = goalMode.achieved ? 'achieved' : goalMode.stop ? `stopped (${goalMode.stop.reason})` : 'in progress'
  const lines = [
    `goal mode: round ${rounds.length}/${goalMode.maxRounds} — ${state}; `
    + `${goalMode.acceptance.length} acceptance condition(s)`,
  ]
  if (goalMode.stop) lines.push(`goal stop: ${stopLabel(goalMode.stop)}`)
  if (last?.failed?.length > 0) {
    lines.push(`goal failing: ${last.failed.map(item => `[${item.id}] ${oneLine(item.text, 90)}`).join('; ')}`)
  }
  return lines
}
