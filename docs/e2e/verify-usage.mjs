#!/usr/bin/env node
/**
 * Independent check of the plugin's usage accounting.
 *
 * Reads a run's state file, sums the `usage` events in every child session log
 * with this file's own zstd frame parser (no imports from lib/), and compares
 * the result with `run.usage`. Also recomputes the cost from the pricing table
 * in the profile overlay when one is passed.
 *
 * Usage: node verify-usage.mjs <stateDir> <sessionsRoot> <runId> [inputPerM] [outputPerM] [currency]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const [, , stateDir, sessionsRoot, runId, inputPerM, outputPerM, currency = 'USD'] = process.argv
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(file) {
  const buffer = fs.readFileSync(file)
  const starts = []
  let at = 0
  while ((at = buffer.indexOf(MAGIC, at)) !== -1) {
    starts.push(at)
    at += MAGIC.length
  }
  const parts = []
  for (let index = 0; index < starts.length; index++) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index], starts[index + 1] ?? buffer.length)).toString('utf8'))
    } catch {
      // A half-written trailing frame is expected while a child is alive.
    }
  }
  return parts.join('\n')
}

function findLog(childId) {
  for (const workspace of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    for (const folder of [childId, `session-${childId}`]) {
      const dir = path.join(sessionsRoot, workspace.name, folder)
      let names
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      const file = names.find(name => name.startsWith('session.') && name.endsWith('.zstd'))
      if (file) return path.join(dir, file)
    }
  }
  return null
}

function sumFile(file) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
  for (const line of decode(file).split('\n')) {
    if (!line.includes('"usage"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const usage = event?.data?.usage
    if (!usage || typeof usage !== 'object') continue
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    if (input === 0 && output === 0) continue
    totals.inputTokens += input
    totals.outputTokens += output
    totals.cacheReadTokens += Number(usage.cacheReadTokens) || 0
    totals.calls++
  }
  return totals
}

const run = JSON.parse(fs.readFileSync(path.join(stateDir, 'runs', `${runId}.json`), 'utf8'))
const childIds = Object.keys(run.usageByChild ?? {})
const measured = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }
console.log('run', run.id, 'status', run.status)
for (const childId of childIds) {
  const log = findLog(childId)
  if (!log) {
    console.log(`  ${childId}  LOG NOT FOUND`)
    continue
  }
  const totals = sumFile(log)
  measured.inputTokens += totals.inputTokens
  measured.outputTokens += totals.outputTokens
  measured.cacheReadTokens += totals.cacheReadTokens
  measured.calls += totals.calls
  console.log(`  ${childId}  in=${totals.inputTokens} out=${totals.outputTokens} cache=${totals.cacheReadTokens} calls=${totals.calls}  ${path.basename(log)}`)
}
console.log('independent:', JSON.stringify(measured))
console.log('plugin     :', JSON.stringify({
  inputTokens: run.usage?.inputTokens,
  outputTokens: run.usage?.outputTokens,
  cacheReadTokens: run.usage?.cacheReadTokens,
  calls: run.usage?.modelCalls,
}))

const price = inputPerM === undefined ? null : { input: Number(inputPerM), output: Number(outputPerM), currency }
const model = Object.keys(run.usage?.models ?? {})[0]
if (price) {
  const cost = (measured.inputTokens + measured.cacheReadTokens) * price.input / 1e6
    + measured.outputTokens * price.output / 1e6
  console.log(`cost by hand: ${price.currency} ${cost.toFixed(6)} for ${model}`)
  console.log('cost in run :', JSON.stringify(run.cost))
} else {
  console.log('no price passed for', model)
}
