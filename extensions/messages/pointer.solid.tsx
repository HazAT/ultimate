/** @jsxImportSource @solidjs/web */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { MessageCircleQuestion, SquareArrowOutUpRight } from '@lucide/solid'
import { Show, createMemo } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Card, ROOT, cn, useConversation, useDocOf } from '@/sdk/solid'
import { openMessage, useAccentOf } from './card-parts.solid.tsx'
import { openQuestion } from './data.ts'
import { AnsweredEntry, AskedEntry } from './entries.ts'
import { MessagesDoc } from './refs.ts'
import type { QuestionNotice } from './refs.ts'
import { Address } from './ui.solid.tsx'

export function QuestionPointer(props: { entry: EntryRecord }) {
  return (
    <Show when={AskedEntry.is(props.entry) && props.entry.data}>
      {(asked) => <Pointer asked={asked()} />}
    </Show>
  )
}

function Pointer(props: { asked: QuestionNotice }) {
  const conversation = useConversation()
  const log = useDocOf(() => ROOT, MessagesDoc)
  const outcome = createMemo(
    () =>
      conversation()
        .entries.filter((candidate) => AnsweredEntry.is(candidate))
        .find((entry) => entry.data.message === props.asked.message)?.data,
  )
  const open = () => {
    const message = log()?.messages.find((item) => item.id === props.asked.message)
    return !outcome() && !!message && openQuestion(message)
  }
  const accent = useAccentOf(() => props.asked.from)
  const state = () => {
    const result = outcome()
    if (!result) return undefined
    return `${result.dismissed ? 'dismissed' : 'answered'}${result.via ? ' for you' : ''}`
  }
  const text = () =>
    outcome() ? (outcome()?.dismissed ? undefined : outcome()?.summary) : props.asked.summary
  return (
    <Card attention={open()} data-message-pointer={props.asked.message}>
      <header class="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <MessageCircleQuestion
          class={cn(
            'size-3.5 shrink-0',
            open() ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}
        />
        <span
          class={cn('flex min-w-0 max-w-24 shrink-0 overflow-hidden sm:max-w-48', accent().name)}
        >
          <Address id={props.asked.from} />
        </span>
        <Button
          aria-label={`Open question ${props.asked.message} from #${props.asked.from}`}
          class="h-auto min-w-0 flex-1 justify-start gap-2 p-0 text-left text-[11px] font-normal hover:text-foreground"
          onClick={() =>
            openMessage(props.asked.from, props.asked.call ? { call: props.asked.call } : undefined)
          }
          size={null}
          variant={null}
        >
          <Show when={state()}>
            <span class="shrink-0">{state()}</span>
          </Show>
          <Show when={text()}>
            <span class="min-w-0 flex-1 truncate">{text()}</span>
          </Show>
          <span class="ml-auto flex shrink-0 items-center gap-1">
            <SquareArrowOutUpRight class="size-3" />
            Open
          </span>
        </Button>
      </header>
    </Card>
  )
}
