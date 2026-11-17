import type { ConversationId, TaskGraph } from '@earendil-works/pi-durable'

export function parkedConversations(graph: TaskGraph | undefined, paused: boolean) {
  const parked = new Set<ConversationId>()
  if (!paused) return parked
  const stillExecutingConversations = new Set<ConversationId>()
  for (const task of Object.values(graph?.tasks ?? {})) {
    if (task.background) continue
    parked.add(task.conversationId)
    if (task.state.status === 'running') stillExecutingConversations.add(task.conversationId)
  }
  for (const id of stillExecutingConversations) parked.delete(id)
  return parked
}
