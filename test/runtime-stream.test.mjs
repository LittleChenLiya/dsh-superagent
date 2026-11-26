import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeStream } from '../lib/runtime-stream.js'

function makeStream(t, options) {
  const stream = createRuntimeStream(options)
  t.after(() => stream.dispose())
  return stream
}

const state = (value = 'idle') => ({ type: 'state', state: { status: value } })
const action = (name = 'browser_click') => ({ type: 'current-action', action: { name, phase: 'started' } })

test('publishes the three frame types and resumes exclusively from a cursor', t => {
  const stream = makeStream(t, { limit: 4 })
  assert.deepEqual(stream.snapshot(), {
    events: [], nextCursor: 0, current: { screenshot: null, currentAction: null, state: null }, dropped: 0, disposed: false,
  })

  assert.deepEqual(stream.publish(state('ready')), { accepted: true, cursor: 1, dropped: 0 })
  assert.deepEqual(stream.publish(action()), { accepted: true, cursor: 2, dropped: 0 })
  assert.deepEqual(stream.publish({ type: 'screenshot', path: 'shots/current.png' }), { accepted: true, cursor: 3, dropped: 0 })

  const first = stream.read({ cursor: 0, limit: 1 })
  assert.equal(first.reset, false)
  assert.equal(first.events.length, 1)
  assert.equal(first.events[0].cursor, 1)
  assert.equal(first.nextCursor, 1)

  const rest = stream.read({ cursor: first.nextCursor })
  assert.equal(rest.reset, false)
  assert.deepEqual(rest.events.map(event => event.type), ['current-action', 'screenshot'])
  assert.deepEqual(rest.events.map(event => event.cursor), [2, 3])
  assert.equal(rest.nextCursor, 3)
  assert.deepEqual(stream.read({ cursor: 3 }), { events: [], nextCursor: 3, reset: false })
  assert.deepEqual(stream.read({ cursor: 3, limit: 0 }), { events: [], nextCursor: 3, reset: false })

  const current = stream.snapshot().current
  assert.equal(current.state.state.status, 'ready')
  assert.equal(current.currentAction.action.name, 'browser_click')
  assert.equal(current.screenshot.path, 'shots/current.png')
})

test('a missing or future cursor resets to the current buffered snapshot', t => {
  const stream = makeStream(t, { limit: 3 })
  stream.publish(state('one'))
  stream.publish(state('two'))

  for (const cursor of [3, 99]) {
    const result = stream.read({ cursor })
    assert.equal(result.reset, true)
    assert.deepEqual(result.events, stream.snapshot().events)
    assert.equal(result.nextCursor, 2)
  }
})

test('retains only the newest frames and reports oldest-frame eviction as backpressure', t => {
  const stream = makeStream(t, { limit: 2 })
  assert.equal(stream.publish(state('one')).dropped, 0)
  assert.equal(stream.publish(state('two')).dropped, 0)
  assert.deepEqual(stream.publish(state('three')), { accepted: true, cursor: 3, dropped: 1 })
  assert.deepEqual(stream.publish(state('four')), { accepted: true, cursor: 4, dropped: 1 })

  const snapshot = stream.snapshot()
  assert.deepEqual(snapshot.events.map(event => event.cursor), [3, 4])
  assert.deepEqual(snapshot.events.map(event => event.state.status), ['three', 'four'])
  assert.equal(snapshot.dropped, 2)
  assert.equal(snapshot.current.state.state.status, 'four')

  const resumed = stream.read({ cursor: 0 })
  assert.equal(resumed.reset, true)
  assert.deepEqual(resumed.events, snapshot.events)
  assert.equal(resumed.nextCursor, 4)
  assert.deepEqual(stream.read({ cursor: 2 }).events.map(event => event.cursor), [3, 4])
})

test('accepts local screenshot paths and canonical base64 image data URLs', t => {
  const stream = makeStream(t, { maxFrameBytes: 512 })
  const files = ['shots/frame.png', './shots/frame with spaces.png', 'C:\\shots\\frame.png']
  for (const path of files) assert.equal(stream.publish({ type: 'screenshot', path }).accepted, true)

  const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(stream.publish({ type: 'screenshot', dataUrl }).accepted, true)
  assert.equal(stream.publish({ type: 'screenshot', data: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }).accepted, true)
  assert.equal(stream.snapshot().events.find(event => event.dataUrl === dataUrl).dataUrl, dataUrl)
})

