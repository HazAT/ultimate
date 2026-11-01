import { FileDiffIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { Header, StatusLine } from '@/sdk'

/** The surface's frame: its header with `controls`, the body, the status line. */
export function Frame({ controls, children }: { controls?: ReactNode; children: ReactNode }) {
  return (
    <>
      <Header>
        <span className="flex shrink-0 items-center gap-2 text-[0.8125rem] font-medium">
          <FileDiffIcon className="size-4 text-muted-foreground" />
          <span className="max-md:hidden">Review</span>
        </span>
        {controls}
      </Header>
      <div className="flex min-h-0 flex-1">{children}</div>
      <StatusLine />
    </>
  )
}

/** A quiet line in place of the diff: why there is none. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex-1 py-10 text-center font-mono text-[0.7188rem] text-muted-foreground">
      {children}
    </p>
  )
}

/** File list and diff blocks while the diff loads. */
export function Loading() {
  return (
    <>
      <div className="w-64 shrink-0 space-y-2 border-r border-border/70 p-3 max-md:hidden">
        {[60, 80, 70, 50, 75].map((width) => (
          <Skeleton className="h-3.5" key={width} style={{ width: `${width}%` }} />
        ))}
      </div>
      <div className="min-w-0 flex-1 space-y-3 p-4">
        <Skeleton className="h-8" />
        <Skeleton className="h-48" />
        <Skeleton className="h-8" />
        <Skeleton className="h-32" />
      </div>
    </>
  )
}
