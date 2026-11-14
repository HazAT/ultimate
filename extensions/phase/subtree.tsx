import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
/** The ownership edges of a conversation summary: a subagent is an owned child of the conversation that started it. */
type Node = {
  id: number
  parentConversationId?: ConversationId
  ownerTaskId?: TaskId
  busy: boolean
}

/** Whether a subagent anywhere below `id` is working, so an idle `id` is waiting on it. */
export function subagentsBusy(conversations: readonly Node[], id: number) {
  const below = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const conversation of conversations)
      if (
        conversation.ownerTaskId !== undefined &&
        conversation.parentConversationId !== undefined &&
        below.has(conversation.parentConversationId) &&
        !below.has(conversation.id)
      ) {
        below.add(conversation.id)
        grew = true
      }
  }
  return conversations.some(
    (conversation) => conversation.id !== id && below.has(conversation.id) && conversation.busy,
  )
}
