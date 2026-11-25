import assert from 'node:assert/strict'
import test from 'node:test'

import { createObservability } from '../lib/observability.js'

function fakeServices(overrides = {}) {
  const calls = {
    create: [],
    emit: [],
    shutdown: [],
    failures: [],
    listEvents: [],
    readSession: [],
    inspect: [],
    pressure: [],
    measure: [],
    logs: [],
  }
  const session = { seq: 3 }
  const services = {
    calls,
    session,
    events: [
      { sessionId: 'session-1', seq: 0, type: 'session/start', time: 100 },
      { sessionId: 'session-1', seq: 2, type: 'assistant/message', time: 200 },
    ],
    otel: {
      createEventReporter(options) {
        calls.create.push(options)
        return {
          emit(record) {
            calls.emit.push(record)
            return overrides.emit?.(record)
          },
          shutdown(signal) {
            calls.shutdown.push(signal)
            return overrides.shutdown?.(signal)
          },
        }
      },
    },
    sessionQuery: {
      async listEvents(sessionId) {
        calls.listEvents.push(sessionId)
        if (overrides.listEvents) return overrides.listEvents(sessionId)
        return services.events
      },
      async readSession(sessionId) {
        calls.readSession.push(sessionId)
        return { session: { id: sessionId }, inheritedEventCount: 1, events: services.events }
      },
      async inspectSession(sessionId, read) {
        calls.inspect.push(sessionId)
        if (overrides.inspectSession) return overrides.inspectSession(sessionId, read)
        return read(session)
      },
    },
    tokenMeter: {
      contextPressure(value) {
        calls.pressure.push(value)
        if (overrides.contextPressure) return overrides.contextPressure(value)
        return { pressureTokens: 900, contextWindow: 4096 }
      },
      measure(value) {
        calls.measure.push(value)
        if (overrides.measure) return overrides.measure(value)
        return {
          logRevision: 3,
          totalTokens: 1200,
          surfaceTokens: 1000,
          surfaceDeltaTokens: 0,
          baseline: { kind: 'usage' },
          nodes: [{ seq: 0, tokens: 1000 }],
        }
      },
    },
    log: {
      warn(...args) { calls.logs.push(['warn', ...args]) },
      error(...args) { calls.logs.push(['error', ...args]) },
    },
  }
  return services
}

function enabledConfig(extra = {}) {
  return {
    enabled: true,
    serviceName: 'dsh-superagent',
    endpoint: 'https://collector.example/v1/logs',
    exportSessionLogs: false,
    ...extra,
  }
}

function nullPressure() {
  return {
    totalTokens: null,
    surfaceTokens: null,
    pressureTokens: null,
    contextWindow: null,
    logRevision: null,
    surfaceDeltaTokens: null,
    baselineKind: null,
  }
}

function nullSummary() {
  return {
    eventCount: null,
    inheritedEventCount: null,
    lastEventSeq: null,
    lastEventType: null,
    lastEventTime: null,
  }
}

test('a late otel service creates its reporter on the first event', () => {
  const services = fakeServices()
  let otel = null
  const adapter = createObservability({ otel: () => otel, config: enabledConfig() })
  assert.equal(adapter.status().reporting, 'inactive')
  otel = services.otel
  adapter.record({ runId: 'run-late', status: 'completed' })
  assert.equal(services.calls.create.length, 1)
  assert.equal(services.calls.emit.length, 1)
  assert.equal(adapter.status().reporting, 'active')
  return adapter.dispose()
})

test('late session-query and token-meter services are resolved when status is read', async () => {
  let query = null
  let meter = null
  const adapter = createObservability({
    sessionQuery: () => query,
    tokenMeter: () => meter,
    config: { enabled: true },
  })
  assert.equal(adapter.status().snapshot, 'unavailable')
  query = {
    async listEvents() { return [{ seq: 1, type: 'turn/start', time: 10 }] },
    async inspectSession(id, read) { return read({ id }) },
  }
  meter = {
    contextPressure() { return { pressureTokens: 12, contextWindow: 100 } },
    measure() { return { totalTokens: 20, surfaceTokens: 18, logRevision: 1 } },
  }
  assert.equal(adapter.status().snapshot, 'available')
  const snapshot = await adapter.snapshot('session-late')
  assert.equal(snapshot.sessionQuery.eventCount, 1)
  assert.equal(snapshot.tokenPressure.pressureTokens, 12)
  assert.equal(snapshot.tokenPressure.totalTokens, 20)
})

test('disabled observability is a complete no-op and explains why', async () => {
  const services = fakeServices()
  const observability = createObservability(services)

  observability.record({ sessionId: 'session-1', prompt: 'secret' })
  const snapshot = await observability.snapshot('session-1')

  assert.equal(services.calls.create.length, 0)
  assert.equal(services.calls.emit.length, 0)
  assert.equal(services.calls.listEvents.length, 0)
  assert.equal(services.calls.inspect.length, 0)
  assert.equal(services.calls.shutdown.length, 0)
  assert.equal(services.calls.logs.length, 0)
  assert.match(observability.status().reason, /disabled/)
  assert.equal(observability.status().enabled, false)
  await observability.dispose()
  assert.deepEqual(snapshot, {
    sessionId: 'session-1',
    tokenPressure: nullPressure(),
    sessionQuery: nullSummary(),
  })
})

