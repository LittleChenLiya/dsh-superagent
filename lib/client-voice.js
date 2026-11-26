/**
 * Browser push-to-talk controller.
 *
 * The controller owns the microphone only while recording. It converts the
 * MediaRecorder result to 16kHz mono PCM16 WAV and returns transcription text
 * to the caller; it has no message-sending integration. Browser and host
 * dependencies are injectable so the lifecycle can be tested without a real
 * microphone or AudioContext.
 *
 * @module dsh-superagent/client-voice
 */

import {
  DEFAULT_VOICE_MAX_BYTES,
  DEFAULT_VOICE_MAX_DURATION_MS,
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_SAMPLE_RATE,
  VoiceError,
  createVoiceService,
  encodeWav,
  inspectWav,
} from './voice.js'

export { VoiceError }

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
]

function messageOf(error) {
  return error?.message ?? String(error)
}

function normalizeError(error, fallback = 'recording-failed') {
  if (error instanceof VoiceError) return error
  const name = error?.name ?? ''
  let code = fallback
  let status = 500
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    code = 'permission-denied'
    status = 403
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    code = 'no-device'
    status = 503
  } else if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    code = 'device-busy'
    status = 503
  } else if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    code = 'no-device'
    status = 503
  } else if (name === 'NotSupportedError' || name === 'MediaRecorderNotSupported') {
    code = 'recording-unavailable'
    status = 501
  }
  return new VoiceError(code, messageOf(error) || 'voice recording failed', { status, cause: error })
}

function invoke(listener, ...args) {
  if (typeof listener !== 'function') return
  try {
    listener(...args)
  } catch {
    // UI callbacks must not prevent track release or stale-result invalidation.
  }
}

function listen(target, type, handler) {
  if (typeof target?.addEventListener === 'function') {
    target.addEventListener(type, handler)
    return () => target.removeEventListener?.(type, handler)
  }
  if (!target) return () => {}
  const property = `on${type}`
  const previous = target[property]
  target[property] = handler
  return () => { target[property] = previous }
}

function releaseStream(stream) {
  if (!stream) return
  let tracks = []
  try {
    tracks = typeof stream.getTracks === 'function'
      ? stream.getTracks()
      : typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : []
  } catch {
    tracks = []
  }
  for (const track of Array.isArray(tracks) ? tracks : []) {
    try { track?.stop?.() } catch { /* continue releasing the other tracks */ }
  }
}

function transcriptOf(result) {
  const text = typeof result === 'string'
    ? result
    : result?.text ?? result?.transcript ?? result?.result?.text ?? result?.data?.text
  if (typeof text !== 'string' || !text.trim()) {
    throw new VoiceError('invalid-transcription', 'the speech service returned no editable text', { status: 502 })
  }
  return text.trim()
}

/**
 * Mix an AudioBuffer-like object to mono, linearly resample it to 16kHz, and
 * encode signed PCM16 WAV. Keeping this step independent of MediaRecorder makes
 * format conversion deterministic and unit-testable.
 *
 * @param {{sampleRate:number,length:number,numberOfChannels:number,getChannelData:(channel:number)=>Float32Array}} audio
 * @param {{maxBytes?:number,maxDurationMs?:number}} [options]
 * @returns {Uint8Array}
 */
export function audioBufferToWav(audio, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_VOICE_MAX_BYTES
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_VOICE_MAX_DURATION_MS
  if (!audio || !Number.isSafeInteger(audio.sampleRate) || audio.sampleRate <= 0
    || !Number.isSafeInteger(audio.length) || audio.length <= 0
    || !Number.isSafeInteger(audio.numberOfChannels) || audio.numberOfChannels <= 0
    || typeof audio.getChannelData !== 'function') {
    throw new VoiceError('invalid-audio', 'decoded audio must be a non-empty AudioBuffer', { status: 422 })
  }
  const durationMs = audio.length * 1000 / audio.sampleRate
  if (durationMs > maxDurationMs) {
    throw new VoiceError('audio-too-long', `recorded audio exceeds the ${maxDurationMs}ms duration limit`, {
      status: 413, details: { durationMs, maxDurationMs },
    })
  }
  const outputLength = Math.ceil(audio.length * VOICE_SAMPLE_RATE / audio.sampleRate)
  if (!Number.isSafeInteger(outputLength) || outputLength <= 0
    || 44 + outputLength * 2 > maxBytes) {
    throw new VoiceError('audio-too-large', `recorded WAV would exceed the ${maxBytes}-byte limit`, { status: 413 })
  }
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => {
    const data = audio.getChannelData(channel)
    if (!data || data.length < audio.length) {
      throw new VoiceError('invalid-audio', `decoded audio channel ${channel} is truncated`, { status: 422 })
    }
    return data
  })
  const pcm = new Int16Array(outputLength)
  const ratio = audio.sampleRate / VOICE_SAMPLE_RATE
  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio
    const left = Math.min(Math.floor(position), audio.length - 1)
    const right = Math.min(left + 1, audio.length - 1)
    const fraction = position - left
    let sample = 0
    for (const channel of channels) {
      const from = Number.isFinite(channel[left]) ? channel[left] : 0
      const to = fraction === 0 ? from : Number.isFinite(channel[right]) ? channel[right] : from
      sample += from + (to - from) * fraction
    }
    sample /= channels.length
    const value = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
    pcm[index] = Math.round(value < 0 ? value * 32768 : value * 32767)
  }
  return encodeWav(pcm, { maxBytes, maxDurationMs })
}

