import type { DraftFile, PastedImage } from './attachments.ts'
import { storeFiles, storedFiles, storeImages, storedImages } from './draft-images.ts'
import { spliced } from './queued.ts'
import {
  attached,
  splitAttachments,
  splitTrailingAttachments,
  withAttachments,
} from './attachments.ts'

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
    set: (change: Partial<Draft>): boolean => {
      const { images, files } = value
      value = { ...value, ...change }
      if (key && value.images !== images) storeImages(key, value.images)
      if (key && value.files !== files) storeFiles(key, value.files)
      for (const listener of listeners) listener()
      return true
    },
  }
}

export type DraftStore = ReturnType<typeof createDraft>

export function boundDraft(
  read: () => string,
  write: (value: string) => boolean | void,
  dropUpload: (id: string) => void,
) {
  let local: Omit<Draft, 'text' | 'files'> & { uploading: DraftFile[] } = {
    images: [],
    uploading: [],
    sending: false,
    revision: 0,
  }
  const listeners = new Set<() => void>()
  let parsed: { from: string; text: string; files: DraftFile[] } | undefined
  const ours = new Set<string>()
  let latest: string | undefined
  const dropUploads = () => {
    for (const file of local.uploading) dropUpload(file.id)
    local = { ...local, uploading: [] }
  }
  const kept = () => {
    const from = read()
    if (parsed?.from !== from) {
      if (parsed && !ours.has(from)) dropUploads()
      if (from === latest) ours.clear()
      const { text, files } = splitTrailingAttachments(from)
      parsed = { from, text, files: files.map((file) => ({ ...file, id: file.line ?? file.path })) }
    }
    return parsed
  }
  return {
    key: undefined,
    get: (): Draft => {
      const { text, files } = kept()
      const { uploading, ...rest } = local
      return { ...rest, text, files: [...files, ...uploading] }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: ({ text, files, ...change }: Partial<Draft>): boolean => {
      let accepted = true
      let { uploading } = local
      if (text !== undefined || files !== undefined) {
        const now = kept()
        const all = files ?? [...now.files, ...local.uploading]
        const next = withAttachments(text ?? now.text, all.filter(attached))
        ours.add(next)
        latest = next
        accepted = next === read() || write(next) !== false
        const finished = all.filter(
          (file) => attached(file) && local.uploading.some((pending) => pending.id === file.id),
        )
        uploading = all.filter((file) => !attached(file))
        if (!accepted && finished.length)
          change = {
            ...change,
            error: `Not attached: ${finished.map((file) => file.name).join(', ')}`,
          }
      }
      local = { ...local, ...change, uploading }
      for (const listener of listeners) listener()
      return accepted
    },
  } satisfies DraftStore
}

export const createLocalDraft = () => createDraft(undefined)

export function restoreDraft(draft: DraftStore, text: string) {
  const { text: rest, files: back } = splitAttachments(text)
  setDraftText(draft, rest)
  if (!back.length) return
  const now = draft.get()
  draft.set({
    files: [...back.map((file) => ({ ...file, id: crypto.randomUUID() })), ...now.files],
    revision: now.revision + 1,
  })
}

export function storedText(draft: DraftStore) {
  return draft.key ? (localStorage.getItem(draft.key) ?? '') : draft.get().text
}

export function getDraft(id: number | string | undefined) {
  if (!draftsAndSubmissions.has(id)) draftsAndSubmissions.set(id, createDraft(id))
  return draftsAndSubmissions.get(id)!
}

export function setDraftText(draft: DraftStore, text: string) {
  const accepted = draft.set({ text, revision: draft.get().revision + 1 })
  if (!draft.key) return accepted
  if (text) localStorage.setItem(draft.key, text)
  else localStorage.removeItem(draft.key)
  return accepted
}

export function fillComposer(id: number, text: string) {
  setDraftText(getDraft(id), text)
}

export function insertIntoDraft(
  draft: DraftStore,
  editor: HTMLTextAreaElement | null | undefined,
  text: string,
) {
  const current = draft.get().text
  const start = editor?.selectionStart ?? current.length
  const end = editor?.selectionEnd ?? current.length
  const { text: next, cursor } = spliced(current, start, end, text)
  setDraftText(draft, next)
  requestAnimationFrame(() => editor?.setSelectionRange(cursor, cursor))
}

export function insertIntoComposer(id: number, text: string) {
  const editor = document.querySelector<HTMLTextAreaElement>(`textarea[data-conversation="${id}"]`)
  insertIntoDraft(getDraft(id), editor, text)
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
