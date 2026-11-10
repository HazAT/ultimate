/** To-dos for other extensions: add to the project's list from server code, at most once per key. */
import { defineApi } from '../../shared/extension-api.ts'
import type { Todo } from './refs.ts'

export type TodosService = {
  /**
   * Add a to-do for `owner` and return it. A `key` (at most 200 characters) seen before adds nothing and returns the
   * to-do it added, as it is now or, once dropped from the list, as it was when added; the newest 500 keys are kept.
   */
  add(input: { text: string; owner: Todo['owner']; key?: string }): Promise<Todo>
}
/** The project's to-do list; `want` it, to-dos are optional. */
export const TodosApi = defineApi<TodosService>()('todos')
