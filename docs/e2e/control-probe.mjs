/**
 * Drive the local HTTP control plane the way an embedder would.
 *
 * The probe reads only the discovery file written by the plugin — never the
 * plugin's source or its internal state — and prints a transcript that can be
 * committed as evidence. Run it while a host with `controlPort` is alive.
 *
 *   node docs/e2e/control-probe.mjs <discovery.json> <sessionId> [goal]
 *
 * `node:http` with `agent: false` is used instead of `fetch` so every request
 * closes its socket: an embedder script must be able to exit without waiting
 * for a global keep-alive pool, and explicit exit during handle teardown is
 * what triggers a libuv assertion on Windows.
 */
import fsp from 'node:fs/promises'
import http from 'node:http'

const [discoveryPath, sessionId, goal = 'Compare two sorting strategies on the stub fixture.'] = process.argv.slice(2)
if (!discoveryPath || !sessionId) {
  console.error('usage: control-probe.mjs <discovery.json> <sessionId> [goal]')
  process.exit(2)
}

const discovery = JSON.parse(await fsp.readFile(discoveryPath, 'utf8'))
const base = new URL(discovery.url)
let failures = 0

function record(method, route, status, body) {
  const text = JSON.stringify(body)
  console.log(`${method} ${route} -> ${status} ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`)
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function request(method, route, { body, token = discovery.token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, base)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `${url.pathname}${url.search}`,
        method,
        agent: false,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          record(method, route, res.statusCode, json)
          resolve({ status: res.statusCode, json })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error(`${method} ${route} timed out`)))
    if (payload) req.write(payload)
    req.end()
  })
}

console.log(`discovery: url=${discovery.url} pid=${discovery.pid} token=${discovery.token.slice(0, 6)}… (${discovery.token.length} chars)`)
console.log(`session: ${sessionId}`)

const index = await request('GET', '/')
check('index names the routes', index.status === 200 && index.json?.data?.endpoints?.length === 6)

const health = await request('GET', '/health')
check('health answers', health.status === 200 && health.json?.data?.service === 'dsh-superagent')
check('health reports a pid and a state directory', Boolean(health.json?.data?.pid && health.json?.data?.stateDir))

const anonymous = await request('GET', '/runs', { token: null })
check('a request without the token is refused', anonymous.status === 401 && anonymous.json?.ok === false)

const wrong = await request('GET', '/runs', { token: `${discovery.token}x` })
check('a wrong token is refused', wrong.status === 401)

const noSession = await request('POST', '/runs', { body: { goal: 'say hi' } })
check('start without session_id is refused as no-session', noSession.status === 409 && noSession.json?.error?.id === 'no-session')
check('the refusal carries a hint', Boolean(noSession.json?.error?.hint))

const closed = await request('POST', '/runs', { body: { goal: 'say hi', session_id: 'session-not-open' } })
check('start with a session that is not live is refused', closed.status === 409 && closed.json?.error?.id === 'no-session')

const created = await request('POST', '/runs', { body: { goal, session_id: sessionId } })
const runId = created.json?.data?.run?.id
check('start accepts a live session', created.status === 202 && Boolean(runId))
check('the run records its owning session', created.json?.data?.run?.parentSessionId === sessionId)

if (runId) {
  const finished = await request('GET', `/runs/${runId}?wait=60`)
  const run = finished.json?.data?.run
  check('the run reaches completed', finished.status === 200 && run?.status === 'completed', run?.status)
  check('the report is non-empty', typeof run?.report === 'string' && run.report.length > 0)
  check('usage was measured through the child session logs', (run?.usage?.modelCalls ?? 0) > 0)
  check('the text rendering matches the tool result', /^run .* — completed/m.test(finished.json?.text ?? ''))

  const listed = await request('GET', '/runs?limit=10')
  check('the run appears in the list', listed.json?.data?.runs?.some(entry => entry.id === runId))

  const cancel = await request('POST', `/runs/${runId}/cancel`, { body: {} })
  check('cancelling a finished run says there is nothing to cancel', cancel.status === 200 && /nothing to cancel/.test(cancel.json?.text ?? ''))

  const resumed = await request('POST', `/runs/${runId}/resume`, { body: { session_id: sessionId } })
  check('resuming a completed run returns it unchanged', resumed.status === 202 && resumed.json?.data?.run?.status === 'completed')

  const resumeNoSession = await request('POST', `/runs/${runId}/resume`, { body: {} })
  check('resume without a session is refused', resumeNoSession.status === 409 && resumeNoSession.json?.error?.id === 'no-session')
}

const missing = await request('GET', '/runs/20260101T000000-none')
check('an unknown run is a 404 with the classifier', missing.status === 404 && missing.json?.error?.id === 'unknown-run')

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
