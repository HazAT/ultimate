/** @jsxImportSource @solidjs/web */
import { Search } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import {
  CommandEmpty as CommandEmptyRoot,
  CommandGroupLabel,
  CommandGroup as CommandGroupRoot,
  CommandInput as CommandInputRoot,
  CommandItem as CommandItemRoot,
  CommandList as CommandListRoot,
  Command as CommandRoot,
  CommandShortcut as CommandShortcutRoot,
} from '@ui-sdk/solid/command'
import { cn } from 'cn'
import { omit } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { writingAs } from '@/sdk/solid'
import { runAsItsSource } from './action-source.solid.tsx'
import type { SourcedAction } from './action-source.solid.tsx'
import { commandStyles } from './command-styles.ts'

function Command(
  props: Omit<ComponentProps<typeof CommandRoot>, 'onAction'> & {
    class?: string
    onAction?: SourcedAction
  },
) {
  const rest = omit(props, 'class', 'onQueryChange', 'onValueChange', 'onPagesChange', 'onAction')
  return (
    <CommandRoot
      {...rest}
      class={cn(commandStyles.root, props.class)}
      onAction={(value, details) => runAsItsSource(props.onAction, value, details)}
      onQueryChange={(query, details) => {
        const changed = props.onQueryChange
        writingAs(details.source, () => changed?.(query, details))
      }}
      onValueChange={(value, details) => {
        const changed = props.onValueChange
        writingAs(details.source, () => changed?.(value, details))
      }}
      onPagesChange={(pages, details) => {
        const changed = props.onPagesChange
        writingAs(details.source, () => changed?.(pages, details))
      }}
    />
  )
}

function CommandInput(
  props: ComponentProps<typeof CommandInputRoot> & { class?: string; 'aria-label': string },
) {
  const rest = omit(props, 'class')
  return (
    <div data-slot="command-input-wrapper" class={commandStyles.inputWrapper}>
      <Search aria-hidden="true" class={commandStyles.searchIcon} />
      <CommandInputRoot {...rest} class={cn(commandStyles.input, props.class)} />
    </div>
  )
}

function CommandList(props: ComponentProps<typeof CommandListRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return <CommandListRoot {...rest} class={cn(commandStyles.list, props.class)} />
}

function CommandEmpty(props: ComponentProps<typeof CommandEmptyRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <CommandEmptyRoot
      {...rest}
      class={cn(commandStyles.empty, props.class, commandStyles.emptySolid)}
    />
  )
}

function CommandGroup(
  props: ComponentProps<typeof CommandGroupRoot> & { class?: string; heading?: JSX.Element },
) {
  const rest = omit(props, 'class', 'heading', 'children')
  return (
    <CommandGroupRoot {...rest} class={cn(commandStyles.group, props.class)}>
      {(state) => (
        <>
          {props.heading != null && (
            <CommandGroupLabel class={commandStyles.headingSolid}>
              {props.heading}
            </CommandGroupLabel>
          )}
          {typeof props.children === 'function' ? props.children(state) : props.children}
        </>
      )}
    </CommandGroupRoot>
  )
}

function CommandItem(props: ComponentProps<typeof CommandItemRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return (
    <CommandItemRoot
      {...rest}
      class={cn(commandStyles.item, commandStyles.itemSolid, props.class)}
    />
  )
}

function CommandShortcut(props: ComponentProps<typeof CommandShortcutRoot> & { class?: string }) {
  const rest = omit(props, 'class')
  return <CommandShortcutRoot {...rest} class={cn(commandStyles.shortcut, props.class)} />
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
}
