import { LoaderCircle, ScreenShare, Square, X } from '@lucide/solid'
import { createEffect, createRoot, createSignal, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { holdEscape, holdReload, useEnabled, useNow } from '@/sdk/solid'
import type { PromptRecorder } from '@/sdk/solid'
import { deadline } from '../../lib/timers.shared.ts'
import { browserMedia, createScreenRecorder, screenSupported } from './capture.web.ts'
import type { Box, Phase, ScreenRecorder } from './capture.web.ts'

type RecorderProps = NonNullable<typeof PromptRecorder.input>

const buttonSize = 'size-7 rounded-md'
const stopSize = 'size-6 rounded-md group-data-minimal/keel:size-5'
const keepEditorFocus = (event: PointerEvent) => event.preventDefault()
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function recordButton(recorder: ScreenRecorder, supported: () => boolean) {
  const phase = createRoot(() => {
    const [current, setCurrent] = createSignal<Phase>(recorder.state())
    recorder.subscribe(() => setCurrent(recorder.state()))
    createEffect(
      () => current().phase === 'recording',
      (recording) => (recording ? holdEscape(recorder.cancel) : undefined),
    )
    return current
  })

  return function RecordButton(props: RecorderProps) {
    const box: Box = {
      get draft() {
        return props.draft
      },
      attach: (files) => props.attach(files),
    }
    onSettled(() => recorder.mount(box))
    const name = () => props.name
    const videos = useEnabled('video')
    const recording = () => phase().phase === 'recording'
    const now = useNow(500, recording)
    createEffect(recording, (on) => {
      const mark = props.recording
      mark(on)
      return () => mark(false)
    })
    createEffect(phase, (current) =>
      current.phase === 'idle' && current.error ? deadline(8000, recorder.dismiss) : undefined,
    )

    return (
      <Show when={supported()}>
        <Show
          when={
            phase().phase === 'recording'
              ? (phase() as Extract<Phase, { phase: 'recording' }>)
              : undefined
          }
          fallback={
            <div class="flex min-w-0 shrink items-center gap-1.5">
              <Show when={phase().phase === 'idle' && (phase() as { error?: string }).error}>
                {(error) => (
                  <span
                    class="line-clamp-2 min-w-0 font-mono text-[11px] leading-tight text-error"
                    role="alert"
                    title={error()}
                  >
                    {error()}
                  </span>
                )}
              </Show>
              <Tooltip type="description">
                <TooltipTrigger
                  render={(trigger) => (
                    <Button
                      {...trigger}
                      aria-label={`Record the screen into ${name()}`}
                      class={`${buttonSize} text-muted-foreground`}
                      data-screen-recorder={phase().phase}
                      disabled={phase().phase === 'asking'}
                      onClick={() => recorder.start(box)}
                      onPointerDown={keepEditorFocus}
                      size={null}
                      variant="ghost"
                    />
                  )}
                >
                  <Show
                    when={phase().phase === 'asking'}
                    fallback={<ScreenShare class="size-3.5" />}
                  >
                    <LoaderCircle class="size-3.5 motion-safe:animate-spin" />
                  </Show>
                </TooltipTrigger>
                <TooltipContent>
                  Record your screen and mic as a video for this prompt.
                  <Show when={videos()}>
                    {' '}
                    Videos are sent to Google (Gemini API) when an agent asks about them.
                  </Show>
                </TooltipContent>
              </Tooltip>
            </div>
          }
        >
          {(active) => (
            <div class="flex shrink-0 items-center gap-1" data-screen-recorder="recording">
              <Button
                aria-label={`Cancel the screen recording in ${name()}`}
                class={`${buttonSize} text-muted-foreground`}
                onClick={() => recorder.cancel()}
                onPointerDown={keepEditorFocus}
                size={null}
                title="Discard the recording · Esc"
                variant="ghost"
              >
                <X class="size-3.5" />
              </Button>
              <span
                class="flex h-6 items-center gap-1.5 rounded-md bg-error/10 px-2 font-mono text-[11px] text-error tabular-nums group-data-minimal/keel:h-5"
                title={active().mic ? 'Recording screen and mic' : 'Recording screen, no mic'}
              >
                <span class="size-1.5 rounded-full bg-error motion-safe:animate-pulse" />
                {active().mic ? 'screen + mic' : 'screen'} {clock(now() - active().started)}
              </span>
              <Button
                aria-label={`Stop and attach the screen recording to ${name()}`}
                class={`${stopSize} bg-error text-white hover:bg-error/90`}
                onClick={() => recorder.stop(box)}
                onPointerDown={keepEditorFocus}
                size={null}
                title="Stop and attach"
                variant={null}
              >
                <Square class="size-2.5 fill-current" />
              </Button>
            </div>
          )}
        </Show>
      </Show>
    )
  }
}

export const RecordButton = recordButton(
  createScreenRecorder(browserMedia(holdReload)),
  () => screenSupported() && !matchMedia('(pointer: coarse)').matches,
)
