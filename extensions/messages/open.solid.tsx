/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Hourglass } from '@lucide/solid'
import { createMemo, createSignal, For, mapArray, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import {
  useProvided,
  ROOT,
  formatAgo,
  switchConversation,
  useConversationId,
  useConversations,
  useDocOf,
  useNow,
} from '@/sdk/solid'
import { OverviewDoc } from '../conversations/refs.ts'
import { useConcluded } from '../conversations/ui.solid.tsx'
import { WorkspacesDoc } from '../workspaces/refs.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { openMessages } from './data.ts'
import { WaitTimers } from './points.ts'
import { MessagesDoc, StartedDoc } from './refs.ts'
import type { Message } from './refs.ts'
import { Address } from './ui.solid.tsx'
import { underwayOf } from './working.ts'

const gist = (text: string) => text.replace(/\s+/g, ' ').trim()

function Section(props: {
  title: string
  messages: Message[]
  side: 'to' | 'from'
  now: number
  open: (id: ConversationId) => void
}) {
  return (
    <Show when={props.messages.length}>
      <div class="grid gap-0.5">
        <div class="px-1.5 section-label">{props.title}</div>
        <For each={props.messages} keyed={(message) => message.id}>
          {(message) => {
            const counterpart = () => message()[props.side]
            return (
              <Button
                aria-label={`${props.title} · message #${message().id}`}
                class="grid w-full min-w-0 gap-0.5 rounded-sm px-1.5 py-1 text-left font-[inherit] text-[length:inherit] font-normal hover:bg-accent"
                disabled={typeof counterpart() !== 'number'}
                onClick={() => {
                  const target = counterpart()
                  if (typeof target === 'number') props.open(target)
                }}
                size={null}
                variant={null}
              >
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="min-w-0 truncate font-sans">
                    <Address id={counterpart()} remote={message().remote} />
                  </span>
                  <span class="ml-auto shrink-0 text-muted-foreground">
                    {formatAgo(message().at, props.now)}
                  </span>
                </span>
                <span class="truncate text-muted-foreground">{gist(message().text)}</span>
              </Button>
            )
          }}
        </For>
      </div>
    </Show>
  )
}

export function OpenMessages() {
  const id = useConversationId()
  const log = useDocOf(() => ROOT, MessagesDoc)
  const concluded = useConcluded()
  const conversations = useConversations()
  const overview = useDocOf(() => ROOT, OverviewDoc)
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const underway = createMemo(() =>
    underwayOf(conversations(), overview()?.conversations, workspaces()?.queue),
  )
  const starters = mapArray(
    () =>
      conversations()
        .filter((c) => c.branchOf)
        .map((c) => c.id),
    (branchId) => {
      const started = useDocOf(() => branchId, StartedDoc)
      return () => ({ id: branchId, starter: started()?.by })
    },
  )
  const timers = useProvided(WaitTimers, () => null)
  const now = useNow(30_000)
  const [shown, setShown] = createSignal(false)
  const open = createMemo(() => {
    const current = id()
    if (current === undefined) return undefined
    const branches = starters().map((starter) => {
      const branch = starter()
      return {
        ...branch,
        working: underway()(branch.id),
        concluded: concluded().includes(branch.id),
      }
    })
    return openMessages(log()?.messages ?? [], current, branches, timers())
  })
  const counts = createMemo(() => {
    const messages = open()
    if (!messages) return ''
    const { waiting, requests, delivering, owed } = messages
    return [
      waiting.length && `${waiting.length} waiting`,
      requests.length + owed.length > 0 && `${requests.length + owed.length} owed`,
      delivering.length && `${delivering.length} delivering`,
    ]
      .filter(Boolean)
      .join(' · ')
  })
  const go = (to: ConversationId) => {
    setShown(false)
    switchConversation(to)
  }
  return (
    <Show when={counts()}>
      <Popover onOpenChange={setShown} open={shown()}>
        <PopoverTrigger
          aria-label={`Open messages for #${id()}`}
          class="flex items-center gap-1.5 transition-colors hover:text-foreground max-md:hidden"
          data-open-messages
          title="Open messages"
        >
          <Hourglass class="size-3 text-amber-700/80 dark:text-amber-300/70" />
          {counts()}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Waiting, owed and delivering messages"
          class="grid w-80 gap-2.5 p-1.5 font-mono text-[11px]"
          side="top"
        >
          <Section
            messages={open()?.waiting ?? []}
            now={now()}
            open={go}
            side="to"
            title="Waiting on"
          />
          <Section
            messages={open()?.requests ?? []}
            now={now()}
            open={go}
            side="from"
            title="You owe an answer to"
          />
          <Show when={open()?.owed.length}>
            <div class="grid gap-0.5">
              <div class="px-1.5 section-label">Branches waiting on you</div>
              <For each={open()?.owed} keyed={(branch) => branch.id}>
                {(branch) => (
                  <Button
                    class="block min-w-0 truncate rounded-sm px-1.5 py-1 text-left font-[inherit] text-[length:inherit] font-normal hover:bg-accent"
                    onClick={() => go(parseConversationId(branch().id))}
                    size={null}
                    variant={null}
                  >
                    #{branch().id} ·{' '}
                    {conversations().find((c) => c.id === branch().id)?.title ?? 'Branch'}
                  </Button>
                )}
              </For>
            </div>
          </Show>
          <Section
            messages={open()?.delivering ?? []}
            now={now()}
            open={go}
            side="to"
            title="Delivering to"
          />
        </PopoverContent>
      </Popover>
    </Show>
  )
}
