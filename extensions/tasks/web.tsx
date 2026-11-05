import { ChevronRightIcon, GitBranchIcon, ListTreeIcon, MessageSquareIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ToolStatusIcon } from '@/components/ai/tool'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  cn,
  defineWebExtension,
  formatDuration,
  provide,
  RunStart,
  useAction,
  useDocOf,
  useNow,
  useTasks,
  useUltimate,
  useUiState,
} from '@/sdk'
import type { TaskGraph, TaskGraphNode } from '@/sdk'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import {
  useWorkspaceConversations as useConversations,
  useWorkspaceIndex,
} from '../workspaces/ui.tsx'
import { FeatureTag, hiddenConversationIds, useOverview } from '../conversations/ui.tsx'
import { Address, MessagesDoc } from '../messages/ui.tsx'
import { TaskChip, useTaskOf } from '../plan/ui.tsx'
import { groups, meaning } from './kinds.ts'
import type { Group, Meaning } from './kinds.ts'
import { DescribeAction, StartedAction } from './refs.ts'
import type { TaskFacts } from './refs.ts'

interface Tree {
  /** Live tasks by owner task id. */
  children: Map<number, TaskGraphNode[]>
  /** Conversation-owned running work by conversation id: the tree the Running group draws. */
  roots: Map<number, TaskGraphNode[]>
  summaries: Map<number, ConversationSummary>
  /** When each task first ran, in wall-clock milliseconds. */
  started: Record<string, number>
  /** What each task means, by task id. */
  meanings: Map<number, Meaning>
  /** Feature tags of top-level conversations. */
  features: Map<number, string>
  now: number
}

function build(
  graph: TaskGraph | undefined,
  conversations: readonly ConversationSummary[],
  concluded: number[],
) {
  const hidden = hiddenConversationIds(conversations, concluded)
  const all = Object.values(graph?.tasks ?? {}).toSorted((a, b) => a.id - b.id)
  const hiddenTasks = new Set(
    all.filter((task) => hidden.has(task.conversationId)).map((task) => task.id),
  )
  let changed = true
  while (changed) {
    changed = false
    // Task ownership can arrive before the child's summary; child runs have no task owner.
    for (const task of all) {
      if (hidden.has(task.conversationId) || (task.owner != null && hiddenTasks.has(task.owner))) {
        if (!hiddenTasks.has(task.id)) {
          hiddenTasks.add(task.id)
          changed = true
        }
        for (const id of task.conversations) {
          if (!hidden.has(id)) {
            hidden.add(id)
            changed = true
          }
        }
      }
    }
    for (const conversation of conversations) {
      if (
        conversation.parentConversationId !== undefined &&
        hidden.has(conversation.parentConversationId) &&
        !hidden.has(conversation.id)
      ) {
        hidden.add(conversation.id)
        changed = true
      }
    }
  }
  const tasks = all
    .filter((task) => !hiddenTasks.has(task.id))
    .map((task) => ({
      ...task,
      conversations: task.conversations.filter((id) => !hidden.has(id)),
    }))
  const children = new Map<number, TaskGraphNode[]>()
  const roots = new Map<number, TaskGraphNode[]>()
  for (const task of tasks) {
    const [map, key] = task.owner == null ? [roots, task.conversationId] : [children, task.owner]
    map.set(key, [...(map.get(key) ?? []), task])
  }
  // Conversations a live task owns appear under that task; the rest are top-level.
  const owned = new Set<number>(tasks.flatMap((task) => task.conversations))
  const top = [...roots.keys()].filter((id) => !owned.has(id)).toSorted((a, b) => a - b)
  return {
    tasks,
    top,
    children,
    roots,
    summaries: new Map(conversations.map((summary) => [summary.id, summary])),
  }
}

function status(task: TaskGraphNode): {
  text: ReactNode
  tone?: string
  icon: 'running' | 'pending' | 'done' | 'interrupted'
} {
  const { state } = task
  if (task.blocked)
    return {
      text: `blocked · ${task.blocked.replaceAll('_', ' ')}`,
      icon: 'interrupted',
      tone: 'text-warning',
    }
  switch (state.status) {
    case 'pending':
      return { text: 'pending', icon: 'pending' }
    case 'running':
      return { text: state.phase, icon: 'running', tone: 'text-foreground/80' }
    case 'waiting':
      return {
        text: (
          <>
            {state.phase} · waiting on{' '}
            <span className="text-foreground/70">{state.on.map((id) => `#${id}`).join(' ')}</span>
            {state.on.length > 1 && (
              <span className="text-muted-foreground"> ({state.policy})</span>
            )}
          </>
        ),
        icon: 'pending',
      }
    case 'sleeping':
      return { text: `${state.phase} · sleeping`, icon: 'pending' }
    default:
      return {
        text: `completing → ${state.outcome}`,
        icon: state.outcome === 'completed' ? 'done' : 'interrupted',
      }
  }
}

