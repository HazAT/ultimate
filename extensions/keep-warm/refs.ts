/** Keep warm in the browser: a standing agent's or branch coordinator's policy, overrides and what was done. Browser-safe. */
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** One keep-warm request, recorded as `interrupted` before it is sent. */
export type Ping = {
  at: number
  provider: string
  model: string
  read?: number
  write?: number
  error?: string
}

/** One compaction this extension started: its task, the context size before it, and the cache-reading summary's usage. */
export type Compaction = {
  at: number
  task: TaskId
  tokens: number
  read?: number
  write?: number
  error?: string
}

/** On each warmed conversation. `warm`, `compact` and `minutes` override its agent definition's `cache`. */
export type WarmDocState = {
  warm?: boolean
  compact?: boolean
  minutes?: number
  /** On conversation 1 only: the earlier on/off switch, carried over as @ultimate's `warm: false` and removed. */
  off?: true
  /** The user's latest input to this standing agent (ms): its warm window counts from here. */
  inputAt?: number
  /** Its latest answered request: when it was sent, on which model, and whether it read or wrote the cache. */
  request?: { at: number; provider: string; model: string; uncached?: true }
  /** The `keep-warm.ping` task that sleeps until its next step; any other one that wakes ends. */
  waker?: TaskId
  /** The latest ping attempt, failed or not. */
  last?: Ping
  pings?: number
  /** Pings that warmed the real request at `since` (ms), and what they cost in dollars; a new warming run starts it again. */
  streak?: { since: number; cost: number; pings: number }
  compaction?: Compaction
}

/** Where a value comes from: this conversation's override, its agent definition, the built-in default, or the model. */
export type Source = 'override' | 'agent' | 'default' | 'model'

export type Setting<T> = { value: T; source: Source }

export type WarmState = {
  /** `standing` counts its window from the user's last input, `coordinator` from its last request. */
  kind?: 'standing' | 'coordinator'
  /** The agent definition its policy comes from. */
  agent?: string
  warm: Setting<boolean>
  compact: Setting<boolean>
  /** How long it is kept warm while idle, after its last input or request. */
  minutes: Setting<number>
  compactTokens: Setting<number>
  provider?: string
  model?: string
  /** How long the model's provider keeps its prompt cache (ms); unset when it is unknown. */
  ttl?: number
  /** How long after a request on the cache the next ping is due (ms): 90 % of `ttl`, as pi's own warmer. */
  pingAfter?: number
  /** False when the model's requests cannot be re-sent without changing the cache (budget-based thinking). */
  replayable?: boolean
  /** What writing the current context to the cache again would cost, in dollars (a one-hour write is twice the input price). */
  rewriteCost?: number
  /** What keeping the current context warm for `minutes` would cost: one cache read of it per ping, in dollars. */
  warmCost?: { pings: number; cost: number }
  /** What the live warming run's pings have cost so far, in dollars. */
  kept?: { cost: number; pings: number }
  inputAt?: number
  /** The latest request on the cache, real or a ping (ms); the cache is warm for `ttl` after it. */
  lastAt?: number
  /** When its warm window ends (ms), while the next step is a ping: no ping is sent after it. */
  warmUntil?: number
  /** It has a run: it is kept warm at least an hour after its request. */
  running?: boolean
  /** Context size now, in tokens. */
  tokens: number
  /** When the next step is due and which, while one will run. */
  next?: { at: number; step: 'ping' | 'compact' }
  /** Why no step is coming, when none is. */
  idle?: string
  last?: Ping
  pings: number
  compaction?: Compaction
}

/** On each warmed conversation: its overrides, the user's last input, the last ping and the last compaction. */
export const WarmDoc = docRef<WarmDocState>('keep-warm.state')
/** `{ id }` → the conversation's policy with sources, its model's cache lifetime, and its next step. */
export const StateAction = actionRef<{ id: ConversationId }, WarmState>('keep-warm', 'state')
/** User-only `{ id, warm?, compact?, minutes? }`: override its agent's policy here; `null` removes an override. */
export const SetAction = actionRef<
  {
    id: ConversationId
    warm?: boolean | null
    compact?: boolean | null
    minutes?: number | null
  },
  WarmState
>('keep-warm', 'set')
