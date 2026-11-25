import type { JSX } from '@solidjs/web'
import { MessageCircleQuestion } from '@lucide/solid'
import { createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import {
  PromptBox,
  Provided,
  api,
  cn,
  errorMessage,
  ROOT,
  useConversationId,
  useDocOf,
  useUiState,
  useViewport,
  writerNow,
  writingAs,
  type Point,
} from '@/sdk/solid'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { MessagesDoc } from '../messages/refs.ts'
import { keyCard, openQuestions, waitsOnUser } from './open.ts'
import type { Message } from './open.ts'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { QuestionItem } from './question.solid.tsx'
import { AnswerAction, DismissAction } from './refs.ts'
import type { Reply } from './refs.ts'
import { ANSWER_UNDO_WINDOW_MS, SendButton } from './send.solid.tsx'
import type { Phase } from './send.solid.tsx'
import {
  answered,
  answerOf,
  cardKey,
  cardOf,
  CARDS_KEY,
  choiceForKey,
  choices,
  keyOf,
} from './state.ts'
import type { CardState, Draft } from './state.ts'

const CHECK_LANDING_BEFORE_ADVANCE_MS = 320

const caretAtEdge = (field: HTMLTextAreaElement, edge: 'start' | 'end') =>
  field.selectionStart === field.selectionEnd &&
  field.selectionStart === (edge === 'start' ? 0 : field.value.length)
const KEEPALIVE_BYTES = 60 * 1024

export const CardActions: Point<{ message: Message }, JSX.Element> = {
  point: 'questions.card-actions',
}

type CardProps = {
  message: Message
  keys?: boolean
  class?: string
  withActions?: boolean
  answerWith?: (answer: Reply, keepalive?: boolean) => Promise<unknown>
  sendLabel?: string
}

export function MessageQuestions(props: CardProps) {
  return (
    <Show when={waitsOnUser(props.message) && props.message.id} keyed>
      {(id) => <AnswerCard {...props} id={id} />}
    </Show>
  )
}

export function HiddenQuestionEntry(_props: { entry: EntryRecord }) {
  return null
}

const Key = (props: { children: string; class?: string }) => (
  <Kbd class={cn('h-4 min-w-4 rounded-[3px] px-1 font-mono text-[10px]', props.class)}>
    {props.children}
  </Kbd>
)

function AnswerCard(props: CardProps & { id: number }) {
  const questions = createMemo(() => openQuestions(props.message))
  const card = () => cardKey(props.id)
  const [cards, setCards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const state = createMemo(() => cardOf(cards(), card(), questions()))
  const change = (edit: (old: CardState) => CardState, unrecorded = false) => {
    const key = card()
    const list = questions()
    const write = () => setCards((old) => ({ ...old, [key]: edit(cardOf(old, key, list)) }))
    if (unrecorded) writingAs('app', write)
    else write()
  }
  const answerRequest = () => {
    const id = props.id
    return (
      props.answerWith ??
      ((reply: Reply, keepalive?: boolean) =>
        api.action(AnswerAction, { messageId: id, ...reply }, { keepalive }))
    )
  }
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const run = async (request: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await request()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const Actions = (controls: { disabled: boolean; class?: string }) => (
    <>
      <Show when={props.withActions !== false}>
        <Provided point={CardActions} input={{ message: props.message }} last />
      </Show>
      <Button
        aria-label={`Dismiss message ${props.id}`}
        variant="ghost"
        size="sm"
        disabled={controls.disabled}
        onClick={() => {
          const messageId = props.id
          return run(() => api.action(DismissAction, { messageId }))
        }}
        title="Close it without an answer; the agent gets a note"
        class={controls.class}
      >
        Dismiss
      </Button>
    </>
  )
  const alert = () => (
    <Show when={error()}>
      <p role="alert" class="w-full text-xs text-error">
        {error()}
      </p>
    </Show>
  )
  const frame = () => props.class ?? 'border-t border-border/60'
  const conversation = useConversationId()
  const messages = useDocOf(() => ROOT, MessagesDoc)
  const viewport = useViewport()
  const hints = createMemo(
    () =>
      viewport() !== 'phone' &&
      (props.keys ?? keyCard(conversation(), messages()?.messages ?? []) === card()),
  )

  let root!: HTMLDivElement
  let noteField: HTMLTextAreaElement | undefined
  let advance: Cancel | undefined
  let waiting: { cancel: Cancel; fire: () => void } | undefined
  let committed = false
  const [phase, setPhase] = createSignal<Phase>('answering')
  const [uploads, setUploads] = createSignal<Record<string, boolean>>({})
  const uploading = () => Object.values(uploads()).some(Boolean)
  const uploadingIn = (box: string) => (pending: boolean) =>
    setUploads((all) => ({ ...all, [box]: pending }))
  const [heldDraft, setHeldDraft] = createSignal<Pick<CardState, 'drafts' | 'note'>>()
  const drafts = () => heldDraft()?.drafts ?? state().drafts
  const note = () => heldDraft()?.note ?? state().note
  const current = () => state().current
  const ready = createMemo(() => answered(questions(), drafts()))
  const locked = () => phase() !== 'answering'
  const disabled = () => busy() || locked()
  const word = (i: number) => answerOf(questions()[i], drafts()[i])
  const left = () => questions().length - ready().length
  const beforeLast = () => current() < questions().length - 1
  const sendLabel = () =>
    props.sendLabel ??
    (!ready().length && note().trim()
      ? 'Send note'
      : left() && ready().length
        ? `Send ${ready().length} of ${questions().length}`
        : 'Send')

  const go = (index: number, automatic = false) => {
    advance?.()
    const next = Math.min(questions().length - 1, Math.max(0, index))
    change((old) => ({ ...old, current: next }), automatic)
    if (questions()[next]?.kind === 'text')
      requestAnimationFrame(() =>
        root
          .querySelector<HTMLTextAreaElement>(`[data-question="${next}"] textarea`)
          ?.focus({ preventScroll: true }),
      )
  }
  const draft = (index: number, edit: (old: Draft) => Draft, typed = false) =>
    change(
      (old) => ({
        ...old,
        drafts: { ...old.drafts, [index]: edit(old.drafts[index] ?? { chosen: [] }) },
      }),
      typed,
    )
  const select = (index: number, option: number, click = false, pressed?: boolean) => {
    const question = questions()[index]
    const choice = question && choices(question)[option]
    if (!choice) return
    change((old) => {
      const previous = old.drafts[index] ?? { chosen: [] }
      const on = pressed ?? !(choice.custom ? previous.other : previous.chosen.includes(option))
      const next =
        question.kind === 'multi'
          ? choice.custom
            ? { ...previous, other: on }
            : {
                ...previous,
                chosen: on
                  ? [...new Set([...previous.chosen, option])].toSorted((a, b) => a - b)
                  : previous.chosen.filter((i) => i !== option),
              }
          : { ...previous, chosen: choice.custom ? [] : [option], other: !!choice.custom }
      return { ...old, current: index, drafts: { ...old.drafts, [index]: next } }
    })
    advance?.()
    if (question.kind !== 'multi' && click && !choice.custom && index < questions().length - 1)
      advance = deadline(CHECK_LANDING_BEFORE_ADVANCE_MS, go.bind(null, index + 1, true))
  }
  const unlock = () => {
    committed = false
    setHeldDraft(undefined)
    setPhase('answering')
  }
  const undo = () => {
    if (!waiting) return
    waiting.cancel()
    waiting = undefined
    unlock()
  }
  const flushAnswer = () => {
    waiting?.cancel()
    waiting?.fire()
  }
  const send = (immediately = false, source?: string) => {
    const extra = note().trim()
    const answers = ready()
    if ((!answers.length && !extra) || committed || busy() || uploading()) return
    const reply = answerRequest()
    committed = true
    advance?.()
    setHeldDraft({ drafts: drafts(), note: note() })
    const answer = { answers, ...(extra ? { note: extra } : {}) }
    const outlivesPage =
      new TextEncoder().encode(JSON.stringify(answer)).byteLength <= KEEPALIVE_BYTES
    const fire = () => {
      waiting = undefined
      setPhase('sending')
      setError(undefined)
      writingAs(source, () => reply(answer, outlivesPage)).then(
        () => setPhase('sent'),
        (failure: unknown) => {
          unlock()
          setError(errorMessage(failure))
        },
      )
    }
    if (immediately) fire()
    else {
      waiting = { cancel: deadline(ANSWER_UNDO_WINDOW_MS, fire), fire }
      setPhase('undo')
    }
  }
  const enter = () => {
    if (phase() === 'undo') return flushAnswer()
    if (locked()) return
    if (beforeLast()) go(current() + 1)
    else send(false, writerNow())
  }
  const fieldKey = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    const leavesField =
      (event.key === 'ArrowUp' && caretAtEdge(event.currentTarget, 'start')) ||
      (event.key === 'ArrowDown' && caretAtEdge(event.currentTarget, 'end'))
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      enter()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.currentTarget.blur()
    } else if (leavesField) {
      event.preventDefault()
      event.currentTarget.blur()
      go(current() + (event.key === 'ArrowDown' ? 1 : -1))
    } else return false
    return true
  }
  const onKey = (event: KeyboardEvent) => {
    if (!hints() || !questions().length || (locked() && phase() !== 'undo')) return
    const target = event.target instanceof Element ? event.target : null
    if (
      event.defaultPrevented ||
      root.closest('[data-receded]') ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      target?.closest('input, textarea, select, [contenteditable="true"]') ||
      (!root.contains(target) && target?.closest('[data-questions-card], button, a'))
    )
      return
    if (phase() === 'undo') {
      if (event.key === 'Escape' || event.key === 'u') {
        event.preventDefault()
        undo()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        flushAnswer()
      }
      return
    }
    const question = questions()[current()]
    const choice =
      question && /^[1-9a-z]$/.test(event.key) ? choiceForKey(question, event.key) : undefined
    if (choice !== undefined) {
      event.preventDefault()
      select(current(), choice)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      go(current() + (event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) send(true)
      else enter()
    } else if (event.key === 'Escape' && question && word(current())) {
      event.preventDefault()
      advance?.()
      draft(current(), () => ({ chosen: [] }))
    } else if (event.key === '/') {
      event.preventDefault()
      noteField?.focus()
    }
  }
  onSettled(() => {
    const listeners = new AbortController()
    window.addEventListener('keydown', onKey, { signal: listeners.signal })
    window.addEventListener('pagehide', flushAnswer, { signal: listeners.signal })
    return () => {
      listeners.abort()
      advance?.()
      flushAnswer()
    }
  })

  const shownKeys = () => {
    const shown = questions()[current()]
    return shown ? [0, 1].flatMap((i) => keyOf(shown, i) ?? []) : []
  }
  const answerText = () => {
    const reply = answerRequest()
    const text = state().text.trim()
    return text && !uploading() ? run(() => reply({ text })) : Promise.resolve()
  }
  const textOnly = () => (
    <Form
      class={cn(frame(), 'flex flex-wrap items-center gap-2 px-3 py-2.5')}
      data-questions-card={card()}
    >
      <MessageCircleQuestion class="size-3.5 shrink-0 text-brand" />
      <div class="min-w-0 flex-1 basis-40">
        <PromptBox
          accepts={{ images: false }}
          disabled={busy()}
          draft={undefined}
          label={`Your answer to message ${props.id}`}
          minimal
          name={`the answer to message ${props.id}`}
          onSubmit={answerText}
          onUploading={uploadingIn('answer')}
          onValue={(text) => change((old) => ({ ...old, text }), true)}
          placeholder="Your answer…"
          sendButton={false}
          value={state().text}
        />
      </div>
      <Actions disabled={busy()} />
      <Button
        aria-label={`${props.sendLabel ?? 'Send'}: answer to message ${props.id}`}
        size="sm"
        type="submit"
        disabled={!state().text.trim() || busy() || uploading()}
        onClick={answerText}
      >
        {busy() ? 'Sending…' : (props.sendLabel ?? 'Send')}
      </Button>
      {alert()}
    </Form>
  )
  return (
    <Show when={questions().length} fallback={textOnly()}>
      <div class={frame()} data-questions-card={card()} ref={root}>
        <div class="flex items-center gap-2 px-3 pt-2.5 pb-1 font-mono text-[11px] text-muted-foreground">
          <MessageCircleQuestion class="size-3.5 text-brand" />
          <span class="text-foreground">
            {questions().length === 1 ? '1 question' : `${questions().length} questions`}
          </span>
          <Show when={questions().length > 1}>
            <span class="ml-auto flex items-center gap-2">
              <span>
                {ready().length}/{questions().length}
              </span>
              <span class="flex items-center gap-1" aria-hidden="true">
                <For each={questions()} keyed={false}>
                  {(_, i) => (
                    <span
                      class={cn(
                        'h-1 rounded-full transition-[width,background-color] duration-300 ease-out',
                        word(i) ? 'w-3 bg-brand' : 'w-1.5 bg-muted-foreground/30',
                      )}
                    />
                  )}
                </For>
              </span>
            </span>
          </Show>
        </div>
        <div class="space-y-0.5 px-1.5">
          <For each={questions()} keyed={false}>
            {(question, index) => (
              <div data-question={index}>
                <QuestionItem
                  question={question()}
                  index={index}
                  messageId={props.id}
                  draft={drafts()[index]}
                  current={index === current()}
                  disabled={disabled()}
                  hints={hints()}
                  onOpen={() => go(index)}
                  onSelect={(option, pressed) => select(index, option, true, pressed)}
                  onText={(value) => draft(index, (old) => ({ ...old, text: value }), true)}
                  onFieldKey={fieldKey}
                  onFieldSend={enter}
                  onUploading={uploadingIn(`question ${index}`)}
                />
              </div>
            )}
          </For>
        </div>
        <div class="px-3 pt-2" data-note-box>
          <PromptBox
            accepts={{ images: false }}
            disabled={disabled()}
            draft={undefined}
            label={`A note to send with your answer to message ${props.id}`}
            minimal
            name={`the note to message ${props.id}`}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return false
              event.preventDefault()
              event.currentTarget.blur()
              return true
            }}
            onSubmit={() => Promise.resolve(send(false, writerNow()))}
            onUploading={uploadingIn('note')}
            onValue={(value) => change((old) => ({ ...old, note: value }), true)}
            placeholder="Anything else? Sent with your answers, or on its own…"
            ready={() => ready().length > 0}
            ref={(element) => {
              noteField = element
            }}
            sendButton={false}
            value={note()}
          />
        </div>
        <div class="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
          <Show when={hints() && phase() === 'undo'}>
            <span class="flex items-center gap-x-2.5 font-mono text-[10px] text-muted-foreground/80 max-md:hidden">
              <span class="flex items-center gap-1">
                <Key>esc</Key> undo
              </span>
              <span class="flex items-center gap-1">
                <Key>↵</Key> send now
              </span>
            </span>
          </Show>
          <Show when={hints() && !locked()}>
            <span class="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-muted-foreground/80 max-md:hidden">
              <Show when={shownKeys().length}>
                <span class="flex items-center gap-1">
                  <For each={shownKeys()}>{(key) => <Key>{key}</Key>}</For> choose
                </span>
              </Show>
              <Show when={questions().length > 1}>
                <span class="flex items-center gap-1">
                  <Key>↑</Key>
                  <Key>↓</Key> move
                </span>
              </Show>
              <span class="flex items-center gap-1">
                <Key>↵</Key>
                {beforeLast() ? 'next' : 'send'}
              </span>
              <Show when={!note()}>
                <span class="flex items-center gap-1">
                  <Key>/</Key> note
                </span>
              </Show>
              <Show when={questions()[current()] && word(current())}>
                <span class="flex items-center gap-1">
                  <Key>esc</Key> clear
                </span>
              </Show>
            </span>
          </Show>
          <span class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <Actions disabled={disabled()} class="max-md:h-11" />
            <SendButton
              messageId={props.id}
              phase={phase()}
              disabled={(!locked() && !ready().length && !note().trim()) || busy() || uploading()}
              label={sendLabel()}
              onSend={(source) => send(false, source)}
              onSendNow={() => send(true)}
              onUndo={undo}
            />
          </span>
          {alert()}
        </div>
      </div>
    </Show>
  )
}
