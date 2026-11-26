import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_VOICE_MAX_BYTES,
  DEFAULT_VOICE_MAX_DURATION_MS,
  VoiceError,
  createVoiceService,
  encodeWav,
  inspectWav,
  validateWav,
} from '../lib/voice.js'

function hasCode(code) {
  return error => error instanceof VoiceError && error.code === code
}

function changedWav(wav, mutate) {
  const copy = wav.slice()
  mutate(new DataView(copy.buffer))
  return copy
}

test('WAV encoding writes canonical little-endian 16kHz mono PCM16 without mutating samples', () => {
  const samples = new Int16Array([-32768, -1, 0, 1, 32767])
  const before = samples.slice()
  const wav = encodeWav(samples)
  assert.equal(wav.byteLength, 54)
  assert.deepEqual(samples, before)
  const view = new DataView(wav.buffer)
  assert.equal(view.getUint32(0, true), 0x52494646)
  assert.equal(view.getUint32(4, true), 46)
  assert.equal(view.getUint32(8, true), 0x57415645)
  assert.equal(view.getUint32(12, true), 0x20746d66)
  assert.equal(view.getUint32(16, true), 16)
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000)
  assert.equal(view.getUint16(32, true), 2)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(36, true), 0x61746164)
  assert.equal(view.getUint32(40, true), 10)
  assert.deepEqual([...wav.slice(44)], [
    0x00, 0x80, 0xff, 0xff, 0x00, 0x00, 0x01, 0x00, 0xff, 0x7f,
  ])
  assert.deepEqual(inspectWav(wav), {
    byteLength: 54,
    dataByteLength: 10,
    sampleCount: 5,
    durationMs: 10 * 1000 / 32000,
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    encoding: 'pcm16',
  })
  assert.equal(validateWav, inspectWav)
})

test('WAV encoding accepts byte views at their exact offset and rejects invalid PCM16 input', () => {
  const backing = Uint8Array.from([99, 98, 0, 0x80, 0xff, 0x7f, 97])
  const wav = encodeWav(new DataView(backing.buffer, 2, 4))
  assert.deepEqual([...wav.slice(44)], [0, 0x80, 0xff, 0x7f])
  assert.deepEqual([...encodeWav([-32768, 32767]).slice(44)], [0, 0x80, 0xff, 0x7f])
  for (const samples of [[], [0.5], [32768], [-32769], new Uint8Array([0])]) {
    assert.throws(() => encodeWav(samples), hasCode('invalid-samples'))
  }
})

test('WAV size and duration limits are inclusive and fail before oversized allocation', () => {
  const samples = new Int16Array(160) // 10ms
  const wav = encodeWav(samples)
  assert.equal(inspectWav(wav, { maxBytes: wav.byteLength, maxDurationMs: 10 }).sampleCount, 160)
  assert.throws(() => inspectWav(wav, { maxBytes: wav.byteLength - 1 }), hasCode('audio-too-large'))
  assert.throws(() => inspectWav(wav, { maxDurationMs: 9 }), hasCode('audio-too-long'))
  assert.throws(() => encodeWav(new Int16Array(1_000_000), { maxDurationMs: 10 }), hasCode('audio-too-long'))
  assert.throws(() => encodeWav(samples, { maxBytes: 100 }), hasCode('audio-too-large'))
  assert.throws(() => encodeWav(samples, { maxDurationMs: 0 }), hasCode('invalid-limit'))
  assert.equal(DEFAULT_VOICE_MAX_BYTES, 10 * 1024 * 1024)
  assert.equal(DEFAULT_VOICE_MAX_DURATION_MS, 60_000)
})

test('WAV validation accepts unknown padded chunks but requires a consistent RIFF container', () => {
  const wav = encodeWav(new Int16Array([1, 2]))
  const withJunk = new Uint8Array(wav.length + 12)
  withJunk.set(wav.slice(0, 36), 0)
  const view = new DataView(withJunk.buffer)
  view.setUint32(4, withJunk.length - 8, true)
  view.setUint32(36, 0x4a554e4b, true)
  view.setUint32(40, 4, true)
  withJunk.set([74, 85, 78, 75], 44)
  withJunk.set(wav.slice(36), 48)
  assert.equal(inspectWav(withJunk).sampleCount, 2)

  assert.throws(() => inspectWav(wav.slice(0, -1)), hasCode('invalid-wav'))
  assert.throws(() => inspectWav(changedWav(wav, v => v.setUint32(4, 1, true))), hasCode('invalid-wav'))
  assert.throws(() => inspectWav(changedWav(wav, v => v.setUint32(0, 0, true))), hasCode('invalid-wav'))
  assert.throws(() => inspectWav(changedWav(wav, v => v.setUint32(40, 3, true))), hasCode('invalid-wav'))
})

test('WAV validation rejects every format mismatch from the 16kHz mono PCM16 contract', () => {
  const wav = encodeWav(new Int16Array([1, 2, 3, 4]))
  const mutations = [
    v => v.setUint16(20, 3, true), // float
    v => v.setUint16(22, 2, true), // stereo
    v => v.setUint32(24, 48000, true),
    v => v.setUint32(28, 192000, true),
    v => v.setUint16(32, 4, true),
    v => v.setUint16(34, 8, true),
  ]
  for (const mutate of mutations) {
    assert.throws(() => inspectWav(changedWav(wav, mutate)), error => {
      assert.equal(error.code, 'invalid-wav')
      assert.match(error.message, /16kHz mono PCM16/)
      return true
    })
  }
})

