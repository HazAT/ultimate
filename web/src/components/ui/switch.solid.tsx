/** @jsxImportSource @solidjs/web */
import { Switch as SwitchRoot, SwitchThumb } from '@ui-sdk/solid/switch'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'

function Switch(props: ComponentProps<typeof SwitchRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <SwitchRoot
      {...rest}
      class={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-40 data-checked:bg-brand data-unchecked:bg-input',
        props.class,
      )}
    >
      <SwitchThumb class="block size-3 rounded-full shadow-sm transition-transform data-checked:translate-x-3.5 data-checked:bg-brand-foreground data-unchecked:translate-x-0.5 data-unchecked:bg-muted-foreground/80" />
    </SwitchRoot>
  )
}

export { Switch }
