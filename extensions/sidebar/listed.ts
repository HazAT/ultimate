import type { ConversationId } from '@earendil-works/pi-durable'
/**
 * The top-level conversations the sidebar lists as rows, roots or branches. `unlisted` are the ones another extension
 * shows elsewhere (the `sidebar.unlisted` point): a side chat is a temporary copy of @ultimate whose fork origin is no
 * branch, so it never shows in In flight, Earlier or Concluded; the side-chat extension nests it under @ultimate
 * instead. Browser-safe.
 */
export const topLevelRows = <T extends { id: number; parentConversationId?: ConversationId }>(
  conversations: readonly T[],
  unlisted: ReadonlySet<number>,
) =>
  conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined && !unlisted.has(conversation.id),
  )
