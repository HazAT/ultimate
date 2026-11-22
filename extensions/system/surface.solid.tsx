/** @jsxImportSource @solidjs/web */
import { ChevronRight, GanttChart } from '@lucide/solid'
import { children, createMemo, For, Show } from 'solid-js'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs.solid.tsx'
import {
  Contribution,
  ErrorCard,
  Header,
  StatusLine,
  useAllProvided,
  useProvided,
  ParkedRuns,
  ROOT,
  cn,
  errorMessage,
  keepLast,
  useAction,
  useConversations,
  useDocOf,
  useExtensionUiState,
  useNow,
  usePageVisible,
  useSurface,
  useUiState,
} from '@/sdk/solid'
import { useAutomations, timerWaits } from '../automations/ui.solid.tsx'
import { useOverview } from '../conversations/ui.solid.tsx'
import { MessagesDoc } from '../messages/refs.ts'
import {
  conversationState,
  conversationWait,
  emptyMessages,
  useRemoteProgress,
  useUnderway,
  waitLabel,
} from '../messages/ui.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import { LaneTree } from './hierarchy.solid.tsx'
import { Axis, laneState } from './lanes.solid.tsx'
import { windows } from './layout.ts'
import type { WindowName } from './layout.ts'
import { LanesAction } from './refs.ts'
import type { Lane, LaneLink } from './refs.ts'
import { Stream } from './stream.solid.tsx'
import type { StreamView } from './stream.solid.tsx'
import { SYSTEM_TAB_KEY, SystemTab } from './ui.solid.tsx'

const noLanes: Lane[] = []
const noLinks: LaneLink[] = []
const windowNames = Object.keys(windows) as WindowName[]
const control = 'border-0 p-0 gap-0.5'
const choice = 'rounded-md px-2 focus-visible:ring-1'
const dot = 'inline-block size-1.5 rounded-full'

function useStates() {
  const parked = useProvided(ParkedRuns, () => null)
  const board = useDocOf(() => ROOT, MessagesDoc)
  const log = () => board() ?? emptyMessages
  const overview = useOverview()
  const conversations = useConversations()
  const summaries = createMemo(() => new Map(conversations().map((item) => [item.id, item])))
  const standing = useDocOf(() => ROOT, StandingDoc)
  const primary = () => standing()?.ultimate
  const automations = useAutomations(() => 5000)
  const timers = createMemo(() => timerWaits(automations().data, standing()))
  const underway = useUnderway()
  const primaryWait = createMemo(() => {
    const id = primary()
    if (id !== undefined)
      return conversationWait(
        { id, kind: 'primary', runState: overview()[id]?.runState, busy: underway(id) },
        log(),
        timers(),
      )
    return undefined
  })
  const remote = useRemoteProgress(() => {
    const wait = primaryWait()
    return wait?.on === 'remote' ? wait.project : undefined
  })
  return (lane: Lane) => {
    const id = lane.conversation
    const own = summaries().get(id)
    const facts = {
      id,
      kind:
        id === primary()
          ? ('primary' as const)
          : own?.ownerTaskId !== undefined
            ? ('subagent' as const)
            : ('other' as const),
      runState: overview()[id]?.runState,
      busy: own?.ownerTaskId !== undefined ? own.busy : underway(id),
      parked: parked()?.has(id) ?? false,
    }
    return {
      state: laneState(
        lane,
        conversationState(facts, log(), timers()),
        overview()[id] !== undefined,
      ),
      label: waitLabel(
        conversationWait(facts, log(), timers()),
        primary(),
        primaryWait(),
        remote(),
      ),
    }
  }
}

type LanesResult = { now: string; lanes: Lane[]; links: LaneLink[]; more?: number }

function useLanes(currentRange: () => number, isLive: () => boolean) {
  const read = useAction(
    LanesAction,
    {
      get windowMs() {
        return currentRange()
      },
    },
    { onError: keepLast, every: () => (isLive() ? 2000 : undefined) },
  )
  return createMemo<{ range: number; data?: LanesResult; error?: unknown }>((previous) => {
    const range = currentRange()
    const data = read.data() ?? (previous?.range === range ? previous.data : undefined)
    return { range, data, error: read.error() }
  })
}

function SystemHeading(props: { tabs: { id: string; title: string }[] }) {
  const controls = children(() => (
    <>
      <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
        <GanttChart class="size-4 text-muted-foreground" /> System
      </span>
      <Show when={props.tabs.length}>
        <TabsList aria-label="System view" class={cn('inline-flex', control)}>
          <TabsTab class={choice} value="agents">
            Agents
          </TabsTab>
          <For each={props.tabs} keyed={(item) => item.id}>
            {(item) => (
              <TabsTab class={choice} value={item().id}>
                {item().title}
              </TabsTab>
            )}
          </For>
        </TabsList>
      </Show>
    </>
  ))
  return <Header>{controls()}</Header>
}

