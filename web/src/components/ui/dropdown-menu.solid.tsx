/** @jsxImportSource @solidjs/web */
import { Circle } from '@lucide/solid'
import {
  MenuContent,
  MenuGroup as DropdownMenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  Menu as MenuRoot,
  MenuTrigger as DropdownMenuTrigger,
} from '@ui-sdk/solid/menu'
import { cn } from 'cn'
import { merge, omit } from 'solid-js'
import type { Accessor, ComponentProps } from 'solid-js'
import { writingAs } from '../../sdk/hooks.ts'
import { runAsItsSource } from './action-source.solid.tsx'
import type { SourcedAction } from './action-source.solid.tsx'
import { menuStyles } from './menu-styles.ts'

function DropdownMenu(
  props: Omit<ComponentProps<typeof MenuRoot>, 'items' | 'itemShortcuts' | 'onAction'> & {
    items?: never
    itemShortcuts?: never
    onAction?: SourcedAction
  },
) {
  const rest = omit(props, 'onOpenChange', 'items', 'itemShortcuts', 'onAction')
  return (
    <MenuRoot
      {...rest}
      onAction={(value, details) => runAsItsSource(props.onAction, value, details)}
      onOpenChange={(open, details) => {
        const changed = props.onOpenChange
        writingAs(details.source, () => changed?.(open, details))
      }}
    />
  )
}

function DropdownMenuContent<Payload>(
  props: ComponentProps<typeof MenuContent<Payload>> & { class?: string },
) {
  const rest = omit(merge({ sideOffset: 4 }, props), 'class')
  return (
    <MenuContent<Payload>
      {...rest}
      class={cn(menuStyles.content, menuStyles.contentSolid, props.class)}
    />
  )
}

type DropdownMenuItemProps = Omit<ComponentProps<typeof MenuItem>, 'destructive'> & {
  class?: string
  inset?: boolean
} & ({ variant: 'destructive'; confirm: string } | { variant?: 'default'; confirm?: never })

function DropdownMenuItem(props: DropdownMenuItemProps) {
  const rest = omit(props, 'class', 'inset', 'variant', 'confirm')
  return (
    <MenuItem
      {...rest}
      class={cn(menuStyles.item, menuStyles.itemSolid, props.class)}
      data-inset={props.inset ? '' : undefined}
      destructive={props.variant === 'destructive'}
      data-agent-confirm={props.confirm}
    />
  )
}

function DropdownMenuLabel(
  props: ComponentProps<typeof MenuGroupLabel> & { class?: string; inset?: boolean },
) {
  const rest = omit(props, 'class', 'inset')
  return (
    <MenuGroupLabel
      {...rest}
      class={cn(menuStyles.label, props.class)}
      data-inset={props.inset ? '' : undefined}
    />
  )
}

function DropdownMenuRadioGroup(
  props: ComponentProps<typeof MenuRadioGroup<string>> & {
    bind?: readonly [Accessor<string>, (value: string) => void]
  },
) {
  const rest = omit(props, 'bind', 'value', 'onValueChange')
  return (
    <MenuRadioGroup
      {...rest}
      value={props.bind ? props.bind[0]() : props.value}
      onValueChange={(value, details) => {
        const changed = props.onValueChange
        const set = props.bind?.[1]
        writingAs(details.source, () => {
          changed?.(value, details)
          if (!details.canceled) set?.(value)
        })
      }}
    />
  )
}

function DropdownMenuRadioItem(props: ComponentProps<typeof MenuRadioItem> & { class?: string }) {
  const rest = omit(props, 'class', 'children')
  return (
    <MenuRadioItem
      {...rest}
      class={cn(menuStyles.radioItem, menuStyles.radioItemSolid, props.class)}
    >
      {(state) => (
        <>
          <MenuItemIndicator class={menuStyles.indicator}>
            <Circle aria-hidden="true" class={menuStyles.indicatorIcon} />
          </MenuItemIndicator>
          {typeof props.children === 'function' ? props.children(state) : props.children}
        </>
      )}
    </MenuRadioItem>
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
}
