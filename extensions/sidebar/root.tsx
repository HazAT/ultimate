import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn, formatAgo, formatTokens, Provided, useAction, useDocOf, useEvents } from '@/sdk'
import { MEMORY_SURFACE, MemoryDoc, TallyDoc, useOpenMemory } from '../lineage/ui.tsx'
import { Committed } from '../coding-tools/ui.tsx'
import { MessagesDoc, conversationState, emptyMessages } from '../messages/ui.tsx'
import { StandingDoc } from '../subagents/ui.tsx'
import { CommitCount, ProgressAction, Review, useWorkspaceIndex } from '../workspaces/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import {
  AgentMark,
  ConversationPhase,
  FeatureTag,
  useConcludedSince,
  useOverview,
} from '../conversations/ui.tsx'
import type { Landing } from './landings.ts'
import { RowMenu, saveTitle } from './rows.tsx'
import { Section } from './section.tsx'
import { SummaryHistory } from './summaries.tsx'
import { useShell } from './state.tsx'
import { workOf } from './work.ts'
import type { Work } from './work.ts'

/** When a branch last landed: its latest landed submission's last step. */
export function landedAt(index: ReturnType<typeof useWorkspaceIndex>, id: number) {
  let at: number | undefined
  for (const result of Object.values(index.results))
    if (result.conversationId === id && result.outcome === 'landed')
      at = Math.max(at ?? 0, result.steps.at(-1)?.at ?? result.at)
  return at
}

/**
 * Whether a branch is still in flight: started and neither concluded (the caller leaves those out) nor landed since
 * its latest input. A branch that lands and then gets new work is in flight again.
 */
export function inFlight(
  conversation: ConversationSummary,
  index: ReturnType<typeof useWorkspaceIndex>,
) {
  if (conversation.busy) return true
  if (index.queue.some((item) => item.conversationId === conversation.id)) return true
  const landed = landedAt(index, conversation.id)
  return landed === undefined || (conversation.inputAt ?? 0) > landed
}

/** Where an open branch stands, in a word or two, and how loud to say it. */
function useBranchState(
  conversation: ConversationSummary,
  working: boolean,
  phase: { word: string; waiting: boolean } | undefined,
  parked = false,
) {
  const index = useWorkspaceIndex()
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const runState = useOverview()[conversation.id]?.runState
  const primary = useDocOf(1, StandingDoc)?.ultimate
  const concludedSince = useConcludedSince()(conversation.id)
  const queued = index.queue.find((item) => item.conversationId === conversation.id)
  if (queued?.state === 'landing') return { label: 'landing', tone: 'success' } as const
  if (queued) return { label: 'submitted', tone: 'success' } as const
  // A pause holds its run: nothing of it executes until Play.
  if (parked) return { label: 'paused', tone: 'paused' } as const
  // The sidebar's one conversation state; `working` also counts its subagents' runs.
  const state = working
    ? 'working'
    : conversationState(
        { id: conversation.id, kind: 'other', runState, primary, concludedSince },
        log,
      )
  if (state === 'working')
    return {
      label: phase && !phase.waiting ? phase.word : 'working',
      tone: 'brand',
    } as const
  if (state === 'waits') return { label: 'waits on you', tone: 'waiting' } as const
  if (state === 'awaiting') return { label: 'awaiting @ultimate', tone: 'waiting' } as const
  if (state === 'failed') return { label: 'failed', tone: 'failed' } as const
  return { label: 'idle', tone: 'quiet' } as const
}

const tones = {
  failed: 'text-error',
  success: 'text-success',
  brand: 'text-brand',
  waiting: 'text-amber-700 dark:text-amber-300',
  paused: 'text-warning',
  quiet: 'text-muted-foreground/70',
}

type FlightProps = {
  conversation: ConversationSummary
  working: boolean
  /** A pause parked its run. */
  parked?: boolean
  shown: boolean
  now: number
  work?: Work
  /** Its subagents, one line each. */
  children?: ReactNode
  onConclude: (conclude: boolean) => void
}

/** Uncommitted edits as "+ 4 edits", opening a review of them while something reviews. */
function Edits({ count, spec }: { count: number; spec: string }) {
  const label = `+ ${count} edit${count === 1 ? '' : 's'}`
  return (
    <Provided input={spec} point={Review}>
      {(open) =>
        open ? (
          <button
            className="shrink-0 cursor-pointer hover:text-foreground hover:underline"
            onClick={open}
            title="Review uncommitted changes"
            type="button"
          >
            {label}
          </button>
        ) : (
          <span className="shrink-0">{label}</span>
        )
      }
    </Provided>
  )
}

/** One open branch: its feature and title, where it stands, and its age; click opens it. */
function FlightRow(props: FlightProps) {
  return (
    <Provided input={props.working ? props.conversation.id : undefined} point={ConversationPhase}>
      {(phase) => <PhasedFlightRow {...props} phase={phase} />}
    </Provided>
  )
}

