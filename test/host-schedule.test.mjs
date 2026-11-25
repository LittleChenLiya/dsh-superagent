import assert from 'node:assert/strict'
import test from 'node:test'

import { createHostScheduleAdapter } from '../lib/host-schedule.js'

const SESSION = 'session-target'
const NOW = '2026-11-25T12:00:00.000Z'

function plan(overrides = {}) {
  return {
    id: 'sch-local',
    name: 'Nightly release check',
    goal: 'Verify the release gate and write the result.',
    mode: 'direct',
    cwd: 'D:/work/release',
    budget: null,
    ownerSessionId: 'session-owner-not-for-prompt',
    schedule: { cron: '0 9 * * MON-FRI', timeZone: 'Asia/Shanghai' },
    ...overrides,
  }
}

function rawFromRequest(request, sequence) {
  const timing = request.timing
  return {
    id: `schedule-${sequence}`,
    kind: timing.kind,
    title: request.title,
    prompt: request.prompt,
    ...(timing.kind === 'cron'
      ? { expression: timing.cron.expression, timeZone: timing.cron.time_zone }
      : { everySeconds: timing.every_seconds }),
    scheduledAt: '2026-11-26T01:00:00.000Z',
    target: request.target,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function fakeService() {
  const tasks = new Map()
  const calls = []
  let sequence = 0
  const record = (method, args) => calls.push({ method, args })
  return {
    tasks,
    calls,
    async create(request, actorSessionId) {
      record('create', [request, actorSessionId])
      const raw = rawFromRequest(request, ++sequence)
      tasks.set(raw.id, structuredClone(raw))
      return structuredClone(raw)
    },
    async list(request = {}) {
      record('list', [request])
      const offset = request.offset ?? 0
      const limit = request.limit ?? 100
      const all = [...tasks.values()]
        .filter(task => request.active === undefined || (task.status === 'active') === request.active)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      return {
        items: structuredClone(all.slice(offset, offset + limit)),
        shown: Math.min(limit, Math.max(0, all.length - offset)),
        total: all.length,
        limit,
        offset,
      }
    },
    async view(request) {
      record('view', [request])
      const task = tasks.get(request.id)
      return task ? structuredClone(task) : { id: request.id, code: 'schedule_not_found' }
    },
    async edit(request) {
      record('edit', [request])
      const task = tasks.get(request.id)
      if (!task) return { id: request.id, code: 'schedule_not_found' }
      if (request.action === 'delete') {
        tasks.delete(request.id)
        return { id: request.id, deleted: true }
      }
      Object.assign(task, request.patch)
      task.status = request.patch.active ? 'active' : 'paused'
      return structuredClone(task)
    },
    async run(request) {
      record('run', [request])
      const task = tasks.get(request.id)
      return task ? structuredClone(task) : { id: request.id, code: 'schedule_not_found' }
    },
    async history(request) {
      record('history', [request])
      return tasks.has(request.id)
        ? { id: request.id, records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false }
        : { id: request.id, code: 'schedule_not_found' }
    },
    async deleteInactive() {
      record('deleteInactive', [])
      let deleted = 0
      for (const [id, task] of tasks) {
        if (task.status === 'ended') {
          tasks.delete(id)
          deleted += 1
        }
      }
      return { deleted }
    },
  }
}

function adapterFor(service, log = () => {}) {
  return createHostScheduleAdapter({ schedule: { schedule: service }, log })
}

function lastCall(service, method) {
  return service.calls.filter(call => call.method === method).at(-1)
}

test('a late-registered host service is resolved at call time', async () => {
  let service = null
  const host = createHostScheduleAdapter({ schedule: () => service })
  assert.equal(host.available(), false)
  service = fakeService()
  assert.equal(host.available(), true)
  const created = await host.createFromPlan(plan(), SESSION)
  assert.equal(created.id, 'schedule-1')
})

test('cron plans use native create with a session target and recoverable prompt', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  assert.equal(host.available(), true)

  const created = await host.createFromPlan(plan(), SESSION)
  assert.equal(created.id, 'schedule-1')
  assert.equal(created.raw.kind, 'cron')
  assert.deepEqual(lastCall(service, 'create').args, [{
    title: 'Nightly release check',
    prompt: created.raw.prompt,
    timing: { kind: 'cron', cron: { expression: '0 9 * * MON-FRI', time_zone: 'Asia/Shanghai' } },
    target: { kind: 'session', sessionId: SESSION },
  }, SESSION])

  const args = JSON.parse(created.raw.prompt.slice(created.raw.prompt.indexOf('{')))
  assert.deepEqual(args, {
    goal: 'Verify the release gate and write the result.',
    mode: 'direct',
    allow_duplicate: true,
    scheduled: true,
    reserve_slot: true,
    schedule_id: 'host:sch-local',
  })
  assert.match(created.raw.prompt, /superagent_start/)
  assert.doesNotMatch(created.raw.prompt, /session-owner-not-for-prompt|session-target|session_id|sessionId/)
})

test('everyMinutes becomes native every_seconds without a cron timezone', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  const input = plan({
    schedule: { cron: null, everyMinutes: 5, timeZone: 'Asia/Shanghai' },
    budget: null,
  })
  const created = await host.createFromPlan(input, SESSION)
  assert.deepEqual(lastCall(service, 'create').args[0].timing, { kind: 'every', every_seconds: 300 })
  assert.deepEqual(lastCall(service, 'create').args[0].target, { kind: 'session', sessionId: SESSION })
  const args = JSON.parse(created.raw.prompt.slice(created.raw.prompt.indexOf('{')))
  assert.deepEqual(args, {
    goal: input.goal,
    mode: input.mode,
    allow_duplicate: true,
    scheduled: true,
    reserve_slot: true,
    schedule_id: 'host:sch-local',
  })
})

