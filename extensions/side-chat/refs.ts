/** Side chats: temporary copies of @ultimate, their lifecycle actions and passive summaries. Browser-safe. */
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

export type SideChat = {
  of: ConversationId
  at: EntryId
  effects: boolean
  ended?: 'discarded' | 'injected'
}
export type SideChatIndex = {
  sides: { id: ConversationId; at: EntryId; openedAt: number; ended?: 'discarded' | 'injected' }[]
}
export type SideChatSummary = {
  side: ConversationId
  at: EntryId
  from: ConversationId
  to: ConversationId
  questions?: string[]
  text: string
}
/** On the fork; absent `of` means this is not a side chat. Never inherited by forks. */
export const SideChatDoc = docRef<Partial<SideChat>>('sidechat')
/** On main: all its open and ended side chats in opening order, for the sidebar. Never inherited. */
export const SideChatsDoc = docRef<SideChatIndex>('sidechat.index')
/** `{text}` on @ultimate → `{id}`: fork its last completed turn and submit the first input. User-only. */
export const OpenAction = actionRef<{ text: string }, { id: ConversationId }>('side-chat', 'open')
/** `{id}` → `{id}`: abort and conclude an effect-free side chat without writing to main. User-only. */
export const DiscardAction = actionRef<{ id: ConversationId }, { id: ConversationId }>(
  'side-chat',
  'discard',
)
/** `{id}` → `{id}`: abort, summarize into main without waking it, and conclude. Requires summaryModel. User-only. */
export const InjectAction = actionRef<{ id: ConversationId }, { id: ConversationId }>(
  'side-chat',
  'inject',
)
