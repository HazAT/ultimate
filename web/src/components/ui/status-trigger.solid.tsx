/** @jsxImportSource @solidjs/web */
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { PopoverTrigger } from './popover.solid.tsx'

function StatusPopoverTrigger(props: ComponentProps<typeof PopoverTrigger> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <PopoverTrigger
      {...rest}
      class={cn(
        '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-open:bg-accent data-open:text-foreground',
        props.class,
      )}
    />
  )
}

export { StatusPopoverTrigger }
