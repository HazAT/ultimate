/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { MessageCircleQuestion } from '@lucide/solid'
import { createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Form } from '@/components/ui/form.solid.tsx'
import { Input, Textarea } from '@/components/ui/input.solid.tsx'
import { Kbd } from '@/components/ui/kbd.solid.tsx'
import {
  Provided,
  api,
  cn,
  errorMessage,
  ROOT,
  useConversationId,
  useDocOf,
  useUiState,
  useViewport,
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
  const change = (edit: (old: CardState) => CardState, automatic = false) => {
    const key = card()
    const list = questions()
    const write = () => setCards((old) => ({ ...old, [key]: edit(cardOf(old, key, list)) }))
    if (automatic) writingAs('app', write)
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
  let noteField!: HTMLTextAreaElement
  let advance: Cancel | undefined
  let waiting: { cancel: Cancel; fire: (keepalive?: boolean) => void } | undefined
  let committed = false
  const [phase, setPhase] = createSignal<Phase>('answering')
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
          .querySelector<HTMLInputElement>(`[data-question="${next}"] input`)
          ?.focus({ preventScroll: true }),
      )
  }
  const draft = (index: number, edit: (old: Draft) => Draft) =>
    change((old) => ({
      ...old,
      drafts: { ...old.drafts, [index]: edit(old.drafts[index] ?? { chosen: [] }) },
    }))
  const select = (index: number, option: number, click = false) => {
    const question = questions()[index]
    const choice = question && choices(question)[option]
    if (!choice) return
    change((old) => {
      const previous = old.drafts[index] ?? { chosen: [] }
      const next =
        question.kind === 'multi'
          ? choice.custom
            ? { ...previous, other: !previous.other }
            : {
                ...previous,
                chosen: previous.chosen.includes(option)
                  ? previous.chosen.filter((i) => i !== option)
                  : [...previous.chosen, option].toSorted((a, b) => a - b),
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
  const flushAnswer = (keepalive = false) => {
    waiting?.cancel()
    waiting?.fire(keepalive)
  }
  const send = (immediately = false, source?: string) => {
    const extra = note().trim()
    const answers = ready()
    if ((!answers.length && !extra) || committed || busy()) return
    const reply = answerRequest()
    committed = true
    advance?.()
    setHeldDraft({ drafts: drafts(), note: note() })
    const fire = (keepalive = false) => {
      waiting = undefined
      setPhase('sending')
      setError(undefined)
      writingAs(source, () =>
        reply({ answers, ...(extra ? { note: extra } : {}) }, keepalive),
      ).then(
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
    if (beforeLast() && left()) go(current() + 1)
    else send()
  }
  const fieldKey = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.isComposing) return
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
      go(current() + (event.key === 'ArrowDown' ? 1 : -1))
    }
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
      noteField.focus()
    }
  }
  onSettled(() => {
    const listeners = new AbortController()
    window.addEventListener('keydown', onKey, { signal: listeners.signal })
    window.addEventListener('pagehide', () => flushAnswer(true), { signal: listeners.signal })
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
  const textOnly = () => (
    <Form
      class={cn(frame(), 'flex flex-wrap items-center gap-2 px-3 py-2.5')}
      data-questions-card={card()}
    >
      <MessageCircleQuestion class="size-3.5 shrink-0 text-brand" />
      <Input
        aria-label={`Your answer to message ${props.id}`}
        placeholder="Your answer…"
        value={state().text}
        disabled={busy()}
        onValueChange={(text) => change((old) => ({ ...old, text }))}
        autocomplete="on"
        spellcheck
        class="h-auto min-h-8 flex-1 basis-40 border-border px-2.5 py-1 font-sans text-[13px] placeholder:text-muted-foreground/70 focus-visible:border-brand/60 focus-visible:ring-0 max-md:min-h-11"
      />
      <Actions disabled={busy()} />
      <Button
        aria-label={`${props.sendLabel ?? 'Send'}: answer to message ${props.id}`}
        size="sm"
        type="submit"
        disabled={!state().text.trim() || busy()}
        onClick={() => {
          const reply = answerRequest()
          const text = state().text.trim()
          return run(() => reply({ text }))
        }}
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
                  onSelect={(option) => select(index, option, true)}
                  onText={(value) => draft(index, (old) => ({ ...old, text: value }))}
                  onFieldKey={fieldKey}
                />
              </div>
            )}
          </For>
        </div>
        <div class="px-3 pt-2">
          <div class="relative">
            <Textarea
              ref={noteField}
              data-note
              aria-label={`A note to send with your answer to message ${props.id}`}
              placeholder="Anything else? Sent with your answers, or on its own…"
              rows={1}
              value={note()}
              disabled={disabled()}
              onValueChange={(value) => change((old) => ({ ...old, note: value }))}
              onKeyDown={(event) => {
                if (event.isComposing) return
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.stopPropagation()
                  send()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
              class="field-sizing-content max-h-40 min-h-9 resize-none border-border/70 bg-background/40 px-2.5 pr-8 leading-snug transition-colors hover:border-border focus:border-brand/60 focus:bg-background focus-visible:ring-0 max-md:min-h-11"
            />
            <Show when={hints() && !note()}>
              <Key class="pointer-events-none absolute top-2.5 right-2.5 bg-transparent text-muted-foreground/60">
                /
              </Key>
            </Show>
          </div>
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
                {beforeLast() && left() ? 'next' : 'send'}
              </span>
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
              disabled={(!locked() && !ready().length && !note().trim()) || busy()}
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
