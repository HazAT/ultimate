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
import { useId, useRef, useState } from 'react'
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
  agentTitle,
  ConversationPhase,
  ConversationTask,
  FeatureTag,
  RenameAction,
} from '../conversations/ui.tsx'
import type { Presence } from '../conversations/ui.tsx'
import { Review } from '../workspaces/ui.tsx'
import type { WorkspaceConversation as ConversationSummary } from '../workspaces/ui.tsx'
import type { OverviewRow } from '../conversations/types.ts'
import type { ConversationState } from '../messages/ui.tsx'

/** What a row's mark and state word say for each settled state; `working` and `idle` show no icon. */
const settled = {
  awaiting: {
    label: 'Awaiting @ultimate',
    word: 'Awaiting @ultimate',
    tone: 'text-amber-700 dark:text-amber-300',
  },
  done: { label: 'Done: its answer went to its parent', word: 'Done', tone: 'text-success' },
  failed: { label: 'Its latest run failed', word: 'Failed', tone: 'text-error' },
  paused: { label: 'Paused: its run continues on Play', word: 'Paused', tone: 'text-warning' },
} as const

/** The leading mark: working (pulsing), a settled state's icon, an unseen answer (solid), or an empty slot that keeps titles aligned. */
function Mark({
  working,
  unseen,
  state,
}: {
  working?: 'self' | 'subagents'
  unseen: boolean
  state?: ConversationState
}) {
  const shown = !working && state && state in settled ? (state as keyof typeof settled) : undefined
  const label = working
    ? working === 'self'
      ? 'Working'
      : 'Subagents working'
    : shown
      ? settled[shown].label
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
              ) : shown === 'awaiting' ? (
                <CircleHelpIcon className="size-3.5" />
              ) : shown === 'failed' ? (
                <CircleXIcon className="size-3.5" />
              ) : shown === 'paused' ? (
                <PauseIcon className="size-3" />
              ) : (
                <span
                  className={cn('size-1.5 rounded-full bg-brand', working && 'animate-pulse-dot')}
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
  activity?: string
  feature?: string
}

/** One top-level conversation: click shows it; the menu renames, clears, concludes or resumes it. */
export function Row(props: RowProps) {
  return (
    <Provided input={props.working ? props.conversation.id : undefined} point={ConversationPhase}>
      {(phase) => <PhasedRow {...props} displayPhase={phase} />}
    </Provided>
  )
}

