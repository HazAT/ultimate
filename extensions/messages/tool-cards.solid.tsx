import { GitBranch, Inbox, Send } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { Show, createMemo } from 'solid-js'
import {
  Card,
  Fold,
  ROOT,
  cn,
  plural,
  useConversationId,
  useDocOf,
  useTranscript,
  type ToolCallView,
} from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.ts'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { Bubble } from './bubble.solid.tsx'
import { callerOf } from './caller.ts'
import { Answers, Body, Navigate, openMessage } from './card-parts.solid.tsx'
import { outgoingState } from './data.ts'
import { MessagesDoc } from './refs.ts'
import { Address } from './ui.solid.tsx'

type CallProps = { call: ToolCallView; core: JSX.Element }
const readable = (call: ToolCallView) => call.status !== 'error' && call.status !== 'interrupted'
const delivery = (id: number | undefined) => (id === undefined ? undefined : { entry: id })

function LeadingIcon(props: { user: boolean; class: string }) {
  return (
    <Show when={props.user} fallback={<Send class={props.class} />}>
      <Inbox class={props.class} />
    </Show>
  )
}

function ErrorLine(props: { error?: string }) {
  return (
    <Show when={props.error}>
      <p class="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] break-words text-destructive">
        {props.error}
      </p>
    </Show>
  )
}

export function MessageCall(props: CallProps) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const sender = useConversationId()
  const transcript = useTranscript()
  const caller = createMemo(() => callerOf(transcript(), props.call.id))
  const sent = createMemo(() => /^Message (\d+) sent\.$/.exec(props.call.output))
  const message = createMemo(() => log()?.messages.find((m) => m.id === Number(sent()?.[1])))
  const args = () =>
    props.call.args as { to?: string; text?: string; reply?: boolean; steer?: boolean }
  const recipient = () => message()?.to ?? (args().to === 'user' ? 'user' : undefined)
  const toUser = () => recipient() === 'user'
  const running = () => props.call.status !== 'done'
  const writing = () => running() && !message() && !args().text
  const state = () => (writing() ? undefined : outgoingState(message(), toUser(), running()))
  const target = () => {
    const id = recipient()
    return typeof id === 'number' && message()?.entry !== undefined ? id : undefined
  }
  const tag = () => {
    const id = recipient()
    return (typeof id === 'number' ? `#${id}` : (id ?? args().to)) || 'recipient'
  }
  const Recipient = () => (
    <Show fallback={args().to ?? '…'} when={recipient()}>
      {(id) => <Address id={id()} remote={message()?.remote} />}
    </Show>
  )
  return (
    <Show fallback={props.core} when={readable(props.call)}>
      <Show
        when={toUser() && sender() !== undefined}
        fallback={
          <Fold
            card={props.call.id}
            label={`Message to ${tag()} (call ${props.call.id})`}
            summary={
              <>
                <LeadingIcon user={toUser()} class="size-3 shrink-0 text-brand" />
                <span class="shrink-0">Message to</span>
                <span class="flex min-w-0 text-foreground/80">
                  <Recipient />
                </span>
                <Show when={writing() || state()}>
                  <span class={cn('shrink-0', state() === 'failed' && 'text-destructive')}>
                    · {writing() ? 'writing' : state()}
                  </span>
                </Show>
              </>
            }
          >
            <Card data-message-outgoing={message()?.id}>
              <header class="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
                <LeadingIcon user={toUser()} class="size-3.5 text-brand" />
                <span>Message to</span>
                <span class="flex min-w-0 text-foreground">
                  <Recipient />
                </span>
                <span>
                  {(message()?.reply ?? args().reply ?? true) ? 'expects reply' : 'one-way'}
                  {args().steer && ' · steer'}
                  <Show when={message()?.images}>
                    {(images) => ` · ${plural(images().count, 'image')}`}
                  </Show>
                </span>
                <Show when={state()}>
                  {(value) => (
                    <span class={value() === 'failed' ? 'text-destructive' : ''}>· {value()}</span>
                  )}
                </Show>
                <Show when={target()}>
                  {(destination) => (
                    <Navigate
                      aria-label={`Open #${destination()}'s message ${message()?.id}`}
                      class="ml-auto"
                      onClick={() => openMessage(destination(), delivery(message()?.entry))}
                    >
                      Open
                    </Navigate>
                  )}
                </Show>
              </header>
              <ErrorLine error={message()?.error} />
              <Body
                pending={writing() ? 'Writing a message…' : undefined}
                text={args().text ?? ''}
              />
              <Show when={message()}>{(item) => <Answers message={item()} />}</Show>
            </Card>
          </Fold>
        }
      >
        <Bubble
          entry={caller()}
          from={sender()!}
          message={message()}
          running={running()}
          text={args().text ?? ''}
        >
          <Show when={message()}>{(item) => <Answers message={item()} />}</Show>
        </Bubble>
      </Show>
    </Show>
  )
}

export function BranchCall(props: CallProps) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const started = createMemo(() =>
    /^Branch #(\d+) started; message (\d+) sent\.$/.exec(props.call.output),
  )
  const id = () => (started() ? parseConversationId(Number(started()?.[1])) : undefined)
  const message = createMemo(() => log()?.messages.find((m) => m.id === Number(started()?.[2])))
  const args = () => props.call.args as { prompt?: string; root?: number; isolated?: boolean }
  const state = () => {
    if (id() === undefined) return 'starting'
    const status = message()?.state
    if (status === 'stopped') return 'stopped by the user'
    if (status === 'answered') return 'reported back'
    return status === 'failed' ? 'failed' : 'working'
  }
  return (
    <Show fallback={props.core} when={readable(props.call)}>
      <Fold
        card={props.call.id}
        label={`Branch ${id() === undefined ? 'startup' : `#${id()}`} (call ${props.call.id})`}
        summary={
          <>
            <GitBranch class="size-3 shrink-0 text-brand" />
            <span class="shrink-0">Branch</span>
            <Show when={id()}>
              {(branch) => (
                <span class="flex min-w-0 text-foreground/80">
                  <ConversationRef id={branch()} />
                </span>
              )}
            </Show>
            <span class={cn('shrink-0', state() === 'failed' && 'text-destructive')}>
              · {state()}
            </span>
          </>
        }
      >
        <Card data-message-branch={id()}>
          <header class="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
            <GitBranch class="size-3.5 shrink-0 text-brand" />
            <span class="shrink-0">
              <span class="max-sm:hidden">Started branch · coordinator</span>
              <span class="sm:hidden">Branch</span>
            </span>
            <Show when={id()}>
              {(branch) => (
                <span class="flex min-w-0 overflow-hidden text-foreground">
                  <ConversationRef class="w-full" id={branch()} />
                </span>
              )}
            </Show>
            <span class="shrink-0 max-sm:hidden">
              {args().root !== undefined && `from #${args().root} · `}
              {(args().isolated ?? true) ? 'isolated' : 'shared'}
              <Show when={message()?.images}>
                {(images) => ` · ${plural(images().count, 'image')}`}
              </Show>
            </span>
            <span class={cn('shrink-0', state() === 'failed' && 'text-destructive')}>
              · {state()}
            </span>
            <Show when={id()}>
              {(branch) => (
                <Navigate
                  aria-label={`Open started branch #${branch()}`}
                  class="ml-auto shrink-0"
                  onClick={() => openMessage(branch(), delivery(message()?.entry))}
                >
                  Open
                </Navigate>
              )}
            </Show>
          </header>
          <ErrorLine error={message()?.error} />
          <Body text={args().prompt ?? ''} />
        </Card>
      </Fold>
    </Show>
  )
}
