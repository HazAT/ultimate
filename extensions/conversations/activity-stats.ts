import type { Context } from '@earendil-works/chord/context'
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryQuery,
  Harness,
} from '@earendil-works/pi-durable'
import { UsageDoc } from '@earendil-works/pi-durable'
import { isInput } from '../../lib/entries.shared.ts'
import { offsetEntryId, parseEntryId } from '../../lib/ids.shared.ts'

type Counts = { turns: number; calls: number; lastAt?: number }
type Checkpoint = Counts & { entry: EntryId }
const histories = new WeakMap<Harness, Map<ConversationId, Checkpoint>>()

export async function activityStats(harness: Harness, ids: ConversationId[], context: Context) {
  let history = histories.get(harness)
  if (!history) histories.set(harness, (history = new Map()))
  const result: Record<string, Counts & { cost: number }> = {}
  for (const id of ids) {
    const conversation = await harness.conversation(id, context)
    if (!conversation) {
      history.delete(id)
      continue
    }
    const tally: Checkpoint = {
      ...(history.get(id) ?? { turns: 0, calls: 0, entry: parseEntryId(0) }),
    }
    const query: Omit<EntryQuery, 'conversationId'> = {
      minEntryId: offsetEntryId(tally.entry, 1),
      order: 'ascending',
    }
    let cursor: Cursor | undefined
    do {
      const page = await conversation.entries(query, 256, cursor, context)
      for (const entry of page.items) {
        tally.entry = entry.id
        if (entry.conversationId !== id) continue
        if (isInput(entry)) tally.turns++
        const first = entry.model?.[0]
        if (first?.role === 'assistant')
          for (const block of first.content) if (block.type === 'toolCall') tally.calls++
        for (const message of entry.model ?? [])
          tally.lastAt = Math.max(tally.lastAt ?? message.timestamp, message.timestamp)
      }
      cursor = page.next
    } while (cursor !== undefined)
    const previous = history.get(id)
    const latest = previous && previous.entry >= tally.entry ? previous : tally
    history.set(id, latest)
    const { turns, calls, lastAt } = latest
    const usage = await harness.snapshot(UsageDoc, id, context)
    const cost = usage
      ? [...Object.values(usage.models), ...Object.values(usage.tools)].reduce(
          (sum, bucket) => sum + bucket.cost.total,
          0,
        )
      : 0
    result[id] = { turns, calls, cost, ...(lastAt === undefined ? {} : { lastAt }) }
  }
  return result
}
