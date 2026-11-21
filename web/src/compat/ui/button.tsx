import * as React from 'react'
import { cn } from 'cn'
import { Slot } from 'radix-ui'
import { buttonVariants } from '../../components/ui/button-variants.ts'
import type { ButtonVariants } from '../../components/ui/button-variants.ts'

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  ButtonVariants & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
