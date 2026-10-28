/** The shared Messages log: appending to it, and the terminal outcome its tasks commit. */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { Tx } from '@earendil-works/pi-durable'
import { Messages } from './api.ts'
import type { Message } from './api.ts'

export async function append(tx: Tx, input: Omit<Message, 'id' | 'at'>) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)
  const message = { ...input, id: log.next++, at: Date.now() }
  log.messages.push(message)
  if (log.messages.length > 300) log.messages.splice(0, log.messages.length - 300)
  return message
}
/** The messages reply `m` answers, as the model reads them: "message 4", "messages 4 and 6". */
export function answered(m: Pick<Message, 're' | 'also'>) {
  const ids = [m.re!, ...(m.also ?? [])]
  return ids.length === 1
    ? `message ${ids[0]}`
    : `messages ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`
}
export const terminal = {
  status: 'terminal',
  outcome: { status: 'completed', result: null },
} as const
