import type { ConversationId } from '@earendil-works/pi-durable'
import { ChevronDownIcon, CornerDownLeftIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { cn, useAction } from '@/sdk/solid'
import { shortSpec } from './comments.ts'
import { RangesAction } from './refs.ts'
import type { ReviewRange } from './refs.ts'

type SelectorProps = {
  spec: string
  title?: string
  conversation?: ConversationId
  onChange: (spec: string) => void
}

export function Selector(props: SelectorProps) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  return (
    <Popover onOpenChange={setOpen} open={open()}>
      <PopoverTrigger
        aria-label="Choose what to review"
        class="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[12px] hover:bg-accent/60"
        title="Choose what to review"
      >
        <span class="shrink-0 text-foreground/90">{shortSpec(props.spec)}</span>
        {props.title && props.title !== props.spec && (
          <span class="min-w-0 truncate font-sans text-[12.5px] text-muted-foreground max-md:hidden">
            {props.title}
          </span>
        )}
        <ChevronDownIcon class="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" class="w-[min(32rem,calc(100vw-1rem))] p-0">
        <Show when={open()}>
          <Ranges
            conversation={props.conversation}
            onChange={(next) => {
              setOpen(false)
              setQuery('')
              props.onChange(next)
            }}
            query={query()}
            setQuery={setQuery}
            spec={props.spec}
          />
        </Show>
      </PopoverContent>
    </Popover>
  )
}

function Ranges(
  props: Omit<SelectorProps, 'title'> & { query: string; setQuery: (query: string) => void },
) {
  const ranges = useAction(RangesAction, {
    get conversation() {
      return props.conversation
    },
  })
  const [highlight, setHighlight] = createSignal<string>()
  const custom = () => props.query.trim()
  const shown = createMemo(() => {
    const list = ranges.data() ?? []
    const needle = custom().toLowerCase()
    return needle
      ? list.filter((range) =>
          [range.spec, range.label, range.detail ?? ''].some((text) =>
            text.toLowerCase().includes(needle),
          ),
        )
      : list
  })
  const groups = createMemo(() => [...Map.groupBy(shown(), (range) => range.group)])
  const startAt = () =>
    custom() ? 'custom' : groups()[0]?.[1][0] && `range:${groups()[0][1][0].spec}`
  return (
    <Command
      autoHighlight={false}
      class="[&_[data-slot=command-group-label]]:px-2 [&_[data-slot=command-group-label]]:pt-2 [&_[data-slot=command-group-label]]:pb-1 [&_[data-slot=command-group-label]]:section-label"
      filter={false}
      onAction={(next) => props.onChange(next === 'custom' ? custom() : next.slice(6))}
      onQueryChange={(next) => {
        props.setQuery(next)
        setHighlight(undefined)
      }}
      onValueChange={setHighlight}
      query={props.query}
      value={highlight() ?? startAt()}
    >
      <CommandInput
        aria-label="Find a review range"
        class="font-mono text-[12.5px]"
        placeholder="uncommitted, <sha>, <a>...<b>, branch:<name>"
      />
      <CommandList class="max-h-[60vh]">
        {custom() && (
          <CommandGroup heading="Spec">
            <CommandItem class="gap-2 py-1 font-mono text-[12px]" value="custom">
              <CornerDownLeftIcon class="size-3.5" />
              Review {custom()}
            </CommandItem>
          </CommandGroup>
        )}
        {ranges.loading() && !ranges.data() && (
          <p class="px-3 py-3 font-mono text-[11.5px] text-muted-foreground">loading…</p>
        )}
        {!custom() && ranges.data() && !shown().length && (
          <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
            Nothing recent.
          </CommandEmpty>
        )}
        <For each={groups()} keyed={([group]) => group}>
          {(group) => (
            <CommandGroup heading={group()[0]}>
              <For each={group()[1]} keyed={(range) => range.spec}>
                {(range) => <Choice current={range().spec === props.spec} range={range()} />}
              </For>
            </CommandGroup>
          )}
        </For>
      </CommandList>
    </Command>
  )
}

function Choice(props: { range: ReviewRange; current: boolean }) {
  return (
    <CommandItem class="gap-2 py-1 text-[12.5px]" value={`range:${props.range.spec}`}>
      <span class={cn('min-w-0 flex-1 truncate', props.current && 'text-brand')}>
        {props.range.label}
      </span>
      {props.range.detail && (
        <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
          {props.range.detail}
        </span>
      )}
    </CommandItem>
  )
}