/**
 * Where a row sits in the tree: its depth, and for each ancestor level whether a sibling follows below (its rail goes
 * on); `last` when no sibling follows this row.
 */
type Place = { depth: number; rails?: readonly boolean[]; last?: boolean }

const INDENT = 14
const EDGE = 12
/** The x of the icon's centre at `depth`, where its children's lines start. */
const axis = (depth: number) => EDGE + depth * INDENT + 6

/**
 * Dashed elbows from a parent's icon to each child's, with the rails of ancestors that have more children below: the
 * shape of the task graph, kept quieter and distinct from the sidebar's solid branch rails.
 */
function Guides({ depth, rails = [], last = true }: Place) {
  if (depth === 0) return null
  const line = 'pointer-events-none absolute border-muted-foreground/35 border-dashed'
  return (
    <span aria-hidden>
      {rails.slice(0, depth - 1).map((on, level) =>
        on ? (
          <span
            className={cn(line, 'inset-y-0 border-l')}
            // oxlint-disable-next-line react/no-array-index-key -- Guide columns are addressed by tree depth.
            key={level}
            style={{ left: axis(level) }}
          />
        ) : null,
      )}
      <span
        className={cn(line, 'top-0 border-l', last ? 'h-1/2' : 'bottom-0')}
        style={{ left: axis(depth - 1) }}
      />
      <span
        className={cn(line, 'top-1/2 border-t')}
        style={{ left: axis(depth - 1), width: INDENT - 8 }}
      />
    </span>
  )
}

/** The places of a row's children, tasks then conversations, in order. */
const places = (count: number, { depth, rails = [], last = true }: Place) =>
  Array.from({ length: count }, (_, index) => ({
    depth: depth + 1,
    rails: [...rails.slice(0, depth - 1), ...(depth > 0 ? [!last] : [])],
    last: index === count - 1,
  }))

/** The root conversation: the project itself, never shown as a conversation of its own. */
const ROOT = 1

/** Ten minutes: a running task or chore older than this shows in warning colour, so a stuck one stands out. */
const LONG = 10 * 60_000

/** Raw facts for hover: kind, id, phase and marks, as the graph has them. */
const rawTitle = (task: TaskGraphNode) =>
  [
    `${task.kind} #${task.id}`,
    'phase' in task.state ? `phase ${task.state.phase}` : task.state.status,
    task.state.status,
    task.background ? 'background' : undefined,
    `owned by #${task.owner ?? task.conversationId}`,
  ]
    .filter(Boolean)
    .join(' · ')

/** Who a meaning names: a conversation by its name, the user, another project. */
function Who({ who }: { who: Meaning['who'] }) {
  if (who === undefined) return null
  return (
    <span className="min-w-0 truncate font-sans text-[0.75rem] text-foreground/90">
      <Address id={who} />
    </span>
  )
}

/** How long it has run, or when it wakes for a scheduled one; warning colour past `LONG` where that matters. */
function Clock({ task, tree, plain }: { task: TaskGraphNode; tree: Tree; plain?: boolean }) {
  const until = tree.meanings.get(task.id)?.until
  if (until !== undefined)
    return (
      <span
        className="shrink-0 text-[0.6562rem] text-muted-foreground tabular-nums"
        title={`Wakes ${new Date(until).toLocaleString()}`}
      >
        in {formatDuration(Math.max(0, until - tree.now))}
      </span>
    )
  const started = tree.started[task.id]
  if (started === undefined || task.blocked) return null
  return (
    <span
      className={cn(
        'shrink-0 text-[0.6562rem] tabular-nums',
        !plain && tree.now - started >= LONG ? 'text-warning' : 'text-muted-foreground',
      )}
      title={`Running since ${new Date(started).toLocaleString()}`}
    >
      {formatDuration(tree.now - started)}
    </span>
  )
}