/** A row with its working phase, when one is known: the phase line makes the row taller. */
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
  activity,
  displayPhase,
}: RowProps & { displayPhase?: { label: ReactNode } }) {
  const hasActivity = !!(displayPhase || activity)
  // One indicator per row: the phase line's pulsing dot, else the leading mark's while no phase is known yet.
  const markWorking = displayPhase ? undefined : working
  const actions = useShell()
  const [editing, setEditing] = useState(false)
  const cancelled = useRef(false)
  /** Whether the row button takes focus back once the field closes: after Enter or Escape, not a click elsewhere. */
  const refocus = useRef(false)
  const name =
    conversation.title ??
    (draft
      ? 'Untitled conversation'
      : conversation.workspace
        ? 'Untitled conversation'
        : `#${conversation.id}`)
  const latest = Math.max(conversation.inputAt ?? 0, conversation.answerAt ?? 0)
  const hasMetadata = feature || conversation.workspace || latest > 0
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
      title={name}
    >
      {name}
    </span>
  )
  return (
    <div
      className={cn(
        'group relative mx-2 flex items-center rounded-md transition-colors',
        hasActivity ? 'h-[58px]' : hasMetadata ? 'h-11' : 'h-7',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={conversation.id}
    >
      {editing ? (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-1.5">
          <Mark state={state} unseen={unseen} working={markWorking} />
          <input
            aria-label="Conversation title"
            autoFocus
            className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            defaultValue={conversation.title ?? ''}
            onBlur={(event) => save(event.currentTarget.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                // Without it, the keypress lands on the refocused row button and opens the row.
                event.preventDefault()
                refocus.current = true
                event.currentTarget.blur()
              }
              if (event.key === 'Escape') {
                cancelled.current = true
                refocus.current = true
                event.currentTarget.blur()
              }
            }}
          />
        </div>
      ) : (
        <button
          aria-current={shown ? 'true' : undefined}
          className="flex h-full min-w-0 flex-1 cursor-pointer flex-col justify-center rounded-md pr-2 pl-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => actions.switchConversation(conversation.id)}
          ref={(element) => {
            if (!element || !refocus.current) return
            refocus.current = false
            element.focus()
          }}
          type="button"
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <Mark state={state} unseen={unseen} working={markWorking} />
            {title}
          </span>
          {hasMetadata && (
            <span className="flex w-full items-center gap-2 pr-5 pl-[18px] font-mono text-[10px] leading-4 text-muted-foreground">
              {feature && <FeatureTag feature={feature} />}
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

/**
 * A conversation's `…` menu, at its row's bottom right on hover or focus: its workspace and changes when isolated,
 * Rename, Compact context, and Conclude or Resume.
 */
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
  /** What a menu item does once the menu has closed, so focus lands where it should. */
  const afterMenu = useRef<() => void>(undefined)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Conversation actions"
        className="invisible absolute right-1 bottom-1 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
      >
        <EllipsisIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-44 [&_[role=menuitem]]:cursor-pointer"
        onCloseAutoFocus={(event) => {
          const next = afterMenu.current
          afterMenu.current = undefined
          if (!next) return
          event.preventDefault()
          next()
        }}
      >
        {conversation.workspace && (
          <DropdownMenuItem
            className="cursor-pointer text-[12.5px]"
            onSelect={() =>
              (afterMenu.current = () => {
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
                  onSelect={() => (afterMenu.current = open)}
                >
                  <FileDiffIcon />
                  Review changes
                </DropdownMenuItem>
              )
            }
          </Provided>
        )}
        <DropdownMenuItem className="text-[12.5px]" onSelect={() => (afterMenu.current = onRename)}>
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

/** Saves a conversation's new title; an empty one clears it. Failures show as a notification. */
export function saveTitle(id: number, value: string) {
  void api
    .action(RenameAction, { id, title: value.trim() })
    .catch((error: unknown) => store.notify({ level: 'error', message: errorMessage(error) }))
}

/**
 * A standing agent or the lander: its fixed `@name`, a leading status mark and one quiet line of state, never a
 * summary or feature. Click opens it; the menu only compacts its context: it is never cleared, renamed or
 * concluded.
 */
export function StandingRow({
  conversation,
  name,
  shown,
  presence,
  onOpen,
  children,
}: {
  /** Missing until @ultimate's conversation is first opened. */
  conversation?: ConversationSummary
  /** The agent's name without `@`: `ultimate`, `lander`, `sync`, … */
  name: string
  shown: boolean
  presence: Presence
  onOpen: () => void
  children: ReactNode
}) {
  const label = useId()
  return (
    <div
      className={cn(
        'group relative mx-2 flex h-11 items-center rounded-md transition-colors',
        shown ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/50',
      )}
      data-conversation={conversation?.id}
      data-standing={name}
    >
      <button
        aria-current={shown ? 'true' : undefined}
        aria-labelledby={label}
        className="absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onOpen}
        type="button"
      />
      {/* Clicks pass through to the row's button beneath, except on a control of the state line. */}
      <span
        className="pointer-events-none relative flex h-full min-w-0 flex-1 items-center gap-2.5 pr-2 pl-2 text-left [&_button]:pointer-events-auto"
        id={label}
      >
        <AgentMark name={name} presence={presence} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {name === 'ultimate' ? (
              // The title bar's wordmark: Ultimate's own name is the brand.
              <span className="truncate font-sans text-[11.5px] leading-5 font-semibold tracking-[0.28em] text-brand">
                ULTIMATE
              </span>
            ) : (
              <span className="truncate text-[13px] leading-5 font-semibold text-foreground">
                {agentTitle(name)}
              </span>
            )}
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">@{name}</span>
          </span>
          <span className="flex w-full min-w-0 items-center gap-2 pr-5 font-mono text-[10px] leading-4 text-muted-foreground">
            {children}
          </span>
        </span>
      </span>
      {conversation && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Conversation actions"
            className="invisible absolute right-1 bottom-1 flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none group-focus-within:visible group-hover:visible pointer-coarse:visible hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:visible data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
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

/** Compacts a conversation's context: the gist stays, older turns leave it; the history stays stored. */
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
  /** The primary agent's conversation. */
  primary?: number
  /** A pause parked its run. */
  parked?: boolean
}

/**
 * A subagent in one line under an In flight branch: its mark, plan chip, role and `#id`, and its state word; its
 * latest activity (or plan task) on hover. `depth` indents a subagent's own subagents.
 */
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
  primary,
  parked,
  depth,
  task,
}: ChildRowProps & { depth: number; task?: { chip: ReactNode; title: string } }) {
  const actions = useShell()
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const state = conversationState(
    {
      id: conversation.id,
      kind: 'subagent',
      runState: row?.runState,
      busy: conversation.busy,
      parked,
      primary,
    },
    log,
  )
  const working = state === 'working'
  const known = state in settled ? settled[state as keyof typeof settled] : undefined
  return (
    <button
      aria-current={shown ? 'true' : undefined}
      className={cn(
        'mx-2 flex h-6 w-[calc(100%-1rem)] min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left font-mono text-[10.5px] outline-none hover:bg-sidebar-accent/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
        shown && 'bg-sidebar-accent',
      )}
      data-child-conversation={conversation.id}
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
        {conversation.label ?? 'agent'}
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

/** A subagent under its conversation; one working on a plan task leads with its chip and shows the task's title. */
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
  primary,
  parked,
  task,
}: ChildRowProps & { task?: { chip: ReactNode; title: string } }) {
  const actions = useShell()
  const log = useDocOf(1, MessagesDoc) ?? emptyMessages
  const state = conversationState(
    {
      id: conversation.id,
      kind: 'subagent',
      runState: row?.runState,
      busy: conversation.busy,
      parked,
      primary,
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
      onClick={() => actions.switchConversation(conversation.id)}
      title={conversation.title}
      type="button"
    >
      <span className="flex w-full items-center gap-1.5">
        <Mark state={state} unseen={false} working={working ? 'self' : undefined} />
        {task?.chip}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/80">
          {conversation.label ?? 'Agent'} · #{conversation.id}
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
