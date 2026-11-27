import { inProcess, meansNone } from '../../lib/errors.shared.ts'
import { deadline } from '../../lib/timers.shared.ts'
import type { Cancel } from '../../lib/timers.shared.ts'

export const MAX_RECORDING_MS = 30 * 60_000
const videoMimeOrder = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]

export type Draft = number | string | undefined
export type Box = { draft: Draft; attach: (files: readonly File[]) => Promise<boolean> }
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

const failureText = (failure: unknown) =>
  `Could not record the screen: ${failure instanceof Error ? failure.message : String(failure)}`

const declined = (failure: unknown) =>
  failure instanceof DOMException && failure.name === 'NotAllowedError'

const stamp = (at: number) => {
  const date = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`
}

export function createScreenRecorder(media: Media) {
  let state: Phase = { phase: 'idle' }
  const listeners = new Set<() => void>()
  const boxes = new Set<Box>()
  const waiting = new Map<Draft, { file: File; release: () => void }[]>()
  let end: ((keep: boolean, into?: Box) => void) | undefined

  const set = (next: Phase) => {
    state = next
    for (const listener of listeners) listener()
  }

  function offer(draft: Draft) {
    const files = waiting.get(draft)
    if (!files?.length) return
    const box = [...boxes].findLast((candidate) => candidate.draft === draft)
    if (!box) return
    waiting.delete(draft)
    inProcess(
      'a recording lives in this page until its box takes it; the reload hold keeps the page',
      box.attach(files.map((held) => held.file)).then(
        (taken) => {
          if (taken) for (const held of files) held.release()
          else {
            waiting.set(draft, [...files, ...(waiting.get(draft) ?? [])])
            const next = [...boxes].findLast((candidate) => candidate.draft === draft)
            if (next && next !== box) offer(draft)
          }
        },
        () => {
          for (const held of files) held.release()
        },
      ),
    )
  }

  function keepFor(draft: Draft, file: File, release: () => void) {
    waiting.set(draft, [...(waiting.get(draft) ?? []), { file, release }])
    offer(draft)
  }

  async function start(box: Box) {
    if (state.phase !== 'idle') return
    const draft = box.draft
    set({ phase: 'asking' })
    const owned: MediaStreamTrack[] = []
    let context: AudioContext | undefined
    let release: (() => void) | undefined
    const teardown = () => {
      for (const track of owned) track.stop()
      void context?.close().catch(meansNone)
    }
    let shareEnded = false
    try {
      const screen = await media.display()
      owned.push(...screen.getTracks())
      const video = screen.getVideoTracks()
      for (const track of video)
        track.addEventListener('ended', () => (end ? end(true) : (shareEnded = true)), {
          once: true,
        })
      const mic = await media.mic().catch(meansNone)
      if (mic) owned.push(...mic.getTracks())
      if (shareEnded || video.every((track) => track.readyState === 'ended')) {
        teardown()
        set({ phase: 'idle' })
        return
      }
      const sources = [screen, mic].filter(
        (stream): stream is MediaStream => !!stream?.getAudioTracks().length,
      )
      const audio: MediaStreamTrack[] = []
      if (sources.length) {
        context = new AudioContext()
        const destination = context.createMediaStreamDestination()
        for (const stream of sources)
          context
            .createMediaStreamSource(new MediaStream(stream.getAudioTracks()))
            .connect(destination)
        audio.push(...destination.stream.getAudioTracks())
        owned.push(...audio)
      }
      const type = videoMimeOrder.find((candidate) => MediaRecorder.isTypeSupported(candidate))
      const recorder = new MediaRecorder(new MediaStream([...video, ...audio]), {
        ...(type ? { mimeType: type } : {}),
        videoBitsPerSecond: 2_500_000,
      })
      const started = media.now()
      const chunks: Blob[] = []
      let keep = true
      let into = draft
      let stopLimit: Cancel | undefined
      recorder.addEventListener('dataavailable', ({ data }) => {
        if (data.size) chunks.push(data)
      })
      release = media.hold()
      const held = release
      recorder.addEventListener(
        'stop',
        () => {
          stopLimit?.()
          teardown()
          end = undefined
          set({ phase: 'idle' })
          if (!keep || !chunks.length) return held()
          const mimeType = (recorder.mimeType || type || 'video/webm').split(';')[0]
          const extension = mimeType === 'video/mp4' ? 'mp4' : 'webm'
          const file = new File(chunks, `Screen recording ${stamp(started)}.${extension}`, {
            type: mimeType,
          })
          keepFor(into, file, held)
        },
        { once: true },
      )
      recorder.start(1000)
      const stop = (keeping: boolean, stoppedFrom?: Box) => {
        if (recorder.state === 'inactive') return
        keep = keeping
        if (stoppedFrom) into = stoppedFrom.draft
        recorder.stop()
      }
      end = stop
      stopLimit = deadline(MAX_RECORDING_MS, () => stop(true))
      set({ phase: 'recording', started, mic: !!mic })
    } catch (failure) {
      teardown()
      release?.()
      end = undefined
      set({ phase: 'idle', ...(declined(failure) ? {} : { error: failureText(failure) }) })
    }
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
      boxes.add(box)
      offer(box.draft)
      return () => {
        boxes.delete(box)
      }
    },
    start,
    stop: (into?: Box) => end?.(true, into),
    cancel: () => end?.(false),
    dismiss: () => {
      if (state.phase === 'idle' && state.error) set({ phase: 'idle' })
    },
  }
}

export type ScreenRecorder = ReturnType<typeof createScreenRecorder>
