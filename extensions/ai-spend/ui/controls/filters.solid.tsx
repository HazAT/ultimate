import { PlusIcon, XIcon } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { cn } from '@/sdk/solid'
import { DIMENSIONS } from '../../model/dimensions.ts'
import type { Dimension, Filter } from '../../model/dimensions.ts'
import { usd } from '../../model/format.ts'
import { group } from '../../model/groups.ts'
import type { SpendData } from '../../model/types.ts'
import { dimensions } from '../../model/view.ts'
import { quiet } from '../parts.solid.tsx'

export function Chip(props: { dimension: Dimension; values: string[]; onRemove: () => void }) {
  const name = () => DIMENSIONS[props.dimension].toLowerCase()
  return (
    <span
      class="inline-flex h-6 max-w-80 items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 pr-0.5 pl-2 font-mono text-[11px]"
      data-spend-chip={props.dimension}
    >
      <span class="shrink-0 text-muted-foreground">{name()}</span>
      <span class="min-w-0 truncate text-foreground" title={props.values.join(', ')}>
        {props.values.join(', ')}
      </span>
      <Button
        aria-label={`Remove the ${name()} filter`}
        class="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => props.onRemove()}
        size={null}
        variant={null}
      >
        <XIcon class="size-3" />
      </Button>
    </span>
  )
}

const DIMENSION = 'dimension:'
const VALUE = 'value:'

export function AddFilter(props: {
  data: SpendData
  filter: Filter
  onAdd: (dimension: Dimension, key: string) => void
  label: (dimension: Dimension, key: string) => string
}) {
  const [open, setOpen] = createSignal(false)
  const [dimension, setDimension] = createSignal<Dimension>()
  const [query, setQuery] = createSignal('')
  const values = createMemo(() => {
    const picked = dimension()
    if (!open() || !picked) return []
    const { [picked]: _, ...rest } = props.filter
    return group(props.data, rest, picked)
  })
  const close = () => {
    setOpen(false)
    setDimension(undefined)
    setQuery('')
  }
  const run = (value: string) => {
    const picked = dimension()
    if (value.startsWith(DIMENSION)) {
      setDimension(value.slice(DIMENSION.length) as Dimension)
      setQuery('')
    } else if (picked && value.startsWith(VALUE)) {
      props.onAdd(picked, value.slice(VALUE.length))
      close()
    }
  }
  return (
    <Popover
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else close()
      }}
      open={open()}
    >
      <PopoverTrigger class={quiet}>
        <PlusIcon class="size-3" />
        filter
      </PopoverTrigger>
      <PopoverContent align="start" aria-label="Add a filter" class="w-80 p-0">
        <Command onAction={run} onQueryChange={setQuery} query={query()}>
          <CommandInput
            aria-label={
              dimension()
                ? `Search ${DIMENSIONS[dimension()!]} values`
                : 'Search dimensions to filter by'
            }
            class="h-9 font-mono text-[12px]"
            placeholder={dimension() ? `${DIMENSIONS[dimension()!]}…` : 'Filter by…'}
          />
          <CommandList>
            <Show
              when={dimension()}
              fallback={
                <CommandGroup heading="Dimension">
                  <For each={dimensions}>
                    {(next) => (
                      <CommandItem
                        class="font-mono text-[11.5px]"
                        label={DIMENSIONS[next]}
                        value={`${DIMENSION}${next}`}
                      >
                        {DIMENSIONS[next]}
                        <Show when={props.filter[next]?.length}>
                          {(count) => <span class="ml-auto text-brand">{count()}</span>}
                        </Show>
                      </CommandItem>
                    )}
                  </For>
                </CommandGroup>
              }
            >
              {(picked) => (
                <CommandGroup heading={DIMENSIONS[picked()]}>
                  <For each={values()} keyed={(value) => value.key}>
                    {(value) => {
                      const shown = () => props.label(picked(), value().key)
                      return (
                        <CommandItem
                          class="gap-2 font-mono text-[11.5px]"
                          label={`${shown()} ${value().key}`}
                          value={`${VALUE}${value().key}`}
                        >
                          <span
                            class={cn(
                              'min-w-0 truncate',
                              props.filter[picked()]?.includes(value().key) && 'text-brand',
                            )}
                          >
                            {shown()}
                          </span>
                          <span class="ml-auto shrink-0 text-muted-foreground tabular-nums">
                            {usd(value().usd)}
                          </span>
                        </CommandItem>
                      )
                    }}
                  </For>
                </CommandGroup>
              )}
            </Show>
          </CommandList>
          <CommandEmpty class="py-5 text-center font-mono text-[11.5px] text-muted-foreground">
            nothing matches
          </CommandEmpty>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
