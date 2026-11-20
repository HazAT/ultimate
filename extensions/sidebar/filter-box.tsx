import { SearchIcon, XIcon } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'

/** The `/` command's target: the sidebar's filter field. */
export const focusFilter = () =>
  document.querySelector<HTMLInputElement>('[data-sidebar-filter]')?.focus()

/**
 * The quiet field above In flight that filters every group of the tree (see `filter.ts`). `/` focuses it, Escape
 * clears it, Enter opens the first match.
 */
export function FilterBox({
  query,
  empty,
  onChange,
  onOpenFirst,
}: {
  query: string
  /** Nothing matches the query. */
  empty: boolean
  onChange: (query: string) => void
  onOpenFirst: () => void
}) {
  return (
    <div className="mx-2 mb-1">
      <label className="group/filter flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground/70 transition-colors focus-within:bg-sidebar-accent/60 focus-within:text-foreground hover:bg-sidebar-accent/40">
        <SearchIcon className="size-3 shrink-0" />
        <input
          aria-label="Filter conversations"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
          data-sidebar-filter
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              if (query) onChange('')
              else event.currentTarget.blur()
            }
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && query) onOpenFirst()
          }}
          placeholder="Filter conversations"
          spellCheck={false}
          value={query}
        />
        {query ? (
          <button
            aria-label="Clear the filter"
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:text-foreground"
            onClick={() => onChange('')}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
        ) : (
          <Kbd className="max-md:hidden group-focus-within/filter:hidden">/</Kbd>
        )}
      </label>
      {empty && (
        <p
          className="px-2 pt-1 pb-1.5 font-mono text-[10px] text-muted-foreground/70"
          role="status"
        >
          No conversation matches
        </p>
      )}
    </div>
  )
}
