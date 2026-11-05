/**
 * Landing evidence: the screenshots a submitter attaches to `workspace submit`, and the rule that says when a diff
 * wants them. The screenshots stay in the submitter's conversation entries; a submission carries only the reference.
 */
import type { ConversationId, EntryId, EntryRecord, Tx } from '@earendil-works/pi-durable'
import { imagesOf, latestImagesEntry } from '../../lib/entries.ts'
import { imageMimeTypes, maxImageBytes, maxImages } from '../../shared/protocol.ts'

/**
 * Which screenshots to attach: `latest`, the newest entry with images in the submitter's current turn (its input or a
 * tool result such as a screenshot since), or an entry's id.
 */
export type ImagesRef = 'latest' | number

/** Resolve `ref` against conversation `from`'s history to the entry holding the screenshots, checking the limits. */
export async function resolveEvidence(tx: Tx, from: ConversationId, ref: ImagesRef) {
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
      `images: entry ${entry.id} has ${images.length} images; at most ${maxImages} land`,
    )
  for (const image of images)
    if (
      !imageMimeTypes.includes(image.mimeType) ||
      Buffer.byteLength(image.data, 'base64') > maxImageBytes
    )
      throw new Error(`images: entry ${entry.id} has an unsupported image or one over 2 MiB`)
  return { entry: entry.id }
}

/** A landing wants screenshots as evidence when its diff touched the UI: the web core or an extension's browser facet. */
export const capturesApply = (paths: readonly string[]) =>
  paths.some((path) => path.startsWith('web/') || /^extensions\/[^/]+\/web\.tsx$/.test(path))
