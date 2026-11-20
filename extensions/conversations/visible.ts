import type { ConversationId } from '@earendil-works/pi-durable'
export function hiddenConversationIds(
  conversations: readonly {
    id: number
    parentConversationId?: ConversationId
    branchOf?: { conversationId: ConversationId }
  }[],
  concluded: readonly number[],
) {
  const hidden = new Set(concluded)
  let changed = true
  while (changed) {
    changed = false
    for (const conversation of conversations) {
      const parent = conversation.parentConversationId ?? conversation.branchOf?.conversationId
      if (parent !== undefined && hidden.has(parent) && !hidden.has(conversation.id)) {
        hidden.add(conversation.id)
        changed = true
      }
    }
  }
  return hidden
}
