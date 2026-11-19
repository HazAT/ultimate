import { deadline } from '../../lib/timers.ts'
import { ArrowUpIcon, LoaderCircleIcon, MicIcon, SquareIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  formatKeys,
  getConversation,
  insertIntoComposer,
  useAction,
  useConversation,
  useEvent,
  useNow,
} from '@/sdk'
import type { UltimateContext } from '@/sdk'
import { meansNone } from '../../lib/errors.ts'
import { StatusAction, TranscribeAction } from './refs.ts'

const uploadSafeRecordingMs = 5 * 60_000

const recordingMimeOrder = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']

const toggleShortcut = 'mod+alt+v'
const toggleShortcutHint = formatKeys(toggleShortcut)[0].join('')

type VoiceControls = { toggle: () => void; cancel: () => void; recording: boolean }
const controlsByConversation = new Map<number, VoiceControls>()

export function registerVoice(id: number, controls: VoiceControls): () => void {
  controlsByConversation.set(id, controls)
  return () => void controlsByConversation.delete(id)
}

function composerOffersVoice(context: UltimateContext) {
  if (unsupported()) return false
  const id = context.conversationId
  return id !== undefined && controlsByConversation.has(id)
}

function toggleVoice(context: UltimateContext) {
  const id = context.conversationId
  if (id !== undefined) controlsByConversation.get(id)?.toggle()
}

function escapeCancelsRecording(context: UltimateContext) {
  const id = context.conversationId
  if (id === undefined || getConversation(id).busy) return false
  return controlsByConversation.get(id)?.recording ?? false
}

function cancelVoice(context: UltimateContext) {
  const id = context.conversationId
  if (id !== undefined) controlsByConversation.get(id)?.cancel()
}

type Recording = {
  recorder: MediaRecorder
  stream: MediaStream
  audio?: AudioContext
  started: number
  chunks: Blob[]
  cancelled: boolean
  send: boolean
}

export async function handleTranscription(
  transcribe: () => Promise<{ text: string }>,
  send: boolean,
  effects: { insert: (text: string) => void; submit: () => void; error: (message: string) => void },
) {
  try {
    const { text } = await transcribe()
    if (!text) return effects.error('No speech heard')
    effects.insert(text)
    if (send) effects.submit()
  } catch (failure) {
    effects.error(errorMessage(failure))
  }
}

export function entersSend(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>,
  targetConversation: string | undefined,
  id: number,
  recording: boolean,
): boolean {
  if (!recording || event.key !== 'Enter' || event.isComposing) return false
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
  return targetConversation === String(id)
}

function unsupported(): string | undefined {
  if (!window.isSecureContext) return 'Voice needs HTTPS: open Ultimate over its tailnet URL'
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
    return 'This browser cannot record audio'
  return undefined
}

async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

function submitComposerAfterRender(id: number) {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLTextAreaElement>(`textarea[data-conversation="${id}"]`)
      ?.closest('form')
      ?.requestSubmit()
  })
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function Level({ audio, stream }: { audio?: AudioContext; stream: MediaStream }) {
  const bars = useRef<HTMLSpanElement[]>([])
  useEffect(() => {
    if (!audio) return undefined
    const analyser = audio.createAnalyser()
    analyser.fftSize = 256
    const source = audio.createMediaStreamSource(stream)
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    let frame = requestAnimationFrame(function draw() {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
      bars.current.forEach((bar, index) => {
        const shape = [0.55, 1, 0.8, 0.45][index] ?? 1
        bar.style.transform = `scaleY(${0.2 + 0.8 * level * shape})`
      })
      frame = requestAnimationFrame(draw)
    })
    return () => {
      cancelAnimationFrame(frame)
      source.disconnect()
    }
  }, [audio, stream])
  return (
    <span aria-hidden className="flex h-3.5 items-center gap-[2px] motion-reduce:hidden">
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          ref={(element) => {
            if (element) bars.current[index] = element
          }}
          className="h-full w-[2px] origin-center scale-y-[0.2] rounded-full bg-error"
        />
      ))}
    </span>
  )
}

