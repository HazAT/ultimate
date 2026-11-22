/** The plan for other extensions' Solid code: the task chip of a conversation that works on a plan task. */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { Accessor } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { ROOT, cn, switchConversation, useDocOf, useUiState } from '@/sdk/solid'
import { openRequest, PLAN_OPEN, statusDots } from './status.ts'
import type { PlanOpen } from './status.ts'
import { TaskIndexDoc } from './refs.ts'
import type { TaskLink } from './refs.ts'

/** The plan task conversation `id()` works on, if a coordinator linked it. */
export function useTaskOf(
  id: Accessor<ConversationId | undefined>,
): Accessor<TaskLink | undefined> {
  const index = useDocOf(() => ROOT, TaskIndexDoc)
  return () => {
    const conversation = id()
    return conversation === undefined ? undefined : index()?.children[String(conversation)]
  }
}

/** Show the task's coordinator with the task open in its plan (`plan.open`). */
export function useOpenTask() {
  const [, setOpen] = useUiState<PlanOpen>(PLAN_OPEN, null)
  return (task: Pick<TaskLink, 'coordinator' | 'key'>) => {
    switchConversation(task.coordinator)
    setOpen(openRequest(task))
  }
}

/**
 * A task's key with its status dot; click shows its coordinator with the task open in its plan (`plan.open`). A
 * button: place it beside a row's button, not inside it.
 */
export function TaskChip(props: { task: TaskLink; on?: string; class?: string }) {
  const open = useOpenTask()
  return (
    <Button
      aria-label={`Open task #${props.task.coordinator}/${props.task.key}: ${props.task.title}${props.on ? ` (${props.on})` : ''}`}
      class={cn(
        'inline-flex shrink-0 items-center gap-1 rounded bg-muted/60 px-1.5 font-mono text-[10px] leading-4 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        props.class,
      )}
      data-task={props.task.key}
      onClick={() => open(props.task)}
      size={null}
      variant={null}
      title={`#${props.task.coordinator}/${props.task.key} · ${props.task.title} · ${props.task.status.replace('_', ' ')}`}
    >
      <span
        class={cn(
          'size-1.5 shrink-0 rounded-full',
          statusDots[props.task.status] ?? statusDots.todo,
        )}
      />
      {props.task.key}
    </Button>
  )
}
