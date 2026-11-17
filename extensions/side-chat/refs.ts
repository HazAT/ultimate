/** Side chats: temporary copies of @ultimate or of a question's asker, their lifecycle actions and passive summaries. Browser-safe. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import type { Reply } from '../questions/refs.ts'

export type SideChat = {
  of: ConversationId
  at: EntryId
  effects: boolean
  ended?: 'discarded' | 'injected'
  /** The open question (its message id) this read-only copy of its asker talks through. */
  question?: number
  /** Context tokens of the asker's last model call before the fork, what the first turn sends. */
  tokens?: number
}
export type SideChatIndex = {
  sides: {
    id: ConversationId
    at: EntryId
    openedAt: number
    ended?: 'discarded' | 'injected'
    question?: number
  }[]
}
export type QuestionSide = {
  id: ConversationId
  of: ConversationId
  question: number
  ended?: 'discarded' | 'injected'
}
export type SideChatSummary = {
  side: ConversationId
  at: EntryId
  from: ConversationId
  to: ConversationId
  questions?: string[]
  /** The question's message id, for a side chat that talked one through. */
  question?: number
  text: string
}
/** On the fork; absent `of` means this is not a side chat. Never inherited by forks. */
export const SideChatDoc = docRef<Partial<SideChat>>('sidechat')
/** On the forked conversation: all its open and ended side chats in opening order. Never inherited. */
export const SideChatsDoc = docRef<SideChatIndex>('sidechat.index')
/** On conversation 1: every question's side chat, open or ended, so a card finds its own. */
export const QuestionSidesDoc = docRef<{ sides: QuestionSide[] }>('sidechat.questions')
/**
 * `{text}` on @ultimate → `{id}`: fork its last completed turn and submit the first input. `{message}` → `{id}`: fork
 * the open question's asker at the question, read-only, or return the side chat already open for it. User-only.
 */
export const OpenAction = actionRef<{ text: string } | { message: number }, { id: ConversationId }>(
  'side-chat',
  'open',
)
/** `{id}` → `{id}`: abort and conclude an effect-free side chat without writing to main. User-only. */
export const DiscardAction = actionRef<{ id: ConversationId }, { id: ConversationId }>(
  'side-chat',
  'discard',
)
/**
 * `{id, answer?}` → `{id}`: abort, summarize into main without waking it, and conclude. With `answer` (a question
 * side chat, `{answers?, note?}` or `{text}` as for questions' answer), the same durable task then answers the open
 * question; it is refused up front when the question is no longer open. Requires summaryModel. User-only.
 */
export const InjectAction = actionRef<
  {
    id: ConversationId
    answer?: Reply
  },
  { id: ConversationId }
>('side-chat', 'inject')
