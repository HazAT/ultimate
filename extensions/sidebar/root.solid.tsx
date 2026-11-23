import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo, For, mapArray, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  useProvided,
  cn,
  formatAgo,
  formatTokens,
  keepLast,
  plural,
  ROOT,
  useAction,
  useDocOf,
  useEvents,
} from '@/sdk/solid'
import { parseConversationId } from '../../lib/ids.ts'
import { Committed } from '../coding-tools/refs.ts'
import { ActivityAction } from '../conversations/refs.ts'
import { AgentMark, ConversationPhase, FeatureTag } from '../conversations/ui.solid.tsx'
import { MemoryDoc, TallyDoc } from '../lineage/refs.ts'
import { MEMORY_SURFACE, useOpenMemory } from '../lineage/ui.solid.tsx'
import {
  conversationState,
  conversationWait,
  useRemoteProgress,
  waitLabel,
} from '../messages/ui.solid.tsx'
import { RunsDoc } from '../subagents/refs.ts'
import { ProgressAction } from '../workspaces/refs.ts'
import type { WorkspaceIndex } from '../workspaces/types.ts'
import { CommitCount, Review } from '../workspaces/ui.solid.tsx'
import type { Landing } from './landings.ts'
import { PreviewUp } from './points.ts'
import { ChildRow, EpicLine, RenameField, RowMenu, useRename } from './rows.solid.tsx'
import { Section } from './section.solid.tsx'
import { shell, useData, useSurface } from './state.solid.tsx'
import type { SidebarConversation } from './state.solid.tsx'
import { SummaryHistory } from './summaries.solid.tsx'
import { workOf } from './work.ts'
import type { Work } from './work.ts'

export function inFlight(
  conversation: SidebarConversation,
  index: WorkspaceIndex,
  working: boolean,
  landings: readonly Landing[],
) {
  if (
    !working &&
    landings.some(
      (event) => event.from === conversation.id && (event.at ?? 0) >= (conversation.inputAt ?? 0),
    )
  )
    return false
  if (conversation.busy || index.queue.some((item) => item.conversationId === conversation.id))
    return true
  return !Object.values(index.results).some(
    (result) =>
      result.conversationId === conversation.id &&
      result.outcome === 'landed' &&
      (result.steps.at(-1)?.at ?? result.at) >= (conversation.inputAt ?? 0),
  )
}

const appearance = {
  failed: ['text-error', 'bg-error', 'failed'],
  success: ['text-success', 'bg-success', 'done'],
  brand: ['text-brand', 'animate-pulse-dot bg-brand', 'working'],
  awaiting: ['text-brand', 'bg-brand', 'awaiting'],
  waiting: ['text-amber-700 dark:text-amber-300', 'bg-amber-400', 'waiting'],
  paused: ['text-warning', 'bg-amber-400', 'paused'],
  quiet: ['text-muted-foreground/70', 'bg-muted-foreground/40', 'idle'],
} as const

function useBranchState(id: () => ConversationId, reviewing: () => boolean) {
  const data = useData()
  const phase = useProvided(ConversationPhase, () => (data.working().has(id()) ? id() : undefined))
  const previewUp = useProvided(PreviewUp, id)
  const facts = createMemo(() => data.facts(id(), data.working().has(id()) || data.underway(id())))
  const wait = createMemo(() => conversationWait(facts(), data.log(), data.timers()))
  const remote = useRemoteProgress(() => {
    const current = wait()
    return current?.on === 'remote' ? current.project : undefined
  })
  return createMemo((): { label: string; tone: keyof typeof appearance } => {
    const queued = data.index().queue.find((item) => item.conversationId === id())
    if (queued?.state === 'landing') return { label: 'landing', tone: 'success' }
    if (queued) return { label: 'submitted', tone: 'success' }
    if (data.parked(id())) return { label: 'paused', tone: 'paused' }
    const state = conversationState(facts(), data.log(), data.timers())
    if (state === 'working') {
      const current = phase()
      return {
        label: reviewing() ? 'reviewing' : current && !current.waiting ? current.word : 'working',
        tone: 'brand',
      }
    }
    if (state === 'waits')
      return { label: previewUp() ? 'preview awaits you' : 'waits on you', tone: 'waiting' }
    if (state === 'awaiting') {
      const current = wait()
      const label = waitLabel(
        current,
        data.ultimateId(),
        data.primaryWait(),
        current?.on === 'remote' ? remote() : data.remote(),
      )
      return { label: label!, tone: 'awaiting' }
    }
    if (state === 'failed') return { label: 'failed', tone: 'failed' }
    return previewUp()
      ? { label: 'preview up', tone: 'awaiting' }
      : { label: 'idle', tone: 'quiet' }
  })
}

