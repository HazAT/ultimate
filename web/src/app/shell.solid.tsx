/** @jsxImportSource @solidjs/web */
import {
  Ellipsis,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { cn } from 'cn'
import { createEffect, createMemo, createRenderEffect, createSignal, For, Show } from 'solid-js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  openPanel,
  overlays,
  useConversation,
  useExtensions,
  usePanels,
  useRegionOpen,
  useStore,
  useUiState,
  useViewport,
} from '../sdk/hooks.ts'
import { actions, layout, shellKeys } from '../sdk/actions.ts'
import { Contribution, ContributedIcon, Slot } from '../sdk/contribution.solid.tsx'
import { HOME, panelBadges, slotItems } from '../sdk/registry.ts'
import type { PanelItem } from '../sdk/registry.ts'

import { Composer } from './composer.solid.tsx'
import { reportedFailure } from './error-stack.solid.tsx'
import { IconButton, inlineFailure } from './header.solid.tsx'
import { setStatusTarget } from './status-target.ts'
import { Transcript } from './transcript.solid.tsx'

export const [sidebarWidth, sidebarWidthBeyondPhone] = ['w-72', 'md:w-72'] as const

export function StatusLine() {
  const viewport = useViewport()
  return (
    <footer
      class="status-line flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border/70 bg-sidebar px-3 font-mono text-[11.5px] text-muted-foreground max-md:px-8 md:pointer-coarse:box-content md:pointer-coarse:px-7 md:pointer-coarse:pb-3"
      data-ui="status-line"
    >
      <Show
        when={viewport() === 'phone'}
        fallback={
          <>
            <div class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
              <Slot fallback={inlineFailure} name="statusline.left" variant="inline" />
            </div>
            <div class="flex shrink-0 items-center gap-3 whitespace-nowrap">
              <Slot fallback={inlineFailure} name="statusline.right" variant="inline" />
            </div>
          </>
        }
      >
        <div class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
          <ComposerStatusTarget />
          <Slot fallback={inlineFailure} name="statusline.left" phone variant="inline" />
          <Slot fallback={inlineFailure} name="statusline.right" phone variant="inline" />
        </div>
        <StatusMore />
      </Show>
    </footer>
  )
}

function ComposerStatusTarget() {
  const target = (
    <div class="flex min-w-0 shrink items-center gap-3 overflow-hidden empty:hidden" />
  ) as HTMLDivElement
  createRenderEffect(
    () => target,
    (element) => {
      setStatusTarget(element)
      return () => setStatusTarget(null)
    },
  )
  return target
}

function StatusMore() {
  return (
    <Popover>
      <StatusPopoverTrigger aria-label="More status" class="shrink-0">
        <Ellipsis aria-hidden="true" class="size-3.5" />
      </StatusPopoverTrigger>
      <PopoverContent
        align="end"
        class="flex w-auto max-w-[calc(100vw-2rem)] flex-col items-start gap-2.5 px-3 py-2.5 font-mono text-[11.5px] whitespace-nowrap text-muted-foreground"
        side="top"
      >
        <Slot fallback={inlineFailure} name="statusline.left" phone={false} variant="inline" />
        <Slot fallback={inlineFailure} name="statusline.right" phone={false} variant="inline" />
      </PopoverContent>
    </Popover>
  )
}

export function Conversation(props: { variant?: 'main' | 'dock' }) {
  return (
    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col" data-ui="conversation">
      <Transcript dock={props.variant === 'dock'} />
      <Composer dock={props.variant === 'dock'} />
      <Slot fallback={reportedFailure} name="conversation.overlay" />
    </div>
  )
}

function mountRegionBeforePaint(region: 'sidebar' | 'panels') {
  createRenderEffect(
    () => region,
    (mounted) => layout.mount(mounted),
  )
}

