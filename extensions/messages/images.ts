import { int, lit, union } from '@earendil-works/pi-schema'
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
/** An image as a message's input carries it. */
export type Image = { type: 'image'; data: string; mimeType: string }

/**
 * The images the user attached to an answer, checked as a submitted input's are: at most `maxImages`, each a supported
 * type in canonical base64 of at most 2 MiB.
 */
export function checkImages(value: unknown): Image[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('images must be a list')
  if (value.length > maxImages) throw new Error(`At most ${maxImages} images go with an answer`)
  return value.map((image: unknown) => {
    const { data, mimeType } = (image ?? {}) as Record<string, unknown>
    if (
      typeof mimeType !== 'string' ||
      !imageMimeTypes.includes(mimeType) ||
      typeof data !== 'string' ||
      !data ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
      Buffer.from(data, 'base64').toString('base64') !== data
    )
      throw new Error('Each image must be a PNG, JPEG, WebP or GIF in base64')
    if (Buffer.byteLength(data, 'base64') > maxImageBytes) throw new Error('An image exceeds 2 MiB')
    return { type: 'image' as const, data, mimeType }
  })
}
export const imagesParameter = union([lit('latest'), int({ minimum: 1 })], {
  description:
    'Forward images from your conversation: "latest" for those of this turn (your current input, or a tool result such as a screenshot since; it fails when there are none), or an entry id for older ones.',
})
