/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createContext, createMemo, useContext } from 'solid-js'
import {
  api,
  openPanel,
  ParkedRuns,
  ROOT,
  showSurface,
  switchConversation,
  useConversations,
  useDocOf,
  useNow,
  useStore,
  useTasks,
  useUiState,
  useAllProvided,
  useProvided,
  type JsonValue,
} from '@/sdk/solid'
import type { ConversationSummary } from '../../shared/protocol.ts'
import { useAutomations, timerWaits } from '../automations/ui.solid.tsx'
import { OverviewDoc } from '../conversations/refs.ts'
import { hiddenConversationIds, useConcludedSince } from '../conversations/ui.solid.tsx'
import { RootsDoc } from '../lineage/refs.ts'
import { MessagesDoc } from '../messages/refs.ts'
import {
  conversationWait,
  emptyMessages,
  useRemoteProgress,
  useStarters,
  useUnderway,
  waitLabel,
} from '../messages/ui.solid.tsx'
import { StandingDoc } from '../subagents/refs.ts'
import { WorkspacesDoc } from '../workspaces/refs.ts'
import type { Workspace, WorkspaceIndex } from '../workspaces/types.ts'
import { topLevelRows } from './listed.ts'
import { Unlisted } from './points.ts'

export type SidebarConversation = ConversationSummary & { workspace?: Workspace }
const emptyWorkspaces: WorkspaceIndex = {
  items: {},
  queue: [],
  landers: {},
  landerConversations: {},
  results: {},
}

export const useSidebarState = <T extends JsonValue>(key: string, initial: T) =>
  useUiState<T>(`ext.conversations.${key}`, initial)

export const useSurface = () => useStore((state) => state.ui.surface?.id ?? 'agent')
export const useShownId = () => useStore((state) => state.view?.conversation.id ?? state.requested)

export const shell = {
  showSurface,
  openPanel,
  switchConversation: (id: ConversationId, options?: { replace?: boolean }) => {
    showSurface('agent')
    switchConversation(id, options)
  },
}

export const standingAgent = (conversation: SidebarConversation) =>
  conversation.label === 'lander' ||
  (conversation.label === 'agent' &&
    conversation.parentConversationId === undefined &&
    conversation.ownerTaskId === undefined)

export const newestInputFirst = (a: SidebarConversation, b: SidebarConversation) =>
  (b.inputAt ?? 0) - (a.inputAt ?? 0) || b.id - a.id

const emptyParked: ReadonlySet<ConversationId> = new Set()

export function useSidebarData() {
  const surface = useSurface()
  const conversationShown = useShownId()
  const shownId = createMemo(() => (surface() === 'agent' ? conversationShown() : undefined))
  const now = useNow(60_000)
  const overview = useDocOf(() => ROOT, OverviewDoc)
  const row = (id: number) => overview()?.conversations[id]
  const messages = useDocOf(() => ROOT, MessagesDoc)
  const log = () => messages() ?? emptyMessages
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const index = () => workspaces() ?? emptyWorkspaces
  const conversations = useConversations()
  const tasks = useTasks()
  const standingIds = useDocOf(() => ROOT, StandingDoc)
  const ultimateId = () => standingIds()?.ultimate
  const parkedRuns = useProvided(ParkedRuns, () => null)
  const parked = (id: ConversationId) => (parkedRuns() ?? emptyParked).has(id)
  const exclusions = useAllProvided(Unlisted, ultimateId)
  const unlisted = createMemo(() => new Set(exclusions().flatMap((set) => [...set])))
  const timersList = useAutomations(() => 5000)
  const timers = createMemo(() => timerWaits(timersList().data, standingIds()))
  const starterOf = useStarters()
  const underway = useUnderway()
  const concludedSince = useConcludedSince()
  const [concludedIds] = useSidebarState<number[]>('concluded', [])
  const [seen] = useSidebarState<Record<string, number>>('seen', {})
  const [expanded, setExpanded] = useSidebarState<number[]>('expanded', [])
  const rootsDoc = useDocOf(() => ROOT, RootsDoc)
  const roots = createMemo(() => new Set(rootsDoc()?.roots))
  const byId = createMemo(
    () => new Map(conversations().map((conversation) => [conversation.id, conversation])),
  )
  const foreground = createMemo(
    () =>
      new Set(
        Object.values(tasks()?.tasks ?? {})
          .filter((task) => !task.background)
          .map((task) => task.conversationId),
      ),
  )
  const busy = (id: ConversationId) =>
    !parked(id) && (foreground().has(id) || row(id)?.runState === 'working')
  const byConversation = (id: ConversationId): SidebarConversation => ({
    ...byId().get(id)!,
    busy: busy(id),
    workspace: index().items[id],
  })
  const topOf = (id?: ConversationId) => {
    let current = id === undefined ? undefined : byId().get(id)
    while (current?.parentConversationId !== undefined)
      current = byId().get(current.parentConversationId)
    return current?.id
  }
  const shownTop = createMemo(() => topOf(shownId()))
  const working = createMemo(() => {
    const result = new Map<ConversationId, 'self' | 'subagents'>()
    for (const { id, parentConversationId, ownerTaskId } of conversations()) {
      if (parentConversationId !== undefined && ownerTaskId === undefined) continue
      if (!busy(id)) continue
      const top = topOf(id)
      if (top !== undefined) result.set(top, top === id ? 'self' : (result.get(top) ?? 'subagents'))
    }
    return result
  })
  const hidden = createMemo(() => hiddenConversationIds(conversations(), concludedIds()))
  const topLevel = createMemo(() =>
    topLevelRows(conversations(), unlisted()).toSorted(newestInputFirst),
  )
  const subagents = createMemo(() => {
    const result = new Map<ConversationId, ConversationId[]>()
    for (const child of conversations()) {
      const parent = child.parentConversationId
      if (parent === undefined || child.ownerTaskId === undefined) continue
      const group = result.get(parent) ?? []
      group.push(child.id)
      result.set(parent, group)
    }
    return result
  })
  const facts = (id: ConversationId, live = underway(id)) => ({
    id,
    kind: 'other' as const,
    runState: row(id)?.runState,
    busy: live,
    parked: parked(id),
    starter: starterOf(id),
    concludedSince: concludedSince(id),
  })
  const primaryWait = createMemo(() => {
    const id = ultimateId()
    return id === undefined
      ? undefined
      : conversationWait(
          { id, kind: 'primary', runState: row(id)?.runState, busy: underway(id) },
          log(),
          timers(),
        )
  })
  const remote = useRemoteProgress(() => {
    const wait = primaryWait()
    return wait?.on === 'remote' ? wait.project : undefined
  })
  const labelOf = (input: Parameters<typeof conversationWait>[0]) =>
    waitLabel(conversationWait(input, log(), timers()), ultimateId(), primaryWait(), remote())
  return {
    busy,
    byConversation,
    conversations,
    expanded,
    facts,
    hidden,
    index,
    labelOf,
    log,
    now,
    parked,
    primaryWait,
    remote,
    roots,
    row,
    seen,
    setExpanded,
    shownId,
    shownTop,
    standingIds,
    subagents,
    timers,
    topLevel,
    ultimateId,
    underway,
    working,
  }
}

export const SidebarData = createContext<ReturnType<typeof useSidebarData>>()
export const useData = () => useContext(SidebarData)

export const compactConversation = (id: ConversationId) => void api.compact(undefined, id)
