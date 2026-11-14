/** Which conversations a pause parked, from the live task graph. Browser-safe. */
import type { ConversationId, TaskGraph } from '@earendil-works/pi-durable'

/**
 * While the host is paused, the conversations whose foreground work it holds: they have live foreground tasks and none
 * of them executes. One whose bash call or model response still runs is not parked yet. Empty while not paused.
 */
export function parkedConversations(graph: TaskGraph | undefined, paused: boolean) {
  const parked = new Set<ConversationId>()
  if (!paused) return parked
  const executing = new Set<ConversationId>()
  for (const task of Object.values(graph?.tasks ?? {})) {
    if (task.background) continue
    parked.add(task.conversationId)
    if (task.state.status === 'running') executing.add(task.conversationId)
  }
  for (const id of executing) parked.delete(id)
  return parked
}
