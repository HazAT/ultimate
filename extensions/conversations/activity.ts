import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ConversationId, Cursor } from '@earendil-works/pi-durable'
import { isInput } from '../../lib/entries.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { projection } from './projection.ts'

export function activityBehavior(
  host: Pick<ExtensionHost, 'harness' | 'metadata' | 'onOpen' | 'notice' | 'resource'>,
) {
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
    const head = entries[0]?.head
    const needsActivityBeforeContextHead =
      head !== undefined && (inputAt === undefined || answerAt === undefined)
    if (needsActivityBeforeContextHead) {
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
    const inheritedInputIsOlder =
      previous?.inputAt !== undefined && (inputAt === undefined || inputAt < previous.inputAt)
    if (inheritedInputIsOlder) inputAt = previous.inputAt
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
  projection(
    host,
    { name: 'activity' },
    (change, add) => {
      if (change.type === 'conversation') add(change.value.id)
      if (
        change.type === 'entry' &&
        (isInput(change.value) ||
          change.value.model?.[0]?.role === 'assistant' ||
          change.value.head !== undefined)
      )
        add(change.value.conversationId)
    },
    ([id]) => reconcile(id),
  )
}
