/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { CornerLeftUp, Mail } from '@lucide/solid'
import { Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Fold, UserView } from '@/sdk/parts.solid.tsx'
import {
  ROOT,
  cn,
  events,
  switchConversation,
  useConversationId,
  useDocOf,
  useTranscript,
} from '@/sdk/solid'
import { MessageEntry, ReplyEntry } from '../entries/refs.ts'
import type { DeliveredMessage } from '../entries/refs.ts'
import { accentOf } from './accent.ts'
import { callerOf } from './caller.ts'
import { Body, Navigate, useAccentOf } from './card-parts.solid.tsx'
import { InputImages } from './message-images.solid.tsx'
import { MessagesDoc } from './refs.ts'
import { Address } from './ui.solid.tsx'

export function MessageInput(props: { entry: EntryRecord }) {
  const origin = () =>
    MessageEntry.is(props.entry) || ReplyEntry.is(props.entry) ? props.entry.data : undefined
  return (
    <Show when={origin()}>
      {(message) => (
        <Show
          when={message().from === 'user'}
          fallback={<Incoming entry={props.entry} message={message()} />}
        >
          <UserTurn entry={props.entry} id={message().id} text={message().text} />
        </Show>
      )}
    </Show>
  )
}

function Incoming(props: { entry: EntryRecord; message: DeliveredMessage }) {
  const receiver = useConversationId()
  const reply = () => props.entry.kind === 'board.reply'
  const accent = useAccentOf(() => props.message.from)
  const label = () => (reply() ? 'Reply' : 'Message')
  const expectation = () => (props.message.reply ? 'expects reply' : 'one-way')
  const state = () =>
    props.message.stopped ? 'stopped by the user' : props.message.failed ? 'failed' : undefined
  const failureClass = () => (state() === 'failed' ? 'text-destructive' : '')
  const delivery = () => {
    const via = props.message.delivery
    return via && { steer: 'steered', followUp: 'follow-up', note: 'note' }[via]
  }
  function openSource() {
    const from = props.message.from
    const back = receiver()
    if (back === undefined || typeof from !== 'number') return
    events.emit('subagents:source', {
      target: { conversation: from },
      back: { conversation: back },
    })
    switchConversation(from)
  }
  return (
    <Fold
      card={props.entry.id}
      label={`${label()} from ${props.message.from === 'remote' ? 'remote agent' : `#${props.message.from}`} (entry ${props.entry.id})`}
      summary={
        <>
          <Mail class={cn('size-3 shrink-0', accent().name)} />
          <span class={cn('flex min-w-0', accent().name)}>
            <Address id={props.message.from} remote={props.message.remote} />
          </span>
          <span class="shrink-0">{reply() ? 'reply' : `message · ${expectation()}`}</span>
          <Show when={state()}>
            <span class={cn('shrink-0', failureClass())}>· {state()}</span>
          </Show>
          <Show when={delivery() === 'note'}>
            <span class="shrink-0 text-muted-foreground/60">· note</span>
          </Show>
        </>
      }
    >
      <section
        class={cn('group/bubble min-w-0 rounded-lg border', accent().edge, accent().fill)}
        data-message-input={props.message.id}
        data-sender={accent() === accentOf('ultimate') ? 'ultimate' : undefined}
        data-ui="message-card"
      >
        <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <Mail class={cn('size-3.5 shrink-0', accent().name)} />
          <span class={cn('flex min-w-0 font-semibold', accent().name)}>
            <Address id={props.message.from} mark remote={props.message.remote} />
          </span>
          <span>{label()}</span>
          <Show when={!reply()}>
            <span>
              {expectation()}
              {delivery() && ` · ${delivery()}`}
            </span>
          </Show>
          <Show when={state()}>
            <span class={failureClass()}>{state()}</span>
          </Show>
          <Show when={typeof props.message.from === 'number'}>
            <Navigate
              aria-label={`Source conversation #${props.message.from} for message ${props.message.id}`}
              class="ml-auto"
              onClick={openSource}
            >
              Source
            </Navigate>
          </Show>
        </header>
        <Body text={props.message.text} />
        <InputImages entry={props.entry} />
      </section>
    </Fold>
  )
}

function UserTurn(props: { entry: EntryRecord; id: number; text: string }) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const transcript = useTranscript()
  const message = createMemo(() => log()?.messages.find((m) => m.id === props.id))
  const question = createMemo(() => log()?.messages.find((m) => m.id === message()?.re))
  const call = () => question()?.call?.split('/')[0]
  const caller = createMemo(() => {
    const id = call()
    return id ? callerOf(transcript(), id) : undefined
  })
  const input = () => {
    const item = props.entry.model?.[0]
    return item?.role === 'user' ? item : undefined
  }
  const settled = () => (question()?.state === 'dismissed' ? 'dismissed' : 'answered')
  return (
    <Show
      when={caller()}
      fallback={
        <Show when={input()}>
          {(value) => <UserView entry={props.entry} message={value()} text={props.text} />}
        </Show>
      }
    >
      {(source) => (
        <Button
          aria-label={`Show question and answer #${props.id}`}
          class="ml-auto h-auto gap-1.5 p-0 font-mono text-[11px] font-normal text-muted-foreground/70 hover:text-muted-foreground"
          data-compact-answer-ref={props.id}
          onClick={() =>
            events.emit('ultimate:reveal-entry', {
              conversationId: source().conversationId,
              entryId: source().id,
              toolCallId: call(),
            })
          }
          size={null}
          title="Show the question and your answer"
          variant={null}
        >
          <CornerLeftUp class="size-3" />
          {message()?.via
            ? `@ultimate ${settled()} a question for you`
            : `you ${settled()} a question`}
        </Button>
      )}
    </Show>
  )
}
