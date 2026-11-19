/** @jsxImportSource @solidjs/web */
import {
  CollapsiblePanel as CollapsibleContent,
  Collapsible as CollapsibleRoot,
  CollapsibleTrigger,
} from '@ui-sdk/solid/collapsible'
import { omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '@/sdk/solid'

function Collapsible(
  props: ComponentProps<typeof CollapsibleRoot> & {
    bind?: readonly [Accessor<boolean>, (open: boolean) => void]
  },
) {
  const rest = omit(props, 'bind', 'open', 'onOpenChange')
  return (
    <CollapsibleRoot
      {...rest}
      open={props.bind ? props.bind[0]() : props.open}
      onOpenChange={(open, details) => {
        const changed = props.onOpenChange
        const set = props.bind?.[1]
        writingAs(details.source, () => {
          changed?.(open, details)
          if (!details.canceled) set?.(open)
        })
      }}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
