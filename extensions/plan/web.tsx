import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClipboardListIcon,
  GitBranchIcon,
  LinkIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from 'lucide-react'
import { deadline } from '../../lib/timers.ts'
import type { ReactNode, SyntheticEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MentionText, MessageResponse } from '@/components/ai/message'
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
  writingAs,
} from '@/sdk'
import type { ConversationSummary, ToolCallView } from '@/sdk'
import { ConversationEpic, ConversationTask } from '../conversations/ui.tsx'
import { InfoAction, LandedNote, stateLabel, useWorkspaces } from '../workspaces/ui.tsx'
import { meansNone } from '../../lib/errors.ts'
import { criteriaOf, sectionsOf, verbatim } from './body.ts'
import {
  confirmed,
  criteriaCounts,
  criteriaOfBody,
  currentEpic,
  finished,
  number,
  pillOf,
  progressLabel,
} from './progress.ts'
import { PlanDoc, ProgressDoc } from './refs.ts'
import type { Epic, Estimate, Plan, Task, TaskLink } from './refs.ts'
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

function LiteralPlanText({ children, className }: { children: string; className?: string }) {
  return (
    <MessageResponse className={className} parseIncompleteMarkdown={false}>
      {verbatim(children)}
    </MessageResponse>
  )
}

type Checks = { epic: Epic; coordinator: number; estimates: Record<string, Estimate> }

function EstimateMark({ estimate }: { estimate: Estimate }) {
  const Icon = estimate.state === 'looks_done' ? CircleDotDashedIcon : CircleDashedIcon
  return (
    <Icon
      aria-label={estimate.state === 'looks_done' ? 'looks done' : 'in progress'}
      className={cn(
        'size-3.5 shrink-0',
        estimate.state === 'looks_done' ? 'text-success/60' : 'text-brand/60',
      )}
    />
  )
}

