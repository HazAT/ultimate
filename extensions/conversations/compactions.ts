import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { rebuiltOnOpen } from '../../lib/errors.ts'
import { offsetEntryId } from '../../lib/ids.ts'
import {
  CompactionEntry,
  CompactionTask,
  defineDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, EntryId, Tx, TypedEntry } from '@earendil-works/pi-durable'
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

type Compaction = TypedEntry<{ reason?: string }>

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
  const announce = async (tx: Tx, compactions: Compaction[], newest: EntryId) => {
    const announced = await tx.doc(Announced, ROOT_CONVERSATION_ID)
    const through = announced.through
    for (const entry of compactions) {
      if (through !== undefined && entry.id <= through) continue
      const reason = entry.data?.reason
      await host.emit(tx, Compacted, {
        conversation: entry.conversationId,
        entry: entry.id,
        ...(reason ? { reason } : {}),
      })
    }
    if (through === undefined || newest > through) announced.through = newest
  }
  const announceMissed = async () => {
    const harness = host.harness()
    const through = (await harness.snapshot(Announced, ROOT_CONVERSATION_ID, context))?.through
    let newest = through
    const moved = await harness.commit(async (tx) => {
      const found: ConversationId[] = []
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const { id } of page.items) {
          const latest = await tx.latestEntryId(id)
          if (latest === undefined || (through !== undefined && latest <= through)) continue
          if (newest === undefined || latest > newest) newest = latest
          found.push(id)
        }
        cursor = page.next
      } while (cursor !== undefined)
      return through === undefined ? [] : found
    }, context)
    const missed: Compaction[] = []
    for (const id of moved) {
      const conversation = await harness.conversation(id, context)
      if (!conversation) continue
      const sinceMark = { minEntryId: offsetEntryId(through!, 1), order: 'ascending' as const }
      let cursor: Cursor | undefined
      do {
        const page = await conversation.entries(sinceMark, 256, cursor, context)
        for (const entry of page.items)
          if (entry.conversationId === id && CompactionEntry.is(entry)) missed.push(entry)
        cursor = page.next
      } while (cursor !== undefined)
    }
    if (newest === undefined) return
    const beforeObserved = (id: EntryId) => firstObserved === undefined || id < firstObserved
    const upTo = beforeObserved(newest) ? newest : offsetEntryId(firstObserved!, -1)
    const unobserved = missed.filter((entry) => beforeObserved(entry.id))
    unobserved.sort((a, b) => a.id - b.id)
    await harness.commit((tx) => announce(tx, unobserved, upTo), context)
  }
  let firstObserved: EntryId | undefined
  let observed: EntryId | undefined
  let failed = false
  let inCommitOrder: Promise<void> = Promise.resolve()
  const next = (work: () => Promise<void>) => {
    inCommitOrder = inCommitOrder.then(work).catch((error: unknown) => {
      failed = true
      host.notice(`Compaction event: ${String(error)}`)
    })
    return inCommitOrder
  }
  let stop: (() => void) | undefined
  host.onOpen(async () => {
    stop?.()
    firstObserved = undefined
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
        firstObserved ??= entry.id
        if (observed === undefined || entry.id > observed) observed = entry.id
        if (!CompactionEntry.is(entry)) continue
        rebuiltOnOpen(
          'opening announces every compaction past the high-water entry',
          next(() => host.harness().commit((tx) => announce(tx, [entry], entry.id), context)),
        )
      }
    })
    await next(announceMissed)
  })
  const settle = async () => {
    if (!stop) return
    stop()
    stop = undefined
    const upTo = observed
    if (upTo !== undefined && !failed)
      await next(() => host.harness().commit((tx) => announce(tx, [], upTo), context))
    await inCommitOrder
  }
  host.onRelease(settle)
  host.onClose(settle)
}
