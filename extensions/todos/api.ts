/** To-dos for other extensions: add to the project's list and carry open to-dos into a new chapter. */
import type { Tx } from '@earendil-works/pi-durable'
import { defineApi } from '../../shared/extension-api.ts'
import type { Todo } from './refs.ts'

export type TodosService = {
  /**
   * Add a to-do for `owner` and return it. A `key` (at most 200 characters) seen before adds nothing and returns the
   * to-do it added, as it is now or, once dropped from the list, as it was when added; the newest 500 keys are kept.
   */
  add(input: { text: string; owner: Todo['owner']; key?: string }): Promise<Todo>
  /** Read the open items' text and owner inside the caller's transaction. */
  listOpen(tx: Tx): Promise<Pick<Todo, 'text' | 'owner'>[]>
  /** Add an item carried into a new chapter in the seed commit, preserving its full text. */
  addCarried(tx: Tx, item: Pick<Todo, 'text' | 'owner'>): Promise<Todo>
}
/** The panel counts what waits in the Inbox beside the to-dos; without inbox it shows the to-dos alone. */
export const wants = ['inbox']
/** The project's to-do list; `want` it, to-dos are optional. */
export const TodosApi = defineApi<TodosService>()('todos')
