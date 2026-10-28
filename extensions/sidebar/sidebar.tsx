import { BrainIcon, ChevronRightIcon, FolderIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  api,
  cn,
  errorMessage,
  formatAgo,
  formatTokens,
  ParkedRuns,
  projectTitle,
  AllProvided,
  Provided,
  Slot,
  useDocOf,
  useNow,
  useStore,
  useSystem,
  useTasks,
} from '@/sdk'
import {
  ConcludeAction,
  hiddenConversationIds,
  ResumeAction,
  useConcludedSince,
  useOverview,
} from '../conversations/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import {
  PendingAction,
  useWorkspaceConversations as useConversations,
  useWorkspaceIndex,
} from '../workspaces/ui.tsx'
import { Row, ChildRow, StandingRow, SubagentLine } from './rows.tsx'
import {
  MessagesDoc,
  conversationState,
  emptyMessages,
  stateTone,
  stateWord,
} from '../messages/ui.tsx'
import { InFlight, inFlight, MemoryRow, stillOpen, useMemorySummary } from './root.tsx'
import type { Flight } from './root.tsx'
import { Landed, useLandings } from './landed.tsx'
import { MEMORY_SURFACE, useOpenMemory, useRoots } from '../lineage/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import type { KeptWork } from '../conversations/types.ts'
import { LanderState } from './lander.tsx'
import { StandingPhase, WaitingCount, WaitingOnUser } from './ultimate.tsx'
import { useShell, useSidebarState } from './state.tsx'
import { topLevelRows } from './listed.ts'
import { UnderUltimate, Unlisted } from './ui.tsx'

/**
 * The project: its path from home (or `<project> #<worktree>`) heading its root's Memory row. Clicking the path opens
 * the root's History, the project's read-only tally; its chevron folds the Memory row away (folded by default, kept in
 * `ext.conversations.projectOpen`), and folded, a quiet brain count on the path row still opens Memory.
 */
function Project({
  root,
  shown,
  children,
}: {
  root?: number
  shown: boolean
  children?: ReactNode
}) {
  const system = useSystem()
  const actions = useShell()
  const title = projectTitle(system)
  const [open, setOpen] = useSidebarState('projectOpen', false)
  return (
    <div aria-label="Project" className="mb-1 border-b border-border/70 pb-1" role="group">
      {root === undefined ? (
        <div
          className="flex h-10 shrink-0 items-center gap-2 px-4 text-[13px] font-medium text-foreground/90"
          title={system?.project.root}
        >
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{title}</span>
        </div>
      ) : (
        <div
          className={cn(
            'group/project mx-2 mt-1 flex h-8 min-w-0 items-center rounded-md text-[13px] font-medium text-foreground/90 has-[[data-root-context]:hover]:bg-sidebar-accent/50',
            shown && 'bg-sidebar-accent has-[[data-root-context]:hover]:bg-sidebar-accent',
          )}
        >
          <button
            aria-expanded={open}
            aria-label={open ? 'Hide the project memory' : 'Show the project memory'}
            className="flex h-full w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            data-project-toggle
            onClick={() => setOpen(!open)}
            title={open ? 'Hide Memory' : 'Show Memory'}
            type="button"
          >
            <ChevronRightIcon
              className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            />
          </button>
          <button
            aria-current={shown ? 'true' : undefined}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            data-root-context={root}
            onClick={() => actions.switchConversation(root)}
            title={`${system?.project.root ?? title} · open the project's History: every branch, abstract and landing`}
            type="button"
          >
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{title}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] font-normal text-muted-foreground/50 group-hover/project:text-muted-foreground">
              History #{root}
            </span>
          </button>
          {!open && <MemoryHint root={root} />}
        </div>
      )}
      {(open || root === undefined) && children}
    </div>
  )
}

/** The folded project block's trace of its memory: a brain and the count, opening the Memory surface. */
function MemoryHint({ root }: { root: number }) {
  const openMemory = useOpenMemory()
  const shown = useShell().surface === MEMORY_SURFACE
  const { total, tokens, counts } = useMemorySummary(root)
  return (
    <button
      aria-current={shown ? 'page' : undefined}
      aria-label="Open the project memory"
      className={cn(
        'mr-0.5 flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[10px] font-normal text-muted-foreground/50 outline-none hover:bg-sidebar-accent/50 hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring',
        shown && 'bg-sidebar-accent text-foreground hover:bg-sidebar-accent hover:text-foreground',
      )}
      data-memory-hint={root}
      onClick={() => openMemory()}
      title={`Memory · ${counts}${tokens === undefined ? '' : ` · ${formatTokens(tokens)} tokens every new branch starts from`}`}
      type="button"
    >
      <BrainIcon className="size-3" />
      {total > 0 && total}
    </button>
  )
}

