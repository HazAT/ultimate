import type { ConversationId } from '@earendil-works/pi-durable'
import type { TaskLink } from './refs.ts'

export const statusDots: Record<string, string> = {
  backlog: 'bg-muted-foreground',
  planning: 'bg-muted-foreground',
  todo: 'bg-muted-foreground',
  in_progress: 'animate-pulse-dot bg-brand',
  in_review: 'bg-warning',
  done: 'bg-success',
  blocked: 'bg-error',
  canceled: 'bg-muted-foreground/40',
}

export const PLAN_OPEN = 'plan.open'
export type PlanOpen = { conversation: ConversationId; key: string } | null
export const openRequest = (task: Pick<TaskLink, 'coordinator' | 'key'>): PlanOpen => ({
  conversation: task.coordinator,
  key: task.key,
})
