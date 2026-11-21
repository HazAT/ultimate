/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { omit } from 'solid-js'

export type MessageProps = JSX.IntrinsicElements['div'] & { from: 'user' | 'assistant' }

export function Message(props: MessageProps) {
  const rest = omit(props, 'class', 'from')
  return (
    <div
      {...rest}
      class={cn(
        'group flex w-full flex-col gap-2',
        props.from === 'user' ? 'is-user' : 'is-assistant',
        props.class,
      )}
      data-from={props.from}
    />
  )
}

export function MessageContent(props: JSX.IntrinsicElements['div']) {
  const rest = omit(props, 'class')
  return (
    <div
      {...rest}
      class={cn(
        'flex min-w-0 max-w-full flex-col gap-2 text-[14px] leading-relaxed',
        'group-[.is-user]:rounded-lg group-[.is-user]:border group-[.is-user]:border-border/70 group-[.is-user]:bg-secondary/60 group-[.is-user]:px-3.5 group-[.is-user]:py-2.5',
        props.class,
      )}
    />
  )
}
