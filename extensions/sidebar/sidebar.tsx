import { ROOT } from '@/sdk'
import { ChevronRightIcon } from 'lucide-react'
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
  ParkedRuns,
  AllProvided,
  Provided,
  Slot,
  useConversationSummary,
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
import { Row, ChildRow, EpicLine, StandingRow, SubagentLine, WaitLines } from './rows.tsx'
import { waitedOn } from '../../lib/waits.ts'
import {
  MessagesDoc,
  conversationState,
  conversationWait,
  waitLabel,
  useRemoteProgress,
  useStarters,
  useUnderway,
  emptyMessages,
  stateTone,
  stateWord,
} from '../messages/ui.tsx'
import { InFlight, inFlight, MemoryRow, stillOpen } from './root.tsx'
import { useAutomations, timerWaits } from '../automations/ui.tsx'
import { Project } from './project.tsx'
import type { Flight } from './root.tsx'
import { Landed, useLandings } from './landed.tsx'
import { useRoots } from '../lineage/ui.tsx'
import { StandingDoc, talkToUltimate } from '../subagents/ui.tsx'
import type { KeptWork } from '../conversations/types.ts'
import { LanderState } from './lander.tsx'
import { StandingPhase, WaitingOnUser } from './ultimate.tsx'
import { useShell, useSidebarState } from './state.tsx'
import { topLevelRows } from './listed.ts'
import { UnderUltimate, Unlisted } from './ui.tsx'

const useShownId = () => useStore((state) => state.view?.conversation.id ?? state.requested)

function topOf(id: number | undefined, conversations: readonly ConversationSummary[]) {
  let current = conversations.find((conversation) => conversation.id === id)
  while (current?.parentConversationId !== undefined) {
    const parent = current.parentConversationId
    current = conversations.find((conversation) => conversation.id === parent)
  }
  return current
}

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

const newestInputFirst = (a: ConversationSummary, b: ConversationSummary) =>
  (b.inputAt ?? 0) - (a.inputAt ?? 0) || b.id - a.id

const neverConcludedStandingAgent = (conversation: ConversationSummary) =>
  conversation.label === 'lander' ||
  (conversation.label === 'agent' &&
    conversation.parentConversationId === undefined &&
    conversation.ownerTaskId === undefined)

