#!/usr/bin/env node
/**
 * Live proof for the runtime-control layer.
 *
 * It starts a local page, launches a real Chromium-family browser with an
 * isolated profile, reads the page's elements, clicks a button, types into a
 * field, refuses an irreversible button, takes screenshots, flips the emergency
 * stop, and prints the audit lines the whole sequence wrote.
 *
 * Nothing here is simulated: the counter it asserts is read back out of the
 * page, and each screenshot is a PNG the browser produced.
 *
 * Usage:
 *   node scripts/runtime-demo.mjs            # headless, writes ./.runtime-demo
 *   node scripts/runtime-demo.mjs --headful   # shows the window
 *   node scripts/runtime-demo.mjs --out D:\tmp\demo
 */
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAuditor } from '../lib/audit.js'
import { createRuntimeControl } from '../lib/runtime-control.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const headful = argv.includes('--headful')
const outIndex = argv.indexOf('--out')
const outDir = path.resolve(outIndex >= 0 ? argv[outIndex + 1] : path.join(root, '.runtime-demo'))

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DSH runtime demo</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 32px; color: #111; }
  h1 { font-size: 22px; }
  button { padding: 10px 16px; font-size: 15px; margin-right: 8px; }
  label { display: block; margin: 18px 0; }
  input { padding: 8px; font-size: 15px; width: 260px; }
  #count { font-size: 26px; font-weight: 700; }
  #echo { color: #0a6; min-height: 20px; }
</style></head>
<body>
  <h1>DSH runtime demo</h1>
  <p>counter: <span id="count">0</span></p>
  <button id="add" aria-label="Add one">Add one</button>
  <label>Your name <input id="name" placeholder="type your name"></label>
  <label>Attach <input id="upload" type="file"></label>
  <p id="echo"></p>
  <button id="submit" aria-label="Submit order">Submit order</button>
  <script>
    let n = 0
    document.getElementById('add').addEventListener('click', () => {
      n += 1
      document.getElementById('count').textContent = String(n)
    })
    document.getElementById('name').addEventListener('input', event => {
      document.getElementById('echo').textContent = 'hello ' + event.target.value
    })
    document.getElementById('submit').addEventListener('click', () => {
      document.getElementById('echo').textContent = 'SUBMITTED'
    })
  </script>
</body></html>`

function serve() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

const transcript = []
function step(title, value) {
  transcript.push(`\n### ${title}\n${value}`)
  console.log(`\n### ${title}\n${value}`)
}

const { server, port } = await serve()
await fsp.mkdir(outDir, { recursive: true })
const auditor = createAuditor({ dir: path.join(outDir, 'audit'), warn: message => console.error(`[warn] ${message}`) })
const runtime = createRuntimeControl({
  config: {
    enabled: true,
    browser: { headless: !headful, allowedHosts: ['127.0.0.1'] },
    shotDir: path.join(outDir, 'shots'),
    stopFile: path.join(outDir, 'STOP'),
  },
  stateRoot: outDir,
  auditor,
  warn: message => console.error(`[warn] ${message}`),
})
const tool = name => runtime.tools.find(entry => entry.name === name)

let failure = null
try {
  step('runtime_status', await tool('runtime_status').execute({}))
  step('browser_open', await tool('browser_open').execute({ url: `http://127.0.0.1:${port}/` }))
  step('browser_elements (button)', await tool('browser_elements').execute({ role: 'button' }))
  step('browser_click "Add one"', await tool('browser_click').execute({ text: 'Add one' }))
  const counter = await tool('browser_script').execute({ expression: "document.getElementById('count').textContent" })
  step('browser_script read counter', counter)
  if (!counter.includes('result: 1') && !counter.includes('"1"') && !/result:\s*1\b/.test(counter)) {
    failure = 'the click did not reach the page: the counter is not 1'
  }
  step('browser_type into "Your name"', await tool('browser_type').execute({ text: 'Your name', value: 'runtime-control' }))
  step('browser_click "Submit order" without confirm', await tool('browser_click').execute({ text: 'Submit order' }))
  step('browser_click the file input', await tool('browser_click').execute({ css: '#upload' }))
  const echo = await tool('browser_script').execute({ expression: "document.getElementById('echo').textContent" })
  step('browser_script read echo', echo)
  if (/SUBMITTED/.test(echo)) failure = failure ?? 'the irreversible button was clicked despite the gate'
  step('browser_screenshot', await tool('browser_screenshot').execute({ path: path.join(outDir, 'shots', 'final.png') }))

  await fsp.writeFile(path.join(outDir, 'STOP'), 'demo: stop switch on\n', 'utf8')
  step('browser_elements while STOP exists', await tool('browser_elements').execute({}))
  await fsp.unlink(path.join(outDir, 'STOP'))
  step('browser_close', await tool('browser_close').execute({}))
} catch (error) {
  failure = error?.stack ?? String(error)
  console.error(failure)
} finally {
  await runtime.dispose().catch(() => {})
  await new Promise(resolve => server.close(resolve))
}

const { events } = await auditor.query({ source: 'runtime', limit: 100 })
const lines = events.map(event => JSON.stringify({
  at: event.at,
  kind: event.kind,
  action: event.action,
  target: event.target,
  decision: event.decision,
  result: event.result,
  durationMs: event.durationMs,
  rule: event.rule,
}))
console.log(`\n### audit trail (${auditor.file}) — ${lines.length} runtime event(s)`)
for (const line of lines) console.log(line)

await fsp.writeFile(
  path.join(outDir, 'transcript.txt'),
  `${transcript.join('\n')}\n\n### audit trail\n${lines.join('\n')}\n`,
  'utf8',
)
console.log(`\nout: ${outDir}`)
if (failure) {
  console.error(`\nDEMO FAILED: ${failure}`)
  process.exit(1)
}
console.log('DEMO OK')
