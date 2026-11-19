/** @jsxImportSource @solidjs/web */
import {
  Popover,
  PopoverContent as PopoverContentRoot,
  PopoverTrigger,
} from '@ui-sdk/solid/popover'
import { cn } from 'cn'
import { merge, omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'

function PopoverContent(props: ComponentProps<typeof PopoverContentRoot> & { class?: string }) {
  const rest = omit(merge({ align: 'center', sideOffset: 4 } as const, props), 'class')
  return (
    <PopoverContentRoot
      {...rest}
      class={cn(
        'z-50 w-72 origin-(--transform-origin) rounded-md border bg-popover p-4 text-left font-sans text-[14px] font-normal tracking-normal whitespace-normal text-popover-foreground normal-case shadow-md outline-hidden',
        props.class,
      )}
    />
  )
}

export { Popover, PopoverTrigger, PopoverContent }
