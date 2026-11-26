/**
 * Host speech adapter and the wire format shared by voice recording.
 *
 * Audio is always converted to canonical, mono PCM16 WAV before it leaves the
 * browser. This module deliberately has no fallback recognizer: a missing
 * remote.speech service is reported as unavailable rather than silently
 * pretending that transcription succeeded.
 *
 * @module dsh-superagent/voice
 */

export const VOICE_SAMPLE_RATE = 16_000
export const VOICE_CHANNELS = 1
export const VOICE_BITS_PER_SAMPLE = 16
export const VOICE_BYTE_RATE = VOICE_SAMPLE_RATE * VOICE_CHANNELS * VOICE_BITS_PER_SAMPLE / 8
export const DEFAULT_VOICE_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_VOICE_MAX_DURATION_MS = 60_000

const WAV_HEADER_BYTES = 44
const RIFF = 0x52494646 // "RIFF"
const WAVE = 0x57415645 // "WAVE"
const FORMAT = 0x20746d66 // "fmt " as a little-endian uint32
const DATA = 0x61746164 // "data" as a little-endian uint32

export class VoiceError extends Error {
  constructor(code, message, { status = 500, cause, details } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'VoiceError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

export function voiceError(code, message, options) {
  return new VoiceError(code, message, options)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function limits({ maxBytes = DEFAULT_VOICE_MAX_BYTES, maxDurationMs = DEFAULT_VOICE_MAX_DURATION_MS } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < WAV_HEADER_BYTES + 2) {
    throw new VoiceError('invalid-limit', 'maxBytes must be an integer large enough for WAV header and one sample')
  }
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) {
    throw new VoiceError('invalid-limit', 'maxDurationMs must be a positive integer')
  }
  return { maxBytes, maxDurationMs }
}

/** Return a byte view without copying, respecting the input view's offset. */
export function asBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new VoiceError('invalid-audio', 'audio must be an ArrayBuffer or a typed-array/DataView byte sequence')
}

function tag(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3),
  )
}

function invalidWav(message, details) {
  return new VoiceError('invalid-wav', message, { status: 422, details })
}

/**
 * Encode signed 16-bit samples as canonical RIFF/WAVE PCM. Int16Array is the
 * preferred input; ArrayBuffer, even-length byte views, and integer arrays are
 * accepted too. The input is never mutated and bytes are written little-endian.
 *
 * @param {Int16Array|Uint8Array|ArrayBuffer|DataView|number[]} samples
 * @param {{maxBytes?: number, maxDurationMs?: number}} [options]
 * @returns {Uint8Array}
 */
export function encodeWav(samples, options = {}) {
  const { maxBytes, maxDurationMs } = limits(options)
  let count
  let sampleAt
  let source
  if (samples instanceof Int16Array) {
    count = samples.length
    sampleAt = index => samples[index]
  } else if (Array.isArray(samples)) {
    count = samples.length
    sampleAt = index => samples[index]
  } else {
    source = asBytes(samples)
    if (source.byteLength % 2 !== 0) {
      throw new VoiceError('invalid-samples', 'PCM16 input must contain an even number of bytes')
    }
    count = source.byteLength / 2
    sampleAt = index => source[index * 2] | (source[index * 2 + 1] << 8)
  }
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new VoiceError('invalid-samples', 'PCM16 audio must contain at least one sample')
  }
  if (Array.isArray(samples)) {
    for (let index = 0; index < count; index += 1) {
      const value = samples[index]
      if (!Number.isInteger(value) || value < -32768 || value > 32767) {
        throw new VoiceError('invalid-samples', `sample ${index} is not a signed 16-bit integer`)
      }
    }
  }
  const dataBytes = count * 2
  const durationMs = dataBytes * 1000 / VOICE_BYTE_RATE
  if (WAV_HEADER_BYTES + dataBytes > maxBytes) {
    throw new VoiceError('audio-too-large', `WAV audio exceeds the ${maxBytes}-byte limit`, {
      status: 413, details: { byteLength: WAV_HEADER_BYTES + dataBytes, maxBytes },
    })
  }
  if (durationMs > maxDurationMs) {
    throw new VoiceError('audio-too-long', `WAV audio exceeds the ${maxDurationMs}ms duration limit`, {
      status: 413, details: { durationMs, maxDurationMs },
    })
  }

  const wav = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(wav.buffer)
  view.setUint32(0, RIFF, true)
  view.setUint32(4, 36 + dataBytes, true)
  view.setUint32(8, WAVE, true)
  view.setUint32(12, FORMAT, true)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, VOICE_CHANNELS, true)
  view.setUint32(24, VOICE_SAMPLE_RATE, true)
  view.setUint32(28, VOICE_BYTE_RATE, true)
  view.setUint16(32, VOICE_CHANNELS * VOICE_BITS_PER_SAMPLE / 8, true)
  view.setUint16(34, VOICE_BITS_PER_SAMPLE, true)
  view.setUint32(36, DATA, true)
  view.setUint32(40, dataBytes, true)
  for (let index = 0; index < count; index += 1) {
    view.setInt16(WAV_HEADER_BYTES + index * 2, sampleAt(index), true)
  }
  return wav
}

