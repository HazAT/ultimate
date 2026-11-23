import type { ConversationId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { imageMimeTypes, maxImageBytes, maxImages } from '../shared/protocol.ts'

export const isInput = (entry: EntryRecord) => entry.kind === 'pi.user' || entry.input === true

export const SCAN_PAGE = 200

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

export function forwardableImages(entry: EntryRecord | undefined) {
  const images = imagesOf(entry)
  if (images.length > maxImages) return []
  return images.filter(
    (image) =>
      (imageMimeTypes as readonly string[]).includes(image.mimeType) &&
      Buffer.byteLength(image.data, 'base64') <= maxImageBytes,
  )
}

export async function latestImagesEntry(tx: Tx, conversationId: ConversationId) {
  const noImagesInCurrentTurn = new Error(
    'images: "latest" found no images in this turn (your current input and the tool results since); pass an entry id to forward an older one',
  )
  let cursor: Parameters<Tx['scanEntries']>[2]
  do {
    const page = await tx.scanEntries({ conversationId }, SCAN_PAGE, cursor)
    for (const entry of page.items) {
      if (imagesOf(entry).length) return entry
      if (isInput(entry)) throw noImagesInCurrentTurn
    }
    cursor = page.next
  } while (cursor !== undefined)
  throw noImagesInCurrentTurn
}

const HINT_PAGE_LIMIT = 3
const HINT_IDS = 3

export async function imagesHint(tx: Tx, conversationId: ConversationId) {
  const usable: string[] = []
  let cursor: Parameters<Tx['scanEntries']>[2]
  let pages = 0
  let seenImages = false
  do {
    const page = await tx.scanEntries({ conversationId }, SCAN_PAGE, cursor)
    pages += 1
    seenImages ||= page.items.some((entry) => imagesOf(entry).length > 0)
    for (const entry of page.items) {
      const count = forwardableImages(entry).length
      if (count) {
        usable.push(`${entry.id} (${count})`)
        if (usable.length === HINT_IDS)
          return `entries with images here, newest first: ${usable.join(', ')}`
      }
    }
    cursor = page.next
  } while (cursor !== undefined && pages < HINT_PAGE_LIMIT)
  return usable.length
    ? `entries with images here, newest first: ${usable.join(', ')}`
    : seenImages
      ? 'recent entries here have images, but none forwardable (type, size or count)'
      : 'no recent entry here has images (captures made inside codemode never become entries; a direct screenshot or browser call does)'
}
