import { defineEntry } from '@earendil-works/pi-durable'
import type {
  TitleChange,
  FeatureChange,
  IntentSummary,
  SpawnSummary,
  ReplySummary,
  SummaryDiscard,
} from './types.ts'

export const TitleChanged = defineEntry<TitleChange>('conversations.title-changed')

export const FeatureChanged = defineEntry<FeatureChange>('conversations.feature-changed')

export const IntentSummarized = defineEntry<IntentSummary>('conversations.intent-summarized')

export const SpawnSummarized = defineEntry<SpawnSummary>('conversations.summarized')

export const ReplySummarized = defineEntry<ReplySummary>('conversations.assessed')

export const SummaryDiscarded = defineEntry<SummaryDiscard>('conversations.summary-discarded')