function Criteria({ items, checks }: { items: string[]; checks?: Checks }) {
  return (
    <ol className="space-y-1">
      {items.map((item, index) => {
        const met = !!checks && confirmed(checks.epic, index + 1)
        const estimate =
          checks && !met && Object.hasOwn(checks.estimates, item)
            ? checks.estimates[item]
            : undefined
        return (
          <li className="flex min-w-0 gap-1.5" data-criterion={index + 1} key={index}>
            <span className="pt-0.5">
              {estimate ? (
                <EstimateMark estimate={estimate} />
              ) : (
                <StatusIcon status={met ? 'done' : 'todo'} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <LiteralPlanText className="text-foreground/90">{item}</LiteralPlanText>
              {estimate && (
                <span
                  className="block font-mono text-[10.5px] text-muted-foreground/70"
                  title="Estimated from the coordinator's recent work, not confirmed"
                >
                  ~ {estimate.state === 'looks_done' ? 'looks done' : 'in progress'}
                  {estimate.at !== undefined && checks && (
                    <>
                      {' · '}
                      <MentionText text={`#${checks.coordinator}/${estimate.at}`} />
                    </>
                  )}
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function EpicBody({ body, checks, criteria }: { body: string; checks: Checks; criteria: boolean }) {
  const sections = sectionsOf(body)
  if (!sections) return <LiteralPlanText>{body}</LiteralPlanText>
  return (
    <div className="space-y-2.5">
      {sections.map((section, index) => {
        if (criteria && section.label === 'Acceptance criteria') return null
        const items = section.label === 'Acceptance criteria' && criteriaOf(section.text)
        return (
          <div key={index}>
            {section.label && <div className="pb-0.5 section-label">{section.label}</div>}
            {items ? (
              <Criteria checks={checks} items={items} />
            ) : (
              section.text && <LiteralPlanText>{section.text}</LiteralPlanText>
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

function IsolateRow({ child, parent }: { child: ConversationSummary; parent: number }) {
  const conversations = useConversations()
  const parentBusy = conversations.find((conversation) => conversation.id === parent)?.busy
  const recorded = useWorkspaces()[String(child.id)]
  const commitOrLandingActivity = [child.busy, parentBusy]
  const { data: isolate } = useAction(
    InfoAction,
    { id: child.id },
    { enabled: !!recorded, on: commitOrLandingActivity, focus: true },
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

function ChildLink({ id, child }: { id: ConversationId; child?: ConversationSummary }) {
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

function useScrollTo<T extends HTMLElement>(focus: DeepLinkFocus, reveal?: () => void) {
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
            deadline(1200, () => setCopied(false))
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
  focus: DeepLinkFocus
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
            <LiteralPlanText>{task.verdict}</LiteralPlanText>
          </div>
        )}
        {open ? (
          <div className="space-y-2 pt-1">
            <div className="text-[12.5px] text-foreground/90">
              <LiteralPlanText>{task.description}</LiteralPlanText>
            </div>
            {task.notes.length > 0 && (
              <div className="space-y-1">
                <div className="section-label">Notes</div>
                {task.notes.map((note, index) => (
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
  focus: DeepLinkFocus
  own?: string
}) {
  const list = Object.values(epic.tasks)
  const done = finished(epic.tasks)
  const approved = epic.verdict?.trimStart().startsWith('APPROVED')
  const criteria = list.length === 0 ? criteriaOfBody(epic.body) : undefined
  const estimates = useEstimates(coordinator, epic.key)
  const checks = { epic, coordinator, estimates }
  const counts = criteriaCounts(epic, estimates)
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
            <EpicBody body={epic.body} checks={checks} criteria={!!criteria} />
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
          <LiteralPlanText>{epic.verdict}</LiteralPlanText>
        </div>
      )}
      {list.length > 0 || criteria ? (
        <div className="flex items-center px-3 pb-1 section-label">
          {criteria ? 'Acceptance criteria' : 'Tasks'}
          <span className="ml-auto">
            {criteria ? <CriteriaCount counts={counts} /> : `${done}/${list.length} done`}
          </span>
        </div>
      ) : (
        <p className="px-3 pb-2 font-sans text-[12px] text-muted-foreground/70">
          Worked directly by the coordinator.
        </p>
      )}
      {criteria && (
        <div className="px-3 pb-2 text-[12.5px]">
          <Criteria checks={checks} items={criteria} />
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

type DeepLinkFocus = { key: string } | undefined

export function PlanBody({
  plan,
  coordinator,
  focus,
  own,
}: {
  plan: Plan
  coordinator: number
  focus: DeepLinkFocus
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

function useEstimates(coordinator: number, key: string) {
  return (
    useDocOf(parseConversationId(coordinator), ProgressDoc)?.epics[key]?.estimates ?? noEstimates
  )
}
const noEstimates: Record<string, Estimate> = {}

function CriteriaCount({ counts }: { counts: ReturnType<typeof criteriaCounts> }) {
  return (
    <span
      className="tabular-nums"
      title={`${counts.confirmed} confirmed by the coordinator, ${counts.estimated} estimated from the work, of ${counts.total}`}
    >
      {counts.confirmed > 0 && <span className="text-success">{counts.confirmed}✓ </span>}
      {counts.confirmed + counts.estimated}/{counts.total}
    </span>
  )
}

const pill =
  'pointer-events-auto flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/90 px-2.5 font-mono text-[11px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground'

function Panel({
  plan,
  coordinator,
  focus,
  own,
  close,
}: {
  plan: Plan | null | undefined
  coordinator: number
  focus: DeepLinkFocus
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

function useAnchor(conversationId: ConversationId | undefined) {
  const [anchor, setAnchor] = useState<{ right: number; bottom: number }>()
  useEffect(() => {
    let form: HTMLFormElement | null | undefined
    const measure = () => {
      if (!form?.isConnected) return
      const rect = form.getBoundingClientRect()
      setAnchor({ right: innerWidth - rect.right, bottom: innerHeight - rect.top + 6 })
    }
    const columnResizeObserver = new ResizeObserver(measure)
    const attach = () => {
      const container = document.querySelector('[data-composer-target="conversation"]')
      form = container?.querySelector('form')
      if (!container?.parentElement || !form) return false
      appeared.disconnect()
      columnResizeObserver.observe(container.parentElement)
      columnResizeObserver.observe(form)
      measure()
      return true
    }
    const appeared = new MutationObserver(attach)
    if (!attach()) {
      setAnchor(undefined)
      appeared.observe(document.body, { childList: true, subtree: true })
    }
    addEventListener('resize', measure)
    return () => {
      appeared.disconnect()
      columnResizeObserver.disconnect()
      removeEventListener('resize', measure)
    }
  }, [conversationId])
  return anchor
}

type Open = { conversation: ConversationId; key: string } | null

function PlanOverlay() {
  const { surface, conversationId } = useUltimate()
  const task = useTaskOf(conversationId)
  const anchor = useAnchor(conversationId)
  const [request, setRequest] = useUiState<Open>('plan.open', null)
  useEffect(() => {
    const url = new URL(location.href)
    const key = url.searchParams.get('task')
    const conversation = parseConversationId(Number(url.searchParams.get('conversation')))
    if (!key) return
    url.searchParams.delete('task')
    history.replaceState(history.state, '', url)
    if (Number.isSafeInteger(conversation) && conversation > 0)
      writingAs('app', () => setRequest({ conversation, key }))
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
  conversation: ConversationId
  request: Open
  settle: () => void
}) {
  const plan = useDoc(PlanDoc)
  const [expanded, setExpanded] = useUiState('plan.panel', false)
  const [focus, setFocus] = useState<DeepLinkFocus>()
  useEffect(() => {
    if (!request || plan === undefined) return
    writingAs('app', () => setExpanded(true))
    setFocus({ key: request.key })
    writingAs('app', settle)
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
          <span>
            · <PillProgress coordinator={conversation} epic={shown.epic} />
          </span>
          {shown.more > 0 && <span className="text-muted-foreground/70">+{shown.more}</span>}
        </button>
      )}
    </>
  )
}

function PillProgress({ coordinator, epic }: { coordinator: number; epic: Epic }) {
  const counts = criteriaCounts(epic, useEstimates(coordinator, epic.key))
  if (Object.keys(epic.tasks).length > 0 || counts.total === 0) return progressLabel(epic)
  return <CriteriaCount counts={counts} />
}

function WorkerPlan({ conversation, task }: { conversation: ConversationId; task: TaskLink }) {
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

function PlanCall({ call }: { call: ToolCallView }) {
  const duration = useToolDuration(call)
  const action = text(call.args.action)
  let result: { key?: string; title?: string; epics?: unknown } | undefined
  if (call.status === 'done') {
    try {
      result = JSON.parse(call.output)
    } catch (error) {
      meansNone(error)
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
                  <LiteralPlanText>{value}</LiteralPlanText>
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

function useConversationTask(id: number | undefined) {
  const task = useTaskOf(id)
  return task && { chip: <TaskChip task={task} />, title: task.title }
}

function useLandedNote({
  conversation,
  submission,
}: {
  conversation: ConversationId
  submission: string
}) {
  const progress = useDocOf(conversation, ProgressDoc)?.epics ?? {}
  const landed = Object.entries(progress).find(([, epic]) => epic.landed?.[submission])
  if (!landed) return undefined
  const [key, epic] = landed
  const counts = epic.landed![submission]
  return (
    <p className="text-muted-foreground tabular-nums">
      Criteria{' '}
      <span className={counts.confirmed === counts.total ? 'text-success' : ''}>
        {counts.confirmed}/{counts.total} confirmed
      </span>
      {counts.estimated > 0 && ` · ${counts.estimated} estimated`}
      <span className="text-muted-foreground/60"> · {key}</span>
    </p>
  )
}

function useConversationEpic(id: ConversationId) {
  const epics = useDocOf(id, PlanDoc)?.epics ?? {}
  const progress = useDocOf(id, ProgressDoc)?.epics
  const openTask = useOpenTask()
  const epic = currentEpic(epics)
  if (!epic || Object.values(epic.tasks).some((task) => task.child !== undefined)) return undefined
  const counts = criteriaCounts(epic, progress?.[epic.key]?.estimates)
  return {
    key: epic.key,
    title: epic.title,
    status: epic.status,
    ...(counts.total > 0 && Object.keys(epic.tasks).length === 0
      ? { progress: `${counts.confirmed + counts.estimated}/${counts.total}` }
      : {}),
    open: () => openTask({ coordinator: id, key: epic.key }),
  }
}

export default defineWebExtension({
  tools: { plan: PlanCall },
  slots: { overlay: PlanOverlay },
  provides: [
    provide(ConversationTask, useConversationTask),
    provide(ConversationEpic, useConversationEpic),
    provide(LandedNote, useLandedNote),
  ],
})
