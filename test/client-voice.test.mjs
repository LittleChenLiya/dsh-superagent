import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VoiceError,
  audioBufferToWav,
  createVoiceController,
  decodeRecordedAudio,
} from '../lib/client-voice.js'
import { inspectWav } from '../lib/voice.js'

class FakeTarget {
  listeners = new Map()
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
  listenerCount(type) { return this.listeners.get(type)?.size ?? 0 }
}

class FakeTrack {
  readyState = 'live'
  stops = 0
  stop() { this.stops += 1; this.readyState = 'ended' }
}

class FakeRecorder {
  static instances = []
  static supportedType = 'audio/webm;codecs=opus'
  static constructorError = null
  static startError = null
  static isTypeSupported(type) { return type === FakeRecorder.supportedType }

  constructor(stream, options) {
    if (FakeRecorder.constructorError) throw FakeRecorder.constructorError
    this.stream = stream
    this.options = options
    this.state = 'inactive'
    this.listeners = new Map()
    this.starts = []
    this.stops = 0
    this.emitStopOnStop = false
    FakeRecorder.instances.push(this)
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
  start(interval) {
    if (FakeRecorder.startError) throw FakeRecorder.startError
    this.starts.push(interval)
    this.state = 'recording'
  }
  stop() {
    this.stops += 1
    this.state = 'inactive'
    if (this.emitStopOnStop) this.emit('stop')
  }
  data(bytes, type = this.options?.mimeType ?? 'audio/webm') {
    this.emit('dataavailable', { data: new Blob([bytes], { type }) })
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function decodedBuffer({ sampleRate = 16_000, length, channels = [[0.25, -0.25, 0.5, -0.5]] } = {}) {
  const actualLength = length ?? channels[0].length
  const actualChannels = channels.length === 1
    ? [Array.from({ length: actualLength }, (_, i) => channels[0][i % channels[0].length])]
    : channels
  return {
    sampleRate,
    length: actualChannels[0].length,
    numberOfChannels: actualChannels.length,
    getChannelData(channel) { return Float32Array.from(actualChannels[channel]) },
  }
}

function hasCode(code) {
  return error => error instanceof VoiceError && error.code === code
}

function fixture(t, overrides = {}) {
  FakeRecorder.instances = []
  FakeRecorder.constructorError = null
  FakeRecorder.startError = null
  FakeRecorder.supportedType = 'audio/webm;codecs=opus'
  const document = new FakeTarget()
  document.hidden = false
  const window = new FakeTarget()
  const track = overrides.track ?? new FakeTrack()
  const stream = overrides.stream ?? {
    getTracks() { return [track] },
    getAudioTracks() { return [track] },
  }
  const calls = { media: [], decoded: [], transcribed: [], transcript: [], errors: [], states: [] }
  const getUserMedia = overrides.getUserMedia ?? (async constraints => {
    calls.media.push(constraints)
    if (!overrides.track) track.readyState = 'live'
    return stream
  })
  const transcribe = overrides.transcribe ?? (async (wav, metadata) => {
    calls.transcribed.push({ wav, metadata })
    return '可编辑文本'
  })
  const controller = createVoiceController({
    window,
    document,
    navigator: { mediaDevices: { getUserMedia } },
    MediaRecorder: FakeRecorder,
    decodeAudioData: async bytes => {
      calls.decoded.push(new Uint8Array(bytes))
      return decodedBuffer()
    },
    transcribe,
    onTranscript: text => calls.transcript.push(text),
    onError: error => calls.errors.push(error),
    onStateChange: state => calls.states.push(state),
    ...overrides.controllerOptions,
  })
  t.after(() => controller.dispose())
  return { controller, calls, document, window, track, stream, getUserMedia, transcribe }
}

async function begin(f) {
  await f.controller.start()
  return FakeRecorder.instances.at(-1)
}

async function recordAndStop(f, bytes = Uint8Array.from([1, 2, 3, 4])) {
  const recorder = await begin(f)
  recorder.data(bytes)
  const result = f.controller.stop()
  recorder.emit('stop')
  return { recorder, result }
}

test('audioBufferToWav mixes channels, resamples to 16kHz and writes clamped PCM16', () => {
  const wav = audioBufferToWav(decodedBuffer({
    sampleRate: 8000,
    channels: [
      [1, -1, 0.5, 0],
      [0, 1, 0.5, 0],
    ],
  }))
  const metadata = inspectWav(wav)
  assert.equal(metadata.sampleRate, 16000)
  assert.equal(metadata.channels, 1)
  assert.equal(metadata.bitsPerSample, 16)
  assert.equal(metadata.sampleCount, 8)
  const view = new DataView(wav.buffer)
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => view.getInt16(44 + index * 2, true)), [
    16384, 8192, 0, 8192, 16384, 8192, 0, 0,
  ])

  const clipped = audioBufferToWav(decodedBuffer({ channels: [[-2, Number.NaN, 2, 0]] }))
  const clippedView = new DataView(clipped.buffer)
  assert.equal(clippedView.getInt16(44, true), -32768)
  assert.equal(clippedView.getInt16(46, true), 0)
  assert.equal(clippedView.getInt16(48, true), 32767)
})

test('audio conversion rejects empty, oversized and overlong decoded audio', () => {
  assert.throws(() => audioBufferToWav(null), hasCode('invalid-audio'))
  assert.throws(() => audioBufferToWav(decodedBuffer({ length: 0, channels: [[]] })), hasCode('invalid-audio'))
  assert.throws(() => audioBufferToWav(decodedBuffer(), { maxDurationMs: 0 }), hasCode('audio-too-long'))
  assert.throws(() => audioBufferToWav(decodedBuffer(), { maxBytes: 45 }), hasCode('audio-too-large'))
  const truncated = decodedBuffer()
  truncated.getChannelData = () => new Float32Array(1)
  assert.throws(() => audioBufferToWav(truncated), hasCode('invalid-audio'))
})

test('decodeRecordedAudio uses injected decoding and closes a real AudioContext on success and failure', async () => {
  const bytes = Uint8Array.from([9, 8, 7])
  const blob = new Blob([bytes])
  const inputs = []
  const wav = await decodeRecordedAudio(blob, {
    decodeAudioData: async input => { inputs.push([...new Uint8Array(input)]); return decodedBuffer() },
  })
  assert.deepEqual(inputs, [[9, 8, 7]])
  assert.equal(inspectWav(wav).sampleRate, 16000)

  const closes = []
  class Context {
    async decodeAudioData() { return decodedBuffer() }
    async close() { closes.push('closed') }
  }
  await decodeRecordedAudio(blob, { AudioContext: Context })
  assert.deepEqual(closes, ['closed'])
  class BrokenContext {
    async decodeAudioData() { throw Object.assign(new Error('bad codec'), { name: 'EncodingError' }) }
    async close() { closes.push('closed') }
  }
  await assert.rejects(decodeRecordedAudio(blob, { AudioContext: BrokenContext }), hasCode('decode-failed'))
  assert.deepEqual(closes, ['closed', 'closed'])
  await assert.rejects(decodeRecordedAudio(blob), hasCode('decode-unavailable'))
})

test('missing host speech is explicitly unavailable before requesting microphone access', async () => {
  const controller = createVoiceController({ remote: {} })
  const caps = controller.capabilities()
  assert.equal(caps.available, false)
  assert.equal(caps.status, 'unavailable')
  assert.equal(caps.code, 'unavailable')
  assert.match(caps.reason, /host remote\.speech service is unavailable/)
  await assert.rejects(controller.start(), hasCode('unavailable'))
  controller.dispose()
  await assert.rejects(controller.start(), hasCode('disposed'))
})

test('browser microphone and MediaRecorder absence have distinct unavailable reasons', () => {
  const noMicrophone = createVoiceController({ transcribe: async () => 'text', navigator: {} })
  assert.equal(noMicrophone.capabilities().code, 'recording-unavailable')
  assert.match(noMicrophone.capabilities().reason, /getUserMedia/)
  noMicrophone.dispose()

  const noRecorder = createVoiceController({
    transcribe: async () => 'text',
    navigator: { mediaDevices: { getUserMedia: async () => ({}) } },
    MediaRecorder: null,
    window: {},
    decodeAudioData: async () => decodedBuffer(),
  })
  assert.equal(noRecorder.capabilities().code, 'recording-unavailable')
  assert.match(noRecorder.capabilities().reason, /MediaRecorder/)
  noRecorder.dispose()
})

test('press starts one recorder and release returns editable text without sending it', async t => {
  const f = fixture(t)
  const first = f.controller.start()
  const second = f.controller.start()
  await Promise.all([first, second])
  assert.equal(f.controller.state, 'recording')
  assert.equal(FakeRecorder.instances.length, 1)
  assert.deepEqual(f.calls.media, [{
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  }])
  const recorder = FakeRecorder.instances[0]
  assert.deepEqual(recorder.starts, [250])
  assert.deepEqual(recorder.options, { mimeType: 'audio/webm;codecs=opus' })
  const source = Uint8Array.from([10, 20, 30, 40])
  recorder.data(source)
  const result = f.controller.stop()
  assert.equal(f.controller.state, 'transcribing')
  assert.equal(f.track.stops, 1)
  recorder.emit('stop')
  assert.equal(await result, '可编辑文本')
  assert.deepEqual(f.calls.transcript, ['可编辑文本'])
  assert.equal(f.calls.transcribed.length, 1)
  assert.deepEqual(f.calls.decoded[0], source)
  assert.equal(inspectWav(f.calls.transcribed[0].wav).sampleRate, 16000)
  assert.equal(f.calls.transcribed[0].metadata.mimeType, 'audio/wav')
  assert.equal(f.controller.state, 'idle')
  assert.equal(await f.controller.stop(), null)
  assert.deepEqual(f.calls.states, ['requesting', 'recording', 'transcribing', 'idle'])
})

test('cancel releases tracks and discards queued MediaRecorder events', async t => {
  const f = fixture(t)
  const recorder = await begin(f)
  recorder.data(Uint8Array.from([1, 2]))
  f.controller.cancel()
  assert.equal(f.track.stops, 1)
  assert.equal(f.controller.state, 'idle')
  recorder.emit('dataavailable', { data: new Blob([Uint8Array.from([3, 4])]) })
  recorder.emit('stop')
  assert.equal(await f.controller.stop(), null)
  assert.equal(f.calls.transcribed.length, 0)
  assert.deepEqual(f.calls.transcript, [])
})

test('cancel while permission is pending stops a late-arriving track and never creates a recorder', async t => {
  const permission = deferred()
  const f = fixture(t, { getUserMedia: () => permission.promise })
  const starting = f.controller.start()
  f.controller.cancel()
  permission.resolve(f.stream)
  await starting
  assert.equal(f.track.stops, 1)
  assert.equal(FakeRecorder.instances.length, 0)
  assert.equal(f.controller.state, 'idle')
})

test('a transcription result arriving after cancel is stale and cannot populate the composer', async t => {
  const transcription = deferred()
  const started = deferred()
  const f = fixture(t, {
    transcribe: async () => { started.resolve(); return transcription.promise },
  })
  const { result } = await recordAndStop(f)
  await started.promise
  f.controller.cancel()
  transcription.resolve('迟到的文本')
  assert.equal(await result, null)
  assert.deepEqual(f.calls.transcript, [])
})

test('a newer recording invalidates a late result from the previous recording', async t => {
  const firstTranscription = deferred()
  const firstStarted = deferred()
  let invocation = 0
  const f = fixture(t, {
    transcribe: async () => {
      invocation += 1
      if (invocation === 1) {
        firstStarted.resolve()
        return firstTranscription.promise
      }
      return '新录音文本'
    },
  })
  const first = await recordAndStop(f)
  await firstStarted.promise
  f.controller.cancel()
  const second = await recordAndStop(f, Uint8Array.from([5, 6]))
  assert.equal(await second.result, '新录音文本')
  firstTranscription.resolve('旧录音文本')
  assert.equal(await first.result, null)
  assert.deepEqual(f.calls.transcript, ['新录音文本'])
})

test('page hidden, pagehide and beforeunload cancel recording and release the microphone', async t => {
  for (const event of ['visibilitychange', 'pagehide', 'beforeunload']) {
    await t.test(event, async t => {
      const f = fixture(t)
      await begin(f)
      if (event === 'visibilitychange') {
        f.document.hidden = true
        f.document.emit(event)
      } else {
        f.window.emit(event)
      }
      assert.equal(f.track.stops, 1)
      assert.equal(f.controller.state, 'idle')
      assert.equal(f.calls.transcribed.length, 0)
    })
  }
})

test('dispose is idempotent, releases tracks and removes lifecycle listeners', async t => {
  const f = fixture(t)
  await begin(f)
  assert.equal(f.document.listenerCount('visibilitychange'), 1)
  assert.equal(f.window.listenerCount('pagehide'), 1)
  assert.equal(f.window.listenerCount('beforeunload'), 1)
  f.controller.dispose()
  f.controller.dispose()
  assert.equal(f.track.stops, 1)
  assert.equal(f.controller.disposed, true)
  assert.equal(f.document.listenerCount('visibilitychange'), 0)
  assert.equal(f.window.listenerCount('pagehide'), 0)
  assert.equal(f.window.listenerCount('beforeunload'), 0)
  f.document.emit('visibilitychange')
  f.window.emit('pagehide')
  assert.equal(f.track.stops, 1)
})

test('permission denial, missing device and device occupation map to stable VoiceError codes', async t => {
  for (const [name, code] of [
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-device'],
    ['NotReadableError', 'device-busy'],
    ['AbortError', 'device-busy'],
  ]) {
    await t.test(name, async t => {
      const error = Object.assign(new Error(name), { name })
      const f = fixture(t, { getUserMedia: async () => { throw error } })
      await assert.rejects(f.controller.start(), hasCode(code))
      assert.equal(f.calls.errors.length, 1)
      assert.equal(f.calls.errors[0].code, code)
      assert.equal(f.controller.state, 'idle')
    })
  }
})

test('no active audio track, recorder construction and recorder start failures release resources', async t => {
  await t.test('no active track', async t => {
    const track = new FakeTrack()
    track.readyState = 'ended'
    const f = fixture(t, { track })
    await assert.rejects(f.controller.start(), hasCode('no-device'))
    assert.equal(track.stops, 1)
  })
  await t.test('constructor', async t => {
    const f = fixture(t)
    FakeRecorder.constructorError = Object.assign(new Error('unsupported'), { name: 'NotSupportedError' })
    await assert.rejects(f.controller.start(), hasCode('recording-unavailable'))
    assert.equal(f.track.stops, 1)
  })
  await t.test('start', async t => {
    const f = fixture(t)
    FakeRecorder.startError = Object.assign(new Error('cannot start'), { name: 'NotReadableError' })
    await assert.rejects(f.controller.start(), hasCode('device-busy'))
    assert.equal(f.track.stops, 1)
    assert.equal(f.controller.state, 'idle')
  })
})

test('oversized MediaRecorder chunks fail closed, release the track and emit no transcript', async t => {
  const f = fixture(t, { controllerOptions: { maxBytes: 3 } })
  const recorder = await begin(f)
  recorder.data(Uint8Array.from([1, 2, 3, 4]))
  assert.equal(f.controller.state, 'idle')
  assert.equal(f.track.stops, 1)
  assert.equal(f.calls.errors[0].code, 'audio-too-large')
  recorder.emit('stop')
  assert.equal(f.calls.transcribed.length, 0)
})

test('oversized data arriving after stop rejects the pending stop instead of leaving it hanging', async t => {
  const f = fixture(t, { controllerOptions: { maxBytes: 3 } })
  const recorder = await begin(f)
  const result = f.controller.stop()
  recorder.data(Uint8Array.from([1, 2, 3, 4]))
  recorder.emit('stop')
  await assert.rejects(result, hasCode('audio-too-large'))
  assert.equal(f.controller.state, 'idle')
  assert.equal(f.track.stops, 1)
})

test('the recording duration limit automatically stops and transcribes the captured audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { controllerOptions: { maxDurationMs: 5 } })
  const recorder = await begin(f)
  t.mock.timers.tick(5)
  assert.equal(f.controller.state, 'transcribing')
  assert.equal(recorder.stops, 1)
  recorder.data(Uint8Array.from([1, 2]))
  recorder.emit('stop')
  assert.equal(await f.controller.stop(), '可编辑文本')
  assert.equal(f.controller.state, 'idle')
})

