import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  GitBranchIcon,
  LinkIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from 'lucide-react'
import type { ReactNode, SyntheticEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageResponse } from '@/components/ai/message'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { store } from '@/sdk/client'
import {
  cn,
  defineWebExtension,
  errorMessage,
  formatTime,
  provide,
  useAction,
  useConversations,
  useDoc,
  useDocOf,
  useToolDuration,
  useUiState,
  useUltimate,
} from '@/sdk'
import type { ConversationSummary, ToolCallView } from '@/sdk'
import { ConversationEpic, ConversationTask } from '../conversations/ui.tsx'
import { InfoAction, stateLabel, useWorkspaces } from '../workspaces/ui.tsx'
import { criteriaOf, sectionsOf, verbatim } from './body.tsx'
import { criteriaOfBody, finished, number, pillOf, progressLabel } from './progress.tsx'
import { PlanDoc } from './refs.ts'
import type { Epic, Plan, Task, TaskLink } from './refs.ts'
import { StatusIcon, TaskChip, statusOf, useOpenTask, useTaskOf } from './ui.tsx'

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border border-border/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

function StatusChip({ status }: { status: string }) {
  return <Tag className={statusOf(status).tone}>{status.replace('_', ' ')}</Tag>
}

const time = (at: string) => formatTime(at)

/**
 * Coordinator-written text as written: `<tags>` stay text, single newlines break, and nothing is completed as if it
 * were still streaming (Streamdown would close a lone `*`).
 */
function PlanText({ children, className }: { children: string; className?: string }) {
  return (
    <MessageResponse className={className} parseIncompleteMarkdown={false}>
      {verbatim(children)}
    </MessageResponse>
  )
}

/** Acceptance criteria as a quiet checklist: open while the epic is, met once it is done. */
function Criteria({ items, met }: { items: string[]; met: boolean }) {
  return (
    <ol className="space-y-1">
      {items.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Criteria are numbered by position.
        <li className="flex min-w-0 gap-1.5" key={index}>
          <span className="pt-0.5">
            <StatusIcon status={met ? 'done' : 'todo'} />
          </span>
          <PlanText className="min-w-0 flex-1 text-foreground/90">{item}</PlanText>
        </li>
      ))}
    </ol>
  )
}

/**
 * An epic's plan: each known section (Request, Scope, Risks…) under a small label, acceptance criteria as a checklist
 * unless they are shown in place of tasks; a body without those labels renders as Markdown.
 */
