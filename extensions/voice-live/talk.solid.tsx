import { AudioLines, Keyboard, X } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { capture, createTalk, talkMode } from '../dictation/ui.solid.tsx'
import type { Take } from '../dictation/ui.solid.tsx'
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
  let held: { finger: number; take: Take } | undefined
  const talk = createTalk({
    tap: () => talkMode() === 'tap',
    talking: () => held?.take.active() ?? false,
    press: async () => {
      const take = capture.press(voiceSink)
      if (!take) return
      held = { finger: pressing, take }
      props.onTalk?.()
      await take.started
    },
    release: async () => held?.take.release(),
    cancel: async () => held?.take.cancel(),
    overCancel: (event) =>
      !!document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-voice-talk-cancel]'),
  })
  let pressing = -1
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
  const status = () => {
    if (dock.error()) return dock.error()
    if (playerState().playing) return 'Speaking'
    if (playerState().paused) return 'Paused'
    if (busy()) return dock.status() ?? 'Thinking…'
    const said = dock.status()
    return said && dock.phase() !== 'done' && dock.phase() !== 'speaking' ? said : undefined
  }
  const failed = () => !!dock.error() || dock.phase() === 'error'
  return (
    <div
      class={cn(
        'relative flex h-12 items-center gap-1 overflow-hidden rounded-lg border bg-card pr-1.5 transition-colors',
        recording()
          ? 'border-error/40 bg-error/5'
          : 'border-border focus-within:border-foreground/25',
      )}
      data-voice-talk-bar
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
          if (held?.take.active()) return held.take.release()
          const take = capture.press(voiceSink)
          if (!take) return undefined
          held = { finger: -1, take }
          props.onTalk?.()
          return take.started
        }}
        onPointerDown={(event) => {
          if (!touchLike(event) || held?.take.active()) return
          pressing = event.pointerId
          talk.pointer.onPointerDown(event)
          const mine = held?.finger === pressing ? held : undefined
          if (!mine) return
          const end = (next: PointerEvent) => {
            if (next.pointerId !== mine.finger) return
            window.removeEventListener('pointerup', end)
            window.removeEventListener('pointercancel', end)
            if (held !== mine) return
            if (next.type === 'pointerup') talk.pointer.onPointerUp(next)
            else talk.pointer.onPointerCancel(next)
          }
          window.addEventListener('pointerup', end)
          window.addEventListener('pointercancel', end)
        }}
        size={null}
        variant={null}
      >
        <Show
          when={recording()}
          fallback={
            <>
              <AudioLines class="size-4 shrink-0 text-brand" />
              <Show when={status()} fallback={<span class="truncate">{label()}</span>}>
                {(text) => (
                  <span class={cn('truncate', failed() ? 'text-error' : 'text-brand')}>
                    {text()}
                  </span>
                )}
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