test('host speech service reports unavailable explicitly and never supplies a local fallback', async () => {
  for (const remote of [undefined, {}, { speech: null }, { speech: { catalog() {} } }, { speech: { transcribe() {} } }]) {
    const service = createVoiceService({ remote })
    assert.deepEqual(service.capabilities().available, false)
    assert.equal(service.capabilities().status, 'unavailable')
    assert.equal(service.capabilities().code, 'unavailable')
    assert.match(service.capabilities().reason, /host remote\.speech service is unavailable/)
    await assert.rejects(service.catalog(), hasCode('unavailable'))
    await assert.rejects(service.transcribe(encodeWav([1])), hasCode('unavailable'))
  }
})

test('host catalog and transcribe calls preserve service binding and pass validated WAV metadata', async () => {
  const calls = { catalog: [], transcribe: [] }
  const speech = {
    marker: 'host',
    async catalog(...args) {
      calls.catalog.push({ receiver: this, args })
      return { models: ['host-voice'] }
    },
    async transcribe(request) {
      calls.transcribe.push({ receiver: this, request })
      return { text: '  可编辑的转写文本  ' }
    },
  }
  let remote = null
  const service = createVoiceService({ remote: { get speech() { return remote?.speech ?? null } } })
  assert.equal(service.capabilities().available, false)
  remote = { speech }
  assert.equal(service.capabilities().available, true)
  assert.deepEqual(await service.catalog('zh', { mode: 'fast' }), { models: ['host-voice'] })
  assert.equal(calls.catalog[0].receiver, speech)
  assert.deepEqual(calls.catalog[0].args, ['zh', { mode: 'fast' }])

  const wav = encodeWav(new Int16Array(160))
  const text = await service.transcribe(wav, { language: 'zh-CN', model: 'host-voice' })
  assert.equal(text, '可编辑的转写文本')
  const call = calls.transcribe[0]
  assert.equal(call.receiver, speech)
  assert.deepEqual(call.request.audio, wav)
  assert.equal(call.request.mimeType, 'audio/wav')
  assert.equal(call.request.language, 'zh-CN')
  assert.equal(call.request.model, 'host-voice')
  assert.equal(call.request.durationMs, 10)
  assert.deepEqual(call.request.format, {
    encoding: 'pcm16', sampleRate: 16000, channels: 1, bitsPerSample: 16,
  })
})

test('host transcribe accepts Blob and request-object input but rejects invalid audio before calling the host', async () => {
  let calls = 0
  const service = createVoiceService({
    remote: { speech: { catalog() {}, async transcribe() { calls += 1; return 'text' } } },
  })
  const wav = encodeWav([1, 2])
  assert.equal(await service.transcribe(new Blob([wav], { type: 'audio/webm' })), 'text')
  assert.equal(await service.transcribe({ audio: wav, options: { language: 'en' } }), 'text')
  assert.equal(await service.transcribe({ audio: wav, language: 'fr' }), 'text')
  assert.equal(calls, 3)
  await assert.rejects(service.transcribe(Uint8Array.from([1, 2, 3])), hasCode('invalid-wav'))
  await assert.rejects(service.transcribe(encodeWav([1]), []), hasCode('invalid-options'))
  assert.equal(calls, 3)
})

test('host adapter returns text for common response shapes and rejects empty/malformed responses', async () => {
  const wav = encodeWav([1])
  for (const [response, expected] of [
    ['hello', 'hello'],
    [{ transcript: 'hello' }, 'hello'],
    [{ result: { text: 'hello' } }, 'hello'],
    [{ data: { text: 'hello' } }, 'hello'],
  ]) {
    const service = createVoiceService({
      remote: { speech: { catalog() {}, transcribe: async () => response } },
    })
    assert.equal(await service.transcribe(wav), expected)
  }
  for (const response of ['', '   ', {}, { text: 42 }, null]) {
    const service = createVoiceService({
      remote: { speech: { catalog() {}, transcribe: async () => response } },
    })
    await assert.rejects(service.transcribe(wav), hasCode('invalid-transcription'))
  }
})

test('host adapter enforces configured size and duration limits before transcription', async () => {
  let calls = 0
  const service = createVoiceService({
    remote: { speech: { catalog() {}, async transcribe() { calls += 1; return 'ok' } } },
    maxBytes: 46,
    maxDurationMs: 1,
  })
  await assert.rejects(service.transcribe(encodeWav([1, 2])), hasCode('audio-too-large'))
  assert.equal(calls, 0)
  const durationService = createVoiceService({
    remote: { speech: { catalog() {}, async transcribe() { calls += 1; return 'ok' } } },
    maxDurationMs: 1,
  })
  await assert.rejects(durationService.transcribe(encodeWav(new Int16Array(32))), hasCode('audio-too-long'))
  assert.equal(calls, 0)
})