function EpicBody({ body, met, criteria }: { body: string; met: boolean; criteria: boolean }) {
  const sections = sectionsOf(body)
  if (!sections) return <PlanText>{body}</PlanText>
  return (
    <div className="space-y-2.5">
      {sections.map((section, index) => {
        if (criteria && section.label === 'Acceptance criteria') return null
        const items = section.label === 'Acceptance criteria' && criteriaOf(section.text)
        return (
          // oxlint-disable-next-line react/no-array-index-key -- Sections are positional; labels can repeat.
          <div key={index}>
            {section.label && <div className="pb-0.5 section-label">{section.label}</div>}
            {items ? (
              <Criteria items={items} met={met} />
            ) : (
              section.text && <PlanText>{section.text}</PlanText>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Note({ note, clamp }: { note: Task['notes'][number]; clamp?: boolean }) {
  return (
    <p className="flex min-w-0 gap-1.5 font-sans text-[12px] leading-snug text-muted-foreground">
      <span
        className="shrink-0 pt-px font-mono text-[10.5px] text-muted-foreground/60 tabular-nums"
        title={note.at}
      >
        {time(note.at)}
      </span>
      <span className={cn('min-w-0 break-words whitespace-pre-wrap', clamp && 'line-clamp-2')}>
        {note.text}
      </span>
    </p>
  )
}

/**
 * The linked child's workspace: branch, state and commits ahead. Refetched when the child or its parent settles,
 * since either may have committed or landed.
 */
function IsolateRow({ child, parent }: { child: ConversationSummary; parent: number }) {
  const conversations = useConversations()
  const parentBusy = conversations.find((conversation) => conversation.id === parent)?.busy
  const recorded = useWorkspaces()[String(child.id)]
  const { data: isolate } = useAction(
    InfoAction,
    { id: child.id },
    { enabled: !!recorded, on: [child.busy, parentBusy], focus: true },
  )
  if (!isolate) return null
  return (
    <div className="font-mono text-[11px] text-muted-foreground">
      <div className="flex h-6 min-w-0 items-center gap-1.5">
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate" title={`${isolate.branch}\n${isolate.path}`}>
          {isolate.branch}
        </span>
        <Tag
          className={cn(
            isolate.state === 'removed'
              ? 'text-muted-foreground/70'
              : isolate.landed
                ? 'border-success/40 text-success'
                : 'border-brand/40 text-brand',
          )}
        >
          {isolate.state === 'ready' && isolate.landed
            ? `Landed ${isolate.landed.slice(0, 7)}`
            : stateLabel(isolate)}
        </Tag>
        {isolate.ahead !== null && (
          <span
            className="shrink-0 text-[10.5px] text-muted-foreground/80"
            title={`${isolate.ahead} commit${isolate.ahead === 1 ? '' : 's'} on the branch that the parent checkout does not have`}
          >
            ↑{isolate.ahead}
          </span>
        )}
      </div>
    </div>
  )
}

/** The linked child: "open #id" like the Agents tab, with a dot while it works. */
function ChildLink({ id, child }: { id: number; child?: ConversationSummary }) {
  const { switchConversation } = useUltimate()
  return (
    <Button
      className="h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => switchConversation(id)}
      size="xs"
      title={child?.title ?? `Show conversation #${id}`}
      variant="ghost"
    >
      {child?.busy && (
        <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-brand" />
      )}
      <SquareArrowOutUpRightIcon className="size-3" />
      open #{id}
    </Button>
  )
}

/** Scrolls the returned ref's element into view, after `reveal`, each time `focus` becomes a new request. */
function useScrollTo<T extends HTMLElement>(focus: Focus, reveal?: () => void) {
  const ref = useRef<T>(null)
  const latest = useRef(reveal)
  latest.current = reveal
  useEffect(() => {
    if (!focus) return
    latest.current?.()
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest' }))
  }, [focus])
  return ref
}

/** Copies the link that opens this task in its coordinator's plan: `?conversation=N&task=E1.2`. */
function CopyLink({
  coordinator,
  id,
  className,
}: {
  coordinator: number
  id: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      aria-label={`Copy link to ${id}`}
      className={cn(
        'h-5 shrink-0 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100',
        copied && 'opacity-100',
        className,
      )}
      onClick={() => {
        const url = new URL(location.origin)
        url.searchParams.set('conversation', String(coordinator))
        url.searchParams.set('task', id)
        void navigator.clipboard
          .writeText(url.href)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
          .catch((error: unknown) => store.notify({ level: 'error', message: errorMessage(error) }))
      }}
      size="xs"
      title={`Copy a link to ${id}`}
      variant="ghost"
    >
      {copied ? <CheckIcon className="size-3" /> : <LinkIcon className="size-3" />}
      {copied ? 'copied' : 'link'}
    </Button>
  )
}

/** One task: key, title, status, role, deps, the linked child and its isolate, and the last note; click for the rest. */
function TaskRow({
  task,
  tasks,
  coordinator,
  focus,
  own,
}: {
  task: Task
  tasks: Map<string, Task>
  coordinator: number
  focus: Focus
  own?: string
}) {
  const [open, setOpen] = useState(false)
  const row = useScrollTo<HTMLDivElement>(focus?.key === task.key ? focus : undefined, () =>
    setOpen(true),
  )
  const conversations = useConversations()
  const child =
    task.child === undefined
      ? undefined
      : conversations.find((conversation) => conversation.id === task.child)
  const parent = child?.parentConversationId ?? coordinator
  const last = task.notes.at(-1)
  return (
    <Collapsible
      className={cn(
        'group/row border-t border-border/50 first:border-t-0',
        own === task.key && 'bg-brand/5 shadow-[inset_2px_0_0_var(--color-brand)]',
      )}
      data-plan-task={task.key}
      onOpenChange={setOpen}
      open={open}
      ref={row}
    >
      <CollapsibleTrigger className="group/task flex h-7 w-full min-w-0 items-center gap-1.5 px-3 text-left hover:bg-accent/40">
        <StatusIcon status={task.status} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.key}</span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12.5px] text-foreground/90',
            task.status === 'canceled' && 'text-muted-foreground line-through',
          )}
          title={task.title}
        >
          {task.title}
        </span>
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/task:rotate-90" />
      </CollapsibleTrigger>
      <div className="space-y-0.5 pr-3 pb-1.5 pl-8">
        <div className="flex h-5 min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <StatusChip status={task.status} />
          <Tag>{task.role}</Tag>
          {task.deps.length > 0 && (
            <span className="min-w-0 truncate">
              after{' '}
              {task.deps.map((dep, index) => (
                <span key={dep}>
                  {index > 0 && ', '}
                  <span
                    className={cn(tasks.get(dep)?.status === 'done' && 'text-success')}
                    title={tasks.get(dep)?.title}
                  >
                    {dep}
                  </span>
                </span>
              ))}
            </span>
          )}
          <CopyLink
            className={cn(task.child === undefined && 'ml-auto')}
            coordinator={coordinator}
            id={task.key}
          />
          {task.child !== undefined && <ChildLink child={child} id={task.child} />}
        </div>
        {child && parent !== undefined && <IsolateRow child={child} parent={parent} />}
        {task.verdict && (
          <div className="rounded-md border border-border/70 bg-card/50 px-3 py-2 text-[12.5px]">
            <div className="pb-1 section-label">Verdict</div>
            <PlanText>{task.verdict}</PlanText>
          </div>
        )}
        {open ? (
          <div className="space-y-2 pt-1">
            <div className="text-[12.5px] text-foreground/90">
              <PlanText>{task.description}</PlanText>
            </div>
            {task.notes.length > 0 && (
              <div className="space-y-1">
                <div className="section-label">Notes</div>
                {task.notes.map((note, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- Notes are append-only; timestamps can repeat.
                  <Note key={index} note={note} />
                ))}
              </div>
            )}
          </div>
        ) : (
          last && (
            <div className="flex min-w-0 items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <Note clamp note={last} />
              </div>
              {task.notes.length > 1 && (
                <button
                  className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70 hover:text-foreground"
                  onClick={() => setOpen(true)}
                  type="button"
                >
                  {task.notes.length} notes
                </button>
              )}
            </div>
          )
        )}
      </div>
    </Collapsible>
  )
}

/**
 * One epic: status and title, its plan folded below, the verdict when there is one, then its tasks. An epic the
 * coordinator works without tasks shows its acceptance criteria in their place.
 */
function EpicCard({
  epic,
  tasks,
  coordinator,
  focus,
  own,
}: {
  epic: Epic
  tasks: Map<string, Task>
  coordinator: number
  focus: Focus
  own?: string
}) {
  const list = Object.values(epic.tasks)
  const done = finished(epic.tasks)
  const approved = epic.verdict?.trimStart().startsWith('APPROVED')
  const criteria = list.length === 0 ? criteriaOfBody(epic.body) : undefined
  const section = useScrollTo<HTMLElement>(focus?.key === epic.key ? focus : undefined)
  return (
    <section
      className="border-t border-border/70 first:border-t-0"
      data-plan-epic={epic.key}
      ref={section}
    >
      <Collapsible className="group/epic">
        <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 px-3 py-2 text-left hover:bg-accent/40">
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/epic:rotate-90" />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{epic.key}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={epic.title}>
            {epic.title}
          </span>
          <StatusChip status={epic.status} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mx-3 mb-2 rounded-md border border-border/70 bg-card/50 px-3 py-2 text-[12.5px]">
            <EpicBody body={epic.body} criteria={!!criteria} met={epic.status === 'done'} />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {epic.verdict && (
        <div
          className={cn(
            'mx-3 mb-2 rounded-md border px-3 py-2 text-[12.5px]',
            approved ? 'border-success/40 bg-success/5' : 'border-border/70 bg-card/50',
          )}
        >
          <div
            className={cn(
              'pb-1 section-label',
              approved ? 'text-success' : 'text-muted-foreground/80',
            )}
          >
            Verdict
          </div>
          <PlanText>{epic.verdict}</PlanText>
        </div>
      )}
      {list.length > 0 || criteria ? (
        <div className="flex items-center px-3 pb-1 section-label">
          {criteria ? 'Acceptance criteria' : 'Tasks'}
          <span className="ml-auto">
            {criteria ? 'worked directly' : `${done}/${list.length} done`}
          </span>
        </div>
      ) : (
        <p className="px-3 pb-2 font-sans text-[12px] text-muted-foreground/70">
          Worked directly by the coordinator.
        </p>
      )}
      {criteria && (
        <div className="px-3 pb-2 text-[12.5px]">
          <Criteria items={criteria} met={epic.status === 'done'} />
        </div>
      )}
      {list.map((task) => (
        <TaskRow
          coordinator={coordinator}
          focus={focus}
          key={task.key}
          own={own}
          task={task}
          tasks={tasks}
        />
      ))}
    </section>
  )
}

/** The task or epic a deep link asked for: its row opens and scrolls into view. */
type Focus = { key: string } | undefined

/** Open epics first, newest first; done epics fold into one row at the end. */
export function PlanBody({
  plan,
  coordinator,
  focus,
  own,
}: {
  plan: Plan
  coordinator: number
  focus: Focus
  own?: string
}) {
  const epics = Object.values(plan.epics).toSorted((a, b) => number(b.key) - number(a.key))
  const open = epics.filter((epic) => epic.status !== 'done')
  const done = epics.filter((epic) => epic.status === 'done')
  const tasks = new Map(epics.flatMap((epic) => Object.values(epic.tasks)).map((t) => [t.key, t]))
  const card = (epic: Epic) => (
    <EpicCard
      coordinator={coordinator}
      epic={epic}
      focus={focus}
      key={epic.key}
      own={own}
      tasks={tasks}
    />
  )
  if (epics.length === 0)
    return <p className="px-3 py-2 font-sans text-[12px] text-muted-foreground/70">No epics yet.</p>
  return (
    <>
      {open.map(card)}
      {done.length > 0 && (
        <Collapsible
          className="group/done border-t border-border/70 first:border-t-0"
          defaultOpen={
            open.length === 0 || done.some((epic) => focus && focus.key.split('.')[0] === epic.key)
          }
        >
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground hover:bg-accent/40">
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]/done:rotate-90" />
            {done.length} done epic{done.length === 1 ? '' : 's'}
          </CollapsibleTrigger>
          <CollapsibleContent>{done.map(card)}</CollapsibleContent>
        </Collapsible>
      )}
    </>
  )
}

const pill =
  'pointer-events-auto flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/90 px-2.5 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground'

/** The plan card above the pill: the plan with a header naming whose it is. */
function Panel({
  plan,
  coordinator,
  focus,
  own,
  close,
}: {
  plan: Plan | null | undefined
  coordinator: number
  focus: Focus
  own?: string
  close: () => void
}) {
  return (
    <div
      className="pointer-events-auto flex max-h-[60vh] w-[420px] max-w-full flex-col overflow-hidden rounded-lg border border-border/80 bg-popover shadow-lg"
      data-plan-panel
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/70 px-3 font-mono text-[11px] text-muted-foreground">
        <ClipboardListIcon className="size-3.5" />
        Plan
        <span className="text-muted-foreground/70">· #{coordinator}</span>
        <button
          aria-label="Close the plan"
          className="ml-auto text-muted-foreground/70 hover:text-foreground"
          onClick={close}
          type="button"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto pb-1">
        {plan ? (
          <PlanBody coordinator={coordinator} focus={focus} own={own} plan={plan} />
        ) : (
          <p className="px-3 py-2 font-sans text-[12px] text-muted-foreground/70">Loading…</p>
        )}
      </div>
    </div>
  )
}

/** Where the pill floats: the right edge of the conversation's prompt, just above it. */
function useAnchor(conversationId: number | undefined) {
  const [anchor, setAnchor] = useState<{ right: number; bottom: number }>()
  useEffect(() => {
    let form: HTMLFormElement | null | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      if (!form?.isConnected) return
      const rect = form.getBoundingClientRect()
      setAnchor({ right: innerWidth - rect.right, bottom: innerHeight - rect.top + 6 })
    }
    // The column resizes when a side region toggles, which moves the prompt without resizing it.
    const observer = new ResizeObserver(measure)
    const attach = () => {
      const container = document.querySelector('[data-composer-target="conversation"]')
      form = container?.querySelector('form')
      if (!container?.parentElement || !form) {
        setAnchor(undefined)
        retry = setTimeout(attach, 250)
        return
      }
      observer.observe(container.parentElement)
      observer.observe(form)
      measure()
    }
    attach()
    addEventListener('resize', measure)
    return () => {
      clearTimeout(retry)
      observer.disconnect()
      removeEventListener('resize', measure)
    }
  }, [conversationId])
  return anchor
}

type Open = { conversation: number; key: string } | null

/**
 * The plan beside the conversation: a pill above the prompt (the open epic's progress, or a worker's task and its
 * coordinator) that expands into the plan. `plan.open` (set by task chips and `?task=` links) opens it at a task.
 */
function PlanOverlay() {
  const { surface, conversationId } = useUltimate()
  const task = useTaskOf(conversationId)
  const anchor = useAnchor(conversationId)
  const [request, setRequest] = useUiState<Open>('plan.open', null)
  useEffect(() => {
    const url = new URL(location.href)
    const key = url.searchParams.get('task')
    const conversation = Number(url.searchParams.get('conversation'))
    if (!key) return
    url.searchParams.delete('task')
    history.replaceState(history.state, '', url)
    if (Number.isSafeInteger(conversation) && conversation > 0) setRequest({ conversation, key })
  }, [setRequest])
  if (surface !== 'agent' || conversationId === undefined || !anchor) return null
  return (
    <div
      className="pointer-events-none fixed z-30 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-1.5"
      style={anchor}
    >
      {task ? (
        <WorkerPlan conversation={conversationId} task={task} />
      ) : (
        <CoordinatorPlan
          conversation={conversationId}
          request={request?.conversation === conversationId ? request : null}
          settle={() => setRequest(null)}
        />
      )}
    </div>
  )
}

function CoordinatorPlan({
  conversation,
  request,
  settle,
}: {
  conversation: number
  request: Open
  settle: () => void
}) {
  const plan = useDoc(PlanDoc)
  const [expanded, setExpanded] = useUiState('plan.panel', false)
  const [focus, setFocus] = useState<Focus>()
  useEffect(() => {
    if (!request || plan === undefined) return
    setExpanded(true)
    setFocus({ key: request.key })
    settle()
  }, [request, plan, setExpanded, settle])
  const shown = pillOf(plan?.epics ?? {})
  if (!shown && !expanded) return null
  return (
    <>
      {expanded && plan && (
        <Panel
          close={() => {
            setExpanded(false)
            setFocus(undefined)
          }}
          coordinator={conversation}
          focus={focus}
          plan={plan}
        />
      )}
      {shown && (
        <button
          aria-expanded={expanded}
          className={pill}
          data-plan-pill
          onClick={() => setExpanded(!expanded)}
          title={`${shown.epic.key} · ${shown.epic.title}`}
          type="button"
        >
          <ClipboardListIcon className="size-3.5 shrink-0" />
          <span className="text-foreground/80">{shown.epic.key}</span>
          <span>· {progressLabel(shown.epic)}</span>
          {shown.more > 0 && <span className="text-muted-foreground/70">+{shown.more}</span>}
        </button>
      )}
    </>
  )
}

function WorkerPlan({ conversation, task }: { conversation: number; task: TaskLink }) {
  const [expanded, setExpanded] = useUiState('plan.panel', false)
  const plan = useDocOf(expanded ? task.coordinator : undefined, PlanDoc)
  const openTask = useOpenTask()
  const focus = useMemo(() => ({ key: task.key }), [task.key])
  return (
    <>
      {expanded && (
        <Panel
          close={() => setExpanded(false)}
          coordinator={task.coordinator}
          focus={focus}
          key={conversation}
          own={task.key}
          plan={plan}
        />
      )}
      <div className={cn(pill, 'pr-1')} data-plan-pill>
        <TaskChip task={task} />
        <button
          aria-expanded={expanded}
          className="max-w-56 min-w-0 truncate hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
          title={task.title}
          type="button"
        >
          {task.title}
        </button>
        <button
          className="shrink-0 rounded-full px-1.5 hover:bg-accent hover:text-foreground"
          onClick={() => openTask(task)}
          title={`Show coordinator #${task.coordinator} at ${task.key}`}
          type="button"
        >
          ↑ #{task.coordinator}
        </button>
      </div>
    </>
  )
}

/** A key in a `plan` call's header: the task's chip, or the epic key, opening the plan panel there. */
function PlanKey({ id }: { id: string }) {
  const { conversationId } = useUltimate()
  const plan = useDoc(PlanDoc)
  const coordinator = useTaskOf(conversationId)?.coordinator ?? conversationId
  const openTask = useOpenTask()
  if (coordinator === undefined || !/^E\d+(\.\d+)?$/.test(id))
    return <span className="text-foreground/80">{id}</span>
  const epic = plan?.epics[id.split('.')[0]]
  const task = epic?.tasks[id]
  if (task && epic && coordinator === conversationId)
    return (
      <TaskChip
        className="align-middle"
        task={{ coordinator, epic: epic.key, key: id, title: task.title, status: task.status }}
      />
    )
  const open = (event: SyntheticEvent) => {
    event.stopPropagation()
    event.preventDefault()
    openTask({ coordinator, key: id })
  }
  return (
    <span
      className="cursor-pointer text-foreground/80 underline-offset-2 hover:underline"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') open(event)
      }}
      role="button"
      tabIndex={0}
      title={`Open ${id} in the plan`}
    >
      {id}
    </span>
  )
}

