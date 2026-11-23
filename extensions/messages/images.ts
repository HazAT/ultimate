import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { int, lit, union } from '@earendil-works/pi-schema'
import { forwardableImages, imagesHint, imagesOf, latestImagesEntry } from '../../lib/entries.ts'
import { maxImages } from '../../shared/protocol.ts'

export type ImagesRef = 'latest' | EntryId

export async function resolveImages(tx: Tx, from: ConversationId, ref: ImagesRef) {
  let entry: EntryRecord | undefined
  if (ref === 'latest') entry = await latestImagesEntry(tx, from)
  else {
    if (!Number.isInteger(ref) || ref < 1)
      throw new Error('images must be "latest" or the id of an entry with images')
    entry = (
      await tx.scanEntries(
        {
          conversationId: from,
          minEntryId: ref,
          maxEntryId: ref,
        },
        1,
      )
    ).items[0]
    if (!entry)
      throw new Error(
        `images: entry ${ref} is not in this conversation; ${await imagesHint(tx, from)}`,
      )
  }
  const images = imagesOf(entry)
  if (!images.length)
    throw new Error(`images: entry ${entry.id} has no images; ${await imagesHint(tx, from)}`)
  if (images.length > maxImages)
    throw new Error(
      `images: entry ${entry.id} has ${images.length} images; at most ${maxImages} go along`,
    )
  if (forwardableImages(entry).length < images.length)
    throw new Error(`images: entry ${entry.id} has an unsupported image or one over 2 MiB`)
  return { entry: entry.id, count: images.length }
}
export const imagesParameter = union([lit('latest'), int({ minimum: 1 })], {
  description:
    'Forward images from your conversation: "latest" for those of this turn (your current input, or a tool result such as a screenshot since; it fails when there are none), or an entry id for older ones. The confirmation names the entry id it used, and a failed reference names usable ones.',
})
