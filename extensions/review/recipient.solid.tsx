import type { ConversationId } from '@earendil-works/pi-durable'
import { ChevronDownIcon, SendIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { ROOT, cn, useConversations, useDocOf } from '@/sdk/solid'
import { Address } from '../messages/ui.solid.tsx'
import { StandingDoc } from '../subagents/ui.solid.tsx'

export function Recipient(props: {
  value?: ConversationId
  onChange: (id: ConversationId) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal<string>()
  const standing = useDocOf(() => ROOT, StandingDoc)
  const agents = createMemo(() => Object.entries(standing() ?? {}))
  const conversations = useConversations()
  const needle = createMemo(() => query().trim().toLowerCase())
  const matches = (id: ConversationId, ...texts: (string | undefined)[]) =>
    !needle() || [`#${id}`, ...texts].some((text) => text?.toLowerCase().includes(needle()))
  const shownAgents = createMemo(() => agents().filter(([name, id]) => matches(id, name)))
  const recent = createMemo(() => {
    const ids = new Set(agents().map(([, id]) => id))
    return conversations()
      .filter((conversation) => !conversation.parentConversationId && !ids.has(conversation.id))
      .toSorted((a, b) => (b.inputAt ?? b.id) - (a.inputAt ?? a.id))
      .filter((conversation) => matches(conversation.id, conversation.title, conversation.label))
      .slice(0, 30)
  })
  const startAt = () => {
    const first = shownAgents()[0]?.[1] ?? recent()[0]?.id
    return first === undefined ? undefined : String(first)
  }
  const changeQuery = (next: string) => {
    setQuery(next)
    setHighlight(undefined)
  }
  return (
    <Popover onOpenChange={setOpen} open={open()}>
      <PopoverTrigger
        aria-label="Choose review recipient"
        class="flex h-7 max-w-64 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[11.5px] text-muted-foreground hover:bg-accent/60"
        data-review-recipient={props.value}
        title="Who the review goes to"
      >
        <SendIcon class="size-3 shrink-0" />
        <span class="max-md:hidden">to</span>
        <span class="flex min-w-0 truncate text-foreground/90">
          <Show when={props.value} fallback="…">
            {(id) => <Address id={id()} />}
          </Show>
        </span>
        <ChevronDownIcon class="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="end" class="w-[min(24rem,calc(100vw-1rem))] p-0">
        <Command
          autoHighlight={false}
          filter={false}
          onAction={(value) => {
            const id =
              shownAgents().find(([, agentId]) => String(agentId) === value)?.[1] ??
              recent().find((conversation) => String(conversation.id) === value)?.id
            if (id === undefined) return
            setOpen(false)
            changeQuery('')
            props.onChange(id)
          }}
          onQueryChange={changeQuery}
          onValueChange={setHighlight}
          query={query()}
          value={highlight() ?? startAt()}
        >
          <CommandInput
            aria-label="Search review recipients"
            class="font-mono text-[12.5px]"
            placeholder="Send the review to…"
          />
          <CommandList class="max-h-[60vh]">
            <Show when={shownAgents().length}>
              <CommandGroup heading="Agents">
                <For each={shownAgents()} keyed={([name]) => name}>
                  {(agent) => (
                    <CommandItem
                      class={cn(
                        'gap-2 py-1 text-[12.5px]',
                        agent()[1] === props.value && 'text-brand',
                      )}
                      value={String(agent()[1])}
                    >
                      <span class="font-mono">@{agent()[0]}</span>
                    </CommandItem>
                  )}
                </For>
              </CommandGroup>
            </Show>
            <Show when={recent().length}>
              <CommandGroup heading="Conversations">
                <For each={recent()} keyed={(conversation) => conversation.id}>
                  {(conversation) => (
                    <CommandItem
                      aria-label={`Send review to conversation #${conversation().id}`}
                      class={cn(
                        'gap-2 py-1 text-[12.5px]',
                        conversation().id === props.value && 'text-brand',
                      )}
                      value={String(conversation().id)}
                    >
                      <Address id={conversation().id} />
                    </CommandItem>
                  )}
                </For>
              </CommandGroup>
            </Show>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
