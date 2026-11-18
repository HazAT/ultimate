import { ROOT } from '@/sdk'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { MessageCircleQuestionIcon, Undo2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  api,
  cn,
  errorMessage,
  Provided,
  useConversation,
  useDocOf,
  useUiState,
  useViewport,
} from '@/sdk'
import { CardActions } from './points.tsx'
import type { Reply } from './refs.ts'
import type { Question } from '../messages/refs.ts'
import { MessagesDoc } from '../messages/ui.tsx'
import { keyCard, openQuestions, waitsOnUser } from './open.tsx'
import type { Message } from './open.tsx'
import { QuestionItem } from './question.tsx'
import { AnswerAction, DismissAction } from './refs.ts'
import type { Answer } from './refs.ts'
import {
  answered,
  answerOf,
  cardKey,
  cardOf,
  CARDS_KEY,
  choiceForKey,
  choices,
  keyOf,
} from './state.tsx'
import type { CardState, Draft } from './state.tsx'

const ANSWER_UNDO_WINDOW_MS = 3000
const HOLD_TO_SEND_MS = 1000
const REDUCED_MOTION_STEP_MS = 250
const CHECK_LANDING_BEFORE_ADVANCE_MS = 320

const fillOver = (durationMs: number) => (fill: HTMLSpanElement | null) => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  fill?.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
    duration: durationMs,
    easing: reduced ? `steps(${durationMs / REDUCED_MOTION_STEP_MS})` : 'linear',
    fill: 'both',
  })
}
const fillUndoWindow = fillOver(ANSWER_UNDO_WINDOW_MS)
const fillHold = fillOver(HOLD_TO_SEND_MS)

function useKeys(card: string) {
  const messages = useDocOf(ROOT, MessagesDoc)?.messages ?? []
  const conversation = useConversation((value) => value.id)
  return keyCard(conversation, messages) === card
}

