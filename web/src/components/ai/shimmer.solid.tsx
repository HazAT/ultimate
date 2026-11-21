/** @jsxImportSource @solidjs/web */
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import type { Component } from 'solid-js'

export interface ShimmerProps {
  children: string
  as?: keyof JSX.IntrinsicElements | Component<JSX.IntrinsicElements['span']>
  class?: string
  spread?: number
}

export function Shimmer(props: ShimmerProps) {
  const Tag = dynamic(() => props.as ?? 'span')
  return (
    <Tag
      class={cn(
        'inline-block animate-shimmer bg-size-[250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box]',
        props.class,
      )}
      style={{
        '--spread': `${props.children.length * (props.spread ?? 2)}px`,
        'background-image':
          'linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--color-foreground), #0000 calc(50% + var(--spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
      }}
    >
      {props.children}
    </Tag>
  )
}