function Overlay(props: {
  side: 'left' | 'right'
  open: boolean
  onClose: () => void
  class?: string
  children: JSX.Element
}) {
  const everOpened = createMemo<boolean>((previous) => props.open || (previous ?? false))
  const [drag, setDrag] = createSignal<number>()
  let touch: { x: number; y: number; swipe?: boolean } | undefined
  const sign = () => (props.side === 'left' ? -1 : 1)
  const start = (event: TouchEvent) => {
    const { clientX: x, clientY: y } = event.touches[0]
    touch = { x, y }
  }
  const move = (event: TouchEvent) => {
    const from = touch
    if (!from) return
    const dx = event.touches[0].clientX - from.x
    const dy = event.touches[0].clientY - from.y
    const firstClearMovement = from.swipe === undefined && Math.hypot(dx, dy) > 8
    if (firstClearMovement) from.swipe = Math.abs(dx) > Math.abs(dy)
    if (from.swipe) setDrag(Math.max(0, dx * sign()) * sign())
  }
  const end = () => {
    const dragged = drag()
    if (dragged !== undefined && Math.abs(dragged) > 64) props.onClose()
    touch = undefined
    setDrag(undefined)
  }
  return (
    <div class={cn('fixed inset-0 z-40', !props.open && 'pointer-events-none')} inert={!props.open}>
      <div
        aria-hidden="true"
        class={cn(
          'absolute inset-0 bg-black/50 transition-opacity duration-300',
          props.open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={() => props.onClose()}
      />
      <aside
        class={cn(
          'absolute inset-y-0 flex w-[85%] max-w-[26rem] flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/40 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          props.side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
          !props.open && (props.side === 'left' ? '-translate-x-full' : 'translate-x-full'),
          drag() !== undefined && 'transition-none',
          props.class,
        )}
        onTouchCancel={end}
        onTouchEnd={end}
        onTouchMove={move}
        onTouchStart={start}
        style={drag() ? { transform: `translateX(${drag()}px)` } : undefined}
      >
        <Show when={props.open || everOpened()}>{props.children}</Show>
      </aside>
    </div>
  )
}

export function Sidebar() {
  mountRegionBeforePaint('sidebar')
  const open = useRegionOpen('sidebar')
  const viewport = useViewport()
  const extensions = useExtensions()
  const empty = () => slotItems(extensions(), 'sidebar').length === 0
  const look = 'overflow-y-auto border-sidebar-border bg-sidebar text-sidebar-foreground'
  return (
    <Show when={!empty()}>
      <Show
        when={overlays('sidebar', viewport())}
        fallback={
          <Show when={open()}>
            <aside class={cn('flex shrink-0 flex-col border-r', sidebarWidth, look)}>
              <Slot fallback={reportedFailure} name="sidebar" />
            </aside>
          </Show>
        }
      >
        <Overlay class={look} onClose={actions.toggleSidebar} open={open()} side="left">
          <Slot fallback={reportedFailure} name="sidebar" />
        </Overlay>
      </Show>
    </Show>
  )
}

const tab = 'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 whitespace-nowrap'
const tabButton =
  'font-mono text-[11.5px] font-normal text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset'
const GAP = 2

type Fit = { compact: boolean; overflow: ReadonlySet<string> }

const key = (panel: PanelItem) => `${panel.extension}:${panel.id}`

function TabBadges(props: { id: string }) {
  const extensions = useExtensions()
  return (
    <For
      each={panelBadges(extensions(), props.id)}
      keyed={(badge) => `${badge.extension}:${badge.version}`}
    >
      {(badge) => (
        <Contribution fallback={inlineFailure} inline item={badge()} props={{}} variant="inline" />
      )}
    </For>
  )
}

function TabIcon(props: { panel: PanelItem }) {
  return (
    <Show when={props.panel.icon}>
      {(icon) => <ContributedIcon class="size-3.5" icon={icon()} />}
    </Show>
  )
}

function PanelTabs(props: { panels: PanelItem[]; active: PanelItem }) {
  let row!: HTMLDivElement
  let measurements!: HTMLDivElement
  const [fit, setFit] = createSignal<Fit>({ compact: false, overflow: new Set() })
  createEffect(
    () => ({ panels: props.panels, active: props.active }),
    ({ panels, active }) => {
      const compute = () => {
        const width = (name: string) =>
          measurements.querySelector<HTMLElement>(`[data-measure="${name}"]`)!.offsetWidth
        const available = row.clientWidth
        const labelled = panels.map((panel) => width(`label:${key(panel)}`))
        const icons = panels.map((panel) => width(`icon:${key(panel)}`))
        const gaps = GAP * (panels.length - 1)
        const next = { compact: false, overflow: new Set<string>() }
        if (labelled.reduce((a, b) => a + b, 0) + gaps > available) {
          next.compact = true
          const alwaysVisibleActiveTab = panels.indexOf(active)
          const others = panels.flatMap((_, index) =>
            index === alwaysVisibleActiveTab ? [] : [index],
          )
          const compact =
            labelled[alwaysVisibleActiveTab] +
            others.reduce((sum, index) => sum + icons[index], 0) +
            gaps
          if (compact > available) {
            let used = labelled[alwaysVisibleActiveTab] + GAP + width('more')
            for (const index of others) {
              used += GAP + icons[index]
              if (used > available) next.overflow.add(key(panels[index]))
            }
          }
        }
        setFit((last) =>
          last.compact === next.compact &&
          [...next.overflow].join(' ') === [...last.overflow].join(' ')
            ? last
            : next,
        )
      }
      compute()
      const observer = new ResizeObserver(compute)
      observer.observe(row)
      observer.observe(measurements)
      return () => observer.disconnect()
    },
  )
  const hidden = () => props.panels.filter((panel) => fit().overflow.has(key(panel)))
  return (
    <div class="flex h-10 shrink-0 items-center border-b border-border/70 px-2 font-mono text-[11.5px]">
      <div class="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" ref={row}>
        <div
          aria-hidden="true"
          class="invisible absolute flex w-max gap-0.5"
          data-agent-hidden
          ref={measurements}
        >
          <For each={props.panels} keyed={key}>
            {(panel) => (
              <span class="contents">
                <span class={tab} data-measure={`label:${key(panel())}`}>
                  <TabIcon panel={panel()} />
                  {panel().title}
                  <TabBadges id={panel().id} />
                </span>
                <span class={tab} data-measure={`icon:${key(panel())}`}>
                  <Show when={panel().icon} fallback={panel().title}>
                    <TabIcon panel={panel()} />
                  </Show>
                  <TabBadges id={panel().id} />
                </span>
              </span>
            )}
          </For>
          <span class={tab} data-measure="more">
            <Ellipsis class="size-3.5" />
          </span>
        </div>
        <TabsList aria-label="Conversation panels" class="min-w-0 gap-0.5 border-0 p-0">
          <For each={props.panels.filter((panel) => !fit().overflow.has(key(panel)))} keyed={key}>
            {(panel) => {
              const iconOnly = () =>
                fit().compact && panel().icon !== undefined && panel().id !== props.active.id
              return (
                <Tooltip delay={400} disabled={!iconOnly()}>
                  <TooltipTrigger
                    render={(trigger) => (
                      <TabsTab
                        {...trigger}
                        aria-label={panel().title}
                        class={cn(tab, tabButton)}
                        value={panel().id}
                      >
                        <TabIcon panel={panel()} />
                        <span class={iconOnly() ? 'sr-only' : undefined}>{panel().title}</span>
                        <TabBadges id={panel().id} />
                      </TabsTab>
                    )}
                  />
                  <TooltipContent
                    class={iconOnly() ? undefined : 'hidden'}
                    data-agent-hidden
                    side="bottom"
                  >
                    {panel().title}
                  </TooltipContent>
                </Tooltip>
              )
            }}
          </For>
        </TabsList>
        <Show when={hidden().length > 0}>
          <DropdownMenu modal={false} onAction={(id) => openPanel(id)}>
            <DropdownMenuTrigger
              aria-label={`${hidden().length} more panels`}
              class={cn(tab, tabButton, 'data-open:text-foreground')}
              title="More panels"
            >
              <Ellipsis aria-hidden="true" class="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-44">
              <For each={hidden()} keyed={key}>
                {(panel) => (
                  <DropdownMenuItem class="gap-2 py-1 font-mono text-[12px]" value={panel().id}>
                    <TabIcon panel={panel()} />
                    {panel().title}
                    <TabBadges id={panel().id} />
                  </DropdownMenuItem>
                )}
              </For>
            </DropdownMenuContent>
          </DropdownMenu>
        </Show>
      </div>
    </div>
  )
}

export function Panels() {
  mountRegionBeforePaint('panels')
  const { open, active, tabs } = usePanels()
  const viewport = useViewport()
  const overlay = () => overlays('panels', viewport())
  const content = (panel: () => PanelItem) => (
    <Tabs bind={[() => panel().id, openPanel]} class="flex min-h-0 flex-1 flex-col">
      <PanelTabs active={panel()} panels={tabs()} />
      <For each={tabs()} keyed={key}>
        {(shown) => (
          <TabsPanel
            class="min-h-0 flex-1 overflow-y-auto not-data-selected:hidden"
            value={shown().id}
          >
            <Contribution fallback={reportedFailure} item={shown()} props={{}} />
          </TabsPanel>
        )}
      </For>
    </Tabs>
  )
  return (
    <Show when={active()}>
      {(panel) => (
        <Show
          when={overlay()}
          fallback={
            <Show when={open()}>
              <aside class="flex w-[22rem] shrink-0 flex-col border-l border-border/70 bg-sidebar">
                {content(panel)}
              </aside>
            </Show>
          }
        >
          <Overlay
            class="border-border/70 bg-sidebar"
            onClose={actions.closePanel}
            open={open()}
            side="right"
          >
            {content(panel)}
          </Overlay>
        </Show>
      )}
    </Show>
  )
}

const DOCK_WIDTH = 416
const MIN_WIDTH = 280
const MIN_SURFACE_WIDTH_BESIDE_DOCK_PX = 360
const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - MIN_SURFACE_WIDTH_BESIDE_DOCK_PX)
const clamp = (width: number) => Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth()))

