import type { ConversationId, Tx } from '@earendil-works/pi-durable'

export async function scanNonterminalTasks(tx: Tx, kind: string, conversationId: ConversationId) {
  const found = []
  for (const status of ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const) {
    let cursor: Parameters<Tx['scanTasks']>[2]
    do {
      const page = await tx.scanTasks({ conversationId, kind, status }, 100, cursor)
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
  }
  return found
}
