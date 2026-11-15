#!/usr/bin/env node
/**
 * `dsh-superagent-archive` — prune terminal runs and move one run in or out of
 * the durable store as a self-contained archive.
 *
 * Prune is a dry run unless `--confirm` is given: the command prints every run
 * and byte it would delete first, and it never touches a run that is live or
 * locked by another process.
 */
import { createStore, resolveStateRoot } from '../lib/store.js'

const USAGE = `Usage: dsh-superagent-archive <command> [options]

Commands:
  prune                 list terminal runs that prune would delete (dry run by default)
  export <run-id>       write one run as a self-contained archive
  import <path>         read an archive back into the local store

Common options:
  --state-dir <path>    run state directory (default: $DSH_HOME/state/superagent)
  -h, --help            show this message

prune options:
  --older-than <days>   only runs finished at least this many days ago (required)
  --status <list>       only these terminal statuses, comma separated
  --confirm             actually delete; without it prune only prints the plan

export options:
  --out <path>          archive path (default: ./superagent-<run-id>[.json|.html])
  --format <kind>       dir (default), bundle (one JSON file), or html (one page)

import options:
  (none)                an existing local run with the same id makes import fail`

/** Format a byte count the way the other CLIs in this package do. */
function sizeText(value) {
  let size = Number(value)
  if (!Number.isFinite(size) || size < 0) size = 0
  if (size < 1024) return `${Math.round(size)} B`
  const units = ['kB', 'MB', 'GB']
  let unit = 'B'
  for (const next of units) {
    if (size < 1024) break
    size /= 1024
    unit = next
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${unit}`
}

function fail(message, code = 2) {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(code)
}

function valueOf(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`)
  return value
}

function parse(argv) {
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg === '--state-dir') options.stateDir = valueOf(argv, ++index, '--state-dir')
    else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length)
    else if (arg === '--older-than') options.olderThan = Number(valueOf(argv, ++index, '--older-than'))
    else if (arg.startsWith('--older-than=')) options.olderThan = Number(arg.slice('--older-than='.length))
    else if (arg === '--status') options.statuses = valueOf(argv, ++index, '--status')
    else if (arg.startsWith('--status=')) options.statuses = arg.slice('--status='.length)
    else if (arg === '--format') options.format = valueOf(argv, ++index, '--format')
    else if (arg.startsWith('--format=')) options.format = arg.slice('--format='.length)
    else if (arg === '--out') options.out = valueOf(argv, ++index, '--out')
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--confirm') options.confirm = true
    else if (arg.startsWith('-')) fail(`unknown option: ${arg}`)
    else positional.push(arg)
  }
  return { options, positional }
}

function printPlan(store, plan) {
  console.log(`prune plan for ${store.root}`)
  if (plan.candidates.length === 0) {
    console.log('  nothing to delete: no terminal run matches this window and filter')
  } else {
    const width = Math.max(20, ...plan.candidates.map(candidate => candidate.id.length))
    console.log(`  ${plan.candidates.length} run(s) qualify, ${plan.files} file(s), ${sizeText(plan.bytes)}:`)
    console.log(`  ${'RUN'.padEnd(width)}  ${'STATUS'.padEnd(11)}  ${'FINISHED'.padEnd(24)}  BYTES`)
    for (const candidate of plan.candidates) {
      console.log(
        `  ${candidate.id.padEnd(width)}  ${candidate.status.padEnd(11)}  `
        + `${String(candidate.finishedAt).padEnd(24)}  ${sizeText(candidate.bytes)}`,
      )
    }
  }
  if (plan.skipped.length > 0) {
    console.log(`  skipped ${plan.skipped.length} run(s) held by another process: `
      + plan.skipped.map(entry => entry.id).join(', '))
  }
}

async function prune(options) {
  if (options.olderThan === undefined) fail('prune needs --older-than <days>')
  if (!Number.isFinite(options.olderThan) || options.olderThan <= 0) {
    fail('--older-than must be a positive number of days')
  }
  // No init(): a dry run must not clean stale files either.
  const store = createStore(resolveStateRoot(options.stateDir))
  let plan
  try {
    plan = await store.planPrune({ olderThanDays: options.olderThan, statuses: options.statuses })
  } catch (error) {
    console.error(`cannot plan a prune: ${error?.message ?? error}`)
    process.exit(1)
  }
  printPlan(store, plan)
  if (!options.confirm) {
    console.log('')
    console.log(plan.candidates.length === 0
      ? 'dry run: nothing deleted.'
      : `dry run: nothing deleted; ${plan.candidates.length} run(s), ${sizeText(plan.bytes)} `
        + `in ${plan.files} file(s). Re-run with --confirm to delete.`)
    return
  }
  const result = await store.prune({
    olderThanDays: options.olderThan,
    statuses: options.statuses,
    dryRun: false,
  })
  console.log('')
  console.log(result.removed.length === 0
    ? 'deleted nothing: the runs eligible a moment ago are gone or now held'
    : `deleted ${result.removed.length} run(s), ${sizeText(result.deletedBytes)}`)
  for (const failure of result.failed) console.error(`  failed to delete ${failure.id}: ${failure.error}`)
  if (result.failed.length > 0) process.exitCode = 1
}

async function exportRun(options, positional) {
  const runId = positional[0]
  if (!runId) fail('export needs a run id')
  const format = options.format ?? 'dir'
  if (!['dir', 'bundle', 'html'].includes(format)) fail('--format must be dir, bundle, or html')
  const suffix = format === 'dir' ? '' : format === 'html' ? '.html' : '.json'
  const out = options.out ?? `superagent-${runId}${suffix}`
  const store = createStore(resolveStateRoot(options.stateDir))
  let result
  try {
    result = await store.exportRun(runId, out, { format })
  } catch (error) {
    console.error(`cannot export run ${runId}: ${error?.message ?? error}`)
    process.exit(1)
  }
  console.log(`exported run ${result.runId} to ${result.out} (${result.format}, `
    + `${result.files.length} file(s), ${sizeText(result.bytes)})`)
  for (const file of result.files) console.log(`  ${file.path}  ${sizeText(file.bytes)}`)
}

async function importRun(options, positional) {
  const source = positional[0]
  if (!source) fail('import needs an archive path')
  const store = createStore(resolveStateRoot(options.stateDir))
  await store.init()
  let result
  try {
    result = await store.importRun(source)
  } catch (error) {
    console.error(`cannot import ${source}: ${error?.message ?? error}`)
    process.exit(1)
  }
  console.log(`imported run ${result.run.id} from ${result.format} archive ${result.source}`)
  console.log(`  wrote ${result.out}`)
}

const { options, positional } = parse(process.argv.slice(2))
const command = positional.shift()
if (!command) fail('a command is required')
if (command === 'prune') await prune(options)
else if (command === 'export') await exportRun(options, positional)
else if (command === 'import') await importRun(options, positional)
else fail(`unknown command: ${command}`)