/** One `plan` call: the action and the key it touched, with what it wrote below. */
function PlanCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = text(call.args.action)
  let result: { key?: string; title?: string; epics?: unknown } | undefined
  if (call.status === 'done') {
    try {
      result = JSON.parse(call.output)
    } catch {
      // Error outputs may be plain text; the card can still describe the call from its arguments.
    }
  }
  const key =
    text(call.args.key) ||
    (result?.epics ? 'ledger' : result?.key) ||
    (action === 'add' ? text(call.args.epic) : '')
  const changes = [
    call.args.status !== undefined && `→ ${text(call.args.status).replace('_', ' ')}`,
    typeof call.args.child === 'number' && `child #${call.args.child}`,
    ...(['title', 'description', 'body', 'verdict'] as const).filter(
      (field) => call.args[field] !== undefined,
    ),
  ].filter(Boolean)
  const detail =
    action === 'create' || action === 'add'
      ? text(call.args.title)
      : action === 'note'
        ? text(call.args.text)
        : action === 'update'
          ? changes.join(' · ')
          : ''
  const sections: [string, string][] = [
    ['Plan', text(call.args.body)],
    ['Task', text(call.args.description)],
    ['Verdict', text(call.args.verdict)],
    ['Note', text(call.args.text)],
  ]
  return (
    <Tool defaultOpen={call.status === 'error'}>
      <ToolHeader
        meta={
          <>
            {action === 'add' && text(call.args.role) && <Tag>{text(call.args.role)}</Tag>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="plan"
        state={call.status}
        title={
          <>
            {action || '…'} {key && <PlanKey id={key} />} {detail}
          </>
        }
      />
      <ToolContent>
        {sections.map(
          ([label, value]) =>
            value && (
              <ToolSection key={label} label={label}>
                <div className="font-sans text-[13px] text-foreground/90">
                  <PlanText>{value}</PlanText>
                </div>
              </ToolSection>
            ),
        )}
        {action === 'add' && (call.args.deps as unknown[] | undefined)?.length ? (
          <ToolSection label="Deps">{(call.args.deps as string[]).join(', ')}</ToolSection>
        ) : null}
        {(action === 'show' || call.status === 'error') && (
          <ToolOutput isError={call.status === 'error'} output={call.output} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics} />
      </ToolContent>
    </Tool>
  )
}

/** The plan task a child conversation works on, for its rows and report cards: the task chip and title. */
function useConversationTask(id: number | undefined) {
  const task = useTaskOf(id)
  return task && { chip: <TaskChip task={task} />, title: task.title }
}

/** The epic coordinator `id` works itself, for its sidebar row; one with a task linked to a subagent has none. */
function useConversationEpic(id: number) {
  const epics = useDocOf(id, PlanDoc)?.epics ?? {}
  const openTask = useOpenTask()
  const epic =
    pillOf(epics)?.epic ?? Object.values(epics).toSorted((a, b) => number(b.key) - number(a.key))[0]
  if (!epic || Object.values(epic.tasks).some((task) => task.child !== undefined)) return undefined
  return {
    key: epic.key,
    title: epic.title,
    status: epic.status,
    open: () => openTask({ coordinator: id, key: epic.key }),
  }
}

export default defineWebExtension({
  tools: { plan: PlanCall },
  slots: { overlay: PlanOverlay },
  provides: [
    provide(ConversationTask, useConversationTask),
    provide(ConversationEpic, useConversationEpic),
  ],
})