function useDurableCard(card: string, questions: Question[]) {
  const [cards, setCards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const state = cardOf(cards, card, questions)
  const change = (edit: (old: CardState) => CardState) =>
    setCards((old) => ({ ...old, [card]: edit(cardOf(old, card, questions)) }))
  return [state, change] as const
}

export function MessageQuestions({
  message,
  keys,
  className,
  withActions = true,
  answerWith,
  sendLabel,
}: {
  message: Message
  keys?: boolean
  className?: string
  withActions?: boolean
  answerWith?: (answer: Reply, keepalive?: boolean) => Promise<unknown>
  sendLabel?: string
}) {
  const questions = openQuestions(message)
  const card = cardKey(message.id)
  const shown = useKeys(card)
  if (!waitsOnUser(message)) return null
  const answer = (reply: Reply, keepalive?: boolean) =>
    answerWith
      ? answerWith(reply, keepalive)
      : api.action(AnswerAction, { messageId: message.id, ...reply }, { keepalive })
  return (
    <Card
      card={card}
      questions={questions}
      keys={questions.length > 0 && (keys ?? shown)}
      submit={(answers, note, keepalive) =>
        answer({ answers, ...(note ? { note } : {}) }, keepalive)
      }
      reply={(text) => answer({ text })}
      actions={
        withActions ? (
          <Provided input={message} point={CardActions}>
            {(node) => node}
          </Provided>
        ) : null
      }
      {...(sendLabel === undefined ? {} : { sendLabel })}
      dismiss={() => api.action(DismissAction, { messageId: message.id })}
      {...(className === undefined ? {} : { className })}
    />
  )
}

function flushUndoWindowSend(
  undoWindowSend: {
    current?: { cancel: Cancel; fire: (keepalive?: boolean) => void }
  },
  keepalive = false,
) {
  const waiting = undoWindowSend.current
  if (!waiting) return
  waiting.cancel()
  waiting.fire(keepalive)
}

type Phase = 'answering' | 'undo' | 'sending' | 'sent'

const Key = ({ children, className }: { children: string; className?: string }) => (
  <Kbd className={cn('h-4 min-w-4 rounded-[3px] px-1 font-mono text-[10px]', className)}>
    {children}
  </Kbd>
)

function SendButton({
  phase,
  disabled,
  onSend,
  onSendNow,
  onUndo,
  children,
}: {
  phase: Phase
  disabled: boolean
  onSend: () => void
  onSendNow: () => void
  onUndo: () => void
  children: string
}) {
  const [holding, setHolding] = useState(false)
  const gesture = useRef<{ pointer: number; cancel: Cancel[] }>(undefined)
  const interruption = useRef<Event>(undefined)
  const sendNow = useRef(onSendNow)
  sendNow.current = onSendNow
  const endGesture = () => {
    for (const cancel of gesture.current?.cancel ?? []) cancel()
    gesture.current = undefined
    setHolding(false)
  }
  useEffect(() => endGesture, [phase])
  const pending = phase === 'undo'
  const activate = () => {
    if (pending) onUndo()
    else if (phase === 'answering') onSend()
  }
  const inside = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return (
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
    )
  }
  const ownGesture = (event: ReactPointerEvent) => gesture.current?.pointer === event.pointerId
  return (
    <Button
      size="sm"
      variant={phase === 'answering' ? 'default' : 'outline'}
      data-send={phase}
      disabled={disabled || phase === 'sending' || phase === 'sent'}
      title={
        pending
          ? 'Take your answer back; your picks and note stay'
          : 'Click to send with a moment to undo; hold (or ⇧↵) to send at once'
      }
      onPointerDown={(event) => {
        const interrupting = interruption.current === event.nativeEvent
        if (interrupting || !event.isPrimary || event.button !== 0) return
        if (phase !== 'answering' && !pending) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const pointer = event.pointerId
        const anotherContact = (other: PointerEvent) => {
          if (other.pointerId === pointer) return
          interruption.current = other
          endGesture()
        }
        window.addEventListener('pointerdown', anotherContact, true)
        gesture.current = {
          pointer,
          cancel: [() => window.removeEventListener('pointerdown', anotherContact, true)],
        }
        if (pending) return
        setHolding(true)
        gesture.current.cancel.push(
          deadline(HOLD_TO_SEND_MS, () => {
            endGesture()
            sendNow.current()
          }),
        )
      }}
      onPointerMove={(event) => {
        if (ownGesture(event) && !inside(event)) endGesture()
      }}
      onPointerUp={(event) => {
        if (!ownGesture(event)) return
        endGesture()
        if (inside(event)) activate()
      }}
      onPointerCancel={(event) => {
        if (ownGesture(event)) endGesture()
      }}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        const fromKeyboard = event.detail === 0
        if (fromKeyboard) activate()
      }}
      className={cn(
        'relative isolate touch-manipulation overflow-hidden select-none [-webkit-touch-callout:none] max-md:h-11 max-md:px-4',
        phase !== 'answering' &&
          'border-brand/50 bg-brand/10 text-foreground dark:border-brand/50 dark:bg-brand/10',
        phase === 'sent' && 'disabled:opacity-100',
      )}
    >
      {(holding || pending) && (
        <span
          key={phase}
          aria-hidden
          ref={pending ? fillUndoWindow : fillHold}
          data-fill
          className={cn(
            'absolute inset-0 -z-10 origin-left',
            pending ? 'bg-brand/25' : 'bg-primary-foreground/25',
          )}
        />
      )}
      <span className="grid">
        <span
          className={cn(
            'col-start-1 row-start-1 flex items-center justify-center gap-1.5',
            phase === 'answering' && 'invisible',
          )}
          aria-hidden={phase === 'answering'}
        >
          {pending && <Undo2Icon />}
          {pending ? 'Undo' : phase === 'sending' ? 'Sending…' : 'Sent'}
        </span>
        <span
          className={cn(
            'col-start-1 row-start-1 text-center',
            phase !== 'answering' && 'invisible',
          )}
          aria-hidden={phase !== 'answering'}
        >
          {children}
        </span>
      </span>
    </Button>
  )
}