/**
 * Decode a MediaRecorder Blob and convert it to the host's required WAV format.
 * AudioContext/Blob are the browser defaults; decodeAudioData is an optional
 * injection point which receives an ArrayBuffer and returns an AudioBuffer-like
 * object (or a promise for one).
 */
export async function decodeRecordedAudio(blob, options = {}) {
  let context = null
  try {
    let audio
    if (typeof options.decodeAudioData === 'function') {
      audio = await options.decodeAudioData(await blob.arrayBuffer())
    } else {
      const AudioContext = options.AudioContext ?? options.audioContext
        ?? globalThis.AudioContext ?? globalThis.webkitAudioContext
      if (typeof AudioContext !== 'function') {
        throw new VoiceError('decode-unavailable', 'browser audio decoding is unavailable; AudioContext is required', { status: 501 })
      }
      context = new AudioContext()
      audio = await context.decodeAudioData(await blob.arrayBuffer())
    }
    return audioBufferToWav(audio, options)
  } catch (error) {
    throw normalizeError(error, error?.name === 'EncodingError' ? 'decode-failed' : 'recording-failed')
  } finally {
    if (context && typeof context.close === 'function') {
      try { await context.close() } catch { /* the decoded samples are already independent */ }
    }
  }
}

function chooseMimeType(Recorder) {
  if (typeof Recorder?.isTypeSupported !== 'function') return null
  return MIME_CANDIDATES.find(type => {
    try { return Recorder.isTypeSupported(type) } catch { return false }
  }) ?? null
}

/**
 * Create a push-to-talk controller.
 *
 * Public lifecycle: start() on press, stop() on release, cancel() to discard,
 * and dispose() on unmount. stop() resolves to editable text (or null when the
 * recording was canceled), and never submits it. onTranscript/onError and
 * subscribe() expose the same outcomes/state to a UI without requiring polling.
 *
 * @param {object} [options]
 * @param {(wav:Uint8Array, metadata:object)=>Promise<string|{text:string}>|string|{text:string}} [options.transcribe]
 * @param {{transcribe:Function}} [options.speech] host speech adapter
 * @param {object} [options.remote] host context carrying remote.speech
 * @param {Function} [options.onTranscript] receives editable text only
 * @param {(error:VoiceError)=>void} [options.onError]
 * @param {(state:string)=>void} [options.onStateChange]
 */
