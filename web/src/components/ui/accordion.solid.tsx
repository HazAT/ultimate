/** @jsxImportSource @solidjs/web */
import {
  AccordionHeader,
  AccordionItem as AccordionItemRoot,
  AccordionPanel,
  Accordion as AccordionRoot,
  AccordionTrigger as AccordionTriggerRoot,
} from '@ui-sdk/solid/accordion'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'

type AccordionProps<T extends string> = ComponentProps<typeof AccordionRoot<T>> & {
  bind?: readonly [Accessor<T[]>, (value: T[]) => void]
}

function Accordion<T extends string>(props: AccordionProps<T>) {
  const rest = omit(props, 'bind', 'value', 'onValueChange')
  return (
    <AccordionRoot<T>
      {...rest}
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

function AccordionItem(props: ComponentProps<typeof AccordionItemRoot>) {
  const rest = omit(props, 'onOpenChange')
  return (
    <AccordionItemRoot
      {...rest}
      onOpenChange={(open, details) => {
        const changed = props.onOpenChange
        writingAs(details.source, () => changed?.(open, details))
      }}
    />
  )
}

function AccordionTrigger(props: ComponentProps<typeof AccordionTriggerRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <AccordionTriggerRoot
      {...rest}
      class={cn(
        'flex min-h-6 w-full items-center gap-1.5 rounded-sm px-2 text-left text-xs text-muted-foreground transition-colors outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-open:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-40',
        props.class,
      )}
    />
  )
}

export { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger }
