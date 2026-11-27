import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Op } from '@earendil-works/chord/delta'
import { advance, createState, rowsOf } from './model/rows.ts'
import type { EntryLike, UsageLike } from './model/rows.ts'
import type { Row } from './model/types.ts'

export const CHAPTERS_FILE = 'chapters.json'
export const FIRST_CHAPTER = 'the-beginning'
const PROFILE = 'ultimate.agent-profile'
const FAMILY = 'models.family'
const METADATA = 'ultimate.metadata'

export type Documents = {
  apply: <T>(target: T | undefined, ops: readonly Op[]) => T
  usage: string
}

type Stored = {
  id: number
  owner?: { conversationId?: number }
  parent?: { conversationId?: number; at?: number }
}

export type ImportedConversation = {
  id: number
  title?: string
  label?: string
  definition?: string
  family: string | null
  owner?: number
  parent?: number
  usage: UsageLike | null
}
export type Imported = { conversations: ImportedConversation[]; rows: Row[] }

export const chapterDatabase = (home: string, name: string) =>
  name === FIRST_CHAPTER ? join(home, 'state.sqlite') : join(home, 'chapters', name, 'state.sqlite')

export async function chaptersToImport(
  home: string,
  active: string,
): Promise<{ name: string; database: string }[]> {
  let text: string
  try {
    text = await readFile(join(home, CHAPTERS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const { chapters } = JSON.parse(text) as { chapters?: { name?: unknown }[] }
  return (chapters ?? []).flatMap((chapter) =>
    typeof chapter.name === 'string' && chapter.name !== active
      ? [{ name: chapter.name, database: chapterDatabase(home, chapter.name) }]
      : [],
  )
}

export function readChapter(database: string, documents: Documents): Imported {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const latest = (kind: string, owner: number): Record<string, unknown> | undefined => {
      const document = db
        .prepare(
          "SELECT id FROM documents WHERE kind = ? AND scope_kind = 'conversation' AND owner_id = ? AND family = 0 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1",
        )
        .get(JSON.stringify(kind), owner)
      if (!document) return undefined
      const base = db
        .prepare(
          "SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1",
        )
        .get(document.id)
      if (!base) return undefined
      let value = JSON.parse(String(base.content)) as Record<string, unknown>
      for (const revision of db
        .prepare(
          'SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq',
        )
        .iterate(document.id, base.seq))
        value = documents.apply(value, JSON.parse(String(revision.content)) as readonly Op[])
      return value
    }
    const conversations: ImportedConversation[] = []
    const rows: Row[] = []
    const records = db
      .prepare('SELECT record FROM conversations ORDER BY id')
      .all()
      .map((row) => JSON.parse(String(row.record)) as Stored)
    const byId = new Map(records.map((record) => [record.id, record]))
    const select = db.prepare('SELECT record FROM entries WHERE conversation_id = ? ORDER BY id')
    const parents = new Set(records.map((record) => record.parent?.conversationId))
    const kept = new Map<number, EntryLike[]>()
    const ownOf = (id: number) => {
      const held = kept.get(id)
      if (held) return held
      const list = select.all(id).map((row) => JSON.parse(String(row.record)) as EntryLike)
      if (parents.has(id)) kept.set(id, list)
      return list
    }
    const entriesOf = (id: number, through: number): EntryLike[] => {
      const parent = byId.get(id)?.parent
      return [
        ...(parent?.conversationId === undefined || parent.at === undefined
          ? []
          : entriesOf(parent.conversationId, Math.min(through, parent.at))),
        ...ownOf(id).filter((entry) => entry.id <= through),
      ]
    }
    for (const record of records) {
      const usage = (latest(documents.usage, record.id) as UsageLike | undefined) ?? null
      const metadata = latest(METADATA, record.id) as
        | { title?: string; inputTitle?: string; label?: string }
        | undefined
      const definition = (latest(PROFILE, record.id) as { definition?: string } | undefined)
        ?.definition
      const family = latest(FAMILY, record.id) as { name?: string | null } | undefined
      const state = createState(record.id)
      advance(state, entriesOf(record.id, Number.MAX_SAFE_INTEGER))
      rows.push(...rowsOf(state, usage))
      const title = metadata?.title ?? metadata?.inputTitle
      conversations.push({
        id: record.id,
        ...(typeof title === 'string' && title ? { title } : {}),
        ...(typeof metadata?.label === 'string' ? { label: metadata.label } : {}),
        ...(definition === undefined ? {} : { definition }),
        family: family?.name ?? null,
        ...(record.owner?.conversationId === undefined
          ? {}
          : { owner: record.owner.conversationId }),
        ...(record.parent?.conversationId === undefined
          ? {}
          : { parent: record.parent.conversationId }),
        usage,
      })
    }
    return { conversations, rows }
  } finally {
    db.close()
  }
}
