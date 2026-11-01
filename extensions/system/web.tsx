import { ChevronRightIcon, GanttChartIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  Header,
  ParkedRuns,
  Provided,
  StatusLine,
  useDocOf,
  useExtensionUiState,
  useConversations,
  useNow,
  useUltimate,
} from '@/sdk'
import { MessagesDoc, conversationState, emptyMessages } from '../messages/ui.tsx'
import { useConcludedSince, useOverview } from '../conversations/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { LaneTree } from './hierarchy.tsx'
import { Axis, laneState } from './lanes.tsx'
import { windows } from './layout.ts'
import type { WindowName } from './layout.ts'
import { LanesAction } from './refs.ts'
import type { Lane, LaneLink } from './refs.ts'
import { NavigationReporter } from './navigation.tsx'
import { Stream } from './stream.tsx'
import type { StreamView } from './stream.tsx'

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
/** Whether the System surface is on screen in a visible tab: polling runs only then. */
function useLive() {
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === 'visible')
  return useUltimate().surface === 'system' && visible
}

/** Each lane's conversation state, the same the sidebar shows: only the primary agent can wait on you. */
function useStates(parked: ReadonlySet<number>) {
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const overview = useOverview()
  const conversations = useConversations()
  const primary = useDocOf(1, StandingDoc)?.ultimate
  const concludedSince = useConcludedSince()
  return (lane: Lane) => {
    const id = lane.conversation
    const own = conversations.find((item) => item.id === id)
    const state = conversationState(
      {
        id,
        kind: id === primary ? 'primary' : own?.ownerTaskId !== undefined ? 'subagent' : 'other',
        runState: overview[id]?.runState,
        busy: own?.busy,
        parked: parked.has(id),
        primary,
        concludedSince: concludedSince(id),
      },
      log,
    )
    return laneState(lane, state, overview[id] !== undefined)
  }
}

/**
 * The lanes of the last `range` milliseconds, fetched again every 2 s while `live`; the previous result stays on
 * screen until the next arrives, so the timeline never blinks.
 */
