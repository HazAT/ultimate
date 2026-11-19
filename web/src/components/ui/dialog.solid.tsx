/** @jsxImportSource @solidjs/web */
import { X } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import {
  DialogBackdrop,
  DialogClose as DialogCloseRoot,
  DialogContent as DialogContentRoot,
  DialogDescription as DialogDescriptionRoot,
  Dialog as DialogRoot,
  DialogTitle as DialogTitleRoot,
  DialogTrigger,
} from '@ui-sdk/solid/dialog'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { writingAs } from '@/sdk/solid'
import { dialogStyles } from './dialog-styles.ts'

function Dialog(props: ComponentProps<typeof DialogRoot>) {
  const rest = omit(props, 'onOpenChange')
  return (
    <DialogRoot
      {...rest}
      onOpenChange={(open, details) => {
        const changed = props.onOpenChange
        writingAs(details.source, () => changed?.(open, details))
      }}
    />
  )
}

function DialogContent<Payload>(
  props: ComponentProps<typeof DialogContentRoot<Payload>> & {
    class?: string
    showCloseButton?: boolean
  },
) {
  const rest = omit(props, 'class', 'children', 'showCloseButton')
  return (
    <>
      <DialogBackdrop class={cn(dialogStyles.overlay, dialogStyles.overlaySolid)} />
      <DialogContentRoot<Payload>
        {...rest}
        class={cn(dialogStyles.content, dialogStyles.contentSolid, props.class)}
      >
        {(state) => (
          <>
            {typeof props.children === 'function' ? props.children(state) : props.children}
            {props.showCloseButton !== false && (
              <DialogClose aria-label="Close" class={dialogStyles.close}>
                <X aria-hidden="true" />
              </DialogClose>
            )}
          </>
        )}
      </DialogContentRoot>
    </>
  )
}

function DialogClose(props: ComponentProps<typeof DialogCloseRoot>) {
  const rest = omit(props, 'action')
  return (
    <DialogCloseRoot
      {...rest}
      action={
        props.action &&
        ((event, details) => {
          const action = props.action
          return writingAs(details.source, () => action?.(event, details))
        })
      }
    />
  )
}

function DialogHeader(props: JSX.IntrinsicElements['div'] & { class?: string }) {
  const rest = omit(props, 'class')
  return <div data-slot="dialog-header" class={cn(dialogStyles.header, props.class)} {...rest} />
}

function DialogTitle(props: ComponentProps<typeof DialogTitleRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return <DialogTitleRoot {...rest} class={cn(dialogStyles.title, props.class)} />
}

function DialogDescription(
  props: ComponentProps<typeof DialogDescriptionRoot> & { class?: string },
) {
  const rest = omit(props, 'class')
  return <DialogDescriptionRoot {...rest} class={cn(dialogStyles.description, props.class)} />
}

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogHeader,
}
