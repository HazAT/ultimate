/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleDotDashed,
  CircleEllipsis,
  CircleSlash,
  GitBranch,
  Link,
  SquareArrowOutUpRight,
} from '@lucide/solid'
import { dynamic } from '@solidjs/web'
import type { JSX } from '@solidjs/web'
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import { Markdown, MentionText } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible.solid.tsx'
import {
  cn,
  formatTime,
  switchConversation,
  useAction,
  useConversationSummary,
  useCopy,
  useDocOf,
} from '@/sdk/solid'
import { InfoAction, stateLabel, useWorkspaceIndex } from '../workspaces/ui.solid.tsx'
import { criteriaOf, sectionsOf, verbatim } from './body.ts'
import { confirmed, criteriaCounts, criteriaOfBody, finished, number } from './progress.ts'
import { ProgressDoc } from './refs.ts'
import type { Epic, Estimate, Plan, Task } from './refs.ts'

export type DeepLinkFocus = { key: string } | undefined

const statuses = {
  backlog: { icon: CircleDashed, tone: 'text-muted-foreground/70' },
  planning: { icon: CircleDashed, tone: 'text-muted-foreground' },
  todo: { icon: Circle, tone: 'text-muted-foreground' },
  in_progress: { icon: CircleDot, tone: 'border-brand/40 text-brand' },
  in_review: { icon: CircleEllipsis, tone: 'border-warning/40 text-warning' },
  done: { icon: CircleCheck, tone: 'border-success/40 text-success' },
  blocked: { icon: CircleAlert, tone: 'border-error/40 text-error' },
  canceled: { icon: CircleSlash, tone: 'text-muted-foreground/60 line-through' },
}
const statusOf = (status: string) => statuses[status as keyof typeof statuses] ?? statuses.todo

function StatusIcon(props: { status: string }) {
  const status = createMemo(() => statusOf(props.status))
  const Icon = dynamic(() => status().icon)
  return (
    <Icon aria-label={props.status} class={cn('size-3.5 shrink-0', status().tone)}>
      <title>{props.status}</title>
    </Icon>
  )
}

export function Tag(props: { children: JSX.Element; class?: string }) {
  return (
    <span
      class={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground',
        props.class,
      )}
    >
      {props.children}
    </span>
  )
}

function StatusChip(props: { status: string }) {
  return <Tag class={statusOf(props.status).tone}>{props.status.replace('_', ' ')}</Tag>
}

export function LiteralPlanText(props: { children: string; class?: string }) {
  return <Markdown class={props.class} text={verbatim(props.children)} />
}

type Checks = { epic: Epic; coordinator: ConversationId; estimates: Record<string, Estimate> }

function EstimateMark(props: { estimate: Estimate }) {
  const done = createMemo(() => props.estimate.state === 'looks_done')
  const label = () => (done() ? 'looks done' : 'in progress')
  const Icon = dynamic(() => (done() ? CircleDotDashed : CircleDashed))
  return (
    <Icon
      aria-label={label()}
      class={cn('size-3.5 shrink-0', done() ? 'text-success/60' : 'text-brand/60')}
    >
      <title>{label()}</title>
    </Icon>
  )
}

function Criteria(props: { items: string[]; checks: Checks }) {
  return (
    <ol class="space-y-1">
      <For each={props.items} keyed={false}>
        {(item, index) => {
          const met = () => confirmed(props.checks.epic, index + 1)
          const estimate = () =>
            !met() && Object.hasOwn(props.checks.estimates, item())
              ? props.checks.estimates[item()]
              : undefined
          return (
            <li class="flex min-w-0 gap-1.5" data-criterion={index + 1}>
              <span class="pt-0.5">
                <Show when={estimate()} fallback={<StatusIcon status={met() ? 'done' : 'todo'} />}>
                  {(value) => <EstimateMark estimate={value()} />}
                </Show>
              </span>
              <span class="min-w-0 flex-1">
                <LiteralPlanText class="text-foreground/90">{item()}</LiteralPlanText>
                <Show when={estimate()}>
                  {(value) => (
                    <span
                      class="block font-mono text-[10.5px] text-muted-foreground/70"
                      title="Estimated from the coordinator's recent work, not confirmed"
                    >
                      ~ {value().state === 'looks_done' ? 'looks done' : 'in progress'}
                      <Show when={value().at !== undefined}>
                        {' · '}
                        <MentionText text={`#${props.checks.coordinator}/${value().at}`} />
                      </Show>
                    </span>
                  )}
                </Show>
              </span>
            </li>
          )
        }}
      </For>
    </ol>
  )
}

