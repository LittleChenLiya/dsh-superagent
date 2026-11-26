import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CronError } from '../lib/cron.js'
import { apply } from '../lib/index.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createScheduler, formatScheduleList, rruleFromCron, rruleWithStart } from '../lib/schedule.js'

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
  execute = undefined,
} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-'))
  const clock = { value: Date.parse(now) }
  const notifications = []
  const timers = fakeTimers()
  const scheduler = createScheduler({
    stateFile: path.join(dir, 'schedules.json'),
    orchestrator,
    execute,
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

test('the default executor keeps the orchestrator path and timestamps ticks and run-now', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    const plan = await h.scheduler.create(planInput({ everyMinutes: 1 }))
    assert.equal(plan.execution, null)
    h.clock.value = Date.parse('2026-11-15T00:01:00Z')
    const [started] = await h.scheduler.tick()

    assert.equal(started.event, 'started')
    assert.equal(h.orchestrator.calls.length, 1)
    assert.equal(h.orchestrator.calls[0].scheduledAt, '2026-11-15T00:01:00.000Z')
    assert.equal(h.orchestrator.calls[0].parent.id, OWNER)
    assert.equal(h.orchestrator.calls[0].parentSessionId, OWNER)
    assert.deepEqual(h.orchestrator.calls[0].origin, {
      kind: 'scheduled', scheduleId: plan.id, scheduleName: plan.name,
    })

    h.orchestrator.runs.get('run-1').status = 'completed'
    h.clock.value = Date.parse('2026-11-15T00:01:30Z')
    const manual = await h.scheduler.runNow(plan.id)
    assert.equal(manual.run.id, 'run-2')
    assert.equal(h.orchestrator.calls.length, 2)
    assert.equal(h.orchestrator.calls[1].scheduledAt, '2026-11-15T00:01:30.000Z')
    assert.equal(manual.plan.nextRunAt, '2026-11-15T00:02:00.000Z', 'run-now keeps the planned grid')
    assert.equal(manual.plan.lastRunAt, '2026-11-15T00:01:00.000Z')
  } finally {
    await h.cleanup()
  }
})

test('an injected router executor gets the exact plan context and its returned runs are tracked', async () => {
  const orchestrator = fakeOrchestrator()
  const invocations = []
  let ownerResolutions = 0
  const execution = {
    kind: 'router',
    action: { type: 'followup', taskId: 'task-42', phaseId: 'phase-1' },
    output: { relativePath: 'reports/router.md' },
    notify: { events: ['completed'] },
    metadata: { attempt: 1, labels: ['release', 'gate'] },
  }
  const h = await harness({
    now: '2026-11-15T00:00:00Z',
    orchestrator,
    resolveOwner: () => {
      ownerResolutions += 1
      throw new Error('a router plan must not resolve a live owner')
    },
    execute: async (args, context) => {
      invocations.push({ args, context })
      const run = {
        id: `router-run-${invocations.length}`,
        status: 'running',
        origin: args.origin,
        usage: null,
        attention: null,
        goalMode: null,
      }
      orchestrator.runs.set(run.id, run)
      return structuredClone(run)
    },
  })
  try {
    const plan = await h.scheduler.create(planInput({
      everyMinutes: 1,
      ownerRecovery: 'none',
      execution,
    }))
    const before = (await h.scheduler.list())[0]
    const dueAt = '2026-11-15T00:01:00.000Z'
    h.clock.value = Date.parse(dueAt)
    const [started] = await h.scheduler.tick()

    assert.equal(ownerResolutions, 0, 'router execution must not require or recover a live session')
    assert.equal(orchestrator.calls.length, 0, 'the injected executor replaces orchestrator.start')
    assert.equal(invocations.length, 1)
    assert.deepEqual(invocations[0].context, { plan: before, dueAt, catchUp: false, missedCount: 0 })
    assert.equal(invocations[0].args.scheduledAt, dueAt)
    assert.deepEqual(invocations[0].args.parent, { id: OWNER })
    assert.equal(invocations[0].args.parentSessionId, OWNER)
    assert.equal(started.run.id, 'router-run-1')

    const [afterStart] = await h.scheduler.list()
    assert.equal(afterStart.activeRunId, 'router-run-1')
    assert.equal(afterStart.lastRunId, 'router-run-1')
    assert.equal(afterStart.lastStatus, 'running')
    assert.equal(afterStart.totalRuns, 1)

    const first = orchestrator.runs.get('router-run-1')
    first.status = 'completed'
    first.usage = { totalTokens: 7, modelCalls: 2 }
    h.clock.value = Date.parse('2026-11-15T00:01:30Z')
    assert.deepEqual(await h.scheduler.tick(), [], 'the finished injected run is reconciled without another due window')
    const settled = (await h.scheduler.list())[0]
    assert.equal(settled.activeRunId, null)
    assert.equal(settled.lastOutcome, 'achieved')
    assert.equal(settled.totalTokens, 7)
    assert.equal(settled.totalModelCalls, 2)

    h.clock.value = Date.parse('2026-11-15T00:01:40Z')
    const manual = await h.scheduler.runNow(plan.id)
    assert.equal(manual.run.id, 'router-run-2')
    assert.deepEqual(invocations[1].context, {
      plan: settled,
      dueAt: '2026-11-15T00:01:40.000Z',
      catchUp: false,
      missedCount: 0,
    })
    assert.equal(invocations[1].args.scheduledAt, '2026-11-15T00:01:40.000Z')
    assert.equal(manual.plan.activeRunId, 'router-run-2')
    assert.equal(manual.plan.nextRunAt, '2026-11-15T00:02:00.000Z')
    assert.equal(manual.plan.totalRuns, 2)
    assert.equal(ownerResolutions, 0)
    assert.equal(orchestrator.calls.length, 0)
  } finally {
    await h.cleanup()
  }
})

