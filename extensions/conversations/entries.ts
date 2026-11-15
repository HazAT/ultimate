/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type {
  TitleChange,
  FeatureChange,
  IntentSummary,
  SpawnSummary,
  ReplySummary,
  SummaryDiscard,
} from './types.ts'

/** Title selected by a summary task. */
export const TitleChanged = defineEntry<TitleChange>('conversations.title-changed')

/** Feature tag selected by a summary task. */
export const FeatureChanged = defineEntry<FeatureChange>('conversations.feature-changed')

/** Summary of the branch intent. */
export const IntentSummarized = defineEntry<IntentSummary>('conversations.intent-summarized')

/** An accepted spawn or steer refresh; the task input names the delegation or steer. */
export const SpawnSummarized = defineEntry<SpawnSummary>('conversations.summarized')

/** An accepted reply summary; older entries also carried a judgement value. */
export const ReplySummarized = defineEntry<ReplySummary>('conversations.assessed')

/** A summary task result superseded or failed. */
export const SummaryDiscarded = defineEntry<SummaryDiscard>('conversations.summary-discarded')
