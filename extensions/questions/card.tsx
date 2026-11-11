import {
  CornerDownRightIcon,
  MessageCircleQuestionIcon,
  PaperclipIcon,
  Undo2Icon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ImagePreviews, useImagePaste } from '@/components/image-paste'
import type { PastedImage } from '@/components/image-paste'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { api, cn, errorMessage, useConversation, useDocOf, useViewport } from '@/sdk'
import { imageMimeTypes } from '../../shared/protocol.ts'
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
  if (!waitsOnUser(message)) return null
  return (
    <Card
      card={card}
      questions={questions}
      keys={questions.length > 0 && (keys ?? shown)}
      submit={(answers, note, keepalive, images) =>
        api.action(
          AnswerAction,
          {
            messageId: message.id,
            answers,
            ...(note ? { note } : {}),
            ...(images.length ? { images: bare(images) } : {}),
          },
          // Keepalive bodies share a budget of about 64 KiB: images never fit it.
          { keepalive: keepalive && !images.length },
        )
      }
      reply={(text, images) =>
        api.action(AnswerAction, {
          messageId: message.id,
          text,
          ...(images.length ? { images: bare(images) } : {}),
        })
      }
      dismiss={() => api.action(DismissAction, { messageId: message.id })}
      {...(className === undefined ? {} : { className })}
    />
  )
}

/** The attached images as the action takes them, without the composer's resize note. */
const bare = (images: PastedImage[]) => images.map(({ data, mimeType }) => ({ data, mimeType }))
const imageCount = (count: number) => `${count} image${count === 1 ? '' : 's'}`

/**
 * Screenshots for an answer: pasted into its field, dropped on the card or picked with the paperclip, shown under the
 * field until sent. Only images attach, within the composer's limits.
 */
function useAttached(disabled: () => boolean) {
  const [images, setImages] = useState<PastedImage[]>([])
  const [error, setError] = useState<string>()
  const { paste, drop, attach, reading } = useImagePaste({
    images,
    setImages: (change) => setImages(change),
    setFiles: () => undefined,
    setError,
    disabled,
  })
  return {
    images,
    error,
    reading,
    clear: () => setImages([]),
    remove: (index: number) => {
      setError(undefined)
      setImages((old) => old.filter((_, i) => i !== index))
    },
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      // oxlint-disable-next-line typescript/no-floating-promises -- paste reports failures in `error`.
      void paste(event as ClipboardEvent<HTMLTextAreaElement>),
    // The page's composer takes drops anywhere else; one on the card (`data-takes-drops`) is the card's.
    onDrop: (event: DragEvent<HTMLElement>) => {
      // oxlint-disable-next-line typescript/no-floating-promises -- drop reports failures in `error`.
      if (event.dataTransfer.types.includes('Files')) void drop(event)
    },
    attach,
  }
}

/** The paperclip that picks screenshots for an answer. */
function Attach({
  disabled,
  onPick,
  className,
}: {
  disabled: boolean
  onPick: (files: File[]) => unknown
  className?: string
}) {
  return (
    <label
      aria-label="Attach images"
      title="Attach images (or paste or drop them here)"
      className={cn(
        'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:size-9',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <PaperclipIcon className="size-3.5" />
      <input
        accept={imageMimeTypes.join(',')}
        className="sr-only"
        disabled={disabled}
        multiple
        type="file"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? [])
          event.target.value = ''
          onPick(picked)
        }}
      />
    </label>
  )
}

