import type { ConversationId } from '@earendil-works/pi-durable'
import { LoaderCircle, Mic, Square, X } from '@lucide/solid'
import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  api,
  errorMessage,
  events,
  ROOT,
  useAction,
  useEvent,
  useNow,
  writingAs,
} from '@/sdk/solid'
import type { Dictation } from '@/sdk/solid'
import { deadline } from '../../lib/timers.shared.ts'
import { base64, capture, unsupported } from './capture.web.ts'
import { startCue, stopCue } from '../../lib/cues.web.ts'
import type { Sink, Take } from './capture.web.ts'
import { StatusAction, TranscribeAction } from './refs.ts'
import { registerBox, soundCues, talkMode } from './routing.solid.tsx'
import { DictationSettings } from './settings.solid.tsx'
import { createTalk } from './talk.web.ts'

const buttonSize = 'size-6 rounded-md pointer-coarse:size-9'
const stopSize =
  'size-6 rounded-md pointer-coarse:size-9 pointer-fine:group-data-minimal/keel:size-5'
const keepEditorFocus = (event: PointerEvent) => event.preventDefault()

type DictationProps = NonNullable<typeof Dictation.input>

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function VoiceButton(props: DictationProps) {
  const id = () => props.conversation
  const status = useAction(StatusAction, null, { conversation: ROOT })
  useEvent('secrets:changed', () => void status.refetch())
  const unavailable = unsupported()
  const missingKey = () => {
    const data = status.data()
    return data?.available === false ? data.reason : undefined
  }
  const blocked = () => unavailable ?? (props.sink ? undefined : missingKey())
  const [transcribing, setTranscribing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const busy = () => transcribing() || (!props.sink && status.loading())
  let row!: HTMLDivElement
  let lifetime = new AbortController()
  let pending:
    | { conversation: ConversationId; insert: (text: string) => void; source: string }
    | undefined
  const defaultSink: Sink = {
    get signal() {
      return lifetime.signal
    },
    start() {
      pending = { conversation: id() ?? ROOT, insert: props.insert, source: 'app' }
      setError(undefined)
    },
    recording() {
      if (soundCues()) startCue()
    },
    cancel() {
      pending = undefined
    },
    error: setError,
    async finish({ blob }) {
      const take = pending
      pending = undefined
      if (soundCues()) stopCue()
      if (take && blob.size) await transcribe(take.conversation, blob, take.source, take.insert)
    },
  }
  const sink = () => props.sink ?? defaultSink
  const take = () => capture.take(sink())
  const recording = () => capture.capturing(sink())
  const started = createMemo(() => (recording() ? Date.now() : undefined))
  const now = useNow(250, recording)

  createEffect(
    () => [id(), sink()] as const,
    () => {
      if (lifetime.signal.aborted) lifetime = new AbortController()
      return () => {
        lifetime.abort()
        pending = undefined
      }
    },
  )
  createEffect(
    () => [recording(), props.level, sink()] as const,
    ([active, level, owner]) => {
      if (!active) return undefined
      level(0)
      const unsubscribe = capture.onLevel(() => {
        if (capture.capturing(owner)) level(capture.levels().at(-1) ?? 0)
      })
      return () => {
        unsubscribe()
        level(undefined)
      }
    },
  )
  createEffect(error, (message) =>
    message ? deadline(8000, () => setError(undefined)) : undefined,
  )

  async function transcribe(
    conversation: ConversationId,
    blob: Blob,
    source: string,
    insert: (text: string) => void,
  ) {
    setTranscribing(true)
    try {
      const args = { audio: await base64(blob), mimeType: blob.type }
      const { text } = await writingAs(source, () =>
        api.action(TranscribeAction, args, { conversationId: conversation }),
      )
      if (text) writingAs(source, () => insert(text))
      else setError('No speech heard')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setTranscribing(false)
    }
  }

  function ready() {
    if (busy() || pending) return false
    if (unavailable) setError(unavailable)
    else if (!props.sink && missingKey()) events.emit('secrets:open', { name: 'OPENAI_API_KEY' })
    else return true
    return false
  }

  onSettled(() => {
    const root = row.closest('[data-ui="prompt-box"]')
    if (!root) return undefined
    return registerBox({
      root,
      get sink() {
        return sink()
      },
      ready,
    })
  })

  function pressMic() {
    return !capture.talking() && ready() ? capture.press(sink()) : undefined
  }

  async function release(owner: Take | undefined, source: string) {
    if (!owner?.active()) return
    if (pending) pending.source = source
    await owner.release()
  }

  let pointer: number | undefined
  let pointerTake: Take | undefined
  const touch = createTalk({
    tap: () => talkMode() === 'tap',
    talking: () => pointerTake?.active() ?? false,
    press: async () => {
      pointerTake = pressMic()
      await pointerTake?.started
    },
    release: () => release(pointerTake, 'person'),
    cancel: async () => pointerTake?.cancel(),
    overCancel: (event) =>
      row.contains(
        document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest('[data-dictation-cancel]') ?? null,
      ),
  })
  const startTouch = (event: PointerEvent) => {
    keepEditorFocus(event)
    if (
      (event.pointerType !== 'touch' && event.pointerType !== 'pen') ||
      pointer !== undefined ||
      busy()
    )
      return
    pointer = event.pointerId
    row.setPointerCapture(pointer)
    touch.pointer.onPointerDown(event)
  }
  const stopTouch = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return
    pointer = undefined
    if (event.type === 'pointerup') touch.pointer.onPointerUp(event)
    else touch.pointer.onPointerCancel(event)
  }

  return (
    <div
      class="flex min-w-0 shrink items-center gap-1"
      onLostPointerCapture={stopTouch}
      onPointerCancel={stopTouch}
      onPointerUp={stopTouch}
      ref={row}
    >
      <Show
        when={recording()}
        fallback={
          <>
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
              <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
                transcribing…
              </span>
            </Show>
            <Button
              aria-label={`Dictate into ${props.name}${blocked() ? `: ${blocked()}` : ''}`}
              class={`${buttonSize} touch-none text-muted-foreground data-[voice=blocked]:opacity-50 data-[voice=blocked]:hover:bg-transparent data-[voice=blocked]:hover:text-muted-foreground`}
              data-voice={blocked() ? 'blocked' : transcribing() ? 'transcribing' : 'idle'}
              disabled={busy()}
              focusableWhenDisabled
              onClick={(event, details) => {
                if (
                  event instanceof PointerEvent &&
                  (event.pointerType === 'touch' || event.pointerType === 'pen')
                )
                  return undefined
                const owner = take()
                return owner ? release(owner, details.source) : pressMic()?.started
              }}
              onPointerDown={startTouch}
              size={null}
              title={
                blocked() ??
                (talkMode() === 'hold'
                  ? 'Voice input: click to toggle, or touch and hold'
                  : 'Voice input: click or tap to toggle')
              }
              variant="ghost"
            >
              <Show when={transcribing()} fallback={<Mic class="size-3.5" />}>
                <LoaderCircle class="size-3.5 motion-safe:animate-spin" />
              </Show>
            </Button>
            <DictationSettings name={props.name} />
          </>
        }
      >
        <>
          <Button
            aria-label={`Cancel dictation into ${props.name}`}
            class={`${buttonSize} text-muted-foreground`}
            data-dictation-cancel
            onClick={() => take()?.cancel()}
            onPointerDown={keepEditorFocus}
            size={null}
            title="Cancel"
            variant="ghost"
          >
            <X class="size-3.5" />
          </Button>
          <span class="flex h-6 items-center gap-1.5 rounded-md bg-error/10 px-2 font-mono text-[11px] text-error tabular-nums pointer-coarse:h-9 pointer-fine:group-data-minimal/keel:h-5">
            <span class="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />
            {clock(now() - (started() ?? now()))}
          </span>
          <Button
            aria-label={
              props.sink
                ? `Stop recording for ${props.name}`
                : `Stop and transcribe into ${props.name}`
            }
            class={`${stopSize} bg-error text-white hover:bg-error/90`}
            onClick={(_event, details) => release(take(), details.source)}
            onPointerDown={keepEditorFocus}
            size={null}
            title={props.sink ? 'Stop recording' : 'Stop and transcribe'}
            variant={null}
          >
            <Square class="size-2.5 fill-current" />
          </Button>
        </>
      </Show>
    </div>
  )
}
