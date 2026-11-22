/** @jsxImportSource @solidjs/web */
import { Check } from '@lucide/solid'
import { Checkbox as CheckboxRoot, CheckboxIndicator } from '@ui-sdk/solid/checkbox'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'

type CheckboxProps = ComponentProps<typeof CheckboxRoot> & {
  class?: string
  bind?: readonly [Accessor<boolean>, (on: boolean) => void]
}

function Checkbox(props: CheckboxProps) {
  const rest = omit(props, 'class', 'bind', 'checked', 'onCheckedChange')
  return (
    <span class="relative inline-flex shrink-0">
      <CheckboxRoot
        {...rest}
        checked={props.bind ? props.bind[0]() : props.checked}
        class={cn(
          'grid size-4 shrink-0 place-items-center rounded-[4px] border border-input bg-background transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-50 data-checked:border-brand data-checked:bg-brand data-checked:text-brand-foreground',
          props.class,
        )}
        onCheckedChange={(on, details) => {
          const set = props.bind?.[1]
          const changed = props.onCheckedChange
          writingAs(details.source, () => {
            changed?.(on, details)
            if (typeof on === 'boolean' && !details.canceled) set?.(on)
          })
        }}
      >
        <CheckboxIndicator aria-hidden="true" class="contents">
          <Check class="size-3" stroke-width={3} />
        </CheckboxIndicator>
      </CheckboxRoot>
    </span>
  )
}

export { Checkbox }
