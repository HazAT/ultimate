/** @jsxImportSource @solidjs/web */
import {
  createToaster,
  Toast as ToastRoot,
  ToastClose as ToastCloseRoot,
  ToastRegion as ToastRegionRoot,
  ToastTitle,
} from '@ui-sdk/solid/toast'
import type { ToastRegionProps } from '@ui-sdk/solid/toast'
import { cn } from 'cn'
import { merge, omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'

function ToastRegion(props: ToastRegionProps & { class?: string }) {
  const rest = omit(
    merge({ side: 'top', align: 'center', expanded: true } as const, props),
    'class',
  )
  return (
    <ToastRegionRoot
      {...rest}
      class={cn(
        'mt-12 w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border border-border/80 bg-popover text-left font-sans text-[14px] font-normal tracking-normal whitespace-normal text-popover-foreground normal-case shadow-lg not-has-[li]:hidden [&>ol]:divide-y [&>ol]:divide-border/70',
        props.class,
      )}
    />
  )
}

function Toast(props: ComponentProps<typeof ToastRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <ToastRoot
      {...rest}
      class={cn(
        'group/toast flex items-start gap-2 px-2.5 py-2 font-mono text-[11.5px] leading-snug transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 data-[type=error]:bg-error/6 data-[type=warning]:bg-warning/6 motion-reduce:transition-none',
        props.class,
      )}
    />
  )
}

function ToastClose(props: ComponentProps<typeof ToastCloseRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <ToastCloseRoot
      {...rest}
      class={cn(
        'shrink-0 text-muted-foreground/60 opacity-0 transition-opacity outline-none group-hover/toast:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-foreground',
        props.class,
      )}
    />
  )
}

export { createToaster, Toast, ToastClose, ToastRegion, ToastTitle }
