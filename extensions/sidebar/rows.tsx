import { ROOT } from '@/sdk'
import { parseConversationId } from '../../lib/ids.ts'
import {
  GitBranchIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  EllipsisIcon,
  FileDiffIcon,
  FoldVerticalIcon,
  PauseIcon,
  PencilIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, cn, errorMessage, formatAgo, Provided, useDocOf } from '@/sdk'
import { useShell } from './state.tsx'
import { store } from '@/sdk/client'
import { MessagesDoc, conversationState, emptyMessages } from '../messages/ui.tsx'
import {
  AgentMark,
  ConversationEpic,
  ConversationPhase,
  ConversationTask,
  FeatureTag,
  RenameAction,
  useAgentTitle,
} from '../conversations/ui.tsx'
import type { Presence } from '../conversations/ui.tsx'
import { Review } from '../workspaces/ui.tsx'
import { RunName } from '../subagents/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import type { OverviewRow } from '../conversations/types.ts'
import type { ConversationState } from '../messages/ui.tsx'
import { SummaryHistory } from './summaries.tsx'

const settled = {
  waits: {
    label: 'Waits on you',
    word: 'Waits on you',
    tone: 'text-amber-700 dark:text-amber-300',
  },
  awaiting: {
    label: 'Waiting',
    word: 'Waiting',
    tone: 'text-brand',
  },
  done: { label: 'Done: its answer went to its parent', word: 'Done', tone: 'text-success' },
  failed: { label: 'Its latest run failed', word: 'Failed', tone: 'text-error' },
  paused: { label: 'Paused: its run continues on Play', word: 'Paused', tone: 'text-warning' },
} as const

