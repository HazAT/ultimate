/**
 * Questions in the browser: the actions that answer an agent's questions to the user from its message's card.
 * Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** One answered question: the question's text and the chosen or typed answer, a multiple choice's as a list. */
export type Answer = { question: string; answer: string | string[] }

/**
 * `{ messageId, answers?, note? }` or `{ messageId, text }` → `{ id }`: answer open message `messageId` with a reply
 * to its sender, from its questions (`note` goes after the answer lines) or as free text; `id` is the reply's message
 * id. Fails when the message no longer waits on the user.
 */
export const AnswerAction = actionRef<
  { messageId: number; answers?: Answer[]; note?: string; text?: string },
  { id: number }
>('questions', 'answer')
/**
 * `{ messageId }` → `{ id }`: close open message `messageId` without an answer; its sender gets a one-way note,
 * `id`, that starts no run. Fails when the message no longer waits on the user.
 */
export const DismissAction = actionRef<{ messageId: number }, { id: number }>(
  'questions',
  'dismiss',
)
