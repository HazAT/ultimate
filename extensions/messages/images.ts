import { Type } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { imagesOf, latestImagesEntry } from '../../lib/entries.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'

/**
 * Which images to forward: `latest`, the newest entry with images in the sender's current turn (its input or a tool
 * result such as a screenshot since), or an entry's id.
 */
export type ImagesRef = 'latest' | number
export const SCAN_PAGE = 200
/** Resolve `ref` against conversation `from`'s visible history to the entry holding the images, checking the limits. */
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
          minEntryId: ref as EntryId,
          maxEntryId: ref as EntryId,
        },
        1,
      )
    ).items[0]
    if (!entry) throw new Error(`images: entry ${ref} is not in this conversation`)
  }
  const images = imagesOf(entry)
  if (!images.length) throw new Error(`images: entry ${entry.id} has no images`)
  if (images.length > maxImages)
    throw new Error(
      `images: entry ${entry.id} has ${images.length} images; at most ${maxImages} go along`,
    )
  for (const image of images)
    if (
      !imageMimeTypes.includes(image.mimeType) ||
      Buffer.byteLength(image.data, 'base64') > maxImageBytes
    )
      throw new Error(`images: entry ${entry.id} has an unsupported image or one over 2 MiB`)
  return { entry: entry.id, count: images.length }
}
export const imagesParameter = Type.Union([Type.Literal('latest'), Type.Integer({ minimum: 1 })], {
  description:
    'Forward images from your conversation: "latest" for those of this turn (your current input, or a tool result such as a screenshot since; it fails when there are none), or an entry id for older ones.',
})
