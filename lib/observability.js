const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  serviceName: 'dsh-superagent',
  endpoint: '',
  exportSessionLogs: false,
})

const SHUTDOWN_TIMEOUT_MS = 1000
const ID_FIELDS = Object.freeze({
  id: 'eventId',
  eventId: 'eventId',
  sessionId: 'sessionId',
  parentSessionId: 'parentSessionId',
  runId: 'runId',
  taskId: 'taskId',
  subtaskId: 'subtaskId',
  goalId: 'goalId',
  attemptId: 'attemptId',
  requestId: 'requestId',
  traceId: 'traceId',
  spanId: 'spanId',
})
const USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'totalTokens',
])

function safeLog(log, level, message, error) {
  try {
    if (typeof log === 'function') log(level, message, error)
    else if (log) {
      const write = log[level] ?? log.error ?? log.info
      if (typeof write === 'function') write.call(log, message, error)
    }
  } catch {
    // Diagnostics must never become a second failure.
  }
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) return null
  return text
}

function safeNumber(value, nonNegative = true) {
  return typeof value === 'number' && Number.isFinite(value) && (!nonNegative || value >= 0)
    ? value
    : null
}

function hasMethod(service, name) {
  try {
    return typeof service?.[name] === 'function'
  } catch {
    return false
  }
}

function resolveService(service) {
  return typeof service === 'function' ? service() : service
}

