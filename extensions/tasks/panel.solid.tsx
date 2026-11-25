import type { ConversationId, TaskGraphNode } from '@earendil-works/pi-durable'
import {
  Check,
  ChevronRight,
  CircleDashed,
  GitBranch,
  LoaderCircle,
  MessageSquare,
  MinusCircle,
} from '@lucide/solid'
import { For, Show, createEffect, createMemo, createSignal, createStore, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  Provided,
  ROOT,
  api,
  cn,
  formatDuration,
  switchConversation,
  useConversationId,
  useConnection,
  useConversations,
  useDocOf,
  useNow,
  useTasks,
  useUiState,
} from '@/sdk/solid'
import type { ActionRef } from '../../shared/extension-api.ts'
import { OverviewDoc } from '../conversations/refs.ts'
import {
  ConversationTaskChip,
  FeatureTag,
  hiddenConversationIds,
} from '../conversations/ui.solid.tsx'
import { MessagesDoc } from '../messages/refs.ts'
import { Address } from '../messages/ui.solid.tsx'
import { WorkspacesDoc } from '../workspaces/refs.ts'
import { groups, meaning } from './kinds.ts'
import { DescribeAction, StartedAction } from './refs.ts'
import { buildVisibleTaskTree, places, rawTitle, status, top } from './tree.ts'
import type { Place, TaskIcon } from './tree.ts'

const LONG_RUNNING_WARNING_MS = 10 * 60_000

function useTaskFacts<T>(
  ref: ActionRef<{ ids: number[] }, Record<string, T>>,
  ids: Accessor<number[]>,
) {
  const [known, setKnown] = createStore<Record<string, T | undefined>>({})
  const connection = useConnection()
  const [rejections, setRejections] = createSignal(0)
  const requested = new Set<number>()
  const failedOn = new Map<number, number>()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  createEffect(
    () => {
      const { status: link, since } = connection()
      return { all: ids(), open: link === 'open', since, rejections: rejections() }
    },
    ({ all, open, since }) => {
      if (!open) return
      const missing = all.filter((id) => !requested.has(id) && failedOn.get(id) !== since)
      if (!missing.length) return
      for (const id of missing) requested.add(id)
      const askedOn = since
      void api
        .action(ref, { ids: missing }, { conversationId: ROOT, signal: controller.signal })
        .then(
          (data) =>
            setKnown((draft) => {
              Object.assign(draft, data)
            }),
          (error: unknown) => {
            if (controller.signal.aborted) return
            for (const id of missing) {
              requested.delete(id)
              failedOn.set(id, askedOn)
            }
            setRejections((count) => count + 1)
            console.warn('Task graph:', error)
          },
        )
    },
  )
  return known
}

function useTaskTree() {
  const graph = useTasks()
  const conversations = useConversations()
  const [concluded] = useUiState<number[]>('ext.conversations.concluded', [])
  const workspaces = useDocOf(() => ROOT, WorkspacesDoc)
  const overview = useDocOf(() => ROOT, OverviewDoc)
  const log = useDocOf(() => ROOT, MessagesDoc)
  const hidden = createMemo(() => hiddenConversationIds(conversations(), concluded()))
  const tree = createMemo(() => buildVisibleTaskTree(graph(), conversations(), hidden()))
  const tasks = () => tree().tasks
  const now = useNow(1000, () => tasks().length > 0)
  const started = useTaskFacts(StartedAction, () =>
    tasks()
      .filter((task) => task.state.status !== 'pending')
      .map((task) => task.id),
  )
  const facts = useTaskFacts(DescribeAction, () => tasks().map((task) => task.id))
  const messageStates = createMemo(
    () => new Map(log()?.messages.map((message) => [message.id, message.state])),
  )
  const meanings = createMemo(
    () =>
      new Map(
        tasks().map((task) => {
          let fact = facts[task.id]
          if (task.kind === 'workspaces.lander') {
            const landing = workspaces()?.queue.find(
              (item) => item.source === fact?.source && item.state === 'landing',
            )
            if (landing) fact = { ...fact, conversation: landing.conversationId }
          }
          return [
            task.id,
            meaning(task, fact, fact?.message && messageStates().get(fact.message.id)),
          ]
        }),
      ),
  )
  const meaningOf = (task: TaskGraphNode) => meanings().get(task.id)
  const runningIn = (id: ConversationId) =>
    (tree().roots.get(id) ?? []).filter((task) => meaningOf(task)?.group === 'running')
  return { tree, tasks, now, started, workspaces, overview, meaningOf, runningIn }
}

type TaskTree = ReturnType<typeof useTaskTree>

const icons = {
  running: [LoaderCircle, 'animate-spin text-brand'],
  pending: [CircleDashed, 'text-muted-foreground'],
  done: [Check, 'text-success'],
  interrupted: [MinusCircle, 'text-warning'],
} as const

