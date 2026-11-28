import {
  TooltipArrow,
  TooltipContent as TooltipContentRoot,
  Tooltip as TooltipRoot,
  TooltipTrigger,
} from '@ui-sdk/solid/tooltip'
import { cn } from 'cn'
import { merge, omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'

function Tooltip(props: ComponentProps<typeof TooltipRoot>) {
  const defaults = merge({ delay: 0 }, props)
  return <TooltipRoot {...defaults} />
}

function TooltipContent<Payload>(
  props: ComponentProps<typeof TooltipContentRoot<Payload>> & { class?: string },
) {
  const rest = omit(merge({ sideOffset: 0 }, props), 'class', 'children')
  return (
    <TooltipContentRoot<Payload>
      {...rest}
      class={cn(
        'z-50 w-fit origin-(--transform-origin) rounded-md bg-foreground px-3 py-1.5 text-left font-sans text-xs font-normal tracking-normal whitespace-normal text-balance text-background normal-case transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none',
        props.class,
      )}
    >
      {(state) => (
        <>
          {typeof props.children === 'function' ? props.children(state) : props.children}
          <TooltipArrow class="pointer-events-none size-2.5 rotate-45 rounded-[2px] bg-foreground data-[side=bottom]:-top-1 data-[side=left]:-right-1 data-[side=right]:-left-1 data-[side=top]:-bottom-1" />
        </>
      )}
    </TooltipContentRoot>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent }
