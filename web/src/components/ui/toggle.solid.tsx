/** @jsxImportSource @solidjs/web */
import { ToggleGroup as ToggleGroupRoot, Toggle as ToggleRoot } from '@ui-sdk/solid/toggle'
import { cn } from 'cn'
import { merge, omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'
import { buttonVariants } from './button-variants.ts'
import type { ButtonVariants } from './button-variants.ts'

type ToggleProps = ComponentProps<typeof ToggleRoot> &
  ButtonVariants & {
    class?: string
    bind?: readonly [Accessor<boolean>, (pressed: boolean) => void]
  }

function Toggle(props: ToggleProps) {
  const styled = merge({ variant: 'ghost', size: 'default' } as const, props)
  const rest = omit(styled, 'bind', 'class', 'variant', 'size', 'pressed', 'onPressedChange')
  return (
    <ToggleRoot
      {...rest}
      data-size={styled.size}
      data-variant={styled.variant}
      pressed={props.bind ? props.bind[0]() : props.pressed}
      class={cn(
        buttonVariants({ variant: styled.variant, size: styled.size }),
        'data-pressed:bg-accent data-pressed:text-foreground',
        props.class,
      )}
      onPressedChange={(pressed, details) => {
        const set = props.bind?.[1]
        const changed = props.onPressedChange
        writingAs(details.source, () => {
          changed?.(pressed, details)
          if (!details.canceled) set?.(pressed)
        })
      }}
    />
  )
}

type ToggleGroupProps<T extends string> = ComponentProps<typeof ToggleGroupRoot<T>> & {
  class?: string
  bind?: readonly [Accessor<T[]>, (value: T[]) => void]
}

function ToggleGroup<T extends string>(props: ToggleGroupProps<T>) {
  const rest = omit(props, 'bind', 'class', 'value', 'onValueChange')
  return (
    <ToggleGroupRoot<T>
      {...rest}
      class={cn(
        'inline-flex items-center gap-0.5 data-[orientation=vertical]:flex-col',
        props.class,
      )}
      value={props.bind ? props.bind[0]() : props.value}
      onValueChange={(value, details) => {
        const set = props.bind?.[1]
        const changed = props.onValueChange
        writingAs(details.source, () => {
          changed?.(value, details)
          if (!details.canceled) set?.(value)
        })
      }}
    />
  )
}

export { Toggle, ToggleGroup }
