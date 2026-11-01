/** Info's components for other extensions: the panel's sections, copy buttons, meters and tags. */
import { CheckIcon, ChevronRightIcon, CopyIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn, useCopy, useExtensionUiState } from '@/sdk'

/** A collapsible group of the panel; which ones are closed is kept in durable UI state. */
export function Section({
  id,
  title,
  meta,
  children,
}: {
  id: string
  title: string
  meta?: ReactNode
  children: ReactNode
}) {
  const [closed, setClosed] = useExtensionUiState<string[]>('closed', [])
  return (
    <Collapsible
      className="group/section border-b border-border/60 last:border-b-0"
      onOpenChange={(open) =>
        setClosed((previous) => (open ? previous.filter((item) => item !== id) : [...previous, id]))
      }
      open={!closed.includes(id)}
    >
      <CollapsibleTrigger className="flex h-8 w-full items-center gap-1.5 px-3 section-label transition-colors hover:text-foreground">
        <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]/section:rotate-90" />
        {title}
        {meta !== undefined && (
          <span className="ml-auto truncate pl-2 text-muted-foreground">{meta}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** A value, typically a path, that copies `value` on click. */
export function Copy({
  value,
  children,
  className,
}: {
  value: string
  children?: ReactNode
  className?: string
}) {
  const { copied, copy } = useCopy()
  return (
    <button
      className={cn(
        'group/copy flex min-w-0 items-center gap-1 text-left transition-colors hover:text-foreground',
        className,
      )}
      onClick={() => copy(value)}
      title={`${value}\nclick to copy`}
      type="button"
    >
      <span className="truncate">{children ?? value}</span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0 text-success" />
      ) : (
        <CopyIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-50" />
      )}
    </button>
  )
}

/** A thin meter, for memory and the like. */
export function Meter({ value, className }: { value: number; className?: string }) {
  return (
    <span className="relative h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted">
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full bg-current opacity-70', className)}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  )
}

/** Small monospace tags, such as facets or tool names. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center rounded-sm border border-border/80 px-1.5 font-mono text-[10.5px] text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 max-h-40 overflow-auto rounded-sm border border-error/30 bg-error/8 px-2 py-1.5 font-mono text-[11px] break-words whitespace-pre-wrap text-error">
      {children}
    </div>
  )
}
