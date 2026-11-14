#!/usr/bin/env node
/**
 * `dsh-superagent-report` — render existing runs into one self-contained HTML
 * file: inline CSS, inline SVG, no scripts, no network.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { buildReport } from '../lib/report.js'
import { createStore, resolveStateRoot } from '../lib/store.js'

const USAGE = `Usage: dsh-superagent-report [options]

Render recorded runs into one self-contained HTML file.

Options:
  --state-dir <path>   run state directory (default: $DSH_HOME/state/superagent)
  --out <file>         output path (default: superagent-report.html)
  --limit <n>          newest runs to include, 0 for all (default: 50)
  --title <text>       report heading (default: Superagent run report)
  -h, --help           show this message`

function valueOf(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${flag} needs a value\n\n${USAGE}`)
    process.exit(2)
  }
  return value
}

function parse(argv) {
  const options = { out: 'superagent-report.html', limit: 50 }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--state-dir') options.stateDir = valueOf(argv, ++index, '--state-dir')
    else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length)
    else if (arg === '--out') options.out = valueOf(argv, ++index, '--out')
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--limit') options.limit = Number(valueOf(argv, ++index, '--limit'))
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice('--limit='.length))
    else if (arg === '--title') options.title = valueOf(argv, ++index, '--title')
    else if (arg.startsWith('--title=')) options.title = arg.slice('--title='.length)
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    console.error(`--limit must be a non-negative integer\n\n${USAGE}`)
    process.exit(2)
  }
  return options
}

const options = parse(process.argv.slice(2))
const store = createStore(resolveStateRoot(options.stateDir))
await store.init()
const runs = await store.list()
if (runs.length === 0) {
  console.error(`no runs in ${store.root}; start one with the superagent_start tool first`)
  process.exit(1)
}

const selected = options.limit === 0 ? runs : runs.slice(0, options.limit)
const html = buildReport(selected, { title: options.title, generatedAt: Date.now() })
const out = path.resolve(options.out)
try {
  await fsp.mkdir(path.dirname(out), { recursive: true })
  await fsp.writeFile(out, html, 'utf8')
} catch (error) {
  console.error(`cannot write ${out}: ${error?.message ?? error}`)
  process.exit(1)
}

const size = Buffer.byteLength(html, 'utf8')
console.log(`wrote ${out} (${(size / 1024).toFixed(1)} kB, ${selected.length} run${selected.length === 1 ? '' : 's'})`)
