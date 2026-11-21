/** @jsxImportSource @solidjs/web */
import {
  SegmentedControl as SegmentedControlRoot,
  SegmentedControlItem as SegmentedControlItemRoot,
} from '@ui-sdk/solid/segmented-control'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'

type SegmentedControlProps<T extends string> = ComponentProps<typeof SegmentedControlRoot<T>> & {
  class?: string
  bind?: readonly [Accessor<T>, (value: T) => void]
}

function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  const rest = omit(props, 'class', 'bind', 'value', 'onValueChange')
  return (
    <SegmentedControlRoot<T>
      {...rest}
      class={cn('flex shrink-0 items-center rounded-md border border-border/70 p-0.5', props.class)}
      onValueChange={(value, details) => {
        const set = props.bind?.[1]
        const changed = props.onValueChange
        writingAs(details.source, () => {
          changed?.(value, details)
          if (value !== null && !details.canceled) set?.(value)
        })
      }}
      value={props.bind ? props.bind[0]() : props.value}
    />
  )
}

function SegmentedControlItem(
  props: ComponentProps<typeof SegmentedControlItemRoot> & { class?: string },
) {
  const rest = omit(props, 'class')
  return (
    <SegmentedControlItemRoot
      {...rest}
      class={cn(
        'flex h-6 items-center gap-1 rounded-sm px-1.5 font-mono text-[11px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-accent data-checked:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-40',
        props.class,
      )}
    />
  )
}

export { SegmentedControl, SegmentedControlItem }
