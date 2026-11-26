import { AudioLines, Keyboard, X } from '@lucide/solid'
import { cn } from 'cn'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { capture, createTalk, talkMode } from '../dictation/ui.solid.tsx'
import { dock, voiceSink } from './dock.solid.tsx'
import { Waveform } from './turns.solid.tsx'

const touchLike = (event: PointerEvent) =>
  event.pointerType === 'touch' || event.pointerType === 'pen'
const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export function ModeSwitch(props: { talking: boolean; onToggle: (talking: boolean) => void }) {
  return (
    <Toggle
      aria-label={`Prompt box ${props.talking ? 'talks to voice' : 'types'} · switch`}
      class="group/voice-mode relative h-6 gap-0 rounded-full bg-muted/60 p-0.5 font-mono text-[10.5px] font-normal data-pressed:bg-muted/60 data-pressed:text-inherit"
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

export function TalkBar(props: { onTalk?: () => void }) {
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
        : 'Release to send · slide to ✕ to cancel'
      : busy()
        ? `${dock.status() ?? 'Thinking…'} · ${talkMode() === 'tap' ? 'tap' : 'hold'} to cut in`
        : talkMode() === 'tap'
          ? 'Tap to talk'
          : 'Hold to talk'
  return (
    <div class="flex items-center gap-2" data-voice-talk-bar ref={bar}>
      <Show when={recording()}>
        <Button
          aria-label="Cancel talking"
          class="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
          data-voice-talk-cancel
          onClick={() => capture.take(voiceSink)?.cancel()}
          size={null}
          variant={null}
        >
          <X class="size-5" />
        </Button>
      </Show>
      <Button
        aria-label={recording() ? 'Send what you said' : 'Talk to voice'}
        class={cn(
          'relative flex h-12 min-w-0 flex-1 touch-none items-center justify-center gap-2 overflow-hidden rounded-full border font-mono text-[12px] font-normal transition-colors select-none',
          recording()
            ? 'border-error/50 bg-error/10 text-error'
            : 'border-brand/40 bg-brand/10 text-brand active:bg-brand/20',
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
              <AudioLines class="size-4 shrink-0" />
              <span class="truncate">{label()}</span>
            </>
          }
        >
          <span class="size-2 shrink-0 animate-pulse-dot rounded-full bg-error" />
          <Waveform class="h-6 min-w-0 flex-1" live />
          <span class="shrink-0 pr-2 text-[11px]">{label()}</span>
        </Show>
      </Button>
    </div>
  )
}
