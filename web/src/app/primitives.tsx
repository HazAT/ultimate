// The building blocks of surfaces, exported from `@/sdk`. Each is a thin wrapper over what the shell already has.
import { cn } from 'cn'
import {
  EllipsisIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode, TouchEvent } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { actions, layout, shellKeys } from '../sdk/actions.ts'
import {
  useConversation,
  useExtensions,
  usePanels,
  useRegionOpen,
  useUiState,
} from '../sdk/hooks.ts'
import { slotItems } from '../sdk/registry.ts'
import type { PanelItem } from '../sdk/registry.ts'
import { overlays, useViewport } from '../sdk/viewport.ts'
import { ExtensionBoundary, Slot } from './boundary.tsx'
import { Composer } from './composer.tsx'
import { IconButton } from './header.tsx'
import { useSurfaceId } from './surface.ts'
import { Transcript } from './transcript.tsx'

/**
 * The bottom line with the `statusline.left` and `statusline.right` slots. On a touch screen of tablet width (an
 * unfolded foldable, a tablet) the page reaches the display's rounded corners, so the line's ends move in and up to
 * clear them. A phone keeps only the items marked `phone` on the line, moved in from the corners, and lists the
 * rest in a ⋯ popover.
 */
export function StatusLine() {
  const phone = useViewport() === 'phone'
  return (
    <footer
      className="status-line flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t border-border/70 bg-sidebar px-3 font-mono text-[0.7188rem] text-muted-foreground max-md:px-8 md:pointer-coarse:box-content md:pointer-coarse:px-7 md:pointer-coarse:pb-3"
      data-ui="status-line"
    >
      {phone ? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
            <Slot name="statusline.left" phone variant="inline" />
            <Slot name="statusline.right" phone variant="inline" />
          </div>
          <StatusMore />
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden whitespace-nowrap">
            <Slot name="statusline.left" variant="inline" />
          </div>
          <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
            <Slot name="statusline.right" variant="inline" />
          </div>
        </>
      )}
    </footer>
  )
}

/** On a phone, the status-line items that don't fit the line: one per row, each still opening its own popover. */
function StatusMore() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="More status"
          className="-mx-1 flex shrink-0 items-center rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          type="button"
        >
          <EllipsisIcon className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-auto max-w-[calc(100vw-2rem)] flex-col items-start gap-2.5 px-3 py-2.5 font-mono text-[0.7188rem] whitespace-nowrap text-muted-foreground"
        side="top"
      >
        <Slot name="statusline.left" phone={false} variant="inline" />
        <Slot name="statusline.right" phone={false} variant="inline" />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The shown conversation: transcript and composer, filling the space it gets. `main` centres a reading column;
 * `dock` fits a narrow side region such as a `Dock`.
 */
export function Conversation({ variant = 'main' }: { variant?: 'main' | 'dock' }) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Transcript dock={variant === 'dock'} />
      <Composer dock={variant === 'dock'} />
      <Slot name="conversation.overlay" />
    </div>
  )
}

/** Mount `region` while this component is, so the header shows its toggle. Before paint: no flicker. */
function useMountRegion(region: 'sidebar' | 'panels') {
  useLayoutEffect(() => layout.mount(region), [region])
}

/**
 * A region over the conversation, sliding in from `side` at most of the window's width; the strip of conversation
 * beside it closes it on a tap, and so does a swipe towards its edge. Its content stays mounted once it has opened.
 */
function Overlay({
  side,
  open,
  onClose,
  className,
  children,
}: {
  side: 'left' | 'right'
  open: boolean
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  const [drag, setDrag] = useState<number>()
  const touch = useRef<{ x: number; y: number; swipe?: boolean }>(undefined)
  const sign = side === 'left' ? -1 : 1

  const start = (event: TouchEvent) => {
    const { clientX: x, clientY: y } = event.touches[0]
    touch.current = { x, y }
  }
  const move = (event: TouchEvent) => {
    const from = touch.current
    if (!from) return
    const dx = event.touches[0].clientX - from.x
    const dy = event.touches[0].clientY - from.y
    // The first clear movement decides between a swipe and a scroll.
    if (from.swipe === undefined && Math.hypot(dx, dy) > 8) from.swipe = Math.abs(dx) > Math.abs(dy)
    if (from.swipe) setDrag(Math.max(0, dx * sign) * sign)
  }
  const end = () => {
    if (drag !== undefined && Math.abs(drag) > 64) onClose()
    touch.current = undefined
    setDrag(undefined)
  }

  return (
    <div className={cn('fixed inset-0 z-40', !open && 'pointer-events-none')} inert={!open}>
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 bg-black/50 transition-opacity duration-300',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          'absolute inset-y-0 flex w-[85%] max-w-[26rem] flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/40 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
          !open && (side === 'left' ? '-translate-x-full' : 'translate-x-full'),
          drag !== undefined && 'transition-none',
          className,
        )}
        onTouchCancel={end}
        onTouchEnd={end}
        onTouchMove={move}
        onTouchStart={start}
        style={drag ? { transform: `translateX(${drag}px)` } : undefined}
      >
        {opened && children}
      </aside>
    </div>
  )
}