test('enabled observability without any service remains a no-op', async () => {
  const observability = createObservability({ config: enabledConfig() })
  observability.record({ status: 'done' })
  const snapshot = await observability.snapshot('session-1')
  assert.deepEqual(snapshot, {
    sessionId: 'session-1',
    tokenPressure: nullPressure(),
    sessionQuery: nullSummary(),
  })

  assert.match(observability.status().reason, /no observability services/)
  assert.equal(observability.status().enabled, false)
  assert.equal(observability.status().reporting, 'inactive')
  await observability.dispose()
})

test('enabled reporter uses the real DSH options and emits metadata only', async () => {
  const services = fakeServices()
  const observability = createObservability({
    ...services,
    config: enabledConfig({ serviceName: 'custom-superagent' }),
  })

  observability.record({
    id: 'event-1',
    sessionId: 'session-1',
    runId: 'run-1',
    taskId: 'task-1',
    status: 'completed',
    type: 'run/completed',
    durationMs: 42,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      token: 'TOKEN-SECRET',
      apiKey: 'API-SECRET',
    },
    prompt: 'PROMPT-SECRET',
    report: 'REPORT-SECRET',
    token: 'TOKEN-SECRET',
    attributes: { prompt: 'NESTED-PROMPT-SECRET' },
  })

  assert.equal(services.calls.create.length, 1)
  const options = services.calls.create[0]
  assert.equal(options.exporter.url, 'https://collector.example/v1/logs')
  assert.deepEqual(options.resourceAttributes, { 'service.name': 'custom-superagent' })
  assert.deepEqual(options.scope, { name: 'custom-superagent' })
  assert.equal(options.processor.maxQueueSize, 100)
  assert.equal(typeof options.onFailure, 'function')
  assert.equal(services.calls.emit.length, 1)
  const record = services.calls.emit[0]
  assert.equal(record.eventName, 'dsh-superagent.event')
  assert.equal(record.body, 'dsh-superagent metadata')
  assert.deepEqual(record.attributes, {
    eventId: 'event-1',
    sessionId: 'session-1',
    runId: 'run-1',
    taskId: 'task-1',
    status: 'completed',
    eventType: 'run/completed',
    durationMs: 42,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
    },
  })
  const serialized = JSON.stringify(record)
  for (const secret of ['PROMPT-SECRET', 'REPORT-SECRET', 'TOKEN-SECRET', 'API-SECRET', 'NESTED-PROMPT-SECRET']) {
    assert.equal(serialized.includes(secret), false)
  }

  options.onFailure('export failed', new Error('offline'))
  assert.equal(services.calls.logs.length, 1)
  assert.equal(services.calls.logs[0][1], 'export failed')
  assert.equal(observability.status().reporting, 'active')
  await observability.dispose()
})

test('a missing endpoint never creates a reporter', async () => {
  const services = fakeServices()
  const observability = createObservability({ ...services, config: enabledConfig({ endpoint: '' }) })
  observability.record({ status: 'completed' })

  assert.equal(services.calls.create.length, 0)
  assert.equal(services.calls.emit.length, 0)
  assert.match(observability.status().reason, /endpoint is missing/)
  assert.equal((await observability.snapshot('session-1')).sessionQuery.eventCount, 2)
  await observability.dispose()
})

test('reporter creation and synchronous emission failures are contained', async () => {
  const services = fakeServices({ emit: () => { throw new Error('emit failed') } })
  const observability = createObservability({ ...services, config: enabledConfig() })
  assert.doesNotThrow(() => observability.record({ status: 'completed' }))
  assert.equal(services.calls.logs.length, 1)
  await observability.dispose()

  const broken = fakeServices()
  broken.otel.createEventReporter = () => { throw new Error('create failed') }
  const unavailable = createObservability({ ...broken, config: enabledConfig() })
  assert.doesNotThrow(() => unavailable.record({ status: 'completed' }))
  assert.match(unavailable.status().reason, /reporter creation failed/)
  assert.equal((await unavailable.snapshot('session-1')).sessionQuery.eventCount, 2)
  await unavailable.dispose()
})

test('asynchronous emission failures are logged without escaping record', async () => {
  const services = fakeServices({ emit: () => Promise.reject(new Error('async export failed')) })
  const observability = createObservability({ ...services, config: enabledConfig() })
  assert.doesNotThrow(() => observability.record({ status: 'completed' }))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(services.calls.logs.length, 1)
  assert.match(services.calls.logs[0][1], /emission failed/)
  await observability.dispose()
})

