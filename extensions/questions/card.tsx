import { ROOT } from '@/sdk'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { CornerDownRightIcon, MessageCircleQuestionIcon, Undo2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { api, cn, errorMessage, useConversation, useDocOf, useUiState, useViewport } from '@/sdk'
import type { Question } from '../messages/refs.ts'
import { MessagesDoc } from '../messages/ui.tsx'
import { keyCard, openQuestions, waitsOnUser } from './open.tsx'
import type { Message } from './open.tsx'
import { brief, QuestionItem } from './question.tsx'
import { AnswerAction, DismissAction } from './refs.ts'
import type { Answer } from './refs.ts'
import {
  answered,
  answerOf,
  cardOf,
  CARDS_KEY,
  choiceForKey,
  choices,
  keyOf,
  pickDraft,
  pickIndices,
} from './state.tsx'
import type { CardState, Draft } from './state.tsx'

const ANSWER_UNDO_WINDOW_MS = 3000
const CHECK_LANDING_BEFORE_ADVANCE_MS = 320

const animateUndoDeadline = (bar: HTMLDivElement | null) => {
  bar?.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
    duration: ANSWER_UNDO_WINDOW_MS,
    easing: 'linear',
    fill: 'both',
  })
}

function useKeys(card: string) {
  const messages = useDocOf(ROOT, MessagesDoc)?.messages ?? []
  const conversation = useConversation((value) => value.id)
  return keyCard(conversation, messages) === card
}

