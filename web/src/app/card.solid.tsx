import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { omit } from 'solid-js'

export function Card(props: JSX.IntrinsicElements['section'] & { attention?: boolean }) {
  const rest = omit(props, 'class', 'attention')
  return (
    <section
      {...rest}
      class={cn(
        'min-w-0 rounded-md border border-border border-l-2 border-l-brand/50 bg-muted/20',
        props.attention && 'border-brand/40 border-l-brand bg-brand/5',
        props.class,
      )}
      data-attention={props.attention || undefined}
      data-ui="card"
    />
  )
}
