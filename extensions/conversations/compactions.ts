import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { rebuiltOnOpen } from '../../lib/errors.ts'
import { offsetEntryId, parseEntryId } from '../../lib/ids.ts'
import {
  CompactionEntry,
  CompactionTask,
  defineDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { Cursor, EntryId, Tx, TypedEntry } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Compacted } from './refs.ts'

const Announced = defineDoc<{ through?: EntryId }>({
  kind: 'conversations.compactions-announced',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})

export function compactionEvents(
  host: Pick<
    ExtensionHost,
    'harness' | 'emit' | 'onOpen' | 'onRelease' | 'onClose' | 'notice' | 'resource'
  >,
) {
  const failuresNoticedAcrossReloads = host.resource(
    'conversations.compaction-failures',
    () => new Set<number>(),
  )
  const announce = async (tx: Tx, entry: TypedEntry<{ reason?: string }>) => {
    const reason = entry.data?.reason
    await host.emit(tx, Compacted, {
      conversation: entry.conversationId,
      entry: entry.id,
      ...(reason ? { reason } : {}),
    })
  }
  const markHistoryAnnounced = async (tx: Tx) => {
    const announced = await tx.doc(Announced, ROOT_CONVERSATION_ID)
    if (announced.through !== undefined) return
    let newest = parseEntryId(0)
    let page: Cursor | undefined
    do {
      const conversations = await tx.scanConversations({}, 256, page)
      for (const { id } of conversations.items) {
        const latest = await tx.latestEntryId(id)
        if (latest !== undefined && latest > newest) newest = latest
      }
      page = conversations.next
    } while (page !== undefined)
    announced.through = newest
  }
  const announceMissed = async (tx: Tx) => {
    const announced = await tx.doc(Announced, ROOT_CONVERSATION_ID)
    const through = announced.through!
    let newest = through
    const missed: TypedEntry<{ reason?: string }>[] = []
    let page: Cursor | undefined
    do {
      const conversations = await tx.scanConversations({}, 256, page)
      for (const { id } of conversations.items) {
        const latest = await tx.latestEntryId(id)
        if (latest === undefined || latest <= through) continue
        if (latest > newest) newest = latest
        let cursor: Cursor | undefined
        do {
          const entries = await tx.scanEntries(
            {
              conversationId: id,
              minEntryId: offsetEntryId(through, 1),
              maxEntryId: latest,
              order: 'ascending',
            },
            256,
            cursor,
          )
          for (const entry of entries.items)
            if (entry.conversationId === id && CompactionEntry.is(entry)) missed.push(entry)
          cursor = entries.next
        } while (cursor !== undefined)
      }
      page = conversations.next
    } while (page !== undefined)
    for (const entry of missed.toSorted((a, b) => a.id - b.id)) await announce(tx, entry)
    announced.through = newest
  }
  const advanceTo =
    (newest: EntryId, entry?: TypedEntry<{ reason?: string }>) => async (tx: Tx) => {
      const announced = await tx.doc(Announced, ROOT_CONVERSATION_ID)
      if (announced.through !== undefined && newest <= announced.through) return
      if (entry) await announce(tx, entry)
      announced.through = newest
    }
  let observed: EntryId | undefined
  let failed = false
  let inCommitOrder: Promise<void> = Promise.resolve()
  const next = (work: (tx: Tx) => Promise<void>) => {
    inCommitOrder = inCommitOrder
      .then(() => (failed ? undefined : host.harness().commit(work, context)))
      .catch((error: unknown) => {
        failed = true
        host.notice(`Compaction event, announced again on the next open: ${String(error)}`)
      })
    return inCommitOrder
  }
  let stop: (() => void) | undefined
  host.onOpen(async () => {
    stop?.()
    failed = false
    await next(markHistoryAnnounced)
    if (failed) return
    stop = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'task') {
          const task = change.value
          const notConversationOwnedCompaction =
            task.kind !== CompactionTask.definition.name || task.owner !== undefined
          if (notConversationOwnedCompaction) continue
          if (task.state.status !== 'terminal' || task.state.outcome.status !== 'failed') continue
          if (failuresNoticedAcrossReloads.has(task.id)) continue
          failuresNoticedAcrossReloads.add(task.id)
          host.notice(
            `Compaction of #${task.conversationId} failed: ${task.state.outcome.error.message}`,
          )
          continue
        }
        if (change.type !== 'entry') continue
        const entry = change.value
        if (observed === undefined || entry.id > observed) observed = entry.id
        if (!CompactionEntry.is(entry)) continue
        rebuiltOnOpen(
          'opening announces every compaction past the high-water entry',
          next(advanceTo(entry.id, entry)),
        )
      }
    })
    await next(announceMissed)
  })
  const settle = async () => {
    if (!stop) return
    stop()
    stop = undefined
    if (observed !== undefined) await next(advanceTo(observed))
    await inCommitOrder
  }
  host.onRelease(settle)
  host.onClose(settle)
}
