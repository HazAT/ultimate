import type { Tx } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { isOpen } from '../../lib/message-state.ts'
import { Messages } from './api.ts'
import type { Message } from './api.ts'

export async function append(tx: Tx, input: Omit<Message, 'id' | 'at'>) {
  const log = await tx.doc(Messages, ROOT_CONVERSATION_ID)

  const message = {
    ...input,
    id: log.next++,
    at: Date.now(),
  }
  log.messages.push(message)
  trim(log.messages)
  return message
}

export function trim(messages: Message[], cap = 300) {
  let extra = messages.length - cap
  for (let i = 0; extra > 0 && i < messages.length;) {
    const openMessageMustStayVisible = isOpen(messages[i])
    if (openMessageMustStayVisible) i++
    else {
      messages.splice(i, 1)
      extra--
    }
  }
}
export const terminal = {
  status: 'terminal',
  outcome: { status: 'completed', result: null },
} as const