test('plans with budgets or unsupported delivery policies stay local', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  await assert.rejects(() => host.createFromPlan(plan({ budget: { maxModelCalls: 1 } }), SESSION), /cannot enforce the plugin plan budget/)
  await assert.rejects(() => host.createFromPlan(plan({ concurrency: { humanPriority: false } }), SESSION), /priority policy/)
  assert.equal(service.calls.length, 0)
})

test('list maps native records and follows real list pagination', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  await host.createFromPlan(plan(), SESSION)
  await host.createFromPlan(plan({ name: 'Interval', schedule: { everyMinutes: 10 } }), SESSION)
  service.tasks.get('schedule-1').status = 'paused'

  assert.deepEqual(await host.list(), [
    {
      id: 'schedule-1',
      title: 'Nightly release check',
      prompt: service.tasks.get('schedule-1').prompt,
      timing: { kind: 'cron', cron: { expression: '0 9 * * MON-FRI', time_zone: 'Asia/Shanghai' } },
      target: { kind: 'session', sessionId: SESSION },
      status: 'paused',
      updatedAt: NOW,
    },
    {
      id: 'schedule-2',
      title: 'Interval',
      prompt: service.tasks.get('schedule-2').prompt,
      timing: { kind: 'every', every_seconds: 600 },
      target: { kind: 'session', sessionId: SESSION },
      status: 'active',
      updatedAt: NOW,
    },
  ])
  assert.deepEqual(lastCall(service, 'list').args, [{ limit: 500, offset: 0 }])

  const paged = fakeService()
  for (let index = 0; index < 501; index += 1) {
    const raw = rawFromRequest({
      title: `Task ${index}`,
      prompt: 'run',
      timing: { kind: 'every', every_seconds: 60 },
      target: { kind: 'session', sessionId: SESSION },
    }, index)
    paged.tasks.set(raw.id, raw)
  }
  const originalList = paged.list
  paged.list = async request => {
    if (request.offset === 0) {
      return { items: structuredClone([...paged.tasks.values()].slice(0, 500)), total: 501 }
    }
    return originalList.call(paged, request)
  }
  const pageHost = adapterFor(paged)
  const listed = await pageHost.list()
  assert.equal(listed.length, 501)
  assert.deepEqual(lastCall(paged, 'list').args, [{ limit: 500, offset: 500 }])
})