/**
 * Validate the complete WAV container and its format/size/duration limits.
 * Unknown RIFF chunks (for example LIST/JUNK) are allowed, but truncated or
 * duplicate fmt/data chunks and inconsistent header fields are rejected.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @param {{maxBytes?: number, maxDurationMs?: number}} [options]
 * @returns {{byteLength:number,dataByteLength:number,sampleCount:number,durationMs:number,sampleRate:number,channels:number,bitsPerSample:number,encoding:string}}
 */
export function inspectWav(input, options = {}) {
  const { maxBytes, maxDurationMs } = limits(options)
  const bytes = asBytes(input)
  const byteLength = bytes.byteLength
  if (byteLength > maxBytes) {
    throw new VoiceError('audio-too-large', `WAV audio exceeds the ${maxBytes}-byte limit`, {
      status: 413, details: { byteLength, maxBytes },
    })
  }
  if (byteLength < WAV_HEADER_BYTES) {
    throw invalidWav('WAV audio is shorter than its 44-byte header')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== RIFF || view.getUint32(8, true) !== WAVE) {
    throw invalidWav('audio must be a little-endian RIFF/WAVE file')
  }
  if (view.getUint32(4, true) + 8 !== byteLength) {
    throw invalidWav('the RIFF size does not match the WAV byte length')
  }

  let offset = 12
  let format = null
  let data = null
  while (offset < byteLength) {
    if (offset + 8 > byteLength) throw invalidWav('WAV contains a truncated chunk header')
    const id = tag(view, offset)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + size
    const paddedEnd = end + (size % 2)
    if (!Number.isSafeInteger(end) || paddedEnd > byteLength) {
      throw invalidWav(`WAV chunk ${JSON.stringify(id)} is truncated`)
    }
    if (id === 'fmt ') {
      if (format) throw invalidWav('WAV contains more than one fmt chunk')
      format = { offset: start, size }
    } else if (id === 'data') {
      if (data) throw invalidWav('WAV contains more than one data chunk')
      data = { offset: start, size }
    }
    offset = paddedEnd
  }
  if (!format) throw invalidWav('WAV has no fmt chunk')
  if (!data) throw invalidWav('WAV has no data chunk')
  if (format.size < 16 || format.offset + 16 > byteLength) {
    throw invalidWav('WAV fmt chunk must contain at least 16 bytes')
  }

  const encoding = view.getUint16(format.offset, true)
  const channels = view.getUint16(format.offset + 2, true)
  const sampleRate = view.getUint32(format.offset + 4, true)
  const byteRate = view.getUint32(format.offset + 8, true)
  const blockAlign = view.getUint16(format.offset + 12, true)
  const bitsPerSample = view.getUint16(format.offset + 14, true)
  if (encoding !== 1 || channels !== VOICE_CHANNELS || sampleRate !== VOICE_SAMPLE_RATE
    || bitsPerSample !== VOICE_BITS_PER_SAMPLE || blockAlign !== 2 || byteRate !== VOICE_BYTE_RATE) {
    throw invalidWav('WAV must be 16kHz mono PCM16 (byteRate 32000, blockAlign 2)', {
      encoding, channels, sampleRate, bitsPerSample, blockAlign, byteRate,
    })
  }
  if (data.size === 0 || data.size % 2 !== 0) {
    throw invalidWav('WAV data must contain a positive, even number of PCM16 bytes')
  }
  const durationMs = data.size * 1000 / VOICE_BYTE_RATE
  if (durationMs > maxDurationMs) {
    throw new VoiceError('audio-too-long', `WAV audio exceeds the ${maxDurationMs}ms duration limit`, {
      status: 413, details: { durationMs, maxDurationMs },
    })
  }
  return {
    byteLength,
    dataByteLength: data.size,
    sampleCount: data.size / 2,
    durationMs,
    sampleRate,
    channels,
    bitsPerSample,
    encoding: 'pcm16',
  }
}

