/**
 * Cross-process cancel through the control plane.
 *
 * Two hosts share one state directory and each publishes its own discovery
 * file. This script asks host B to cancel a run owned by host A and checks that
 * both hosts see the terminal state. That is the failure mode the plugin cares
 * most about: a "cancelled" answer that does not stop the process spending
 * tokens.
 *
 *   node docs/e2e/cross-cancel.mjs <hostA-discovery.json> <hostB-discovery.json>
 */
import fsp from 'node:fs/promises'
import http from 'node:http'

const [aPath, bPath] = process.argv.slice(2)
if (!aPath || !bPath) {
  console.error('usage: cross-cancel.mjs <hostA.json> <hostB.json>')
  process.exit(2)
}

const hostA = JSON.parse(await fsp.readFile(aPath, 'utf8'))
const hostB = JSON.parse(await fsp.readFile(bPath, 'utf8'))
let failures = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function request(host, method, route, body) {
  return new Promise((resolve, reject) => {
    const base = new URL(host.url)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: route,
        method,
        agent: false,
        headers: {
          authorization: `Bearer ${host.token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            json = null
          }
          resolve({ status: res.statusCode, json })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')))
    if (payload) req.write(payload)
    req.end()
  })
}

const ACTIVE = new Set(['queued', 'planning', 'running', 'aggregating'])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

console.log(`host A: pid=${hostA.pid} ${hostA.url}`)
console.log(`host B: pid=${hostB.pid} ${hostB.url}`)
check('the two hosts are different processes', hostA.pid !== hostB.pid, `${hostA.pid} vs ${hostB.pid}`)

const listedByA = await request(hostA, 'GET', '/runs?limit=10')
const active = listedByA.json?.data?.runs?.find(run => ACTIVE.has(run.status))
check('host A has an active run to cancel', Boolean(active), listedByA.json?.data?.runs?.map(run => `${run.id}:${run.status}`).join(', '))
if (!active) process.exit(1)

const runId = active.id
console.log(`run: ${runId} (${active.status})`)

const listedByB = await request(hostB, 'GET', '/runs?limit=10')
const seenByB = listedByB.json?.data?.runs?.find(run => run.id === runId)
check('host B sees the run in the shared state directory', Boolean(seenByB), `B saw ${listedByB.json?.data?.runs?.length ?? 0} run(s)`)
// Mount sweeps orphaned runs. A run owned by another live pid must survive that
// sweep, but its status may still move (planning -> running) while we look, so
// the assertion is "still active", not "byte-identical to the earlier snapshot".
check('host B did not mark the live run interrupted at mount', ACTIVE.has(seenByB?.status), `B saw ${seenByB?.status}`)

const cancel = await request(hostB, 'POST', `/runs/${runId}/cancel`, {})
console.log(`POST /runs/${runId}/cancel -> ${cancel.status} ${JSON.stringify(cancel.json).slice(0, 300)}`)
check('host B accepts the cancel request', cancel.status === 200)

let terminal = null
for (let attempt = 0; attempt < 40; attempt++) {
  const read = await request(hostB, 'GET', `/runs/${runId}`)
  terminal = read.json?.data?.run
  if (terminal && !ACTIVE.has(terminal.status)) break
  await sleep(500)
}
check('the run stops changing', terminal && !ACTIVE.has(terminal.status), terminal?.status)
check('the owner recorded it as cancelled', terminal?.status === 'cancelled', terminal?.status)

const readByA = await request(hostA, 'GET', `/runs/${runId}`)
check('host A reports the same terminal state', readByA.json?.data?.run?.status === 'cancelled', readByA.json?.data?.run?.status)
// `orchestrator.cancel` records `error = 'cancelled by superagent_cancel'` as an
// audit note. What must not happen is the user-facing text presenting that as a
// failure, so assert on the rendered reply rather than on the raw field.
const cancelText = readByA.json?.text ?? ''
check(
  'the cancel did not surface as an error to the reader',
  terminal?.status === 'cancelled' && !/^(error|hint):/m.test(cancelText),
  cancelText.split('\n').find(line => /^(error|hint):/.test(line)) ?? '',
)

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
