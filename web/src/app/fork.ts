import type { EntryRecord } from '@earendil-works/pi-durable'

const startsContext = (entry: EntryRecord) =>
  entry.kind === 'pi.reset' || entry.kind === 'pi.compaction'

/**
 * Whether the loaded rows of conversation `id` hold everything its first context shows, so paging can stop: its oldest
 * own entry, the source's entry right before it, and, unless the fork starts its own context, the source's context the
 * fork carries in: its last context start before the fork, and for a compaction the entries it kept from its `head` on.
 */
export function reachedFork(loaded: readonly EntryRecord[], id: number | undefined) {
  const rows = loaded.toSorted((a, b) => a.id - b.id)
  const own = rows.findIndex((entry) => entry.conversationId === id)
  if (own <= 0 || rows[own - 1].conversationId === id) return false
  if (startsContext(rows[own])) return true
  const start = rows.slice(0, own).findLast(startsContext)
  if (!start) return false
  return start.head === undefined || rows[0].id <= start.head
}
