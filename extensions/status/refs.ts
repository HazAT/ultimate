/** Status: one compact read-only summary of this Ultimate, for dashboards that poll it. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'

export type Status = {
  /** When this answer was made, epoch ms. */
  at: number
  /**
   * The generation this host serves, from `ULTIMATE_GENERATION`: the supervisor bumps it on every core swap, so a
   * caller that asked for a restart sees the new generation once the new core answers.
   */
  generation: number
  /**
   * Optional project progress from the first enabled extension's `projectProgress {}` action that returns a valid result.
   * A nonempty label, safe integer index from 0 through total, and positive safe integer total. Null, invalid
   * results and errors are absent; extensions without progress need no action.
   */
  progress?: { label: string; index: number; total: number }
  /**
   * The clone Ultimate runs from, from Update's last check (origin is fetched hourly, never per call). Absent while
   * Update is off, on a preview, or cannot read the clone (origin has no default branch).
   */
  head?: {
    sha: string
    branch?: string
    /** Commits on origin the clone lacks, as of `fetchedAt`. */
    behind: number
    /** The clone's own commits origin lacks. */
    ahead: number
    /** When origin was last fetched, epoch ms. */
    fetchedAt?: number
    /** Why the last fetch failed. */
    error?: string
  }
  /** Failed runs Watchdog reported since `since`, newest first, at most 20. Absent while Watchdog is off. */
  failures?: {
    conversation: ConversationId
    title: string
    at: number
    error: string
    retried: boolean
    retries?: number
  }[]
  /** Each model provider with a login on this machine. Absent while Health is off. */
  providers?: { provider: string; state: 'ok' | 'failing' | 'unknown'; error?: string }[]
  /** Messages waiting on the user's answer; `first` is the oldest. */
  questions: {
    count: number
    first?: { text: string; conversation: ConversationId; message: number }
  }
  /** Conversations running a turn now. */
  busy: number
  /** Every discovered extension; `error` is why its server facet failed to load. */
  extensions: {
    name: string
    source: 'builtin' | 'user' | 'project'
    enabled: boolean
    error?: string
  }[]
}

/** `{ since? }` (epoch ms, default 24 hours ago) → this Ultimate's status. Read-only. */
export const StatusAction = actionRef<{ since?: number }, Status>('status', 'status')
