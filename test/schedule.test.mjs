import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CronError } from '../lib/cron.js'
import { apply } from '../lib/index.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createScheduler, formatScheduleList } from '../lib/schedule.js'

const OWNER = 'session-owner'

function fakeOrchestrator() {
  const runs = new Map()
  const calls = []
  return {
    calls,
    runs,
    async start(args) {
      const run = {
        id: `run-${calls.length + 1}`,
        status: 'running',
        goal: args.goal,
        origin: args.origin,
        notifyMuted: args.muted === true,
        usage: null,
        attention: null,
        goalMode: null,
      }
      calls.push(args)
      runs.set(run.id, run)
      return structuredClone(run)
    },
    async status(id) {
      return runs.has(id) ? structuredClone(runs.get(id)) : null
    },
    async list() {
      return [...runs.values()]
        .map(run => structuredClone(run))
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    },
  }
}

function fakeTimers() {
  const timers = []
  return {
    timers,
    setInterval: (fn, ms) => {
      const timer = { fn, ms }
      timers.push(timer)
      return timer
    },
    clearInterval: timer => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    },
  }
}

async function harness({
  now = '2026-11-15T00:00:00Z',
  orchestrator = fakeOrchestrator(),
  tickSeconds = 30,
  humanPriority = true,
  maxConsecutiveFailures = 3,
  resolveOwner = () => ({ id: OWNER }),
} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-'))
  const clock = { value: Date.parse(now) }
  const notifications = []
  const timers = fakeTimers()
  const scheduler = createScheduler({
    stateFile: path.join(dir, 'schedules.json'),
    orchestrator,
    resolveOwner,
    notify: input => {
      notifications.push(input)
    },
    now: () => clock.value,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    tickSeconds,
    humanPriority,
    maxConsecutiveFailures,
    maxActiveRuns: 2,
    warn: () => {},
  })
  return {
    dir,
    clock,
    notifications,
    timers,
    scheduler,
    orchestrator,
    stateFile: path.join(dir, 'schedules.json'),
    async cleanup() {
      scheduler.stop()
      await fsp.rm(dir, { recursive: true, force: true })
    },
  }
}

function planInput(overrides = {}) {
  return {
    name: 'nightly check',
    goal: 'check the release gate',
    everyMinutes: 30,
    timeZone: 'UTC',
    ownerSessionId: OWNER,
    ...overrides,
  }
}

test('create, list, pause, resume, delete, and survive a host restart', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    await h.scheduler.init()
    assert.equal(h.scheduler.isRunning(), false, 'no plans must mean no timer')
    await assert.rejects(fsp.access(h.stateFile), 'mounting must not create a schedule file')

    const created = await h.scheduler.create(planInput())
    assert.match(created.id, /^sch-/)
    assert.equal(created.nextRunAt, '2026-11-15T00:30:00.000Z')
    assert.equal(h.scheduler.isRunning(), true, 'the first plan arms the timer')
    assert.equal(h.timers.timers.length, 1)

    const listed = formatScheduleList(await h.scheduler.list())
    assert.match(listed, /1 scheduled run\(s\)/)
    assert.match(listed, /nightly check/)
    assert.match(listed, /every 30 minute\(s\)/)

    // A new instance on the same state file is a host restart.
    const restarted = createScheduler({ stateFile: h.stateFile, orchestrator: h.orchestrator, now: () => h.clock.value })
    await restarted.init()
    const afterRestart = await restarted.list()
    assert.equal(afterRestart.length, 1)
    assert.equal(afterRestart[0].id, created.id)
    assert.equal(restarted.isRunning(), true)
    restarted.stop()

    const paused = await h.scheduler.pause(created.id, 'paused by test')
    assert.equal(paused.enabled, false)
    assert.equal(paused.pausedReason, 'paused by test')
    assert.equal(h.timers.timers.length, 0, 'pausing the only plan disarms the timer')

    h.clock.value = Date.parse('2026-11-16T00:00:00Z')
    const resumed = await h.scheduler.resume(created.id)
    assert.equal(resumed.enabled, true)
    assert.equal(resumed.consecutiveFailures, 0)
    assert.equal(resumed.nextRunAt, '2026-11-16T00:30:00.000Z', 'resume must not replay the paused windows')

    await h.scheduler.remove(created.id)
    assert.deepEqual(await h.scheduler.list(), [])
    assert.equal(h.scheduler.isRunning(), false, 'deleting the last plan disarms the timer')
    assert.equal(h.timers.timers.length, 0)
  } finally {
    await h.cleanup()
  }
})

