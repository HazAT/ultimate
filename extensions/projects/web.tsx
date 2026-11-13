// The project switcher (`shell.rail`): every Ultimate running on this machine as a tile at the window's left edge.
// Hover opens it over the app with names and ports; pin keeps it open beside the app. A tile is a link to that
// instance's `/`, which opens its @ultimate. It steps aside for any other extension that fills `shell.rail`.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { api, cn, defineWebExtension, useAction, useExtensions, useViewport } from '@/sdk'
import { ListAction, PinAction } from './refs.ts'
import type { RunningProject } from './refs.ts'

const RAIL = 52
const WIDE = 232
/** Live state every 4 s while the page is visible; the shared pin every 30 s. */
const LIVE = 4_000
const PIN = 30_000

/** Two letters from the project name: initials of its words, else its first two letters. */
function monogram(name: string) {
  const words = name.split(/[-_.\s]+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toLowerCase()
}

const port = (url: string) => new URL(url).port || '80'

/**
 * The project this tab is navigating to. The old page stays until the new one paints, which takes seconds while the
 * target builds its bundle, so the rail marks the target and a bar runs along the top. A page restored by Back from the
 * browser's cache clears it, and so does a navigation stopped on this page, after 15 s.
 */
let opening: string | undefined
let expiry: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const setOpening = (url: string | undefined) => {
  opening = url
  clearTimeout(expiry)
  if (url) expiry = setTimeout(() => setOpening(undefined), 15_000)
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const useOpening = () => useSyncExternalStore(subscribe, () => opening)
if (typeof window !== 'undefined') window.addEventListener('pageshow', () => setOpening(undefined))

/** A thin brand bar across the top of the window while this tab navigates to another project. */
function OpeningBar() {
  if (!useOpening()) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 animate-sweep bg-brand/30 bg-size-[300%_100%] bg-no-repeat bg-[linear-gradient(90deg,transparent_30%,var(--color-brand)_50%,transparent_70%)]"
    />
  )
}

/** Calls `refetch` every `every` ms while the page is visible, and when it becomes visible. */
function usePoll(refetch: () => Promise<unknown>, every: number) {
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== 'visible') return
      // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
      void refetch()
    }
    const timer = setInterval(visible, every)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refetch, every])
}

/** Whether the rail is pinned: one value for every instance on this machine, so a jump keeps the rail as it was. */
function usePinned() {
  const shared = useAction(PinAction, {}, { onError: () => {} })
  usePoll(shared.refetch, PIN)
  const [pinned, setPinned] = useState<boolean>()
  const stored = shared.data?.pinned
  useEffect(() => {
    if (stored !== undefined) setPinned(stored)
  }, [stored])
  const set = (next: boolean) => {
    setPinned(next)
    // A failed write leaves this page's value; the next poll brings the file's back.
    api.action(PinAction, { pinned: next }).catch(() => {})
  }
  return [pinned ?? false, set] as const
}

function BusyDot({ className }: { className?: string }) {
  return (
    <span className={cn('size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand', className)} />
  )
}

function QuestionBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        'flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 font-mono text-[9.5px] font-semibold text-background tabular-nums',
        className,
      )}
    >
      {count}
    </span>
  )
}

