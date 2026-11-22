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
import type { ConversationId, Cursor, EntryId, Tx, TypedEntry } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { Compacted } from './refs.ts'

const Announced = defineDoc<{ through?: EntryId }>({
  kind: 'conversations.compactions-announced',
  checkpointWhen: () => true,
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
  const announce = (compactions: Compaction[], upTo: EntryId) => async (tx: Tx) => {
    const announced = await tx.doc(Announced, ROOT_CONVERSATION_ID)
    const through = announced.through!
    for (const entry of compactions) {
      if (entry.id <= through) continue
      const reason = entry.data?.reason
      await host.emit(tx, Compacted, {
        conversation: entry.conversationId,
        entry: entry.id,
        ...(reason ? { reason } : {}),
      })
    }
    if (upTo > through) announced.through = upTo
  }
  const newestEntries = async (tx: Tx) => {
    const latest = new Map<ConversationId, EntryId>()
    let page: Cursor | undefined
    do {
      const conversations = await tx.scanConversations({}, 256, page)
      for (const { id } of conversations.items) {
        const newest = await tx.latestEntryId(id)
        if (newest !== undefined) latest.set(id, newest)
      }
      page = conversations.next
    } while (page !== undefined)
    const announced = await tx.doc(Announced, ROOT_CONVERSATION_ID)
    announced.through ??= parseEntryId(Math.max(0, ...latest.values()))
    return { through: announced.through, latest }
  }
  const markHistoryAnnounced = async () => {
    const harness = host.harness()
    if ((await harness.snapshot(Announced, ROOT_CONVERSATION_ID, context))?.through !== undefined)
      return
    await harness.commit(newestEntries, context)
  }
  const catchUp = async () => {
    const harness = host.harness()
    const { through, latest } = await harness.commit(newestEntries, context)
    const missed: Compaction[] = []
    for (const [id, newest] of latest) {
      if (newest <= through) continue
      const conversation = await harness.conversation(id, context)
      if (!conversation) continue
      let cursor: Cursor | undefined
      do {
        const page = await conversation.entries(
          { minEntryId: offsetEntryId(through, 1), maxEntryId: newest, order: 'ascending' },
          256,
          cursor,
          context,
        )
        for (const entry of page.items)
          if (entry.conversationId === id && CompactionEntry.is(entry)) missed.push(entry)
        cursor = page.next
      } while (cursor !== undefined)
    }
    const upTo = parseEntryId(Math.max(through, ...latest.values()))
    const inOrder = missed.toSorted((a, b) => a.id - b.id)
    await harness.commit(announce(inOrder, upTo), context)
  }
  let observed: EntryId | undefined
  let failed = false
  let inCommitOrder: Promise<void> = Promise.resolve()
  const next = (work: () => Promise<unknown>) => {
    inCommitOrder = inCommitOrder
      .then(() => (failed ? undefined : work()))
      .then(
        () => undefined,
        (error: unknown) => {
          failed = true
          host.notice(`Compaction event, announced again on the next open: ${String(error)}`)
        },
      )
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
          next(() => host.harness().commit(announce([entry], entry.id), context)),
        )
      }
    })
    rebuiltOnOpen('a failed catch-up runs again on the next open', next(catchUp))
  })
  const settle = async () => {
    if (!stop) return
    stop()
    stop = undefined
    const upTo = observed
    await (upTo === undefined
      ? inCommitOrder
      : next(() => host.harness().commit(announce([], upTo), context)))
  }
  host.onRelease(settle)
  host.onClose(settle)
}
