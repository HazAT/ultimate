/** @jsxImportSource @solidjs/web */
import { PanelLeft, PanelRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  ConversationKind,
  ROOT,
  switchConversation,
  useConversation,
  useConversations,
  useExtensions,
  useRegionOpen,
  useStore,
} from '../sdk/hooks.ts'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import { actions, layout } from '../sdk/actions.ts'
import { Slot, useProvided } from '../sdk/contribution.solid.tsx'
import { panelItems, slotItems } from '../sdk/registry.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { Shortcut } from './palette.solid.tsx'

export function IconButton(props: {
  label: string
  keys?: string
  onClick: () => void
  children: JSX.Element
  active?: boolean
}) {
  return (
    <Tooltip delay={400}>
      <TooltipTrigger
        aria-label={props.label}
        onClick={() => props.onClick()}
        render={(trigger) => (
          <Button
            {...trigger}
            class={cn(
              'size-7 text-muted-foreground hover:text-foreground pointer-coarse:size-9',
              props.active && 'text-foreground',
            )}
            size="icon"
            variant="ghost"
          />
        )}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent class="flex items-center gap-2">
        {props.label}
        <Show when={props.keys}>{(keys) => <Shortcut keys={keys()} />}</Show>
      </TooltipContent>
    </Tooltip>
  )
}

function ancestors(id: number | undefined, conversations: readonly ConversationSummary[]) {
  const chain: ConversationSummary[] = []
  let parent = conversations.find((conversation) => conversation.id === id)?.parentConversationId
  while (parent !== undefined && !chain.some((conversation) => conversation.id === parent)) {
    const found = conversations.find((conversation) => conversation.id === parent)
    if (!found) break
    chain.unshift(found)
    parent = found.parentConversationId
  }
  return chain
}

const nameOf = (conversation: ConversationSummary) =>
  conversation.id === ROOT ? 'main' : (conversation.label ?? `#${conversation.id}`)

function Trail() {
  const shown = useConversation()
  const id = useStore((state) => state.view?.conversation.id ?? state.requested)
  const conversations = useConversations()
  const summary = createMemo(() => conversations().find((conversation) => conversation.id === id()))
  const trail = createMemo(() => ancestors(id(), conversations()))
  const kind = useProvided(ConversationKind, summary)
  const title = () =>
    id() === undefined
      ? 'connecting…'
      : summary()
        ? (summary()!.title ?? 'Untitled conversation')
        : ''
  const label = () => kind() ?? summary()?.label
  return (
    <>
      <For each={trail()} keyed={(conversation) => conversation.id}>
        {(conversation) => (
          <>
            <Button
              aria-label={`Show ${nameOf(conversation())} (#${conversation().id})`}
              class="h-auto shrink-0 rounded-sm px-1 font-mono text-[12px] font-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-md:hidden"
              onClick={() => switchConversation(conversation().id)}
              size={null}
              title={conversation().id === ROOT ? 'The main conversation' : conversation().title}
              variant={null}
            >
              {nameOf(conversation())}
            </Button>
            <span class="-mx-1 shrink-0 text-muted-foreground/40 max-md:hidden">/</span>
          </>
        )}
      </For>
      <Show when={shown().busy}>
        <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
      </Show>
      <Show
        when={id() !== ROOT}
        fallback={<span class="font-mono text-[12px] text-foreground/85">main</span>}
      >
        <Show when={label()}>
          <span class="max-w-1/2 shrink-0 truncate font-mono text-[12px] text-brand">
            {label()}
          </span>
        </Show>
        <span class="truncate text-[13px] font-medium" title={title()}>
          {title()}
        </span>
        <Show when={id() !== undefined}>
          <span class="shrink-0 font-mono text-[11px] text-muted-foreground/70">#{id()}</span>
        </Show>
      </Show>
    </>
  )
}

export function useRegion(region: 'sidebar' | 'panels') {
  const [mounted, setMounted] = createSignal(layout.has(region))
  onSettled(() => {
    setMounted(layout.has(region))
    return layout.subscribe(() => setMounted(layout.has(region)))
  })
  return mounted
}

export const inlineFailure = (extension: string, error: unknown) => (
  <ContributionError error={error} extension={extension} inline />
)

export function Header(props: { children?: JSX.Element }) {
  const extensions = useExtensions()
  const sidebarMounted = useRegion('sidebar')
  const panelsMounted = useRegion('panels')
  const sidebar = () => sidebarMounted() && slotItems(extensions(), 'sidebar').length > 0
  const panels = () => panelsMounted() && panelItems(extensions()).length > 0
  const panelOpen = useRegionOpen('panels')
  return (
    <header
      class="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2"
      data-ui="conversation-header"
    >
      <Show when={sidebar()}>
        <IconButton keys="mod+b" label="Toggle sidebar" onClick={actions.toggleSidebar}>
          <PanelLeft aria-hidden="true" class="size-4" />
        </IconButton>
      </Show>
      <div class="flex min-w-0 items-center gap-2">
        <Show when={props.children !== undefined} fallback={<Trail />}>
          {props.children}
        </Show>
      </div>
      <div class="ml-auto flex items-center gap-1">
        <Slot fallback={inlineFailure} name="header.right" variant="inline" />
        <Show when={panels()}>
          <IconButton
            active={panelOpen()}
            keys="mod+alt+b"
            label="Toggle panel"
            onClick={actions.togglePanel}
          >
            <PanelRight aria-hidden="true" class="size-4" />
          </IconButton>
        </Show>
      </div>
    </header>
  )
}
