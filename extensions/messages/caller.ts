import type { EntryRecord } from '@earendil-works/pi-durable'

export const callerOf = (entries: readonly EntryRecord[], call: string) =>
  entries.findLast((entry) => {
    const message = entry.model?.[0]
    return (
      message?.role === 'assistant' &&
      message.content.some((block) => block.type === 'toolCall' && block.id === call)
    )
  })
