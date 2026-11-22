/** Keep warm in the browser: whether @ultimate's prompt cache is kept warm, and the last ping. Browser-safe. */
import type { TaskId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/**
 * One keep-warm request: when, on which provider and model, what it read from and wrote to the cache, or why it failed. Recorded as
 * `interrupted` before it is sent, so a crash mid-request counts as a failure.
 */
export type Ping = {
  at: number
  /** @ultimate's conversation whose cache it renewed; absent on pings recorded before it was, which count for @ultimate's current one. */
  conversation?: number
  provider: string
  model: string
  read?: number
  write?: number
  error?: string
}

/**
 * On conversation 1. `off` when the user turned it off (it is on by default); the user's latest input to @ultimate
 * (ms, from `user.input` events); when @ultimate last got an answer that read or wrote its cache, per
 * `conversation:provider/model` (ms); the last ping and how many ran; the task that sleeps until the next ping, while one is planned.
 */
export type WarmDocState = {
  off?: true
  inputAt?: number
  answers?: Record<string, number>
  last?: Ping
  pings?: number
  waker?: TaskId
}

export type WarmState = {
  on: boolean
  /** @ultimate's latest request on its cache, an answer or a ping (ms); the cache is warm for an hour after it. */
  lastRequest?: number
  /** The user's latest input to @ultimate (ms); pings stop 8 hours after it. */
  inputAt?: number
  /** When the next ping is due (ms), while one will run. */
  nextAt?: number
  last?: Ping
  pings: number
}

/** On conversation 1: off when the user turned it off, the last ping and how many ran. */
export const WarmDoc = docRef<WarmDocState>('keep-warm.state')
/** No arguments → whether it is on, the cache's last request, the next ping and the last one. */
export const StateAction = actionRef<null, WarmState>('keep-warm', 'state')
/** User-only `{ on }`: keep @ultimate's cache warm, or stop. Returns the state. */
export const SetAction = actionRef<{ on: boolean }, WarmState>('keep-warm', 'set')