export function Dock(props: { title?: string; side?: 'left' | 'right'; children?: JSX.Element }) {
  const title = () => props.title ?? 'conversation'
  const side = () => props.side ?? 'right'
  const surface = useStore((state) => state.ui.surface?.id ?? HOME)
  const [stored, setStored] = useUiState<{ open?: boolean; width?: number }>(
    () => `${shellKeys.dock}.${surface()}.${side()}`,
    { open: true, width: DOCK_WIDTH },
  )
  const open = () => stored().open !== false
  const [dragging, setDragging] = createSignal<number>()
  const conversation = useConversation()
  const width = () => {
    const saved = stored().width
    return clamp(dragging() ?? (typeof saved === 'number' ? saved : DOCK_WIDTH))
  }
  const border = () => (side() === 'right' ? 'border-l' : 'border-r')
  const setOpen = (next: boolean) => setStored({ open: next, width: width() })

  const resize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const start = event.clientX
    const from = width()
    const towardsSurface = side() === 'right' ? -1 : 1
    let live: number | undefined
    handle.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      live = clamp(from + (next.clientX - start) * towardsSurface)
      setDragging(live)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      if (live !== undefined) setStored({ open: true, width: live })
      setDragging(undefined)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  return (
    <Show
      when={open()}
      fallback={
        <aside
          class={cn(
            'flex w-10 shrink-0 flex-col items-center gap-2 border-border/70 py-2',
            border(),
          )}
        >
          <IconButton label={`Show ${title()}`} onClick={() => setOpen(true)}>
            <Show
              when={side() === 'right'}
              fallback={<PanelLeftOpen aria-hidden="true" class="size-4" />}
            >
              <PanelRightOpen aria-hidden="true" class="size-4" />
            </Show>
          </IconButton>
          <Show when={conversation().busy}>
            <span class="size-1.5 animate-pulse-dot rounded-full bg-brand" />
          </Show>
        </aside>
      }
    >
      <aside
        class={cn('relative flex shrink-0 flex-col border-border/70', border())}
        style={{ width: `${width()}px` }}
      >
        <div
          aria-hidden="true"
          class={cn(
            'absolute inset-y-0 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-brand/60 after:opacity-0 after:transition-opacity hover:after:opacity-100',
            side() === 'right' ? '-left-1' : '-right-1',
            dragging() !== undefined && 'after:opacity-100',
          )}
          onDblClick={() => setStored({ open: true, width: DOCK_WIDTH })}
          onPointerDown={resize}
          title={`Resize ${title()}`}
        />
        <div class="flex h-9 shrink-0 items-center justify-between border-b border-border/70 pr-1 pl-3 font-mono text-[11.5px] text-muted-foreground">
          {title()}
          <IconButton label={`Hide ${title()}`} onClick={() => setOpen(false)}>
            <Show
              when={side() === 'right'}
              fallback={<PanelLeftClose aria-hidden="true" class="size-4" />}
            >
              <PanelRightClose aria-hidden="true" class="size-4" />
            </Show>
          </IconButton>
        </div>
        {props.children}
      </aside>
    </Show>
  )
}