function StatusIcon(props: { state: TaskIcon }) {
  const appearance = () => icons[props.state]
  return (
    <Show when={appearance()[0]} keyed>
      {(Icon) => (
        <Icon aria-label={props.state} class={cn('size-3 shrink-0', appearance()[1])}>
          <title>{props.state}</title>
        </Icon>
      )}
    </Show>
  )
}

function Guides(props: { place: Place }) {
  return (
    <For each={props.place} keyed={false}>
      {(guide) => (
        <span aria-hidden="true" class="pointer-events-none relative w-3.5 shrink-0">
          <Show when={guide() !== 'blank'}>
            <span
              data-rail={guide()}
              class="absolute inset-y-0 left-1.5 border-l border-dashed border-muted-foreground/35 data-[rail=last]:h-1/2"
            />
            <Show when={guide() !== 'rail'}>
              <span
                data-elbow
                class="absolute top-1/2 left-1.5 w-1.5 border-t border-dashed border-muted-foreground/35"
              />
            </Show>
          </Show>
        </span>
      )}
    </For>
  )
}

function Clock(props: { task: TaskGraphNode; tree: TaskTree }) {
  const clock = createMemo(() => {
    const task = props.task
    const named = props.tree.meaningOf(task)
    if (named?.until !== undefined) return { at: named.until, wakes: true, warn: false }
    const started = props.tree.started[task.id]
    if (started === undefined || task.blocked) return undefined
    return { at: started, wakes: false, warn: named?.group !== 'waiting' }
  })
  return (
    <Show when={clock()}>
      {(time) => {
        const elapsed = () => props.tree.now() - time().at
        return (
          <span
            class={cn(
              'shrink-0 text-[10.5px] tabular-nums',
              time().warn && elapsed() >= LONG_RUNNING_WARNING_MS
                ? 'text-warning'
                : 'text-muted-foreground/70',
            )}
            title={`${time().wakes ? 'Wakes' : 'Running since'} ${new Date(time().at).toLocaleString()}`}
          >
            {time().wakes
              ? `in ${formatDuration(Math.max(0, -elapsed()))}`
              : formatDuration(elapsed())}
          </span>
        )
      }}
    </Show>
  )
}

function TaskRow(props: { task: TaskGraphNode; tree: TaskTree; place: Place }) {
  const state = createMemo(() => status(props.task))
  const named = () => props.tree.meaningOf(props.task)
  const children = () => props.tree.tree().children.get(props.task.id) ?? []
  const below = createMemo(() =>
    places(children().length + props.task.conversations.length, props.place),
  )
  return (
    <>
      <div class="flex min-w-0 pl-3" data-graph-task={props.task.id} title={rawTitle(props.task)}>
        <Guides place={props.place} />
        <div class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-3 font-mono text-[11.5px]">
          <StatusIcon state={state().icon} />
          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-1.5 overflow-hidden text-foreground/90">
              <span class="shrink-0">{named()?.text ?? props.task.kind}</span>
              <Show when={named()?.who}>
                {(who) => (
                  <span class="min-w-0 truncate font-sans text-[12px] text-foreground/90">
                    <Address id={who()} />
                  </span>
                )}
              </Show>
            </span>
            <span class="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground/60">
              <Show
                when={!props.task.blocked && named()?.detail}
                fallback={
                  <span class={cn('truncate', state().tone)}>
                    {state().text}
                    <span class="text-foreground/70">{state().on}</span>
                    {state().policy}
                  </span>
                }
              >
                {(detail) => (
                  <>
                    <Show when={named()?.by}>
                      {(by) => (
                        <span class="shrink-0 text-muted-foreground/80">
                          <Address id={by()} />
                        </span>
                      )}
                    </Show>
                    <span class="truncate">{detail()}</span>
                  </>
                )}
              </Show>
            </span>
          </span>
          <Clock task={props.task} tree={props.tree} />
          <Show when={props.task.abortRequested}>
            <span class="shrink-0 text-[10.5px] text-warning">aborting</span>
          </Show>
        </div>
      </div>
      <For each={children()} keyed={(task) => task.id}>
        {(task, index) => <TaskRow task={task()} tree={props.tree} place={below()[index()]} />}
      </For>
      <For each={props.task.conversations}>
        {(id, index) => (
          <ConversationRow id={id} tree={props.tree} place={below()[children().length + index()]} />
        )}
      </For>
    </>
  )
}

