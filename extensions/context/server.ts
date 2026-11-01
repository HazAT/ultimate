import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { comparePrompts, promptOf } from './breakdown.ts'
import { CurrentPromptAction } from './refs.ts'

export default defineExtension({ name: 'context' })

export const actions = {
  currentPrompt: implementAction(CurrentPromptAction, async (args, { host, conversationId }) => {
    const since = args && typeof args === 'object' && !Array.isArray(args) ? args.since : undefined
    if (since !== undefined && !Number.isSafeInteger(since)) throw new Error('since is an entry id')
    if (conversationId === undefined) throw new Error('No conversation')
    const conversation = await host
      .harness()
      .conversation(conversationId as ConversationId, context)
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`)
    // The model context carries every system message in effect, also those far older than the stream's window.
    const view = await conversation.context(context)
    const prompt = promptOf(view.messages)
    const at = view.entries.findLast((entry) => entry.kind === 'pi.system')?.id
    if (since === undefined || since === at) return { prompt, ...(at && { at }) }
    const before = await conversation.context(context, { at: since as EntryId })
    return {
      prompt,
      ...(at && { at }),
      ...(before.entries.length > 0 && { diff: comparePrompts(promptOf(before.messages), prompt) }),
    }
  }),
}
