import type { ConversationId } from '@earendil-works/pi-durable'
import { LoaderCircle, Mic, Square, X } from '@lucide/solid'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  api,
  errorMessage,
  events,
  insertIntoComposer,
  useAction,
  useConversationId,
  useEvent,
  useNow,
  writingAs,
} from '@/sdk/solid'
import { meansNone } from '../../lib/errors.ts'
import { deadline } from '../../lib/timers.ts'
import { StatusAction, TranscribeAction } from './refs.ts'

const recordingMimeOrder = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
const barShapes = [0.55, 1, 0.8, 0.45]
const buttonSize = 'size-7 rounded-lg pointer-coarse:size-9'
const keepEditorFocus = (event: PointerEvent) => event.preventDefault()

type Recording = {
  stream: MediaStream
  audio?: AudioContext
  started: number
  stop: (source?: string) => void
}

function blockedMicrophone(reason: string) {
  const android = /Android/.test(navigator.userAgent)
  if (reason === 'Permission denied by system')
    return android
      ? 'Android blocks the mic for Chrome: allow it in Settings → Apps → Chrome → Permissions'
      : 'The system blocks the mic for this browser: allow it in the system’s privacy settings'
  if (android)
    return 'Mic blocked for this site: allow it in Chrome → Settings → Site settings → Microphone'
  return 'Microphone access is blocked: allow it in the browser’s site settings'
}

function unsupported() {
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

function Level(props: { recording: Recording }) {
  const bars: { element: HTMLSpanElement; shape: number }[] = []
  createEffect(
    () => props.recording,
    ({ audio, stream }) => {
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
        for (const { element, shape } of bars)
          element.style.transform = `scaleY(${0.2 + 0.8 * level * shape})`
        frame = requestAnimationFrame(draw)
      })
      return () => {
        cancelAnimationFrame(frame)
        source.disconnect()
      }
    },
  )
  return (
    <span aria-hidden="true" class="flex h-3.5 items-center gap-[2px] motion-reduce:hidden">
      <For each={barShapes}>
        {(shape) => (
          <span
            ref={(element) => void bars.push({ element, shape })}
            class="h-full w-[2px] origin-center scale-y-[0.2] rounded-full bg-error"
          />
        )}
      </For>
    </span>
  )
}

