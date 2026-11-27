import { api } from '@/sdk/solid'
import { imagesOf } from '../../lib/entries.shared.ts'
import { offsetEntryId } from '../../lib/ids.shared.ts'
import type { Frame } from './refs.ts'

const KEPT = 12
const THUMBS_KEPT = 120
const THUMB_PX = 192
const sources = new Map<string, Promise<string>>()
const thumbs = new Map<string, Promise<string>>()

function remembered(
  cache: Map<string, Promise<string>>,
  limit: number,
  frame: Frame,
  load: () => Promise<string>,
  release?: (value: string) => void,
) {
  const key = `${frame.entry}:${frame.image}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const loading = load()
  loading.catch(() => cache.delete(key))
  cache.set(key, loading)
  if (cache.size > limit) {
    const [oldest, evicted] = cache.entries().next().value!
    cache.delete(oldest)
    if (release) evicted.then(release, () => undefined)
  }
  return loading
}

const sourceOf = (frame: Frame) =>
  remembered(sources, KEPT, frame, async () => {
    const page = await api.history(
      frame.conversation,
      offsetEntryId(frame.entry, 1),
      undefined,
      frame.entry,
    )
    const image = imagesOf(page.entries.find((entry) => entry.id === frame.entry))[frame.image]
    if (!image) throw new Error(`Screenshot ${frame.entry} is gone`)
    return `data:${image.mimeType};base64,${image.data}`
  })

export async function imageOf(frame: Frame) {
  const src = await sourceOf(frame)
  const decoded = new Image()
  decoded.src = src
  await decoded.decode()
  return src
}

export const thumbOf = (frame: Frame) =>
  remembered(
    thumbs,
    THUMBS_KEPT,
    frame,
    async () => {
      const full = await (await fetch(await sourceOf(frame))).blob()
      const bitmap = await createImageBitmap(full, { resizeWidth: THUMB_PX, resizeQuality: 'high' })
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
      bitmap.close()
      return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 }))
    },
    (url) => URL.revokeObjectURL(url),
  )
