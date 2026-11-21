/** @jsxImportSource @solidjs/web */
import {
  HoverCardContent as HoverCardContentRoot,
  HoverCard as HoverCardRoot,
  HoverCardTrigger,
} from '@ui-sdk/solid/hover-card'
import { cn } from 'cn'
import { merge, omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'
import { hoverCardStyles } from './hover-card-styles.ts'

function HoverCard(props: ComponentProps<typeof HoverCardRoot>) {
  const rest = omit(props, 'onOpenChange')
  return (
    <HoverCardRoot
      {...rest}
      onOpenChange={(open, details) => {
        const changed = props.onOpenChange
        writingAs(details.source, () => changed?.(open, details))
      }}
    />
  )
}

function HoverCardContent<Payload>(
  props: ComponentProps<typeof HoverCardContentRoot<Payload>> & { class?: string },
) {
  const rest = omit(merge({ align: 'center', sideOffset: 4 } as const, props), 'class')
  return (
    <HoverCardContentRoot<Payload>
      {...rest}
      class={cn(hoverCardStyles.content, hoverCardStyles.contentSolid, props.class)}
    />
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
