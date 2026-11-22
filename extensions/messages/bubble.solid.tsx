import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { CornerDownRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import { MessageActions, UserText, ROOT, cn, formatAgo, useDocOf, useNow } from '@/sdk/solid'
import { AgentMark, AgentTitle } from '../conversations/ui.solid.tsx'
import { accentOf } from './accent.ts'
import { Address } from './address.solid.tsx'
import { Body, Navigate, openMessage, useAccentOf } from './card-parts.solid.tsx'
import { answerTo, sentStatus } from './data.ts'
import { MessageImages } from './message-images.solid.tsx'
import { MessagesDoc } from './refs.ts'
import type { Message } from './refs.ts'
import { useStandingName } from './standing-name.solid.tsx'

export function Bubble(props: {
  from: ConversationId
  message?: Message
  text?: string
  running: boolean
  entry?: EntryRecord
  at?: number
  children?: JSX.Element
}) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const accent = useAccentOf(() => props.from)
  const status = () => sentStatus(props.message, props.running)
  const writing = () => props.running && !props.message && !props.text
  const answer = createMemo(() => {
    const message = props.message
    return message && answerTo(log()?.messages ?? [], message)
  })
  const attention = () => {
    const state = status()
    return state === 'sending'
      ? !writing()
      : state === 'yours' || state === 'failed' || state === 'stopped' || state === 'dismissed'
  }
  const statusLabel = () => (status() === 'yours' ? 'awaiting your reply' : status())
  return (
    <section
      class="group/bubble mt-2 w-full min-w-0"
      data-message-outgoing={props.message?.id}
      data-compact-bubble
      data-sender={accent() === accentOf('ultimate') ? 'ultimate' : undefined}
      data-ui="message-card"
    >
      <BubbleHeader
        message={props.message?.id}
        at={props.at ?? props.message?.at}
        entry={props.entry}
        from={props.from}
        text={props.text}
      />
      <div class="[&>div]:px-0 [&>div]:pt-1.5 [&>div]:pb-0">
        <Show when={props.text !== undefined}>
          <Body
            pending={writing() ? 'Writing you a message…' : undefined}
            text={props.text ?? ''}
          />
        </Show>
      </div>
      <div
        class="mt-3 overflow-hidden rounded-lg border border-border/70 bg-card/60 empty-row [&>:first-child]:border-t-0"
        data-ui="message-card-body"
      >
        <Show when={props.message?.images}>
          {(images) => <MessageImages conversation={props.from} entry={images().entry} />}
        </Show>
        {props.children}
        <Show when={answer()}>
          {(reply) => <AttachedAnswer answer={reply()} question={props.message!} />}
        </Show>
        <Show when={attention() || props.message?.error}>
          <footer class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
            <Show when={attention()}>
              <span
                class={cn(
                  status() === 'yours' &&
                    'rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300',
                  status() === 'failed' && 'text-destructive',
                )}
              >
                {statusLabel()}
              </span>
            </Show>
            <Show when={props.message?.error}>
              <span class="min-w-0 break-words text-destructive">{props.message?.error}</span>
            </Show>
          </footer>
        </Show>
      </div>
    </section>
  )
}

export function BubbleHeader(props: {
  from: ConversationId
  entry?: EntryRecord
  at?: number
  text?: string
  message?: number
}) {
  const name = useStandingName(() => props.from)
  const accent = useAccentOf(() => props.from)
  const time = () => {
    const stored = props.entry?.model?.[0]
    return props.at ?? (stored && 'timestamp' in stored ? stored.timestamp : 0)
  }
  return (
    <header class="flex h-6 min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
      <Show
        when={name()}
        fallback={
          <span class={cn('flex min-w-0 font-semibold', accent().name)}>
            <Address id={props.from} mark />
          </span>
        }
      >
        {(agent) => (
          <span class="flex shrink-0 items-center gap-2" title={`@${agent()}`}>
            <AgentMark name={agent()} />
            <span
              class={cn('font-sans text-[13px] font-semibold tracking-[-0.005em]', accent().name)}
            >
              <AgentTitle name={agent()} />
            </span>
          </span>
        )}
      </Show>
      <Show
        when={props.entry}
        fallback={
          <Show when={props.at !== undefined}>
            <Time at={props.at!} class="ml-auto shrink-0" />
          </Show>
        }
      >
        {(entry) => (
          <MessageActions
            bubble
            class="ml-auto min-w-0 flex-nowrap justify-end overflow-hidden whitespace-nowrap"
            entry={entry()}
            name={props.message === undefined ? undefined : `board message #${props.message}`}
            text={props.text ?? ''}
            timestamp={time()}
          />
        )}
      </Show>
    </header>
  )
}

function Time(props: { at: number; class: string }) {
  const now = useNow(60_000)
  return (
    <time
      class={props.class}
      datetime={new Date(props.at).toISOString()}
      title={new Date(props.at).toLocaleString()}
    >
      {formatAgo(props.at, now())}
    </time>
  )
}

function AttachedAnswer(props: { answer: Message; question: Message }) {
  const accent = accentOf('user')
  const dismissed = () => props.question.state === 'dismissed'
  const via = () => props.answer.via
  const settled = () => (dismissed() ? 'dismissed' : 'answered')
  const label = () =>
    via()
      ? `@ultimate ${settled()} ${dismissed() ? 'it ' : ''}for you`
      : `You ${settled()}${dismissed() ? ' it' : ''}`
  return (
    <div class="border-t border-border/60 px-3 py-2.5" data-compact-answer={props.answer.id}>
      <div class="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <CornerDownRight class={cn('size-3.5 shrink-0', accent.name)} />
        <span class={cn('font-semibold', accent.name)}>{label()}</span>
        <Show when={via()?.entry !== undefined}>
          <Navigate
            aria-label={`Read your message #${via()!.entry} behind answer ${props.answer.id}`}
            data-settled-from={via()!.entry}
            onClick={() => {
              const ref = via()!
              openMessage(ref.conversation, { entry: ref.entry! })
            }}
            title="Show what you said that @ultimate read this from"
          >
            from your message
          </Navigate>
        </Show>
        <Time at={props.answer.at} class="ml-auto" />
      </div>
      <Show when={!dismissed() || via()}>
        <UserText
          class="mt-1.5 rounded-md border border-border/70 bg-secondary/60 px-3 py-2 text-[13px] leading-relaxed"
          text={props.answer.text}
        />
      </Show>
    </div>
  )
}
