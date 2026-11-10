/** To-dos in the browser: the project's short list of open loops, each owned by the user or @ultimate. Browser-safe. */
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** One to-do. `done` is when it was ticked, epoch ms; absent while it is open. */
export type Todo = {
  id: number
  text: string
  owner: 'user' | 'ultimate'
  /** When it was added, epoch ms. */
  at: number
  done?: number
}
/** `{ next, items }` on conversation 1: every open to-do and the last 50 done ones, oldest first. */
export const TodosDoc = docRef<{ next: number; items: Todo[] }>('todos')

/**
 * `{ text, owner, key? }` → the new to-do, or the one `key` already added. User-only; @ultimate uses its `todo`
 * tool, server code `TodosApi`.
 */
export const AddAction = actionRef<{ text: string; owner: Todo['owner']; key?: string }, Todo>(
  'todos',
  'add',
)
/** `{ id }` → the to-do, ticked. User-only. */
export const DoneAction = actionRef<{ id: number }, Todo>('todos', 'done')
/** `{ id }` → the to-do, open again. User-only. */
export const ReopenAction = actionRef<{ id: number }, Todo>('todos', 'reopen')
