import { openQuestion } from '../../lib/message-state.ts'
import type { Question } from '../messages/refs.ts'

/** The fields of a message the answer card reads. */
export type Message = {
  id: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  reply: boolean
  state: string
  questions?: Question[]
}

/** Whether a message to the user still waits on their answer or dismissal. */
export const waitsOnUser = (message: Message) => openQuestion(message)

/** The questions of a message while it still waits on the user's reply; none once it is answered or dismissed. */
export function openQuestions(message: Message) {
  return waitsOnUser(message) ? (message.questions ?? []) : []
}

/** Every message that waits on the user, newest first. */
export const waiting = <M extends Message>(messages: readonly M[]) =>
  messages.filter(waitsOnUser).toReversed()

/** The newest message showing an answer card: only it takes the desktop 1–9 and Enter keys. */
export function newestAsked(messages: readonly Message[]) {
  return messages.findLast((message) => openQuestions(message).length > 0)?.id
}

/** The card taking desktop keys on a conversation's page: its newest open message with an answer card. */
export const keyCard = (conversation: number | undefined, messages: readonly Message[]) => {
  const id = newestAsked(messages.filter((message) => message.from === conversation))
  return id === undefined ? undefined : `message:${id}`
}
