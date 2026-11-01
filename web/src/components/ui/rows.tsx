import { cn } from 'cn'
import type { ReactNode } from 'react'

/** Label/value rows with aligned values, as the Info panel shows them. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 gap-y-[3px] font-mono text-[0.7188rem] leading-[1.5]',
        className,
      )}
    >
      {children}
    </dl>
  )
}

/** One muted label and its value. */
export function Row({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <>
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className={cn('flex min-w-0 items-center gap-1.5 text-foreground/85', className)}>
        {children}
      </dd>
    </>
  )
}
