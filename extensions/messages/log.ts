/** The shared Messages log: appending to it, and the terminal outcome its tasks commit. */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import { isOpen } from '../../lib/message-state.ts'
import { Messages } from './api.ts'
import type { Message } from './api.ts'
import { Started } from './addresses.ts'

export async function append(tx: Tx, input: Omit<Message, 'id' | 'at'>) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  // A branch's reply to its starter awaits the starter's answer, which `board.route` sends down; anyone else's reply
  // (a standing agent's) just answered and awaits nothing.
  const awaits =
    input.re !== undefined &&
    typeof input.from === 'number' &&
    (await tx.doc(Started, input.from as ConversationId)).by === input.to
  const message = {
    ...input,
    ...(awaits ? { awaits: true as const } : {}),
    id: log.next++,
    at: Date.now(),
  }
  log.messages.push(message)
  trim(log.messages)
  return message
}

/**
 * Keeps the log at 300 items by dropping the oldest closed ones. An open message (a question waiting on the user, a
 * reply still owed) is never dropped: every view of what waits reads this log, so a dropped one would wait unseen.
 */
export function trim(messages: Message[], cap = 300) {
  let extra = messages.length - cap
  for (let i = 0; extra > 0 && i < messages.length;)
    if (isOpen(messages[i])) i++
    else {
      messages.splice(i, 1)
      extra--
    }
}
export const terminal = {
  status: 'terminal',
  outcome: { status: 'completed', result: null },
} as const
