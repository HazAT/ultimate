import { openQuestion } from '../../lib/message-state.ts'
import type { Question } from '../messages/refs.ts'
import type { CardState } from './state.tsx'

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

/**
 * What the user did on cards whose message no longer waits on them is dropped: answered, dismissed, or settled for
 * them by @ultimate, also from another window. The same object when nothing settled, so it writes nothing.
 */
export function forgetSettled(cards: Record<string, CardState>, messages: readonly Message[]) {
  const open = new Set(
    messages.flatMap((message) => (waitsOnUser(message) ? [`message:${message.id}`] : [])),
  )
  const kept = Object.entries(cards).filter(([card]) => open.has(card))
  return kept.length === Object.keys(cards).length ? cards : Object.fromEntries(kept)
}