/** Synchronous alias for callers that only need validation metadata. */
export const validateWav = inspectWav

async function inputBytes(input) {
  // Blob is intentionally handled here, not by asBytes, so validation remains
  // synchronous for already-buffered audio.
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer())
  }
  return asBytes(input)
}

function speechService(remote) {
  try {
    const speech = remote?.speech
    if (!speech || typeof speech.catalog !== 'function' || typeof speech.transcribe !== 'function') {
      return {
        speech: null,
        reason: 'the host remote.speech service is unavailable; both catalog and transcribe are required',
      }
    }
    return { speech, reason: null }
  } catch (error) {
    return { speech: null, reason: `the host remote.speech service is unavailable: ${messageOf(error)}` }
  }
}

function transcriptOf(result) {
  const text = typeof result === 'string'
    ? result
    : result?.text ?? result?.transcript ?? result?.result?.text ?? result?.data?.text
  if (typeof text !== 'string' || !text.trim()) {
    throw new VoiceError('invalid-transcription', 'the host speech service returned no editable text', { status: 502 })
  }
  return text.trim()
}

/**
 * Adapt the host's remote.speech.catalog/transcribe service. Services are
 * resolved on every call so a late-mounted host service becomes usable without
 * rebuilding the adapter.
 *
 * transcribe(audio, options) sends one validated WAV and resolves to a string.
 * It never sends a chat message or invokes any conversation/session API.
 *
 * @param {{remote?: object, maxBytes?: number, maxDurationMs?: number}} [options]
 */
export function createVoiceService({ remote = null, maxBytes, maxDurationMs } = {}) {
  const wavOptions = {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
  }
  // Validate configuration at construction rather than halfway through a recording.
  limits(wavOptions)

  function requireSpeech() {
    const { speech, reason } = speechService(remote)
    if (!speech) {
      throw new VoiceError('unavailable', reason, { status: 503, details: { service: 'remote.speech' } })
    }
    return speech
  }

  function capabilities() {
    const { speech, reason } = speechService(remote)
    return {
      available: Boolean(speech),
      status: speech ? 'ready' : 'unavailable',
      code: speech ? null : 'unavailable',
      reason,
      service: 'remote.speech',
      format: {
        mimeType: 'audio/wav', encoding: 'pcm16', sampleRate: VOICE_SAMPLE_RATE,
        channels: VOICE_CHANNELS, bitsPerSample: VOICE_BITS_PER_SAMPLE,
      },
      maxBytes: wavOptions.maxBytes ?? DEFAULT_VOICE_MAX_BYTES,
      maxDurationMs: wavOptions.maxDurationMs ?? DEFAULT_VOICE_MAX_DURATION_MS,
    }
  }

  async function catalog(...args) {
    return requireSpeech().catalog(...args)
  }

  async function transcribe(input, options = {}) {
    const speech = requireSpeech()
    let audio = input
    let extra = options ?? {}
    if (input && typeof input === 'object' && !ArrayBuffer.isView(input)
      && !(input instanceof ArrayBuffer) && Object.hasOwn(input, 'audio')) {
      const { audio: nestedAudio, options: nestedOptions, ...inlineOptions } = input
      audio = nestedAudio
      extra = { ...inlineOptions, ...(nestedOptions ?? {}), ...(options ?? {}) }
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new VoiceError('invalid-options', 'transcription options must be an object')
    }
    const bytes = await inputBytes(audio)
    const metadata = inspectWav(bytes, wavOptions)
    const result = await speech.transcribe({
      ...extra,
      audio: bytes,
      mimeType: 'audio/wav',
      format: {
        encoding: 'pcm16', sampleRate: VOICE_SAMPLE_RATE,
        channels: VOICE_CHANNELS, bitsPerSample: VOICE_BITS_PER_SAMPLE,
      },
      durationMs: metadata.durationMs,
    })
    return transcriptOf(result)
  }

  return { capabilities, catalog, transcribe }
}
