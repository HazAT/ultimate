import { createRoot, createSignal } from 'solid-js'
import { errorMessage, writerNow, writingAs } from '@/sdk/solid'
import type { DictationSink, DictationTake } from '@/sdk/solid'
import { inProcess } from '../../lib/errors.shared.ts'
import { animationFrames, deadline } from '../../lib/timers.shared.ts'

const recordingMimeOrder = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg', 'audio/webm']
const MAX_RECORDING_MS = 5 * 60_000
export const MIN_SPOKEN_SECONDS = 0.6
const VOICED_LEVEL = 0.12
const MIN_VOICED_FRAMES = 6

export type Recorded = DictationTake
export type Sink = DictationSink

export function unsupported() {
  if (!window.isSecureContext) return 'Voice needs HTTPS: open Ultimate over its tailnet URL'
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
    return 'This browser cannot record audio'
  return undefined
}

function micFailure(failure: unknown) {
  if (failure instanceof DOMException) {
    if (failure.name === 'NotFoundError') return 'No microphone found'
    if (failure.name === 'NotAllowedError') {
      const agent = navigator.userAgent
      if (/; wv\)/.test(agent))
        return 'Microphone denied: this app must declare and grant the microphone to its web view'
      const android = /Android/.test(agent)
      if (failure.message === 'Permission denied by system')
        return android
          ? 'Android blocks the mic for Chrome: allow it in Settings → Apps → Chrome → Permissions'
          : 'The system blocks the mic for this browser: allow it in the system’s privacy settings'
      if (android)
        return 'Mic blocked for this site: allow it in Chrome → Settings → Site settings → Microphone'
      return 'Microphone access is blocked: allow it in the browser’s site settings'
    }
  }
  return `Could not start recording: ${errorMessage(failure)}`
}

export async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

