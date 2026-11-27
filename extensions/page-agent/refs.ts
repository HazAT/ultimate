/** The page agent in the browser: the UI requests waiting for a page, and the actions a page claims and answers them with. Browser-safe. */
import type { JsonValue } from '@earendil-works/chord/json'
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** One `ui` tool call: ui-sdk `query`, `act` or `snapshot` input, run on the user's own page. */
export type PageAgentCall = {
  id: string
  /** The conversation whose `ui` call waits for it. */
  conversation: ConversationId
  task: TaskId
  op: 'query' | 'act' | 'snapshot'
  input?: JsonValue
  at: number
  /** The page the caller named: only it may claim the request. Without one, any visible page may. */
  page?: string
  /** The page that claimed it: only that page runs it and answers. */
  claimed?: string
}

/** `{ calls }` on conversation 1: every `ui` request still waiting for its answer, oldest first. */
export const PageAgentDoc = docRef<{ calls: PageAgentCall[] }>('page-agent.calls')

/**
 * `{ id, page, visible }` → whether this page now holds UI request `id`. The named page, or any visible page when none
 * is named, may claim an unclaimed, unexpired request; the first claim wins, and only that page runs it, once.
 */
export const ClaimAction = actionRef<
  { id: string; page: string; visible: boolean },
  { claimed: boolean }
>('page-agent', 'claim')

/** `{ id, page, result }` → the claiming page's result for UI request `id`, which wakes the waiting `ui` tool call. */
export const AnswerAction = actionRef<
  { id: string; page: string; result: JsonValue },
  Record<string, never>
>('page-agent', 'answer')
