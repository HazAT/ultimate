import {
  CircleAlertIcon,
  CornerDownRightIcon,
  MessageCircleQuestionIcon,
  Undo2Icon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { api, cn, errorMessage, useConversation, useDocOf, useViewport } from '@/sdk'
import type { Question } from '../messages/refs.ts'
import { MessagesDoc } from '../messages/ui.tsx'
import { keyCard, openQuestions } from './open.tsx'
import type { Message } from './open.tsx'
import { brief, QuestionItem } from './question.tsx'
import { AnswerAction, DismissAction } from './refs.ts'
import type { Answer } from './refs.ts'
import {
  answered,
  answerOf,
  choiceForKey,
  choices,
  keyOf,
  pickDraft,
  pickIndices,
} from './state.tsx'
import type { Draft } from './state.tsx'

/** How long a sent card can still be taken back before the answer goes out. */
const UNDO_MS = 3000

/**
 * Fills the undo bar over UNDO_MS from the moment it mounts, as `send` starts the timer. The Web Animations API
 * runs on every mobile engine, where a `@starting-style` transition left the bar full. It stays under reduced
 * motion: the bar tells how long Undo remains, it is not decoration. Module-level, so re-renders never restart it.
 */
const countdown = (bar: HTMLDivElement | null) => {
  bar?.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
    duration: UNDO_MS,
    easing: 'linear',
    fill: 'both',
  })
}

/** Whether `card` is the one on the shown conversation's page that takes the desktop 1–9 and Enter keys. */
function useKeys(card: string) {
  const messages = useDocOf(1, MessagesDoc)?.messages ?? []
  const conversation = useConversation((value) => value.id)
  return keyCard(conversation, messages) === card
}

/**
 * The answer card of a message that waits on the user: the questions it asks, or only a reply field and Dismiss when
 * it asks none. `keys` (default: the shown conversation decides) whether it takes the desktop 1–9 and Enter keys.
 */
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
  if (message.to !== 'user' || !message.reply || message.state !== 'delivered') return null
  return (
    <Card
      card={card}
      questions={questions}
      keys={questions.length > 0 && (keys ?? shown)}
      submit={(answers, note) =>
        api.action(AnswerAction, { messageId: message.id, answers, ...(note ? { note } : {}) })
      }
      reply={(text) => api.action(AnswerAction, { messageId: message.id, text })}
      dismiss={() => api.action(DismissAction, { messageId: message.id })}
      {...(className === undefined ? {} : { className })}
    />
  )
}

/** Sends the answer waiting out its undo window now, if one does. */
function flushPending(pending: {
  current?: { timer: ReturnType<typeof setTimeout>; fire: () => void }
}) {
  const waiting = pending.current
  if (!waiting) return
  clearTimeout(waiting.timer)
  waiting.fire()
}

/** Where the card is: being answered, sent but still undoable, on its way, or settled into a summary. */
type Phase = 'answering' | 'undo' | 'sending' | 'sent'

/** A small key cap for the hint line and buttons. */
const Key = ({ children, className }: { children: string; className?: string }) => (
  <Kbd className={cn('h-4 min-w-4 rounded-[3px] px-1 font-mono text-[10px]', className)}>
    {children}
  </Kbd>
)

/** One dot per question, filled as it gets an answer: how far along the card is, at a glance. */
function Progress({ done }: { done: boolean[] }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {done.map((value, index) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- Progress dots correspond to fixed question positions.
          key={index}
          className={cn(
            'h-1 rounded-full transition-all duration-300 ease-out',
            value ? 'w-3 bg-brand' : 'w-1.5 bg-muted-foreground/30',
          )}
        />
      ))}
    </span>
  )
}

/**
 * What was sent, folded to a line per question in the shape of the answer under an answered message: the number and
 * letter, the words, and "skipped" for a question left open.
 */
