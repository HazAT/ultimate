import type { EntryRecord } from '@earendil-works/pi-durable'

const startsContext = (entry: EntryRecord) =>
  entry.kind === 'pi.reset' || entry.kind === 'pi.compaction'

export function reachedFork(loaded: readonly EntryRecord[], id: number | undefined) {
  const rows = loaded.toSorted((a, b) => a.id - b.id)
  const firstOwnEntry = rows.findIndex((entry) => entry.conversationId === id)
  if (firstOwnEntry <= 0 || rows[firstOwnEntry - 1].conversationId === id) return false
  if (startsContext(rows[firstOwnEntry])) return true
  const inheritedContextStart = rows.slice(0, firstOwnEntry).findLast(startsContext)
  if (!inheritedContextStart) return false
  return inheritedContextStart.head === undefined || rows[0].id <= inheritedContextStart.head
}
