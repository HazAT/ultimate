import type { EntryRecord } from '@earendil-works/pi-durable'

const startsContext = (entry: EntryRecord) =>
  entry.kind === 'pi.reset' || entry.kind === 'pi.compaction'

const timeOf = (entry: EntryRecord | undefined) => {
  const message = entry?.model?.[0]
  return message && 'timestamp' in message ? message.timestamp : undefined
}

export function forkStart(loaded: readonly EntryRecord[], id: number, at: number) {
  const own = loaded.filter((entry) => entry.conversationId === id).toSorted((a, b) => a.id - b.id)
  if (own.length === 0) return undefined
  const inherited = loaded.filter((entry) => entry.conversationId !== id && entry.id <= at)
  const lastTimed = inherited.toSorted((a, b) => b.id - a.id).find((entry) => timeOf(entry))
  return {
    at: timeOf(lastTimed) ?? timeOf(own[0]),
    fresh: own[0].kind === 'pi.reset',
  }
}

export function reachedFork(loaded: readonly EntryRecord[], id: number | undefined) {
  const rows = loaded.toSorted((a, b) => a.id - b.id)
  const firstOwnEntry = rows.findIndex((entry) => entry.conversationId === id)
  if (firstOwnEntry <= 0 || rows[firstOwnEntry - 1].conversationId === id) return false
  if (startsContext(rows[firstOwnEntry])) return true
  const inheritedContextStart = rows.slice(0, firstOwnEntry).findLast(startsContext)
  if (!inheritedContextStart) return false
  return inheritedContextStart.head === undefined || rows[0].id <= inheritedContextStart.head
}
