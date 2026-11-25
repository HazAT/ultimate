import { createRoot, createSignal } from 'solid-js'
import { errorMessage } from '@/sdk/solid'
import type { DictationSink, DictationTake } from '@/sdk/solid'
import { inProcess } from '../../lib/errors.ts'
import { deadline } from '../../lib/timers.ts'

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

export function animationFrames(fn: () => void) {
  let handle = requestAnimationFrame(function tick() {
    fn()
    handle = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(handle)
}

function createMic(keepOpen: () => boolean) {
  let stream: MediaStream | undefined
  let audio: AudioContext | undefined
  let analyser: AnalyserNode | undefined
  const levels: number[] = []
  const listeners = new Set<() => void>()
  let recorder: MediaRecorder | undefined
  let chunks: Blob[] = []
  let started = 0
  let voiced = 0
  let stopFrames: (() => void) | undefined

  function release() {
    stopFrames?.()
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    recorder = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    analyser = undefined
    const closing = audio
    audio = undefined
    return closing?.close()
  }

  async function start() {
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
    const active = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    const captured: Blob[] = []
    chunks = captured
    levels.length = 0
    voiced = 0
    active.addEventListener('dataavailable', ({ data }) => {
      if (data.size) captured.push(data)
    })
    active.start()
    recorder = active
    started = performance.now()
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
  }

  async function stop(): Promise<Recorded | undefined> {
    const active = recorder
    if (!active) return undefined
    recorder = undefined
    stopFrames?.()
    stopFrames = undefined
    const stopped = new Promise<void>((resolve) =>
      active.addEventListener('stop', () => resolve(), { once: true }),
    )
    active.stop()
    await stopped
    const seconds = (performance.now() - started) / 1000
    if (!keepOpen()) await release()
    return {
      blob: new Blob(chunks, { type: active.mimeType || 'audio/webm' }),
      seconds,
      spoke: seconds >= MIN_SPOKEN_SECONDS && voiced >= MIN_VOICED_FRAMES,
      envelope: levels.slice(),
    }
  }

  return {
    start,
    stop,
    recording: () => recorder !== undefined,
    levels: () => levels as readonly number[],
    onLevel: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    release,
  }
}

export function createCapture(keepOpen = () => false) {
  const mic = createMic(() => keepOpen())
  const [active, setActive] = createSignal<{ sink: Sink; signal?: AbortSignal }>()
  let sink: Sink | undefined
  let lifetime: AbortSignal | undefined
  let pressing = 0
  let released = 0
  let ended = 0
  let cap: (() => void) | undefined
  let micWork: Promise<unknown> = Promise.resolve()
  const onMic = <T>(work: () => Promise<T>) => {
    const run = micWork.then(work, work)
    micWork = run
    return run
  }
  const clear = () => {
    cap?.()
    cap = undefined
    setActive(undefined)
  }

  async function press(next: Sink, signal?: AbortSignal) {
    if (pressing > released || signal?.aborted) return
    const reason = unsupported()
    if (reason) {
      next.error?.(reason)
      return
    }
    const mine = ++pressing
    sink = next
    lifetime = signal
    next.start?.()
    let started: boolean
    try {
      started = await onMic(async () => {
        if (released >= mine) return false
        try {
          await mic.start()
        } catch (failure) {
          await mic.release()
          throw failure
        }
        if (released < mine) {
          cap = deadline(MAX_RECORDING_MS, () =>
            inProcess('the recording belongs to this page', release(next)),
          )
        }
        return true
      })
    } catch (failure) {
      if (pressing !== mine) return
      released = mine
      sink = undefined
      next.cancel?.()
      if (!signal?.aborted) next.error?.(micFailure(failure))
      return
    }
    if (released >= mine) {
      if (!started && (pressing === mine || sink !== next)) next.cancel?.()
      return
    }
    setActive({ sink: next, signal })
    next.recording?.()
  }

  async function cancel(owner?: Sink) {
    if (owner && owner !== sink) return
    const take = pressing
    const cancelled = sink
    released = take
    clear()
    await onMic(() => mic.stop())
    if (pressing === take) sink = undefined
    if (sink !== cancelled) cancelled?.cancel?.()
  }

  async function release(owner?: Sink) {
    if (owner && owner !== sink) return
    const take = pressing
    const finishing = sink
    const signal = lifetime
    released = take
    clear()
    const recorded = await onMic(() => mic.stop())
    const current = pressing === take
    if (current) sink = undefined
    if (!recorded || take <= ended || signal?.aborted) return
    await finishing?.finish(recorded, !current && sink === finishing)
  }

  async function end(owner?: Sink) {
    if (owner && sink && owner !== sink) return
    const cancelled = sink
    released = pressing
    ended = pressing
    sink = undefined
    clear()
    await onMic(async () => mic.release())
    if (sink !== cancelled) cancelled?.cancel?.()
  }

  const take = (owner?: Sink, signal?: AbortSignal) =>
    pressing > released && (!owner || owner === sink) && (!signal || signal === lifetime)
      ? pressing
      : undefined

  return {
    press,
    release,
    cancel,
    end,
    take,
    talking: (owner?: Sink, signal?: AbortSignal) => take(owner, signal) !== undefined,
    capturing: (owner?: Sink, signal?: AbortSignal) => {
      const current = active()
      return (
        !!current && (!owner || owner === current.sink) && (!signal || signal === current.signal)
      )
    },
    recording: mic.recording,
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
