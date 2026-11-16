import type { ConversationId } from '@earendil-works/pi-durable'
export const topLevelRows = <T extends { id: number; parentConversationId?: ConversationId }>(
  conversations: readonly T[],
  unlisted: ReadonlySet<number>,
) =>
  conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined && !unlisted.has(conversation.id),
  )
