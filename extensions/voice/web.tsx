import { LoaderCircleIcon, MicIcon, SquareIcon, XIcon } from 'lucide-react'
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
import { StatusAction, TranscribeAction } from './refs.ts'

/** Recordings stop on their own here: well under the 8 MB the server takes at any browser's bitrate. */
const MAX_MS = 5 * 60_000
/** In order of preference; iOS Safari records only `audio/mp4`. */
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
/**
 * No default binding claims `mod+shift+v` in Chrome or Safari on macOS or Windows: it is a letter chord, so the
 * browser's "paste as plain text" (itself a page feature some rich editors add for Ctrl/Cmd+Shift+V, not a browser
 * interception) never comes up, since the composer is a plain `<textarea>` with nothing to strip.
 */
const KEYS = 'mod+shift+v'
const keyHint = formatKeys(KEYS)[0].join('')

/**
 * Every mounted button's controls, by the conversation it records into: the shortcut drives the same recorder the
 * tap does (never a second one), reached by the conversation its command ran in (the focused composer's, or the
 * shown conversation's from the palette). `registerVoice` registers one on mount and withdraws it on unmount; tests
 * use it directly to drive the commands without mounting the button.
 */
type VoiceControls = { toggle: () => void; cancel: () => void; recording: boolean }
const buttons = new Map<number, VoiceControls>()

export function registerVoice(id: number, controls: VoiceControls): () => void {
  buttons.set(id, controls)
  return () => void buttons.delete(id)
}

/** Hidden when no composer offers voice here: an unsupported browser, or no mounted button for this conversation. A missing key stays visible, like the dimmed button: invoking it opens the Secrets row. */
function unavailable(context: UltimateContext) {
  if (unsupported()) return true
  const id = context.conversationId
  return id === undefined || !buttons.has(id)
}

function toggleVoice(context: UltimateContext) {
  const id = context.conversationId
  if (id !== undefined) buttons.get(id)?.toggle()
}

/**
 * Escape cancels a live recording, but only while the conversation is idle: `agent.stop` already owns Escape to stop
 * a busy run, and the two `when`s never both hold, so they never compete for the same keypress.
 */
function cancellable(context: UltimateContext) {
  const id = context.conversationId
  if (id === undefined || getConversation(id).busy) return false
  return buttons.get(id)?.recording ?? false
}

function cancelVoice(context: UltimateContext) {
  const id = context.conversationId
  if (id !== undefined) buttons.get(id)?.cancel()
}

type Recording = {
  recorder: MediaRecorder
  stream: MediaStream
  audio?: AudioContext
  started: number
  chunks: Blob[]
  cancelled: boolean
}

/** Why this browser cannot record at all, or undefined when it can. */
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

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Four bars that follow the microphone's level; still under reduced motion, where the dot stays solid instead. */
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

/** Tap to record, tap to stop (or `mod+shift+v`); the words land in the draft at the cursor, unsent, for review. */
function VoiceButton() {
  const { id } = useConversation()
  const status = useAction(StatusAction)
  useEvent('secrets:changed', () => void status.refetch())
  const [recording, setRecording] = useState<Recording>()
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string>()
  const now = useNow(250, recording !== undefined)
  const current = useRef<Recording>(undefined)
  current.current = recording

  // A recording never outlives its composer: leaving the conversation drops it and frees the microphone.
  useEffect(() => () => finish(current.current, true), [id])
  useEffect(() => {
    if (recording && now - recording.started >= MAX_MS) finish(recording, false)
  }, [now, recording])
  useEffect(() => {
    if (!error) return undefined
    const timer = setTimeout(() => setError(undefined), 8000)
    return () => clearTimeout(timer)
  }, [error])

  function finish(active: Recording | undefined, cancel: boolean) {
    if (!active) return
    active.cancelled = cancel
    if (active.recorder.state !== 'inactive') active.recorder.stop()
    setRecording(undefined)
  }

  async function transcribe(audio: Blob) {
    if (id === undefined) return
    setTranscribing(true)
    try {
      const { text } = await api.action(TranscribeAction, {
        audio: await base64(audio),
        mimeType: audio.type,
      })
      if (text) insertIntoComposer(id, text)
      else setError('No speech heard')
    } catch (failure) {
      setError(errorMessage(failure))
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
    const type = TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate))
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const audio = typeof AudioContext === 'undefined' ? undefined : new AudioContext()
    const active: Recording = {
      recorder,
      stream,
      audio,
      started: Date.now(),
      chunks: [],
      cancelled: false,
    }
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) active.chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      for (const track of stream.getTracks()) track.stop()
      // Closing only frees the meter's audio graph; a failure leaves nothing to clean up.
      audio?.close().catch(() => undefined)
      if (active.cancelled || active.chunks.length === 0) return
      // oxlint-disable-next-line typescript/no-floating-promises -- transcribe shows its own failures beside the button.
      void transcribe(new Blob(active.chunks, { type: recorder.mimeType || type || 'audio/webm' }))
    })
    // Created after awaiting the permission prompt, it may start suspended (Safari): the meter would read silence.
    audio?.resume().catch(() => undefined)
    recorder.start(1000)
    setRecording(active)
  }

  const blocked =
    unsupported() ?? (status.data?.available === false ? status.data.reason : undefined)
  const missingKey = !unsupported() && status.data?.available === false
  // Keeps the editor's focus, so a phone's keyboard neither opens nor closes under the tap.
  const keepFocus = (event: React.PointerEvent) => event.preventDefault()

  // Tap and the shortcut share this: start if idle, stop (and transcribe) if recording. A missing key opens its row
  // in Secrets, as the tap does; a blocked browser shows why, beside the button.
  function toggle() {
    if (transcribing || status.loading) return
    if (recording) return finish(recording, false)
    if (missingKey) return events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
    if (blocked) return setError(blocked)
    // oxlint-disable-next-line typescript/no-floating-promises -- start shows its own failures beside the button.
    void start()
  }
  // A ref holds the latest toggle (it closes over this render's state); the map entry stays the same object across
  // renders, so registering it costs one Map write per mount, not one per render.
  const latestToggle = useRef(toggle)
  latestToggle.current = toggle

  // Registers for the shortcut and the palette command; withdrawn on unmount or a conversation switch.
  useEffect(() => {
    if (id === undefined) return undefined
    return registerVoice(id, {
      toggle: () => latestToggle.current(),
      cancel: () => finish(current.current, true),
      get recording() {
        return !!current.current
      },
    })
  }, [id])

  if (recording)
    return (
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Recording">
        <button
          aria-label="Cancel recording"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9"
          onClick={() => finish(recording, true)}
          onPointerDown={keepFocus}
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
          onPointerDown={keepFocus}
          title="Stop and transcribe"
          type="button"
        >
          <SquareIcon className="size-3 fill-current" />
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
            // On a phone there is no tooltip: the tap says why, as toggle() does for every trigger.
            onClick={toggle}
            onPointerDown={keepFocus}
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
          {blocked ?? `Voice input: tap to record, tap again to transcribe · ${keyHint}`}
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
      keys: KEYS,
      whileTyping: true,
      when: (context) => !unavailable(context),
      run: (context) => toggleVoice(context),
    },
    {
      id: 'voice.cancel',
      title: 'Voice input: cancel recording',
      keys: 'escape',
      whileTyping: true,
      when: (context) => cancellable(context),
      run: (context) => cancelVoice(context),
    },
  ],
})