export function Conversations() {
  const ultimateId = useDocOf(ROOT, StandingDoc)?.ultimate
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

function Tree({
  waiting,
  parked,
  unlisted,
}: {
  waiting: number
  parked: ReadonlySet<number>
  unlisted: readonly ReadonlySet<number>[]
}) {
  const overview = useOverview()
  const log = useDocOf(ROOT, MessagesDoc) ?? emptyMessages
  const tasks = useTasks()
  const foregroundTaskConversations = new Set<number>(
    Object.values(tasks?.tasks ?? {})
      .filter((task) => !task.background)
      .map((task) => task.conversationId),
  )
  const conversations = useConversations().map((conversation) => ({
    ...conversation,
    busy:
      !parked.has(conversation.id) &&
      (foregroundTaskConversations.has(conversation.id) ||
        overview[conversation.id]?.runState === 'working'),
  }))
  const actions = useShell()
  const workspacesEnabled = useSystem()?.extensions.some(
    (extension) => extension.name === 'workspaces' && extension.enabled,
  )
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
    shownTop &&
    !neverConcludedStandingAgent(shownTop) &&
    !roots.has(shownTop.id) &&
    !hiddenIds.has(shownTop.id)
      ? overview[shownTop.id]
      : undefined
  const [expanded, setExpanded] = useSidebarState<number[]>('expanded', [])
  const working = workingByTop(conversations)
  const topLevel = topLevelRows(conversations, new Set(unlisted.flatMap((set) => [...set])))
  const standingIds = useDocOf(ROOT, StandingDoc)
  const ultimateId = standingIds?.ultimate
  const timers = timerWaits(useAutomations(5000).data, standingIds)
  const starterOf = useStarters()
  const underway = useUnderway()
  const primaryWait =
    ultimateId === undefined
      ? undefined
      : conversationWait(
          {
            id: ultimateId,
            kind: 'primary',
            runState: overview[ultimateId]?.runState,
            busy: underway(ultimateId),
          },
          log,
          timers,
        )
  const remote = useRemoteProgress(primaryWait?.on === 'remote' ? primaryWait.project : undefined)
  const labelOf = (conversation: Parameters<typeof conversationWait>[0]) =>
    waitLabel(conversationWait(conversation, log, timers), ultimateId, primaryWait, remote.data)
  const ultimate = topLevel.find((conversation) => conversation.id === ultimateId)
  const agents = topLevel
    .filter(
      (conversation) => neverConcludedStandingAgent(conversation) && conversation.id !== ultimateId,
    )
    .toSorted((a, b) => Number(b.label === 'lander') - Number(a.label === 'lander') || a.id - b.id)
  const workspaceIndex = useWorkspaceIndex()
  const listed = topLevel
    .filter(
      (conversation) =>
        !neverConcludedStandingAgent(conversation) && !hiddenIds.has(conversation.id),
    )
    .toSorted(newestInputFirst)
  const hidden = topLevel
    .filter(
      (conversation) =>
        !neverConcludedStandingAgent(conversation) && hiddenIds.has(conversation.id),
    )
    .toSorted(newestInputFirst)
  const branchesBySource = new Map<number, ConversationSummary[]>()
  for (const conversation of topLevel.toSorted(newestInputFirst)) {
    if (roots.has(conversation.id) || !conversation.branchOf) continue
    const source = conversation.branchOf.conversationId
    branchesBySource.set(source, [...(branchesBySource.get(source) ?? []), conversation])
  }
  const rootRows = listed
    .filter((conversation) => roots.has(conversation.id))
    .toSorted(newestInputFirst)
  const landings = useLandings(rootRows.map((root) => root.id))
  const branchesBelow = (id: number): ConversationSummary[] =>
    (branchesBySource.get(id) ?? [])
      .filter((branch) => !hiddenIds.has(branch.id))
      .flatMap((branch) => [branch, ...branchesBelow(branch.id)])
  const openBranches = rootRows
    .flatMap((root) => branchesBelow(root.id))
    .filter(
      (branch) =>
        inFlight(branch, workspaceIndex) &&
        stillOpen({ conversation: branch, working: working.has(branch.id) }, landings),
    )
    .toSorted(newestInputFirst)
  const rest = listed.filter(
    (conversation) =>
      !roots.has(conversation.id) &&
      !neverConcludedStandingAgent(conversation) &&
      !openBranches.includes(conversation),
  )
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
        throw failure
      }
    }
    await setConclude(id, conclude)
  }
  const standingRow = (conversation: ConversationSummary | undefined) => {
    const busy = conversation !== undefined && working.has(conversation.id)
    const latest = Math.max(conversation?.inputAt ?? 0, conversation?.answerAt ?? 0)
    const lander = conversation?.label === 'lander'
    const isUltimate = conversation === undefined || conversation.id === ultimateId
    const shown = conversation !== undefined && conversation.id === shownTop?.id
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
    const facts = conversation && {
      id: conversation.id,
      kind: isUltimate ? ('primary' as const) : ('other' as const),
      runState: overview[conversation.id]?.runState,
      busy: busy || underway(conversation.id),
      parked: parked.has(conversation.id),
    }
    const state = facts ? conversationState(facts, log, timers) : waiting > 0 ? 'waits' : 'idle'
    const markKeepsPulsingWhileUserWaits =
      state === 'working' || landing || (busy && state === 'waits')
    const waits =
      isUltimate &&
      facts &&
      state === 'awaiting' &&
      conversationWait(facts, log, timers)?.on === 'agent'
        ? waitedOn(facts.id, log.messages).map((id) => ({
            id,
            title: conversations.find((c) => c.id === id)?.title,
            feature: overview[id]?.feature,
          }))
        : []
    const label =
      waits.length > 0
        ? `waits on ${waits.length === 1 ? 'a branch' : `${waits.length} branches`}`
        : facts && labelOf(facts)
    const standing = (
      <StandingRow
        conversation={conversation}
        key={conversation?.id ?? 'ultimate'}
        name={name}
        presence={
          markKeepsPulsingWhileUserWaits
            ? 'working'
            : state === 'waits'
              ? 'waiting'
              : state === 'awaiting'
                ? 'awaiting'
                : 'idle'
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
            ) : (
              <span className={cn('min-w-0 truncate', stateTone[state])} title={label}>
                {stateWord(state, 0, label)}
              </span>
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
    return waits.length > 0 ? (
      <div key={conversation?.id ?? 'ultimate'}>
        {standing}
        <WaitLines waits={waits} />
      </div>
    ) : (
      standing
    )
  }
  const row = (conversation: ConversationSummary, shown = conversation.id === shownTop?.id) => {
    if (neverConcludedStandingAgent(conversation)) return standingRow(conversation)
    if (roots.has(conversation.id))
      return (
        <MemoryRow
          conversation={conversation}
          key={conversation.id}
          working={working.get(conversation.id)}
        />
      )
    const recorded = seen[conversation.id]
    const facts = {
      id: conversation.id,
      kind: 'other' as const,
      runState: overview[conversation.id]?.runState,
      busy: underway(conversation.id),
      parked: parked.has(conversation.id),
      starter: starterOf(conversation.id),
      concludedSince: concludedSince(conversation.id),
    }
    const derived = conversationState(facts, log, timers)
    const wait = labelOf(facts)
    const workingUnlessQuestionWaitsOnUser =
      derived === 'waits'
        ? undefined
        : (working.get(conversation.id) ?? (derived === 'working' ? 'self' : undefined))
    return (
      <Row
        activity={overview[conversation.id]?.activity}
        state={derived}
        waitLabel={derived === 'awaiting' ? wait : undefined}
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
          workingUnlessQuestionWaitsOnUser === undefined
        }
        working={workingUnlessQuestionWaitsOnUser}
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
    const tallyHasOnlyHistoricalOwnedChildren = roots.has(conversation.id)
    const children = tallyHasOnlyHistoricalOwnedChildren
      ? []
      : (childrenByParent.get(conversation.id) ?? [])
    const mountSubagentRows = expanded.includes(conversation.id)
    const ownBranches =
      roots.has(conversation.id) && !concluded
        ? []
        : (branchesBySource.get(conversation.id) ?? []).filter(
            (branch) => hiddenIds.has(branch.id) === concluded && !openBranches.includes(branch),
          )
    const subagents = children.length > 0 && (
      <Collapsible
        open={mountSubagentRows}
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
          {mountSubagentRows && children.map((child) => tree(child, true, concluded))}
        </CollapsibleContent>
      </Collapsible>
    )
    return (
      <div key={conversation.id}>
        {nested ? (
          <ChildRow
            parked={parked.has(conversation.id)}
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
  const subagentLines = (id: number, depth = 0): ReactNode[] =>
    (childrenByParent.get(id) ?? []).flatMap((child) => [
      <SubagentLine
        conversation={child}
        depth={depth}
        key={child.id}
        parked={parked.has(child.id)}
        row={overview[child.id]}
        shown={shownId === child.id}
      />,
      ...subagentLines(child.id, depth + 1),
    ])
  const flights: Flight[] = openBranches.map((branch) => ({
    conversation: branch,
    working: working.has(branch.id),
    parked: parked.has(branch.id),
    subagents: [
      <EpicLine id={branch.id} key="epic" working={working.get(branch.id) === 'self'} />,
      ...subagentLines(branch.id),
    ],
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
      <nav aria-label="Conversations" className="flex flex-col gap-0.5">
        <div className="mb-2 flex flex-col gap-0.5 border-b border-border/60 pb-2">
          {ultimate ? tree(ultimate) : standingRow(undefined)}
          <AllProvided input={ultimateId} point={UnderUltimate}>
            {(rows) => rows}
          </AllProvided>
        </div>
        {agents.length > 0 && (
          <div
            aria-label="Agents"
            className="mb-2 flex flex-col gap-0.5 border-b border-border/60 pb-2"
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
            <CollapsibleTrigger className="group/earlier flex w-full cursor-pointer items-center gap-1 px-4 py-1.5 section-label outline-none hover:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/earlier:rotate-90" />
              Earlier · {earlier.length}
            </CollapsibleTrigger>
            <CollapsibleContent
              aria-label="Earlier"
              role="region"
              className="flex flex-col gap-0.5 pt-1"
            >
              {earlierOpen && earlier.map((conversation) => tree(conversation))}
            </CollapsibleContent>
          </Collapsible>
        )}
        {hidden.length > 0 && (
          <Collapsible className="pt-1" open={concludedOpen} onOpenChange={setConcludedOpen}>
            <CollapsibleTrigger className="group/concluded flex w-full cursor-pointer items-center gap-1 px-4 py-1.5 section-label outline-none hover:text-foreground focus-visible:text-foreground">
              <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/concluded:rotate-90" />
              Concluded · {hidden.length}
            </CollapsibleTrigger>
            <CollapsibleContent
              aria-label="Concluded"
              className="flex flex-col gap-0.5 pt-1"
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

export function Seen() {
  const id = useShownId()
  const summary = useConversationSummary(id)
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
