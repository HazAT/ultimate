import type { JSX } from '@solidjs/web'
import { cn } from 'cn'

export function Rows(props: { children: JSX.Element; class?: string }) {
  return (
    <dl
      class={cn(
        'grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 gap-y-[3px] font-mono text-[11.5px] leading-[1.5]',
        props.class,
      )}
    >
      {props.children}
    </dl>
  )
}

export function Row(props: { label: string; children: JSX.Element; class?: string }) {
  return (
    <>
      <dt class="truncate text-muted-foreground/70">{props.label}</dt>
      <dd class={cn('flex min-w-0 items-center gap-1.5 text-foreground/85', props.class)}>
        {props.children}
      </dd>
    </>
  )
}