test('an invalid cron is refused at create time with the field number, and nothing is persisted', async () => {
  const h = await harness()
  try {
    await h.scheduler.init()
    await assert.rejects(
      h.scheduler.create(planInput({ everyMinutes: undefined, cron: '0 25 * * *' })),
      error => {
        assert.ok(error instanceof CronError)
        assert.equal(error.field, 2)
        assert.equal(error.fieldName, 'hour')
        assert.match(error.message, /cron field 2/)
        return true
      },
    )
    await assert.rejects(fsp.access(h.stateFile), 'a rejected plan must not create state')
    assert.deepEqual(await h.scheduler.list(), [])
  } finally {
    await h.cleanup()
  }
})

test('a cron plan is scheduled in its own time zone', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({
      everyMinutes: undefined,
      cron: '30 23 * * *',
      timeZone: 'Asia/Shanghai',
    }))
    assert.equal(plan.nextRunAt, '2026-11-15T15:30:00.000Z')
  } finally {
    await h.cleanup()
  }
})

test('after downtime only the newest window runs and the rest are marked missed', async () => {
  const h = await harness({ now: '2026-11-15T08:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({ everyMinutes: 30 }))
    assert.equal(plan.nextRunAt, '2026-11-15T08:30:00.000Z')

    h.clock.value = Date.parse('2026-11-15T10:05:00Z')
    const outcomes = await h.scheduler.tick()
    assert.equal(h.orchestrator.calls.length, 1, 'exactly one catch-up run')
    assert.equal(h.orchestrator.calls[0].goal, 'check the release gate')
    assert.equal(outcomes[0].event, 'started')

    const [after] = await h.scheduler.list()
    assert.equal(after.missedRuns, 3, '08:30, 09:00 and 09:30 are missed; 10:00 is the newest')
    assert.equal(after.lastRunAt, '2026-11-15T10:00:00.000Z')
    assert.equal(after.nextRunAt, '2026-11-15T10:30:00.000Z')
    const missed = after.history.find(entry => entry.event === 'missed')
    assert.match(missed.reason, /host was not running for 3 window\(s\)/)
    assert.match(missed.reason, /miss policy "latest"/)

    // A second tick must not replay another missed window.
    assert.deepEqual(await h.scheduler.tick(), [])
    assert.equal(h.orchestrator.calls.length, 1)
  } finally {
    await h.cleanup()
  }
})

test('miss policy "none" skips every due window after downtime', async () => {
  const h = await harness({ now: '2026-11-15T08:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({ everyMinutes: 30, missPolicy: 'none' }))
    h.clock.value = Date.parse('2026-11-15T10:05:00Z')
    const outcomes = await h.scheduler.tick()
    assert.equal(h.orchestrator.calls.length, 0)
    assert.equal(outcomes[0].event, 'missed')
    assert.equal(outcomes[0].missed, 4)
    const after = (await h.scheduler.list()).find(entry => entry.id === plan.id)
    assert.equal(after.missedRuns, 4)
    assert.match(after.misses.at(-1).reason, /miss policy "none"/)
    assert.equal(after.nextRunAt, '2026-11-15T10:30:00.000Z')
  } finally {
    await h.cleanup()
  }
})

test('a restarted host runs the newest missed window and counts it as a catch-up', async () => {
  const h = await harness({ now: '2026-11-15T08:00:00Z' })
  try {
    await h.scheduler.create(planInput({ everyMinutes: 1, ownerRecovery: 'resume' }))
    h.scheduler.stop()

    // The host was down for two windows (08:01, 08:02); the third is now due.
    h.clock.value = Date.parse('2026-11-15T08:03:10Z')
    const restarted = createScheduler({
      stateFile: h.stateFile,
      orchestrator: h.orchestrator,
      resolveOwner: () => ({ id: OWNER }),
      now: () => h.clock.value,
      setInterval: h.timers.setInterval,
      clearInterval: h.timers.clearInterval,
      maxActiveRuns: 2,
    })
    await restarted.init()
    const [after] = await restarted.list()

    assert.equal(h.orchestrator.calls.length, 1, 'the newest missed window runs after restart')
    assert.equal(after.totalRuns, 1)
    assert.equal(after.catchUpRuns, 1)
    assert.equal(after.missedRuns, 2, '08:01 and 08:02 are counted, not replayed')
    assert.equal(after.lastRunAt, '2026-11-15T08:03:00.000Z')
    assert.match(after.history.find(entry => entry.event === 'started').reason, /catch-up run .* after 2 missed window/)
    restarted.stop()
  } finally {
    await h.cleanup()
  }
})

test('a plan whose owner cannot be restored is blocked, not silently paused', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z', resolveOwner: () => null })
  try {
    await h.scheduler.create(planInput({ everyMinutes: 1, ownerRecovery: 'none' }))
    h.clock.value = Date.parse('2026-11-15T00:01:00Z')
    await h.scheduler.tick()
    h.clock.value = Date.parse('2026-11-15T00:02:00Z')
    await h.scheduler.tick()
    h.clock.value = Date.parse('2026-11-15T00:03:00Z')
    await h.scheduler.tick()

    const [after] = await h.scheduler.list()
    assert.equal(after.enabled, true, 'a missing session must not pause a plan the host cannot make durable')
    assert.equal(after.requiresLiveSession, true)
    assert.equal(after.consecutiveFailures, 0)
    assert.equal(after.lastOutcome, 'blocked')
    assert.equal(after.totalRuns, 0)
    assert.equal(h.notifications.filter(item => item.event === 'blocked').length, 1, 'announced once, not every window')
    assert.match(after.history.find(entry => entry.event === 'blocked').reason, /requires a resident session/)
  } finally {
    await h.cleanup()
  }
})

test('a restarted host adopts a replacement session when the old one is gone', async () => {
  const h = await harness({
    now: '2026-11-15T00:00:00Z',
    resolveOwner: async () => ({ agent: { id: 'fresh-session' }, sessionId: 'fresh-session' }),
  })
  try {
    const plan = await h.scheduler.create(planInput({ everyMinutes: 1, ownerRecovery: 'resume' }))
    assert.equal(plan.ownerSessionId, OWNER)
    h.clock.value = Date.parse('2026-11-15T00:01:00Z')
    await h.scheduler.tick()

    assert.equal(h.orchestrator.calls.length, 1)
    assert.equal(h.orchestrator.calls[0].parentSessionId, 'fresh-session')
    assert.equal(h.orchestrator.calls[0].parent.id, 'fresh-session')
    const [after] = await h.scheduler.list()
    assert.equal(after.ownerSessionId, 'fresh-session')
    assert.ok(after.history.some(entry => entry.event === 'owner-recovered'))
  } finally {
    await h.cleanup()
  }
})

test('a window is skipped while the previous run of the same plan is still active', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({ everyMinutes: 1 }))
    h.clock.value = Date.parse('2026-11-15T00:01:00Z')
    await h.scheduler.tick()
    assert.equal(h.orchestrator.calls.length, 1)

    h.clock.value = Date.parse('2026-11-15T00:02:00Z')
    const outcomes = await h.scheduler.tick()
    assert.equal(h.orchestrator.calls.length, 1, 'the second window must not start a run')
    assert.equal(outcomes[0].event, 'skipped')
    assert.equal(outcomes[0].reason, 'skipped: previous run still active')
    const after = (await h.scheduler.list()).find(entry => entry.id === plan.id)
    assert.equal(after.lastOutcome, 'skipped')
    assert.equal(after.skippedRuns, 1)
    assert.match(after.history.at(-1).reason, /skipped: previous run still active/)
    assert.equal(after.nextRunAt, '2026-11-15T00:03:00.000Z')
  } finally {
    await h.cleanup()
  }
})

