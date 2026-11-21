/** @jsxImportSource @solidjs/web */
import { Pin, PinOff } from '@lucide/solid'
import { createMemo, createRoot, createSignal, For, onSettled, Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Button } from '@/components/ui/button.solid.tsx'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import {
  ROOT,
  api,
  cn,
  keepLast,
  prettyName,
  showSurface,
  useAction,
  useExtensions,
  useViewport,
} from '@/sdk/solid'
import { deadline, debounce } from '../../lib/timers.ts'
import { ProjectSwatch, RepoLabel, stemOf } from '../sidebar/ui.solid.tsx'
import { inboxTarget, shownPort, target } from './links.ts'
import { ListAction, PinAction } from './refs.ts'
import type { RunningProject } from './refs.ts'

const VISIBLE_PROJECTS_POLL_MS = 4_000
const SHARED_PIN_POLL_MS = 30_000
const NAVIGATION_EXPIRY_MS = 15_000
const HOVER_DELAY_MS = 150
const titleBarAlignedHeader = 'flex h-9 shrink-0 items-center border-b border-border/70'
const statusLineAlignedFooter =
  'flex h-7 shrink-0 items-center border-t border-border/70 font-mono text-[10px] text-muted-foreground/70 md:pointer-coarse:box-content md:pointer-coarse:pb-3'

const [opening, setOpening] = createRoot(() => createSignal<string>())
let cancelOpening: (() => void) | undefined
const open = (url: string | undefined) => {
  cancelOpening?.()
  setOpening(url)
  if (url) cancelOpening = deadline(NAVIGATION_EXPIRY_MS, () => setOpening())
}

export function OpeningBar() {
  onSettled(() => {
    const clear = () => open(undefined)
    window.addEventListener('pageshow', clear)
    return () => window.removeEventListener('pageshow', clear)
  })
  return (
    <Show when={opening()}>
      <div
        aria-hidden="true"
        class="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 animate-sweep bg-brand/30 bg-size-[300%_100%] bg-no-repeat bg-[linear-gradient(90deg,transparent_30%,var(--color-brand)_50%,transparent_70%)]"
      />
    </Show>
  )
}

const opensHere = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

function InboxLink(props: { project?: RunningProject; class?: string; children: JSX.Element }) {
  const here = () => !props.project || props.project.current
  const href = () =>
    here() ? `${location.pathname}?inbox=` : inboxTarget(props.project as RunningProject, location)
  const label = () =>
    here() ? 'Open the Inbox' : `Open ${prettyName(props.project?.name ?? '')}’s Inbox`
  return (
    <Show when={href()} fallback={<span class={props.class}>{props.children}</span>}>
      {(link) => (
        <a
          aria-label={props.project ? `${label()} · ${props.project.questions} for you` : undefined}
          class={cn('outline-none focus-visible:ring-1 focus-visible:ring-ring', props.class)}
          href={link()}
          onClick={(event) => {
            if (!opensHere(event)) return
            if (here()) {
              event.preventDefault()
              showSurface('inbox')
            } else open(props.project?.url)
          }}
          onMouseDown={(event) => event.preventDefault()}
          title={label()}
        >
          {props.children}
        </a>
      )}
    </Show>
  )
}

const [visible, setVisible] = createRoot(() => createSignal(true))
const shownNow = () => document.visibilityState === 'visible'

function refetchWhenShown(...reads: { refetch: () => unknown }[]) {
  onSettled(() => {
    setVisible(shownNow())
    const changed = () => {
      setVisible(shownNow())
      if (shownNow()) for (const read of reads) void read.refetch()
    }
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  })
}

const whileVisible = (ms: number) => () => (visible() ? ms : undefined)

export function Rail() {
  const viewport = useViewport()
  const extensions = useExtensions()
  const anotherRail = createMemo(() =>
    extensions().some(
      (record) => record.name !== 'projects' && record.extension?.slots?.['shell.rail'],
    ),
  )
  return (
    <Show when={!anotherRail() && viewport() !== 'phone'}>
      <ProjectsRail />
    </Show>
  )
}

