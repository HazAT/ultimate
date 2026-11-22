import { cn } from 'cn'
import { omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { Button } from './button.solid.tsx'
import { PopoverTrigger } from './popover.solid.tsx'

const item =
  '-mx-1 flex items-center gap-1.5 rounded-sm px-1 font-[family-name:inherit] text-[length:inherit] leading-[inherit] font-normal transition-colors hover:bg-accent hover:text-foreground'

function StatusPopoverTrigger(props: ComponentProps<typeof PopoverTrigger> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <PopoverTrigger
      {...rest}
      class={cn(item, 'data-open:bg-accent data-open:text-foreground', props.class)}
    />
  )
}

function StatusButton(props: Omit<ComponentProps<typeof Button>, 'size' | 'variant'>) {
  const rest = omit(props, 'class')
  return <Button {...rest} class={cn(item, props.class)} size={null} variant={null} />
}

export { StatusButton, StatusPopoverTrigger }