test('a run resumed after a failure blocks the catch-up after a restart', async () => {
  const h = await harness({ now: '2026-11-15T08:00:00Z' })
  try {
    await h.scheduler.create(planInput({ everyMinutes: 1, ownerRecovery: 'resume' }))
    h.clock.value = Date.parse('2026-11-15T08:01:00Z')
    await h.scheduler.tick()
    assert.equal(h.orchestrator.calls.length, 1)

    // The run fails and the plan records it; the next window is not due yet, so
    // no second run starts.
    const first = h.orchestrator.runs.get('run-1')
    first.status = 'failed'
    first.error = 'the worker crashed'
    await h.scheduler.tick()
    const [failed] = await h.scheduler.list()
    assert.equal(failed.activeRunId, null)
    assert.equal(failed.lastOutcome, 'failed')
    assert.equal(failed.totalRuns, 1)

    // A person resumes that failed run, and the host restarts with 08:02 and
    // 08:03 missed while 08:04 is the due window.
    h.scheduler.stop()
    first.status = 'running'
    h.clock.value = Date.parse('2026-11-15T08:04:10Z')
    const restarted = createScheduler({
      stateFile: h.stateFile,
      orchestrator: h.orchestrator,
      resolveOwner: () => ({ id: OWNER }),
      now: () => h.clock.value,
      setInterval: h.timers.setInterval,
      clearInterval: h.timers.clearInterval,
      maxActiveRuns: 2,
    })
    await restarted.init()
    const [afterRestart] = await restarted.list()

    assert.equal(h.orchestrator.calls.length, 1, 'the resumed run is the only run this plan has started')
    assert.equal(afterRestart.activeRunId, 'run-1', 'the plan tracks the run it did not start itself')
    assert.equal(afterRestart.totalRuns, 1)
    assert.equal(afterRestart.catchUpRuns, 0, 'a catch-up must not start beside the resumed run')
    assert.equal(afterRestart.missedRuns, 2, 'the windows crossed while the host was down are still counted')
    assert.equal(afterRestart.skippedRuns, 1, 'the due window is skipped once, not started')
    assert.equal(afterRestart.nextRunAt, '2026-11-15T08:05:00.000Z')
    assert.ok(afterRestart.history.some(entry => entry.event === 'active-run-recovered'))
    assert.ok(afterRestart.history.some(entry => entry.event === 'skipped'))

    // The run finishes; the next window starts normally instead of skipping.
    first.status = 'completed'
    h.clock.value = Date.parse('2026-11-15T08:05:10Z')
    const outcomes = await restarted.tick()
    assert.equal(outcomes[0].event, 'started')
    assert.equal(h.orchestrator.calls.length, 2)
    const [afterNext] = await restarted.list()
    assert.equal(afterNext.activeRunId, 'run-2')
    assert.equal(afterNext.skippedRuns, 1, 'no further skips once the resumed run is gone')
    restarted.stop()
  } finally {
    await h.cleanup()
  }
})

