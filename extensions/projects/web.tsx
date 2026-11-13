// The project switcher (`shell.rail`): every Ultimate running on this machine as a colour swatch at the window's left edge.
// Hover opens it over the app with names, repositories and ports; pin keeps it open beside the app. A row is a link to that
// instance's `/`, which opens its @ultimate. It steps aside for any other extension that fills `shell.rail`.
import { PinIcon, PinOffIcon } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import {
  api,
  cn,
  defineWebExtension,
  prettyName,
  useAction,
  useExtensions,
  useViewport,
} from '@/sdk'
import { ProjectSwatch, RepoLabel, stemOf } from '../sidebar/ui.tsx'
import { ListAction, PinAction } from './refs.ts'
import type { RunningProject } from './refs.ts'

const RAIL = 56
const WIDE = 272
/** Live state every 4 s while the page is visible; the shared pin every 30 s. */
const LIVE = 4_000
const PIN = 30_000

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

/** Calls `refetch` every `every` ms while the page is visible, and when it becomes visible; never while `off`. */
function usePoll(refetch: () => Promise<unknown>, every: number, off = false) {
  useEffect(() => {
    if (off) return undefined
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
  }, [refetch, every, off])
}

/** Whether the rail is pinned: one value for every instance on this machine, so a jump keeps the rail as it was. */
function usePinned(off: boolean) {
  const shared = useAction(PinAction, {}, { onError: () => {}, enabled: !off })
  usePoll(shared.refetch, PIN, off)
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

/** The project's identity under its name: its GitHub repository when known, and its port. */
function Detail({ project, pending }: { project: RunningProject; pending: boolean }) {
  if (pending) return <span className="text-brand">opening…</span>
  return (
    <>
      {project.repo && <RepoLabel className="min-w-0" repo={project.repo} />}
      <span className="shrink-0 text-muted-foreground/50">:{port(project.url)}</span>
    </>
  )
}

/** What waits in a project, loudest first: questions for the user in amber, else a pulsing dot while it works. */
function State({ busy, questions }: { busy: boolean; questions: number }) {
  if (questions > 0)
    return (
      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/15 px-1.5 font-mono text-[10px] font-semibold text-amber-700 tabular-nums ring-1 ring-amber-500/30 ring-inset dark:text-amber-300">
        {questions}
      </span>
    )
  if (busy) return <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
  return null
}

/**
 * One project. Collapsed it is its swatch, a segment of the rail's colour column: a family's segments (`first`,
 * `last`) join into one strip, rounded at its ends, with a gap before the next family.
 */
function Row({
  project,
  wide,
  first,
  last,
  family,
}: {
  project: RunningProject
  wide: boolean
  first: boolean
  last: boolean
  /** Every running project's folder name, for the shades of a family. */
  family: readonly string[]
}) {
  const here = project.current
  const pending = useOpening() === project.url
  const busy = (project.busy ?? 0) > 0
  const questions = project.questions ?? 0
  const name = prettyName(project.name)
  const title = [
    name,
    project.repo?.name,
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
        'group relative mx-1.5 flex h-10 items-center rounded-lg text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
        here ? 'cursor-default' : 'cursor-pointer',
        wide && (here ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50'),
      )}
      data-project={project.name}
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
      {/* The edge bar: the project this tab shows, or the one it is opening; a hint of it on hover. */}
      <span
        className={cn(
          'absolute -left-1.5 w-[3px] rounded-r-full transition-all duration-150',
          here || pending ? 'h-6 bg-brand' : 'h-0 bg-muted-foreground/60 group-hover:h-3',
          pending && 'animate-pulse-dot',
        )}
      />
      <span
        className={cn(
          'relative flex h-full w-11 shrink-0 items-stretch justify-center',
          !first && 'pt-px',
          !last && 'pb-px',
        )}
      >
        <ProjectSwatch
          className={cn(
            'transition-[width,opacity] duration-150',
            here || pending ? 'w-5' : 'w-3 opacity-70 group-hover:w-4 group-hover:opacity-100',
            first && 'rounded-t-md',
            last && 'rounded-b-md',
            pending && 'animate-pulse-dot',
          )}
          family={family}
          folder={project.name}
        />
        {!wide && questions > 0 && (
          <span className="absolute top-1/2 left-1/2 flex h-4 min-w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-amber-400 px-1 font-mono text-[9.5px] font-semibold text-black tabular-nums ring-2 ring-sidebar">
            {questions}
          </span>
        )}
        {!wide && busy && questions === 0 && (
          <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 animate-pulse-dot rounded-full bg-brand ring-2 ring-sidebar" />
        )}
      </span>
      {wide && (
        <span className="flex min-w-0 flex-1 items-center gap-2 pr-2.5 pl-1.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                'truncate text-[13px] leading-5',
                here ? 'font-semibold text-foreground' : 'text-foreground/85',
              )}
            >
              {name}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-4 text-muted-foreground/80">
              <Detail pending={pending} project={project} />
            </span>
          </span>
          <State busy={busy} questions={questions} />
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
        <span className="mx-1.5 flex h-10 items-center" key={name}>
          <span className="flex h-full w-11 shrink-0 justify-center py-px">
            <Skeleton className="h-full w-3 rounded-sm bg-sidebar-accent/60" />
          </span>
          {wide && (
            <span className="flex min-w-0 flex-1 flex-col gap-1.5 pl-1.5">
              <Skeleton className={cn('h-2.5 rounded-sm bg-sidebar-accent/60', name)} />
              <Skeleton className="h-2 w-16 rounded-sm bg-sidebar-accent/40" />
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
  usePoll(list.refetch, LIVE, other)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = usePinned(other)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const projects = list.data ?? []
  const loading = !list.data && !list.error
  // A list that arrives after the skeleton fades in over it; one already there on mount just shows.
  const waited = useRef(loading).current
  // On phones, like the shell's other rails; and with only this project running there is nothing to switch to.
  if (other || viewport === 'phone' || (!loading && projects.length < 2)) return null

  const wide = hover || pinned
  const family = projects.map((project) => project.name)
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
          <span className="flex w-14 shrink-0 justify-center font-mono text-[9px] tracking-[0.2em] text-brand">
            U
          </span>
          {wide && (
            <>
              <span className="section-label">Projects</span>
              <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/60 tabular-nums">
                {projects.length || ''}
              </span>
              <button
                aria-label={pinned ? 'Unpin the projects rail' : 'Pin the projects rail open'}
                aria-pressed={pinned}
                className={cn(
                  'mr-2 ml-auto flex size-6 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                  pinned ? 'text-foreground' : 'text-muted-foreground/70',
                )}
                onClick={() => setPinned(!pinned)}
                title={pinned ? 'Unpin: open on hover' : 'Pin: keep open beside the app'}
                type="button"
              >
                {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
              </button>
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-2 pb-2 [scrollbar-width:none]">
          {loading && <RailSkeleton wide={wide} />}
          <div className={cn('flex flex-col', waited && 'animate-fade-in')}>
            {projects.map((project, index) => {
              const stem = stemOf(project.name)
              const first = index === 0 || stemOf(projects[index - 1].name) !== stem
              const last = stemOf(projects[index + 1]?.name ?? '') !== stem
              return (
                <div className={cn(first && index > 0 && 'mt-2')} key={project.url}>
                  <Row family={family} first={first} last={last} project={project} wide={wide} />
                </div>
              )
            })}
          </div>
        </div>
        {/* Same height and border as the status line beside it (core primitives.tsx), so the two read as one line. */}
        <div className="flex h-7 shrink-0 items-center border-t border-border/70 font-mono text-[10px] text-muted-foreground/70 md:pointer-coarse:box-content md:pointer-coarse:pb-3">
          <span className="flex w-14 shrink-0 justify-center">
            {questions > 0 && <span className="size-1.5 rounded-full bg-amber-400" />}
          </span>
          {wide && !loading && (
            <span className="truncate">
              <span className={cn(questions > 0 && 'text-amber-700 dark:text-amber-300')}>
                {questions} for you
              </span>
              {` · ${working} working`}
            </span>
          )}
        </div>
      </nav>
    </div>
  )
}

export default defineWebExtension({
  slots: { 'shell.rail': Rail, overlay: OpeningBar },
})
