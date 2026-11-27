import { Pin, PinOff } from '@lucide/solid'
import {
  action,
  createMemo,
  createOptimistic,
  createRoot,
  createSignal,
  For,
  onSettled,
  Show,
} from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import {
  ROOT,
  api,
  cn,
  keepLast,
  prettyName,
  useAction,
  useExtensions,
  usePageVisible,
  useViewport,
} from '@/sdk/solid'
import { deadline, debounce } from '../../lib/timers.shared.ts'
import { ProjectSwatch, RepoLabel, stemOf } from '../sidebar/ui.solid.tsx'
import { shownPort, target } from './links.web.ts'
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
  const visible = usePageVisible()
  const showCount = createMemo<number>((previous) => (previous ?? 0) + Number(visible()))
  const whileVisible = (ms: number) => () => (visible() ? ms : undefined)
  const list = useAction(ListAction, null, {
    conversation: ROOT,
    on: showCount,
    onError: keepLast,
    every: whileVisible(VISIBLE_PROJECTS_POLL_MS),
  })
  const shared = useAction(
    PinAction,
    {},
    {
      conversation: ROOT,
      on: showCount,
      onError: keepLast,
      every: whileVisible(SHARED_PIN_POLL_MS),
    },
  )
  const answer = createMemo(() => shared.data())
  const [acknowledged, setAcknowledged] = createSignal(() => answer()?.pinned ?? false)
  const [pinned, setPinned] = createOptimistic(acknowledged)
  const pin = action(function* (next: boolean) {
    setPinned(next)
    const saved: { pinned: boolean } | undefined = yield api
      .action(PinAction, { pinned: next })
      .catch(keepLast)
    if (!saved) return
    setAcknowledged(saved.pinned)
    yield shared.refetch()
  })
  let saving: Promise<void> | undefined
  const press = (next: boolean) => {
    saving ??= pin(next).finally(() => (saving = undefined))
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
              <Toggle
                aria-label={pinned() ? 'Unpin the projects rail' : 'Pin the projects rail open'}
                pressed={pinned()}
                class="mr-2 ml-auto text-muted-foreground/70 hover:bg-sidebar-accent hover:text-foreground data-pressed:bg-transparent data-pressed:text-foreground data-pressed:hover:bg-sidebar-accent"
                onPressedChange={press}
                size="icon-xs"
                title={pinned() ? 'Unpin: open on hover' : 'Pin: keep open beside the app'}
                variant={null}
              >
                <Show when={pinned()} fallback={<Pin class="size-3.5" />}>
                  <PinOff class="size-3.5" />
                </Show>
              </Toggle>
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
                <span class={cn(questions() > 0 && 'text-amber-700 dark:text-amber-300')}>
                  {questions()} for you
                </span>
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
  const opensHere = (event: MouseEvent) =>
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  const control = (render?: ComponentProps<typeof Button>['render']) => (
    <Button
      aria-current={here() ? 'page' : undefined}
      aria-label={title()}
      class={cn(
        'group relative mx-1.5 flex h-10 items-center justify-start gap-0 rounded-lg text-left font-normal whitespace-normal outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
        unreachable()
          ? 'disabled:opacity-45 data-disabled:opacity-45'
          : 'disabled:opacity-100 data-disabled:opacity-100',
        props.wide && (here() ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50'),
      )}
      data-project={props.project.name}
      disabled={!href()}
      onClick={(event) => {
        if (href() && opensHere(event)) open(props.project.url)
      }}
      render={render}
      size={null}
      variant={null}
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
          <Show when={!props.wide}>
            <Show
              when={questions() > 0}
              fallback={
                <Show when={busy()}>
                  <span class="absolute inset-0 m-auto size-2 animate-pulse-dot rounded-full bg-brand ring-2 ring-sidebar" />
                </Show>
              }
            >
              <span class="absolute inset-0 m-auto flex h-4 w-fit min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 font-mono text-[9.5px] leading-none font-semibold text-black tabular-nums ring-2 ring-sidebar">
                {questions()}
              </span>
            </Show>
          </Show>
        </span>
      </span>
      <Show when={props.wide}>
        <span class="flex min-w-0 flex-1 items-center gap-2 pr-2.5 pl-1.5">
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
          <Show
            when={questions() > 0}
            fallback={
              <Show when={busy()}>
                <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
              </Show>
            }
          >
            <span class="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-400/15 px-1.5 font-mono text-[10px] font-semibold text-amber-700 tabular-nums ring-1 ring-amber-500/30 ring-inset dark:text-amber-300">
              {questions()}
            </span>
          </Show>
        </span>
      </Show>
    </Button>
  )
  return (
    <div class={cn(props.first && props.gap && 'mt-2')} title={title()}>
      <Show when={href()} fallback={control()}>
        {(link) =>
          control((anchor) => (
            <a {...anchor} href={link()}>
              {anchor.children}
            </a>
          ))
        }
      </Show>
    </div>
  )
}