/** The shown conversation, also while its snapshot is still on the way. */
const useShownId = () => useStore((state) => state.view?.conversation.id ?? state.requested)

/** The top-level conversation above `id` by parent links, or `id`'s own summary when it is top-level. */
function topOf(id: number | undefined, conversations: readonly ConversationSummary[]) {
  let current = conversations.find((conversation) => conversation.id === id)
  while (current?.parentConversationId !== undefined) {
    const parent = current.parentConversationId
    current = conversations.find((conversation) => conversation.id === parent)
  }
  return current
}

/** Why a top-level conversation is working: its own run, or only runs of conversations below it. */
function workingByTop(conversations: readonly ConversationSummary[]) {
  const working = new Map<number, 'self' | 'subagents'>()
  for (const conversation of conversations) {
    if (
      !conversation.busy ||
      (conversation.parentConversationId !== undefined && conversation.ownerTaskId === undefined)
    )
      continue
    const top = topOf(conversation.id, conversations)
    if (!top) continue
    working.set(top.id, top.id === conversation.id ? 'self' : (working.get(top.id) ?? 'subagents'))
  }
  return working
}

/** Siblings by latest input, newest first. */
const byInput = (a: ConversationSummary, b: ConversationSummary) =>
  (b.inputAt ?? 0) - (a.inputAt ?? 0) || b.id - a.id

const pinned = (conversation: ConversationSummary) =>
  conversation.label === 'lander' ||
  (conversation.label === 'agent' &&
    conversation.parentConversationId === undefined &&
    conversation.ownerTaskId === undefined)

/** The project tree, with owned subagents under each row and earlier/concluded work at the bottom. */
export function Conversations() {
  const ultimateId = useDocOf(1, StandingDoc)?.ultimate
  return (
    <WaitingOnUser>
      {(waiting) => (
        <Provided input={null} point={ParkedRuns}>
          {(parked) => (
            <AllProvided input={ultimateId} point={Unlisted}>
              {(sets) => <Tree parked={parked ?? none} unlisted={sets} waiting={waiting} />}
            </AllProvided>
          )}
        </Provided>
      )}
    </WaitingOnUser>
  )
}
const none: ReadonlySet<number> = new Set()

