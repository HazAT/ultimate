import type { EntryId } from '@earendil-works/pi-durable'

type SummaryWrittenAt = number
type RespondingOrRequestedSummaryModel = string

export type IntentSummary = { summary: string; model?: string; at: number }

export type TitleChange = { title: string; model?: string; at: number }

export type FeatureChange = { feature: string; from: string; model?: string; at: number }

export type SpawnSummary = { summary: string; model?: string; at: number }

export type SummaryStatus = 'pending' | 'ready' | 'stale' | 'error'
export type ReplySummary = {
  inputId: EntryId
  answerId: EntryId
  activity: string
  summary?: string
  model?: string
  at: number
}
export type SummaryRecord = { summary: string; at?: SummaryWrittenAt }
export type SummaryDiscard = {
  reason: 'stale' | 'error'
  cause: string
  model?: RespondingOrRequestedSummaryModel
  at: number
}
export type OverviewRow = {
  runState: 'working' | 'queued' | 'idle' | 'answered' | 'error'
  inputId?: number
  internalInput?: true
  answerId?: number
  summary?: string
  feature?: string
  summaryStatus?: SummaryStatus
  activity?: string
  assessmentStatus?: SummaryStatus
}
export type OverviewState = { conversations: Record<string, OverviewRow> }

export type ConversationSubject = { title?: string; summary?: string; feature?: string }
export type KeptWork = {
  id: number
  uncommitted: number
  unlanded: number
  busy?: string
  reason?: string
  descendant?: number
}
