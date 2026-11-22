import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { CommitChange, ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable'
import { onCommit } from '../../lib/commits.ts'
import { parseEntryId } from '../../lib/ids.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { UiState } from '../../shared/ui-state.ts'

export async function concludedIn(tx: Tx): Promise<Set<ConversationId>> {
  const ids = (await tx.doc(UiState, ROOT_CONVERSATION_ID))['ext.conversations.concluded']
  return new Set(Array.isArray(ids) ? (ids as ConversationId[]) : [])
}

const ProjectedThroughAtCleanClose = defineDoc<Record<string, EntryId>>({
  kind: 'conversations.projected',
  checkpointWhen: () => true,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export function projection(
  host: Pick<ExtensionHost, 'harness' | 'onOpen' | 'notice'>,
  { name, batch = 1, background = false }: { name: string; batch?: number; background?: boolean },
  changed: (change: CommitChange, add: (id: ConversationId) => void) => void,
  reconcile: (ids: ConversationId[]) => Promise<void>,
) {
  let closed = false
  let failed = false
  let through = parseEntryId(0)
  let draining: Promise<void> | undefined
  const pending = new Set<ConversationId>()
  const drain = async () => {
    while (pending.size) {
      if (closed) break
      const ids = [...pending].slice(0, batch)
      for (const id of ids) pending.delete(id)
      await reconcile(ids).catch((error: unknown) => {
        failed = true
        if (!closed) host.notice(`Conversation ${name}: ${String(error)}`)
      })
    }
  }
  const schedule = () => {
    if (draining || closed) return
    draining = drain().finally(() => {
      draining = undefined
      if (pending.size && !closed) schedule()
    })
  }
  const add = (id: ConversationId) => void pending.add(id)
  host.onOpen(async (opened) => {
    closed = false
    failed = false
    through = parseEntryId(0)
    const harness = host.harness()
    const stop = onCommit(harness, (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry' && change.value.id > through) through = change.value.id
        changed(change, add)
      }
      if (pending.size) schedule()
    })
    opened.defer(async () => {
      closed = true
      stop()
      await draining
      if (failed || pending.size) return
      const clean = through
      await harness.commit(async (tx) => {
        ;(await tx.doc(ProjectedThroughAtCleanClose, ROOT_CONVERSATION_ID))[name] = clean
      }, context)
    })
    await harness.commit(async (tx) => {
      const marks = await tx.doc(ProjectedThroughAtCleanClose, ROOT_CONVERSATION_ID)
      const mark = marks[name]
      delete marks[name]
      const concluded = await concludedIn(tx)
      const owners = new Map<ConversationId, ConversationId>()
      const ids: ConversationId[] = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const record of page.items) {
          ids.push(record.id)
          if (record.owner) owners.set(record.id, record.owner.conversationId)
        }
        cursor = page.next
      } while (cursor !== undefined)
      const inConcludedTree = (id: ConversationId) => {
        let top = id
        while (owners.has(top)) top = owners.get(top)!
        return concluded.has(top)
      }
      for (const id of ids) {
        const newest = await tx.latestEntryId(id)
        if (newest !== undefined && newest > through) through = newest
        if (mark === undefined || !inConcludedTree(id) || (newest !== undefined && newest > mark))
          pending.add(id)
      }
    }, context)
    schedule()
    if (!background) await draining
  })
}