function ConversationRow(props: { id: ConversationId; tree: TaskTree; place: Place }) {
  const current = useConversationId()
  const shown = () => current() === props.id
  const summary = () => props.tree.tree().summaries.get(props.id)
  const title = () => summary()?.title || summary()?.label || 'Untitled conversation'
  const feature = () => props.tree.overview()?.conversations[props.id]?.feature
  const tasks = createMemo(() => props.tree.runningIn(props.id))
  const below = createMemo(() => places(tasks().length, props.place))
  return (
    <>
      <div
        class="flex min-w-0 items-stretch pl-3 pr-3 transition-colors hover:bg-accent/50 data-current:bg-accent/60"
        data-current={shown() || undefined}
      >
        <Guides place={props.place} />
        <Button
          aria-current={shown() ? 'true' : undefined}
          aria-label={`Open conversation #${props.id}: ${title()}`}
          class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left font-mono text-[11.5px] focus-visible:outline-1 focus-visible:outline-ring"
          onClick={() => switchConversation(props.id)}
          size={null}
          variant={null}
        >
          <MessageSquare
            class={cn('size-3 shrink-0', shown() ? 'text-brand' : 'text-muted-foreground')}
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-sans text-[12px] text-foreground/90" title={title()}>
              {title()}
            </span>
            <span class="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground/60">
              <Show when={feature()}>{(tag) => <FeatureTag feature={tag()} />}</Show>
              <span class="shrink-0">#{props.id}</span>
              <Show when={props.tree.workspaces()?.items[props.id]}>
                <GitBranch
                  aria-label="Isolated checkout"
                  class="size-3 shrink-0 text-muted-foreground"
                >
                  <title>Isolated checkout</title>
                </GitBranch>
              </Show>
            </span>
          </span>
        </Button>
        <span class="contents [&>button]:ml-1.5 [&>button]:self-center">
          <Provided
            input={{ conversation: props.id, on: `task row #${props.id}` }}
            last
            point={ConversationTaskChip}
          />
        </span>
      </div>
      <For each={tasks()} keyed={(task) => task.id}>
        {(task, index) => <TaskRow task={task()} tree={props.tree} place={below()[index()]} />}
      </For>
    </>
  )
}

function TaskRows(props: { tasks: TaskGraphNode[]; tree: TaskTree }) {
  return (
    <For each={props.tasks} keyed={(task) => task.id}>
      {(task) => <TaskRow task={task()} tree={props.tree} place={top} />}
    </For>
  )
}

function Background(props: { tasks: TaskGraphNode[]; tree: TaskTree }) {
  const [open, setOpen] = createSignal(false)
  const sections = createMemo(() => {
    const attention: TaskGraphNode[] = []
    const folded: TaskGraphNode[] = []
    for (const task of props.tasks) {
      const started = props.tree.started[task.id]
      const urgent =
        task.blocked !== undefined ||
        (started !== undefined && props.tree.now() - started >= LONG_RUNNING_WARNING_MS)
      if (urgent) attention.push(task)
      else folded.push(task)
    }
    return { attention, folded }
  })
  return (
    <Collapsible bind={[open, setOpen]}>
      <CollapsibleTrigger
        aria-label="Background tasks"
        class="group/background flex w-full items-center gap-1.5 px-3 pt-3 pb-1 section-label hover:text-foreground"
      >
        <ChevronRight class="size-3 transition-transform group-data-open/background:rotate-90" />
        Background <span class="text-muted-foreground/60">{props.tasks.length}</span>
      </CollapsibleTrigger>
      <TaskRows tasks={sections().attention} tree={props.tree} />
      <CollapsibleContent>
        <TaskRows tasks={sections().folded} tree={props.tree} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function TasksPanel() {
  const tree = useTaskTree()
  const busy = () =>
    tree.tasks().filter((task) => task.state.status === 'running' && !task.blocked).length
  const project = createMemo(() => tree.runningIn(ROOT))
  const conversations = createMemo(() =>
    tree.tree().top.filter((id) => id !== ROOT && tree.runningIn(id).length > 0),
  )
  const listed = createMemo(() =>
    Map.groupBy(
      tree.tasks().filter((task) => task.owner == null),
      (task) => tree.meaningOf(task)?.group ?? 'background',
    ),
  )
  return (
    <div class="py-2" data-task-graph>
      <div class="flex items-center gap-2 px-3 pb-1 section-label">
        Task graph
        <span class="ml-auto text-muted-foreground/70">
          {tree.tasks().length} live{busy() > 0 && ` · ${busy()} running`}
        </span>
      </div>
      <Show when={project().length || conversations().length}>
        <section data-group="running">
          <h3 class="px-3 pt-3 pb-1 section-label">Running</h3>
          <TaskRows tasks={project()} tree={tree} />
          <For each={conversations()}>
            {(id) => <ConversationRow id={id} tree={tree} place={top} />}
          </For>
        </section>
      </Show>
      <For each={groups.filter((group) => group.id !== 'running')}>
        {(group) => (
          <Show when={listed().get(group.id)}>
            {(list) => (
              <section data-group={group.id}>
                {group.id === 'background' ? (
                  <Background tasks={list()} tree={tree} />
                ) : (
                  <>
                    <h3 class="flex items-center gap-2 px-3 pt-3 pb-1 section-label">
                      {group.title} <span class="text-muted-foreground/60">{list().length}</span>
                    </h3>
                    <TaskRows tasks={list()} tree={tree} />
                  </>
                )}
              </section>
            )}
          </Show>
        )}
      </For>
      <Show when={tree.tasks().length === 0}>
        <div class="px-3 py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
          idle · no live tasks
        </div>
      </Show>
    </div>
  )
}