function Progress({ done }: { done: boolean[] }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {done.map((value, index) => (
        <span
          key={index}
          className={cn(
            'h-1 rounded-full transition-[width,background-color] duration-300 ease-out',
            value ? 'w-3 bg-brand' : 'w-1.5 bg-muted-foreground/30',
          )}
        />
      ))}
    </span>
  )
}

function Note({
  value,
  disabled,
  hint,
  onChange,
  onSend,
}: {
  value: string
  disabled: boolean
  hint: boolean
  onChange: (value: string) => void
  onSend: () => void
}) {
  return (
    <div className="relative">
      <textarea
        data-note
        aria-label="A note to send with your answer"
        placeholder="Anything else? Sent with your answers, or on its own…"
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.stopPropagation()
            onSend()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        className="field-sizing-content max-h-40 min-h-9 w-full resize-none rounded-md border border-border/70 bg-background/40 px-2.5 py-2 pr-8 text-[13px] leading-snug transition-colors outline-none placeholder:text-muted-foreground/60 hover:border-border focus:border-brand/60 focus:bg-background disabled:opacity-60 max-md:min-h-11"
      />
      {hint && !value && (
        <Key className="pointer-events-none absolute top-2.5 right-2.5 bg-transparent text-muted-foreground/60">
          /
        </Key>
      )}
    </div>
  )
}

