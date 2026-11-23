import { place } from './blocks.ts'

export const limits = {
  comments: 50,
  text: 4000,
  excerptLines: 40,
  excerptBytes: 8 * 1024,
} as const

export type Draft = {
  id: string
  start: number
  end: number
  excerpt: string
  anchor: string
  text: string
}

export type Drafts = { comments: Draft[]; note: string }

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export type Change = (storage: DraftStorage, prefix: string) => boolean

const bytes = (text: string) => new TextEncoder().encode(text).length

export function excerptOf(selected: string) {
  const kept: string[] = []
  let size = 0
  for (const line of selected
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .split('\n')
    .slice(0, limits.excerptLines)) {
    const next = size + (kept.length ? 1 : 0) + bytes(line)
    if (next > limits.excerptBytes) {
      if (kept.length) break
      let cut = ''
      for (const char of line) {
        if (bytes(cut + char) > limits.excerptBytes) break
        cut += char
      }
      return cut
    }
    kept.push(line)
    size = next
  }
  return kept.join('\n')
}

export const draftsKey = (absolute: string) => `ultimate.reader.drafts:${absolute}:`

const NOTE = 'note'

export const writingSlot = (tab: string) => `writing:${tab}`

const isDraft = (value: unknown): value is Draft =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Draft).id === 'string' &&
  typeof (value as Draft).text === 'string' &&
  Number.isSafeInteger((value as Draft).start) &&
  Number.isSafeInteger((value as Draft).end)

const parse = (raw: string | null): unknown => {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const held = new WeakMap<DraftStorage, Map<string, string>>()

const read = (storage: DraftStorage, key: string) =>
  held.get(storage)?.get(key) ?? storage.getItem(key)

function store(storage: DraftStorage, key: string, value: string, hold: boolean) {
  try {
    storage.setItem(key, value)
    held.get(storage)?.delete(key)
    return true
  } catch {
    if (hold) {
      if (!held.has(storage)) held.set(storage, new Map())
      held.get(storage)!.set(key, value)
    }
    return false
  }
}

function remove(storage: DraftStorage, key: string) {
  held.get(storage)?.delete(key)
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export const isUnsaved = (storage: DraftStorage, prefix: string, rest: string) =>
  held.get(storage)?.has(prefix + rest) ?? false

function keysOf(storage: DraftStorage, prefix: string) {
  const keys = new Set(held.get(storage)?.keys())
  for (let index = 0; index < storage.length; index++) keys.add(storage.key(index) ?? '')
  return [...keys]
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes(':'))
    .toSorted()
}

export function readDrafts(storage: DraftStorage, prefix: string): Drafts {
  const comments: Draft[] = []
  let note = ''
  for (const key of keysOf(storage, prefix)) {
    const rest = key.slice(prefix.length)
    const value = parse(read(storage, key))
    if (rest === NOTE) note = typeof value === 'string' ? value : ''
    else if (isDraft(value) && value.id === rest) comments.push(value)
  }
  comments.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id))
  return { comments, note }
}

export const draftsSignature = (storage: DraftStorage, prefix: string) =>
  keysOf(storage, prefix)
    .map((key) => `${key}\u0000${read(storage, key)}`)
    .join('\u0001')

export const putComment =
  (draft: Draft): Change =>
  (storage, prefix) =>
    store(storage, prefix + draft.id, JSON.stringify(draft), false)

export const dropComment =
  (id: string): Change =>
  (storage, prefix) =>
    remove(storage, prefix + id)

export const putNote =
  (note: string): Change =>
  (storage, prefix) =>
    note
      ? store(storage, prefix + NOTE, JSON.stringify(note), true)
      : remove(storage, prefix + NOTE)

const same = (a: Draft, b: Draft) =>
  a.id === b.id &&
  a.start === b.start &&
  a.end === b.end &&
  a.text === b.text &&
  a.excerpt === b.excerpt &&
  a.anchor === b.anchor

export const withoutSent =
  (sent: Drafts): Change =>
  (storage, prefix) => {
    let ok = true
    for (const draft of sent.comments) {
      const stored = parse(read(storage, prefix + draft.id))
      if (isDraft(stored) && same(stored, draft)) ok = remove(storage, prefix + draft.id) && ok
    }
    if (readDrafts(storage, prefix).note === sent.note) ok = remove(storage, prefix + NOTE) && ok
    return ok
  }

export type Writing = {
  start: number
  end: number
  excerpt: string
  anchor: string
  id?: string
  text: string
  refused?: true
}

export function typed(writing: Writing, text: string): Writing {
  const { refused: _refused, ...rest } = writing
  return { ...rest, text }
}

export const added = (writing: Writing, kept: boolean): Writing | undefined =>
  kept ? undefined : { ...writing, refused: true }

export const busyReason = (writing: Writing | undefined) =>
  writing ? 'Save or cancel the comment you are writing first' : undefined

export const saveWriting =
  (writing: Writing | undefined, tab: string): Change =>
  (storage, prefix) =>
    writing
      ? store(storage, prefix + writingSlot(tab), JSON.stringify(writing), true)
      : remove(storage, prefix + writingSlot(tab))

export function loadWriting(
  storage: DraftStorage,
  prefix: string,
  lines: readonly string[],
  tab: string,
): Writing | undefined {
  const value = parse(read(storage, prefix + writingSlot(tab))) as Partial<Writing> | undefined
  if (
    !value ||
    typeof value.text !== 'string' ||
    typeof value.excerpt !== 'string' ||
    typeof value.anchor !== 'string' ||
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end)
  )
    return undefined
  const writing = value as Writing
  const { start, end } = place(writing, lines)
  return {
    start,
    end,
    excerpt: writing.excerpt,
    anchor: writing.anchor,
    text: writing.text,
    ...(typeof writing.id === 'string' && { id: writing.id }),
    ...(writing.refused === true && { refused: true as const }),
  }
}

const count = (value: number) => value.toLocaleString('en-US')

export function sendProblem(drafts: Drafts) {
  if (!drafts.comments.length) return 'Add a comment to send'
  if (drafts.comments.length > limits.comments)
    return `At most ${limits.comments} comments per review`
  if (drafts.note.length > limits.text)
    return `The note is ${count(drafts.note.length)} characters, over the ${count(limits.text)} a review allows: shorten it to send`
  if (drafts.comments.some((draft) => draft.text.length > limits.text))
    return `A comment is over ${count(limits.text)} characters: shorten it to send`
  return undefined
}
