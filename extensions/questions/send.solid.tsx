import { Undo2 } from '@lucide/solid'
import { createEffect, createSignal, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { cn } from '@/sdk/solid'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'

export const ANSWER_UNDO_WINDOW_MS = 3000
const HOLD_TO_SEND_MS = 1000
const REDUCED_MOTION_STEP_MS = 250

export type Phase = 'answering' | 'undo' | 'sending' | 'sent'

function Fill(props: { duration: number; class: string }) {
  let fill!: HTMLSpanElement
  onSettled(() => {
    const duration = props.duration
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const animation = fill.animate?.([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration,
      easing: reduced ? `steps(${duration / REDUCED_MOTION_STEP_MS})` : 'linear',
      fill: 'both',
    })
    return () => animation?.cancel()
  })
  return (
    <span
      ref={fill}
      aria-hidden="true"
      data-fill
      class={cn('absolute inset-0 -z-10 origin-left', props.class)}
    />
  )
}

export function SendButton(props: {
  messageId: number
  phase: Phase
  disabled: boolean
  label: string
  onSend: (source: string) => void
  onSendNow: () => void
  onUndo: () => void
}) {
  const [holding, setHolding] = createSignal(false)
  let hold: { stop: AbortController; cancel: Cancel } | undefined
  let heldClick = false
  let interruption: Event | undefined
  const end = () => {
    hold?.stop.abort()
    hold?.cancel()
    hold = undefined
  }
  const stop = () => {
    end()
    setHolding(false)
  }
  createEffect(
    () => props.phase,
    () => {
      stop()
      return end
    },
  )
  const answering = () => props.phase === 'answering'
  const undo = () => props.phase === 'undo'
  const settling = () => answering() || undo()
  const status = () => (settling() ? 'Undo' : props.phase === 'sending' ? 'Sending…' : 'Sent')
  return (
    <Button
      size="sm"
      variant={answering() ? 'default' : 'outline'}
      data-send={props.phase}
      aria-label={`${answering() ? props.label : status()}: answer to message ${props.messageId}`}
      disabled={props.disabled || (!answering() && !undo())}
      title={
        undo()
          ? 'Take your answer back; your picks and note stay'
          : 'Click to send with a moment to undo; hold (or ⇧↵) to send at once'
      }
      onPointerDown={(event) => {
        heldClick = false
        if (event === interruption) return
        if (!event.isPrimary || event.button !== 0 || props.disabled || !answering()) return
        const pointer = event.pointerId
        const controller = new AbortController()
        window.addEventListener(
          'pointerdown',
          (other) => {
            if (other.pointerId === pointer) return
            interruption = other
            stop()
          },
          { capture: true, signal: controller.signal },
        )
        setHolding(true)
        const sendNow = props.onSendNow
        hold = {
          stop: controller,
          cancel: deadline(HOLD_TO_SEND_MS, () => {
            stop()
            heldClick = true
            sendNow()
          }),
        }
      }}
      onPointerMove={(event) => {
        if (!hold) return
        const box = event.currentTarget.getBoundingClientRect()
        const { clientX: x, clientY: y } = event
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) stop()
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event, details) => {
        if (heldClick && event.detail !== 0) {
          heldClick = false
          return
        }
        if (undo()) props.onUndo()
        else if (answering()) props.onSend(details.source)
      }}
      class={cn(
        'relative isolate touch-manipulation overflow-hidden select-none [-webkit-touch-callout:none] max-md:h-11 max-md:px-4',
        !answering() &&
          'border-brand/50 bg-brand/10 text-foreground dark:border-brand/50 dark:bg-brand/10',
        props.phase === 'sent' && 'disabled:opacity-100',
      )}
    >
      <Show when={holding()}>
        <Fill duration={HOLD_TO_SEND_MS} class="bg-primary-foreground/25" />
      </Show>
      <Show when={undo()}>
        <Fill duration={ANSWER_UNDO_WINDOW_MS} class="bg-brand/25" />
      </Show>
      <span class="grid">
        <span
          class={cn(
            'col-start-1 row-start-1 flex items-center justify-center gap-1.5',
            answering() && 'invisible',
          )}
          aria-hidden={answering() ? 'true' : 'false'}
        >
          <Show when={settling()}>
            <Undo2 />
          </Show>
          {status()}
        </span>
        <span
          class={cn('col-start-1 row-start-1 text-center', !answering() && 'invisible')}
          aria-hidden={answering() ? 'false' : 'true'}
        >
          {props.label}
        </span>
      </span>
    </Button>
  )
}
