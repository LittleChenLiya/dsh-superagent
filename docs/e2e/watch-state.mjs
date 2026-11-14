#!/usr/bin/env node
/**
 * Poll a superagent state directory and print one JSON line per observed
 * change. Used by the E2E harness to prove that subtasks really overlap in
 * time; it only reads files and never writes to the plugin's state.
 *
 * Usage: node watch-state.mjs <stateDir> <seconds>
 */
import fs from 'node:fs'
import path from 'node:path'

const [, , stateDir, seconds = '25'] = process.argv
const runsDir = path.join(stateDir, 'runs')
const deadline = Date.now() + Number(seconds) * 1000
const previous = new Map()

while (Date.now() < deadline) {
  let names = []
  try {
    names = fs.readdirSync(runsDir).filter(name => name.endsWith('.json'))
  } catch {
    names = []
  }
  for (const name of names) {
    let run
    try {
      run = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8'))
    } catch {
      continue
    }
    const running = (run.subtasks ?? []).filter(subtask => subtask.status === 'running').length
    const line = JSON.stringify({
      at: new Date().toISOString(),
      id: run.id,
      status: run.status,
      subtasks: (run.subtasks ?? []).length,
      running,
      spawns: run.counters?.spawns ?? 0,
    })
    if (previous.get(run.id) !== line) {
      console.log(line)
      previous.set(run.id, line)
    }
  }
  await new Promise(resolve => setTimeout(resolve, 100))
}
