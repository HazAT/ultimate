/** @jsxImportSource @solidjs/web */
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { omit } from 'solid-js'

function Kbd(props: JSX.IntrinsicElements['kbd']) {
  const rest = omit(props, 'class')
  return (
    <kbd
      data-slot="kbd"
      class={cn(
        'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm bg-muted px-1 font-sans text-xs font-medium text-muted-foreground select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10',
        props.class,
      )}
      {...rest}
    />
  )
}

function KbdGroup(props: JSX.IntrinsicElements['kbd']) {
  const rest = omit(props, 'class')
  return (
    <kbd
      data-slot="kbd-group"
      class={cn('inline-flex items-center gap-1', props.class)}
      {...rest}
    />
  )
}

export { Kbd, KbdGroup }
