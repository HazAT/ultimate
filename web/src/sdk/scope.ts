import type { ConversationId } from '@earendil-works/pi-durable'
import { parseConversationId } from '../../../lib/ids.shared.ts'

export const scopeAttribute = 'data-conversation-scope'

/** The conversation of the conversation scope around an element, or undefined outside every scope. */
export function scopeOf(target: EventTarget | null): ConversationId | undefined {
  const scope = target instanceof HTMLElement ? target.closest(`[${scopeAttribute}]`) : null
  const id = Number(scope?.getAttribute(scopeAttribute))
  return Number.isSafeInteger(id) && id > 0 ? parseConversationId(id) : undefined
}