function Summary({
  questions,
  drafts,
  note,
}: {
  questions: Question[]
  drafts: Record<number, Draft>
  note: string
}) {
  // One column for the tags, as wide as the widest ("2a,b,c", "note"), so every answer starts at the same place.
  const widest = Math.max(
    ...questions.map((question, index) => brief(question, index, drafts[index]).tag.length),
    note.trim() ? 4 : 0,
  )
  const tag = { minWidth: `${Math.max(3, widest)}ch` }
  return (
    <ul className="mt-1.5 space-y-0.5 pl-5.5 text-[13px] leading-relaxed">
      {questions.map((question, index) => {
        const answer = brief(question, index, drafts[index])
        return (
          <li
            // oxlint-disable-next-line react/no-array-index-key -- Answers correspond to fixed question positions.
            key={index}
            className="flex min-w-0 items-baseline gap-2 motion-safe:animate-fade-in"
            style={{ animationDelay: `${index * 40}ms` }}
          >
            <span className="shrink-0 font-mono text-[11px] text-brand" style={tag}>
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
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground" style={tag}>
            note
          </span>
          <span className="min-w-0 whitespace-pre-wrap text-foreground">{note.trim()}</span>
        </li>
      )}
    </ul>
  )
}

/**
 * The note field under every card: whatever comes to mind while answering goes along with the answers, or on its
 * own. Enter sends, ⇧Enter breaks a line, Esc hands the keys back to the card; `/` focuses it from the card.
 */
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

/** Send with questions left unanswered asks in place of the buttons, so a partial answer goes out only on purpose. */
function Confirm({
  done,
  total,
  hints,
  onSend,
  onEdit,
}: {
  done: number
  total: number
  hints: boolean
  onSend: () => void
  onEdit: () => void
}) {
  return (
    <div
      role="alert"
      className="flex w-full flex-wrap items-center gap-2 motion-safe:animate-fade-in"
    >
      <CircleAlertIcon className="size-3.5 shrink-0 text-warning" />
      <span className="text-[13px] text-foreground">
        {done} of {total} answered: send anyway?
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Keep editing
          {hints && <Key className="bg-transparent">esc</Key>}
        </Button>
        <Button size="sm" onClick={onSend}>
          Send anyway
          {hints && <Key className="bg-transparent text-primary-foreground/70">↵</Key>}
        </Button>
      </span>
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
  submit: (answers: Answer[], note?: string) => Promise<unknown>
  reply: (text: string) => Promise<unknown>
  dismiss: () => Promise<unknown>
  className?: string
}) {
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [current, setCurrent] = useState(0)
  const [phase, setPhase] = useState<Phase>('answering')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // Send with questions still unanswered asks first: a partial answer is easy to send by accident.
  const [confirming, setConfirming] = useState(false)
  // The send waiting out its undo window, and the click that folds a chosen question away.
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; fire: () => void }>(undefined)
  const advance = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flush = () => flushPending(pending)
  const phone = useViewport() === 'phone'
  const hints = keys && !phone
  const words = questions.map((question, index) => answerOf(question, drafts[index]))
  const ready = answered(questions, words)
  const open = questions.flatMap((question, index) =>
    !words[index] && pickIndices(question).length ? [index] : [],
  )
  const settled = phase !== 'answering'

  // Leaving the page inside the undo window sends what was sent: only Undo takes it back.
  useEffect(
    () => () => {
      clearTimeout(advance.current)
      flush()
    },
    [],
  )

  const focusField = (index: number) =>
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLInputElement>(`[data-question="${index}"] input`)
        ?.focus({ preventScroll: true }),
    )
  const go = (index: number) => {
    clearTimeout(advance.current)
    const next = Math.min(questions.length - 1, Math.max(0, index))
    setCurrent(next)
    if (questions[next]?.kind === 'text') focusField(next)
  }
  const draft = (index: number, change: (old: Draft) => Draft) => {
    setConfirming(false)
    setDrafts((old) => ({ ...old, [index]: change(old[index] ?? { chosen: [] }) }))
  }
  const select = (index: number, option: number, click = false) => {
    const question = questions[index]
    const choice = question && choices(question)[option]
    if (!question || !choice) return
    setCurrent(index)
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
    // A click on a single answer lets its check land, then folds the question and opens the next.
    clearTimeout(advance.current)
    if (click && !choice.custom && index < questions.length - 1)
      advance.current = setTimeout(() => go(index + 1), 320)
  }
  /** Takes @ultimate's picks for questions `indices`, returning the answers that are ready then. */
  const takePicks = (indices: number[]) => {
    const next = { ...drafts }
    for (const [index, question] of questions.entries())
      if (indices.includes(index)) next[index] = pickDraft(question)
    setConfirming(false)
    setDrafts(next)
    return answered(
      questions,
      questions.map((question, index) => answerOf(question, next[index])),
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
  /** Sends `list` with the note; with questions left unanswered, asks first and sends on the next send. */
  const send = (list: Answer[] = ready) => {
    const extra = note.trim()
    if ((!list.length && !extra) || pending.current || phase !== 'answering') return
    clearTimeout(advance.current)
    if (!confirming && list.length < questions.length) return setConfirming(true)
    setConfirming(false)
    const fire = () => {
      pending.current = undefined
      setPhase('sending')
      setError(undefined)
      submit(list, extra || undefined).then(
        () => setPhase('sent'),
        (failure: unknown) => {
          setPhase('answering')
          setError(errorMessage(failure))
        },
      )
    }
    pending.current = { timer: setTimeout(fire, UNDO_MS), fire }
    setPhase('undo')
  }
  /** Back from "send anyway?" to the first question still unanswered. */
  const keepEditing = () => {
    setConfirming(false)
    const first = words.findIndex((value) => !value)
    if (first >= 0) go(first)
  }
  const now = flush
  const undo = () => {
    if (!pending.current) return
    clearTimeout(pending.current.timer)
    pending.current = undefined
    setPhase('answering')
  }
  /** Every pick for the questions still open, sent at once: the one-keystroke path. */
  const acceptAndSend = () => send(takePicks(open))
  /** Enter: take the pick of an open question, move on, and send from the last one or once all are answered. */
  const enter = () => {
    if (phase === 'undo') return now()
    if (phase !== 'answering') return
    if (!words[current] && open.includes(current)) {
      const list = takePicks([current])
      return current < questions.length - 1 ? go(current + 1) : send(list)
    }
    if (current < questions.length - 1 && ready.length < questions.length) return go(current + 1)
    send()
  }
  const clear = () => {
    clearTimeout(advance.current)
    setDrafts((old) => ({ ...old, [current]: { chosen: [] } }))
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
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        // Outside this card, another card or a control keeps its own keys.
        (!root.current?.contains(target) && target?.closest('[data-questions-card], button, a'))
      )
        return
      if (confirming && (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey))) {
        // Enter on a focused button presses that button instead.
        if (event.key === 'Enter' && target?.closest('button')) return
        event.preventDefault()
        if (event.key === 'Enter') send()
        else keepEditing()
        return
      }
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

  // No questions to answer with buttons: a reply field for this message, and Dismiss.
  if (!questions.length)
    return (
      <form
        className={cn(className, 'flex flex-wrap items-center gap-2 px-3 py-2.5')}
        data-questions-card={card}
        onSubmit={(event) => {
          event.preventDefault()
          // oxlint-disable-next-line typescript/no-floating-promises -- run catches reply failures and displays them with setError.
          if (text.trim()) void run(() => reply(text.trim()))
        }}
      >
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-brand" />
        <input
          aria-label="Your answer"
          placeholder="Your answer…"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
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
        <Summary questions={questions} drafts={drafts} note={note} />
        {phase === 'undo' && (
          <div className="mt-2.5 h-0.5 overflow-hidden rounded-full bg-border/60">
            <div
              ref={countdown}
              data-countdown
              className="h-full w-full origin-left rounded-full bg-brand/70"
            />
          </div>
        )}
      </div>
    )

  const last = questions.length - 1
  // The keys of the open question: its first two choices, none while it is typed.
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
          // oxlint-disable-next-line react/no-array-index-key -- Questions and their drafts are addressed by index.
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
        <Note value={note} disabled={busy} hint={hints} onChange={setNote} onSend={() => send()} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
        {confirming ? (
          <Confirm
            done={ready.length}
            total={questions.length}
            hints={hints}
            onSend={() => send()}
            onEdit={keepEditing}
          />
        ) : (
          <>
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
                  onClick={() => takePicks(open)}
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
          </>
        )}
        {error && (
          <p role="alert" className="w-full text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
