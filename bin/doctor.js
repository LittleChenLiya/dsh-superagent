#!/usr/bin/env node
/**
 * `dsh-superagent-doctor` — read-only checks for the two ways this package has
 * failed to run after a clean install: a `files` whitelist that dropped an
 * imported module, and a profile copy left half-unpacked by an interrupted
 * install. Prints one block per check and the commands that fix it.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inferProfileDir, renderReport, runDoctor } from '../lib/doctor.js'

const USAGE = `Usage: dsh-superagent-doctor [options]

Check that this copy of dsh-superagent can actually run:
  - every file the code imports is shipped by package.json "files" and exists
  - the installed copy matches the version package.json claims
  - the installed files match the published tarball (skipped when offline)
  - the DSH profile mounts the bundle patch and the eleven tools are registered
  - the running Node satisfies "engines"

Nothing is installed or modified; the only network access is one public
tarball for the hash comparison, and --offline removes even that.

Options:
  --package <dir>   package copy to inspect (default: the copy this runs from)
  --profile <name>  DSH profile name, or a full profile directory
  --offline         skip the npm registry comparison
  --no-color        never emit ANSI colour
  -h, --help        show this message

Exit code: 0 when no check fails, 1 when one does, 2 on bad usage.`

function valueOf(argv, index, flag) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${flag} needs a value\n\n${USAGE}`)
    process.exit(2)
  }
  return value
}

function parse(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--package') options.packageRoot = valueOf(argv, ++index, '--package')
    else if (arg.startsWith('--package=')) options.packageRoot = arg.slice('--package='.length)
    else if (arg === '--profile') options.profile = valueOf(argv, ++index, '--profile')
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--offline') options.online = false
    else if (arg === '--no-color') options.color = false
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  return options
}

const options = parse(process.argv.slice(2))
// When installed, bin/ lives one level below the package root. Running the
// checkout from source resolves to the checkout, which is the same idea.
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = options.packageRoot ? path.resolve(options.packageRoot) : defaultRoot

const result = await runDoctor({
  packageRoot,
  // `undefined` means "infer from where this package lives"; only an explicit
  // `--profile` overrides the inference.
  profile: options.profile,
  online: options.online,
})

const color = options.color !== false
  && process.stdout.isTTY
  && !process.env.NO_COLOR
console.log(renderReport(result, { color }))
if (!options.profile && !inferProfileDir(result.targetDir)) {
  console.log('\nnot inside a DSH profile, so only the package itself was checked')
}
process.exit(result.ok ? 0 : 1)
