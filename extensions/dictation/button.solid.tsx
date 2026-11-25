import type { ConversationId } from '@earendil-works/pi-durable'
import { LoaderCircle, Mic, Square, X } from '@lucide/solid'
import { createEffect, createSignal, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
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
import { deadline } from '../../lib/timers.ts'
import { base64, capture, unsupported } from './capture.ts'
import type { Sink } from './capture.ts'
import { StatusAction, TranscribeAction } from './refs.ts'

const buttonSize = 'size-7 rounded-md pointer-coarse:size-9'
const stopSize =
  'size-6 rounded-md pointer-coarse:size-9 pointer-fine:group-data-minimal/keel:size-5'
const keepEditorFocus = (event: PointerEvent) => event.preventDefault()

type DictationProps = NonNullable<typeof Dictation.input>

type Recording = { started: number; stop(source: string): void }

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
  const blocked = () => unavailable ?? missingKey()
  const [recording, setRecording] = createSignal<Recording>()
  const [transcribing, setTranscribing] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const now = useNow(250, () => !!recording())
  let pending: { sink: Sink; lifetime: AbortController } | undefined

  function cancelCapture() {
    const take = pending
    pending = undefined
    setRecording(undefined)
    if (take) {
      take.lifetime.abort()
      void capture.cancel(take.sink)
    }
  }
  createEffect(id, () => cancelCapture)
  createEffect(
    () => [recording(), props.level] as const,
    ([active, level]) => {
      if (!active) return undefined
      const sink = pending?.sink
      level(0)
      const unsubscribe = capture.onLevel(() => {
        if (sink && capture.capturing(sink)) level(capture.levels().at(-1) ?? 0)
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

  function start() {
    if (pending || capture.talking()) return undefined
    const conversation = id() ?? ROOT
    const insert = props.insert
    const lifetime = new AbortController()
    let source = 'app'
    const clear = () => {
      pending = undefined
      setRecording(undefined)
    }
    const sink: Sink = {
      start() {
        pending = { sink, lifetime }
        setError(undefined)
      },
      recording: () => {
        setRecording({
          started: Date.now(),
          stop(requestedBy) {
            if (!capture.talking(sink)) return
            source = requestedBy
            void capture.release(sink)
          },
        })
      },
      cancel() {
        if (pending?.sink === sink) clear()
      },
      error: setError,
      async finish({ blob }) {
        if (pending?.sink !== sink) return
        clear()
        if (blob.size) await transcribe(conversation, blob, source, insert)
      },
    }
    return capture.press(sink, lifetime.signal)
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
                  aria-label={`Dictate into ${props.name}${blocked() ? `: ${blocked()}` : ''}`}
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
              <Show when={transcribing()} fallback={<Mic class="size-3.5" />}>
                <LoaderCircle class="size-3.5 motion-safe:animate-spin" />
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
            aria-label={`Cancel dictation into ${props.name}`}
            class={`${buttonSize} text-muted-foreground`}
            onClick={cancelCapture}
            onPointerDown={keepEditorFocus}
            size={null}
            title="Cancel"
            variant="ghost"
          >
            <X class="size-3.5" />
          </Button>
          <span class="flex h-6 items-center gap-1.5 rounded-md bg-error/10 px-2 font-mono text-[11px] text-error tabular-nums pointer-coarse:h-9 pointer-fine:group-data-minimal/keel:h-5">
            <span class="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />
            {clock(now() - active().started)}
          </span>
          <Button
            aria-label={`Stop and transcribe into ${props.name}`}
            class={`${stopSize} bg-error text-white hover:bg-error/90`}
            onClick={(_event, details) => active().stop(details.source)}
            onPointerDown={keepEditorFocus}
            size={null}
            title="Stop and transcribe"
            variant={null}
          >
            <Square class="size-2.5 fill-current" />
          </Button>
        </div>
      )}
    </Show>
  )
}