export function VoiceButton() {
  const id = useConversationId()
  const status = useAction(StatusAction)
  useEvent('secrets:changed', () => void status.refetch())
  const unavailable = unsupported()
  const missingKey = () => {
    const data = status.data()
    return data?.available === false ? data.reason : undefined
  }
  const blocked = () => unavailable ?? missingKey()
  const [recording, setRecording] = createSignal<Recording>()
  const [transcribing, setTranscribing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const now = useNow(250, () => !!recording())
  let capture: AbortController | undefined

  function cancelCapture() {
    capture?.abort()
    capture = undefined
  }
  createEffect(id, () => {
    setRecording(undefined)
    return cancelCapture
  })
  createEffect(recording, (active) => active && deadline(5 * 60_000, () => active.stop()))
  createEffect(error, (message) =>
    message ? deadline(8000, () => setError(undefined)) : undefined,
  )

  async function transcribe(conversation: ConversationId, blob: Blob, source: string) {
    setTranscribing(true)
    try {
      const args = { audio: await base64(blob), mimeType: blob.type }
      const { text } = await writingAs(source, () =>
        api.action(TranscribeAction, args, { conversationId: conversation }),
      )
      if (text) writingAs(source, () => insertIntoComposer(conversation, text))
      else setError('No speech heard')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setTranscribing(false)
    }
  }

  async function start() {
    const conversation = id()
    capture = new AbortController()
    const { signal } = capture
    setError(undefined)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      const releaseStream = () => {
        for (const track of stream.getTracks()) track.stop()
      }
      if (signal.aborted) return releaseStream()
      signal.addEventListener('abort', releaseStream, { once: true })

      const type = recordingMimeOrder.find((candidate) => MediaRecorder.isTypeSupported(candidate))
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      const audio = typeof AudioContext === 'undefined' ? undefined : new AudioContext()
      const chunks: Blob[] = []
      let source = 'app'
      const stop = (requestedBy = 'app') => {
        if (recorder.state === 'inactive') return
        source = requestedBy
        recorder.stop()
      }
      const collect = ({ data }: BlobEvent) => {
        if (data.size) chunks.push(data)
      }
      const finish = () => {
        cancelCapture()
        setRecording(undefined)
        if (conversation !== undefined && chunks.length) {
          const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' })
          void transcribe(conversation, blob, source)
        }
      }
      signal.addEventListener(
        'abort',
        () => {
          stop()
          audio?.close().catch(meansNone)
        },
        { once: true },
      )
      recorder.addEventListener('dataavailable', collect, { signal })
      recorder.addEventListener('stop', finish, { signal, once: true })
      audio?.resume().catch(meansNone)
      recorder.start(1000)
      setRecording({ stream, audio, started: Date.now(), stop })
    } catch (failure) {
      if (signal.aborted) return
      cancelCapture()
      const { name, message } =
        failure instanceof DOMException ? failure : { name: '', message: '' }
      setError(
        name === 'NotAllowedError'
          ? blockedMicrophone(message)
          : name === 'NotFoundError'
            ? 'No microphone found'
            : `Could not start recording: ${errorMessage(failure)}`,
      )
    }
  }

  function pressMic() {
    if (unavailable) setError(unavailable)
    else if (missingKey()) events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
    else return start()
    return undefined
  }

  return (
    <Show
      when={recording()}
      fallback={
        <div class="flex min-w-0 shrink items-center gap-1.5">
          {error() && (
            <span
              class="line-clamp-3 min-w-0 font-mono text-[11px] leading-tight text-error"
              role="alert"
              title={error()}
            >
              {error()}
            </span>
          )}
          <Show when={transcribing()}>
            <span class="shrink-0 font-mono text-[11px] text-muted-foreground">transcribing…</span>
          </Show>
          <Tooltip type="description">
            <TooltipTrigger
              render={(trigger) => (
                <Button
                  {...trigger}
                  aria-label={blocked() ?? 'Voice input'}
                  class={`${buttonSize} text-muted-foreground data-[voice=blocked]:opacity-50 data-[voice=blocked]:hover:bg-transparent data-[voice=blocked]:hover:text-muted-foreground`}
                  data-voice={blocked() ? 'blocked' : transcribing() ? 'transcribing' : 'idle'}
                  disabled={status.loading() || transcribing()}
                  focusableWhenDisabled
                  onClick={pressMic}
                  onPointerDown={keepEditorFocus}
                  size={null}
                  variant="ghost"
                />
              )}
            >
              <Show when={transcribing()} fallback={<Mic class="size-4" />}>
                <LoaderCircle class="size-4 motion-safe:animate-spin" />
              </Show>
            </TooltipTrigger>
            <TooltipContent>
              {blocked() ?? 'Voice input: tap to record, tap again to transcribe'}
            </TooltipContent>
          </Tooltip>
        </div>
      }
    >
      {(active) => (
        <div class="flex shrink-0 items-center gap-1">
          <Button
            aria-label="Cancel recording"
            class={`${buttonSize} text-muted-foreground`}
            onClick={() => {
              cancelCapture()
              setRecording(undefined)
            }}
            onPointerDown={keepEditorFocus}
            size={null}
            title="Cancel"
            variant="ghost"
          >
            <X class="size-4" />
          </Button>
          <span class="flex h-7 items-center gap-1.5 rounded-lg bg-error/10 px-2 font-mono text-[11.5px] text-error tabular-nums pointer-coarse:h-9">
            <span class="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />
            {clock(now() - active().started)}
            <Level recording={active()} />
          </span>
          <Button
            aria-label="Stop and transcribe"
            class={`${buttonSize} bg-error text-white hover:bg-error/90`}
            onClick={(_event, details) => active().stop(details.source)}
            onPointerDown={keepEditorFocus}
            size={null}
            title="Stop and transcribe"
            variant={null}
          >
            <Square class="size-3 fill-current" />
          </Button>
        </div>
      )}
    </Show>
  )
}