test('plain-JSON execution metadata is persisted and restored by init migration', async () => {
  const h = await harness({ now: '2026-11-15T00:00:00Z' })
  try {
    const execution = {
      kind: 'router',
      action: { type: 'task', prompt: 'check the release', target: null },
      output: { relativePath: 'reports/gate.md' },
      notify: { events: ['started', 'completed'] },
      budget: { maxRuns: 3 },
    }
    const expected = structuredClone(execution)
    const created = await h.scheduler.create(planInput({ execution }))
    assert.deepEqual(created.execution, expected)
    execution.action.type = 'followup'
    assert.equal(created.execution.action.type, 'task', 'normalization must not retain the caller object')

    const persisted = JSON.parse(await fsp.readFile(h.stateFile, 'utf8'))
    assert.deepEqual(persisted.plans[0].execution, expected)
    h.scheduler.stop()

    const restarted = createScheduler({
      stateFile: h.stateFile,
      orchestrator: h.orchestrator,
      resolveOwner: () => { throw new Error('init must not need a router owner') },
      now: () => h.clock.value,
      setInterval: h.timers.setInterval,
      clearInterval: h.timers.clearInterval,
    })
    await restarted.init()
    const [migrated] = await restarted.list()
    assert.equal(migrated.id, created.id)
    assert.deepEqual(migrated.execution, expected)
    restarted.stop()
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

function mountScheduleTool(dir) {
  const tools = new Map()
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    get: () => undefined,
    get schedule() { throw new Error('cannot get property "schedule" without inject') },
  }
  apply(ctx, { stateDir: dir, notifyOnComplete: false })
  return tools.get('superagent_schedule')
}

function agentWithHostSchedule(depth = 0) {
  return {
    id: OWNER,
    session: { header: { delegationDepth: depth }, cwd: process.cwd() },
    ctx: { tools: { get: name => (name === 'schedule_create' ? { name: 'schedule_create' } : undefined) } },
  }
}

test('cron is only converted to RRULE when the mapping is exact', () => {
  assert.equal(rruleFromCron('*/15 * * * *'), 'FREQ=MINUTELY;INTERVAL=15')
  assert.equal(rruleFromCron('30 8 * * *'), 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30')
  assert.equal(rruleFromCron('0 9 * * MON-FRI'), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0')
  assert.equal(rruleFromCron('30 8 * * 1-5,0'), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SU;BYHOUR=8;BYMINUTE=30')
  assert.equal(rruleFromCron('15 2 1 * *'), null, 'day-of-month has no place in the host DAILY shape')
  assert.equal(rruleFromCron('0 9 * * MON#2'), null)
  assert.equal(
    rruleWithStart('FREQ=DAILY;BYHOUR=8;BYMINUTE=30', 'Asia/Shanghai', Date.UTC(2026, 10, 17, 1, 2, 3)),
    'DTSTART;TZID=Asia/Shanghai:20261117T090203\nRRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=30',
  )
})

test('a session that can call schedule_create gets a handoff, not a plugin timer', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-handoff-'))
  try {
    const tool = mountScheduleTool(dir)
    const out = await tool.execute({
      action: 'create',
      name: 'gate check',
      goal: 'check the release gate',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
    }, { agent: agentWithHostSchedule() })
    assert.match(out, /handoff/)
    assert.match(out, /schedule_create/)
    assert.match(out, /DTSTART;TZID=Asia\/Shanghai:\d{8}T\d{6}/)
    assert.match(out, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0/)
    assert.match(out, /"target": "this_session"/)
    assert.match(out, /superagent_start/)
    await assert.rejects(fsp.access(path.join(dir, 'schedules.json')), 'a handoff must not write plugin state')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('without schedule_create the plugin keeps its timer and says why', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-local-'))
  try {
    const tool = mountScheduleTool(dir)
    const out = await tool.execute({
      action: 'create',
      name: 'local check',
      goal: 'check the release gate',
      every_minutes: 15,
      timezone: 'UTC',
    }, { agent: { id: OWNER } })
    assert.match(out, /plugin-local timer is armed/)
    assert.match(out, /cannot call schedule_create/)
    const listed = await tool.execute({ action: 'list' }, { agent: { id: OWNER } })
    assert.match(listed, /engine: plugin-local timer \(fallback: this session cannot call schedule_create/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a delegated subagent falls back because the host tool would refuse it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-child-'))
  try {
    const tool = mountScheduleTool(dir)
    const out = await tool.execute({
      action: 'create',
      name: 'child check',
      goal: 'check the release gate',
      every_minutes: 15,
      timezone: 'UTC',
    }, { agent: agentWithHostSchedule(1) })
    assert.match(out, /delegated subagent cannot call schedule_create/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a cron with no lossless RRULE mapping stays local even with the host tool', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-cron-'))
  try {
    const tool = mountScheduleTool(dir)
    const out = await tool.execute({
      action: 'create',
      name: 'monthly check',
      goal: 'check the release gate',
      cron: '15 2 1 * *',
      timezone: 'UTC',
    }, { agent: agentWithHostSchedule() })
    assert.match(out, /no lossless RRULE equivalent/)
    assert.match(out, /plugin-local timer is armed/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('migrate pauses local plans and returns schedule_create payloads', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-migrate-'))
  try {
    const tool = mountScheduleTool(dir)
    await tool.execute({
      action: 'create',
      name: 'legacy check',
      goal: 'check the release gate',
      every_minutes: 30,
      timezone: 'UTC',
      goal_mode: true,
      acceptance: [{ text: 'Gate exists', check: { type: 'file', path: 'gate.txt' } }],
    }, { agent: { id: OWNER } })
    const out = await tool.execute({ action: 'migrate' }, { agent: agentWithHostSchedule() })
    assert.match(out, /migration: 1 plan\(s\)/)
    assert.match(out, /"pluginId"/)
    assert.match(out, /"title": "legacy check"/)
    assert.match(out, /RRULE:FREQ=MINUTELY;INTERVAL=30/)
    assert.match(out, /Gate exists/)
    assert.match(out, /gate\.txt/)
    assert.match(out, /action="delete"/)
    const listed = await tool.execute({ action: 'list' }, { agent: { id: OWNER } })
    assert.match(listed, /paused: migrating to a Host scheduled task/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a schedule with a whole-plan cap stays enabled in the plugin after migration is requested', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-budget-'))
  try {
    const tool = mountScheduleTool(dir)
    const agent = agentWithHostSchedule()
    const out = await tool.execute({
      action: 'create', name: 'limited check', goal: 'check the release gate', every_minutes: 30,
      budget: { max_total_runs: 2 },
    }, { agent })
    assert.match(out, /local timer is armed/)
    const migrated = await tool.execute({ action: 'migrate' }, { agent })
    assert.match(migrated, /migration: 0 plan\(s\)/)
    assert.match(migrated, /cannot enforce the plugin plan budget/)
    const listed = await tool.execute({ action: 'list' }, { agent })
    assert.doesNotMatch(listed, /paused: migrating/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