test('a run stopped by its budget pauses the plan and records the reason once', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({
      everyMinutes: 1,
      budget: { maxModelCalls: 2, maxTokens: 100 },
    }))
    h.clock.value = Date.parse('2026-11-15T00:01:00Z')
    await h.scheduler.tick()
    assert.equal(h.orchestrator.calls[0].overrides.maxTokens, 100)
    assert.equal(h.orchestrator.calls[0].goalMode, null, 'a budget works without goal mode')

    const run = h.orchestrator.runs.get('run-1')
    run.status = 'failed'
    run.error = 'token budget reached (120/100 tokens)'
    run.usage = { totalTokens: 120, modelCalls: 2 }

    h.clock.value = Date.parse('2026-11-15T00:02:00Z')
    const outcomes = await h.scheduler.tick()
    assert.equal(outcomes[0].event, 'budget')
    assert.equal(h.orchestrator.calls.length, 1, 'a budget stop must not start another run')
    const after = (await h.scheduler.list()).find(entry => entry.id === plan.id)
    assert.equal(after.enabled, false)
    assert.match(after.pausedReason, /budget reached: token budget reached/)
    assert.deepEqual(h.notifications.map(item => item.event), ['budget'])
    assert.match(h.notifications[0].message, /schedule "nightly check"/)
    assert.match(h.notifications[0].message, /The plan is paused/)
  } finally {
    await h.cleanup()
  }
})