function useDurableCard(card: string) {
  const [cards, setCards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const state = cardOf(cards, card)
  const change = (edit: (old: CardState) => CardState) =>
    setCards((old) => ({ ...old, [card]: edit(cardOf(old, card)) }))
  return [state, change] as const
}

export function MessageQuestions({
  message,
  keys,
  className,
}: {
  message: Message
  keys?: boolean
  className?: string
}) {
  const questions = openQuestions(message)
  const card = `message:${message.id}`
  const shown = useKeys(card)
  if (!waitsOnUser(message)) return null
  return (
    <Card
      card={card}
      questions={questions}
      keys={questions.length > 0 && (keys ?? shown)}
      submit={(answers, note, keepalive) =>
        api.action(
          AnswerAction,
          { messageId: message.id, answers, ...(note ? { note } : {}) },
          { keepalive },
        )
      }
      reply={(text) => api.action(AnswerAction, { messageId: message.id, text })}
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

function Summary({
  questions,
  drafts,
  note,
}: {
  questions: Question[]
  drafts: Record<number, Draft>
  note: string
}) {
  const widestAnswerTagChars = Math.max(
    ...questions.map((question, index) => brief(question, index, drafts[index]).tag.length),
    note.trim() ? 4 : 0,
  )
  const alignedAnswerTagStyle = { minWidth: `${Math.max(3, widestAnswerTagChars)}ch` }
  return (
    <ul className="mt-1.5 space-y-0.5 pl-5.5 text-[13px] leading-relaxed">
      {questions.map((question, index) => {
        const answer = brief(question, index, drafts[index])
        return (
          <li
            key={index}
            className="flex min-w-0 items-baseline gap-2 motion-safe:animate-fade-in"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <span
              className="shrink-0 font-mono text-[11px] text-brand"
              style={alignedAnswerTagStyle}
            >
              {answer.tag}
            </span>
            {answer.words ? (
              <span className="min-w-0 text-foreground">{answer.words}</span>
            ) : (
              <span className="text-muted-foreground/70">skipped</span>
            )}
          </li>
        )
      })}
      {note.trim() && (
        <li
          className="flex min-w-0 items-baseline gap-2 motion-safe:animate-fade-in"
          style={{ animationDelay: `${questions.length * 40}ms` }}
        >
          <span
            className="shrink-0 font-mono text-[11px] text-muted-foreground"
            style={alignedAnswerTagStyle}
          >
            note
          </span>
          <span className="min-w-0 whitespace-pre-wrap text-foreground">{note.trim()}</span>
        </li>
      )}
    </ul>
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
  className = 'border-t border-border/60',
}: {
  card: string
  questions: Question[]
  keys: boolean
  submit: (answers: Answer[], note?: string, keepalive?: boolean) => Promise<unknown>
  reply: (text: string) => Promise<unknown>
  dismiss: () => Promise<unknown>
  className?: string
}) {
  const [state, setState] = useDurableCard(card)
  const { drafts, note, current, text } = state
  const root = useRef<HTMLDivElement>(null)

  const [submittedSummarySnapshot, setSubmittedSummarySnapshot] = useState<{
    drafts: Record<number, Draft>
    note: string
  }>()
  const [phase, setPhase] = useState<Phase>('answering')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const undoWindowSend = useRef<{
    cancel: Cancel
    fire: (keepalive?: boolean) => void
  }>(undefined)
  const cancelAdvanceAfterCheck = useRef<Cancel>(undefined)
  const flush = () => flushUndoWindowSend(undoWindowSend)
  const phone = useViewport() === 'phone'
  const hints = keys && !phone
  const words = questions.map((question, index) => answerOf(question, drafts[index]))
  const ready = answered(questions, drafts)
  const open = questions.flatMap((question, index) =>
    !words[index] && pickIndices(question).length ? [index] : [],
  )
  const settled = phase !== 'answering'

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

  const takePicksWithImmediateSummary = (
    indices: number[],
  ): { answers: Answer[]; drafts: Record<number, Draft> } => {
    const next = { ...drafts }
    for (const [index, question] of questions.entries())
      if (indices.includes(index)) next[index] = pickDraft(question)
    setState((old) => ({ ...old, drafts: next }))
    return { answers: answered(questions, next), drafts: next }
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
  const send = (list: Answer[] = ready, picked: Record<number, Draft> = drafts) => {
    const extra = note.trim()
    if ((!list.length && !extra) || undoWindowSend.current || phase !== 'answering') return
    cancelAdvanceAfterCheck.current?.()
    setSubmittedSummarySnapshot({ drafts: picked, note })
    const fire = (keepalive = false) => {
      undoWindowSend.current = undefined
      setPhase('sending')
      setError(undefined)
      submit(list, extra || undefined, keepalive).then(
        () => setPhase('sent'),
        (failure: unknown) => {
          setPhase('answering')
          setError(errorMessage(failure))
        },
      )
    }
    undoWindowSend.current = { cancel: deadline(ANSWER_UNDO_WINDOW_MS, fire), fire }
    setPhase('undo')
  }
  const now = flush
  const undo = () => {
    if (!undoWindowSend.current) return
    undoWindowSend.current.cancel()
    undoWindowSend.current = undefined
    setPhase('answering')
  }

  const acceptAndSend = () => {
    const picks = takePicksWithImmediateSummary(open)
    send(picks.answers, picks.drafts)
  }

  const enter = () => {
    if (phase === 'undo') return now()
    if (phase !== 'answering') return
    if (!words[current] && open.includes(current)) {
      const picks = takePicksWithImmediateSummary([current])
      return current < questions.length - 1 ? go(current + 1) : send(picks.answers, picks.drafts)
    }
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
      if (event.shiftKey) acceptAndSend()
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
        if (event.shiftKey) acceptAndSend()
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
          {busy ? 'Sending…' : 'Send'}
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </form>
    )

  if (settled)
    return (
      <div className={cn(className, 'px-3 py-2.5')} data-questions-card={card} ref={root}>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <CornerDownRightIcon className="size-3.5 shrink-0 text-brand" />
          <span className="font-semibold text-brand">
            {phase === 'sent' ? 'You answered' : 'Sending your answer'}
          </span>
          {phase === 'undo' && (
            <span className="ml-auto flex items-center gap-2">
              {hints && (
                <span className="flex items-center gap-1 max-md:hidden">
                  <Key>esc</Key> undo
                </span>
              )}
              <Button variant="ghost" size="xs" onClick={undo}>
                <Undo2Icon />
                Undo
              </Button>
            </span>
          )}
          {phase === 'sending' && <span className="ml-auto">sending…</span>}
        </div>
        <Summary
          questions={questions}
          drafts={submittedSummarySnapshot?.drafts ?? drafts}
          note={submittedSummarySnapshot?.note ?? note}
        />
        {phase === 'undo' && (
          <div className="mt-2.5 h-0.5 overflow-hidden rounded-full bg-border/60">
            <div
              ref={animateUndoDeadline}
              data-countdown
              className="h-full w-full origin-left rounded-full bg-brand/70"
            />
          </div>
        )}
      </div>
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
              disabled={busy}
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
          disabled={busy}
          hint={hints}
          onChange={(value) => setState((old) => ({ ...old, note: value }))}
          onSend={() => send()}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
        {hints && (
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
              {!words[current] && open.includes(current)
                ? 'take pick'
                : current < last && unanswered
                  ? 'next'
                  : 'send'}
            </span>
            {words[current] && (
              <span className="flex items-center gap-1">
                <Key>esc</Key> clear
              </span>
            )}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(dismiss)}
            title="Close it without an answer; the agent gets a note"
          >
            Dismiss
          </Button>
          {open.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => takePicksWithImmediateSummary(open)}
              title="Choose @ultimate's pick for every question still open (⇧↵ also sends)"
            >
              Accept picks
              {hints && <Key className="bg-transparent">⇧↵</Key>}
            </Button>
          )}
          <Button
            size="sm"
            disabled={(!ready.length && !note.trim()) || busy}
            onClick={() => send()}
          >
            {!ready.length && note.trim()
              ? 'Send note'
              : unanswered && ready.length
                ? `Send ${ready.length} of ${questions.length}`
                : 'Send'}
          </Button>
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
