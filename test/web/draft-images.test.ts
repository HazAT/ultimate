import { expect, it, vi } from 'vitest'
import {
  storeFiles,
  storedFiles,
  storeImages,
  storedImages,
} from '../../web/src/app/draft-images.ts'

const stored = new Map<string, string>()
let full = false
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (full) throw new DOMException('quota', 'QuotaExceededError')
    stored.set(key, value)
  },
  removeItem: (key: string) => stored.delete(key),
})

it('keeps a draft’s pasted images across a reload, as its text', () => {
  const image = { data: 'iVBORw0KGgo=', mimeType: 'image/png' }
  storeImages('ultimate.draft.7', [image])
  expect(storedImages('ultimate.draft.7')).toEqual([image])
  // Sending or removing them clears what a reload brings back.
  storeImages('ultimate.draft.7', [])
  expect(storedImages('ultimate.draft.7')).toEqual([])
})

it('keeps a draft’s attached files only until reload when the browser storage is full', () => {
  const file = { id: 'a', name: 'a.ts', size: '1 KB', mimeType: 'text/plain', path: 'a.ts' }
  storeFiles('ultimate.draft.8', [file])
  full = true
  expect(() => storeFiles('ultimate.draft.8', [file, { ...file, id: 'b' }])).not.toThrow()
  full = false
  expect(storedFiles('ultimate.draft.8')).toEqual([])
})