test('a plan total budget stops the next window before it starts', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({
      everyMinutes: 1,
      budget: { maxTotalTokens: 5 },
    }))
    h.clock.value = Date.parse('2026-11-15T00:01:00Z')
    await h.scheduler.tick()
    const run = h.orchestrator.runs.get('run-1')
    run.status = 'completed'
    run.usage = { totalTokens: 12, modelCalls: 1 }

    h.clock.value = Date.parse('2026-11-15T00:02:00Z')
    const outcomes = await h.scheduler.tick()
    assert.equal(h.orchestrator.calls.length, 1)
    assert.equal(outcomes[0].event, 'budget')
    assert.deepEqual(h.notifications.map(item => item.event), ['achieved', 'budget'])
    const after = (await h.scheduler.list()).find(entry => entry.id === plan.id)
    assert.equal(after.enabled, false)
    assert.match(after.pausedReason, /token budget reached \(12\/5 tokens\)/)
  } finally {
    await h.cleanup()
  }
})

test('three consecutive failures pause the plan and notify only twice', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({ everyMinutes: 1 }))
    for (let minute = 1; minute <= 3; minute++) {
      h.clock.value = Date.parse(`2026-11-15T00:0${minute}:00Z`)
      await h.scheduler.tick()
      const run = h.orchestrator.runs.get(`run-${minute}`)
      run.status = 'failed'
      run.error = 'the worker crashed'
    }
    h.clock.value = Date.parse('2026-11-15T00:04:00Z')
    const outcomes = await h.scheduler.tick()
    assert.equal(outcomes[0].event, 'failed')
    assert.equal(h.orchestrator.calls.length, 3, 'the plan pauses instead of starting a fourth run')
    const after = (await h.scheduler.list()).find(entry => entry.id === plan.id)
    assert.equal(after.enabled, false)
    assert.equal(after.consecutiveFailures, 3)
    assert.match(after.pausedReason, /paused after 3 consecutive failure/)
    // First failure announces itself; the second is silent; the pause is once.
    assert.deepEqual(h.notifications.map(item => item.event), ['failed', 'paused'])
  } finally {
    await h.cleanup()
  }
})

