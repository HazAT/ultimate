import { AudioLines, Keyboard, X } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { capture, createTalk, talkMode } from '../dictation/ui.solid.tsx'
import { dock, playerState, voiceSink } from './dock.solid.tsx'
import { Waveform } from './turns.solid.tsx'

const touchLike = (event: PointerEvent) =>
  event.pointerType === 'touch' || event.pointerType === 'pen'
const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export function ModeSwitch(props: { talking: boolean; onToggle: (talking: boolean) => void }) {
  return (
    <Toggle
      aria-label={`Prompt box ${props.talking ? 'talks to voice' : 'types'} · switch`}
      class="group/voice-mode relative h-5 gap-0 rounded-full bg-muted/60 p-0.5 font-mono text-[10.5px] font-normal data-pressed:bg-muted/60 data-pressed:text-inherit"
      data-ui="voice-mode-switch"
      onPressedChange={(pressed) => props.onToggle(pressed)}
      pressed={props.talking}
      size={null}
      variant={null}
    >
      <span
        aria-hidden="true"
        class="absolute top-0.5 bottom-0.5 left-0.5 w-16 rounded-full bg-background shadow-xs transition-transform duration-300 group-data-pressed/voice-mode:translate-x-16 group-data-pressed/voice-mode:ring-1 group-data-pressed/voice-mode:ring-brand/40 motion-reduce:transition-none"
        style={{ 'transition-timing-function': ease }}
      />
      <span
        class={cn(
          'relative z-10 flex w-16 items-center justify-center gap-1 transition-colors',
          props.talking ? 'text-muted-foreground/70' : 'text-foreground',
        )}
      >
        <Keyboard class="size-3" />
        Type
      </span>
      <span
        class={cn(
          'relative z-10 flex w-16 items-center justify-center gap-1 transition-colors',
          props.talking ? 'text-brand' : 'text-muted-foreground/70',
        )}
      >
        <AudioLines class="size-3" />
        Talk
      </span>
    </Toggle>
  )
}

export function TalkBar(props: { onTalk?: () => void; settings?: JSX.Element }) {
  const recording = () => capture.capturing(voiceSink)
  const busy = () => dock.phase() === 'sending' || dock.phase() === 'thinking'
  let bar!: HTMLDivElement
  const talk = createTalk({
    tap: () => talkMode() === 'tap',
    talking: () => capture.talking(voiceSink),
    press: async () => {
      props.onTalk?.()
      await capture.press(voiceSink)?.started
    },
    release: async () => capture.take(voiceSink)?.release(),
    cancel: async () => capture.take(voiceSink)?.cancel(),
    overCancel: (event) =>
      !!document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-voice-talk-cancel]'),
  })
  const label = () =>
    recording()
      ? talkMode() === 'tap'
        ? 'Tap to send'
        : 'Release to send'
      : busy() || playerState().playing
        ? `${talkMode() === 'tap' ? 'tap' : 'hold'} to cut in`
        : talkMode() === 'tap'
          ? 'Tap to talk'
          : 'Hold to talk'
  const status = () =>
    playerState().playing
      ? 'Speaking'
      : playerState().paused
        ? 'Paused'
        : busy()
          ? (dock.status() ?? 'Thinking…')
          : undefined
  return (
    <div
      class={cn(
        'relative flex h-12 items-center gap-1 overflow-hidden rounded-lg border bg-card pr-1.5 transition-colors',
        recording()
          ? 'border-error/40 bg-error/5'
          : 'border-border focus-within:border-foreground/25',
      )}
      data-voice-talk-bar
      ref={bar}
    >
      <Show when={recording()}>
        <Button
          aria-label="Cancel talking"
          class="ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          data-voice-talk-cancel
          onClick={() => capture.take(voiceSink)?.cancel()}
          size={null}
          variant={null}
        >
          <X class="size-4" />
        </Button>
      </Show>
      <Button
        aria-label={recording() ? 'Send what you said' : 'Talk to voice'}
        class={cn(
          'flex h-full min-w-0 flex-1 touch-none items-center justify-start gap-2 font-mono text-[12px] font-normal select-none',
          recording() ? 'pr-2 text-error' : 'px-3 text-muted-foreground active:bg-accent/40',
        )}
        data-voice-talk
        onClick={(event) => {
          if (event instanceof PointerEvent && touchLike(event)) return undefined
          const owner = capture.take(voiceSink)
          if (owner) return owner.release()
          props.onTalk?.()
          return capture.press(voiceSink)?.started
        }}
        onPointerCancel={(event) => talk.pointer.onPointerCancel(event)}
        onPointerDown={(event) => {
          if (!touchLike(event)) return
          bar.setPointerCapture(event.pointerId)
          talk.pointer.onPointerDown(event)
        }}
        onPointerUp={(event) => talk.pointer.onPointerUp(event)}
        size={null}
        variant={null}
      >
        <Show
          when={recording()}
          fallback={
            <>
              <AudioLines class="size-4 shrink-0 text-brand" />
              <Show when={status()} fallback={<span class="truncate">{label()}</span>}>
                {(text) => <span class="truncate text-brand">{text()}</span>}
              </Show>
            </>
          }
        >
          <Waveform class="h-5 min-w-0 flex-1" live />
          <span class="shrink-0 text-[11px]">{label()}</span>
        </Show>
      </Button>
      <Show when={!recording()}>
        {props.settings}
        <ModeSwitch onToggle={dock.setTalking} talking />
      </Show>
    </div>
  )
}