function ProjectsRail() {
  const list = useAction(ListAction, null, {
    onError: keepLast,
    every: whileVisible(VISIBLE_PROJECTS_POLL_MS),
  })
  const shared = useAction(
    PinAction,
    {},
    { conversation: ROOT, onError: keepLast, every: whileVisible(SHARED_PIN_POLL_MS) },
  )
  refetchWhenShown(list, shared)
  const [writing, setWriting] = createSignal<boolean>()
  const [saved, setSaved] = createSignal<{ pinned: boolean; over: unknown }>()
  const pinned = () => {
    const ack = saved()
    const answer = shared.data()
    return writing() ?? (ack && answer === ack.over ? ack.pinned : (answer?.pinned ?? false))
  }
  const pin = async (next: boolean) => {
    if (writing() !== undefined) return
    setWriting(next)
    await api
      .action(PinAction, { pinned: next })
      .then((answer) => setSaved({ pinned: answer.pinned, over: shared.data() }), keepLast)
    setWriting()
    await shared.refetch()
  }

  const [hover, setHover] = createSignal(false)
  const enter = debounce(HOVER_DELAY_MS, () => setHover(true))
  const leave = () => {
    enter.cancel()
    setHover(false)
  }
  onSettled(() => enter.cancel)

  const projects = () => list.data() ?? []
  const loading = () => !list.data() && !list.error()
  const wide = () => hover() || pinned()
  const family = createMemo(() => projects().map((project) => project.name))
  const questions = createMemo(() =>
    projects().reduce((sum, project) => sum + (project.questions ?? 0), 0),
  )
  const working = createMemo(() => projects().filter((project) => (project.busy ?? 0) > 0).length)

  return (
    <Show when={loading() || projects().length >= 2}>
      <div
        class={cn('relative shrink-0', pinned() ? 'w-68' : 'w-14')}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocusIn={() => setHover(true)}
        onFocusOut={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(false)
        }}
      >
        <nav
          aria-label="Projects"
          class={cn(
            'absolute inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,box-shadow] duration-150 ease-out',
            wide() ? 'w-68' : 'w-14',
            hover() && !pinned() && 'shadow-2xl shadow-black/40',
          )}
          data-wide={wide() ? '' : undefined}
        >
          <div class={titleBarAlignedHeader}>
            <span class="flex w-14 shrink-0 justify-center font-mono text-[9px] tracking-[0.2em] text-brand">
              U
            </span>
            <Show when={wide()}>
              <span class="section-label">Projects</span>
              <span class="ml-1.5 font-mono text-[11px] text-muted-foreground/60 tabular-nums">
                {projects().length || ''}
              </span>
              <Button
                aria-label={pinned() ? 'Unpin the projects rail' : 'Pin the projects rail open'}
                aria-pressed={pinned() ? 'true' : 'false'}
                class="mr-2 ml-auto text-muted-foreground/70 hover:bg-sidebar-accent hover:text-foreground aria-pressed:text-foreground"
                onClick={() => pin(!pinned())}
                size="icon-xs"
                title={pinned() ? 'Unpin: open on hover' : 'Pin: keep open beside the app'}
                variant={null}
              >
                <Show when={pinned()} fallback={<Pin class="size-3.5" />}>
                  <PinOff class="size-3.5" />
                </Show>
              </Button>
            </Show>
          </div>
          <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-2 pb-2 [scrollbar-width:none]">
            <Show when={loading()}>
              <RailSkeleton wide={wide()} />
            </Show>
            <div class="flex animate-fade-in flex-col">
              <For each={projects()} keyed={(project) => project.url}>
                {(project, index) => (
                  <Row
                    family={family()}
                    first={stemOf(projects()[index() - 1]?.name ?? '') !== stemOf(project().name)}
                    last={stemOf(projects()[index() + 1]?.name ?? '') !== stemOf(project().name)}
                    gap={index() > 0}
                    project={project()}
                    wide={wide()}
                  />
                )}
              </For>
            </div>
          </div>
          <div class={statusLineAlignedFooter}>
            <span class="flex w-14 shrink-0 justify-center">
              <Show when={questions() > 0}>
                <span class="size-1.5 rounded-full bg-amber-400" />
              </Show>
            </span>
            <Show when={wide() && !loading()}>
              <span class="truncate">
                <Show when={questions() > 0} fallback={<span>{questions()} for you</span>}>
                  <InboxLink class="rounded-sm text-amber-700 underline-offset-2 hover:underline dark:text-amber-300">
                    {questions()} for you
                  </InboxLink>
                </Show>
                {` · ${working()} working`}
              </span>
            </Show>
          </div>
        </nav>
      </div>
    </Show>
  )
}

function RailSkeleton(props: { wide: boolean }) {
  return (
    <div aria-hidden="true" class="pointer-events-none">
      <For each={['w-24', 'w-32', 'w-20', 'w-28']}>
        {(width) => (
          <span class="mx-1.5 flex h-10 items-center">
            <span class="flex h-full w-11 shrink-0 justify-center py-px">
              <Skeleton class="h-full w-3 rounded-sm bg-sidebar-accent/60" />
            </span>
            <Show when={props.wide}>
              <span class="flex min-w-0 flex-1 flex-col gap-1.5 pl-1.5">
                <Skeleton class={cn('h-2.5 rounded-sm bg-sidebar-accent/60', width)} />
                <Skeleton class="h-2 w-16 rounded-sm bg-sidebar-accent/40" />
              </span>
            </Show>
          </span>
        )}
      </For>
    </div>
  )
}