function Row({ project, wide }: { project: RunningProject; wide: boolean }) {
  const here = project.current
  const pending = useOpening() === project.url
  const busy = (project.busy ?? 0) > 0
  const questions = project.questions ?? 0
  const title = [
    project.name,
    `:${port(project.url)}`,
    questions && `${questions} for you`,
    busy && 'working',
    here && 'this tab',
    pending && 'opening',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <a
      aria-current={here ? 'page' : undefined}
      aria-label={title}
      className={cn(
        'group relative flex h-9 w-full items-center text-left outline-none',
        here ? 'cursor-default' : 'cursor-pointer',
        wide && !here && 'hover:bg-sidebar-accent/50',
        wide && here && 'bg-brand/10',
      )}
      href={here ? undefined : `${project.url}/`}
      onClick={(event) => {
        // A plain click navigates this tab: mark it. Mod-click and middle-click open another tab and leave this one.
        if (
          here ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        setOpening(project.url)
      }}
      title={title}
    >
      <span
        className={cn(
          'absolute left-0 w-[3px] rounded-r-full bg-brand transition-all duration-150',
          here || pending ? 'h-6' : 'h-0 group-hover:h-2.5 group-hover:bg-muted-foreground/60',
          pending && 'animate-pulse-dot',
        )}
      />
      <span className="flex w-[52px] shrink-0 justify-center">
        <span
          className={cn(
            'relative flex size-7 items-center justify-center rounded-lg font-mono text-[10.5px] font-medium transition-colors group-focus-visible:ring-1 group-focus-visible:ring-ring',
            here
              ? 'bg-brand/20 text-brand ring-1 ring-brand/50'
              : pending
                ? 'animate-pulse-dot bg-brand/15 text-brand ring-1 ring-brand/40'
                : 'bg-sidebar-accent/60 text-muted-foreground group-hover:text-foreground',
          )}
        >
          {monogram(project.name)}
          {!wide && questions > 0 && (
            <QuestionBadge
              className="absolute -top-1.5 -right-1.5 ring-2 ring-sidebar"
              count={questions}
            />
          )}
          {!wide && busy && (
            <BusyDot className="absolute -right-0.5 -bottom-0.5 size-2 ring-2 ring-sidebar" />
          )}
        </span>
      </span>
      {wide && (
        <span className="flex min-w-0 flex-1 items-center gap-2 pr-3">
          <span
            className={cn(
              'min-w-0 truncate text-[13px]',
              here ? 'font-medium text-brand' : 'text-foreground/85',
            )}
          >
            {project.name}
          </span>
          <span
            className={cn(
              'shrink-0 font-mono text-[10px]',
              pending ? 'text-brand' : 'text-muted-foreground/60',
            )}
          >
            {pending ? 'opening…' : `:${port(project.url)}`}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {busy && <BusyDot />}
            {questions > 0 && <QuestionBadge count={questions} />}
          </span>
        </span>
      )}
    </a>
  )
}

/** The rail's shape while the list loads, so it holds its place and width. */
function RailSkeleton({ wide }: { wide: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none">
      {['w-24', 'w-32', 'w-20', 'w-28'].map((name) => (
        <span className="flex h-9 items-center" key={name}>
          <span className="flex w-[52px] shrink-0 justify-center">
            <Skeleton className="size-7 rounded-lg bg-sidebar-accent/60" />
          </span>
          {wide && (
            <span className="flex min-w-0 flex-1 items-center gap-2 pr-3">
              <Skeleton className={cn('h-2.5 rounded-sm bg-sidebar-accent/60', name)} />
              <Skeleton className="h-2 w-7 rounded-sm bg-sidebar-accent/40" />
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

function Rail() {
  const viewport = useViewport()
  // Another extension's rail (a fleet switcher, say) takes the slot: two rails side by side would be one too many.
  const other = useExtensions().some(
    (record) => record.name !== 'projects' && record.extension?.slots?.['shell.rail'],
  )
  const list = useAction(ListAction, null, { onError: () => {}, enabled: !other })
  usePoll(list.refetch, LIVE)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = usePinned()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const projects = list.data ?? []
  const loading = !list.data && !list.error
  // A list that arrives after the skeleton fades in over it; one already there on mount just shows.
  const waited = useRef(loading).current
  // On phones, like the shell's other rails; and with only this project running there is nothing to switch to.
  if (other || viewport === 'phone' || (!loading && projects.length < 2)) return null

  const wide = hover || pinned
  const questions = projects.reduce((sum, project) => sum + (project.questions ?? 0), 0)
  const working = projects.filter((project) => (project.busy ?? 0) > 0).length

  return (
    <div className="relative shrink-0" style={{ width: pinned ? WIDE : RAIL }}>
      <nav
        aria-label="Projects"
        className={cn(
          'absolute inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,box-shadow] duration-150 ease-out',
          hover && !pinned && 'shadow-2xl shadow-black/40',
        )}
        onMouseEnter={() => {
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setHover(true), 150)
        }}
        onMouseLeave={() => {
          clearTimeout(timer.current)
          setHover(false)
        }}
        // Keyboard: tabbing into the rail opens it like hovering, leaving it closes it.
        onFocus={() => setHover(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setHover(false)
        }}
        style={{ width: wide ? WIDE : RAIL }}
      >
        {/* Every horizontal rail line continues an app line: this one the title bar's (h-9, core shell). */}
        <div className="flex h-9 shrink-0 items-center border-b border-border/70">
          <span className="flex w-[52px] shrink-0 justify-center font-mono text-[9px] tracking-[0.2em] text-brand">
            U
          </span>
          {wide && (
            <>
              <span className="font-mono text-[10px] tracking-[0.3em] text-brand">PROJECTS</span>
              <button
                className="mr-2 ml-auto cursor-pointer rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                onClick={() => setPinned(!pinned)}
                type="button"
              >
                {pinned ? 'unpin' : 'pin'}
              </button>
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-1 pb-2 [scrollbar-width:none]">
          {loading && <RailSkeleton wide={wide} />}
          <div className={cn(waited && 'animate-fade-in')}>
            {projects.map((project) => (
              <Row key={project.url} project={project} wide={wide} />
            ))}
          </div>
        </div>
        {/* Same height and border as the status line beside it (core primitives.tsx), so the two read as one line. */}
        <div className="flex h-7 shrink-0 items-center border-t border-border/70 font-mono text-[10px] text-muted-foreground/70 md:pointer-coarse:box-content md:pointer-coarse:pb-3">
          <span className="flex w-[52px] shrink-0 justify-center">
            {questions > 0 && <span className="size-1.5 rounded-full bg-warning" />}
          </span>
          {wide && !loading && (
            <span className="truncate">{`${questions} for you · ${working} working`}</span>
          )}
        </div>
      </nav>
    </div>
  )
}

export default defineWebExtension({
  slots: { 'shell.rail': Rail, overlay: OpeningBar },
})