function Edits(props: { id: ConversationId; count: number; spec: string }) {
  const open = useProvided(Review, () => props.spec)
  const label = () => `+ ${props.count} edit${props.count === 1 ? '' : 's'}`
  return (
    <Show when={open()} fallback={<span class="shrink-0">{label()}</span>}>
      {(review) => (
        <Button
          aria-label={`Edits of #${props.id}`}
          class="shrink-0 font-[inherit] text-[length:inherit] font-normal hover:text-foreground hover:underline"
          onClick={() => review()()}
          size={null}
          title="Review uncommitted changes"
          variant={null}
        >
          {label()}
        </Button>
      )}
    </Show>
  )
}

const silentTooLong = 10 * 60_000

function ActivityLine(props: { id: ConversationId; activity: Activity }) {
  const data = useData()
  const working = () => data.working().get(props.id) === 'self'
  const idle = () => (props.activity.lastAt === undefined ? 0 : data.now() - props.activity.lastAt)
  const silent = () => working() && idle() >= silentTooLong
  const workers = () => props.activity.workers
  const company = () => (workers() > 0 ? `with ${plural(workers(), 'worker')}` : 'alone')
  return (
    <span
      class="flex min-w-0 items-center gap-1.5 pr-2 pb-0.5 pl-[30px] font-mono text-[10px] leading-4 text-muted-foreground/70"
      data-flight-activity={props.id}
      title={`#${props.id}: ${props.activity.turns} turns and ${props.activity.calls} tool calls of its own; ${formatCost(props.activity.cost)} with its subagents`}
    >
      <span class="min-w-0 truncate">
        {[
          plural(props.activity.turns, 'turn'),
          plural(props.activity.calls, 'call'),
          formatCost(props.activity.cost),
          company(),
        ].join(' · ')}
      </span>
      <Show when={props.activity.lastAt !== undefined && idle() >= 60_000}>
        <span aria-hidden="true" class="shrink-0">
          ·
        </span>
        <span
          class={cn('shrink-0', silent() && 'text-amber-700 dark:text-amber-300')}
          data-silent={silent() || undefined}
          title={`Last activity ${formatAgo(props.activity.lastAt!, data.now(), { ago: true })}`}
        >
          idle {formatAgo(props.activity.lastAt!, data.now())}
        </span>
      </Show>
    </span>
  )
}

const formatCost = (dollars: number) =>
  `$${dollars < 10 ? dollars.toFixed(2) : Math.round(dollars)}`

