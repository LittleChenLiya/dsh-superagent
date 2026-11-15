#!/usr/bin/env node
/**
 * `dsh-superagent-workbench` — serve the local workspace panel from a terminal.
 *
 * This is the standalone entry point: it needs no host, and it reads the same
 * run files the plugin writes when `--state-dir` points at a plugin state
 * directory. The plugin's own `workbenchPort` option starts the same server
 * inside the host.
 */
import path from 'node:path'

import { createStore } from '../lib/store.js'
import { createWorkbench } from '../lib/workbench.js'

const USAGE = `Usage: dsh-superagent-workbench [options]

Serve a loopback-only workspace panel: file tree, editor, diff preview, and the
files each recorded run changed. A fresh access token is printed on start.

Options:
  --root <path>        workspace the panel may read and edit (default: cwd)
  --port <port>        loopback port; 0 picks a free one (default: 0)
  --state-dir <path>   run state directory used for the Runs view
                       (default: <root>/.dsh-workbench)
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
  const options = { root: process.cwd(), port: 0, stateDir: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--root') options.root = valueOf(argv, ++index, '--root')
    else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length)
    else if (arg === '--port') options.port = Number(valueOf(argv, ++index, '--port'))
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length))
    else if (arg === '--state-dir') options.stateDir = valueOf(argv, ++index, '--state-dir')
    else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length)
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown option ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  options.root = path.resolve(options.root)
  options.stateDir = options.stateDir ? path.resolve(options.stateDir) : path.join(options.root, '.dsh-workbench')
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    console.error(`--port must be a whole number in 0–65535\n\n${USAGE}`)
    process.exit(2)
  }
  return options
}

const options = parse(process.argv.slice(2))
const store = createStore(options.stateDir)
await store.init()

const panel = createWorkbench({
  port: options.port,
  root: options.root,
  stateRoot: store.root,
  store,
  version: 'standalone',
  log: message => console.error(`[workbench] ${message}`),
})

try {
  const { url } = await panel.start()
  console.log(`workbench ${url}`)
  console.log(`root      ${options.root}`)
  console.log(`runs      ${store.root}`)
  console.log(`open      ${url}/?token=${panel.token}`)
  console.log(`discovery ${panel.discoveryPath}`)
  console.log('press Ctrl-C to stop')
} catch (error) {
  console.error(`cannot start the workbench: ${error?.message ?? error}`)
  process.exit(1)
}

let stopping = false
const shutdown = async signal => {
  if (stopping) return
  stopping = true
  console.error(`[workbench] ${signal}: closing`)
  await panel.stop()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
