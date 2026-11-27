import type { EntryRecord } from '@earendil-works/pi-durable'

const timeOf = (entry: EntryRecord | undefined) => {
  const message = entry?.model?.[0]
  return message && 'timestamp' in message ? message.timestamp : undefined
}

export function forkStart(loaded: readonly EntryRecord[], id: number, at: number) {
  const own = loaded.filter((entry) => entry.conversationId === id).toSorted((a, b) => a.id - b.id)
  if (own.length === 0) return undefined
  const lastTimed = loaded
    .filter((entry) => entry.conversationId !== id && entry.id <= at)
    .toSorted((a, b) => b.id - a.id)
    .find((entry) => timeOf(entry))
  return { at: timeOf(lastTimed) ?? timeOf(own[0]), fresh: own[0].kind === 'pi.reset' }
}
