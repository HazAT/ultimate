/** @jsxImportSource @solidjs/web */
import { Check, ChevronsUpDown } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { cn, useModels } from '@/sdk/solid'
import { modelIdOf } from './family-state.ts'
import { matchesEveryQueryTerm, modelKey, termsOf } from './state.ts'
import { ModelRow } from './model-row.solid.tsx'

const LIMIT = 150
const INHERIT = 'inherit'

export function ModelSelect(props: {
  name: string
  class?: string
  value: string | undefined
  placeholder?: string
  inherit?: string
  onChange: (value: string | undefined) => void
  compact?: boolean
}) {
  const models = useModels()
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal<string | null>()
  const terms = createMemo(() => termsOf(query()))
  const found = createMemo(() =>
    (models()?.models ?? [])
      .filter((model) =>
        terms().length
          ? matchesEveryQueryTerm(model, terms())
          : model.available || modelKey(model) === props.value,
      )
      .toSorted((a, b) => Number(b.available) - Number(a.available))
      .slice(0, LIMIT),
  )
  const groups = createMemo(() => [...Map.groupBy(found(), (model) => model.provider)])
  const inherit = () => !query() && props.inherit
  const startAt = () => {
    const selected = props.value
    if (!query() && selected && found().some((model) => modelKey(model) === selected))
      return selected
    return inherit() ? INHERIT : found()[0] && modelKey(found()[0])
  }
  function search(value: string) {
    setQuery(value)
    setHighlight(undefined)
  }
  return (
    <Popover open={open()} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={`Choose model for ${props.name}`}
        class={cn(props.class, 'flex items-center gap-2 text-left font-mono')}
        title={props.value}
      >
        <Show
          when={props.value}
          fallback={
            <span class="min-w-0 truncate text-muted-foreground">
              {props.placeholder ?? 'Pick a model'}
            </span>
          }
        >
          {(value) => (
            <span class="min-w-0 truncate">
              <span class="text-muted-foreground">
                {value().slice(0, value().indexOf('/') + 1)}
              </span>
              {modelIdOf(value())}
            </span>
          )}
        </Show>
        <ChevronsUpDown class="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" class="w-[min(34rem,90vw)] p-0">
        <Command
          autoHighlight={false}
          class="[&_[data-slot=command-group-label]]:pt-2 [&_[data-slot=command-group-label]]:pb-1 [&_[data-slot=command-group-label]]:section-label"
          filter={false}
          onAction={(value) => {
            props.onChange(value === INHERIT ? undefined : value)
            setOpen(false)
            search('')
          }}
          onQueryChange={search}
          onValueChange={setHighlight}
          query={query()}
          value={highlight() ?? startAt()}
        >
          <CommandInput
            aria-label={`Search catalog for ${props.name}`}
            class="text-[13px]"
            placeholder={`Search ${(models()?.models.length ?? 0).toLocaleString()} models…`}
          />
          <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
            No model matches.
          </CommandEmpty>
          <CommandList class="max-h-[45vh]">
            <Show when={inherit()}>
              {(label) => (
                <CommandGroup heading={props.compact ? 'Main conversation' : 'Default'}>
                  <CommandItem class="gap-2 py-1 font-mono text-[12px]" value={INHERIT}>
                    <Check class={cn('size-3.5', props.value ? 'opacity-0' : 'text-brand')} />
                    {label()}
                  </CommandItem>
                </CommandGroup>
              )}
            </Show>
            <For each={groups()} keyed={([provider]) => provider}>
              {(group) => (
                <CommandGroup heading={group()[0]}>
                  <For each={group()[1]} keyed={modelKey}>
                    {(model) => (
                      <ModelRow
                        compact={props.compact}
                        current={modelKey(model()) === props.value}
                        model={model()}
                      />
                    )}
                  </For>
                </CommandGroup>
              )}
            </For>
          </CommandList>
          <div class="border-t border-border/70 px-3 py-1.5 text-[11px] text-muted-foreground">
            {query() ? 'all providers' : 'logged-in providers · type to search all'}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
