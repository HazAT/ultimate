/** @jsxImportSource @solidjs/web */
import { Switch as SwitchRoot, SwitchThumb } from '@ui-sdk/solid/switch'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'

type SwitchProps = ComponentProps<typeof SwitchRoot> & {
  class?: string
  bind?: readonly [Accessor<boolean>, (on: boolean) => void]
}

function Switch(props: SwitchProps) {
  const rest = omit(props, 'class', 'bind', 'checked', 'onCheckedChange')
  return (
    <span class="relative inline-flex shrink-0">
      <SwitchRoot
        {...rest}
        checked={props.bind ? props.bind[0]() : props.checked}
        class={cn(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-40 data-checked:bg-brand data-unchecked:bg-input',
          props.class,
        )}
        onCheckedChange={(on, details) => {
          const set = props.bind?.[1]
          const changed = props.onCheckedChange
          writingAs(details.source, () => {
            changed?.(on, details)
            if (!details.canceled) set?.(on)
          })
        }}
      >
        <SwitchThumb class="block size-3 rounded-full shadow-sm transition-transform data-checked:translate-x-3.5 data-checked:bg-brand-foreground data-unchecked:translate-x-0.5 data-unchecked:bg-muted-foreground/80" />
      </SwitchRoot>
    </span>
  )
}

export { Switch }
