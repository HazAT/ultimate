const recordingMimeOrder = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg']
export const MIN_SPOKEN_SECONDS = 0.6
const VOICED_LEVEL = 0.12
const MIN_VOICED_FRAMES = 6

export type Recorded = { blob: Blob; seconds: number; spoke: boolean; envelope: number[] }

export function unsupported() {
  if (!window.isSecureContext) return 'Voice needs HTTPS: open Ultimate over its tailnet URL'
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
    return 'This browser cannot record audio'
  return undefined
}

export async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

export function createMic(frame: (fn: () => void) => () => void) {
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

  async function start() {
    stream ??= await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
    audio ??= new AudioContext()
    if (audio.state === 'suspended') await audio.resume()
    if (!analyser) {
      analyser = audio.createAnalyser()
      analyser.fftSize = 1024
      audio.createMediaStreamSource(stream).connect(analyser)
    }
    const mimeType = recordingMimeOrder.find((type) => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    chunks = []
    levels.length = 0
    voiced = 0
    recorder.addEventListener('dataavailable', (event) => chunks.push(event.data))
    recorder.start()
    started = performance.now()
    const samples = new Float32Array(analyser.fftSize)
    stopFrames = frame(() => {
      analyser!.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      const level = Math.min(1, Math.pow(Math.sqrt(sum / samples.length) * 9, 0.8))
      levels.push(level)
      if (level > VOICED_LEVEL) voiced++
      for (const listener of listeners) listener()
    })
  }

  async function stop(): Promise<Recorded | undefined> {
    const active = recorder
    if (!active) return undefined
    recorder = undefined
    stopFrames?.()
    const stopped = new Promise<void>((resolve) =>
      active.addEventListener('stop', () => resolve(), { once: true }),
    )
    active.stop()
    await stopped
    if (matchMedia('(pointer: coarse)').matches) {
      stream?.getTracks().forEach((track) => track.stop())
      stream = undefined
      analyser = undefined
    }
    const seconds = (performance.now() - started) / 1000
    const type = (active.mimeType || 'audio/webm').split(';')[0]
    return {
      blob: new Blob(chunks, { type }),
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
    onLevel(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    release() {
      stopFrames?.()
      recorder?.stop()
      recorder = undefined
      stream?.getTracks().forEach((track) => track.stop())
      stream = undefined
      analyser = undefined
      const closing = audio
      audio = undefined
      return closing?.close()
    },
  }
}

export type Mic = ReturnType<typeof createMic>

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