test('pause, resume, remove, runNow, and view delegate to native methods', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  const { id } = await host.createFromPlan(plan(), SESSION)

  const paused = await host.pause(id)
  assert.equal(paused.raw.status, 'paused')
  assert.deepEqual(lastCall(service, 'edit').args, [{ id, action: 'update', patch: { active: false } }])

  const resumed = await host.resume(id)
  assert.equal(resumed.id, id)
  assert.equal(resumed.raw.status, 'active')
  assert.deepEqual(lastCall(service, 'edit').args, [{ id, action: 'update', patch: { active: true } }])

  const viewed = await host.view(id)
  assert.equal(viewed.raw.id, id)
  assert.deepEqual(lastCall(service, 'view').args, [{ id }])

  const run = await host.runNow(id)
  assert.equal(run.id, id)
  assert.deepEqual(lastCall(service, 'run').args, [{ id }])

  const removed = await host.remove(id)
  assert.deepEqual(removed, { id, raw: { id, deleted: true } })
  assert.deepEqual(lastCall(service, 'edit').args, [{ id, action: 'delete' }])
  assert.equal(service.tasks.size, 0)
})

test('history and deleteInactive call their native service methods', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  const { id } = await host.createFromPlan(plan(), SESSION)
  const history = await host.history(id, 20)
  assert.equal(history.id, id)
  assert.deepEqual(lastCall(service, 'history').args, [{ id, limit: 20 }])
  service.tasks.get(id).status = 'ended'
  assert.deepEqual(await host.deleteInactive(), { deleted: 1 })
  assert.deepEqual(lastCall(service, 'deleteInactive').args, [])
})

test('missing or incomplete ctx.schedule is unavailable and every operation rejects', async () => {
  for (const service of [undefined, null, { create() {} }]) {
    const host = adapterFor(service)
    assert.equal(host.available(), false)
    const operations = [
      () => host.createFromPlan(plan(), SESSION),
      () => host.list(),
      () => host.pause('schedule-1'),
      () => host.resume('schedule-1'),
      () => host.remove('schedule-1'),
      () => host.runNow('schedule-1'),
      () => host.view('schedule-1'),
      () => host.history('schedule-1'),
      () => host.deleteInactive(),
    ]
    for (const operation of operations) {
      await assert.rejects(operation, error => {
        assert.equal(error.code, 'host-schedule-unavailable')
        assert.match(error.message, /ctx\.schedule.*no local fallback/)
        return true
      })
    }
  }
})

test('native refusal results become explicit errors rather than false success', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  await assert.rejects(host.view('missing'), { code: 'schedule_not_found' })
  service.run = async () => ({ id: 'schedule-1', code: 'schedule_execution_pending' })
  await assert.rejects(host.runNow('schedule-1'), { code: 'schedule_execution_pending' })
  service.edit = async () => ({ id: 'schedule-1', code: 'schedule_conflict' })
  await assert.rejects(host.pause('schedule-1'), { code: 'schedule_conflict' })
  await assert.rejects(host.remove('schedule-1'), { code: 'schedule_conflict' })
})

test('native exceptions and malformed responses reject and are logged', async () => {
  const messages = []
  const service = fakeService()
  const failure = new Error('storage unavailable')
  service.create = async () => { throw failure }
  const host = adapterFor(service, message => messages.push(message))
  await assert.rejects(host.createFromPlan(plan(), SESSION), error => error === failure)
  assert.match(messages.at(-1), /Host Schedule create failed: storage unavailable/)

  service.list = async () => ({ items: 'not-an-array' })
  await assert.rejects(host.list(), { code: 'host-schedule-invalid-response' })
})

test('invalid plugin plans are rejected before native create', async () => {
  const service = fakeService()
  const host = adapterFor(service)
  await assert.rejects(host.createFromPlan(plan({ schedule: {} }), SESSION), /cron or everyMinutes/)
  await assert.rejects(host.createFromPlan(plan({
    schedule: { cron: '0 9 * * *', everyMinutes: 5 },
  }), SESSION), /not both/)
  await assert.rejects(host.createFromPlan(plan({ schedule: { everyMinutes: 0 } }), SESSION), /positive safe integer/)
  await assert.rejects(host.createFromPlan(plan({ goal: '' }), SESSION), /plan\.goal/)
  await assert.rejects(host.createFromPlan(plan(), ''), /needs sessionId/)
  assert.equal(service.calls.length, 0)
})
