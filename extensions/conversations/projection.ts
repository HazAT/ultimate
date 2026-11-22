import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type {
  CommitChange,
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryId,
  Tx,
} from '@earendil-works/pi-durable'
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
  host: Pick<ExtensionHost, 'harness' | 'onOpen' | 'notice' | 'resource'>,
  {
    name,
    batch = 1,
    background = false,
    stale,
  }: {
    name: string
    batch?: number
    background?: boolean
    stale?: (tx: Tx, conversation: ConversationRecord) => Promise<boolean>
  },
  changed: (change: CommitChange, add: (id: ConversationId) => void) => void,
  reconcile: (ids: ConversationId[]) => Promise<void>,
) {
  const markCoversOnlyTheFirstOpenOfAProcess = host.resource(
    `conversations.projection.${name}`,
    () => ({ opened: false }),
  )
  host.onOpen(async (opened) => {
    let closed = false
    let failed = false
    let through = parseEntryId(0)
    let draining: Promise<void> | undefined
    const live = new Set<ConversationId>()
    let backlog: ConversationId[] | undefined
    const next = () => {
      const ids: ConversationId[] = []
      for (const id of live) {
        if (ids.length === batch) break
        ids.push(id)
      }
      for (const id of ids) live.delete(id)
      return ids.length ? ids : (backlog?.splice(-batch) ?? [])
    }
    const drain = async () => {
      for (;;) {
        if (closed) return
        const ids = next()
        if (!ids.length) return
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
        if ((live.size || backlog?.length) && !closed) schedule()
      })
    }
    const harness = host.harness()
    const stop = onCommit(harness, (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry' && change.value.id > through) through = change.value.id
        changed(change, (id) => void live.add(id))
      }
      if (live.size) schedule()
    })
    const select = async () => {
      const mark = await harness.commit(async (tx) => {
        const marks = await tx.doc(ProjectedThroughAtCleanClose, ROOT_CONVERSATION_ID)
        const consumed = marks[name]
        delete marks[name]
        return consumed
      }, context)
      const trusted = markCoversOnlyTheFirstOpenOfAProcess.opened ? undefined : mark
      markCoversOnlyTheFirstOpenOfAProcess.opened = true
      const owners = new Map<ConversationId, ConversationId>()
      const topOf = (id: ConversationId) => {
        let top = id
        while (owners.has(top)) top = owners.get(top)!
        return top
      }
      const selected: ConversationId[] = []
      let cursor: Cursor | undefined
      do {
        if (closed) return
        cursor = await harness.commit(async (tx) => {
          const concluded = await concludedIn(tx)
          const page = await tx.scanConversations({}, 256, cursor)
          for (const record of page.items) {
            const { id, owner } = record
            if (owner) owners.set(id, owner.conversationId)
            const newest = await tx.latestEntryId(id)
            if (newest !== undefined && newest > through) through = newest
            if (
              trusted === undefined ||
              !concluded.has(topOf(id)) ||
              (newest !== undefined && newest > trusted) ||
              (await stale?.(tx, record))
            )
              selected.push(id)
          }
          return page.next
        }, context)
      } while (cursor !== undefined)
      backlog = selected
    }
    const opening = select()
      .catch((error: unknown) => {
        host.notice(
          `Conversation ${name}: selection incomplete; live updates continue: ${String(error)}`,
        )
      })
      .then(() => {
        schedule()
        return draining
      })
    opened.defer(async () => {
      closed = true
      stop()
      await opening
      await draining
      if (!backlog || failed || live.size || backlog.length) return
      const clean = through
      await harness.commit(async (tx) => {
        ;(await tx.doc(ProjectedThroughAtCleanClose, ROOT_CONVERSATION_ID))[name] = clean
      }, context)
    })
    if (!background) await opening
  })
}
