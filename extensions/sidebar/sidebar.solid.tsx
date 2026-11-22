/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { ChevronRight } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog.solid.tsx'
import {
  Provided,
  Slot,
  useProvided,
  api,
  cn,
  errorMessage,
  formatAgo,
  notify,
  plural,
  useConversationSummary,
  useSystem,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { waitedOn } from '../../lib/waits.ts'
import { ConcludeAction, ResumeAction } from '../conversations/refs.ts'
import type { KeptWork } from '../conversations/types.ts'
import {
  AgentMark,
  ConversationPhase,
  hiddenConversationIds,
  useAgentTitle,
} from '../conversations/ui.solid.tsx'
import {
  conversationState,
  conversationWait,
  stateTone,
  stateWord,
  waitingOnUser,
} from '../messages/ui.solid.tsx'
import { talkToUltimate } from '../subagents/ui.solid.tsx'
import { PendingAction } from '../workspaces/refs.ts'
import { Landed, useLandings } from './landed.solid.tsx'
import { LanderState } from './lander.solid.tsx'
import { UnderUltimate } from './points.ts'
import { Project } from './project.solid.tsx'
import { InFlight, inFlight, MemoryRow } from './root.solid.tsx'
import { ChildRow, Row, RowMenu, WaitLines } from './rows.solid.tsx'
import {
  shell,
  SidebarData,
  standingAgent,
  useData,
  useShownId,
  useSidebarData,
  useSidebarState,
} from './state.solid.tsx'
import { workingWord } from './ultimate.solid.tsx'

export function Conversations() {
  const data = useSidebarData()
  return (
    <SidebarData value={data}>
      <Tree />
    </SidebarData>
  )
}

function Tree() {
  const data = useData()
  const system = useSystem()
  const listed = createMemo(() =>
    data.topLevel().filter((c) => !standingAgent(c) && !data.hidden().has(c.id)),
  )
  const hidden = createMemo(() =>
    data.topLevel().filter((c) => !standingAgent(c) && data.hidden().has(c.id)),
  )
  const rootIds = createMemo(() =>
    listed()
      .filter((c) => data.roots().has(c.id))
      .map((c) => c.id),
  )
  const landings = useLandings(rootIds)
  const branches = createMemo(() => {
    const result = new Map<ConversationId, ConversationId[]>()
    for (const c of data.topLevel()) {
      if (data.roots().has(c.id) || !c.branchOf) continue
      const source = c.branchOf.conversationId
      const group = result.get(source) ?? []
      group.push(c.id)
      result.set(source, group)
    }
    return result
  })
  const flights = createMemo(() => {
    const open = new Set<ConversationId>()
    const visit = (parent: ConversationId) => {
      for (const id of branches().get(parent) ?? []) {
        if (data.hidden().has(id)) continue
        if (inFlight(data.byConversation(id), data.index(), data.working().has(id), landings()))
          open.add(id)
        visit(id)
      }
    }
    for (const id of rootIds()) visit(id)
    return data
      .topLevel()
      .filter((c) => open.has(c.id))
      .map((c) => c.id)
  })
  const flightIds = createMemo(() => new Set(flights()))
  const earlier = createMemo(() => {
    const rest = listed().filter((c) => !data.roots().has(c.id) && !flightIds().has(c.id))
    const ids = new Set(rest.map((c) => c.id))
    return rest.filter((c) => !c.branchOf || !ids.has(c.branchOf.conversationId)).map((c) => c.id)
  })
  const concluded = createMemo(() => {
    const ids = new Set(hidden().map((c) => c.id))
    return hidden()
      .filter((c) => data.roots().has(c.id) || !c.branchOf || !ids.has(c.branchOf.conversationId))
      .map((c) => c.id)
  })
  const ultimate = createMemo(() => data.topLevel().find((c) => c.id === data.ultimateId())?.id)
  const agents = createMemo(() =>
    data
      .topLevel()
      .filter((c) => standingAgent(c) && c.id !== ultimate())
      .toSorted(
        (a, b) => Number(b.label === 'lander') - Number(a.label === 'lander') || a.id - b.id,
      ),
  )
  const summary = createMemo(() => {
    const id = data.shownTop()
    if (
      id === undefined ||
      data.roots().has(id) ||
      data.hidden().has(id) ||
      standingAgent(data.byConversation(id))
    )
      return undefined
    const row = data.row(id)
    if (
      row?.summary ||
      [row?.summaryStatus, row?.assessmentStatus].some(
        (status) => status === 'pending' || status === 'error',
      )
    )
      return row
    return undefined
  })
  const [warning, setWarning] = createSignal<{
    id: ConversationId
    work?: KeptWork[]
    failure?: string
  }>()
  const [error, setError] = createSignal<string>()
  const setConclude = async (id: ConversationId, close: boolean, who = writerNow()) => {
    if (!close) {
      await writingAs(who, () => api.action(ResumeAction, { ids: [id] }))
      return
    }
    const shown = data.shownTop()
    const rows = listed()
    const subtree = hiddenConversationIds(data.conversations(), [id])
    await writingAs(who, () => api.action(ConcludeAction, { ids: [id] }))
    if (shown === undefined || !subtree.has(shown)) return
    const other = (candidate: { id: ConversationId }) => !subtree.has(candidate.id)
    const next = rows.slice(rows.findIndex((c) => c.id === id) + 1).find(other) ?? rows.find(other)
    if (next) writingAs(who, () => shell.switchConversation(next.id))
  }
  const requestConclude = async (id: ConversationId, close: boolean) => {
    const who = writerNow()
    if (close && system()?.extensions.some((ext) => ext.name === 'workspaces' && ext.enabled)) {
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
    await setConclude(id, close, who)
  }
  const confirmConclude = async (id: ConversationId) => {
    try {
      await setConclude(id, true)
      setWarning(undefined)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  const onConclude = (id: ConversationId, close: boolean) => {
    void requestConclude(id, close).catch((failure: unknown) =>
      notify({ level: 'error', message: errorMessage(failure) }),
    )
  }
  const ownBranches = (id: ConversationId, closed: boolean) =>
    data.roots().has(id) && !closed
      ? []
      : (branches().get(id) ?? []).filter(
          (branch) => data.hidden().has(branch) === closed && !flightIds().has(branch),
        )
  const tree = (id: ConversationId, closed = false) => (
    <ConversationTree id={id} closed={closed} onConclude={onConclude} branches={ownBranches} />
  )

  return (
    <div class="flex flex-1 flex-col pb-2">
      <ConcludeDialog
        warning={warning()}
        error={error()}
        cancel={() => setWarning(undefined)}
        confirm={confirmConclude}
      />
      <Project
        root={rootIds()[0]}
        shown={rootIds()[0] !== undefined && rootIds()[0] === data.shownTop()}
      >
        <For each={rootIds()}>{(id) => tree(id)}</For>
      </Project>
      <nav aria-label="Conversations" class="flex flex-col gap-0.5">
        <div class="mb-2 flex flex-col gap-0.5 border-b border-border/60 pb-2">
          <Show when={ultimate()} keyed fallback={<StandingRow />}>
            {(id) => tree(id)}
          </Show>
          <Provided point={UnderUltimate} input={{ conversation: data.ultimateId() }} />
        </div>
        <Show when={agents().length > 0}>
          <fieldset
            aria-label="Agents"
            class="mb-2 flex min-w-0 flex-col gap-0.5 border-b border-border/60 pb-2"
          >
            <For each={agents()} keyed={(agent) => agent.id}>
              {(agent, index) => (
                <Show
                  when={agent().label === 'lander' && index() === 0}
                  fallback={tree(agent().id)}
                >
                  <div>
                    {tree(agent().id)}
                    <Landed landings={landings()} now={data.now()} />
                  </div>
                </Show>
              )}
            </For>
          </fieldset>
        </Show>
        <Slot name="sidebar.top" variant="inline" />
        <InFlight ids={flights()} onConclude={onConclude} />
      </nav>
      <Show when={summary()}>
        {(row) => (
          <section
            aria-label="Conversation summary"
            class="mx-4 mt-4 border-t border-border/60 pt-3"
            data-summary-conversation={data.shownTop()}
          >
            <p class="text-xs leading-relaxed break-words text-muted-foreground">{row().summary}</p>
            <Show when={row().summaryStatus === 'pending' || row().assessmentStatus === 'pending'}>
              <output class="mt-1 block text-[10.5px] text-muted-foreground/70">
                {row().summaryStatus === 'pending' ? 'Updating summary…' : 'Assessing reply…'}
              </output>
            </Show>
            <Show when={row().summaryStatus === 'error' || row().assessmentStatus === 'error'}>
              <output class="mt-1 block text-[10.5px] text-muted-foreground/70">
                {row().summaryStatus === 'error' ? 'Summary unavailable' : 'Assessment unavailable'}{' '}
                · retries after next reply
              </output>
            </Show>
          </section>
        )}
      </Show>
      <div class="mt-auto pt-3">
        <HistoryGroup label="Earlier" count={earlier().length}>
          <For each={earlier()}>{(id) => tree(id)}</For>
        </HistoryGroup>
        <HistoryGroup label="Concluded" count={hidden().length}>
          <For each={concluded()}>{(id) => tree(id, true)}</For>
        </HistoryGroup>
      </div>
    </div>
  )
}

function ConcludeDialog(props: {
  warning?: { id: ConversationId; work?: KeptWork[]; failure?: string }
  error?: string
  cancel: () => void
  confirm: (id: ConversationId) => Promise<void>
}) {
  const description = () => {
    const warning = props.warning
    if (!warning) return ''
    if (warning.failure)
      return `Couldn't check #${warning.id}'s checkout: ${warning.failure}. Conclude anyway?`
    const details = warning.work
      ?.map((item) => {
        const parts = [
          item.uncommitted > 0 && plural(item.uncommitted, 'uncommitted file'),
          item.unlanded > 0 && plural(item.unlanded, 'unlanded commit'),
        ].filter(Boolean)
        return `#${item.id}${item.id !== warning.id ? ', a subagent,' : ''} has ${parts.join(' and ')}.`
      })
      .join(' ')
    return `${details} Its checkout is kept until that work lands or is discarded.`
  }
  return (
    <Dialog
      open={!!props.warning}
      onOpenChange={(open) => {
        if (!open) props.cancel()
      }}
    >
      <DialogContent class="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        <div class="px-5 pt-5 pb-4">
          <DialogTitle class="text-[14px] font-medium">Conclude #{props.warning?.id}?</DialogTitle>
          <DialogDescription class="mt-2 text-[13px] leading-relaxed break-words">
            {description()}
          </DialogDescription>
          <Show when={props.error}>
            {(error) => <p class="mt-3 font-mono text-[12px] break-words text-error">{error()}</p>}
          </Show>
        </div>
        <div class="flex justify-end gap-2 border-t border-border/70 bg-sidebar px-5 py-3">
          <Button onClick={props.cancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            class="group/conclude"
            size="sm"
            onClick={() => props.warning && props.confirm(props.warning.id)}
          >
            <span class="group-data-pending/conclude:hidden">Conclude</span>
            <span class="hidden group-data-pending/conclude:inline">Concluding…</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function HistoryGroup(props: {
  label: 'Earlier' | 'Concluded'
  count: number
  children: JSX.Element
}) {
  return (
    <Show when={props.count > 0}>
      <Collapsible class="pt-1">
        <CollapsibleTrigger
          aria-label={props.label}
          class={cn(
            'group/history flex w-full items-center gap-1 px-4 py-1.5 section-label outline-none hover:text-foreground',
            props.label === 'Concluded' && 'focus-visible:text-foreground',
          )}
        >
          <ChevronRight class="size-3 transition-transform group-data-open/history:rotate-90" />
          {props.label} · {props.count}
        </CollapsibleTrigger>
        <CollapsibleContent
          aria-label={props.label}
          class="flex flex-col gap-0.5 pt-1"
          render={(panel) => <section {...panel} />}
        >
          {props.children}
        </CollapsibleContent>
      </Collapsible>
    </Show>
  )
}

type TreeProps = {
  id: ConversationId
  closed: boolean
  nested?: boolean
  branches: (id: ConversationId, closed: boolean) => readonly ConversationId[]
  onConclude: (id: ConversationId, close: boolean) => void
}
function ConversationTree(props: TreeProps) {
  const data = useData()
  const conversation = createMemo(() => data.byConversation(props.id))
  const root = () => data.roots().has(props.id)
  const children = () => (root() ? undefined : data.subagents().get(props.id))
  const branches = createMemo(() => (props.nested ? [] : props.branches(props.id, props.closed)))
  const expanded = () => data.expanded().includes(props.id)
  return (
    <div>
      <Switch
        fallback={
          <Row
            conversation={conversation()}
            onConclude={(close) => props.onConclude(props.id, close)}
          />
        }
      >
        <Match when={props.nested}>
          <ChildRow id={props.id} />
        </Match>
        <Match when={standingAgent(conversation())}>
          <StandingRow id={props.id} />
        </Match>
        <Match when={root()}>
          <MemoryRow id={props.id} working={data.working().get(props.id) === 'self'} />
        </Match>
      </Switch>
      <Show when={children()?.length}>
        <Collapsible
          bind={[
            expanded,
            (next) => {
              const id = props.id
              data.setExpanded((previous) => [
                ...previous.filter((key) => key !== id),
                ...(next ? [id] : []),
              ])
            },
          ]}
        >
          <CollapsibleTrigger
            aria-label={`Sub-agents of conversation ${props.id}`}
            class="group/agents ml-5 flex items-center gap-1 py-1 text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight class="size-3 transition-transform group-data-open/agents:rotate-90" />
            Sub-agents · {children()?.length}
          </CollapsibleTrigger>
          <CollapsibleContent class="ml-4 border-l border-border/60">
            <For each={children()}>
              {(id) => (
                <ConversationTree
                  id={id}
                  closed={props.closed}
                  branches={props.branches}
                  nested
                  onConclude={props.onConclude}
                />
              )}
            </For>
          </CollapsibleContent>
        </Collapsible>
      </Show>
      <Show when={branches().length > 0}>
        <div class="ml-4 border-l border-border/60" data-branches-of={props.id}>
          <For each={branches()}>
            {(id) => (
              <ConversationTree
                id={id}
                closed={props.closed}
                branches={props.branches}
                onConclude={props.onConclude}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function StandingRow(props: { id?: ConversationId }) {
  const data = useData()
  const conversation = createMemo(() =>
    props.id === undefined ? undefined : data.byConversation(props.id),
  )
  const isUltimate = () => props.id === undefined || props.id === data.ultimateId()
  const lander = () => conversation()?.label === 'lander'
  const name = createMemo(() =>
    lander()
      ? 'lander'
      : isUltimate()
        ? 'ultimate'
        : (Object.entries(data.standingIds() ?? {}).find(([, id]) => id === props.id)?.[0] ??
          conversation()?.title?.replace(/^@/, '') ??
          `#${props.id}`),
  )
  const title = useAgentTitle(name)
  const shown = () => props.id !== undefined && props.id === data.shownTop()
  const busy = () => props.id !== undefined && data.working().has(props.id)
  const landing = () =>
    lander() &&
    data
      .index()
      .queue.some(
        (item) =>
          item.state === 'landing' && data.index().landerConversations[item.source] === props.id,
      )
  const latest = () => Math.max(conversation()?.inputAt ?? 0, conversation()?.answerAt ?? 0)
  const facts = createMemo(() => {
    const id = props.id
    return id === undefined
      ? undefined
      : {
          id,
          kind: isUltimate() ? ('primary' as const) : ('other' as const),
          runState: data.row(id)?.runState,
          busy: busy() || data.underway(id),
          parked: data.parked(id),
        }
  })
  const state = createMemo(() => {
    const current = facts()
    return current
      ? conversationState(current, data.log(), data.timers())
      : waitingOnUser(data.log()) > 0
        ? 'waits'
        : 'idle'
  })
  const waits = createMemo(() => {
    const current = facts()
    return current &&
      isUltimate() &&
      state() === 'awaiting' &&
      conversationWait(current, data.log(), data.timers())?.on === 'agent'
      ? waitedOn(current.id, data.log().messages).map((id) => ({
          id,
          title: data.conversations().find((c) => c.id === id)?.title,
          feature: data.row(id)?.feature,
        }))
      : []
  })
  const label = createMemo(() => {
    if (waits().length)
      return `waits on ${waits().length === 1 ? 'a branch' : `${waits().length} branches`}`
    const current = facts()
    return current && data.labelOf(current)
  })
  const open = () => {
    if (!isUltimate() && props.id !== undefined) shell.switchConversation(props.id)
    else void talkToUltimate(shell)
  }
  return (
    <>
      <div
        class={cn(
          'group relative mx-2 flex h-12 items-center rounded-md transition-colors',
          shown() ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
        )}
        data-conversation={props.id}
        data-selected={shown() ? 'true' : undefined}
        data-standing={name()}
        data-ui="sidebar-row"
      >
        <Button
          aria-current={shown() ? 'true' : undefined}
          aria-label={`Open standing @${name()}${lander() ? ` #${props.id}` : ''}`}
          class="flex h-full min-w-0 flex-1 items-center justify-start gap-2.5 rounded-md pr-2 pl-2 text-left font-normal outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={open}
          size={null}
          variant={null}
        >
          <AgentMark
            name={name()}
            presence={
              state() === 'working' || landing() || (busy() && state() === 'waits')
                ? 'working'
                : state() === 'waits'
                  ? 'waiting'
                  : state() === 'awaiting'
                    ? 'awaiting'
                    : 'idle'
            }
            size="md"
          />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="flex min-w-0 items-baseline gap-1.5">
              <Show
                when={title().brand}
                fallback={
                  <span class="truncate text-[13px] leading-5 font-semibold text-foreground">
                    {title().title}
                  </span>
                }
              >
                <span
                  class="truncate font-sans text-[11.5px] leading-5 font-semibold tracking-[0.28em] text-brand"
                  data-ui="wordmark"
                >
                  ULTIMATE
                </span>
              </Show>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground/70">@{name()}</span>
            </span>
            <span class="flex w-full min-w-0 items-center gap-2 pr-5 font-mono text-[10px] leading-4 text-muted-foreground">
              <Show
                when={lander() && props.id}
                fallback={
                  <>
                    <Show
                      when={state() === 'working' && props.id}
                      fallback={
                        <span class={cn('min-w-0 truncate', stateTone[state()])} title={label()}>
                          {stateWord(state(), 0, label())}
                        </span>
                      }
                    >
                      {(id) => <StandingPhase id={id()} />}
                    </Show>
                    <Show when={latest()}>
                      {(at) => (
                        <span
                          class="ml-auto shrink-0 text-muted-foreground/80"
                          title={new Date(at()).toLocaleString()}
                        >
                          {formatAgo(at(), data.now())}
                        </span>
                      )}
                    </Show>
                  </>
                }
              >
                {(id) => <LanderState id={id()} state={state()} />}
              </Show>
            </span>
          </span>
        </Button>
        <Show when={conversation()}>{(row) => <RowMenu conversation={row()} />}</Show>
      </div>
      <Show when={waits().length > 0}>
        <WaitLines waits={waits()} />
      </Show>
    </>
  )
}

function StandingPhase(props: { id: ConversationId }) {
  const phase = useProvided(ConversationPhase, () => props.id)
  return <span class="shrink-0 text-brand">{workingWord(phase())}</span>
}

export function Seen() {
  const id = useShownId()
  const summary = useConversationSummary(id)
  const [seen, setSeen] = useSidebarState<Record<string, number>>('seen', {})
  createEffect(
    () => {
      const current = summary()
      const shown = id()
      if (
        shown === undefined ||
        !current ||
        current.parentConversationId !== undefined ||
        current.busy
      )
        return undefined
      const answerAt = current.answerAt ?? 0
      return seen()[shown] === answerAt ? undefined : { shown, answerAt }
    },
    (next) => {
      if (next)
        writingAs('app', () =>
          setSeen((previous) => ({ ...previous, [next.shown]: next.answerAt })),
        )
    },
  )
  return null
}
