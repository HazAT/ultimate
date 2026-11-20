/** @jsxImportSource @solidjs/web */
import {
  Slider as SliderRoot,
  SliderControl,
  SliderIndicator,
  SliderThumb,
  SliderTrack,
} from '@ui-sdk/solid/slider'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '@/sdk/solid'

type SliderProps = Omit<ComponentProps<typeof SliderRoot<number>>, 'children'> & {
  'aria-label': string
  bind?: readonly [Accessor<number>, (value: number) => void]
}

function Slider(props: SliderProps) {
  const rest = omit(props, 'aria-label', 'bind', 'class', 'value', 'onValueChange')
  return (
    <SliderRoot<number>
      {...rest}
      class={cn('w-32', props.class)}
      onValueChange={(value, details) => {
        const set = props.bind?.[1]
        const changed = props.onValueChange
        writingAs(details.source, () => {
          changed?.(value, details)
          if (!details.canceled) set?.(value)
        })
      }}
      value={props.bind ? props.bind[0]() : props.value}
    >
      <SliderControl class="flex h-6 w-full touch-none items-center">
        <SliderTrack class="relative h-1 w-full rounded-full bg-input">
          <SliderIndicator class="h-full rounded-full bg-brand" />
          <SliderThumb
            aria-label={props['aria-label']}
            class="size-3.5 rounded-full bg-brand outline-none has-focus-visible:ring-2 has-focus-visible:ring-ring"
          />
        </SliderTrack>
      </SliderControl>
    </SliderRoot>
  )
}

export { Slider }
