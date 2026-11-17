import type { ConversationId } from '@earendil-works/pi-durable'
import { openQuestion } from '../../lib/message-state.ts'
import type { Question } from '../messages/refs.ts'
import type { CardState } from './state.tsx'

export type Message = {
  id: number
  from: number | 'user' | 'remote'
  to: number | 'user' | 'remote'
  reply: boolean
  state: string
  questions?: Question[]
}

export const waitsOnUser = (message: Message) => openQuestion(message)

export function openQuestions(message: Message) {
  return waitsOnUser(message) ? (message.questions ?? []) : []
}

export const waiting = <M extends Message>(messages: readonly M[]) =>
  messages.filter(waitsOnUser).toReversed()

export function newestAsked(messages: readonly Message[]) {
  return messages.findLast((message) => openQuestions(message).length > 0)?.id
}

export const keyCard = (conversation: ConversationId | undefined, messages: readonly Message[]) => {
  const id = newestAsked(messages.filter((message) => message.from === conversation))
  return id === undefined ? undefined : `message:${id}`
}

export function forgetSettled(cards: Record<string, CardState>, messages: readonly Message[]) {
  const open = new Set(
    messages.flatMap((message) => (waitsOnUser(message) ? [`message:${message.id}`] : [])),
  )
  const kept = Object.entries(cards).filter(([card]) => open.has(card))
  const keepStoreIdentityWhenNothingSettled = kept.length === Object.keys(cards).length
  return keepStoreIdentityWhenNothingSettled ? cards : Object.fromEntries(kept)
}
