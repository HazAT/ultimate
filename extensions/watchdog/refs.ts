/** Watchdog failure cards: the failed conversation, error, last step and retry outcome. */
import type { ConversationId } from '@earendil-works/pi-durable'
export type Failure = {
  conversation: ConversationId
  title: string
  error: string
  step: string
  hint?: string
  retried: boolean
  /** How many automatic continuations ran before this report, when more than one. */
  retries?: number
}