export function TaskRow({ task, tree, ...place }: { task: TaskGraphNode; tree: Tree } & Place) {
  const { text, tone, icon } = status(task)
  const named = tree.meanings.get(task.id)
  const children = tree.children.get(task.id) ?? []
  const below = places(children.length + task.conversations.length, place)
  return (
    <>
      <div
        className="relative flex min-w-0 items-center gap-1.5 py-1.5 pr-3 font-mono text-[0.7188rem]"
        style={{ paddingLeft: EDGE + place.depth * INDENT }}
        title={rawTitle(task)}
      >
        <Guides {...place} />
        <ToolStatusIcon className="size-3" state={icon} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-foreground/90">
            <span className="shrink-0">{named?.text ?? task.kind}</span>
            <Who who={named?.who} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.6562rem] text-muted-foreground">
            {named?.detail && !task.blocked ? (
              <>
                {named.by !== undefined && (
                  <span className="shrink-0 text-muted-foreground">
                    <Address id={named.by} />
                  </span>
                )}
                <span className="truncate">{named.detail}</span>
              </>
            ) : (
              <span className={cn('truncate', tone)}>{text}</span>
            )}
          </span>
        </span>
        <Clock plain={named?.group === 'waiting'} task={task} tree={tree} />
        {task.abortRequested && (
          <span className="shrink-0 text-[0.6562rem] text-warning">aborting</span>
        )}
      </div>
      {children.map((child, index) => (
        <TaskRow key={child.id} task={child} tree={tree} {...below[index]} />
      ))}
      {task.conversations.map((id, index) => (
        <ConversationRow id={id} key={`c${id}`} tree={tree} {...below[children.length + index]} />
      ))}
    </>
  )
}

function ConversationRow({ id, tree, ...place }: { id: number; tree: Tree } & Place) {
  const { conversationId, switchConversation } = useUltimate()
  const summary = tree.summaries.get(id)
  const link = useTaskOf(id)
  const shown = conversationId === id
  const tasks = tree.roots.get(id) ?? []
  const below = places(tasks.length, place)
  return (
    <>
      <button
        className={cn(
          'relative flex w-full min-w-0 items-center gap-1.5 py-1.5 pr-3 text-left font-mono text-[0.7188rem] transition-colors hover:bg-accent/50',
          shown && 'bg-accent/60',
        )}
        onClick={() => switchConversation(id)}
        style={{ paddingLeft: EDGE + place.depth * INDENT }}
        title={shown ? 'Shown' : 'Show this conversation'}
        type="button"
      >
        <Guides {...place} />
        <MessageSquareIcon
          className={cn('size-3 shrink-0', shown ? 'text-brand' : 'text-muted-foreground')}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {link && <TaskChip task={link} />}
            <span
              className="truncate font-sans text-[0.75rem] text-foreground/90"
              title={summary?.title}
            >
              {summary?.title || summary?.label || 'Untitled conversation'}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.6562rem] text-muted-foreground">
            {tree.features.get(id) && <FeatureTag feature={tree.features.get(id)!} />}
            <span className="shrink-0">#{id}</span>
            {summary?.workspace && (
              <GitBranchIcon
                aria-label="Isolated checkout"
                className="size-3 shrink-0 text-muted-foreground"
              />
            )}
          </span>
        </span>
      </button>
      {tasks.map((task, index) => (
        <TaskRow key={task.id} task={task} tree={tree} {...below[index]} />
      ))}
    </>
  )
}

/** Facts a value never changes for, asked once per id: start times, what a task's input says. */
function useOnce<T>(
  ref: Parameters<typeof useAction<{ ids: number[] }, Record<string, T>>>[0],
  ids: number[],
) {
  const [known, setKnown] = useState<Record<string, T>>({})
  const missing = ids.filter((id) => !(id in known))
  const { data } = useAction(ref, { ids: missing }, { enabled: missing.length > 0 })
  useEffect(() => {
    if (data) setKnown((previous) => ({ ...previous, ...data }))
  }, [data])
  return known
}

function Heading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3 pb-1 section-label">
      {children}
      {count !== undefined && <span className="text-muted-foreground">{count}</span>}
    </div>
  )
}