test('rejects URL, raw-base64, oversized, control-character, and ambiguous screenshots without consuming cursors', t => {
  const stream = makeStream(t, { maxFrameBytes: 160 })
  stream.publish(state('before'))
  const invalid = [
    { type: 'screenshot', path: 'https://example.test/private.png' },
    { type: 'screenshot', path: 'HTTP://example.test/private.png' },
    { type: 'screenshot', path: '//example.test/private.png' },
    { type: 'screenshot', url: 'https://example.test/private.png' },
    { type: 'screenshot', data: 'https://example.test/private.png' },
    { type: 'screenshot', path: 'file:///tmp/private.png' },
    { type: 'screenshot', data: 'iVBORw0KGgo=' },
    { type: 'screenshot', base64: 'iVBORw0KGgo=' },
    { type: 'screenshot', data: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { type: 'screenshot', data: 'data:image/png;base64,%%%%' },
    { type: 'screenshot', data: 'data:image/png;base64,AAA' },
    { type: 'screenshot', data: `data:image/png;base64,${'A'.repeat(200)}` },
    { type: 'screenshot', path: 'shots\nframe.png' },
    { type: 'screenshot', path: 'shots\tframe.png' },
    { type: 'screenshot', path: 'shots/frame.png', caption: 'bad\u0000caption' },
    { type: 'screenshot', data: 'data:image/png;base64,iVBOR\nw0KGgo=' },
    { type: 'screenshot', path: 'shots/frame.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    { type: 'screenshot', caption: 'no media payload' },
    { type: 'screenshot', image: { url: 'https://example.test/private.png' } },
  ]

  for (const frame of invalid) {
    assert.deepEqual(stream.publish(frame), { accepted: false, cursor: 1, dropped: 0 }, JSON.stringify(frame))
  }
  assert.equal(stream.snapshot().events.length, 1)
  assert.equal(stream.publish({ type: 'screenshot', path: 'shots/good.png' }).cursor, 2)
})

test('enforces the serialized UTF-8 frame limit for every frame type', t => {
  const stream = makeStream(t, { maxFrameBytes: 96 })
  assert.equal(stream.publish(state('ok')).accepted, true)
  assert.equal(stream.publish(state('界'.repeat(100))).accepted, false)
  assert.equal(stream.publish(action('x'.repeat(100))).accepted, false)
  assert.equal(stream.publish({ type: 'screenshot', path: `shots/${'x'.repeat(100)}.png` }).accepted, false)
  assert.equal(stream.snapshot().nextCursor, 1)
})

test('redacts sensitive keys and text recursively while preserving screenshot data URLs', t => {
  const stream = makeStream(t, {
    maxFrameBytes: 2048,
    redact: (text, key) => key === 'note' ? `note: ${text}` : text,
  })
  const secret = 'sk-live-do-not-log-this'
  const result = stream.publish({
    type: 'state',
    state: {
      status: 'password=hunter2',
      apiKey: secret,
      nested: { refreshToken: 'refresh-secret', note: `Bearer ${secret}`, safe: 'ready' },
      contact: 'person@example.test',
      phone: '13800138000',
      url: 'https://user:pass@example.test/private?token=query-secret',
    },
  })
  assert.equal(result.accepted, true)
  const event = stream.snapshot().events[0]
  assert.equal(event.state.status, 'password=[REDACTED]')
  assert.equal(event.state.apiKey, '[REDACTED]')
  assert.equal(event.state.nested.refreshToken, '[REDACTED]')
  assert.match(event.state.nested.note, /^note: Bearer \[REDACTED\]$/)
  assert.equal(event.state.nested.safe, 'ready')
  assert.equal(event.state.contact, '[email redacted]')
  assert.equal(event.state.phone, '[phone redacted]')
  assert.doesNotMatch(event.state.url, /user:pass|query-secret/)

  const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(stream.publish({ type: 'screenshot', dataUrl, caption: `token=${secret}` }).accepted, true)
  const screenshot = stream.snapshot().current.screenshot
  assert.equal(screenshot.dataUrl, dataUrl)
  assert.equal(screenshot.caption, 'token=[REDACTED]')
  assert.doesNotMatch(JSON.stringify(stream.snapshot()), new RegExp(secret))
})

test('a custom redactor cannot restore built-in secrets', t => {
  const stream = makeStream(t, { redact: () => 'password=restored-secret' })
  assert.equal(stream.publish(state('safe')).accepted, true)
  assert.equal(stream.snapshot().events[0].state.status, 'password=[REDACTED]')
})

test('subscriptions are isolated, ordered under reentrancy, and cancellable', t => {
  const stream = makeStream(t, { limit: 5 })
  const first = []
  const second = []
  const unsubscribeFirst = stream.subscribe(event => {
    first.push(event.cursor)
    event.state.status = 'mutated by consumer'
    if (event.cursor === 1) stream.publish(state('nested'))
    throw new Error('consumer failure must not escape')
  })
  const unsubscribeSecond = stream.subscribe(event => {
    second.push([event.cursor, event.state.status])
  })

  assert.deepEqual(stream.publish(state('outer')), { accepted: true, cursor: 1, dropped: 0 })
  assert.deepEqual(first, [1, 2])
  assert.deepEqual(second, [[1, 'outer'], [2, 'nested']])
  assert.equal(stream.snapshot().current.state.state.status, 'nested')

  unsubscribeFirst()
  unsubscribeFirst.unsubscribe()
  stream.publish(state('after unsubscribe'))
  assert.deepEqual(first, [1, 2])
  assert.deepEqual(second.at(-1), [3, 'after unsubscribe'])

  unsubscribeSecond()
  const returned = stream.read({ cursor: 0 })
  returned.events[0].state.status = 'mutated replay'
  assert.equal(stream.snapshot().events[0].state.status, 'outer')
})

test('dispose is idempotent, closes subscriptions, clears frames, and rejects later work', t => {
  const stream = makeStream(t)
  const seen = []
  const unsubscribe = stream.subscribe(event => seen.push(event))
  stream.publish(state('before'))
  assert.equal(seen.length, 1)

  stream.dispose()
  stream.dispose()
  unsubscribe()
  unsubscribe.unsubscribe()
  assert.deepEqual(stream.publish(state('after')), { accepted: false, cursor: 1, dropped: 0 })
  assert.deepEqual(stream.read({ cursor: 1 }), { events: [], nextCursor: 1, reset: true })
  assert.deepEqual(stream.snapshot(), {
    events: [], nextCursor: 1, current: { screenshot: null, currentAction: null, state: null }, dropped: 0, disposed: true,
  })
  assert.throws(() => stream.subscribe(() => {}), error => error.code === 'DISPOSED')
})

test('rejects malformed frames and API arguments without corrupting the stream', t => {
  const stream = makeStream(t)
  for (const frame of [null, [], 'state', {}, { type: 'frame' }, { type: 'state', value: 1n }]) {
    assert.equal(stream.publish(frame).accepted, false)
  }
  const cyclic = { type: 'state' }
  cyclic.self = cyclic
  assert.equal(stream.publish(cyclic).accepted, false)
  assert.equal(stream.publish({ type: 'state', cursor: 99 }).cursor, 1)
  assert.equal(stream.snapshot().events[0].cursor, 1)
  assert.throws(() => stream.read({ cursor: -1 }), RangeError)
  assert.throws(() => stream.read({ cursor: '0' }), RangeError)
  assert.throws(() => stream.read({ limit: -1 }), RangeError)
  assert.throws(() => stream.subscribe(null), TypeError)
  assert.throws(() => createRuntimeStream({ limit: 0 }), RangeError)
  assert.throws(() => createRuntimeStream({ maxFrameBytes: 1.5 }), RangeError)
  assert.throws(() => createRuntimeStream({ redact: false }), TypeError)
  const invalidRedactor = createRuntimeStream({ redact: () => null })
  assert.equal(invalidRedactor.publish(state('safe')).accepted, false)
  invalidRedactor.dispose()
})
