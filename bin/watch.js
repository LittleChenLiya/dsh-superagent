#!/usr/bin/env node
/**
 * `dsh-superagent-watch` — live terminal panel over the run store.
 *
 * The panel reads the same files the host writes, so it works from a separate
 * terminal, against a remote-mounted state directory, or after the host that
 * started the runs has gone.
 */
import { DEFAULT_INTERVAL_MS, watch } from '../lib/watch.js'

const USAGE = `Usage: dsh-superagent-watch [options]

Draw one line per run, refreshed in place, until Ctrl-C.

Options:
  --state-dir <path>   run state directory (default: $DSH_HOME/state/superagent)
  --interval <ms>      refresh interval (default: ${DEFAULT_INTERVAL_MS})
  --once               print one frame and exit (for pipes and tests)
  --no-color           never emit ANSI colour
  -h, --help           show this message`

/** Read one value that follows a flag, or fail with the usage text. */
function valueOf(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${flag} needs a value\n\n${USAGE}`)
    process.exit(2)
  }
  return value
}

function parse(argv) {
  const options = { intervalMs: DEFAULT_INTERVAL_MS }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--state-dir') options.stateDir = valueOf(argv, ++index, '--state-dir')
    else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length)
    else if (arg === '--interval') options.intervalMs = Number(valueOf(argv, ++index, '--interval'))
    else if (arg.startsWith('--interval=')) options.intervalMs = Number(arg.slice('--interval='.length))
    else if (arg === '--once') options.once = true
    else if (arg === '--no-color') options.color = false
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    console.error(`--interval must be a positive number of milliseconds\n\n${USAGE}`)
    process.exit(2)
  }
  return options
}

await watch(parse(process.argv.slice(2)))
