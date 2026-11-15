import { cn } from 'cn'
import type { ComponentProps } from 'react'

export function Card({
  className,
  attention,
  ...props
}: ComponentProps<'section'> & { attention?: boolean }) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20',
        attention && 'border-brand/40 border-l-brand bg-brand/5',
        className,
      )}
      data-attention={attention || undefined}
      data-ui="card"
      {...props}
    />
  )
}
