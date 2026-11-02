/** Tasks in the browser: when the durable tasks of the task tree first ran, and running parked ones again. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** `{ ids }` → `{ [taskId]: startedAt }`: when each task first ran, in milliseconds; unstarted or gone ones are left out. */
export const StartedAction = actionRef<{ ids: number[] }, Record<string, number>>(
  'tasks',
  'started',
)

/**
 * What a task's input says about it, for naming it in plain words: who a message goes to, which automation, which
 * conversation a chore is for. Fixed for the task's life, so asked once per task. Each field is optional: a kind
 * fills the ones it has.
 */
export type TaskFacts = {
  /** A `board.delivery`'s message; in its `reply` phase the answer goes back to `from`. */
  message?: {
    id: number
    from: number | 'user' | 'remote'
    to: number | 'user' | 'remote'
    reply: boolean
    note: boolean
    /** Its first line, shortened. */
    gist: string
  }
  /** The conversation the task works for or waits on, when it is not the one that owns it. */
  conversation?: number
  /** An automation's name. */
  automation?: string
  /** A tool call's tool name. */
  tool?: string
  /** A lander's source checkout. */
  source?: string
}

/** `{ ids }` → `{ [taskId]: facts }`; gone tasks are left out. */
export const DescribeAction = actionRef<{ ids: number[] }, Record<string, TaskFacts>>(
  'tasks',
  'describe',
)