function Mark({
  working,
  unseen,
  state,
  waitLabel,
}: {
  working?: 'self' | 'subagents'
  unseen: boolean
  state?: ConversationState
  waitLabel?: string
}) {
  const shown = !working && state && state in settled ? (state as keyof typeof settled) : undefined
  const label = working
    ? working === 'self'
      ? 'Working'
      : 'Subagents working'
    : shown
      ? ((shown === 'awaiting' ? waitLabel : undefined) ?? settled[shown].label)
      : 'New answer'
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      {(working || unseen || shown) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={label}
              role="img"
              className={cn(
                'flex items-center justify-center',
                shown ? settled[shown].tone : 'text-muted-foreground',
              )}
            >
              {shown === 'done' ? (
                <CircleCheckIcon className="size-3.5" />
              ) : shown === 'awaiting' || shown === 'waits' ? (
                <CircleHelpIcon className="size-3.5" />
              ) : shown === 'failed' ? (
                <CircleXIcon className="size-3.5" />
              ) : shown === 'paused' ? (
                <PauseIcon className="size-3" />
              ) : (
                <span
                  className={cn('size-1.5 rounded-full bg-brand', working && 'animate-pulse-dot')}
                  data-status={working ? 'working' : 'idle'}
                />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

type RowProps = {
  conversation: ConversationSummary
  shown: boolean
  draft: boolean
  working?: 'self' | 'subagents'
  unseen: boolean
  concluded: boolean
  now: number
  onConclude: (conclude: boolean) => void
  state?: ConversationState
  waitLabel?: string
  activity?: string
  feature?: string
}

export function Row(props: RowProps) {
  return (
    <Provided input={props.working ? props.conversation.id : undefined} point={ConversationPhase}>
      {(phase) => <PhasedRow {...props} displayPhase={phase} />}
    </Provided>
  )
}

function PhasedRow({
  conversation,
  shown,
  draft,
  working,
  unseen,
  concluded,
  now,
  onConclude,
  feature,
  state,
  waitLabel,
  activity,
  displayPhase,
}: RowProps & { displayPhase?: { label: ReactNode } }) {
  const hasActivity = !!(displayPhase || activity)
  const leadingMarkWorkingWithoutPhaseDot = displayPhase ? undefined : working
  const actions = useShell()
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  const refocusAfterKeyboardRename = useRef(false)
  const name =
    conversation.title ??
    (draft
      ? 'Untitled conversation'
      : conversation.workspace
        ? 'Untitled conversation'
        : `#${conversation.id}`)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const hasMetadata = feature || conversation.workspace || latest > 0 || waitLabel
  const rename = () => {
    cancelled.current = false
    setEditing(true)
  }
  const save = (value: string) => {
    setEditing(false)
    if (!cancelled.current) saveTitle(conversation.id, value)
  }
  const title = (
    <span
      className={cn(
        'min-w-0 flex-1 truncate text-[13px]',
        conversation.title || !draft
          ? shown
            ? 'text-foreground'
            : 'text-foreground/85'
          : 'text-muted-foreground',
      )}
      onDoubleClick={draft ? undefined : rename}
    >
      {name}
    </span>
  )
  return (
    <div
      className={cn(
        'group relative mx-2 flex items-center rounded-md transition-colors',
        hasActivity ? 'h-[62px]' : hasMetadata ? 'h-12' : 'h-8',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={conversation.id}
      data-selected={shown || undefined}
      data-ui="sidebar-row"
    >
      {editing ? (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-1.5">
          <Mark
            state={state}
            waitLabel={waitLabel}
            unseen={unseen}
            working={leadingMarkWorkingWithoutPhaseDot}
          />
          <input
            aria-label="Conversation title"
            autoFocus
            className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            defaultValue={conversation.title ?? ''}
            onBlur={(event) => save(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              const confirmRenameOnly = event.key === 'Enter' && !event.nativeEvent.isComposing
              if (confirmRenameOnly) {
                event.preventDefault()
                refocusAfterKeyboardRename.current = true
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                cancelled.current = true
                refocusAfterKeyboardRename.current = true
                event.currentTarget.blur()
              }
            }}
          />
        </div>
      ) : (
        <SummaryHistory id={conversation.id} title={name}>
          <button
            aria-current={shown ? 'true' : undefined}
            className="flex h-full min-w-0 flex-1 cursor-pointer flex-col justify-center rounded-md pr-2 pl-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => actions.switchConversation(conversation.id)}
            ref={(element) => {
              if (!element || !refocusAfterKeyboardRename.current) return
              refocusAfterKeyboardRename.current = false
              element.focus()
            }}
            type="button"
          >
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <Mark
                state={state}
                waitLabel={waitLabel}
                unseen={unseen}
                working={leadingMarkWorkingWithoutPhaseDot}
              />
              {title}
            </span>
            {hasMetadata && (
              <span className="flex w-full items-center gap-2 pr-5 pl-[18px] font-mono text-[10px] leading-4 text-muted-foreground">
                {feature && <FeatureTag feature={feature} />}
                {waitLabel && (
                  <span className="min-w-0 truncate text-brand" title={waitLabel}>
                    {waitLabel}
                  </span>
                )}
                {conversation.workspace && (
                  <span className="shrink-0" title="Isolated checkout">
                    #{conversation.id}
                  </span>
                )}
                {latest > 0 && (
                  <span
                    className="shrink-0 text-muted-foreground/80"
                    title={new Date(latest).toLocaleString()}
                  >
                    {formatAgo(latest, now)}
                  </span>
                )}
              </span>
            )}
            {hasActivity && (
              <span className="flex w-full min-w-0 items-center gap-1 pr-5 pl-[18px] text-[11px] leading-4 text-muted-foreground/70">
                {displayPhase && <span className="shrink-0 text-brand">{displayPhase.label}</span>}
                {displayPhase && activity && <span>·</span>}
                {activity && <span className="truncate">{activity}</span>}
              </span>
            )}
          </button>
        </SummaryHistory>
      )}
      {(!draft || conversation.workspace) && !editing && (
        <RowMenu
          concluded={concluded}
          conversation={conversation}
          onConclude={onConclude}
          onRename={rename}
        />
      )}
    </div>
  )
}

export function RowMenu({
  conversation,
  concluded,
  onRename,
  onConclude,
}: {
  conversation: ConversationSummary
  concluded: boolean
  onRename: () => void
  onConclude: (conclude: boolean) => void
}) {
  const actions = useShell()
  const actionOnMenuClose = useRef<() => void>(undefined)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Conversation actions"
        className="invisible absolute right-1.5 bottom-1.5 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
      >
        <EllipsisIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-44 [&_[role=menuitem]]:cursor-pointer"
        onCloseAutoFocus={(event) => {
          const next = actionOnMenuClose.current
          actionOnMenuClose.current = undefined
          if (!next) return
          event.preventDefault()
          next()
        }}
      >
        {conversation.workspace && (
          <DropdownMenuItem
            className="cursor-pointer text-[12.5px]"
            onSelect={() =>
              (actionOnMenuClose.current = () => {
                actions.switchConversation(conversation.id)
                actions.openPanel('info')
              })
            }
          >
            <GitBranchIcon />
            Workspace details
          </DropdownMenuItem>
        )}
        {conversation.workspace && conversation.workspace.state !== 'removed' && (
          <Provided input={`branch:${conversation.workspace.branch}`} point={Review}>
            {(open) =>
              open && (
                <DropdownMenuItem
                  className="cursor-pointer text-[12.5px]"
                  onSelect={() => (actionOnMenuClose.current = open)}
                >
                  <FileDiffIcon />
                  Review changes
                </DropdownMenuItem>
              )
            }
          </Provided>
        )}
        <DropdownMenuItem
          className="text-[12.5px]"
          onSelect={() => (actionOnMenuClose.current = onRename)}
        >
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <CompactItem conversation={conversation} />
        <DropdownMenuItem className="text-[12.5px]" onSelect={() => onConclude(!concluded)}>
          <CircleCheckIcon />
          {concluded ? 'Resume' : 'Conclude'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function saveTitle(id: number, value: string) {
  void api
    .action(RenameAction, { id, title: value.trim() })
    .catch((error: unknown) => store.notify({ level: 'error', message: errorMessage(error) }))
}

export function StandingRow({
  conversation,
  name,
  shown,
  presence,
  onOpen,
  children,
}: {
  conversation?: ConversationSummary
  name: string
  shown: boolean
  presence: Presence
  onOpen: () => void
  children: ReactNode
}) {
  const { title, brand } = useAgentTitle(name)
  return (
    <div
      className={cn(
        'group relative mx-2 flex h-12 items-center rounded-md transition-colors',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={conversation?.id}
      data-selected={shown || undefined}
      data-standing={name}
      data-ui="sidebar-row"
    >
      <button
        aria-current={shown ? 'true' : undefined}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md pr-2 pl-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onOpen}
        type="button"
      >
        <AgentMark name={name} presence={presence} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {brand ? (
              <span
                className="truncate font-sans text-[11.5px] leading-5 font-semibold tracking-[0.28em] text-brand"
                data-ui="wordmark"
              >
                ULTIMATE
              </span>
            ) : (
              <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
                {title}
              </span>
            )}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">@{name}</span>
          </span>
          <span className="flex w-full min-w-0 items-center gap-2 pr-5 font-mono text-[10px] leading-4 text-muted-foreground">
            {children}
          </span>
        </span>
      </button>
      {conversation && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Conversation actions"
            className="invisible absolute right-1.5 bottom-1.5 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
          >
            <EllipsisIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44 [&_[role=menuitem]]:cursor-pointer">
            <CompactItem conversation={conversation} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function CompactItem({ conversation }: { conversation: ConversationSummary }) {
  return (
    <DropdownMenuItem
      className="text-[12.5px]"
      disabled={conversation.busy}
      onSelect={() => void api.compact(undefined, conversation.id)}
    >
      <FoldVerticalIcon />
      Compact context
    </DropdownMenuItem>
  )
}

type ChildRowProps = {
  conversation: ConversationSummary
  row?: OverviewRow
  shown: boolean
  parked?: boolean
}

export function SubagentLine(props: ChildRowProps & { depth: number }) {
  return (
    <Provided input={props.conversation.id} point={ConversationTask}>
      {(task) => <TaskedSubagentLine {...props} task={task} />}
    </Provided>
  )
}

function TaskedSubagentLine({
  conversation,
  row,
  shown,
  parked,
  depth,
  task,
}: ChildRowProps & { depth: number; task?: { chip: ReactNode; title: string } }) {
  const actions = useShell()
  const log = useDocOf(ROOT, MessagesDoc) ?? emptyMessages
  const state = conversationState(
    {
      id: conversation.id,
      kind: 'subagent',
      runState: row?.runState,
      busy: conversation.busy,
      parked,
    },
    log,
  )
  const working = state === 'working'
  const known = state in settled ? settled[state as keyof typeof settled] : undefined
  return (
    <button
      aria-current={shown ? 'true' : undefined}
      className={cn(
        'mx-2 flex h-7 w-[calc(100%-1rem)] min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left font-mono text-[10.5px] outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
        shown && 'bg-sidebar-accent',
      )}
      data-child-conversation={conversation.id}
      data-selected={shown || undefined}
      data-ui="sidebar-row"
      onClick={() => actions.switchConversation(conversation.id)}
      style={{ paddingLeft: 20 + depth * 12 }}
      title={[
        `${conversation.label ?? 'Agent'} · #${conversation.id}`,
        task?.title ?? row?.activity ?? conversation.title,
      ]
        .filter(Boolean)
        .join('\n')}
      type="button"
    >
      <span className="w-2 shrink-0 text-muted-foreground/40">└</span>
      <Mark state={state} unseen={false} working={working ? 'self' : undefined} />
      {task?.chip}
      <span className="min-w-0 flex-1 truncate text-foreground/75">
        <RunName id={conversation.id} label={conversation.label ?? 'agent'} />
        <span className="text-muted-foreground/60"> #{conversation.id}</span>
      </span>
      <span
        className={cn(
          'shrink-0 text-[10px]',
          working ? 'text-brand' : (known?.tone ?? 'text-muted-foreground/70'),
        )}
      >
        {working ? 'working' : (known?.word.toLowerCase() ?? 'idle')}
      </span>
    </button>
  )
}

const shownWaits = 3

export function WaitLines({
  waits,
}: {
  waits: readonly { id: number; title?: string; feature?: string }[]
}) {
  const actions = useShell()
  const [all, setAll] = useState(false)
  const hidden = waits.length - shownWaits
  const shown = all || hidden <= 1 ? waits : waits.slice(0, shownWaits)
  return (
    <div data-ui="wait-lines">
      {shown.map((wait) => (
        <button
          className="mx-2 flex h-6 w-[calc(100%-1rem)] min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-5 text-left font-mono text-[10.5px] outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          data-wait-line={wait.id}
          key={wait.id}
          onClick={() => actions.switchConversation(parseConversationId(wait.id))}
          title={[`#${wait.id}`, wait.feature, wait.title].filter(Boolean).join(' · ')}
          type="button"
        >
          <span className="w-2 shrink-0 text-muted-foreground/40">└</span>
          <span className="shrink-0 text-brand">#{wait.id}</span>
          {wait.feature && <FeatureTag className="max-w-[45%] shrink-0" feature={wait.feature} />}
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{wait.title ?? ''}</span>
        </button>
      ))}
      {!all && hidden > 1 && (
        <button
          className="mx-2 flex h-6 w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded-md pl-5 font-mono text-[10.5px] text-muted-foreground outline-none hover:bg-sidebar-accent/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => setAll(true)}
          type="button"
        >
          <span className="w-2 shrink-0 text-muted-foreground/40">└</span>+{hidden} more
        </button>
      )}
    </div>
  )
}

export function EpicLine({ id, working }: { id: number; working: boolean }) {
  return (
    <Provided input={id} point={ConversationEpic}>
      {(epic) => {
        if (!epic) return null
        const done = epic.status === 'done'
        return (
          <button
            className="mx-2 flex h-7 w-[calc(100%-1rem)] min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-5 text-left font-mono text-[10.5px] outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            data-epic-line={id}
            data-ui="sidebar-row"
            onClick={epic.open}
            title={`${epic.key} · ${epic.title}\nWorked directly by #${id}`}
            type="button"
          >
            <span className="w-2 shrink-0 text-muted-foreground/40">└</span>
            <span className="flex size-3 shrink-0 items-center justify-center">
              {done ? (
                <CircleCheckIcon className="size-3.5 text-success" />
              ) : (
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    working ? 'animate-pulse-dot bg-brand' : 'bg-muted-foreground/40',
                  )}
                  data-status={working ? 'working' : 'idle'}
                />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/75">
              {epic.key}
              <span className="text-muted-foreground/60"> · {epic.title}</span>
            </span>
            <span
              className={cn(
                'shrink-0 text-[10px]',
                done ? 'text-success' : working ? 'text-brand' : 'text-muted-foreground/70',
              )}
            >
              {done ? 'done' : working ? 'working' : 'idle'}
            </span>
          </button>
        )
      }}
    </Provided>
  )
}

export function ChildRow(props: ChildRowProps) {
  return (
    <Provided input={props.conversation.id} point={ConversationTask}>
      {(task) => <TaskedChildRow {...props} task={task} />}
    </Provided>
  )
}

function TaskedChildRow({
  conversation,
  row,
  shown,
  parked,
  task,
}: ChildRowProps & { task?: { chip: ReactNode; title: string } }) {
  const actions = useShell()
  const log = useDocOf(ROOT, MessagesDoc) ?? emptyMessages
  const state = conversationState(
    {
      id: conversation.id,
      kind: 'subagent',
      runState: row?.runState,
      busy: conversation.busy,
      parked,
    },
    log,
  )
  const working = state === 'working'
  return (
    <button
      aria-current={shown ? 'true' : undefined}
      className={cn(
        'mx-1 flex w-[calc(100%-0.5rem)] cursor-pointer flex-col gap-1 rounded-md px-2 py-1.5 text-left outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring',
        shown && 'bg-sidebar-accent',
      )}
      data-child-conversation={conversation.id}
      data-selected={shown || undefined}
      data-ui="sidebar-row"
      onClick={() => actions.switchConversation(conversation.id)}
      title={conversation.title}
      type="button"
    >
      <span className="flex w-full items-center gap-1.5">
        <Mark state={state} unseen={false} working={working ? 'self' : undefined} />
        {task?.chip}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
          <RunName id={conversation.id} label={conversation.label ?? 'Agent'} /> · #
          {conversation.id}
        </span>
        {conversation.workspace && (
          <GitBranchIcon
            aria-label="Isolated checkout"
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
        <span
          className={cn(
            'shrink-0 text-[10px]',
            working
              ? 'text-brand'
              : state in settled
                ? settled[state as keyof typeof settled].tone
                : 'text-muted-foreground',
          )}
        >
          {working
            ? 'Working'
            : state in settled
              ? settled[state as keyof typeof settled].word
              : 'Idle'}
        </span>
      </span>
      <span className="line-clamp-2 pl-[18px] text-[11px] leading-relaxed break-words text-muted-foreground">
        {task
          ? task.title
          : row?.activity
            ? `${working ? 'Last reply: ' : ''}${row.activity}`
            : (conversation.title ?? 'No reply yet')}
      </span>
    </button>
  )
}