function PhasedFlightRow({
  conversation,
  working,
  parked,
  shown,
  now,
  work,
  children,
  onConclude,
  phase,
}: FlightProps & { phase?: { word: string; waiting: boolean } }) {
  const actions = useShell()
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  const feature = useOverview()[conversation.id]?.feature
  const state = useBranchState(conversation, working, phase, parked)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const title = conversation.title ?? `#${conversation.id}`
  return (
    <li>
      <div className="group relative">
        {editing && (
          <input
            aria-label="Conversation title"
            autoFocus
            className="absolute inset-x-2 top-0.5 z-10 h-6 rounded-sm border border-input bg-background px-1.5 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            defaultValue={conversation.title ?? ''}
            onBlur={(event) => {
              setEditing(false)
              if (!cancelled.current) saveTitle(conversation.id, event.currentTarget.value)
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                event.currentTarget.blur()
              if (event.key === 'Escape') {
                cancelled.current = true
                event.currentTarget.blur()
              }
            }}
          />
        )}
        <SummaryHistory id={conversation.id}>
          <button
            aria-current={shown ? 'true' : undefined}
            className={cn(
              'mx-2 flex w-[calc(100%-1rem)] min-w-0 cursor-pointer flex-col gap-0.5 rounded-md py-1 pr-2 pl-2.5 text-left outline-none hover:bg-sidebar-accent/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
              shown && 'bg-sidebar-accent',
            )}
            data-in-flight={conversation.id}
            onClick={() => actions.switchConversation(conversation.id)}
            title={`${title} · #${conversation.id}`}
            type="button"
          >
            <span className="flex w-full min-w-0 items-center gap-1.5 pr-5">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  state.tone === 'brand'
                    ? 'animate-pulse-dot bg-brand'
                    : state.tone === 'waiting' || state.tone === 'paused'
                      ? 'bg-amber-400'
                      : state.tone === 'success'
                        ? 'bg-success'
                        : state.tone === 'failed'
                          ? 'bg-error'
                          : 'bg-muted-foreground/40',
                )}
              />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-[12px]',
                  shown ? 'text-foreground' : 'text-foreground/85',
                )}
              >
                {title}
              </span>
            </span>
            <span className="flex w-full min-w-0 items-center gap-1.5 pl-3 font-mono text-[10px] leading-4 text-muted-foreground">
              {feature && <FeatureTag feature={feature} />}
              <span className={cn('shrink-0', tones[state.tone])}>{state.label}</span>
              {latest > 0 && (
                <span className="ml-auto shrink-0 pl-1 text-muted-foreground/60">
                  {formatAgo(latest, now)}
                </span>
              )}
            </span>
          </button>
        </SummaryHistory>
        {!editing && (
          // Beside the title rather than at the bottom right, where the age is.
          <div className="absolute top-0.5 right-2 size-5">
            <RowMenu
              concluded={false}
              conversation={conversation}
              onConclude={onConclude}
              onRename={() => {
                cancelled.current = false
                setEditing(true)
              }}
            />
          </div>
        )}
      </div>
      {work && (
        // Its own line under the row's button, so its links never nest in it.
        <span
          className="flex min-w-0 items-center gap-2 pr-2 pb-0.5 pl-[30px] font-mono text-[10px] leading-4 text-muted-foreground/80"
          data-flight-work={conversation.id}
        >
          {work.commits && <CommitCount count={work.commits.count} range={work.commits.spec} />}
          {work.edits && <Edits count={work.edits.count} spec={work.edits.spec} />}
        </span>
      )}
      {children}
    </li>
  )
}

/**
 * Each open branch's work so far, read once for all of them. It is read again only when something can have changed it:
 * an agent commits (`coding-tools.committed`), a worktree changes in the index, or a branch's run ends (edits happen in
 * runs). Never on a timer, nor when a run starts: each read runs git per worktree on the host.
 */
function useFlightWork(branches: ConversationSummary[]) {
  const ids = branches.filter((branch) => branch.workspace?.state === 'ready').map((b) => b.id)
  const progress = useAction(
    ProgressAction,
    { ids },
    { enabled: ids.length > 0, onError: () => {} },
  )
  const { refetch } = progress
  // A worktree becoming ready or going changes `ids`, which refetches by itself.
  const commit = useEvents({ events: [Committed], limit: 1 })?.[0]?.id
  const busy = branches.filter((branch) => branch.busy).map((branch) => branch.id)
  // Counts the runs that ended: a branch that was working is not anymore.
  const [runs, setRuns] = useState({ busy, ended: 0 })
  if (busy.join() !== runs.busy.join())
    setRuns({
      busy,
      ended: runs.ended + (runs.busy.some((id) => !busy.includes(id)) ? 1 : 0),
    })
  const { ended } = runs
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (ids.length > 0) void refetch()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- a changed id set refetches in useAction itself
  }, [commit, ended, refetch])
  const byId = new Map((progress.data ?? []).map((item) => [item.id, item]))
  return new Map(
    branches.map((branch) => [
      branch.id,
      workOf(branch.id, branch.workspace?.branch, byId.get(branch.id)),
    ]),
  )
}

