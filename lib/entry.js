/**
 * Package entry point.
 *
 * A plugin is loaded as one module graph. If any file that graph imports is
 * missing, the import throws before `apply` exists, and the host can only say
 * "this plugin did not load" — in the desktop UI that looks like every tool of
 * the plugin vanishing at once, with no reason given.
 *
 * The commonest cause is an incomplete installation: `lib/index.js` was copied
 * but a sibling it imports (`wizard.js`, `board.js`, ...) was not. This file is
 * the only static import of the package, so it can catch that failure and name
 * the file that is missing plus the command that fixes it.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const libDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * Turn a failed import into the sentence a user needs.
 *
 * @param {unknown} error - thrown by the failed import.
 * @param {string} [dir] - this package's lib directory, for the fix suggestion.
 * @returns {string} one readable explanation.
 */
export function explainLoadError(error, dir = libDir) {
  const raw = error?.message ?? String(error)
  const match = /Cannot find (module|package) '([^']+)'/.exec(raw)
  if (!match) {
    return `dsh-superagent failed to load: ${raw}. `
      + 'The session keeps its other tools; no dsh-superagent tool exists until this is fixed.'
  }
  const [, kind, specifier] = match
  // Error paths may use a different OS dialect from the host.
  const windowsPaths = [dir, specifier].some(value => path.win32.isAbsolute(value) && !path.posix.isAbsolute(value))
  const paths = windowsPaths ? path.win32 : path.posix
  if (kind === 'package') {
    return `dsh-superagent failed to load because a package it imports is missing: ${specifier}. `
      + `Fix: run npm install in ${paths.dirname(dir)}, then restart the host.`
  }
  // Node prints a resolved absolute path for a relative import, but an older
  // runtime may keep the bare specifier; show whichever it gave.
  const file = paths.isAbsolute(specifier) || specifier.includes('://')
    ? specifier
    : paths.resolve(dir, specifier)
  const copyFix = windowsPaths
    ? 'Copy-Item lib\\* -Force on Windows'
    : `cp -R lib/. ${paths.dirname(dir)} on macOS/Linux`
  return `dsh-superagent failed to load because a file it imports is missing: ${file}. `
    + 'This installation is incomplete — usually only lib/index.js was copied. '
    + `Fix: copy every file of the package's lib directory into ${dir} `
    + `(${copyFix}) or reinstall the package, then restart the host. `
    + 'Until then the plugin is skipped and none of its tools appear in any session.'
}

let loaded
try {
  loaded = await import('./index.js')
} catch (error) {
  const explanation = explainLoadError(error)
  // The host logs what it catches; the console line is for the terminal that
  // started it. Both carry the same sentence.
  console.error(`[dsh-superagent] ${explanation}`)
  const failure = new Error(explanation, { cause: error })
  failure.code = error?.code
  throw failure
}

export const name = loaded.name
export const inject = loaded.inject
export const apply = loaded.apply
