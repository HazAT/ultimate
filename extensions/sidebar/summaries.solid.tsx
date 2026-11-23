import type { ConversationId } from '@earendil-works/pi-durable'
import type { JSX } from '@solidjs/web'
import { createSignal, For, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card.solid.tsx'
import { ROOT, cn, formatAgo, formatTime, keepLast, useAction } from '@/sdk/solid'
import { SummariesAction } from '../conversations/refs.ts'

export function SummaryHistory(props: {
  id: ConversationId
  title: string
  shown: boolean
  class: string
  inFlight?: boolean
  rowRef?: (element: HTMLButtonElement) => void
  children: JSX.Element
  onOpen: () => void
}) {
  const [open, setOpen] = createSignal(false)
  let list: HTMLOListElement | undefined
  return (
    <HoverCard closeDelay={100} delay={600} open={open()} onOpenChange={setOpen}>
      <HoverCardTrigger
        aria-label={`Summary history of #${props.id}`}
        class={
          props.inFlight ? 'mx-2 flex w-[calc(100%-1rem)] min-w-0' : 'flex h-full min-w-0 flex-1'
        }
        onKeyDown={(event) => {
          if (!open() || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
          event.preventDefault()
          list?.scrollBy({ top: event.key === 'ArrowDown' ? 48 : -48 })
        }}
        render={(trigger) => <span {...trigger} />}
      >
        <Button
          aria-current={props.shown ? 'true' : undefined}
          aria-label={`${props.title} · #${props.id}`}
          class={cn(props.class, 'font-normal whitespace-normal')}
          data-in-flight={props.inFlight ? props.id : undefined}
          onClick={props.onOpen}
          ref={props.rowRef}
          size={null}
          variant={null}
        >
          {props.children}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        class="w-80 p-0"
        collisionPadding={8}
        data-summary-history={props.id}
        side="right"
      >
        <p class="border-b border-border/50 px-3 py-1.5 font-mono text-[10px] break-words text-muted-foreground">
          {props.title} · #{props.id}
        </p>
        <Show when={open() && props.id} keyed>
          {(id) => (
            <History
              id={id}
              list={(element) => {
                list = element
              }}
            />
          )}
        </Show>
      </HoverCardContent>
    </HoverCard>
  )
}

function History(props: { id: ConversationId; list: (element: HTMLOListElement) => void }) {
  const { data, loading } = useAction(
    SummariesAction,
    {
      get id() {
        return props.id
      },
    },
    { conversation: ROOT, onError: keepLast },
  )
  const now = Date.now()
  return (
    <Switch>
      <Match when={!data()}>
        <p class="px-3 py-2 text-[11px] text-muted-foreground">
          {loading() ? 'Loading summaries…' : 'Summaries unavailable'}
        </p>
      </Match>
      <Match when={!data()?.length}>
        <p class="px-3 py-2 text-[11px] text-muted-foreground">No summary yet</p>
      </Match>
      <Match when={data()}>
        <ol
          aria-label="Summary history"
          class="max-h-72 overflow-y-auto overscroll-contain py-1"
          ref={props.list}
        >
          <For each={data()} keyed={(record) => `${record.at ?? 'now'}-${record.summary}`}>
            {(record, index) => (
              <li class="border-b border-border/50 px-3 py-1.5 last:border-b-0">
                <div class="flex items-baseline gap-2 font-mono text-[10px] text-muted-foreground/80">
                  <Show when={index() === 0}>
                    <span class="text-foreground/80">Latest</span>
                  </Show>
                  <Show when={record().at}>
                    {(at) => (
                      <time
                        class="ml-auto"
                        datetime={new Date(at()).toISOString()}
                        title={new Date(at()).toLocaleString()}
                      >
                        {formatAgo(at(), now)} · {formatTime(at())}
                      </time>
                    )}
                  </Show>
                </div>
                <p
                  class={cn(
                    'text-xs leading-relaxed break-words',
                    index() === 0 ? 'text-foreground/90' : 'text-muted-foreground',
                  )}
                >
                  {record().summary}
                </p>
              </li>
            )}
          </For>
        </ol>
      </Match>
    </Switch>
  )
}