function VoiceButton() {
  const { id } = useConversation()
  const status = useAction(StatusAction)
  useEvent('secrets:changed', () => void status.refetch())
  const [recording, setRecording] = useState<Recording>()
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string>()
  const now = useNow(250, recording !== undefined)
  const composerRecording = useRef<Recording>(undefined)
  composerRecording.current = recording

  useEffect(() => () => finish(composerRecording.current, true), [id])
  useEffect(() => {
    if (recording && now - recording.started >= uploadSafeRecordingMs) finish(recording, false)
  }, [now, recording])
  useEffect(() => {
    if (!error) return undefined
    return deadline(8000, () => setError(undefined))
  }, [error])

  function finish(active: Recording | undefined, cancel: boolean, send = false) {
    if (!active) return
    active.cancelled = cancel
    active.send = send
    if (active.recorder.state !== 'inactive') active.recorder.stop()
    setRecording(undefined)
  }
  const latestFinish = useRef(finish)
  latestFinish.current = finish

  async function transcribe(audio: Blob, send: boolean) {
    if (id === undefined) return
    setTranscribing(true)
    try {
      await handleTranscription(
        async () =>
          api.action(TranscribeAction, { audio: await base64(audio), mimeType: audio.type }),
        send,
        {
          insert: (text) => insertIntoComposer(id, text),
          submit: () => submitComposerAfterRender(id),
          error: setError,
        },
      )
    } finally {
      setTranscribing(false)
    }
  }

  async function start() {
    setError(undefined)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (failure) {
      const name = failure instanceof DOMException ? failure.name : ''
      setError(
        name === 'NotAllowedError'
          ? 'Microphone access is blocked: allow it in the browser’s site settings'
          : name === 'NotFoundError'
            ? 'No microphone found'
            : `Could not start recording: ${errorMessage(failure)}`,
      )
      return
    }
    const type = recordingMimeOrder.find((candidate) => MediaRecorder.isTypeSupported(candidate))
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const audio = typeof AudioContext === 'undefined' ? undefined : new AudioContext()
    const active: Recording = {
      recorder,
      stream,
      audio,
      started: Date.now(),
      chunks: [],
      cancelled: false,
      send: false,
    }
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) active.chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      for (const track of stream.getTracks()) track.stop()
      audio?.close().catch(meansNone)
      if (active.cancelled || active.chunks.length === 0) return
      void transcribe(
        new Blob(active.chunks, { type: recorder.mimeType || type || 'audio/webm' }),
        active.send,
      )
    })
    audio?.resume().catch(meansNone)
    recorder.start(1000)
    setRecording(active)
  }

  const blocked =
    unsupported() ?? (status.data?.available === false ? status.data.reason : undefined)
  const missingKey = !unsupported() && status.data?.available === false

  const keepEditorFocus = (event: React.PointerEvent) => event.preventDefault()

  function toggle() {
    if (transcribing || status.loading) return
    if (recording) return finish(recording, false)
    if (missingKey) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
    if (blocked) return setError(blocked)
    void start()
  }
  const latestToggle = useRef(toggle)
  latestToggle.current = toggle

  useEffect(() => {
    if (id === undefined) return undefined
    return registerVoice(id, {
      toggle: () => latestToggle.current(),
      cancel: () => finish(composerRecording.current, true),
      get recording() {
        return !!composerRecording.current
      },
    })
  }, [id])

  useEffect(() => {
    if (id === undefined) return undefined
    const conversationId = id
    function captureEnterToSend(event: KeyboardEvent) {
      const target = event.target
      const conversation =
        target instanceof HTMLTextAreaElement ? target.dataset.conversation : undefined
      if (!entersSend(event, conversation, conversationId, !!composerRecording.current)) return
      event.preventDefault()
      event.stopPropagation()
      latestFinish.current(composerRecording.current, false, true)
    }
    window.addEventListener('keydown', captureEnterToSend, true)
    return () => window.removeEventListener('keydown', captureEnterToSend, true)
  }, [id])

  if (recording)
    return (
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Recording">
        <button
          aria-label="Cancel recording"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9"
          onClick={() => finish(recording, true)}
          onPointerDown={keepEditorFocus}
          title="Cancel"
          type="button"
        >
          <XIcon className="size-4" />
        </button>
        <span className="flex h-7 items-center gap-1.5 rounded-lg bg-error/10 px-2 font-mono text-[11.5px] text-error tabular-nums pointer-coarse:h-9">
          <span className="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />
          {clock(now - recording.started)}
          <Level audio={recording.audio} stream={recording.stream} />
        </span>
        <button
          aria-label="Stop and transcribe"
          className="flex size-7 items-center justify-center rounded-lg bg-error text-white hover:bg-error/90 pointer-coarse:size-9"
          onClick={() => finish(recording, false)}
          onPointerDown={keepEditorFocus}
          title="Stop and transcribe"
          type="button"
        >
          <SquareIcon className="size-3 fill-current" />
        </button>
        <button
          aria-label="Send"
          className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 pointer-coarse:size-9"
          onClick={() => finish(recording, false, true)}
          onPointerDown={keepEditorFocus}
          title="Send (Enter)"
          type="button"
        >
          <ArrowUpIcon className="size-4" />
        </button>
      </div>
    )

  return (
    <div className="flex min-w-0 shrink items-center gap-1.5">
      {error && (
        <span
          className="min-w-0 truncate font-mono text-[11px] text-error"
          role="alert"
          title={error}
        >
          {error}
        </span>
      )}
      {transcribing && (
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">transcribing…</span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-disabled={!!blocked || transcribing || status.loading}
            aria-label={blocked ?? 'Voice input'}
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
              (blocked || transcribing) &&
                'opacity-50 hover:bg-transparent hover:text-muted-foreground',
            )}
            data-voice={blocked ? 'blocked' : transcribing ? 'transcribing' : 'idle'}
            onClick={toggle}
            onPointerDown={keepEditorFocus}
            type="button"
          >
            {transcribing ? (
              <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
            ) : (
              <MicIcon className="size-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {blocked ?? `Voice input: tap to record, tap again to transcribe · ${toggleShortcutHint}`}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export default defineWebExtension({
  slots: { 'composer.actions': [VoiceButton] },
  commands: [
    {
      id: 'voice.toggle',
      title: 'Voice input: start / stop recording',
      keys: toggleShortcut,
      whileTyping: true,
      when: (context) => composerOffersVoice(context),
      run: (context) => toggleVoice(context),
    },
    {
      id: 'voice.cancel',
      title: 'Voice input: cancel recording',
      keys: 'escape',
      whileTyping: true,
      when: (context) => escapeCancelsRecording(context),
      run: (context) => cancelVoice(context),
    },
  ],
})