function Row(props: {
  project: RunningProject
  wide: boolean
  first: boolean
  last: boolean
  gap: boolean
  family: readonly string[]
}) {
  const here = () => props.project.current
  const pending = () => opening() === props.project.url
  const busy = () => (props.project.busy ?? 0) > 0
  const questions = () => props.project.questions ?? 0
  const href = () => (here() ? undefined : target(props.project, location))
  const unreachable = () => !here() && !href()
  const title = createMemo(() =>
    [
      prettyName(props.project.name),
      props.project.repo?.name,
      shownPort(props.project, location),
      unreachable() && 'not on the tailnet',
      questions() && `${questions()} for you`,
      busy() && 'working',
      here() && 'this tab',
      pending() && 'opening',
    ]
      .filter(Boolean)
      .join(' · '),
  )
  const count = () => questions() > 0
  return (
    <div
      class={cn(
        'group relative mx-1.5 flex h-10 items-center rounded-lg',
        props.first && props.gap && 'mt-2',
        unreachable() && 'opacity-45',
        props.wide && (here() ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50'),
      )}
    >
      <a
        aria-current={here() ? 'page' : undefined}
        aria-label={title()}
        class="relative flex h-full min-w-0 flex-1 items-center rounded-lg text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        data-project={props.project.name}
        href={href()}
        onClick={(event) => {
          if (href() && opensHere(event)) open(props.project.url)
        }}
        title={title()}
      >
        <span
          class={cn(
            'absolute -left-1.5 w-[3px] rounded-r-full transition-all duration-150',
            here() || pending() ? 'h-6 bg-brand' : 'h-0 bg-muted-foreground/60 group-hover:h-3',
            pending() && 'animate-pulse-dot',
          )}
        />
        <span
          class={cn(
            'flex h-full w-11 shrink-0 justify-center',
            !props.first && 'pt-px',
            !props.last && 'pb-px',
          )}
        >
          <span class="relative flex h-full w-5 justify-center">
            <ProjectSwatch
              class={cn(
                'h-full transition-[width,opacity] duration-150',
                here() || pending()
                  ? 'w-5'
                  : 'w-3 opacity-70 group-hover:w-4 group-hover:opacity-100',
                here() && 'outline-1 outline-offset-2 outline-foreground/45',
                props.first ? 'rounded-t-md' : 'rounded-t-[1px]',
                props.last ? 'rounded-b-md' : 'rounded-b-[1px]',
                pending() && 'animate-pulse-dot',
              )}
              family={props.family}
              folder={props.project.name}
            />
            <Show when={!props.wide && !count() && busy()}>
              <span class="absolute inset-0 m-auto size-2 animate-pulse-dot rounded-full bg-brand ring-2 ring-sidebar" />
            </Show>
          </span>
        </span>
        <Show when={props.wide}>
          <span
            class={cn('flex min-w-0 flex-1 items-center gap-2 pl-1.5', count() ? 'pr-2' : 'pr-2.5')}
          >
            <span class="flex min-w-0 flex-1 flex-col">
              <span
                class={cn(
                  'truncate text-[13px] leading-5',
                  here() ? 'font-semibold text-foreground' : 'text-foreground/85',
                )}
              >
                {prettyName(props.project.name)}
              </span>
              <span class="flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-4 text-muted-foreground/80">
                <Show when={!pending()} fallback={<span class="text-brand">opening…</span>}>
                  <Show when={props.project.repo}>
                    {(repo) => <RepoLabel class="min-w-0" repo={repo()} />}
                  </Show>
                  <span class="shrink-0 text-muted-foreground/50">
                    {shownPort(props.project, location)}
                  </span>
                </Show>
              </span>
            </span>
            <Show when={!count() && busy()}>
              <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
            </Show>
          </span>
        </Show>
      </a>
      <Show when={count()}>
        <InboxLink
          class={cn(
            'flex items-center justify-center rounded-full font-mono font-semibold tabular-nums transition-colors after:absolute after:-inset-1',
            props.wide
              ? 'relative mr-2.5 h-5 min-w-5 shrink-0 bg-amber-400/15 px-1.5 text-[10px] text-amber-700 ring-1 ring-amber-500/30 ring-inset hover:bg-amber-400/30 hover:ring-amber-500/70 dark:text-amber-300'
              : 'absolute top-1/2 left-[22px] h-4 min-w-4 -translate-1/2 bg-amber-400 px-1 text-[9.5px] leading-none text-black ring-2 ring-sidebar hover:bg-amber-300',
          )}
          project={props.project}
        >
          {questions()}
        </InboxLink>
      </Show>
    </div>
  )
}
