import { api } from '@/sdk/solid'
import { imagesOf } from '../../lib/entries.ts'
import { offsetEntryId } from '../../lib/ids.ts'
import type { Frame } from './refs.ts'

const KEPT = 12
const loaded = new Map<string, Promise<string>>()

const keyOf = (frame: Frame) => `${frame.entry}:${frame.image}`

export function imageOf(frame: Frame) {
  const key = keyOf(frame)
  const cached = loaded.get(key)
  if (cached) {
    loaded.delete(key)
    loaded.set(key, cached)
    return cached
  }
  const fetched = api
    .history(frame.conversation, offsetEntryId(frame.entry, 1), undefined, frame.entry)
    .then((page) => {
      const image = imagesOf(page.entries.find((entry) => entry.id === frame.entry))[frame.image]
      if (!image) throw new Error(`Screenshot ${frame.entry} is gone`)
      return `data:${image.mimeType};base64,${image.data}`
    })
  fetched.catch(() => loaded.delete(key))
  loaded.set(key, fetched)
  if (loaded.size > KEPT) loaded.delete(loaded.keys().next().value!)
  return fetched
}
