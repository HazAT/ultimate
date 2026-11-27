import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Conversation, Price, Row } from './model/types.ts'

export const HISTORY_FILE = 'costs-history.json'

export type Saved<T> = T & { chapter: string }
export type History = {
  version: 2
  savedAt: number
  conversations: Saved<Conversation>[]
  rows: Saved<Row>[]
  prices: Record<string, Price>
}

export const emptyHistory = (): History => ({
  version: 2,
  savedAt: 0,
  conversations: [],
  rows: [],
  prices: {},
})

export async function loadHistory(path: string): Promise<History> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyHistory()
    throw error
  }
  const parsed = JSON.parse(text) as Partial<History>
  const savable = (list: unknown) =>
    Array.isArray(list) &&
    list.every((saved) => typeof (saved as Saved<unknown> | null)?.chapter === 'string')
  if (parsed.version !== 2 || !savable(parsed.conversations) || !savable(parsed.rows))
    throw new Error(`${path} is not a costs history (version 2)`)
  return { ...emptyHistory(), ...parsed }
}

let written = 0
export async function saveHistory(path: string, history: History) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${++written}.tmp`
  try {
    await writeFile(temp, JSON.stringify(history))
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

export function replaceChapter(
  history: History,
  chapter: string,
  imported: { conversations: readonly Conversation[]; rows: readonly Row[] },
): History {
  const fresh = new Set(imported.conversations.map((conversation) => conversation.id))
  return {
    ...history,
    conversations: [
      ...history.conversations.filter((saved) => saved.chapter !== chapter || !fresh.has(saved.id)),
      ...imported.conversations.map((conversation) => ({ ...conversation, chapter })),
    ],
    rows: [
      ...history.rows.filter(
        (saved) => saved.chapter !== chapter || !fresh.has(saved.conversation),
      ),
      ...imported.rows.map((row) => ({ ...row, chapter })),
    ],
  }
}

export type Origin = { chapter: string; id: number }

export type Earlier = {
  conversations: Conversation[]
  rows: Row[]
  origin: Map<number, Origin>
}
const keyOf = (saved: Origin) => `${saved.chapter}/${saved.id}`

export function earlier(history: History, chapter: string, live: ReadonlySet<number>): Earlier {
  const kept = history.conversations.filter(
    (saved) => saved.chapter !== chapter || !live.has(saved.id),
  )
  const origin = new Map<number, Origin>()
  for (const saved of kept)
    if (saved.chapter === chapter) origin.set(saved.id, { chapter, id: saved.id })
  kept
    .filter((saved) => saved.chapter !== chapter)
    .toSorted((a, b) => (a.chapter === b.chapter ? a.id - b.id : a.chapter < b.chapter ? -1 : 1))
    .forEach((saved, index) => origin.set(-(index + 1), { chapter: saved.chapter, id: saved.id }))
  const ids = new Map([...origin].map(([id, saved]) => [keyOf(saved), id]))
  const ref = (saved: Saved<Conversation>, at: number | undefined) => {
    if (at === undefined) return undefined
    const known = ids.get(keyOf({ chapter: saved.chapter, id: at }))
    return known ?? (saved.chapter === chapter && live.has(at) ? at : undefined)
  }
  const conversations = kept.map((saved) => {
    const { chapter: from, owner, parent, root, ...conversation } = saved
    const id = ids.get(keyOf(saved))!
    const up = ref(saved, owner)
    const fork = ref(saved, parent)
    return {
      ...conversation,
      id,
      live: false,
      ...(from === chapter ? {} : { ref: `${from}#${saved.id}` }),
      root: ref(saved, root) ?? up ?? fork ?? id,
      ...(up === undefined ? {} : { owner: up }),
      ...(fork === undefined ? {} : { parent: fork }),
    }
  })
  const rows = history.rows.flatMap((saved) => {
    const id = ids.get(keyOf({ chapter: saved.chapter, id: saved.conversation }))
    if (id === undefined) return []
    const { chapter: _, ...row } = saved
    return [{ ...row, conversation: id }]
  })
  return { conversations, rows, origin }
}

export function historyOf(input: {
  conversations: readonly Conversation[]
  rows: (id: number) => readonly Row[]
  prices: Record<string, Price>
  chapter: string
  origin: ReadonlyMap<number, Origin>
  savedAt: number
}): History {
  const savedId = (id: number | undefined) =>
    id === undefined ? undefined : (input.origin.get(id) ?? { chapter: input.chapter, id }).id
  const history: History = { ...emptyHistory(), savedAt: input.savedAt, prices: input.prices }
  for (const conversation of input.conversations) {
    const saved = input.origin.get(conversation.id) ?? {
      chapter: input.chapter,
      id: conversation.id,
    }
    const owner = savedId(conversation.owner)
    const parent = savedId(conversation.parent)
    const { ref: _, ...kept } = conversation
    history.conversations.push({
      ...kept,
      id: saved.id,
      chapter: saved.chapter,
      root: savedId(conversation.root) ?? saved.id,
      ...(owner === undefined ? {} : { owner }),
      ...(parent === undefined ? {} : { parent }),
    })
    for (const row of input.rows(conversation.id))
      history.rows.push({ ...row, conversation: saved.id, chapter: saved.chapter })
  }
  return history
}