function Card({
  card,
  questions,
  keys,
  submit,
  reply,
  dismiss,
  actions,
  sendLabel,
  className = 'border-t border-border/60',
}: {
  card: string
  questions: Question[]
  keys: boolean
  submit: (answers: Answer[], note?: string, keepalive?: boolean) => Promise<unknown>
  reply: (text: string) => Promise<unknown>
  dismiss: () => Promise<unknown>
  actions: ReactNode
  sendLabel?: string
  className?: string
}) {
  const [state, setState] = useDurableCard(card, questions)
  const [lockedIn, setLockedIn] = useState<Pick<CardState, 'drafts' | 'note'>>()
  const { drafts, note } = lockedIn ?? state
  const { current, text } = state
  const root = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('answering')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const undoWindowSend = useRef<{
    cancel: Cancel
    fire: (keepalive?: boolean) => void
  }>(undefined)
  const cancelAdvanceAfterCheck = useRef<Cancel>(undefined)
  const committed = useRef(false)
  const flush = () => flushUndoWindowSend(undoWindowSend)
  const phone = useViewport() === 'phone'
  const hints = keys && !phone
  const words = questions.map((question, index) => answerOf(question, drafts[index]))
  const ready = answered(questions, drafts)
  const locked = phase !== 'answering'

  useEffect(() => {
    const flushWithKeepaliveOnPagehide = () => flushUndoWindowSend(undoWindowSend, true)
    window.addEventListener('pagehide', flushWithKeepaliveOnPagehide)
    return () => {
      window.removeEventListener('pagehide', flushWithKeepaliveOnPagehide)
      cancelAdvanceAfterCheck.current?.()
      flush()
    }
  }, [])

  const focusField = (index: number) =>
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLInputElement>(`[data-question="${index}"] input`)
        ?.focus({ preventScroll: true }),
    )
  const go = (index: number) => {
    cancelAdvanceAfterCheck.current?.()
    const next = Math.min(questions.length - 1, Math.max(0, index))
    setState((old) => ({ ...old, current: next }))
    if (questions[next]?.kind === 'text') focusField(next)
  }
  const draft = (index: number, change: (old: Draft) => Draft) =>
    setState((old) => ({
      ...old,
      drafts: { ...old.drafts, [index]: change(old.drafts[index] ?? { chosen: [] }) },
    }))
  const select = (index: number, option: number, click = false) => {
    const question = questions[index]
    const choice = question && choices(question)[option]
    if (!question || !choice) return
    setState((old) => ({ ...old, current: index }))
    if (question.kind === 'multi')
      return draft(index, (old) =>
        choice.custom
          ? { ...old, other: !old.other }
          : {
              ...old,
              chosen: old.chosen.includes(option)
                ? old.chosen.filter((i) => i !== option)
                : [...old.chosen, option].toSorted((a, b) => a - b),
            },
      )
    draft(index, (old) =>
      choice.custom
        ? { ...old, chosen: [], other: true }
        : { ...old, chosen: [option], other: false },
    )

    cancelAdvanceAfterCheck.current?.()
    if (click && !choice.custom && index < questions.length - 1)
      cancelAdvanceAfterCheck.current = deadline(CHECK_LANDING_BEFORE_ADVANCE_MS, () =>
        go(index + 1),
      )
  }

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const send = (immediately = false) => {
    const extra = note.trim()
    if ((!ready.length && !extra) || committed.current) return
    committed.current = true
    cancelAdvanceAfterCheck.current?.()
    setLockedIn({ drafts, note })
    const fire = (keepalive = false) => {
      undoWindowSend.current = undefined
      setPhase('sending')
      setError(undefined)
      submit(ready, extra || undefined, keepalive).then(
        () => setPhase('sent'),
        (failure: unknown) => {
          unlock()
          setError(errorMessage(failure))
        },
      )
    }
    if (immediately) return fire()
    undoWindowSend.current = { cancel: deadline(ANSWER_UNDO_WINDOW_MS, fire), fire }
    setPhase('undo')
  }
  const unlock = () => {
    committed.current = false
    setLockedIn(undefined)
    setPhase('answering')
  }
  const now = flush
  const undo = () => {
    if (!undoWindowSend.current) return
    undoWindowSend.current.cancel()
    undoWindowSend.current = undefined
    unlock()
  }

  const enter = () => {
    if (phase === 'undo') return now()
    if (phase !== 'answering') return
    if (current < questions.length - 1 && ready.length < questions.length) return go(current + 1)
    send()
  }
  const clear = () => {
    cancelAdvanceAfterCheck.current?.()
    setState((old) => ({ ...old, drafts: { ...old.drafts, [current]: { chosen: [] } } }))
  }
  const focusNote = () =>
    root.current?.querySelector<HTMLTextAreaElement>('textarea[data-note]')?.focus()
  const fieldKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) send(true)
      else enter()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.currentTarget.blur()
      go(current + (event.key === 'ArrowDown' ? 1 : -1))
    }
  }

  useEffect(() => {
    if (!keys || phone || phase === 'sending' || phase === 'sent') return undefined
    const outsideControlOwnsKeys = (target: HTMLElement | null) =>
      !root.current?.contains(target) && target?.closest('[data-questions-card], button, a')
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented ||
        root.current?.closest('[data-receded]') ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        outsideControlOwnsKeys(target)
      )
        return
      if (phase === 'undo') {
        if (event.key === 'Escape' || event.key === 'u') {
          event.preventDefault()
          undo()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          now()
        }
        return
      }
      const question = questions[current]
      const choice =
        question && /^[1-9a-z]$/.test(event.key) ? choiceForKey(question, event.key) : undefined
      if (choice !== undefined) {
        event.preventDefault()
        select(current, choice)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        go(current + (event.key === 'ArrowDown' ? 1 : -1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (event.shiftKey) send(true)
        else enter()
      } else if (event.key === 'Escape' && words[current]) {
        event.preventDefault()
        clear()
      } else if (event.key === '/') {
        event.preventDefault()
        focusNote()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  if (!questions.length)
    return (
      <form
        className={cn(className, 'flex flex-wrap items-center gap-2 px-3 py-2.5')}
        data-questions-card={card}
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim()) void run(() => reply(text.trim()))
        }}
      >
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-brand" />
        <input
          aria-label="Your answer"
          placeholder="Your answer…"
          value={text}
          disabled={busy}
          onChange={(event) => setState((old) => ({ ...old, text: event.target.value }))}
          className="min-h-8 min-w-0 flex-1 basis-40 rounded-md border border-border bg-background px-2.5 py-1 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-brand/60 max-md:min-h-11"
        />
        {actions}
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => void run(dismiss)}
          title="Close it without an answer; the agent gets a note"
        >
          Dismiss
        </Button>
        <Button size="sm" type="submit" disabled={!text.trim() || busy}>
          {busy ? 'Sending…' : (sendLabel ?? 'Send')}
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </form>
    )

  const last = questions.length - 1

  const shown = questions[current]
  const shownKeys = shown ? [0, 1].flatMap((i) => keyOf(shown, i) ?? []) : []
  const unanswered = questions.length - ready.length
  return (
    <div className={className} data-questions-card={card} ref={root}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 font-mono text-[11px] text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5 text-brand" />
        <span className="text-foreground">
          {questions.length === 1 ? '1 question' : `${questions.length} questions`}
        </span>
        {questions.length > 1 && (
          <span className="ml-auto flex items-center gap-2">
            <span>
              {ready.length}/{questions.length}
            </span>
            <Progress done={words.map(Boolean)} />
          </span>
        )}
      </div>
      <div className="space-y-0.5 px-1.5">
        {questions.map((question, index) => (
          <div key={index} data-question={index}>
            <QuestionItem
              question={question}
              index={index}
              draft={drafts[index]}
              current={index === current}
              disabled={busy || locked}
              hints={hints}
              onOpen={() => go(index)}
              onSelect={(option) => select(index, option, true)}
              onText={(value) => draft(index, (old) => ({ ...old, text: value }))}
              onFieldKey={fieldKey}
            />
          </div>
        ))}
      </div>
      <div className="px-3 pt-2">
        <Note
          value={note}
          disabled={busy || locked}
          hint={hints}
          onChange={(value) => setState((old) => ({ ...old, note: value }))}
          onSend={() => send()}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
        {hints && phase === 'undo' && (
          <span className="flex items-center gap-x-2.5 font-mono text-[10px] text-muted-foreground/80 max-md:hidden">
            <span className="flex items-center gap-1">
              <Key>esc</Key> undo
            </span>
            <span className="flex items-center gap-1">
              <Key>↵</Key> send now
            </span>
          </span>
        )}
        {hints && !locked && (
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-muted-foreground/80 max-md:hidden">
            {shownKeys.length > 0 && (
              <span className="flex items-center gap-1">
                {shownKeys.map((key) => (
                  <Key key={key}>{key}</Key>
                ))}{' '}
                choose
              </span>
            )}
            {questions.length > 1 && (
              <span className="flex items-center gap-1">
                <Key>↑</Key>
                <Key>↓</Key> move
              </span>
            )}
            <span className="flex items-center gap-1">
              <Key>↵</Key>
              {current < last && unanswered ? 'next' : 'send'}
            </span>
            {words[current] && (
              <span className="flex items-center gap-1">
                <Key>esc</Key> clear
              </span>
            )}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {actions}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || locked}
            onClick={() => void run(dismiss)}
            title="Close it without an answer; the agent gets a note"
            className="max-md:h-11"
          >
            Dismiss
          </Button>
          <SendButton
            phase={phase}
            disabled={(!locked && !ready.length && !note.trim()) || busy}
            onSend={() => send()}
            onSendNow={() => send(true)}
            onUndo={undo}
          >
            {sendLabel ??
              (!ready.length && note.trim()
                ? 'Send note'
                : unanswered && ready.length
                  ? `Send ${ready.length} of ${questions.length}`
                  : 'Send')}
          </SendButton>
        </span>
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