function PhasedFlightRow(props: {
  id: ConversationId
  work?: Work
  activity?: Activity
  reviewing: boolean
  onConclude: (conclude: boolean) => void
}) {
  const data = useData()
  const rename = useRename(() => props.id)
  const conversation = createMemo(() => data.byConversation(props.id))
  const shown = () => props.id === data.shownTop()
  const feature = () => data.row(props.id)?.feature
  const state = useBranchState(
    () => props.id,
    () => props.reviewing,
  )
  const looks = () => appearance[state().tone]
  const latest = () => Math.max(conversation().inputAt ?? 0, conversation().answerAt ?? 0)
  const title = () => conversation().title ?? `#${props.id}`
  return (
    <li>
      <div class="group relative">
        <Show when={rename.editing()}>
          <RenameField
            class="absolute inset-x-2 top-0.5 z-10 h-6 w-auto rounded-sm px-1.5 text-[12px]"
            id={props.id}
            title={conversation().title}
            finish={rename.finish}
          />
        </Show>
        <SummaryHistory
          class={cn(
            'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md py-1.5 pr-2 pl-2.5 text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
            shown() && 'bg-sidebar-accent',
          )}
          id={props.id}
          inFlight
          onOpen={() => shell.switchConversation(props.id)}
          rowRef={rename.rowRef}
          shown={shown()}
          title={title()}
        >
          <span class="flex w-full min-w-0 items-center gap-1.5 pr-5">
            <span
              class={cn('size-1.5 shrink-0 rounded-full', looks()[1])}
              data-status={looks()[2]}
            />
            <span
              class={cn(
                'min-w-0 flex-1 truncate text-[12px]',
                shown() ? 'text-foreground' : 'text-foreground/85',
              )}
            >
              {title()}
            </span>
          </span>
          <span class="flex w-full min-w-0 items-center gap-1.5 pl-3 font-mono text-[10px] leading-4 text-muted-foreground">
            <Show when={feature()}>
              {(tag) => <FeatureTag class="max-w-[35%] shrink-0" feature={tag()} />}
            </Show>
            <span class={cn('min-w-0 truncate', looks()[0])} title={state().label}>
              {state().label}
            </span>
            <Show when={latest()}>
              {(at) => (
                <span class="ml-auto shrink-0 pl-1 text-muted-foreground/60">
                  {formatAgo(at(), data.now())}
                </span>
              )}
            </Show>
          </span>
        </SummaryHistory>
        <Show when={!rename.editing()}>
          <div class="absolute top-1 right-2 size-5">
            <RowMenu
              conversation={conversation()}
              onConclude={props.onConclude}
              onRename={rename.begin}
            />
          </div>
        </Show>
      </div>
      <Show when={props.work}>
        <span
          class="flex min-w-0 items-center gap-2 pr-2 pb-0.5 pl-[30px] font-mono text-[10px] leading-4 text-muted-foreground/80"
          data-flight-work={props.id}
        >
          <Show when={props.work?.commits}>
            {(commits) => <CommitCount count={commits().count} range={commits().spec} />}
          </Show>
          <Show when={props.work?.edits}>
            {(edits) => <Edits id={props.id} count={edits().count} spec={edits().spec} />}
          </Show>
        </span>
      </Show>
      <Show when={props.activity}>
        {(activity) => <ActivityLine activity={activity()} id={props.id} />}
      </Show>
      <EpicLine id={props.id} working={data.working().get(props.id) === 'self'} />
      <FlightChildren id={props.id} depth={0} />
    </li>
  )
}

function FlightChildren(props: { id: ConversationId; depth: number }) {
  const data = useData()
  return (
    <For each={data.subagents().get(props.id)}>
      {(id) => (
        <>
          <ChildRow id={id} depth={props.depth} />
          <FlightChildren id={id} depth={props.depth + 1} />
        </>
      )}
    </For>
  )
}

function useFlightWork(branches: () => readonly ConversationId[]) {
  const data = useData()
  const keys = createMemo(() => {
    const ready = branches().filter((id) => data.index().items[id]?.state === 'ready')
    return ready.length ? [ready.toSorted((a, b) => a - b).join(',')] : []
  })
  const commits = useEvents({ events: [Committed], limit: 1 })
  const runs = createMemo<{ busy: ConversationId[]; refetch: number }>((previous) => {
    const busy = branches().filter(data.busy)
    return {
      busy,
      refetch:
        (previous?.refetch ?? 0) + Number(previous?.busy.some((id) => !busy.includes(id)) ?? false),
    }
  })
  const reads = mapArray(keys, (key) =>
    useAction(
      ProgressAction,
      { ids: key.split(',').map((id) => parseConversationId(Number(id))) },
      { conversation: ROOT, onError: keepLast, on: () => [commits()?.[0]?.id, runs().refetch] },
    ),
  )
  const byId = createMemo(
    () =>
      new Map(
        reads()[0]
          ?.data()
          ?.map((item) => [item.id, item]),
      ),
  )
  return (id: ConversationId) => workOf(id, data.index().items[id]?.branch, byId().get(id))
}

type ActivityStats = { turns: number; calls: number; cost: number; lastAt?: number }
type Activity = ActivityStats & { workers: number }

