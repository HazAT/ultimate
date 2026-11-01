/** The shared Messages log: appending to it, and the terminal outcome its tasks commit. */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
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
  if (log.messages.length > 300) log.messages.splice(0, log.messages.length - 300)
  return message
}
export const terminal = {
  status: 'terminal',
  outcome: { status: 'completed', result: null },
} as const
