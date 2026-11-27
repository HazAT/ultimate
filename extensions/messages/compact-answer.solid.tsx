import type { EntryRecord } from '@earendil-works/pi-durable'
import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { For, Show, createMemo } from 'solid-js'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { ROOT, useCompact, useConversationId, useDocOf } from '@/sdk/solid'
import { Bubble } from './bubble.solid.tsx'
import { Answers } from './card-parts.solid.tsx'
import { answeredMessages, sentBy } from './data.web.ts'
import { MessagesDoc } from './refs.ts'
import { Address } from './ui.solid.tsx'

export const HiddenEntry = () => null

type AnswerProps = { entry: EntryRecord; core: JSX.Element; blocks?: readonly number[] }
const triggerClass =
  'flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/70 hover:text-muted-foreground'

export function CompactAnswer(props: AnswerProps) {
  const compact = useCompact()
  const message = () => {
    const item = props.entry.model?.[0]
    return compact() && item?.role === 'assistant' ? item : undefined
  }
  const text = () =>
    message()
      ?.content.flatMap((block) => (block.type === 'text' && block.text.trim() ? [block.text] : []))
      .join('\n\n') ?? ''
  const tools = createMemo(() => {
    const content = message()?.content ?? []
    return (props.blocks ?? content.map((_, index) => index)).flatMap((index) => {
      const block = content[index]
      return block?.type === 'toolCall' ? [block] : []
    })
  })
  return (
    <Show fallback={props.core} when={message()}>
      {(item) => (
        <Show
          when={item().stopReason === 'stop'}
          fallback={<ScriptMessages core={props.core} entry={props.entry} shown={tools()} />}
        >
          <ReplyFold at={item().timestamp} core={props.core} entry={props.entry} text={text()} />
        </Show>
      )}
    </Show>
  )
}

function ScriptMessages(props: {
  entry: EntryRecord
  core: JSX.Element
  shown: readonly { id: string; name: string }[]
}) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const sent = createMemo(() =>
    props.shown.flatMap((block) =>
      block.name === 'codemode' ? sentBy(log()?.messages ?? [], block.id) : [],
    ),
  )
  return (
    <Show fallback={props.core} when={sent().length}>
      <div class="flex min-w-0 flex-col gap-3">
        <Show fallback={props.core} when={props.shown.every((block) => block.name === 'codemode')}>
          <Collapsible class="group/script">
            <CollapsibleTrigger
              aria-label={`Show codemode script from entry ${props.entry.id}`}
              class={triggerClass}
            >
              sent with codemode
              <ChevronRight class="size-3 transition-transform group-data-open/script:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent class="mt-3">{props.core}</CollapsibleContent>
          </Collapsible>
        </Show>
        <For each={sent()} keyed={(item) => item.id}>
          {(message) => (
            <Bubble
              entry={props.entry}
              from={props.entry.conversationId}
              message={message()}
              running={false}
              text={message().text}
            >
              <Answers message={message()} />
            </Bubble>
          )}
        </For>
      </div>
    </Show>
  )
}

function ReplyFold(props: AnswerProps & { text: string; at: number }) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const answered = createMemo(() =>
    answeredMessages(log()?.messages ?? [], props.entry.conversationId, props.entry.id),
  )
  const agentReply = () =>
    answered().length > 0 && answered().every((m) => m.reply && m.from !== 'user')
  return (
    <Show
      when={agentReply()}
      fallback={
        <Show fallback={props.core} when={props.text}>
          <Bubble
            at={props.at}
            entry={props.entry}
            from={props.entry.conversationId}
            running={false}
            text={props.text}
          />
        </Show>
      }
    >
      <Collapsible class="group/reply">
        <CollapsibleTrigger
          aria-label={`Read agent replies in entry ${props.entry.id}`}
          class={`${triggerClass} flex-wrap`}
        >
          replied to
          <For each={answered()} keyed={(item) => item.id}>
            {(message) => (
              <span class="flex min-w-0">
                <Address id={message().from} remote={message().remote} />
              </span>
            )}
          </For>
          <ChevronRight class="size-3 transition-transform group-data-open/reply:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent class="mt-3">{props.core}</CollapsibleContent>
      </Collapsible>
    </Show>
  )
}

export function MessageAnswerLabel(props: { entry: EntryRecord }) {
  const log = useDocOf(() => ROOT, MessagesDoc)
  const conversation = useConversationId()
  const answers = createMemo(() => {
    const id = conversation()
    return id === undefined ? [] : answeredMessages(log()?.messages ?? [], id, props.entry.id)
  })
  return (
    <For each={answers()} keyed={(message) => message.id}>
      {(message) => (
        <span class="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1 text-muted-foreground">
          {message().reply ? '↩ sent to' : 'not sent · one-way from'}{' '}
          <Address id={message().from} remote={message().remote} />
        </span>
      )}
    </For>
  )
}
