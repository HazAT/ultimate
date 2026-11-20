import type { ConversationSummary } from '../../shared/protocol.ts'
import type { OverviewRow } from '../conversations/types.ts'

export function underwayOf(
  conversations: readonly ConversationSummary[],
  overview: Readonly<Record<string, OverviewRow>> | undefined,
  queue: readonly { conversationId: number }[] = [],
) {
  const byId = new Map<number, ConversationSummary>(conversations.map((c) => [c.id, c]))
  const topOf = (id: number) => {
    let parent = byId.get(id)
    while (parent?.ownerTaskId !== undefined && parent.parentConversationId !== undefined) {
      const next = byId.get(parent.parentConversationId)
      if (!next) break
      parent = next
    }
    return parent?.id ?? id
  }
  const busy = new Set(conversations.filter((c) => c.busy).map((c) => topOf(c.id)))
  for (const item of queue) busy.add(item.conversationId)
  return (id: number) => {
    const state = overview?.[id]?.runState
    return busy.has(id) || state === 'working' || state === 'queued'
  }
}
