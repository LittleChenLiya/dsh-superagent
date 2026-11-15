#!/usr/bin/env node
/**
 * `dsh-superagent-sync` — carry one state directory between machines through a
 * git remote, with no server and no dependency.
 *
 * This is an approximate sync, not a cluster: see the LIMITS block below and
 * the "Syncing one state directory across machines" section of the README.
 */
import { buildIgnoreBlock, createSync } from '../lib/sync.js'
import { resolveStateRoot } from '../lib/store.js'

const USAGE = `Usage: dsh-superagent-sync <command> [options]

Carry the run state directory between machines through a git remote.

Commands:
  init <git-remote>    make the state directory a repository, write .gitignore,
                       and commit; <git-remote> becomes "origin"
  pull                 fetch and merge the remote; uncommitted local work is
                       stashed first and reapplied after the merge
  push                 commit local state, then push it to origin
  status               ahead/behind counts, uncommitted files, pending conflicts

Options:
  --state-dir <path>   run state directory (default: $DSH_HOME/state/superagent)
  --json               print the raw result as JSON
  -h, --help           show this message

Limits (approximate by design):
  - two machines writing at the same moment can still conflict; the merge stops
    with both sides kept and the paths listed, nothing is chosen for you
  - there is no live sync: another machine sees this state only after push/pull
  - keys are not distributed: each machine still needs its own model credential
  - a conflicted run file must be resolved before the plugin mounts, otherwise
    the store quarantines the unparsable bytes as <runId>.json.corrupt-<ts>

Ignored machine-local files (never pushed):
${IGNORE_PATTERNS_TEXT()}`

function IGNORE_PATTERNS_TEXT() {
  return buildIgnoreBlock()
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => `  ${line}`)
    .join('\n')
}

const COMMANDS = new Set(['init', 'pull', 'push', 'status'])

function parse(argv) {
  const options = { json: false }
  const positional = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--state-dir') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) fail(2, '--state-dir needs a path')
      options.stateDir = value
    } else if (arg.startsWith('--state-dir=')) options.stateDir = arg.slice('--state-dir='.length)
    else if (arg === '--json') options.json = true
    else if (arg === '-h' || arg === '--help' || arg === 'help') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg.startsWith('-')) fail(2, `unknown option: ${arg}`)
    else positional.push(arg)
  }
  const [command, ...rest] = positional
  if (!command) fail(2, 'a command is required')
  if (!COMMANDS.has(command)) fail(2, `unknown command: ${command}`)
  options.command = command
  options.args = rest
  if (command === 'init' && rest.length === 0) fail(2, 'init needs a git remote')
  if (command !== 'init' && rest.length > 0) fail(2, `${command} takes no positional argument (got ${rest[0]})`)
  if (command === 'init' && rest.length > 1) fail(2, `init takes one remote, got ${rest.length}`)
  return options
}

function fail(code, message, hint) {
  console.error(`[error] ${message}`)
  if (hint) console.error(`hint: ${hint}`)
  else console.error(`\n${USAGE}`)
  process.exit(code)
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

function printInit(result) {
  console.log(`initialized repository at ${result.root}`)
  console.log(`  remote   origin → ${result.remote} (${result.remoteAction})`)
  console.log(`  branch   ${result.branch ?? '(detached)'}`)
  console.log(`  commit   ${result.commit ?? '(nothing to commit)'}`)
  console.log(`  ignore   .gitignore ${result.ignoreChanged ? 'written' : 'already current'}`)
  console.log(`           kept out: ${result.ignoredPatterns.join(', ')}`)
  console.log(
    result.memorySynced
      ? '  memory   memory/.gitignore rewritten; <scope>.jsonl notes are synced'
      : '  memory   memory/.gitignore was customized, so notes stay local (a "*" there keeps them out)',
  )
  console.log(`next: run "dsh-superagent-sync push" here, then init + pull on the other machine`)
}

function printPull(result) {
  if (result.stash) {
    const count = plural(result.stash.files, 'local change')
    console.log(`stashed ${count} as ${result.stash.ref} — nothing local was overwritten ("git stash list" shows it)`)
  }
  if (result.conflicts.length > 0) {
    console.log(`merge ${result.ref} stopped with ${plural(result.conflicts.length, 'conflict')}; both sides are still in the files:`)
    for (const file of result.conflicts) console.log(`  ${file}`)
    console.log('nothing was resolved automatically and the stash was not reapplied')
    console.log(`hint: edit each file by hand, then "git add <file>" and "git commit", then push`)
    return 1
  }
  if (result.note) {
    console.log(result.note)
  } else {
    console.log(result.merged ? `merged ${result.ref}` : `already up to date with ${result.ref}`)
  }
  if (result.stash) {
    if (result.stash.reapplied) console.log(`reapplied ${result.stash.ref}`)
    else {
      console.log(`could not reapply ${result.stash.ref}: ${result.stash.popError ?? 'unknown reason'}`)
      console.log(`the stash is kept; inspect with "git stash show -p ${result.stash.ref}" and apply it by hand`)
    }
  }
  return 0
}

function printPush(result) {
  if (result.commit) console.log(`committed local state as ${result.commit}`)
  else console.log('nothing new to commit')
  if (result.pushed) {
    console.log(`pushed ${result.branch} → origin/${result.branch}`)
    return 0
  }
  if (result.rejected) {
    console.log('push rejected: origin has commits this machine does not have')
    console.log('hint: run "dsh-superagent-sync pull", resolve anything it reports, then push again')
  } else {
    console.log(`push failed: ${result.output || 'git gave no reason'}`)
  }
  return 1
}

function printStatus(result) {
  console.log(`state root  ${result.root}`)
  console.log(`remote      ${result.remote ? `origin → ${result.remote}` : 'none'}`)
  console.log(`branch      ${result.branch ?? '(detached)'}${result.upstream ? ` → ${result.upstream}` : ' (no upstream yet)'}`)
  if (result.ahead === null) console.log('position    unknown (no upstream yet; push once to set it)')
  else console.log(`position    ahead ${result.ahead}, behind ${result.behind}`)
  console.log(`local       ${plural(result.dirty, 'uncommitted file')}`)
  console.log(`stashes     ${result.stashes.length === 0 ? 'none' : result.stashes.map(item => `${item.ref} ${item.subject}`).join('; ')}`)
  if (result.conflicts.length === 0) console.log('conflicts   none')
  else {
    console.log(`conflicts   ${plural(result.conflicts.length, 'file')} left for you:`)
    for (const file of result.conflicts) console.log(`  ${file}`)
  }
  console.log(`last        ${result.head ?? 'no commit yet'}`)
  if (result.fetchError) console.log(`warning     could not fetch: ${result.fetchError.split('\n')[0]}`)
  return result.conflicts.length > 0 ? 1 : 0
}

const options = parse(process.argv.slice(2))
const sync = createSync(resolveStateRoot(options.stateDir))
let result
try {
  if (options.command === 'init') result = await sync.init({ remote: options.args[0] })
  else if (options.command === 'pull') result = await sync.pull()
  else if (options.command === 'push') result = await sync.push()
  else result = await sync.status()
} catch (error) {
  if (options.json) console.log(JSON.stringify({ error: error?.message ?? String(error), conflicts: error?.conflicts ?? [] }, null, 2))
  fail(1, error?.message ?? String(error), 'check "dsh-superagent-sync status" and the git output above')
}

if (options.json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

const printed = options.command === 'init' ? (printInit(result), 0)
  : options.command === 'pull' ? printPull(result)
    : options.command === 'push' ? printPush(result)
      : printStatus(result)
process.exit(printed)