function emptyPressure() {
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

function emptySummary() {
  return {
    eventCount: null,
    inheritedEventCount: null,
    lastEventSeq: null,
    lastEventType: null,
    lastEventTime: null,
  }
}

function emptySnapshot(sessionId) {
  return {
    sessionId: safeText(sessionId, 256),
    tokenPressure: emptyPressure(),
    sessionQuery: emptySummary(),
  }
}

/** Select metadata only; caller-owned attributes and payloads never reach OTel. */
function metadataRecord(event) {
  const source = event && typeof event === 'object' ? event : {}
  const attributes = {}
  for (const [sourceField, attribute] of Object.entries(ID_FIELDS)) {
    const value = safeText(source[sourceField], 256)
    if (value !== null) attributes[attribute] = value
  }

  const status = safeText(source.status, 64)
  if (status !== null) attributes.status = status
  const eventType = safeText(source.eventType ?? source.type, 96)
  if (eventType !== null) attributes.eventType = eventType
  const durationMs = safeNumber(source.durationMs) ?? safeNumber(source.duration)
  if (durationMs !== null) attributes.durationMs = durationMs

  const usageSource = source.usage && typeof source.usage === 'object' ? source.usage : source
  const usage = {}
  for (const field of USAGE_FIELDS) {
    const value = safeNumber(usageSource[field])
    if (value !== null) usage[field] = value
  }
  if (Object.keys(usage).length > 0) attributes.usage = usage

  return {
    eventName: 'dsh-superagent.event',
    body: 'dsh-superagent metadata',
    timestamp: Date.now(),
    attributes,
  }
}

function summarizeEvents(events, inheritedEventCount = null) {
  if (!Array.isArray(events)) return emptySummary()
  const last = events.at(-1)
  return {
    eventCount: events.length,
    inheritedEventCount: safeNumber(inheritedEventCount),
    lastEventSeq: safeNumber(last?.seq),
    lastEventType: safeText(last?.type, 96),
    lastEventTime: safeNumber(last?.time),
  }
}

function normalizePressure(value) {
  const pressure = value && typeof value === 'object' ? value : {}
  return {
    totalTokens: safeNumber(pressure.totalTokens),
    surfaceTokens: safeNumber(pressure.surfaceTokens),
    pressureTokens: safeNumber(pressure.pressureTokens),
    contextWindow: safeNumber(pressure.contextWindow),
    logRevision: safeNumber(pressure.logRevision),
    surfaceDeltaTokens: safeNumber(pressure.surfaceDeltaTokens, false),
    baselineKind: safeText(pressure.baselineKind, 32),
  }
}

/**
 * Optional, fail-open adapter for DSH observability services.
 *
 * `exportSessionLogs` never enables DSH's raw Session-log reporter: this
 * adapter's privacy contract permits metadata only, regardless of that flag.
 */
export function createObservability({ otel, sessionQuery, tokenMeter, config, log } = {}) {
  const settings = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const requested = settings.enabled === true
  const endpoint = safeText(settings.endpoint, 2048)
  const serviceName = safeText(settings.serviceName, 128) ?? DEFAULT_CONFIG.serviceName
  const canQuery = () => requested && (hasMethod(resolveService(sessionQuery), 'listEvents')
    || hasMethod(resolveService(sessionQuery), 'readSession'))
  const canMeasure = () => requested && hasMethod(resolveService(sessionQuery), 'inspectSession')
    && typeof resolveService(tokenMeter) === 'object'
    && resolveService(tokenMeter) !== null
    && (hasMethod(resolveService(tokenMeter), 'measure') || hasMethod(resolveService(tokenMeter), 'contextPressure'))

  let reporter = null
  let reason = 'disabled by config'
  if (requested) {
    const currentOtel = resolveService(otel)
    if (!currentOtel && !canQuery() && !canMeasure()) {
      reason = 'no observability services available'
    } else {
      let reportingReason = 'otel service unavailable'
      if (currentOtel) {
        if (endpoint === null) reportingReason = 'event reporting inactive: endpoint is missing'
        else if (typeof currentOtel.createEventReporter !== 'function') {
          reportingReason = 'event reporting inactive: otel.createEventReporter is unavailable'
        } else {
          try {
            reporter = currentOtel.createEventReporter({
              exporter: { url: endpoint },
              resourceAttributes: { 'service.name': serviceName },
              scope: { name: serviceName },
              processor: {
                maxQueueSize: 100,
                maxExportBatchSize: 20,
                exportTimeoutMillis: 5000,
                scheduledDelayMillis: 1000,
              },
              onFailure(message, error) {
                safeLog(log, 'warn', message, error)
              },
            })
            if (typeof reporter?.emit !== 'function' || typeof reporter?.shutdown !== 'function') {
              throw new TypeError('otel.createEventReporter returned an invalid channel')
            }
            reportingReason = 'event reporting active'
          } catch (error) {
            reporter = null
            reportingReason = 'event reporting inactive: reporter creation failed'
            safeLog(log, 'warn', reportingReason, error)
          }
        }
      }

      const snapshotParts = []
      if (!canQuery()) snapshotParts.push('sessionQuery unavailable')
      if (!canMeasure()) snapshotParts.push('tokenMeter/session inspection unavailable')
      reason = snapshotParts.length === 0
        ? reportingReason
        : `${reportingReason}; snapshot ${reporter ? 'unavailable' : 'partial'}: ${snapshotParts.join(', ')}`
    }
  }

  let disposed = false
  let disposePromise

  async function readSummary(sessionId) {
    try {
      const query = resolveService(sessionQuery)
      if (typeof query?.listEvents === 'function') {
        return summarizeEvents(await query.listEvents(sessionId))
      }
      if (typeof query?.readSession === 'function') {
        const snapshot = await query.readSession(sessionId)
        return summarizeEvents(snapshot?.events, snapshot?.inheritedEventCount)
      }
    } catch (error) {
      safeLog(log, 'warn', 'observability session query failed', error)
    }
    return emptySummary()
  }

  async function readPressure(sessionId) {
    if (!canMeasure()) return emptyPressure()
    try {
      const query = resolveService(sessionQuery)
      const meter = resolveService(tokenMeter)
      const value = await query.inspectSession(sessionId, session => {
        const pressure = emptyPressure()
        if (typeof meter.contextPressure === 'function') {
          try {
            const current = meter.contextPressure(session)
            pressure.pressureTokens = safeNumber(current?.pressureTokens)
            pressure.contextWindow = safeNumber(current?.contextWindow)
          } catch (error) {
            safeLog(log, 'warn', 'observability context pressure read failed', error)
          }
        }
        if (typeof meter.measure === 'function') {
          try {
            const current = meter.measure(session)
            pressure.totalTokens = safeNumber(current?.totalTokens)
            pressure.surfaceTokens = safeNumber(current?.surfaceTokens)
            pressure.logRevision = safeNumber(current?.logRevision)
            pressure.surfaceDeltaTokens = safeNumber(current?.surfaceDeltaTokens, false)
            pressure.baselineKind = safeText(current?.baseline?.kind, 32)
          } catch (error) {
            safeLog(log, 'warn', 'observability token measurement failed', error)
          }
        }
        return pressure
      })
      return normalizePressure(value)
    } catch (error) {
      safeLog(log, 'warn', 'observability session inspection failed', error)
      return emptyPressure()
    }
  }

  function ensureReporter() {
    if (disposed || !requested || reporter || endpoint === null) return
    const service = resolveService(otel)
    if (typeof service?.createEventReporter !== 'function') return
    try {
      const created = service.createEventReporter({
        exporter: { url: endpoint },
        resourceAttributes: { 'service.name': serviceName },
        scope: { name: serviceName },
        processor: {
          maxQueueSize: 100,
          maxExportBatchSize: 20,
          exportTimeoutMillis: 5000,
          scheduledDelayMillis: 1000,
        },
        onFailure(message, error) {
          safeLog(log, 'warn', message, error)
        },
      })
      if (typeof created?.emit !== 'function' || typeof created?.shutdown !== 'function') {
        throw new TypeError('otel.createEventReporter returned an invalid channel')
      }
      reporter = created
      reason = 'event reporting active'
    } catch (error) {
      reason = 'event reporting inactive: reporter creation failed'
      safeLog(log, 'warn', reason, error)
    }
  }

  return {
    status() {
      ensureReporter()
      const queryAvailable = canQuery()
      const measureAvailable = canMeasure()
      const serviceAvailable = Boolean(resolveService(otel) || queryAvailable || measureAvailable)
      const reasons = []
      if (!reporter) {
        reasons.push(!resolveService(otel)
          ? 'otel service unavailable'
          : endpoint === null ? 'event reporting inactive: endpoint is missing' : 'event reporting inactive')
      }
      if (!queryAvailable) reasons.push('sessionQuery unavailable')
      if (!measureAvailable) reasons.push('tokenMeter/session inspection unavailable')
      const currentReason = !serviceAvailable
        ? 'no observability services available'
        : !reporter && /reporter creation failed/.test(reason)
          ? 'event reporting inactive: reporter creation failed'
          : reasons.join('; ') || 'event reporting active'
      return {
        configured: requested,
        enabled: !disposed && requested && serviceAvailable,
        disposed,
        reporting: reporter && !disposed ? 'active' : 'inactive',
        snapshot: !disposed && (queryAvailable || measureAvailable) ? 'available' : 'unavailable',
        reason: disposed ? 'disposed' : !requested ? 'disabled by config' : currentReason,
      }
    },

    record(event) {
      ensureReporter()
      if (disposed || !reporter) return
      try {
        const result = reporter.emit(metadataRecord(event))
        if (result && typeof result.then === 'function') {
          void Promise.resolve(result).catch(error => {
            safeLog(log, 'warn', 'observability event emission failed', error)
          })
        }
      } catch (error) {
        safeLog(log, 'warn', 'observability event emission failed', error)
      }
    },

    async snapshot(sessionId) {
      if (disposed) return emptySnapshot(sessionId)
      const id = safeText(sessionId, 256)
      if (id === null || (!canQuery() && !canMeasure())) return emptySnapshot(id)
      const [sessionQuerySummary, tokenPressure] = await Promise.all([
        readSummary(id),
        readPressure(id),
      ])
      return { sessionId: id, sessionQuery: sessionQuerySummary, tokenPressure }
    },

    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      if (!reporter) {
        disposePromise = Promise.resolve()
        return disposePromise
      }

      const controller = new AbortController()
      let timer
      const shutdown = Promise.resolve()
        .then(() => reporter.shutdown(controller.signal))
        .catch(error => safeLog(log, 'warn', 'observability shutdown failed', error))
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => {
          controller.abort(new Error('observability shutdown timed out'))
          safeLog(log, 'warn', 'observability shutdown timed out')
          resolve()
        }, SHUTDOWN_TIMEOUT_MS)
      })
      disposePromise = Promise.race([shutdown, deadline]).finally(() => {
        clearTimeout(timer)
        controller.abort()
      })
      return disposePromise
    },
  }
}
