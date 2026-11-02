/** Read a closed chapter without resuming its tasks. */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai'
import { AgentDoc, createRegistry, Harness } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  EntryRecord,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { ExtensionHost } from '../../server/extensions.ts'
import { chapterFiles, readChapters } from '../../lib/chapters.ts'
import { shortTitle } from '../../lib/title.ts'

export const limit = (value: unknown, fallback = 100) => {
  const n = value ?? fallback
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000)
    throw new Error('limit must be an integer between 1 and 1000')
  return n
}
export const id = (value: unknown): ConversationId => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new Error('conversationId must be a positive integer')
  return value as ConversationId
}

export type HistoryRead = 'conversations' | 'entries' | 'search'

/** Undefined means the live chapter; unknown names fail before any database is opened. */
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

/** Read history from a closed chapter's database through a read-only Harness: it recovers nothing and writes nothing. */
export async function readChapter(
  host: Pick<ExtensionHost, 'metadata' | 'doc'>,
  database: string,
  op: HistoryRead,
  args: unknown[],
) {
  const ui = host.doc('ultimate.ui')
  const storage = await openNodeSqliteStorage(database)
  const harness = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry(), readOnly: true },
    context,
  )
  try {
    const conversations = () =>
      harness.commit(async (tx) => {
        const records: ConversationRecord[] = []
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanConversations({}, 256, cursor)
          records.push(...page.items)
          cursor = page.next
        } while (cursor !== undefined)
        return records
      }, context)
    /** Fork-aware history, newest first, from before `before` (exclusive). */
    async function* entries(value: unknown, before?: number): AsyncGenerator<EntryRecord> {
      const conversation = await harness.conversation(id(value), context)
      if (!conversation) throw new Error('Unknown conversation')
      const query = before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }
      let cursor: Cursor | undefined
      do {
        const page = await conversation.entries(query, 256, cursor, context)
        yield* page.items
        cursor = page.next
      } while (cursor !== undefined)
    }
    if (op === 'conversations') {
      // The same listing as the live read: summary fields with short titles, busy from live foreground tasks, concluded from the UI state.
      const concluded = (ui && (await harness.snapshot(ui, 1 as ConversationId, context)))?.[
        'ext.conversations.concluded'
      ]
      const done = new Set(Array.isArray(concluded) ? concluded : [])
      const graph = await harness.watchTaskGraph(context)
      await graph.stop()
      const busy = new Set(
        Object.values(graph.value.tasks)
          .filter((task) => !task.background)
          .map((task) => task.conversationId as number),
      )
      return await Promise.all(
        (await conversations()).map(async (record) => {
          const metadata = (await harness.snapshot(host.metadata, record.id, context)) ?? {}
          const cwd = (await harness.snapshot(AgentDoc, record.id, context))?.cwd
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
        }),
      )
    }
    const matches: EntryRecord[] = []
    if (op === 'entries') {
      const options = (args[1] ?? {}) as { kinds?: string[]; limit?: number; before?: number }
      const count = limit(options.limit)
      for await (const entry of entries(args[0], options.before)) {
        if (!options.kinds || options.kinds.includes(entry.kind)) matches.push(entry)
        if (matches.length === count) break
      }
    } else {
      const text = args[0]
      if (typeof text !== 'string' || !text) throw new Error('search text must be nonempty')
      const options = (args[1] ?? {}) as { conversationId?: number; limit?: number }
      const count = limit(options.limit)
      const records =
        options.conversationId === undefined
          ? await conversations()
          : [{ id: id(options.conversationId) }]
      for (const record of records) {
        for await (const entry of entries(record.id)) {
          if (JSON.stringify(entry).includes(text)) matches.push(entry)
          if (matches.length === count) return matches
        }
      }
    }
    return matches
  } finally {
    await harness.close(context)
  }
}