/** The `sidebar` slot as a left column (`mod+b`), or over the conversation on a phone; gone while nothing is in it. */
/**
 * The docked sidebar's width (18 rem); the title bar's left part takes it beyond a phone on every surface, so the
 * surface tabs stay put and start where Agent's sidebar ends. Change both together.
 */
export const sidebarWidth = 'w-72'
export const sidebarWidthBeyondPhone = 'md:w-72'

export function Sidebar() {
  useMountRegion('sidebar')
  const open = useRegionOpen('sidebar')
  const viewport = useViewport()
  const empty = slotItems(useExtensions(), 'sidebar').length === 0
  if (empty) return null
  const look = 'overflow-y-auto border-sidebar-border bg-sidebar text-sidebar-foreground'
  if (overlays('sidebar', viewport))
    return (
      <Overlay className={look} onClose={actions.toggleSidebar} open={open} side="left">
        <Slot name="sidebar" />
      </Overlay>
    )
  if (!open) return null
  return (
    <aside className={cn('flex shrink-0 flex-col border-r', sidebarWidth, look)}>
      <Slot name="sidebar" />
    </aside>
  )
}

const tab = 'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 whitespace-nowrap'
const tabButton =
  'text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset'
const GAP = 2

/** How the tabs fit: whether the others drop their labels, and which of them move into the `⋯` menu. */
type Fit = { compact: boolean; overflow: Set<string> }

const key = (panel: PanelItem) => `${panel.extension}:${panel.id}`

/**
 * A tab per extension panel. When not every label fits, the tabs other than the shown one keep only their icon and
 * name themselves in a tooltip; when even the icons do not fit, the last ones move into a `⋯` menu. The shown tab
 * always stays in the row.
 */