/** The tree, with how many messages and answers wait on the user for @ultimate's row. */
function Tree({
  waiting,
  parked,
  unlisted,
}: {
  waiting: number
  parked: ReadonlySet<number>
  /** Each provider's conversations no section lists. */
  unlisted: readonly ReadonlySet<number>[]
}) {
  const overview = useOverview()
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const tasks = useTasks()
  const foreground = new Set<number>(
    Object.values(tasks?.tasks ?? {})
      .filter((task) => !task.background)
      .map((task) => task.conversationId),
  )
  // The task graph reflects the run; the timestamp/title list can lag. A run a pause parked is not working.
  const conversations = useConversations().map((conversation) => ({
    ...conversation,
    busy:
      !parked.has(conversation.id) &&
      (foreground.has(conversation.id) || overview[conversation.id]?.runState === 'working'),
  }))
  const actions = useShell()
  const workspacesEnabled = useSystem()?.extensions.some(
    (extension) => extension.name === 'workspaces' && extension.enabled,
  )
  // Beside another surface (Memory) no conversation shows, so no row is highlighted.
  const conversationShown = useShownId()
  const shownId = actions.surface === 'agent' ? conversationShown : undefined
  const now = useNow(60_000)
  const [concludedIds] = useSidebarState<number[]>('concluded', [])
  const concludedSince = useConcludedSince()
  const [seen] = useSidebarState<Record<string, number>>('seen', {})
  const shownTop = topOf(shownId, conversations)
  const hiddenIds = hiddenConversationIds(conversations, concludedIds)
  const roots = new Set(useRoots())
  const summary =
    shownTop && !pinned(shownTop) && !roots.has(shownTop.id) && !hiddenIds.has(shownTop.id)
      ? overview[shownTop.id]
      : undefined
  const [expanded, setExpanded] = useSidebarState<number[]>('expanded', [])
  const working = workingByTop(conversations)
  const topLevel = topLevelRows(conversations, new Set(unlisted.flatMap((set) => [...set])))
  // @ultimate first, then the lander and other standing agents: pinned above the rest and never concluded.
  const standingIds = useDocOf(1, StandingDoc)
  const ultimateId = standingIds?.ultimate
  const ultimate = topLevel.find((conversation) => conversation.id === ultimateId)
  const agents = topLevel
    .filter((conversation) => pinned(conversation) && conversation.id !== ultimateId)
    .toSorted((a, b) => Number(b.label === 'lander') - Number(a.label === 'lander') || a.id - b.id)
  const workspaceIndex = useWorkspaceIndex()
  const listed = topLevel
    .filter((conversation) => !pinned(conversation) && !hiddenIds.has(conversation.id))
    .toSorted(byInput)
  const hidden = topLevel
    .filter((conversation) => !pinned(conversation) && hiddenIds.has(conversation.id))
    .toSorted(byInput)
  const branchesBySource = new Map<number, ConversationSummary[]>()
  for (const conversation of topLevel.toSorted(byInput)) {
    if (roots.has(conversation.id) || !conversation.branchOf) continue
    const source = conversation.branchOf.conversationId
    branchesBySource.set(source, [...(branchesBySource.get(source) ?? []), conversation])
  }
  const rootRows = listed.filter((conversation) => roots.has(conversation.id)).toSorted(byInput)
  const landings = useLandings(rootRows.map((root) => root.id))
  /** The listed branches below `id`, at any depth. */
  const branchesBelow = (id: number): ConversationSummary[] =>
    (branchesBySource.get(id) ?? [])
      .filter((branch) => !hiddenIds.has(branch.id))
      .flatMap((branch) => [branch, ...branchesBelow(branch.id)])
  // Every branch of a tree is in flight until it landed after its latest input; landed ones wait in Earlier.
  const openBranches = rootRows
    .flatMap((root) => branchesBelow(root.id))
    .filter(
      (branch) =>
        inFlight(branch, workspaceIndex) &&
        stillOpen({ conversation: branch, working: working.has(branch.id) }, landings),
    )
    .toSorted(byInput)
  const rest = listed.filter(
    (conversation) =>
      !roots.has(conversation.id) && !pinned(conversation) && !openBranches.includes(conversation),
  )
  // The rest, with branches nested under their source when it is there too.
  const earlier = rest.filter(
    (conversation) => !rest.some((source) => source.id === conversation.branchOf?.conversationId),
  )

  const [warning, setWarning] = useState<{
    id: number
    work?: KeptWork[]
    failure?: string
  }>()
  const [pending, setPending] = useState(false)
  const [earlierOpen, setEarlierOpen] = useState(false)
  const [concludedOpen, setConcludedOpen] = useState(false)
  const [error, setError] = useState<string>()
  const setConclude = async (id: number, conclude: boolean) => {
    if (conclude) await api.action(ConcludeAction, { ids: [id] })
    else await api.action(ResumeAction, { ids: [id] })
    if (!conclude || !hiddenConversationIds(conversations, [id]).has(shownTop?.id ?? -1)) return
    const index = listed.findIndex((conversation) => conversation.id === id)
    const subtree = hiddenConversationIds(conversations, [id])
    const next =
      listed.slice(index + 1).find((candidate) => !subtree.has(candidate.id)) ??
      listed.find((candidate) => !subtree.has(candidate.id))
    if (next) actions.switchConversation(next.id)
  }
  const requestConclude = async (id: number, conclude: boolean) => {
    if (conclude && workspacesEnabled) {
      setError(undefined)
      try {
        const work = await api.action(PendingAction, { ids: [id] })
        if (work.length) {
          setWarning({ id, work })
          return
        }
      } catch (failure) {
        setWarning({ id, failure: errorMessage(failure) })
        // Unhandled ActionErrors become notices; the dialog still lets the user conclude.
        throw failure
      }
    }
    await setConclude(id, conclude)
  }
  /** A standing agent's or the lander's row: status and age, the lander's latest landing, @ultimate's questions. */
  const standingRow = (conversation: ConversationSummary | undefined) => {
    const busy = conversation !== undefined && working.has(conversation.id)
    const latest = Math.max(conversation?.inputAt ?? 0, conversation?.answerAt ?? 0)
    const lander = conversation?.label === 'lander'
    const isUltimate = conversation === undefined || conversation.id === ultimateId
    const shown = conversation !== undefined && conversation.id === shownTop?.id
    // A lander lands without a model run: its dot pulses for the landing too.
    const landing =
      lander &&
      workspaceIndex.queue.some(
        (item) =>
          item.state === 'landing' &&
          workspaceIndex.landerConversations[item.source] === conversation.id,
      )
    const name = lander
      ? 'lander'
      : isUltimate
        ? 'ultimate'
        : (Object.entries(standingIds ?? {}).find(([, id]) => id === conversation.id)?.[0] ??
          conversation.title?.replace(/^@/, '') ??
          `#${conversation.id}`)
    const state = conversation
      ? conversationState(
          {
            id: conversation.id,
            kind: isUltimate ? 'primary' : 'other',
            runState: overview[conversation.id]?.runState,
            busy,
            parked: parked.has(conversation.id),
            primary: ultimateId,
          },
          log,
        )
      : waiting > 0
        ? 'waits'
        : 'idle'
    return (
      <StandingRow
        conversation={conversation}
        key={conversation?.id ?? 'ultimate'}
        name={name}
        presence={
          state === 'working' || landing ? 'working' : state === 'waits' ? 'waiting' : 'idle'
        }
        onOpen={() =>
          conversation && !isUltimate
            ? actions.switchConversation(conversation.id)
            : void talkToUltimate(actions)
        }
        shown={shown}
      >
        {lander ? (
          <LanderState id={conversation.id} index={workspaceIndex} now={now} state={state} />
        ) : (
          <>
            {state === 'working' && conversation ? (
              <StandingPhase id={conversation.id} />
            ) : isUltimate && state === 'waits' && waiting > 0 ? (
              <WaitingCount log={log} waiting={waiting} />
            ) : (
              <span className={cn('shrink-0', stateTone[state])}>{stateWord(state, waiting)}</span>
            )}
            {latest > 0 && (
              <span
                className="ml-auto shrink-0 text-muted-foreground/80"
                title={new Date(latest).toLocaleString()}
              >
                {formatAgo(latest, now)}
              </span>
            )}
          </>
        )}
      </StandingRow>
    )
  }
  const row = (conversation: ConversationSummary, shown = conversation.id === shownTop?.id) => {
    if (pinned(conversation)) return standingRow(conversation)
    if (roots.has(conversation.id))
      return (
        <MemoryRow
          conversation={conversation}
          key={conversation.id}
          working={working.get(conversation.id)}
        />
      )
    const recorded = seen[conversation.id]
    const derived = conversationState(
      {
        id: conversation.id,
        kind: 'other',
        runState: overview[conversation.id]?.runState,
        busy: conversation.busy,
        parked: parked.has(conversation.id),
        primary: ultimateId,
        concludedSince: concludedSince(conversation.id),
      },
      log,
    )
    // Queued input counts as working too; subagents working below it say so.
    const state = working.get(conversation.id) ?? (derived === 'working' ? 'self' : undefined)
    return (
      <Row
        activity={overview[conversation.id]?.activity}
        state={derived}
        concluded={hiddenIds.has(conversation.id)}
        conversation={conversation}
        draft={conversation.inputAt === undefined}
        feature={overview[conversation.id]?.feature}
        key={conversation.id}
        now={now}
        onConclude={(conclude) => void requestConclude(conversation.id, conclude)}
        shown={shown}
        unseen={
          recorded !== undefined &&
          (conversation.answerAt ?? 0) > recorded &&
          conversation.id !== shownId &&
          state === undefined
        }
        working={state}
      />
    )
  }

  const childrenByParent = new Map<number, ConversationSummary[]>()
  for (const candidate of conversations) {
    const parent = candidate.parentConversationId
    if (candidate.ownerTaskId === undefined || parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(candidate)
    childrenByParent.set(parent, children)
  }
  const tree = (conversation: ConversationSummary, nested = false, concluded = false) => {
    // A listed root runs no turns, so anything it owns predates its tally: leftovers stay readable by link and search.
    const children = roots.has(conversation.id) ? [] : (childrenByParent.get(conversation.id) ?? [])
    const open = expanded.includes(conversation.id)
    // Open branches are listed in In flight and a root's Memory row lists none: the rest nest under their source.
    const ownBranches =
      roots.has(conversation.id) && !concluded
        ? []
        : (branchesBySource.get(conversation.id) ?? []).filter(
            (branch) => hiddenIds.has(branch.id) === concluded && !openBranches.includes(branch),
          )
    const subagents = children.length > 0 && (
      <Collapsible
        open={open}
        onOpenChange={(next) =>
          setExpanded((previous) => [
            ...previous.filter((id) => id !== conversation.id),
            ...(next ? [conversation.id] : []),
          ])
        }
      >
        <CollapsibleTrigger
          aria-label={`Sub-agents of conversation ${conversation.id}`}
          className="group/agents ml-5 flex cursor-pointer items-center gap-1 py-1 text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/agents:rotate-90" />
          Sub-agents · {children.length}
        </CollapsibleTrigger>
        <CollapsibleContent className="ml-4 border-l border-border/60">
          {/* Closed sections mount nothing, so their rows are not built either: a long history has thousands. */}
          {open && children.map((child) => tree(child, true, concluded))}
        </CollapsibleContent>
      </Collapsible>
    )
    return (
      <div key={conversation.id}>
        {nested ? (
          <ChildRow
            parked={parked.has(conversation.id)}
            primary={ultimateId}
            conversation={conversation}
            row={overview[conversation.id]}
            shown={shownId === conversation.id}
          />
        ) : (
          row(conversation)
        )}
        {subagents}
        {!nested && ownBranches.length > 0 && (
          <div className="ml-4 border-l border-border/60" data-branches-of={conversation.id}>
            {ownBranches.map((branch) => tree(branch, false, concluded))}
          </div>
        )}
      </div>
    )
  }
  /** A branch's subagents at any depth, one line each, for its In flight row. */
  const subagentLines = (id: number, depth = 0): ReactNode[] =>
    (childrenByParent.get(id) ?? []).flatMap((child) => [
      <SubagentLine
        conversation={child}
        depth={depth}
        key={child.id}
        parked={parked.has(child.id)}
        primary={ultimateId}
        row={overview[child.id]}
        shown={shownId === child.id}
      />,
      ...subagentLines(child.id, depth + 1),
    ])
  const flights: Flight[] = openBranches.map((branch) => ({
    conversation: branch,
    working: working.has(branch.id),
    parked: parked.has(branch.id),
    subagents: subagentLines(branch.id),
  }))

  return (
    <div className="flex flex-1 flex-col pb-2">
      <Dialog
        open={!!warning}
        onOpenChange={(open) => {
          if (!open) setWarning(undefined)
        }}
      >
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
          <div className="px-5 pt-5 pb-4">
            <DialogTitle className="text-[14px] font-medium">Conclude #{warning?.id}?</DialogTitle>
            <DialogDescription className="mt-2 text-[13px] leading-relaxed break-words">
              {warning?.failure ? (
                <>
                  Couldn't check #{warning.id}'s checkout: {warning.failure}. Conclude anyway?
                </>
              ) : (
                <>
                  {warning?.work
                    ?.map((item) => {
                      const parts = [
                        item.uncommitted > 0
                          ? `${item.uncommitted} uncommitted ${item.uncommitted === 1 ? 'file' : 'files'}`
                          : undefined,
                        item.unlanded > 0
                          ? `${item.unlanded} unlanded ${item.unlanded === 1 ? 'commit' : 'commits'}`
                          : undefined,
                      ].filter(Boolean)
                      return `#${item.id}${item.id !== warning.id ? ', a subagent,' : ''} has ${parts.join(' and ')}.`
                    })
                    .join(' ')}{' '}
                  Its checkout is kept until that work lands or is discarded.
                </>
              )}
            </DialogDescription>
            {error && <p className="mt-3 font-mono text-[12px] break-words text-error">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
            <Button onClick={() => setWarning(undefined)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={pending}
              size="sm"
              onClick={async () => {
                if (!warning) return
                setPending(true)
                try {
                  await setConclude(warning.id, true)
                  setWarning(undefined)
                } catch (failure) {
                  setError(errorMessage(failure))
                } finally {
                  setPending(false)
                }
              }}
            >
              {pending ? 'Concluding…' : 'Conclude'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Project
        root={rootRows[0]?.id}
        shown={rootRows[0] !== undefined && rootRows[0].id === shownTop?.id}
      >
        {rootRows.map((root) => tree(root))}
      </Project>
      <nav aria-label="Conversations" className="flex flex-col gap-px">
        <div className="mb-1 border-b border-border/60 pb-1">
          {ultimate ? tree(ultimate) : standingRow(undefined)}
          <AllProvided input={ultimateId} point={UnderUltimate}>
            {(rows) => rows}
          </AllProvided>
        </div>
        {agents.length > 0 && (
          <div
            aria-label="Agents"
            className="mb-1 flex flex-col gap-px border-b border-border/60 pb-1"
            role="group"
          >
            {agents.map((conversation) =>
              conversation.label === 'lander' ? (
                <div key={conversation.id}>
                  {tree(conversation)}
                  <Landed landings={landings} now={now} />
                </div>
              ) : (
                tree(conversation)
              ),
            )}
          </div>
        )}
        {/* What watches or runs in the background, from optional extensions; each section brings its own rule. */}
        <Slot name="sidebar.top" />
        <InFlight
          flights={flights}
          now={now}
          onConclude={(id, conclude) => void requestConclude(id, conclude)}
          shownId={shownId}
        />
      </nav>
      {summary &&
        (summary.summary ||
          [summary.summaryStatus, summary.assessmentStatus].some(
            (status) => status === 'pending' || status === 'error',
          )) && (
          <section
            aria-label="Conversation summary"
            className="mx-4 mt-4 border-t border-border/60 pt-3"
            data-summary-conversation={shownTop?.id}
          >
            <p className="text-xs leading-relaxed break-words text-muted-foreground">
              {summary.summary}
            </p>
            {(summary.summaryStatus === 'pending' || summary.assessmentStatus === 'pending') && (
              <p className="mt-1 text-[10.5px] text-muted-foreground/70" role="status">
                {summary.summaryStatus === 'pending' ? 'Updating summary…' : 'Assessing reply…'}
              </p>
            )}
            {(summary.summaryStatus === 'error' || summary.assessmentStatus === 'error') && (
              <p className="mt-1 text-[10.5px] text-muted-foreground/70" role="status">
                {summary.summaryStatus === 'error'
                  ? 'Summary unavailable'
                  : 'Assessment unavailable'}{' '}
                · retries after next reply
              </p>
            )}
          </section>
        )}
      <div className="mt-auto pt-3">
        {earlier.length > 0 && (
          <Collapsible className="pt-1" open={earlierOpen} onOpenChange={setEarlierOpen}>
            <CollapsibleTrigger className="group/earlier flex w-full cursor-pointer items-center gap-1 px-4 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/earlier:rotate-90" />
              Earlier · {earlier.length}
            </CollapsibleTrigger>
            <CollapsibleContent
              aria-label="Earlier"
              role="region"
              className="flex flex-col gap-px pt-1"
            >
              {earlierOpen && earlier.map((conversation) => tree(conversation))}
            </CollapsibleContent>
          </Collapsible>
        )}
        {hidden.length > 0 && (
          <Collapsible className="pt-1" open={concludedOpen} onOpenChange={setConcludedOpen}>
            <CollapsibleTrigger className="group/concluded flex w-full cursor-pointer items-center gap-1 px-4 py-1 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/concluded:rotate-90" />
              Concluded · {hidden.length}
            </CollapsibleTrigger>
            <CollapsibleContent
              aria-label="Concluded"
              className="flex flex-col gap-px pt-1"
              role="region"
            >
              {concludedOpen &&
                hidden
                  .filter(
                    (conversation) =>
                      roots.has(conversation.id) ||
                      !hidden.some((source) => source.id === conversation.branchOf?.conversationId),
                  )
                  .map((conversation) => tree(conversation, false, true))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  )
}

/** Records the answer the user has seen: the shown top-level conversation's latest, once it is idle. */
export function Seen() {
  const id = useShownId()
  const summary = useConversations().find((conversation) => conversation.id === id)
  const [seen, setSeen] = useSidebarState<Record<string, number>>('seen', {})
  const answerAt =
    summary && summary.parentConversationId === undefined && !summary.busy
      ? (summary.answerAt ?? 0)
      : undefined
  useEffect(() => {
    if (id === undefined || answerAt === undefined || seen[id] === answerAt) return
    setSeen((previous) => ({ ...previous, [id]: answerAt }))
  }, [id, answerAt, seen, setSeen])
  return null
}