/** An open branch for the In flight section, with whether it (or a subagent of it) works and its subagent lines. */
export type Flight = {
  conversation: ConversationSummary
  working: boolean
  parked?: boolean
  subagents?: ReactNode
}

/**
 * Whether a flight still counts as open once the roots' own landing notes are known too: the lander keeps only recent
 * results, so a branch whose landing note is newer than its latest input landed, unless it works again.
 */
export const stillOpen = (flight: Flight, landings: readonly Landing[]) =>
  flight.working ||
  !landings.some(
    (event) =>
      event.from === flight.conversation.id &&
      (event.at ?? 0) >= (flight.conversation.inputAt ?? 0),
  )

/**
 * In flight · N: every open branch across the project's trees, newest input first, each with its feature, state, age,
 * its work so far and its subagents nested below it. It replaces the per-root tree; concluded and landed work sits in
 * the Landed, Earlier and Concluded folds.
 */
export function InFlight({
  flights,
  shownId,
  now,
  onConclude,
}: {
  flights: Flight[]
  shownId?: number
  now: number
  onConclude: (id: number, conclude: boolean) => void
}) {
  const work = useFlightWork(flights.map((flight) => flight.conversation))
  if (!flights.length) return null
  return (
    <Section count={flights.length} id="in-flight" label="In flight">
      <ul className="flex flex-col gap-px">
        {flights.map((flight) => (
          <FlightRow
            conversation={flight.conversation}
            key={flight.conversation.id}
            now={now}
            onConclude={(conclude) => onConclude(flight.conversation.id, conclude)}
            parked={flight.parked}
            shown={flight.conversation.id === shownId}
            work={work.get(flight.conversation.id)}
            working={flight.working}
          >
            {flight.subagents}
          </FlightRow>
        ))}
      </ul>
    </Section>
  )
}

const kinds = [
  ['decision', 'decisions'],
  ['fact', 'facts'],
  ['lesson', 'lessons'],
] as const

/**
 * A root's project memory as one row: what every new branch starts from, counted by kind, with the brief's size; a
 * click opens the Memory surface, and the row shows selected while it does. Its tally, the browsable history behind
 * it, opens from the project header above it. A root without memories yet shows its context's size.
 */
export function useMemorySummary(id: number) {
  const tally = useDocOf(id, TallyDoc)
  const memories = Object.values(useDocOf(id, MemoryDoc)?.memories ?? {})
  const counts = kinds
    .map(
      ([kind, plural]) => [memories.filter((item) => item.kind === kind).length, plural] as const,
    )
    .filter(([count]) => count > 0)
  return {
    total: memories.length,
    tokens: tally?.since === undefined ? undefined : (tally.briefTokens ?? tally.tokens),
    counts: counts.length
      ? counts
          .map(([count, plural]) => `${count} ${count === 1 ? plural.slice(0, -1) : plural}`)
          .join(' · ')
      : 'none yet',
  }
}

/**
 * A root's project memory as one row in the project block, opening the Memory surface (see `useMemorySummary`).
 */
export function MemoryRow({
  conversation,
  working,
}: {
  conversation: ConversationSummary
  working?: 'self' | 'subagents'
}) {
  const shown = useShell().surface === MEMORY_SURFACE
  const openMemory = useOpenMemory()
  const id = conversation.id
  const { tokens, counts } = useMemorySummary(id)
  return (
    <div data-conversation={id} data-root-row={id}>
      <button
        aria-current={shown ? 'page' : undefined}
        aria-label={`Project memory of #${id}`}
        className={cn(
          'mx-2 flex h-11 w-[calc(100%-1rem)] min-w-0 cursor-pointer items-center gap-2.5 rounded-md pr-2 pl-2 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
          shown && 'bg-sidebar-accent hover:bg-sidebar-accent',
        )}
        onClick={() => openMemory()}
        title="What every new branch starts from · open Memory"
        type="button"
      >
        <AgentMark name="memory" presence={working === 'self' ? 'working' : undefined} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
              Memory
            </span>
            {tokens !== undefined && (
              <span
                className="shrink-0 font-mono text-[10px] text-muted-foreground/70"
                title="Tokens every new branch starts from"
              >
                {formatTokens(tokens)}
              </span>
            )}
          </span>
          <span className="truncate font-mono text-[10px] leading-4 text-muted-foreground">
            {counts}
          </span>
        </span>
      </button>
    </div>
  )
}