function EpicBody(props: { body: string; checks: Checks; criteria: boolean }) {
  const sections = createMemo(() => sectionsOf(props.body))
  return (
    <Show when={sections()} fallback={<LiteralPlanText>{props.body}</LiteralPlanText>}>
      {(parts) => (
        <div class="space-y-2.5">
          <For each={parts()} keyed={false}>
            {(section) => {
              const acceptance = () => section().label === 'Acceptance criteria'
              const items = createMemo(() =>
                acceptance() ? criteriaOf(section().text) : undefined,
              )
              return (
                <Show when={!(props.criteria && acceptance())}>
                  <div>
                    <Show when={section().label}>
                      <div class="pb-0.5 section-label">{section().label}</div>
                    </Show>
                    <Show
                      when={items()}
                      fallback={
                        section().text && <LiteralPlanText>{section().text}</LiteralPlanText>
                      }
                    >
                      {(list) => <Criteria checks={props.checks} items={list()} />}
                    </Show>
                  </div>
                </Show>
              )
            }}
          </For>
        </div>
      )}
    </Show>
  )
}

function Note(props: { note: Task['notes'][number]; clamp?: boolean }) {
  return (
    <p class="flex min-w-0 gap-1.5 font-sans text-[12px] leading-snug text-muted-foreground">
      <span
        class="shrink-0 pt-px font-mono text-[10.5px] text-muted-foreground/60 tabular-nums"
        title={props.note.at}
      >
        {formatTime(props.note.at)}
      </span>
      <span class={cn('min-w-0 break-words whitespace-pre-wrap', props.clamp && 'line-clamp-2')}>
        {props.note.text}
      </span>
    </p>
  )
}

