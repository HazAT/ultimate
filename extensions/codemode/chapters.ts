import { parseConversationId } from '../../lib/ids.ts'
import type {
  ConversationId,
  ConversationRecord,
  EntryRecord,
  JsonObject,
  EntryId,
} from '@earendil-works/pi-durable'
import { apply } from '@earendil-works/chord/delta'
import { DatabaseSync } from 'node:sqlite'
import { chapterFiles, readChapters } from '../../lib/chapters.ts'
import { shortTitle } from '../../lib/title.ts'

export const limit = (value: unknown, fallback = 100) => {
  const n = value ?? fallback
  if (typeof n !== 'number' || Number.isNaN(n)) throw new Error('limit must be a number')
  return Math.min(Math.max(1, Math.trunc(n)), 1000)
}
export const id = (value: unknown): ConversationId => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error('conversationId must be a positive integer')
  return parseConversationId(value)
}

export type HistoryRead = 'conversations' | 'entries' | 'search'

export type SearchOptions = {
  conversationId?: ConversationId
  limit?: number
  kinds?: string[]
  full?: boolean
}

export function searchHit(entry: EntryRecord, text: string, options: SearchOptions) {
  if (options.kinds && !options.kinds.includes(entry.kind)) return undefined
  const json = JSON.stringify(entry)
  const at = json.indexOf(text)
  if (at < 0) return undefined
  if (options.full) return entry
  const start = Math.max(0, at - 80)
  const end = Math.min(json.length, at + text.length + 120)
  const time = entry.model?.[0]?.timestamp
  return {
    conversation: entry.conversationId,
    id: entry.id,
    kind: entry.kind,
    ...(typeof time === 'number' && { at: new Date(time).toISOString() }),
    excerpt: `${start > 0 ? '…' : ''}${json.slice(start, end)}${end < json.length ? '…' : ''}`,
  }
}

export type EntriesOptions = { kinds?: string[]; limit?: number; before?: EntryId; full?: boolean }

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const toolResultHeadAndExitStatusTail = (text: string) =>
  `${text.slice(0, 300)}\n…\n${text.slice(-700)}`

export function compactEntry(entry: EntryRecord) {
  const message = entry.model?.[0] as
    | {
        role?: string
        content?: unknown
        timestamp?: number
        toolName?: string
        stopReason?: string
        errorMessage?: string
        isError?: boolean
      }
    | undefined
  const content = message?.content
  const blocks = (
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content
        : []
  ) as { type?: string; text?: string; name?: string; arguments?: unknown }[]
  let text = blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  if (message?.role === 'toolResult' && text.length > 1000)
    text = toolResultHeadAndExitStatusTail(text)
  const tools = blocks
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({ name: block.name, args: cut(JSON.stringify(block.arguments ?? {}), 200) }))
  const stop = message?.stopReason
  const error = message?.errorMessage ?? (message?.isError ? true : undefined)
  return {
    id: entry.id,
    kind: entry.kind,
    ...(typeof message?.timestamp === 'number' && {
      at: new Date(message.timestamp).toISOString(),
    }),
    ...(message?.role && { role: message.role }),
    ...(message?.toolName && { tool: message.toolName }),
    ...(text && { text }),
    ...(tools.length > 0 && { tools }),
    ...(stop && stop !== 'stop' && stop !== 'toolUse' && { stopReason: stop }),
    ...(error !== undefined && { error }),
    ...(entry.data !== undefined &&
      !entry.kind.startsWith('pi.') && { data: cut(JSON.stringify(entry.data), 500) }),
  }
}

export async function closedChapter(home: string, active: string, options: unknown) {
  if (
    !options ||
    typeof options !== 'object' ||
    !('chapter' in options) ||
    options.chapter === undefined
  )
    return undefined
  if ('project' in options && options.project !== undefined)
    throw new Error('chapter and project cannot be used together')
  const chapter = options.chapter
  if (typeof chapter !== 'string') throw new Error('chapter must be a name')
  const { chapters } = await readChapters(home)
  if (!chapters.some(({ name }) => name === chapter))
    throw new Error(
      `Unknown chapter ${chapter}. Chapters: ${chapters.map(({ name }) => name).join(', ')}`,
    )
  return chapter === active ? undefined : chapterFiles(home, chapter).database
}

