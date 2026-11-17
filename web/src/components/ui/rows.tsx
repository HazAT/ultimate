import { cn } from 'cn'
import type { ReactNode } from 'react'

export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        'grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 gap-y-[3px] font-mono text-[11.5px] leading-[1.5]',
        className,
      )}
    >
      {children}
    </dl>
  )
}

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
      <dt className="truncate text-muted-foreground/70">{label}</dt>
      <dd className={cn('flex min-w-0 items-center gap-1.5 text-foreground/85', className)}>
        {children}
      </dd>
    </>
  )
}