test('empty recordings and malformed host responses reject stop and return the controller to idle', async t => {
  await t.test('empty', async t => {
    const f = fixture(t)
    const recorder = await begin(f)
    const result = f.controller.stop()
    recorder.emit('stop')
    await assert.rejects(result, hasCode('empty-recording'))
    assert.equal(f.controller.state, 'idle')
    assert.equal(f.track.stops, 1)
  })
  await t.test('malformed response', async t => {
    const f = fixture(t, { transcribe: async () => ({ text: '  ' }) })
    const { result } = await recordAndStop(f)
    await assert.rejects(result, hasCode('invalid-transcription'))
    assert.equal(f.controller.state, 'idle')
    assert.deepEqual(f.calls.transcript, [])
  })
})

test('UI callback failures do not break transcription or microphone cleanup', async t => {
  const f = fixture(t, {
    controllerOptions: {
      onTranscript() { throw new Error('render failed') },
      onStateChange() { throw new Error('state render failed') },
    },
  })
  const { result } = await recordAndStop(f)
  assert.equal(await result, '可编辑文本')
  assert.equal(f.controller.state, 'idle')
  assert.equal(f.track.stops, 1)
})

test('state subscriptions can be removed and stop is idempotent while transcription is pending', async t => {
  const transcription = deferred()
  const f = fixture(t, { transcribe: () => transcription.promise })
  const states = []
  const unsubscribe = f.controller.subscribe(state => states.push(state))
  const recorder = await begin(f)
  recorder.data(Uint8Array.from([1, 2]))
  const first = f.controller.stop()
  const second = f.controller.stop()
  assert.equal(first, second)
  unsubscribe()
  recorder.emit('stop')
  transcription.resolve('done')
  assert.equal(await first, 'done')
  assert.deepEqual(states, ['requesting', 'recording', 'transcribing'])
})