// Pi upstream: @earendil-works/pi-durable@1.6.0 src/storage/sqlite/migrations.ts — conversation/entry JSON records and document revisions; fork cutoffs follow src/storage/sqlite/storage.ts. Drop when Pi's SQLite storage opens over a read-only connection: 1.6.0's readOnly Harness still sets WAL mode, runs migrations and checkpoints the file on close.
export function readChapter(database: string, op: HistoryRead, args: unknown[]) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const conversations = () =>
      db
        .prepare('SELECT record FROM conversations ORDER BY id')
        .all()
        .map((row) => JSON.parse(String(row.record)) as ConversationRecord)
    const conversation = (value: unknown) => {
      const row = db.prepare('SELECT record FROM conversations WHERE id = ?').get(id(value))
      if (!row) throw new Error('Unknown conversation')
      return JSON.parse(String(row.record)) as ConversationRecord
    }
    function* entries(value: unknown, before?: EntryId): Generator<EntryRecord> {
      let record = conversation(value)
      let upper = before === undefined ? Number.MAX_SAFE_INTEGER : before - 1
      while (true) {
        for (const row of db
          .prepare(
            'SELECT record FROM entries WHERE conversation_id = ? AND id <= ? ORDER BY id DESC',
          )
          .iterate(record.id, upper))
          yield JSON.parse(String(row.record)) as EntryRecord
        if (!record.parent) return
        upper = Math.min(upper, record.parent.at)
        record = conversation(record.parent.conversationId)
      }
    }
    const latestDocumentFromBaseAndDeltas = (kind: string, owner: number) => {
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
      if (!base) throw new Error(`Document ${String(document.id)} is missing a required base`)
      let value = JSON.parse(String(base.content)) as JsonObject
      for (const revision of db
        .prepare(
          'SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq',
        )
        .iterate(document.id, base.seq))
        value = apply(value, JSON.parse(String(revision.content)))
      return value
    }
    if (op === 'conversations') {
      const concluded = latestDocumentFromBaseAndDeltas('ultimate.ui', 1)?.[
        'ext.conversations.concluded'
      ]
      const done = new Set(Array.isArray(concluded) ? concluded : [])
      const busy = new Set(
        db
          .prepare(
            "SELECT DISTINCT conversation_id AS id FROM tasks WHERE status != 'terminal' AND background = 0",
          )
          .all()
          .map((row) => Number(row.id)),
      )
      return conversations().map((record) => {
        const metadata = latestDocumentFromBaseAndDeltas('ultimate.metadata', record.id) ?? {}
        const cwd = latestDocumentFromBaseAndDeltas('pi.agent', record.id)?.cwd
        const title = metadata.title ?? metadata.inputTitle
        return {
          ...record,
          ...(typeof title === 'string' && { title: shortTitle(title) }),
          ...(metadata.label !== undefined && { label: metadata.label }),
          ...(cwd !== undefined && { cwd }),
          busy: busy.has(record.id),
          ...(metadata.inputAt !== undefined && { inputAt: metadata.inputAt }),
          ...(done.has(record.id) && { concluded: true }),
        }
      })
    }
    const matches: unknown[] = []
    if (op === 'entries') {
      const options = (args[1] ?? {}) as EntriesOptions
      const count = limit(options.limit)
      for (const entry of entries(args[0], options.before)) {
        if (!options.kinds || options.kinds.includes(entry.kind))
          matches.push(options.full ? entry : compactEntry(entry))
        if (matches.length === count) break
      }
    } else {
      const text = args[0]
      if (typeof text !== 'string' || !text) throw new Error('search text must be nonempty')
      const options = (args[1] ?? {}) as SearchOptions
      const count = limit(options.limit)
      const records =
        options.conversationId === undefined
          ? conversations()
          : [{ id: id(options.conversationId) }]
      for (const record of records) {
        for (const entry of entries(record.id)) {
          const hit = searchHit(entry, text, options)
          if (hit) matches.push(hit)
          if (matches.length === count) return matches
        }
      }
    }
    return matches
  } finally {
    db.close()
  }
}
