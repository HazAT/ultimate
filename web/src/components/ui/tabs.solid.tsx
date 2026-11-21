/** @jsxImportSource @solidjs/web */
import {
  Tabs as TabsRoot,
  TabsList as TabsListRoot,
  TabsPanel,
  TabsTab as TabsTabRoot,
} from '@ui-sdk/solid/tabs'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'

type TabsProps<T extends string> = ComponentProps<typeof TabsRoot<T>> & {
  bind?: readonly [Accessor<T>, (value: T) => void]
}

function Tabs<T extends string>(props: TabsProps<T>) {
  const rest = omit(props, 'bind', 'value', 'onValueChange')
  return (
    <TabsRoot<T>
      {...rest}
      value={props.bind ? props.bind[0]() : props.value}
      onValueChange={(value, details) => {
        const set = props.bind?.[1]
        const changed = props.onValueChange
        writingAs(details.source, () => {
          changed?.(value, details)
          if (value !== null && !details.canceled) set?.(value)
        })
      }}
    />
  )
}

function TabsList(props: ComponentProps<typeof TabsListRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <TabsListRoot
      {...rest}
      class={cn(
        'flex shrink-0 items-center rounded-md border border-border/70 p-0.5 data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch',
        props.class,
      )}
    />
  )
}

function TabsTab(props: ComponentProps<typeof TabsTabRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <TabsTabRoot
      {...rest}
      class={cn(
        'flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-selected:bg-accent data-selected:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-40',
        props.class,
      )}
    />
  )
}

export { Tabs, TabsList, TabsPanel, TabsTab }
