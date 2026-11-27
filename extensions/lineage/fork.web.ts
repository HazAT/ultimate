import type { EntryRecord } from '@earendil-works/pi-durable'

const timeOf = (entry: EntryRecord | undefined) => {
  const message = entry?.model?.[0]
  return message && 'timestamp' in message ? message.timestamp : undefined
}

const callIn = (entry: EntryRecord, call: string) => {
  const message = entry.model?.[0]
  return (
    message?.role === 'assistant' &&
    message.content.some((block) => block.type === 'toolCall' && block.id === call)
  )
}

export function forkStart(loaded: readonly EntryRecord[], id: number, at: number) {
  const own = loaded.filter((entry) => entry.conversationId === id).toSorted((a, b) => a.id - b.id)
  const inherited = loaded
    .filter((entry) => entry.conversationId !== id && entry.id <= at)
    .toSorted((a, b) => b.id - a.id)
  const point = inherited.find((entry) => entry.id === at)
  const result = point?.model?.[0]
  const call = result?.role === 'toolResult' ? result.toolCallId : undefined
  const caller = call === undefined ? undefined : inherited.find((entry) => callIn(entry, call))
  return {
    at: timeOf(inherited.find((entry) => timeOf(entry))) ?? timeOf(own[0]),
    fresh: own[0]?.kind === 'pi.reset',
    reveal: caller && call ? { entry: caller.id, call } : { entry: at },
  }
}