function useFlightActivity(branches: () => readonly ConversationId[]) {
  const data = useData()
  const below = (id: ConversationId): ConversationId[] =>
    (data.subagents().get(id) ?? []).flatMap((child) => [child, ...below(child)])
  const trees = createMemo(() => new Map(branches().map((id) => [id, below(id)])))
  const keys = createMemo(() => {
    const ids = [...trees()].flatMap(([id, children]) => [id, ...children])
    return ids.length ? [ids.toSorted((a, b) => a - b).join(',')] : []
  })
  const moved = createMemo(() =>
    [...trees()]
      .flatMap(([id, children]) =>
        [id, ...children].map((each) => {
          const conversation = data.byConversation(each)
          return `${each}:${conversation.busy}:${conversation.inputAt}:${conversation.answerAt}`
        }),
      )
      .join(' '),
  )
  const anyBusy = createMemo(() => branches().some((id) => data.working().has(id)))
  const reads = mapArray(keys, (key) =>
    useAction(
      ActivityAction,
      { ids: key.split(',').map((id) => parseConversationId(Number(id))) },
      {
        conversation: ROOT,
        onError: keepLast,
        on: moved,
        every: () => (anyBusy() ? 30_000 : undefined),
      },
    ),
  )
  const latest = createMemo<Record<string, ActivityStats> | undefined>(
    (previous) => reads()[0]?.data() ?? previous,
  )
  return (id: ConversationId): Activity | undefined => {
    const stats = latest()
    const own = stats?.[id]
    if (!own) return undefined
    const children = trees().get(id) ?? []
    const subtree = [own, ...children.flatMap((child) => stats[child] ?? [])]
    return {
      turns: own.turns,
      calls: own.calls,
      cost: subtree.reduce((sum, each) => sum + each.cost, 0),
      lastAt: own.lastAt,
      workers: children.filter((child) => data.busy(child)).length,
    }
  }
}

export function InFlight(props: {
  ids: readonly ConversationId[]
  onConclude: (id: ConversationId, conclude: boolean) => void
}) {
  const data = useData()
  const runs = useDocOf(() => ROOT, RunsDoc)
  const workOfId = useFlightWork(() => props.ids)
  const activityOf = useFlightActivity(() => props.ids)
  const reviewing = (id: ConversationId) =>
    data.conversations().some((child) => {
      if (
        child.parentConversationId !== id ||
        child.ownerTaskId === undefined ||
        !data.busy(child.id)
      )
        return false
      const agent = runs()?.[child.id]?.agent
      return agent === 'reviewer' || agent?.startsWith('reviewer-')
    })
  return (
    <Show when={props.ids.length > 0}>
      <Section count={props.ids.length} id="in-flight" label="In flight">
        <ul class="flex flex-col gap-0.5">
          <For each={props.ids}>
            {(id) => (
              <PhasedFlightRow
                id={id}
                onConclude={(conclude) => props.onConclude(id, conclude)}
                activity={activityOf(id)}
                reviewing={reviewing(id)}
                work={workOfId(id)}
              />
            )}
          </For>
        </ul>
      </Section>
    </Show>
  )
}

const kinds = ['decision', 'fact', 'lesson'] as const

export function useMemorySummary(id: () => ConversationId) {
  const tally = useDocOf(id, TallyDoc)
  const memory = useDocOf(id, MemoryDoc)
  return createMemo(() => {
    const memories = Object.values(memory()?.memories ?? {})
    const counts = kinds
      .map((kind) => {
        const count = memories.filter((item) => item.kind === kind).length
        return count ? plural(count, kind) : ''
      })
      .filter(Boolean)
    const context = tally()
    return {
      total: memories.length,
      tokens: context?.since === undefined ? undefined : (context.briefTokens ?? context.tokens),
      counts: counts.join(' · ') || 'none yet',
    }
  })
}

export function MemoryRow(props: { id: ConversationId; working: boolean }) {
  const surface = useSurface()
  const openMemory = useOpenMemory()
  const shown = () => surface() === MEMORY_SURFACE
  const memory = useMemorySummary(() => props.id)
  return (
    <div data-conversation={props.id} data-root-row={props.id}>
      <Button
        aria-current={shown() ? 'page' : undefined}
        aria-label={`Project memory of #${props.id}`}
        class={cn(
          'mx-2 flex h-12 w-[calc(100%-1rem)] min-w-0 items-center justify-start gap-2.5 rounded-md pr-2 pl-2 text-left font-normal outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
          shown() && 'bg-sidebar-accent hover:bg-sidebar-accent',
        )}
        onClick={() => openMemory()}
        size={null}
        title="What every new branch starts from · open Memory"
        variant={null}
      >
        <AgentMark name="memory" presence={props.working ? 'working' : undefined} size="md" />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="flex min-w-0 items-baseline gap-1.5">
            <span class="truncate text-[13px] leading-5 font-semibold text-foreground">Memory</span>
            <Show when={memory().tokens !== undefined}>
              <span
                class="shrink-0 font-mono text-[10px] text-muted-foreground/70"
                title="Tokens every new branch starts from"
              >
                {formatTokens(memory().tokens!)}
              </span>
            </Show>
          </span>
          <span class="truncate font-mono text-[10px] leading-4 text-muted-foreground">
            {memory().counts}
          </span>
        </span>
      </Button>
    </div>
  )
}