function PanelTabs({ panels, active }: { panels: PanelItem[]; active: PanelItem }) {
  const row = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<Fit>({ compact: false, overflow: new Set() })
  useLayoutEffect(() => {
    const compute = () => {
      const width = (name: string) =>
        measure.current!.querySelector<HTMLElement>(`[data-measure="${name}"]`)!.offsetWidth
      const available = row.current!.clientWidth
      const labelled = panels.map((panel) => width(`label:${key(panel)}`))
      const icons = panels.map((panel) => width(`icon:${key(panel)}`))
      const gaps = GAP * (panels.length - 1)
      const next: Fit = { compact: false, overflow: new Set() }
      if (labelled.reduce((a, b) => a + b, 0) + gaps > available) {
        next.compact = true
        const at = panels.indexOf(active)
        const others = panels.flatMap((_, index) => (index === at ? [] : [index]))
        const compact = labelled[at] + others.reduce((sum, index) => sum + icons[index], 0) + gaps
        if (compact > available) {
          let used = labelled[at] + GAP + width('more')
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
    observer.observe(row.current!)
    observer.observe(measure.current!)
    return () => observer.disconnect()
  }, [panels, active])
  const hidden = panels.filter((panel) => fit.overflow.has(key(panel)))
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-2 font-mono text-[0.7188rem]">
      <div className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" ref={row}>
        {/* Every tab with and without its label, and the menu button, unseen: what fits. */}
        <div aria-hidden className="invisible absolute flex w-max gap-0.5" ref={measure}>
          {panels.map((panel) => {
            const Icon = panel.icon
            return (
              <span className="contents" key={key(panel)}>
                <span className={tab} data-measure={`label:${key(panel)}`}>
                  {Icon && <Icon className="size-3.5" />}
                  {panel.title}
                </span>
                <span className={tab} data-measure={`icon:${key(panel)}`}>
                  {Icon ? <Icon className="size-3.5" /> : panel.title}
                </span>
              </span>
            )
          })}
          <span className={tab} data-measure="more">
            <EllipsisIcon className="size-3.5" />
          </span>
        </div>
        {panels.map((panel) => {
          if (fit.overflow.has(key(panel))) return null
          const compact = fit.compact
          const Icon = panel.icon
          const iconOnly = compact && Icon !== undefined && panel.id !== active.id
          const button = (
            <button
              aria-label={iconOnly ? panel.title : undefined}
              className={cn(tab, tabButton, panel.id === active.id && 'bg-accent text-foreground')}
              key={`${panel.extension}:${panel.id}`}
              onClick={() => actions.openPanel(panel.id)}
              type="button"
            >
              {Icon && <Icon className="size-3.5" />}
              {!iconOnly && panel.title}
            </button>
          )
          return iconOnly ? (
            <Tooltip key={`${panel.extension}:${panel.id}`}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="bottom">{panel.title}</TooltipContent>
            </Tooltip>
          ) : (
            button
          )
        })}
        {hidden.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={`${hidden.length} more panels`}
                className={cn(tab, tabButton, 'data-[state=open]:text-foreground')}
                title="More panels"
                type="button"
              >
                <EllipsisIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {hidden.map((panel) => {
                const Icon = panel.icon
                return (
                  <DropdownMenuItem
                    className="gap-2 py-1 font-mono text-[0.75rem]"
                    key={key(panel)}
                    onSelect={() => actions.openPanel(panel.id)}
                  >
                    {Icon && <Icon className="size-3.5" />}
                    {panel.title}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}

/** The right panel: a tab per extension panel (`mod+alt+b`), over the conversation below desktop width. */
export function Panels() {
  useMountRegion('panels')
  const { open, active, tabs } = usePanels()
  const viewport = useViewport()
  // Only tabless panels and none opened: nothing to show until one is.
  if (!active) return null
  const overlay = overlays('panels', viewport)
  if (!open && !overlay) return null
  const Panel = active.component
  const content = (
    <>
      <PanelTabs active={active} panels={tabs} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ExtensionBoundary
          extension={active.extension}
          key={`${active.extension}:${active.id}`}
          version={active.version}
        >
          <Panel />
        </ExtensionBoundary>
      </div>
    </>
  )
  if (overlay)
    return (
      <Overlay
        className="border-border/70 bg-sidebar"
        onClose={actions.closePanel}
        open={open}
        side="right"
      >
        {content}
      </Overlay>
    )
  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-border/70 bg-sidebar">
      {content}
    </aside>
  )
}

const DOCK_WIDTH = 416
const MIN_WIDTH = 280
/** The widest a dock gets: the window less room for the surface beside it. */
const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - 360)
const clamp = (width: number) => Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth()))

/**
 * A collapsible, resizable side region, usually holding `<Conversation variant="dock" />`. Collapsed it is a rail
 * that still shows when the agent works. Open state and width are durable per surface and side
 * (`shell.dock.<surface>.<side>`); drag the inner edge to resize, double-click it to reset.
 */
export function Dock({
  title = 'conversation',
  side = 'right',
  children,
}: {
  title?: string
  side?: 'left' | 'right'
  children: ReactNode
}) {
  const surface = useSurfaceId()
  const [stored, setStored] = useUiState<{ open?: boolean; width?: number }>(
    `${shellKeys.dock}.${surface}.${side}`,
    { open: true, width: DOCK_WIDTH },
  )
  const open = stored.open !== false
  const [dragging, setDragging] = useState<number>()
  const live = useRef<number | undefined>(undefined)
  const { busy } = useConversation()
  const width = clamp(dragging ?? (typeof stored.width === 'number' ? stored.width : DOCK_WIDTH))
  const border = side === 'right' ? 'border-l' : 'border-r'
  const setOpen = (next: boolean) => setStored({ open: next, width })

  if (!open)
    return (
      <aside
        className={cn(
          'flex w-10 shrink-0 flex-col items-center gap-2 border-border/70 py-2',
          border,
        )}
      >
        <IconButton label={`Show ${title}`} onClick={() => setOpen(true)}>
          {side === 'right' ? (
            <PanelRightOpenIcon className="size-4" />
          ) : (
            <PanelLeftOpenIcon className="size-4" />
          )}
        </IconButton>
        {busy && <span className="size-1.5 animate-pulse-dot rounded-full bg-brand" />}
      </aside>
    )

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const start = event.clientX
    handle.setPointerCapture(event.pointerId)
    const move = (next: globalThis.PointerEvent) => {
      const delta = side === 'right' ? start - next.clientX : next.clientX - start
      live.current = clamp(width + delta)
      setDragging(live.current)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      if (live.current !== undefined) setStored({ open: true, width: live.current })
      live.current = undefined
      setDragging(undefined)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  return (
    <aside
      className={cn('relative flex shrink-0 flex-col border-border/70', border)}
      style={{ width }}
    >
      <div
        aria-label={`Resize ${title}`}
        aria-orientation="vertical"
        className={cn(
          'absolute inset-y-0 z-10 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-brand/60 after:opacity-0 after:transition-opacity hover:after:opacity-100',
          side === 'right' ? '-left-1' : '-right-1',
          dragging !== undefined && 'after:opacity-100',
        )}
        onDoubleClick={() => setStored({ open: true, width: DOCK_WIDTH })}
        onPointerDown={resize}
        role="separator"
      />
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 pr-1 pl-3 font-mono text-[0.7188rem] text-muted-foreground">
        {title}
        <IconButton label={`Hide ${title}`} onClick={() => setOpen(false)}>
          {side === 'right' ? (
            <PanelRightCloseIcon className="size-4" />
          ) : (
            <PanelLeftCloseIcon className="size-4" />
          )}
        </IconButton>
      </div>
      {children}
    </aside>
  )
}

export { Header } from './header.tsx'
export { Slot }
