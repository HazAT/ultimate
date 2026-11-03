import type { EntryId } from '@earendil-works/pi-durable'

/** `model`: the summary model that answered, as in `ReplySummary`. */
export type IntentSummary = { summary: string; model?: string; at: number }

export type TitleChange = { title: string; model?: string; at: number }

/** An accepted change of the feature tag from `from`; a conversation's first tag is not a change. */
export type FeatureChange = { feature: string; from: string; model?: string; at: number }

/** An accepted spawn or steer refresh, recorded even when the title stays. */
export type SpawnSummary = { summary: string; model?: string; at: number }

/** `stale`: newer work or a reset superseded the result; `error`: the request failed. */
export type SummaryStatus = 'pending' | 'ready' | 'stale' | 'error'
/**
 * What the latest final reply did, in one line, for the exchange `inputId` → `answerId`; `summary` when this reply also
 * refreshed the conversation's summary.
 */
export type ReplySummary = {
  inputId: EntryId
  answerId: EntryId
  activity: string
  summary?: string
  model?: string
  at: number
}
/** One summary a conversation had: `at` is when it was written, absent when no entry recorded it. */
export type SummaryRecord = { summary: string; at?: number }
export type SummaryDiscard = {
  reason: 'stale' | 'error'
  cause: string
  /** The summary model that answered or was asked, when one was chosen. */
  model?: string
  at: number
}
export type OverviewRow = {
  /** `answered`: the latest input got a reply. */
  runState: 'working' | 'queued' | 'idle' | 'answered' | 'error'
  inputId?: number
  /** The latest input is extension-authored rather than a plain user message. */
  internalInput?: true
  answerId?: number
  summary?: string
  feature?: string
  summaryStatus?: SummaryStatus
  activity?: string
  /** The reply summary's state for the latest answer: `error` when it could not be written. */
  assessmentStatus?: SummaryStatus
}
export type OverviewState = { conversations: Record<string, OverviewRow> }

/** What a conversation is about at one moment: its title, summary and feature, as a record keeps them (a landing). */
export type ConversationSubject = { title?: string; summary?: string; feature?: string }
/** Work kept when concluding a conversation, including its owned descendants: why its resources stay. */
export type KeptWork = {
  id: number
  uncommitted: number
  unlanded: number
  busy?: string
  reason?: string
  descendant?: number
}