/** Background chores, folded to a count; a blocked or long-running one stays out of the fold, so it is seen. */
function Background({ tasks, tree }: { tasks: TaskGraphNode[]; tree: Tree }) {
  const loud = (task: TaskGraphNode) =>
    task.blocked !== undefined ||
    (tree.started[task.id] !== undefined && tree.now - tree.started[task.id] >= LONG)
  const shown = tasks.filter(loud)
  const folded = tasks.filter((task) => !loud(task))
  return (
    <Collapsible className="group/bg">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 px-3 pt-3 pb-1 section-label hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-[state=open]/bg:rotate-90" />
        Background
        <span className="text-muted-foreground">{tasks.length}</span>
      </CollapsibleTrigger>
      {shown.map((task) => (
        <TaskRow depth={0} key={task.id} task={task} tree={tree} />
      ))}
      <CollapsibleContent>
        {folded.map((task) => (
          <TaskRow depth={0} key={task.id} task={task} tree={tree} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function TasksPanel() {
  const graph = useTasks()
  const conversations = useConversations()
  const [concluded] = useUiState<number[]>('ext.conversations.concluded', [])
  const { tasks, children, roots, summaries } = build(graph, conversations, concluded)
  const log = useDocOf(1, MessagesDoc)
  const overview = useOverview()
  const now = useNow(1000, tasks.length > 0)
  const ids = tasks.map((task) => task.id)
  const started = useOnce(StartedAction, ids)
  const facts = useOnce<TaskFacts>(DescribeAction, ids)
  const states = new Map(log?.messages.map((message) => [message.id, message.state]))
  const { queue } = useWorkspaceIndex()
  // A lander works its queue one submission after another: the one it lands now names it.
  const landing = (fact: TaskFacts | undefined) => {
    const item = queue.find((entry) => entry.source === fact?.source && entry.state === 'landing')
    return item ? { ...fact, conversation: item.conversationId } : fact
  }
  const meanings = new Map(
    tasks.map((task) => {
      const fact = task.kind === 'workspaces.lander' ? landing(facts[task.id]) : facts[task.id]
      return [task.id, meaning(task, fact, fact?.message && states.get(fact.message.id))]
    }),
  )
  const groupOf = (task: TaskGraphNode) => meanings.get(task.id)?.group ?? 'background'
  // Running work stays a tree under its conversation; the rest is listed by meaning, whoever owns it. The root's
  // running work (an automation run) is the project's: listed on its own, never under a conversation header.
  const running = new Map(
    [...roots].flatMap(([id, list]) => {
      const kept = list.filter((task) => groupOf(task) === 'running')
      return kept.length && id !== ROOT ? [[id, kept] as const] : []
    }),
  )
  const owned = new Set<number>(tasks.flatMap((task) => task.conversations))
  const top = [...running.keys()].filter((id) => !owned.has(id)).toSorted((a, b) => a - b)
  const listed = (group: Group) =>
    tasks.filter((task) => task.owner == null && groupOf(task) === group)
  const project = (roots.get(ROOT) ?? []).filter((task) => groupOf(task) === 'running')
  const tree: Tree = {
    children,
    roots: running,
    summaries,
    started,
    meanings,
    now,
    features: new Map(
      Object.entries(overview).flatMap(([id, row]) =>
        row.feature ? [[Number(id), row.feature]] : [],
      ),
    ),
  }
  const busy = tasks.filter((task) => task.state.status === 'running' && !task.blocked).length
  return (
    <div className="py-2">
      <div className="flex items-center gap-2 px-3 pb-1 section-label">
        Task graph
        <span className="ml-auto text-muted-foreground">
          {tasks.length} live{busy > 0 && ` · ${busy} running`}
        </span>
      </div>
      {groups.map(({ id, title }) => {
        if (id === 'running')
          return top.length || project.length ? (
            <section data-group={id} key={id}>
              <Heading>{title}</Heading>
              {project.map((task) => (
                <TaskRow depth={0} key={task.id} task={task} tree={tree} />
              ))}
              {top.map((conversation) => (
                <ConversationRow depth={0} id={conversation} key={conversation} tree={tree} />
              ))}
            </section>
          ) : null
        const list = listed(id)
        if (!list.length) return null
        if (id === 'background')
          return (
            <section data-group={id} key={id}>
              <Background tasks={list} tree={tree} />
            </section>
          )
        return (
          <section data-group={id} key={id}>
            <Heading count={list.length}>{title}</Heading>
            {list.map((task) => (
              <TaskRow depth={0} key={task.id} task={task} tree={tree} />
            ))}
          </section>
        )
      })}
      {tasks.length === 0 && (
        <div className="px-3 py-6 text-center font-mono text-[0.7188rem] text-muted-foreground">
          idle · no live tasks
        </div>
      )}
    </div>
  )
}

/** When run task `id` first ran, asked once per run, for the transcript's working clock. */
function useRunStart(id: number | undefined): number | undefined {
  const { data } = useAction(
    StartedAction,
    { ids: id === undefined ? [] : [id] },
    {
      enabled: id !== undefined,
    },
  )
  return id === undefined ? undefined : data?.[id]
}

export default defineWebExtension({
  provides: [provide(RunStart, useRunStart)],
  panels: [{ id: 'tasks', title: 'Tasks', icon: ListTreeIcon, component: TasksPanel, order: 1 }],
  commands: [
    {
      id: 'tasks.open',
      title: 'Show the task graph',
      run: (context) => context.openPanel('tasks'),
    },
  ],
})
