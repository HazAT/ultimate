import { ChevronDownIcon, CornerDownLeftIcon } from 'lucide-react'
import { Fragment, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn, useAction } from '@/sdk'
import { RangesAction } from './refs.ts'
import type { ReviewRange } from './refs.ts'

/** A spec as a short label: shas cut to seven characters. */
export const shortSpec = (spec: string) => spec.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1')

/** The spec on screen as a button; it opens the recent choices to filter, or takes any spec typed in. */
export function Selector({
  spec,
  title,
  onChange,
}: {
  spec: string
  title?: string
  onChange: (spec: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ranges = useAction(RangesAction, null, { enabled: open })
  const list = ranges.data ?? []
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? list.filter((range) =>
        [range.spec, range.label, range.detail ?? ''].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : list
  const groups = Map.groupBy(shown, (range) => range.group)
  const choose = (next: string) => {
    setOpen(false)
    setQuery('')
    onChange(next)
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[0.75rem] hover:bg-accent/60"
          title="Choose what to review"
          type="button"
        >
          <span className="shrink-0 text-foreground/90">{shortSpec(spec)}</span>
          {title && title !== spec && (
            <span className="min-w-0 truncate font-sans text-[0.7812rem] text-muted-foreground max-md:hidden">
              {title}
            </span>
          )}
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(32rem,calc(100vw-1rem))] p-0">
        <Command
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:section-label"
          shouldFilter={false}
        >
          <CommandInput
            className="font-mono text-[0.7812rem]"
            onValueChange={setQuery}
            placeholder="uncommitted, <sha>, <a>...<b>, branch:<name>"
            value={query}
          />
          <CommandList className="max-h-[60vh]">
            {needle && (
              <CommandGroup heading="Spec">
                <CommandItem
                  className="gap-2 py-1 font-mono text-[0.75rem]"
                  onSelect={() => choose(query.trim())}
                  value={`spec:${query}`}
                >
                  <CornerDownLeftIcon className="size-3.5" />
                  Review {query.trim()}
                </CommandItem>
              </CommandGroup>
            )}
            {ranges.loading && !ranges.data && (
              <p className="px-3 py-3 font-mono text-[0.7188rem] text-muted-foreground">loading…</p>
            )}
            {!needle && ranges.data && list.length === 0 && (
              <CommandEmpty className="py-6 text-center text-[0.75rem] text-muted-foreground">
                Nothing recent.
              </CommandEmpty>
            )}
            {[...groups].map(([group, items]) => (
              <Fragment key={group}>
                <CommandGroup heading={group}>
                  {items.map((range) => (
                    <Choice
                      current={range.spec === spec}
                      key={range.spec}
                      onSelect={() => choose(range.spec)}
                      range={range}
                    />
                  ))}
                </CommandGroup>
              </Fragment>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Choice({
  range,
  current,
  onSelect,
}: {
  range: ReviewRange
  current: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem className="gap-2 py-1 text-[0.7812rem]" onSelect={onSelect} value={range.spec}>
      <span className={cn('min-w-0 flex-1 truncate', current && 'text-brand')}>{range.label}</span>
      {range.detail && (
        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
          {range.detail}
        </span>
      )}
    </CommandItem>
  )
}
