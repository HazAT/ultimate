import type { ConversationId, EntryRecord, Tx } from '@earendil-works/pi-durable'

export const isInput = (entry: EntryRecord) => entry.kind === 'pi.user' || entry.input === true

export function imagesOf(entry: EntryRecord | undefined) {
  return (entry?.model ?? []).flatMap((message) =>
    (message.role === 'user' || message.role === 'toolResult') &&
    typeof message.content !== 'string'
      ? message.content.flatMap((block) =>
          block.type === 'image'
            ? [{ type: 'image' as const, data: block.data, mimeType: block.mimeType }]
            : [],
        )
      : [],
  )
}

export async function latestImagesEntry(tx: Tx, conversationId: ConversationId) {
  const noImagesInCurrentTurn =
    'images: "latest" found no images in this turn (your current input and the tool results since)'
  let inCurrentTurn = true
  let cursor: Parameters<Tx['scanEntries']>[2]
  do {
    const page = await tx.scanEntries({ conversationId }, 200, cursor)
    for (const entry of page.items) {
      if (imagesOf(entry).length) {
        if (inCurrentTurn) return entry
        throw new Error(
          `${noImagesInCurrentTurn}; entry ${entry.id} has images: pass images: ${entry.id}`,
        )
      }
      if (isInput(entry)) inCurrentTurn = false
    }
    cursor = page.next
  } while (cursor !== undefined)
  throw new Error(`${noImagesInCurrentTurn}; no earlier entry has images either`)
}