export function System() {
  const [tab, setTab] = useUiState<string>(SYSTEM_TAB_KEY, 'agents')
  const provided = useAllProvided(SystemTab, () => null)
  const tabs = createMemo(() => provided().filter((item) => item !== undefined))
  const open = createMemo(() => tabs().find((item) => item.id === tab()))
  const panelClass = 'flex min-h-0 flex-1 flex-col overflow-hidden'
  return (
    <Tabs
      aria-label="System view"
      bind={[() => open()?.id ?? 'agents', setTab]}
      class="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <SystemHeading tabs={tabs()} />
      <TabsPanel class={panelClass} value="agents">
        <Lanes />
      </TabsPanel>
      <For each={tabs()} keyed={(item) => item.id}>
        {(item) => (
          <TabsPanel class={panelClass} value={item().id}>
            <Contribution
              item={{ extension: 'system', version: 0, component: item().component }}
              props={{}}
              fallback={(extension, error) => (
                <ErrorCard error={errorMessage(error)} extension={extension} />
              )}
            />
          </TabsPanel>
        )}
      </For>
      <StatusLine />
    </Tabs>
  )
}

function Lanes() {
  const surface = useSurface()
  const visible = usePageVisible()
  const live = () => surface() === 'system' && visible()
  const [stored, setWindow] = useExtensionUiState<WindowName>('window', '30m')
  const window = (): WindowName => windowNames.find((name) => name === stored()) ?? '30m'
  const stream = useExtensionUiState('streamOpen', true)
  const [view, setView] = useExtensionUiState<StreamView>('view', {
    source: 'all',
    errors: false,
    text: '',
  })
  const now = useNow(1000, live)
  const range = () => windows[window()].ms
  const lanes = useLanes(range, live)
  const stateOf = useStates()
  const list = () => lanes()?.data?.lanes ?? noLanes
  const states = createMemo(() => new Map(list().map((lane) => [lane.conversation, stateOf(lane)])))
  const running = () =>
    list().filter(
      (lane) => lane.runs.length && states().get(lane.conversation)?.state === 'running',
    ).length
  const waits = () => [...states().values()].some((entry) => entry.state === 'waits')
  return (
    <main class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <section class="mx-auto max-w-6xl px-3 py-3 md:px-5">
        <div class="rounded-lg border border-border/70 bg-card/40">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <span class="section-label">Agents</span>
            <span class="flex items-center gap-1.5" data-running={running()}>
              <span class={cn(dot, 'bg-brand', running() > 0 && 'animate-pulse-dot')} />
              {running()} running
            </span>
            <Show when={waits()}>
              <span class="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                <span class={cn(dot, 'bg-amber-400')} /> waits on you
              </span>
            </Show>
            <Show when={lanes()?.data?.more !== undefined}>
              <span class="text-muted-foreground/70">+{lanes()?.data?.more} more</span>
            </Show>
            <SegmentedControl
              aria-label="Agent timeline window"
              bind={[window, setWindow]}
              class={cn(control, 'ml-auto')}
            >
              <For each={windowNames}>
                {(name) => (
                  <SegmentedControlItem class={choice} value={name}>
                    {name}
                  </SegmentedControlItem>
                )}
              </For>
            </SegmentedControl>
          </div>
          <div class="px-3">
            <div class="flex md:gap-3">
              <span class="md:w-56 md:shrink-0" />
              <div class="min-w-0 flex-1">
                <Axis window={window()} />
              </div>
            </div>
            <Show
              when={list().length > 0}
              fallback={
                <p class="py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
                  {lanes()?.error
                    ? `lanes failed: ${errorMessage(lanes()?.error)}`
                    : !lanes()?.data
                      ? 'loading…'
                      : `quiet · no agent worked in the last ${window()}`}
                </p>
              }
            >
              <LaneTree
                lanes={list()}
                links={lanes()?.data?.links ?? noLinks}
                now={now()}
                onFilter={(conversation) => {
                  setView((previous) => ({ ...previous, conversation }))
                  stream[1](true)
                }}
                since={now() - range()}
                states={states()}
                window={window()}
              />
            </Show>
          </div>
        </div>
      </section>
      <section class="mx-auto max-w-6xl px-3 pb-6 md:px-5">
        <Collapsible bind={stream}>
          <CollapsibleTrigger class="group/stream flex w-full items-center gap-1.5 py-1.5 section-label hover:text-foreground">
            <ChevronRight class="size-3 transition-transform group-data-open/stream:rotate-90" />{' '}
            All events
          </CollapsibleTrigger>
          <CollapsibleContent class="rounded-lg border border-border/70 bg-card/40">
            <Stream live={live()} setView={setView} view={view()} />
          </CollapsibleContent>
        </Collapsible>
      </section>
    </main>
  )
}