test('snapshot combines lightweight session summary with real token-meter reads', async () => {
  const services = fakeServices()
  const observability = createObservability({ ...services, config: enabledConfig() })
  const snapshot = await observability.snapshot('session-1')

  assert.deepEqual(services.calls.listEvents, ['session-1'])
  assert.deepEqual(services.calls.inspect, ['session-1'])
  assert.deepEqual(services.calls.pressure, [services.session])
  assert.deepEqual(services.calls.measure, [services.session])
  assert.deepEqual(snapshot, {
    sessionId: 'session-1',
    tokenPressure: {
      totalTokens: 1200,
      surfaceTokens: 1000,
      pressureTokens: 900,
      contextWindow: 4096,
      logRevision: 3,
      surfaceDeltaTokens: 0,
      baselineKind: 'usage',
    },
    sessionQuery: {
      eventCount: 2,
      inheritedEventCount: null,
      lastEventSeq: 2,
      lastEventType: 'assistant/message',
      lastEventTime: 200,
    },
  })
  await observability.dispose()
})

test('snapshot uses readSession fallback and makes every missing field null', async () => {
  const services = fakeServices({
    contextPressure: () => ({}),
    measure: () => ({}),
  })
  delete services.sessionQuery.listEvents
  services.events = [{ seq: 1, type: 'step/start' }]
  const observability = createObservability({ ...services, config: enabledConfig() })
  const snapshot = await observability.snapshot('session-1')

  assert.deepEqual(services.calls.readSession, ['session-1'])
  assert.deepEqual(snapshot.tokenPressure, nullPressure())
  assert.deepEqual(snapshot.sessionQuery, {
    eventCount: 1,
    inheritedEventCount: 1,
    lastEventSeq: 1,
    lastEventType: 'step/start',
    lastEventTime: null,
  })
  await observability.dispose()
})

test('snapshot isolates query and token service failures', async () => {
  const services = fakeServices({
    listEvents: () => { throw new Error('query failed') },
    measure: () => { throw new Error('measure failed') },
  })
  const observability = createObservability({ ...services, config: enabledConfig() })
  const snapshot = await observability.snapshot('session-1')

  assert.deepEqual(snapshot.sessionQuery, nullSummary())
  assert.deepEqual(snapshot.tokenPressure, {
    ...nullPressure(),
    pressureTokens: 900,
    contextWindow: 4096,
  })
  assert.equal(services.calls.logs.length, 2)
  await observability.dispose()

  const brokenInspection = fakeServices({
    inspectSession: () => Promise.reject(new Error('inspection failed')),
  })
  const partial = createObservability({ ...brokenInspection, config: enabledConfig() })
  const partialSnapshot = await partial.snapshot('session-1')
  assert.equal(partialSnapshot.sessionQuery.eventCount, 2)
  assert.deepEqual(partialSnapshot.tokenPressure, nullPressure())
  assert.equal(brokenInspection.calls.logs.length, 1)
  await partial.dispose()
})

test('snapshot-only services work without otel and invalid ids do not call services', async () => {
  const services = fakeServices()
  const observability = createObservability({
    ...services,
    otel: null,
    config: enabledConfig(),
  })
  assert.equal((await observability.snapshot('session-1')).tokenPressure.totalTokens, 1200)
  assert.equal(observability.status().enabled, true)
  assert.match(observability.status().reason, /otel service unavailable/)

  const counts = [services.calls.listEvents.length, services.calls.inspect.length]
  assert.deepEqual(await observability.snapshot(''), {
    sessionId: null,
    tokenPressure: nullPressure(),
    sessionQuery: nullSummary(),
  })
  assert.deepEqual([services.calls.listEvents.length, services.calls.inspect.length], counts)
  await observability.dispose()
})

test('dispose is idempotent, passes an abort signal, and contains shutdown failure', async () => {
  const services = fakeServices({ shutdown: () => Promise.reject(new Error('shutdown failed')) })
  const observability = createObservability({ ...services, config: enabledConfig() })
  const first = observability.dispose()
  assert.equal(observability.dispose(), first)
  await first

  assert.equal(services.calls.shutdown.length, 1)
  assert.ok(services.calls.shutdown[0] instanceof AbortSignal)
  assert.equal(services.calls.shutdown[0].aborted, true)
  assert.equal(services.calls.logs.length, 1)
  assert.equal(observability.status().disposed, true)
  assert.equal(observability.status().enabled, false)
  observability.record({ status: 'completed' })
  assert.equal(services.calls.emit.length, 0)
})

test('dispose bounds a shutdown that ignores its abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const services = fakeServices({ shutdown: () => new Promise(() => {}) })
  const observability = createObservability({ ...services, config: enabledConfig() })
  const disposing = observability.dispose()
  await Promise.resolve()
  t.mock.timers.tick(1000)
  await disposing

  assert.equal(services.calls.shutdown.length, 1)
  assert.equal(services.calls.shutdown[0].aborted, true)
  assert.match(services.calls.logs.at(-1)[1], /timed out/)
  assert.equal(observability.status().reason, 'disposed')
})