/** Sends the answer waiting out its undo window now, if one does. */
function flushPending(
  pending: {
    current?: { timer: ReturnType<typeof setTimeout>; fire: (keepalive?: boolean) => void }
  },
  keepalive = false,
) {
  const waiting = pending.current
  if (!waiting) return
  clearTimeout(waiting.timer)
  waiting.fire(keepalive)
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
            'h-1 rounded-full transition-[width,background-color] duration-300 ease-out',
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
  images,
}: {
  questions: Question[]
  drafts: Record<number, Draft>
  note: string
  images: number
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
      {images > 0 && (
        <li className="flex min-w-0 items-baseline gap-2 motion-safe:animate-fade-in">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground" style={tag}>
            +
          </span>
          <span className="min-w-0 text-foreground">{imageCount(images)}</span>
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
  onPaste,
  onAttach,
}: {
  value: string
  disabled: boolean
  hint: boolean
  onChange: (value: string) => void
  onSend: () => void
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onAttach: (files: File[]) => unknown
}) {
  return (
    <div className="relative">
      <textarea
        data-note
        aria-label="A note to send with your answer"
        placeholder="Anything else? Sent with your answers, or on its own; paste a screenshot…"
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onPaste={onPaste}
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
        className="field-sizing-content max-h-40 min-h-9 w-full resize-none rounded-md border border-border/70 bg-background/40 px-2.5 py-2 pr-14 text-[13px] leading-snug transition-colors outline-none placeholder:text-muted-foreground/60 hover:border-border focus:border-brand/60 focus:bg-background disabled:opacity-60 max-md:min-h-11 max-md:pr-11"
      />
      <span className="absolute top-1 right-1 flex items-center gap-0.5">
        {hint && !value && (
          <Key className="pointer-events-none bg-transparent text-muted-foreground/60">/</Key>
        )}
        <Attach disabled={disabled} onPick={onAttach} />
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
  submit: (
    answers: Answer[],
    note: string | undefined,
    keepalive: boolean,
    images: PastedImage[],
  ) => Promise<unknown>
  reply: (text: string, images: PastedImage[]) => Promise<unknown>
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
  const [failed, setError] = useState<string>()
  const attached = useAttached(() => busy || phase !== 'answering')
  const error = failed ?? attached.error
  const images = attached.images
  // The send waiting out its undo window, and the click that folds a chosen question away.
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>
    fire: (keepalive?: boolean) => void
  }>(undefined)
  const advance = useRef<ReturnType<typeof setTimeout>>(undefined)
  const flush = () => flushPending(pending)
  const phone = useViewport() === 'phone'
  const hints = keys && !phone
  const words = questions.map((question, index) => answerOf(question, drafts[index]))
  const ready = answered(questions, drafts)
  const open = questions.flatMap((question, index) =>
    !words[index] && pickIndices(question).length ? [index] : [],
  )
  const settled = phase !== 'answering'

  // Leaving the page inside the undo window sends what was sent: only Undo takes it back.
  useEffect(() => {
    // Only this send is keepalive: keepalive bodies share a budget of about 64 KiB, and a note can be longer.
    const leave = () => flushPending(pending, true)
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      clearTimeout(advance.current)
      flush()
    }
  }, [])
  // An answer with images cannot go out as the page closes (keepalive's budget is too small): the browser asks first.
  const holding = images.length > 0 && (phase === 'undo' || phase === 'sending')
  useEffect(() => {
    if (!holding) return undefined
    const ask = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', ask)
    return () => window.removeEventListener('beforeunload', ask)
  }, [holding])

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
  const draft = (index: number, change: (old: Draft) => Draft) =>
    setDrafts((old) => ({ ...old, [index]: change(old[index] ?? { chosen: [] }) }))
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
    setDrafts(next)
    return answered(questions, next)
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
  const send = (list: Answer[] = ready) => {
    const extra = note.trim()
    if (
      (!list.length && !extra && !images.length) ||
      attached.reading ||
      pending.current ||
      phase !== 'answering'
    )
      return
    clearTimeout(advance.current)
    const fire = (keepalive = false) => {
      pending.current = undefined
      setPhase('sending')
      setError(undefined)
      submit(list, extra || undefined, keepalive, images).then(
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
        data-takes-drops
        onDrop={attached.onDrop}
        onSubmit={(event) => {
          event.preventDefault()
          if ((text.trim() || images.length) && !attached.reading)
            // oxlint-disable-next-line typescript/no-floating-promises -- run catches reply failures and displays them with setError.
            void run(async () => {
              await reply(text.trim(), images)
              attached.clear()
            })
        }}
      >
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-brand" />
        <input
          aria-label="Your answer"
          placeholder="Your answer…"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onPaste={attached.onPaste}
          className="min-h-8 min-w-0 flex-1 basis-40 rounded-md border border-border bg-background px-2.5 py-1 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-brand/60 max-md:min-h-11"
        />
        <Attach disabled={busy} onPick={attached.attach} />
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
        <Button
          size="sm"
          type="submit"
          disabled={(!text.trim() && !images.length) || busy || attached.reading}
        >
          {busy ? 'Sending…' : 'Send'}
        </Button>
        <ImagePreviews
          className="w-full px-0 pt-1"
          disabled={busy}
          images={images}
          remove={attached.remove}
        />
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
        <Summary questions={questions} drafts={drafts} note={note} images={images.length} />
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
    <div
      className={className}
      data-questions-card={card}
      data-takes-drops
      onDrop={attached.onDrop}
      ref={root}
    >
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
        <Note
          value={note}
          disabled={busy}
          hint={hints}
          onChange={setNote}
          onSend={() => send()}
          onPaste={attached.onPaste}
          onAttach={attached.attach}
        />
        <ImagePreviews
          className="px-0 pt-2"
          disabled={busy}
          images={images}
          remove={attached.remove}
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
              onClick={() => takePicks(open)}
              title="Choose @ultimate's pick for every question still open (⇧↵ also sends)"
            >
              Accept picks
              {hints && <Key className="bg-transparent">⇧↵</Key>}
            </Button>
          )}
          <Button
            size="sm"
            disabled={(!ready.length && !note.trim() && !images.length) || busy || attached.reading}
            onClick={() => send()}
          >
            {!ready.length && (note.trim() || images.length)
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
