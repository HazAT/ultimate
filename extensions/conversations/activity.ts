import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import { isInput } from '../../lib/entries.ts'
import type { ExtensionHost } from '../../server/extensions.ts'

/** Publish sidebar naming and activity in metadata; core reads the projection without interpreting history. */
export function activityBehavior(
  host: Pick<ExtensionHost, 'harness' | 'metadata' | 'onOpen' | 'onClose' | 'notice'>,
) {
  let stop: (() => void) | undefined
  let closed = false
  let draining: Promise<void> | undefined
  const pending = new Set<ConversationId>()
  const reconcile = async (id: ConversationId) => {
    const conversation = await host.harness().conversation(id, context)
    if (!conversation) return
    const { entries } = await conversation.context(context)
    const input = entries.find(isInput)?.model?.[0]
    const title =
      input?.role === 'user'
        ? typeof input.content === 'string'
          ? input.content
          : input.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ')
        : undefined
    let inputAt = entries.findLast(isInput)?.model?.[0]?.timestamp
    let answerAt = entries.findLast((entry) => entry.model?.[0]?.role === 'assistant')?.model?.[0]
      ?.timestamp
    // Reset and compaction cut the view, not the conversation's activity history.
    const head = entries[0]?.head
    if (head !== undefined && (inputAt === undefined || answerAt === undefined)) {
      let cursor: Cursor | undefined
      do {
        const page = await conversation.entries({ maxEntryId: head }, 64, cursor, context)
        for (const entry of page.items) {
          if (isInput(entry)) inputAt ??= entry.model?.[0]?.timestamp
          if (entry.model?.[0]?.role === 'assistant') answerAt ??= entry.model[0].timestamp
        }
        cursor = page.next
      } while (cursor !== undefined && (inputAt === undefined || answerAt === undefined))
    }
    const inputTitle = title ? title.replace(/\s+/g, ' ').slice(0, 160) : undefined
    const previous = await host.harness().snapshot(host.metadata, id, context)
    // The latest input only moves forward: a branch is active from the moment it was asked for, while the history
    // it inherited is older.
    if (previous?.inputAt !== undefined && (inputAt === undefined || inputAt < previous.inputAt))
      inputAt = previous.inputAt
    if (
      previous?.inputTitle === inputTitle &&
      previous?.inputAt === inputAt &&
      previous?.answerAt === answerAt
    )
      return
    await host.harness().commit(async (tx) => {
      const metadata = await tx.doc(host.metadata, id)
      if (inputTitle !== undefined) metadata.inputTitle = inputTitle
      else delete metadata.inputTitle
      if (inputAt !== undefined) metadata.inputAt = inputAt
      else delete metadata.inputAt
      if (answerAt !== undefined) metadata.answerAt = answerAt
      else delete metadata.answerAt
    }, context)
  }
  const schedule = () => {
    if (draining || closed) return
    draining = (async () => {
      while (pending.size) {
        if (closed) break
        const ids = [...pending]
        pending.clear()
        for (const id of ids) await reconcile(id)
      }
    })()
      .catch((error: unknown) => {
        if (!closed) host.notice(`Conversation activity: ${String(error)}`)
      })
      .finally(() => {
        draining = undefined
        if (pending.size && !closed) schedule()
      })
  }
  host.onOpen(async () => {
    closed = false
    // Not a reactor: activity follows Pi's conversation records and entries, not domain events.
    stop = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'conversation') pending.add(change.value.id)
        if (
          change.type === 'entry' &&
          (isInput(change.value) ||
            change.value.model?.[0]?.role === 'assistant' ||
            change.value.head !== undefined)
        )
          pending.add(change.value.conversationId)
      }
      if (pending.size) schedule()
    })
    await host.harness().commit(async (tx) => {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanConversations({}, 256, cursor)
        for (const own of page.items) pending.add(own.id)
        cursor = page.next
      } while (cursor !== undefined)
    }, context)
    schedule()
    await draining
  })
  host.onClose(async () => {
    closed = true
    stop?.()
    await draining
  })
}
