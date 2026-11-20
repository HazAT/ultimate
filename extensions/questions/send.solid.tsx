/** @jsxImportSource @solidjs/web */
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
  let gesture: { pointer: number; stop: AbortController; cancel?: Cancel } | undefined
  let interruption: Event | undefined
  let released = false
  const end = () => {
    gesture?.stop.abort()
    gesture?.cancel?.()
    gesture = undefined
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
  const status = () => (undo() ? 'Undo' : props.phase === 'sending' ? 'Sending…' : 'Sent')
  const inside = (event: PointerEvent & { currentTarget: HTMLElement }) => {
    const box = event.currentTarget.getBoundingClientRect()
    return (
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
    )
  }
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
        released = false
        if (
          interruption === event ||
          !event.isPrimary ||
          event.button !== 0 ||
          props.disabled ||
          (!answering() && !undo())
        )
          return
        event.currentTarget.setPointerCapture(event.pointerId)
        const pointer = event.pointerId
        const controller = new AbortController()
        window.addEventListener(
          'pointerdown',
          (other) => {
            if (other.pointerId !== pointer) {
              interruption = other
              stop()
            }
          },
          { capture: true, signal: controller.signal },
        )
        gesture = { pointer, stop: controller }
        if (undo()) return
        setHolding(true)
        const sendNow = props.onSendNow
        gesture.cancel = deadline(HOLD_TO_SEND_MS, () => {
          stop()
          sendNow()
        })
      }}
      onPointerMove={(event) => {
        if (gesture?.pointer === event.pointerId && !inside(event)) stop()
      }}
      onPointerUp={(event) => {
        released = gesture?.pointer === event.pointerId && inside(event)
        if (gesture?.pointer === event.pointerId) stop()
      }}
      onPointerCancel={(event) => {
        if (gesture?.pointer === event.pointerId) stop()
      }}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event, details) => {
        if (!released && event.detail !== 0 && details.source !== 'agent') return
        released = false
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
          <Show when={undo()}>
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
