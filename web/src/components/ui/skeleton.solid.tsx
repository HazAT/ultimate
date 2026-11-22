import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { omit } from 'solid-js'

const fixedViewportSweep =
  'animate-sweep rounded-md bg-muted bg-size-[300%_100%] bg-fixed bg-no-repeat bg-[linear-gradient(90deg,transparent_40%,color-mix(in_oklab,var(--color-foreground)_7%,transparent)_50%,transparent_60%)]'

function Skeleton(props: JSX.IntrinsicElements['div']) {
  const rest = omit(props, 'class')
  return <div data-slot="skeleton" class={cn(fixedViewportSweep, props.class)} {...rest} />
}

export { Skeleton }
