import { Button as ButtonRoot } from '@ui-sdk/solid/button'
import { cn } from 'cn'
import { merge, omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'
import { buttonVariants } from './button-variants.ts'
import type { ButtonVariants } from './button-variants.ts'

type ButtonProps = ComponentProps<typeof ButtonRoot> & ButtonVariants & { class?: string }

function Button(props: ButtonProps) {
  const styled = merge({ variant: 'default', size: 'default' } as const, props)
  const rest = omit(styled, 'class', 'variant', 'size', 'onClick')
  return (
    <ButtonRoot
      {...rest}
      data-variant={styled.variant}
      data-size={styled.size}
      class={cn(buttonVariants({ variant: styled.variant, size: styled.size }), props.class)}
      onClick={(event, details) => {
        const click = props.onClick
        return writingAs(details.source, () =>
          typeof click === 'function'
            ? click(event, details)
            : click?.[0](click[1], event, details),
        )
      }}
    />
  )
}

export { Button, buttonVariants }