export function createVoiceController(options = {}) {
  const browser = options.window ?? globalThis.window ?? globalThis
  const navigator = options.navigator ?? browser.navigator ?? globalThis.navigator
  const document = options.document ?? browser.document ?? globalThis.document
  const Recorder = options.MediaRecorder ?? browser.MediaRecorder ?? globalThis.MediaRecorder
  const maxBytes = options.maxBytes ?? DEFAULT_VOICE_MAX_BYTES
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_VOICE_MAX_DURATION_MS
  const wavOptions = { maxBytes, maxDurationMs }
  const host = options.remote ? createVoiceService({ remote: options.remote, ...wavOptions }) : null
  const speech = options.speech ?? host
  const transcribe = typeof options.transcribe === 'function'
    ? options.transcribe
    : typeof speech?.transcribe === 'function' ? speech.transcribe.bind(speech) : null

  let phase = 'idle'
  let active = null
  let generation = 0
  let starting = null
  let startingId = null
  let stopping = null
  let stoppingSession = null
  let recordingTimer = null
  let disposed = false
  const listeners = new Set()
  const cleanupListeners = []

  function setPhase(next) {
    if (phase === next) return
    phase = next
    invoke(options.onStateChange, next)
    for (const listener of [...listeners]) invoke(listener, next)
  }

  function capabilities() {
    let hostCapabilities = null
    try {
      hostCapabilities = typeof speech?.capabilities === 'function' ? speech.capabilities() : null
    } catch (error) {
      hostCapabilities = { available: false, reason: `host speech capabilities are unavailable: ${messageOf(error)}` }
    }
    const hostAvailable = hostCapabilities ? hostCapabilities.available === true : typeof transcribe === 'function'
    const mediaAvailable = typeof navigator?.mediaDevices?.getUserMedia === 'function'
    const recorderAvailable = typeof Recorder === 'function'
    const decodeAvailable = typeof options.decodeAudioData === 'function'
      || typeof (options.AudioContext ?? options.audioContext
        ?? globalThis.AudioContext ?? globalThis.webkitAudioContext) === 'function'
    let code = null
    let reason = null
    if (!hostAvailable) {
      code = 'unavailable'
      reason = hostCapabilities?.reason
        ?? 'the host speech transcription service is unavailable; remote.speech.catalog/transcribe are required'
    } else if (!mediaAvailable) {
      code = 'recording-unavailable'
      reason = 'browser microphone access is unavailable; navigator.mediaDevices.getUserMedia is required'
    } else if (!recorderAvailable) {
      code = 'recording-unavailable'
      reason = 'browser audio recording is unavailable; MediaRecorder is required'
    } else if (!decodeAvailable) {
      code = 'decode-unavailable'
      reason = 'browser audio decoding is unavailable; AudioContext is required'
    }
    return {
      available: code === null,
      supported: mediaAvailable && recorderAvailable && decodeAvailable,
      status: code === null ? 'ready' : 'unavailable',
      code,
      reason,
      state: phase,
      maxBytes,
      maxDurationMs,
      format: {
        mimeType: 'audio/wav', encoding: 'pcm16', sampleRate: VOICE_SAMPLE_RATE,
        channels: VOICE_CHANNELS, bitsPerSample: VOICE_BITS_PER_SAMPLE,
      },
    }
  }

  function clearTimer() {
    if (recordingTimer !== null) clearTimeout(recordingTimer)
    recordingTimer = null
  }

  function isCurrent(session) {
    return !disposed && active === session && session.id === generation
  }

  function fail(session, error) {
    const normalized = normalizeError(error)
    clearTimer()
    if (session) {
      session.failure = normalized
      session.rejectStop?.(normalized)
      releaseStream(session.stream)
      session.stream = null
      if (session.recorder && session.recorder.state !== 'inactive') {
        try { session.recorder.stop() } catch { /* the original failure is more useful */ }
      }
    }
    if (!session || isCurrent(session)) {
      active = null
      setPhase('idle')
    }
    invoke(options.onError, normalized)
    return normalized
  }

  function cancel() {
    if (disposed) return
    generation += 1
    clearTimer()
    const session = active
    active = null
    if (session) {
      session.resolveStop?.(null)
      if (stoppingSession === session) {
        stopping = null
        stoppingSession = null
      }
      releaseStream(session.stream)
      session.stream = null
      if (session.recorder && session.recorder.state !== 'inactive') {
        try { session.recorder.stop() } catch { /* cancellation still releases tracks */ }
      }
    }
    setPhase('idle')
  }

  function dispose() {
    if (disposed) return
    cancel()
    disposed = true
    listeners.clear()
    for (const cleanup of cleanupListeners.splice(0)) cleanup()
  }

  async function finish(session) {
    if (session.failure) throw session.failure
    if (!isCurrent(session)) return null
    const blob = new Blob(session.chunks, { type: session.mimeType || 'audio/webm' })
    if (blob.size === 0) {
      throw new VoiceError('empty-recording', 'the microphone returned no audio data', { status: 422 })
    }
    if (blob.size > maxBytes) {
      throw new VoiceError('audio-too-large', `recorded audio exceeds the ${maxBytes}-byte limit`, { status: 413 })
    }
    const wav = await decodeRecordedAudio(blob, {
      ...wavOptions,
      AudioContext: options.AudioContext,
      audioContext: options.audioContext,
      decodeAudioData: options.decodeAudioData,
    })
    if (!isCurrent(session)) return null
    const metadata = inspectWav(wav, wavOptions)
    let result
    try {
      result = await transcribe(wav, {
        mimeType: 'audio/wav',
        format: {
          encoding: 'pcm16', sampleRate: VOICE_SAMPLE_RATE,
          channels: VOICE_CHANNELS, bitsPerSample: VOICE_BITS_PER_SAMPLE,
        },
        durationMs: metadata.durationMs,
      })
    } catch (error) {
      throw normalizeError(error, 'transcription-failed')
    }
    if (!isCurrent(session)) return null
    const text = transcriptOf(result)
    invoke(options.onTranscript, text)
    return text
  }

  function start() {
    if (disposed) {
      return Promise.reject(new VoiceError('disposed', 'the voice controller has been disposed', { status: 409 }))
    }
    const caps = capabilities()
    if (!caps.available) {
      return Promise.reject(new VoiceError(caps.code, caps.reason, {
        status: caps.code === 'unavailable' ? 503 : 501,
      }))
    }
    if (phase !== 'idle') {
      if (starting) return starting
      return Promise.reject(new VoiceError('recording-active', `cannot start voice input while ${phase}`, { status: 409 }))
    }
    const id = ++generation
    setPhase('requesting')
    const operation = (async () => {
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: VOICE_CHANNELS,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
      } catch (error) {
        if (disposed || id !== generation) return
        throw fail(null, error)
      }
      if (disposed || id !== generation) {
        releaseStream(stream)
        return
      }
      let tracks = []
      try {
        tracks = typeof stream?.getTracks === 'function' ? stream.getTracks() : stream?.getAudioTracks?.() ?? []
      } catch (error) {
        releaseStream(stream)
        throw fail(null, error)
      }
      if (!Array.isArray(tracks) || tracks.length === 0 || tracks.every(track => track?.readyState === 'ended')) {
        releaseStream(stream)
        throw fail(null, new VoiceError('no-device', 'the browser returned no active microphone track', { status: 503 }))
      }

      const session = {
        id, stream, recorder: null, chunks: [], bytes: 0, mimeType: null,
        failure: null, resolveStop: null, rejectStop: null,
      }
      active = session
      try {
        const mimeType = chooseMimeType(Recorder)
        session.mimeType = mimeType
        const recorder = mimeType ? new Recorder(stream, { mimeType }) : new Recorder(stream)
        session.recorder = recorder
        listen(recorder, 'dataavailable', event => {
          if (!isCurrent(session)) return
          const data = event?.data
          if (!data) return
          session.bytes += data.size
          if (session.bytes > maxBytes) {
            fail(session, new VoiceError('audio-too-large', `recorded audio exceeds the ${maxBytes}-byte limit`, { status: 413 }))
            return
          }
          session.chunks.push(data)
        })
        listen(recorder, 'stop', () => {
          if (!isCurrent(session)) return
          session.resolveStop?.(null)
        })
        listen(recorder, 'error', event => {
          if (!isCurrent(session)) return
          fail(session, event?.error ?? new VoiceError('recording-failed', 'MediaRecorder failed'))
        })
        recorder.start(250)
      } catch (error) {
        throw fail(session, error)
      }
      setPhase('recording')
      recordingTimer = setTimeout(() => {
        recordingTimer = null
        stop().catch(error => {
          if (isCurrent(active)) fail(active, error)
        })
      }, maxDurationMs)
    })()
    starting = operation
    startingId = id
    return operation.finally(() => {
      if (startingId === id) {
        starting = null
        startingId = null
      }
    })
  }

  function stop() {
    if (disposed || phase === 'idle' || phase === 'requesting') {
      if (phase === 'requesting') cancel()
      return Promise.resolve(null)
    }
    const session = active
    if (!session?.recorder) return Promise.resolve(null)
    if (stopping && stoppingSession === session) return stopping
    clearTimer()
    setPhase('transcribing')
    const operation = (async () => {
      try {
        await new Promise((resolve, reject) => {
          session.resolveStop = resolve
          session.rejectStop = reject
          try {
            session.recorder.stop()
          } catch (error) {
            releaseStream(session.stream)
            session.stream = null
            reject(error)
            return
          }
          releaseStream(session.stream)
          session.stream = null
        })
        if (!isCurrent(session)) return null
        const text = await finish(session)
        if (!isCurrent(session)) return null
        active = null
        setPhase('idle')
        return text
      } catch (error) {
        if (session.failure) throw session.failure
        if (!isCurrent(session)) return null
        throw fail(session, error)
      }
    })().finally(() => {
      session.resolveStop = null
      session.rejectStop = null
      if (stoppingSession === session) {
        stopping = null
        stoppingSession = null
      }
    })
    stopping = operation
    stoppingSession = session
    return operation
  }

  if (typeof document?.addEventListener === 'function') {
    cleanupListeners.push(listen(document, 'visibilitychange', () => {
      if (document.hidden) cancel()
    }))
  }
  for (const target of [browser]) {
    if (typeof target?.addEventListener !== 'function') continue
    for (const type of ['pagehide', 'beforeunload']) {
      cleanupListeners.push(listen(target, type, cancel))
    }
  }

  return {
    start,
    stop,
    cancel,
    dispose,
    capabilities,
    getCapabilities: capabilities,
    startRecording: start,
    stopRecording: stop,
    get state() { return phase },
    get disposed() { return disposed },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('a voice state listener must be a function')
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
