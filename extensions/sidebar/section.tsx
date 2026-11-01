import { ChevronRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/sdk'
import { useSidebarState } from './state.tsx'

/**
 * A folding sidebar section: a quiet mono heading with a count bubble, as automations'
 * Scheduled sections draw theirs, and its rows. `rule` closes it with the hairline the sidebar's groups end with. The fold state is kept per `id`.
 */
export function Section({
  id,
  label,
  count,
  rule,
  children,
}: {
  id: string
  label: string
  count: number
  rule?: boolean
  children: ReactNode
}) {
  const [closed, setClosed] = useSidebarState<string[]>('closedSections', [])
  const open = !closed.includes(id)
  return (
    <Collapsible
      aria-label={label}
      className={cn('flex flex-col gap-px', rule && 'mb-1 border-b border-border/60 pb-1')}
      data-sidebar-section={id}
      onOpenChange={(next) =>
        setClosed((previous) => [...previous.filter((key) => key !== id), ...(next ? [] : [id])])
      }
      open={open}
    >
      <CollapsibleTrigger
        className="group/section mx-2 flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 section-label outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        data-ui="sidebar-section-header"
      >
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/section:rotate-90" />
        {label}
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-px">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** The `+N more` / `fewer` toggle at a section's end, aligned with its rows' titles. */
export function More({
  hidden,
  all,
  onToggle,
}: {
  hidden: number
  all: boolean
  onToggle: () => void
}) {
  return (
    <button
      className="mx-2 h-5 cursor-pointer rounded-md pl-[26px] text-left font-mono text-[0.625rem] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      onClick={onToggle}
      type="button"
    >
      {all ? 'fewer' : `+${hidden} more`}
    </button>
  )
}