function IsolateRow(props: { child: ConversationId; coordinator: ConversationId }) {
  const child = useConversationSummary(() => props.child)
  const parent = useConversationSummary(() => child()?.parentConversationId ?? props.coordinator)
  const { data } = useAction(
    InfoAction,
    {
      get id() {
        return props.child
      },
    },
    { on: () => [child()?.busy, parent()?.busy], focus: true },
  )
  return (
    <Show when={data()}>
      {(isolate) => (
        <div class="font-mono text-[11px] text-muted-foreground">
          <div class="flex h-6 min-w-0 items-center gap-1.5">
            <GitBranch class="size-3 shrink-0" />
            <span class="min-w-0 truncate" title={`${isolate().branch}\n${isolate().path}`}>
              {isolate().branch}
            </span>
            <Tag
              class={
                isolate().state === 'removed'
                  ? 'text-muted-foreground/70'
                  : isolate().landed
                    ? 'border-success/40 text-success'
                    : 'border-brand/40 text-brand'
              }
            >
              {isolate().state === 'ready' && isolate().landed
                ? `Landed ${isolate().landed?.slice(0, 7)}`
                : stateLabel(isolate())}
            </Tag>
            <Show when={isolate().ahead !== null}>
              <span
                class="shrink-0 text-[10.5px] text-muted-foreground/80"
                title={`${isolate().ahead} commit${isolate().ahead === 1 ? '' : 's'} on the branch that the parent checkout does not have`}
              >
                ↑{isolate().ahead}
              </span>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}

function ChildLink(props: { id: ConversationId; task: string }) {
  const child = useConversationSummary(() => props.id)
  return (
    <Button
      aria-label={`Open linked branch ${props.id} for task ${props.task}`}
      class="h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => switchConversation(props.id)}
      size="xs"
      title={child()?.title ?? `Show conversation #${props.id}`}
      variant="ghost"
    >
      <Show when={child()?.busy}>
        <span class="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
      </Show>
      <SquareArrowOutUpRight class="size-3" />
      open #{props.id}
    </Button>
  )
}

function useScrollTo(focus: Accessor<DeepLinkFocus>, reveal?: () => void) {
  let element: HTMLElement | undefined
  createEffect(focus, (target) => {
    if (!target) return undefined
    reveal?.()
    const frame = requestAnimationFrame(() => element?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  })
  return (value: HTMLElement) => {
    element = value
  }
}

function CopyLink(props: { coordinator: ConversationId; id: string; class?: string }) {
  const { copied, copy } = useCopy()
  return (
    <Button
      aria-label={`Copy plan link #${props.coordinator}/${props.id}`}
      class={cn(
        'h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100',
        copied() && 'opacity-100',
        props.class,
      )}
      onClick={() => {
        const url = new URL(location.origin)
        url.searchParams.set('conversation', String(props.coordinator))
        url.searchParams.set('task', props.id)
        return copy(url.href)
      }}
      size="xs"
      title={`Copy a link to ${props.id}`}
      variant="ghost"
    >
      <Show when={copied()} fallback={<Link class="size-3" />}>
        <Check class="size-3" />
      </Show>
      {copied() ? 'copied' : 'link'}
    </Button>
  )
}

type PlanRows = {
  tasks: Map<string, Task>
  coordinator: ConversationId
  focus: DeepLinkFocus
  own?: string
}

function TaskRow(props: PlanRows & { task: Task }) {
  const task = () => props.task
  const [open, setOpen] = createSignal(false)
  const bind = [open, setOpen] as const
  const row = useScrollTo(
    () => (props.focus?.key === task().key ? props.focus : undefined),
    () => setOpen(true),
  )
  const child = useConversationSummary(() => task().child)
  const workspaces = useWorkspaceIndex()
  const isolatedChild = createMemo(() => {
    const id = child()?.id
    return id !== undefined && workspaces().items[String(id)] ? id : undefined
  })
  const last = () => task().notes.at(-1)
  return (
    <Collapsible
      bind={bind}
      class={cn(
        'group/row border-t border-border/50 first:border-t-0',
        props.own === task().key && 'bg-brand/5 shadow-[inset_2px_0_0_var(--color-brand)]',
      )}
      data-plan-task={task().key}
      ref={row}
    >
      <CollapsibleTrigger
        aria-label={`Show plan task ${task().key} for #${props.coordinator}`}
        class="group/task flex h-7 w-full min-w-0 items-center gap-1.5 px-3 text-left hover:bg-accent/40"
      >
        <StatusIcon status={task().status} />
        <span class="shrink-0 font-mono text-[11px] text-muted-foreground">{task().key}</span>
        <span
          class={cn(
            'min-w-0 flex-1 truncate text-[12.5px] text-foreground/90',
            task().status === 'canceled' && 'text-muted-foreground line-through',
          )}
          title={task().title}
        >
          {task().title}
        </span>
        <ChevronRight class="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-open/task:rotate-90" />
      </CollapsibleTrigger>
      <div class="space-y-0.5 pr-3 pb-1.5 pl-8">
        <div class="flex h-5 min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <StatusChip status={task().status} />
          <Tag>{task().role}</Tag>
          <Show when={task().deps.length > 0}>
            <span class="min-w-0 truncate">
              after{' '}
              <For each={task().deps}>
                {(dep, index) => (
                  <span>
                    {index() > 0 && ', '}
                    <span
                      class={cn(props.tasks.get(dep)?.status === 'done' && 'text-success')}
                      title={props.tasks.get(dep)?.title}
                    >
                      {dep}
                    </span>
                  </span>
                )}
              </For>
            </span>
          </Show>
          <CopyLink
            class={cn(task().child === undefined && 'ml-auto')}
            coordinator={props.coordinator}
            id={task().key}
          />
          <Show when={task().child}>{(id) => <ChildLink id={id()} task={task().key} />}</Show>
        </div>
        <Show when={isolatedChild()} keyed>
          {(id) => <IsolateRow child={id} coordinator={props.coordinator} />}
        </Show>
        <Show when={task().verdict}>
          {(verdict) => (
            <div class="rounded-md border border-border/70 bg-card/50 px-3 py-2 text-[12.5px]">
              <div class="pb-1 section-label">Verdict</div>
              <LiteralPlanText>{verdict()}</LiteralPlanText>
            </div>
          )}
        </Show>
        <Show
          when={open()}
          fallback={
            <Show when={last()}>
              {(note) => (
                <div class="flex min-w-0 items-start gap-1.5">
                  <div class="min-w-0 flex-1">
                    <Note clamp note={note()} />
                  </div>
                  <Show when={task().notes.length > 1}>
                    <Button
                      aria-label={`Show all notes for ${task().key} in #${props.coordinator}`}
                      class="shrink-0 font-mono text-[10.5px] font-normal text-muted-foreground/70 hover:text-foreground"
                      onClick={() => setOpen(true)}
                      size={null}
                      variant={null}
                    >
                      {task().notes.length} notes
                    </Button>
                  </Show>
                </div>
              )}
            </Show>
          }
        >
          <div class="space-y-2 pt-1">
            <div class="text-[12.5px] text-foreground/90">
              <LiteralPlanText>{task().description}</LiteralPlanText>
            </div>
            <Show when={task().notes.length > 0}>
              <div class="space-y-1">
                <div class="section-label">Notes</div>
                <For each={task().notes} keyed={false}>
                  {(note) => <Note note={note()} />}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Collapsible>
  )
}

function EpicCard(props: PlanRows & { epic: Epic }) {
  const epic = () => props.epic
  const list = createMemo(() => Object.values(epic().tasks))
  const done = () => finished(epic().tasks)
  const approved = () => epic().verdict?.trimStart().startsWith('APPROVED')
  const criteria = createMemo(() => (list().length === 0 ? criteriaOfBody(epic().body) : undefined))
  const estimates = useEstimates(
    () => props.coordinator,
    () => epic().key,
  )
  const checks = {
    get epic() {
      return epic()
    },
    get coordinator() {
      return props.coordinator
    },
    get estimates() {
      return estimates()
    },
  }
  const counts = createMemo(() => criteriaCounts(epic(), estimates()))
  const section = useScrollTo(() => (props.focus?.key === epic().key ? props.focus : undefined))
  return (
    <section
      class="border-t border-border/70 first:border-t-0"
      data-plan-epic={epic().key}
      ref={section}
    >
      <Collapsible class="group/epic">
        <CollapsibleTrigger
          aria-label={`Show epic details ${epic().key} for #${props.coordinator}`}
          class="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left hover:bg-accent/40"
        >
          <ChevronRight class="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-open/epic:rotate-90" />
          <span class="shrink-0 font-mono text-[11px] text-muted-foreground">{epic().key}</span>
          <span class="min-w-0 flex-1 truncate text-[13px] font-medium" title={epic().title}>
            {epic().title}
          </span>
          <StatusChip status={epic().status} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div class="mx-3 mb-2 rounded-md border border-border/70 bg-card/50 px-3 py-2 text-[12.5px]">
            <EpicBody body={epic().body} checks={checks} criteria={!!criteria()} />
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Show when={epic().verdict}>
        {(verdict) => (
          <div
            class={cn(
              'mx-3 mb-2 rounded-md border px-3 py-2 text-[12.5px]',
              approved() ? 'border-success/40 bg-success/5' : 'border-border/70 bg-card/50',
            )}
          >
            <div
              class={cn(
                'pb-1 section-label',
                approved() ? 'text-success' : 'text-muted-foreground/80',
              )}
            >
              Verdict
            </div>
            <LiteralPlanText>{verdict()}</LiteralPlanText>
          </div>
        )}
      </Show>
      <Show
        when={list().length > 0 || criteria()}
        fallback={
          <p class="px-3 pb-2 font-sans text-[12px] text-muted-foreground/70">
            Worked directly by the coordinator.
          </p>
        }
      >
        <div class="flex items-center px-3 pb-1 section-label">
          {criteria() ? 'Acceptance criteria' : 'Tasks'}
          <span class="ml-auto">
            <Show when={criteria()} fallback={`${done()}/${list().length} done`}>
              <CriteriaCount counts={counts()} />
            </Show>
          </span>
        </div>
      </Show>
      <Show when={criteria()}>
        {(items) => (
          <div class="px-3 pb-2 text-[12.5px]">
            <Criteria checks={checks} items={items()} />
          </div>
        )}
      </Show>
      <For each={list()} keyed={(task) => task.key}>
        {(task) => (
          <TaskRow
            coordinator={props.coordinator}
            focus={props.focus}
            own={props.own}
            task={task()}
            tasks={props.tasks}
          />
        )}
      </For>
    </section>
  )
}

export function PlanBody(props: Omit<PlanRows, 'tasks'> & { plan: Plan }) {
  const epics = createMemo(() =>
    Object.values(props.plan.epics).toSorted((a, b) => number(b.key) - number(a.key)),
  )
  const open = createMemo(() => epics().filter((epic) => epic.status !== 'done'))
  const done = createMemo(() => epics().filter((epic) => epic.status === 'done'))
  const tasks = createMemo(
    () =>
      new Map(
        epics()
          .flatMap((epic) => Object.values(epic.tasks))
          .map((task) => [task.key, task]),
      ),
  )
  const card = (epic: Accessor<Epic>) => (
    <EpicCard
      coordinator={props.coordinator}
      epic={epic()}
      focus={props.focus}
      own={props.own}
      tasks={tasks()}
    />
  )
  return (
    <Show
      when={epics().length > 0}
      fallback={
        <p class="px-3 py-2 font-sans text-[12px] text-muted-foreground/70">No epics yet.</p>
      }
    >
      <For each={open()} keyed={(epic) => epic.key}>
        {card}
      </For>
      <Show when={done().length > 0}>
        <Collapsible
          class="group/done border-t border-border/70 first:border-t-0"
          defaultOpen={
            open().length === 0 ||
            done().some((epic) => props.focus?.key.split('.')[0] === epic.key)
          }
        >
          <CollapsibleTrigger
            aria-label={`Show completed epics in #${props.coordinator}`}
            class="flex w-full items-center gap-1.5 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground hover:bg-accent/40"
          >
            <ChevronRight class="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-open/done:rotate-90" />
            {done().length} done epic{done().length === 1 ? '' : 's'}
          </CollapsibleTrigger>
          <CollapsibleContent>
            {
              <For each={done()} keyed={(epic) => epic.key}>
                {card}
              </For>
            }
          </CollapsibleContent>
        </Collapsible>
      </Show>
    </Show>
  )
}

const noEstimates: Record<string, Estimate> = {}

export function useEstimates(coordinator: Accessor<ConversationId>, key: Accessor<string>) {
  const progress = useDocOf(coordinator, ProgressDoc)
  return () => progress()?.epics[key()]?.estimates ?? noEstimates
}

export function CriteriaCount(props: { counts: ReturnType<typeof criteriaCounts> }) {
  return (
    <span
      class="tabular-nums"
      title={`${props.counts.confirmed} confirmed by the coordinator, ${props.counts.estimated} estimated from the work, of ${props.counts.total}`}
    >
      <Show when={props.counts.confirmed > 0}>
        <span class="text-success">{props.counts.confirmed}✓ </span>
      </Show>
      {props.counts.confirmed + props.counts.estimated}/{props.counts.total}
    </span>
  )
}