function createMic(keepOpen: () => boolean) {
  let stream: MediaStream | undefined
  let audio: AudioContext | undefined
  let analyser: AnalyserNode | undefined
  const levels: number[] = []
  const listeners = new Set<() => void>()

  async function release() {
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    analyser = undefined
    const closing = audio
    audio = undefined
    await closing?.close()
  }

  async function start(unexpectedStop: () => void) {
    stream ??= await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
    if (typeof AudioContext !== 'undefined') {
      audio ??= new AudioContext()
      if (audio.state === 'suspended') await audio.resume()
      if (!analyser) {
        analyser = audio.createAnalyser()
        analyser.fftSize = 1024
        audio.createMediaStreamSource(stream).connect(analyser)
      }
    }
    const mimeType = recordingMimeOrder.find((type) => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    const chunks: Blob[] = []
    const stopped = Promise.withResolvers<{ audio: Recorded; unexpected: boolean }>()
    let requestedStop = false
    let stopFrames: (() => void) | undefined
    let voiced = 0
    levels.length = 0
    const started = performance.now()
    recorder.addEventListener('dataavailable', ({ data }) => {
      if (data.size) chunks.push(data)
    })
    recorder.addEventListener(
      'stop',
      () => {
        stopFrames?.()
        const seconds = (performance.now() - started) / 1000
        const unexpected = !requestedStop
        stopped.resolve({
          unexpected,
          audio: {
            blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
            seconds,
            spoke: seconds >= MIN_SPOKEN_SECONDS && voiced >= MIN_VOICED_FRAMES,
            envelope: levels.slice(),
          },
        })
        if (unexpected) unexpectedStop()
      },
      { once: true },
    )
    recorder.start()
    const meter = analyser
    if (meter) {
      const samples = new Float32Array(meter.fftSize)
      stopFrames = animationFrames(() => {
        meter.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        const level = Math.min(1, Math.pow(Math.sqrt(sum / samples.length) * 9, 0.8))
        levels.push(level)
        if (level > VOICED_LEVEL) voiced++
        for (const listener of listeners) listener()
      })
    }
    return async () => {
      if (recorder.state !== 'inactive') {
        requestedStop = true
        recorder.stop()
      }
      const result = await stopped.promise
      if (result.unexpected || !keepOpen() || matchMedia('(pointer: coarse)').matches)
        await release()
      return result
    }
  }

  return {
    start,
    levels: () => levels as readonly number[],
    onLevel: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    release,
  }
}

export type Take = {
  active(): boolean
  started: Promise<void>
  release(): Promise<void>
  cancel(): Promise<void>
}

export function createCapture(keepOpen = () => false) {
  const mic = createMic(() => keepOpen())
  const [active, setActive] = createSignal<Sink>()
  const [pending, setPending] = createSignal(false)
  let current: { sink: Sink; take: Take } | undefined
  const latest = new WeakMap<Sink, Take>()
  let micWork: Promise<unknown> = Promise.resolve()
  const onMic = <T>(work: () => Promise<T>) => {
    const run = micWork.then(work, work)
    micWork = run
    return run
  }
  const onPage = (work: Promise<void>) => inProcess('the recording belongs to this page', work)

  function press(sink: Sink): Take | undefined {
    const signal = sink.signal
    if (current || signal?.aborted) return undefined
    const who = writerNow()
    const reason = unsupported()
    if (reason) {
      sink.error?.(reason)
      return undefined
    }
    let stopMic: Awaited<ReturnType<typeof mic.start>> | undefined
    let cap: (() => void) | undefined
    const abort = () => onPage(take.cancel())
    const clear = () => {
      current = undefined
      setActive(undefined)
      setPending(false)
      signal?.removeEventListener('abort', abort)
      cap?.()
      cap = undefined
    }
    const discard = () => {
      if (latest.get(sink) === take) sink.cancel?.()
    }
    async function stop(send: boolean) {
      if (!take.active()) return
      clear()
      const result = await onMic(async () => {
        const finishMic = stopMic
        stopMic = undefined
        return finishMic?.()
      })
      if (!send || signal?.aborted || !result || (result.unexpected && !result.audio.blob.size))
        discard()
      else await writingAs(who, () => sink.finish(result.audio, latest.get(sink) !== take))
    }
    const take: Take = {
      active: () => current?.take === take,
      release: () => stop(true),
      cancel: () => stop(false),
      started: onMic(async () => {
        if (!take.active()) return
        try {
          stopMic = await mic.start(() => onPage(take.release()))
        } catch (failure) {
          if (take.active()) {
            clear()
            discard()
          }
          if (!signal?.aborted && latest.get(sink) === take) sink.error?.(micFailure(failure))
          await mic.release()
          return
        }
        if (!take.active()) return
        cap = deadline(MAX_RECORDING_MS, () => onPage(take.release()))
        setActive(sink)
        sink.recording?.()
      }),
    }
    current = { sink, take }
    setPending(true)
    latest.set(sink, take)
    signal?.addEventListener('abort', abort, { once: true })
    sink.start?.()
    return take
  }

  async function end(owner?: Sink) {
    if (owner && current && owner !== current.sink) return
    await Promise.all([current?.take.cancel(), onMic(mic.release)])
  }

  const take = (owner?: Sink) => (!owner || owner === current?.sink ? current?.take : undefined)
  return {
    press,
    end,
    take,
    talking: (owner?: Sink) => take(owner) !== undefined,
    pending,
    capturing: (owner?: Sink) => {
      const sink = active()
      return !!sink && (!owner || owner === sink)
    },
    levels: mic.levels,
    onLevel: mic.onLevel,
    setKeepOpen: (next: () => boolean) => (keepOpen = next),
  }
}

export const capture = createRoot(() => createCapture())

export function drawWave(
  canvas: HTMLCanvasElement,
  envelope: readonly number[],
  color: string,
  live: boolean,
) {
  const context = canvas.getContext('2d')
  if (!context) return
  const { width, height } = canvas
  context.clearRect(0, 0, width, height)
  const count = live ? 140 : Math.min(Math.max(envelope.length, 1), 160)
  const values = live
    ? envelope.slice(-count)
    : Array.from({ length: count }, (_, index) => {
        const from = Math.floor((index * envelope.length) / count)
        const to = Math.max(from + 1, Math.floor(((index + 1) * envelope.length) / count))
        return Math.max(0, ...envelope.slice(from, to))
      })
  const step = width / count
  const middle = height / 2
  context.fillStyle = color
  values.forEach((value, index) => {
    const half = Math.max(1, Math.min(1, value) * (middle - 2))
    const x = live ? width - (values.length - index) * step : index * step
    context.globalAlpha = live ? 0.25 + (0.75 * index) / values.length : 0.85
    context.beginPath()
    context.roundRect(x, middle - half, Math.max(1.5, step * 0.55), half * 2, 1.5)
    context.fill()
  })
  context.globalAlpha = 1
}
