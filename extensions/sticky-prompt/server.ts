import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { ConversationId, Cursor, EntryId } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { TurnAction } from './refs.ts'
import { turnLine } from './turn.ts'

export default { name: 'sticky-prompt' }

const PAGE = 512

export const pollActions = ['turn']
export const actions = {
  turn: implementAction(TurnAction, async (args, { host }) => {
    const { conversation, before } = (args ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(conversation)) throw new Error('conversation must be an id')
    if (!Number.isSafeInteger(before)) throw new Error('before must be an entry id')
    const own = await host.harness().conversation(conversation as ConversationId, context)
    if (!own) throw new Error(`Unknown conversation #${conversation as number}`)
    let cursor: Cursor | undefined
    do {
      const page = await own.entries(
        { maxEntryId: ((before as number) - 1) as EntryId },
        PAGE,
        cursor,
        context,
      )
      for (const entry of page.items) {
        // A fork's history before its first entry is its source's, which its transcript does not show.
        if (entry.conversationId !== own.id) return {}
        const turn = turnLine(entry)
        if (turn) return { turn }
      }
      cursor = page.next
    } while (cursor)
    return {}
  }),
}