test('a scheduled run defers to a manual run and a manual start is not squeezed out', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-quota-'))
  const gates = new Map()
  const prompts = []
  const gateFor = text => {
    let release
    const promise = new Promise(resolve => {
      release = resolve
    })
    gates.set(text, release)
    return promise
  }
  const spawner = {
    prompts,
    async spawnChild(spec) {
      const prompt = spec.prompt
      prompts.push(prompt)
      return {
        childId: `child-${prompts.length}`,
        result: gateFor(prompt).then(() => ({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })),
        dispose: async () => {},
      }
    },
    release(substring) {
      for (const [prompt, release] of gates) {
        if (prompt.includes(substring)) release()
      }
    },
  }
  const parent = { id: OWNER }
  const orchestrator = createOrchestrator({
    store: memoryStore(),
    config: {
      maxSubtasks: 4,
      maxParallel: 2,
      maxActiveRuns: 2,
      attempts: 1,
      deadlineMinutes: 30,
      resultCapBytes: 32 * 1024,
      maxModelCallsPerRun: 0,
      maxTokensPerRun: 0,
    },
    spawnChild: spawner.spawnChild,
    readUsage: async () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2, modelCalls: 1, models: {} }),
    memory: null,
    notify: () => {},
    log: () => {},
  })
  const clock = { value: Date.parse('2026-11-15T00:00:00Z') }
  const scheduler = createScheduler({
    stateFile: path.join(dir, 'schedules.json'),
    orchestrator,
    resolveOwner: () => parent,
    now: () => clock.value,
    setInterval: () => null,
    clearInterval: () => {},
    humanPriority: true,
    maxActiveRuns: 2,
    warn: () => {},
  })
  try {
    await scheduler.init()
    const plan = await scheduler.create(planInput({
      name: 'quota plan',
      everyMinutes: 1,
      mode: 'direct',
    }))
    clock.value = Date.parse('2026-11-15T00:01:00Z')

    // One manual run occupies a slot; the scheduler must leave the other one
    // for a person, so its due window is deferred rather than started.
    await orchestrator.start({ goal: 'manual goal', parentSessionId: OWNER, parent, mode: 'direct' })
    await waitFor(() => spawner.prompts.length === 1)
    const deferred = await scheduler.tick()
    assert.equal(deferred[0].event, 'deferred')
    assert.equal(spawner.prompts.length, 1, 'the scheduled run must not take the reserved slot')
    assert.match((await scheduler.list())[0].lastReason, /one slot is reserved for manual runs/)
    assert.equal((await scheduler.list())[0].nextRunAt, '2026-11-15T00:01:00.000Z', 'a deferred window is not consumed')

    // With the manual run finished, the same window starts.
    spawner.release('manual goal')
    await orchestrator.idle()
    const started = await scheduler.tick()
    assert.equal(started[0].event, 'started')
    await waitFor(() => spawner.prompts.length === 2)
    assert.match(spawner.prompts[1], /check the release gate/)
    const record = await orchestrator.status(started[0].run.id)
    assert.equal(record.origin.kind, 'scheduled')
    assert.equal(record.notifyMuted, true, 'the scheduler reports the outcome, not the run notifier')

    // A manual start still fits next to the scheduled run: 1 active, cap 2.
    const manualAgain = await orchestrator.start({
      goal: 'second manual goal',
      parentSessionId: OWNER,
      parent,
      mode: 'direct',
    })
    assert.ok(['planning', 'running', 'queued'].includes(manualAgain.status), 'a manual start must not be refused')
    assert.equal((await orchestrator.activeSnapshot()).manualActive, 1)
    assert.equal((await orchestrator.activeSnapshot()).scheduledActive, 1)

    await waitFor(() => spawner.prompts.length === 3)
    spawner.release('release gate')
    spawner.release('second manual goal')
    await orchestrator.idle()
  } finally {
    scheduler.stop()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('mounting with no plan leaves the scheduler off and writes no schedule file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-off-'))
  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: () => undefined,
  }
  try {
    apply(ctx, { stateDir: dir, notifyOnComplete: false })
    assert.equal(tools.size, 14)
    const listed = await tools.get('superagent_schedule').execute({ action: 'list' }, { agent: { id: OWNER } })
    assert.match(listed, /no scheduled runs/)
    await assert.rejects(fsp.access(path.join(dir, 'schedules.json')), 'listing must not create state')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

function memoryStore() {
  const runs = new Map()
  const cancels = new Set()
  const locks = new Map()
  const store = {
    owner: null,
    async init() {},
    async list() {
      return [...runs.values()].map(run => structuredClone(run))
    },
    async read(id) {
      const run = runs.get(id)
      return run ? structuredClone(run) : null
    },
    async write(run) {
      runs.set(run.id, structuredClone(run))
    },
    async requestCancel(id) {
      cancels.add(id)
      return true
    },
    async hasCancelRequest(id) {
      return cancels.has(id)
    },
    async clearCancel(id) {
      cancels.delete(id)
    },
    async readOwner() {
      return store.owner
    },
    async writeOwner(owner) {
      store.owner = owner
    },
    async acquireLock(id, holder) {
      if (locks.has(id)) return { acquired: false, holder: locks.get(id) }
      locks.set(id, holder)
      return { acquired: true, holder }
    },
    async readLock(id) {
      return locks.get(id) ?? null
    },
    async releaseLock(id) {
      locks.delete(id)
    },
  }
  return store
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
