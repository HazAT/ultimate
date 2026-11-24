import type { DraftFile, PastedImage } from './attachments.ts'
import { storeFiles, storedFiles, storeImages, storedImages } from './draft-images.ts'
import { spliced } from './queued.ts'

export type Draft = {
  text: string
  images: PastedImage[]
  files: DraftFile[]
  error?: string
  sending: boolean
  revision: number
}

const draftsAndSubmissions = new Map<number | string | undefined, ReturnType<typeof createDraft>>()
function createDraft(id: number | string | undefined) {
  const key = id === undefined ? undefined : `ultimate.draft.${id}`
  let value: Draft = {
    text: key ? (localStorage.getItem(key) ?? '') : '',
    images: key ? storedImages(key) : [],
    files: key ? storedFiles(key) : [],
    sending: false,
    revision: 0,
  }
  const listeners = new Set<() => void>()
  return {
    key,
    get: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (change: Partial<Draft>) => {
      const { images, files } = value
      value = { ...value, ...change }
      if (key && value.images !== images) storeImages(key, value.images)
      if (key && value.files !== files) storeFiles(key, value.files)
      for (const listener of listeners) listener()
    },
  }
}

export type DraftStore = ReturnType<typeof createDraft>

export function getDraft(id: number | string | undefined) {
  if (!draftsAndSubmissions.has(id)) draftsAndSubmissions.set(id, createDraft(id))
  return draftsAndSubmissions.get(id)!
}

export function fillComposer(id: number, text: string) {
  const draft = getDraft(id)
  draft.set({ text, revision: draft.get().revision + 1 })
  if (draft.key) localStorage.setItem(draft.key, text)
}

export function insertIntoComposer(id: number, text: string) {
  const draft = getDraft(id)
  const current = draft.get().text
  const editor = document.querySelector<HTMLTextAreaElement>(`textarea[data-conversation="${id}"]`)
  const start = editor?.selectionStart ?? current.length
  const end = editor?.selectionEnd ?? current.length
  const { text: next, cursor } = spliced(current, start, end, text)
  draft.set({ text: next, revision: draft.get().revision + 1 })
  if (draft.key) localStorage.setItem(draft.key, next)
  requestAnimationFrame(() => editor?.setSelectionRange(cursor, cursor))
}

export function composerDraft(id: number | string) {
  const draft = getDraft(id)
  const { text, images, files } = draft.get()
  return {
    text,
    images: images.map(({ data, mimeType }) => ({ data, mimeType })),
    files: files.length,
    subscribe: draft.subscribe,
    reserve: () => {
      if (draft.get().sending) return undefined
      draft.set({ sending: true })
      return (sent?: 'all' | 'images') => {
        if (sent === 'all' && draft.get().text === text) {
          if (draft.key && localStorage.getItem(draft.key) === text)
            localStorage.removeItem(draft.key)
          draft.set({ text: '', revision: draft.get().revision + 1 })
        }
        if (sent && draft.get().images === images) draft.set({ images: [] })
        draft.set({ sending: false })
      }
    },
  }
}

export function clearDraft(draft: DraftStore, snapshot: { text: string; revision: number }) {
  const stored = draft.key ? (localStorage.getItem(draft.key) ?? '') : ''
  const editedAfterSubmission = draft.get().revision !== snapshot.revision
  if (editedAfterSubmission) return
  if (draft.key && stored === snapshot.text) localStorage.removeItem(draft.key)
  draft.set({ text: stored === snapshot.text ? '' : stored })
}
