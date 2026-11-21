/**
 * Normalize GitHub webhook deliveries into one record per event.
 *
 * This is the pure half of the GitHub source. It takes a decoded payload and
 * returns a small plain object —
 * or null when the delivery is not one of the supported shapes. It reads no
 * clock, no files, no environment and no network: `receivedAt` is supplied by
 * the caller, which is the only component that knows when the request arrived.
 * Signature verification, repository authorization, persistence, de-duplication
 * and dispatch belong to the integration layer.
 *
 * Identifiers mean different things:
 * - `eventId` (`github:<deliveryId>`) names one delivery. GitHub retries
 *   deliveries with the same `X-GitHub-Delivery`, so a replay yields the same
 *   eventId and the persistence layer can drop the duplicate.
 * - `anchor` (`kind` + `id`) names the work object the event belongs to:
 *   `issue` and `pull_request` use the issue number, `check_run` uses the run
 *   id. An issue comment and its issue share one anchor.
 * - `objectId` (`github:<repository.id>:<anchor.kind>:<anchor.id>`) is the
 *   key that ties both together. The same issue number in two repositories
 *   produces two objects; the same delivery replayed produces one.
 *
 * `actor` is the delivery's sender only — the GitHub account that caused the
 * event, not the issue reporter and not whoever will later do the work.
 *
 * Supported deliveries: `issues/opened`, `issue_comment/created`,
 * `check_run/completed`. Everything else returns null, as does a payload
 * missing a key field or a `receivedAt` that is not a real date.
 *
 * Titles and bodies are attacker-controlled text. They are truncated to fixed
 * code-point limits and returned as data; nothing here interprets them as
 * instructions, paths or commands.
 *
 * @module dsh-superagent/github-events
 */

/** Longest title kept from an issue or check run, in code points. */
export const TITLE_LIMIT = 200

/** Longest body kept from an issue or comment, in code points. */
export const BODY_LIMIT = 2000

const SUPPORTED = {
  issues: 'opened',
  issue_comment: 'created',
  check_run: 'completed',
}

const CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'success',
  'timed_out',
])

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const FULL_NAME = /^[^/\s]+\/[^/\s]+$/

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0
}

function nonEmptyText(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function truncate(value, limit) {
  if (typeof value !== 'string') return null
  const points = Array.from(value)
  return points.length > limit ? points.slice(0, limit).join('') : value
}

function isoTime(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    const time = new Date(value)
    return Number.isNaN(time.getTime()) ? null : time.toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const time = new Date(value)
    return Number.isNaN(time.getTime()) ? null : time.toISOString()
  }
  return null
}

function readRepository(payload) {
  const repo = payload.repository
  if (!repo || typeof repo !== 'object') return null
  if (!positiveId(repo.id)) return null
  const fullName = nonEmptyText(repo.full_name)
  if (!fullName || !FULL_NAME.test(fullName)) return null
  return { id: repo.id, fullName }
}

function readIssueRef(issue) {
  if (!issue || typeof issue !== 'object') return null
  if (!positiveId(issue.number)) return null
  return {
    kind: issue.pull_request ? 'pull_request' : 'issue',
    number: issue.number,
  }
}

function readActor(payload) {
  const login = nonEmptyText(payload.sender?.login)
  return login ? { login } : null
}

function readIssueFields(issue) {
  return {
    title: truncate(issue.title, TITLE_LIMIT),
    url: nonEmptyText(issue.html_url),
  }
}

function readCheckRun(run) {
  if (!run || typeof run !== 'object' || !positiveId(run.id)) return null
  return {
    anchor: { kind: 'check_run', id: run.id },
    subject: {
      name: truncate(run.name, TITLE_LIMIT),
      headSha: typeof run.head_sha === 'string' && SHA.test(run.head_sha) ? run.head_sha : null,
      conclusion: CONCLUSIONS.has(run.conclusion) ? run.conclusion : null,
      url: nonEmptyText(run.html_url),
    },
  }
}

/**
 * Turn one GitHub webhook delivery into a work-event record.
 *
 * @param {object} input
 * @param {string} input.event GitHub event name, e.g. `issues`.
 * @param {string} input.deliveryId value of `X-GitHub-Delivery`.
 * @param {object} input.payload parsed JSON body.
 * @param {string|number|Date} input.receivedAt when the HTTP layer accepted it.
 * @returns {null | {
 *   source: 'github',
 *   eventId: string,
 *   type: string,
 *   repository: { id: number, fullName: string },
 *   anchor: { kind: 'issue'|'pull_request'|'check_run', id: number },
 *   actor: { login: string } | null,
 *   receivedAt: string,
 *   objectId: string,
 *   subject: object,
 * }}
 */
export function normalizeGitHubEvent(input) {
  if (!input || typeof input !== 'object') return null

  const { event, deliveryId, payload, receivedAt } = input
  if (typeof event !== 'string' || !Object.hasOwn(SUPPORTED, event)) return null
  if (!payload || typeof payload !== 'object') return null
  if (payload.action !== SUPPORTED[event]) return null

  const delivery = nonEmptyText(deliveryId)
  if (!delivery) return null

  const received = isoTime(receivedAt)
  if (!received) return null

  const repository = readRepository(payload)
  if (!repository) return null

  let anchor
  let subject

  if (event === 'check_run') {
    const run = readCheckRun(payload.check_run)
    if (!run) return null
    anchor = run.anchor
    subject = run.subject
  } else {
    const issue = readIssueRef(payload.issue)
    if (!issue) return null
    const fields = readIssueFields(payload.issue)
    anchor = { kind: issue.kind, id: issue.number }

    if (event === 'issues') {
      subject = {
        number: issue.number,
        title: fields.title,
        body: truncate(payload.issue.body, BODY_LIMIT),
        url: fields.url,
      }
    } else {
      const comment = payload.comment
      if (!comment || typeof comment !== 'object' || !positiveId(comment.id)) return null
      subject = {
        number: issue.number,
        commentId: comment.id,
        title: fields.title,
        body: truncate(comment.body, BODY_LIMIT),
        url: nonEmptyText(comment.html_url) ?? fields.url,
      }
    }
  }

  return {
    source: 'github',
    eventId: `github:${delivery}`,
    type: `${event}.${payload.action}`,
    repository,
    anchor,
    actor: readActor(payload),
    receivedAt: received,
    objectId: `github:${repository.id}:${anchor.kind}:${anchor.id}`,
    subject,
  }
}
