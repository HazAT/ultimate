import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { meansNone } from '../../lib/errors.ts'

export const MAX_RECORDING_MS = 30 * 60_000
const videoMimeOrder = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]

export type Box = { attach: (files: readonly File[]) => void }
export type Phase =
  | { phase: 'idle'; error?: string }
  | { phase: 'asking' }
  | { phase: 'recording'; started: number; mic: boolean }

export type Media = {
  display: () => Promise<MediaStream>
  mic: () => Promise<MediaStream>
  hold: () => () => void
  now: () => number
}

export const browserMedia = (hold: () => () => void): Media => ({
  display: () => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true }),
  mic: () =>
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    }),
  hold,
  now: Date.now,
})

export const screenSupported = () =>
  window.isSecureContext &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
  typeof MediaRecorder !== 'undefined'

function captureFailure(failure: unknown) {
  if (failure instanceof DOMException && failure.name === 'NotAllowedError') return undefined
  return `Could not record the screen: ${failure instanceof Error ? failure.message : String(failure)}`
}

const stamp = (at: number) => {
  const date = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`
}

function mixed(streams: MediaStream[]) {
  const audio = streams.filter((stream) => stream.getAudioTracks().length)
  if (!audio.length) return { tracks: [], close: () => undefined }
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  for (const stream of audio)
    context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(destination)
  return {
    tracks: destination.stream.getAudioTracks(),
    close: () => void context.close().catch(meansNone),
  }
}

export function createScreenRecorder(media: Media) {
  let state: Phase = { phase: 'idle' }
  const listeners = new Set<() => void>()
  const boxes: Box[] = []
  let starter: Box | undefined
  let held: File | undefined
  let end: ((keep: boolean, into?: Box) => void) | undefined

  const set = (next: Phase) => {
    state = next
    for (const listener of listeners) listener()
  }

  function deliver(file: File, into: Box | undefined) {
    const target =
      into && boxes.includes(into)
        ? into
        : starter && boxes.includes(starter)
          ? starter
          : boxes.at(-1)
    if (target) target.attach([file])
    else held = file
  }

  async function start(box: Box) {
    if (state.phase !== 'idle') return
    starter = box
    set({ phase: 'asking' })
    let screen: MediaStream
    try {
      screen = await media.display()
    } catch (failure) {
      set({ phase: 'idle', error: captureFailure(failure) })
      return
    }
    const mic = await media.mic().catch(meansNone)
    const audio = mixed(mic ? [screen, mic] : [screen])
    const stream = new MediaStream([...screen.getVideoTracks(), ...audio.tracks])
    const type = videoMimeOrder.find((candidate) => MediaRecorder.isTypeSupported(candidate))
    const recorder = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      videoBitsPerSecond: 2_500_000,
    })
    const started = media.now()
    const chunks: Blob[] = []
    const release = media.hold()
    let keep = true
    let into: Box | undefined
    let stopLimit: Cancel | undefined
    recorder.addEventListener('dataavailable', ({ data }) => {
      if (data.size) chunks.push(data)
    })
    recorder.addEventListener(
      'stop',
      () => {
        stopLimit?.()
        for (const track of [...screen.getTracks(), ...(mic?.getTracks() ?? [])]) track.stop()
        audio.close()
        end = undefined
        release()
        set({ phase: 'idle' })
        if (!keep || !chunks.length) return
        const mimeType = (recorder.mimeType || type || 'video/webm').split(';')[0]
        const extension = mimeType === 'video/mp4' ? 'mp4' : 'webm'
        deliver(
          new File(chunks, `Screen recording ${stamp(started)}.${extension}`, { type: mimeType }),
          into,
        )
      },
      { once: true },
    )
    end = (keeping, stoppedFrom) => {
      if (recorder.state === 'inactive') return
      keep = keeping
      into = stoppedFrom
      recorder.stop()
    }
    for (const track of screen.getVideoTracks())
      track.addEventListener('ended', () => end?.(true), { once: true })
    recorder.start(1000)
    stopLimit = deadline(MAX_RECORDING_MS, () => end?.(true))
    set({ phase: 'recording', started, mic: !!mic })
  }

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    mount(box: Box) {
      boxes.push(box)
      const waiting = held
      held = undefined
      if (waiting) box.attach([waiting])
      return () => {
        boxes.splice(boxes.indexOf(box), 1)
      }
    },
    mounted: () => boxes.length,
    start,
    stop: (into?: Box) => end?.(true, into),
    cancel: () => end?.(false),
    dismiss: () => {
      if (state.phase === 'idle' && state.error) set({ phase: 'idle' })
    },
  }
}

export type ScreenRecorder = ReturnType<typeof createScreenRecorder>
