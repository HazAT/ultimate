/** The plan's components for other extensions: the task chip of a conversation that works on a plan task. */
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  CircleIcon,
  CircleSlashIcon,
} from 'lucide-react'
import { useCallback } from 'react'
import type { SyntheticEvent } from 'react'
import { cn, useDocOf, useUiState, useUltimate } from '@/sdk'
import { TaskIndexDoc } from './refs.ts'
import type { TaskLink } from './refs.ts'

const statuses: Record<string, { icon: typeof CircleIcon; tone: string; dot: string }> = {
  backlog: { icon: CircleDashedIcon, tone: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  planning: { icon: CircleDashedIcon, tone: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  todo: { icon: CircleIcon, tone: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  in_progress: {
    icon: CircleDotIcon,
    tone: 'border-brand/40 text-brand',
    dot: 'animate-pulse-dot bg-brand',
  },
  in_review: {
    icon: CircleEllipsisIcon,
    tone: 'border-warning/40 text-warning',
    dot: 'bg-warning',
  },
  done: { icon: CircleCheckIcon, tone: 'border-success/40 text-success', dot: 'bg-success' },
  blocked: { icon: CircleAlertIcon, tone: 'border-error/40 text-error', dot: 'bg-error' },
  canceled: {
    icon: CircleSlashIcon,
    tone: 'text-muted-foreground line-through',
    dot: 'bg-muted-foreground/40',
  },
}
export const statusOf = (status: string) => statuses[status] ?? statuses.todo

export function StatusIcon({ status }: { status: string }) {
  const { icon: Icon, tone } = statusOf(status)
  return <Icon aria-label={status} className={cn('size-3.5 shrink-0', tone)} />
}

const noTasks: Record<string, TaskLink> = {}

/** Every linked child conversation id → its plan task, live from the root's `ultimate.plan.tasks`. */
export function useTaskIndex() {
  return useDocOf(1, TaskIndexDoc)?.children ?? noTasks
}

/** The plan task conversation `id` works on, if a coordinator linked it. */
export function useTaskOf(id: number | undefined): TaskLink | undefined {
  const index = useTaskIndex()
  return id === undefined ? undefined : index[String(id)]
}

/** Show the task's coordinator and ask its plan panel to open the task (durable UI state `plan.open`). */
export function useOpenTask() {
  const { switchConversation } = useUltimate()
  const [, setOpen] = useUiState<{ conversation: number; key: string } | null>('plan.open', null)
  return useCallback(
    (task: Pick<TaskLink, 'coordinator' | 'key'>) => {
      switchConversation(task.coordinator)
      setOpen({ conversation: task.coordinator, key: task.key })
    },
    [switchConversation, setOpen],
  )
}

/**
 * A task's key with its status dot; click opens the task in its coordinator's plan.
 * A `span` with the button role: it sits inside row buttons, which cannot nest buttons.
 */
export function TaskChip({ task, className }: { task: TaskLink; className?: string }) {
  const openTask = useOpenTask()
  const open = (event: SyntheticEvent) => {
    event.stopPropagation()
    event.preventDefault()
    openTask(task)
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center gap-1 rounded bg-muted/60 px-1.5 font-mono text-[0.625rem] leading-4 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
      data-task={task.key}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') open(event)
      }}
      role="button"
      tabIndex={0}
      title={`#${task.coordinator}/${task.key} · ${task.title} · ${task.status.replace('_', ' ')}`}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', statusOf(task.status).dot)} />
      {task.key}
    </span>
  )
}
