import { ChevronDown, Command as CommandIcon, Ellipsis, PanelLeft, PanelRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import { cell } from '../../../lib/cell.web.ts'
import {
  ConversationKind,
  ROOT,
  showSurface,
  switchConversation,
  useConversation,
  useConversations,
  useExtensions,
  useRegionOpen,
  useStore,
  useSystem,
  useViewport,
} from '../sdk/hooks.ts'
import type { ConversationSummary } from '../../../shared/protocol.ts'
import { actions, layout } from '../sdk/actions.ts'
import { ContributedIcon, Slot, useProvided } from '../sdk/contribution.solid.tsx'
import { useExternal } from '../sdk/page.ts'
import { HOME, panelItems, slotItems, surfaceItems } from '../sdk/registry.ts'
import { ContributionError } from './contribution-error.solid.tsx'
import { Shortcut } from './palette.solid.tsx'
import { projectTitle } from './project.ts'

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
  return useExternal(() => layout.has(region), layout.subscribe)
}

export const inlineFailure = (extension: string, error: unknown) => (
  <ContributionError error={error} extension={extension} inline />
)

const headers = cell(0)
export const useHeaderShown = () => useExternal(() => headers.get() > 0, headers.subscribe)

export const wordmark =
  'flex shrink-0 items-center gap-2 rounded-sm px-1 font-sans text-[11px] font-semibold tracking-[0.28em] text-brand'

export function SurfaceMenu(props: {
  label: string
  class: string
  children: JSX.Element
  data?: string
}) {
  const extensions = useExtensions()
  const surfaces = createMemo(() => surfaceItems(extensions()))
  const shown = useStore((state) => state.ui.surface?.id)
  return (
    <DropdownMenu modal={false} onAction={(id) => showSurface(id)}>
      <DropdownMenuTrigger
        aria-label={props.label}
        class={props.class}
        data-ui={props.data}
        title={props.label}
      >
        {props.children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-96 max-w-[calc(100vw-1rem)]" sideOffset={4}>
        <DropdownMenuGroup>
          <DropdownMenuLabel class="px-2 pt-1 pb-1.5 section-label">Surfaces</DropdownMenuLabel>
          <For each={surfaces()} keyed={(surface) => surface.id}>
            {(surface, index) => {
              const active = () => surface().id === shown()
              return (
                <DropdownMenuItem
                  class="items-start gap-2.5 py-1.5"
                  data-surface={surface().id}
                  value={surface().id}
                >
                  <ContributedIcon
                    class={cn('mt-0.5 size-4', active() ? 'text-brand' : 'text-muted-foreground')}
                    icon={surface().icon}
                  />
                  <span class="min-w-0 flex-1">
                    <span class={cn('block text-[13px]', active() && 'text-brand')}>
                      {surface().title}
                    </span>
                    <Show when={surface().description}>
                      <span class="block truncate text-[12px] text-muted-foreground">
                        {surface().description}
                      </span>
                    </Show>
                  </span>
                  <Show when={index() < 9}>
                    <span class="mt-0.5 shrink-0 pointer-coarse:hidden">
                      <Shortcut keys={`mod+${index() + 1}`} />
                    </span>
                  </Show>
                </DropdownMenuItem>
              )
            }}
          </For>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const barButton =
  'flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-open:bg-accent data-open:text-foreground'

function CurrentSurfaceIcon() {
  const extensions = useExtensions()
  const shown = useStore((state) => state.ui.surface?.id ?? HOME)
  const current = () => surfaceItems(extensions()).find((surface) => surface.id === shown())
  return (
    <Show when={current()?.icon}>{(icon) => <ContributedIcon class="size-4" icon={icon()} />}</Show>
  )
}

function PhoneMore(props: { panels: boolean }) {
  const [open, setOpen] = createSignal(false)
  const system = useSystem()
  const panelOpen = useRegionOpen('panels')
  const row =
    'h-9 w-full justify-start gap-2.5 rounded-md px-2 font-mono text-[12px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground'
  const run = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  return (
    <Popover onOpenChange={setOpen} open={open()}>
      <PopoverTrigger aria-label="More in the top bar" class={barButton}>
        <Ellipsis aria-hidden="true" class="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        class="flex w-64 max-w-[calc(100vw-1rem)] flex-col gap-0.5 p-1.5 font-mono text-[12px]"
      >
        <Show when={projectTitle(system())}>
          {(name) => (
            <span class="truncate px-2 pt-1 pb-1.5 section-label" title={system()?.project.root}>
              {name()}
            </span>
          )}
        </Show>
        <Show when={props.panels}>
          <Button
            aria-label={panelOpen() ? 'Hide the panel' : 'Show the panel'}
            class={row}
            onClick={run(actions.togglePanel)}
            size={null}
            variant={null}
          >
            <PanelRight aria-hidden="true" class="size-4" />
            {panelOpen() ? 'hide panel' : 'panels'}
          </Button>
        </Show>
        <Button
          aria-label="Open commands"
          class={row}
          onClick={run(actions.openPalette)}
          size={null}
          variant={null}
        >
          <CommandIcon aria-hidden="true" class="size-4" />
          commands
        </Button>
        <div class="flex flex-wrap items-center gap-1 px-1 pt-1 empty:hidden">
          <Slot fallback={inlineFailure} name="titlebar.left" phone={false} />
          <Slot fallback={inlineFailure} name="titlebar.right" phone={false} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function PhoneHeader(props: { children?: JSX.Element; sidebar: boolean; panels: boolean }) {
  return (
    <header
      class="flex h-11 shrink-0 items-center gap-0.5 border-b border-border/70 bg-sidebar px-1"
      data-ui="conversation-header"
    >
      <Show when={props.sidebar}>
        <IconButton label="Toggle sidebar" onClick={actions.toggleSidebar}>
          <PanelLeft aria-hidden="true" class="size-4" />
        </IconButton>
      </Show>
      <SurfaceMenu class={cn(barButton, 'w-auto gap-0.5 px-1.5')} label="Switch surface">
        <CurrentSurfaceIcon />
        <ChevronDown aria-hidden="true" class="size-3 opacity-60" />
      </SurfaceMenu>
      <Show
        when={props.children !== undefined}
        fallback={
          <div class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pl-1">
            <Trail />
          </div>
        }
      >
        <div class="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pl-1 [scrollbar-width:none]">
          {props.children}
        </div>
      </Show>
      <div class="flex shrink-0 items-center gap-0.5">
        <Slot fallback={inlineFailure} name="header.right" />
        <Slot fallback={inlineFailure} name="titlebar.left" phone />
        <Slot fallback={inlineFailure} name="titlebar.right" phone />
        <PhoneMore panels={props.panels} />
      </div>
    </header>
  )
}

export function Header(props: { children?: JSX.Element }) {
  const extensions = useExtensions()
  const sidebarMounted = useRegion('sidebar')
  const panelsMounted = useRegion('panels')
  const sidebar = () => sidebarMounted() && slotItems(extensions(), 'sidebar').length > 0
  const panels = () => panelsMounted() && panelItems(extensions()).length > 0
  const panelOpen = useRegionOpen('panels')
  const viewport = useViewport()
  onSettled(() => {
    headers.set(headers.get() + 1)
    return () => headers.set(headers.get() - 1)
  })
  return (
    <Show
      when={viewport() !== 'phone'}
      fallback={
        <PhoneHeader panels={panels()} sidebar={sidebar()}>
          {props.children}
        </PhoneHeader>
      }
    >
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
          <Slot fallback={inlineFailure} name="header.right" />
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
    </Show>
  )
}
