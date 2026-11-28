import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Cursor, EntryId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../server/extensions.ts'

export class NoSettledInputAnswer extends Error {
  constructor(conversation: ConversationId) {
    super(`#${conversation} has no finished turn to fork yet`)
  }
}

export async function lastSettledInputAnswer(
  host: ExtensionHost,
  conversation: ConversationId,
  context: Context,
): Promise<EntryId> {
  let cursor: Cursor | undefined
  let answer: EntryId | undefined
  do {
    const page = await host.scanSubmissions(
      { conversationId: conversation, status: 'done' },
      100,
      cursor,
      context,
    )
    for (const input of page.items)
      if (
        input.type === 'input' &&
        input.status === 'done' &&
        (answer === undefined || input.answer > answer)
      )
        answer = input.answer
    cursor = page.next
  } while (cursor)
  if (answer === undefined) throw new NoSettledInputAnswer(conversation)
  return answer
}

export async function answerIncludingClosingToolResults(
  tx: Tx,
  conversation: ConversationId,
  answer: EntryId,
): Promise<EntryId> {
  const entry = (await tx.entry(answer))!
  const pending = new Set(
    entry.model?.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'toolCall' ? [part.id] : []))
        : [],
    ) ?? [],
  )
  if (!pending.size) return answer
  let cursor: Cursor | undefined
  do {
    const page = await tx.scanEntries(
      { conversationId: conversation, minEntryId: answer, order: 'ascending' },
      100,
      cursor,
    )
    for (const result of page.items) {
      for (const message of result.model ?? [])
        if (message.role === 'toolResult') pending.delete(message.toolCallId)
      if (!pending.size) return result.id
    }
    cursor = page.next
  } while (cursor)
  throw new Error(`Finished answer #${conversation}/${answer} is missing its tool results`)
}