function useLanes(range: number, live: boolean) {
  const [state, setState] = useState<{ range: number; data?: LanesResult; error?: unknown }>({
    range,
  })
  useEffect(() => {
    const controller = new AbortController()
    const load = () =>
      api
        .action(
          LanesAction,
          // Whole minutes, so repeated polls carry the same args and the trace counts them instead of writing each.
          { since: new Date(Math.floor((Date.now() - range) / 60_000) * 60_000).toISOString() },
          { signal: controller.signal },
        )
        .then((data) => setState({ range, data }))
        .catch((error: unknown) => {
          // Aborted when the window changes or the surface hides; the next fetch owns the state.
          if (!controller.signal.aborted) setState((previous) => ({ ...previous, error }))
        })
    // oxlint-disable-next-line typescript/no-floating-promises -- load catches fetch failures and stores them in the displayed error state.
    void load()
    const timer = live ? setInterval(() => void load(), 2000) : undefined
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [range, live])
  return { data: state.range === range ? state.data : undefined, error: state.error }
}

type LanesResult = { now: string; lanes: Lane[]; links: LaneLink[]; more?: number }

const dot = 'inline-block size-1.5 rounded-full'

/** Agent Lanes on top, the stream of everything below; both live while on screen. */
function System() {
  return (
    <Provided input={null} point={ParkedRuns}>
      {(parked) => <Lanes parked={parked ?? noneParked} />}
    </Provided>
  )
}
const noneParked: ReadonlySet<number> = new Set()

function Lanes({ parked }: { parked: ReadonlySet<number> }) {
  const live = useLive()
  const [stored, setWindow] = useExtensionUiState<WindowName>('window', '30m')
  const window: WindowName = Object.hasOwn(windows, stored) ? (stored as WindowName) : '30m'
  const [streamOpen, setStreamOpen] = useExtensionUiState('streamOpen', true)
  const [view, setView] = useExtensionUiState<StreamView>('view', {
    source: 'all',
    errors: false,
    text: '',
  })
  const now = useNow(1000, live)
  const range = windows[window].ms
  const lanes = useLanes(range, live)
  const stateOf = useStates(parked)
  const list = lanes.data?.lanes ?? []
  const states = new Map(list.map((lane) => [lane.conversation, stateOf(lane)]))
  // A parent listed only to hold its children's place did not work in the window: it is no agent at work.
  const worked = list.filter((lane) => lane.runs.length > 0)
  const running = worked.filter((lane) => states.get(lane.conversation) === 'running').length
  const waits = list.some((lane) => states.get(lane.conversation) === 'waits')
  const since = now - range
  return (
    <>
      <Header>
        <span className="flex items-center gap-2 text-[0.8125rem] font-medium">
          <GanttChartIcon className="size-4 text-muted-foreground" />
          System
        </span>
      </Header>
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <section className="mx-auto max-w-6xl px-3 py-3 md:px-5">
          <div className="rounded-lg border border-border/70 bg-card/40">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 font-mono text-[0.6875rem] text-muted-foreground">
              <span className="section-label">Agents</span>
              <span className="flex items-center gap-1.5" data-running={running}>
                <span className={cn(dot, 'bg-brand', running > 0 && 'animate-pulse-dot')} />
                {running} running
              </span>
              {waits && (
                <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                  <span className={cn(dot, 'bg-amber-400')} />
                  waits on you
                </span>
              )}
              {lanes.data?.more !== undefined && (
                <span className="text-muted-foreground">+{lanes.data.more} more</span>
              )}
              <span className="ml-auto flex items-center gap-0.5">
                {(Object.keys(windows) as WindowName[]).map((name) => (
                  <button
                    aria-pressed={window === name}
                    className={cn(
                      'h-6 cursor-pointer rounded-md px-2 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      window === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
                    )}
                    key={name}
                    onClick={() => setWindow(name)}
                    type="button"
                  >
                    {name}
                  </button>
                ))}
              </span>
            </div>
            <div className="px-3">
              <div className="flex md:gap-3">
                <span className="md:w-56 md:shrink-0" />
                <div className="min-w-0 flex-1">
                  <Axis window={window} />
                </div>
              </div>
              {list.length === 0 ? (
                <p className="py-6 text-center font-mono text-[0.7188rem] text-muted-foreground">
                  {lanes.error
                    ? `lanes failed: ${errorMessage(lanes.error)}`
                    : !lanes.data
                      ? 'loading…'
                      : `quiet · no agent worked in the last ${window}`}
                </p>
              ) : (
                <LaneTree
                  lanes={list}
                  links={lanes.data?.links ?? []}
                  now={now}
                  onFilter={(conversation) => {
                    setView({ ...view, conversation })
                    setStreamOpen(true)
                  }}
                  since={since}
                  states={states}
                  window={window}
                />
              )}
            </div>
          </div>
        </section>
        <section className="mx-auto max-w-6xl px-3 pb-6 md:px-5">
          <button
            aria-expanded={streamOpen}
            className="flex w-full cursor-pointer items-center gap-1.5 py-1.5 section-label hover:text-foreground"
            onClick={() => setStreamOpen(!streamOpen)}
            type="button"
          >
            <ChevronRightIcon
              className={cn('size-3 transition-transform', streamOpen && 'rotate-90')}
            />
            All events
          </button>
          {streamOpen && (
            <div className="rounded-lg border border-border/70 bg-card/40">
              <Stream live={live} setView={setView} view={view} />
            </div>
          )}
        </section>
      </main>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'system',
      title: 'System',
      icon: GanttChartIcon,
      description: 'What every agent is doing, and everything recorded, live',
      order: 50,
      component: System,
    },
  ],
  commands: [
    { id: 'system.open', title: 'Open System', run: (context) => context.showSurface('system') },
  ],
  slots: { overlay: [NavigationReporter] },
})
