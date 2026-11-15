/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'

/** First onboarding input and the facts gathered for it. */
export const StartEntry = defineEntry<{
  root: ConversationId
  instructions?: string
  facts: {
    project: { name: string; path: string }
    firstRun: boolean
    projectUndecided: boolean
    gitReason?: string
    root: ConversationId
    rootEmpty: boolean
  }
}>('onboarding.start')

/** A requested walkthrough. */
export const WalkthroughEntry = defineEntry<Record<string, never>>('walkthrough.start')

/** A settled setup choice. */
export const ChoiceEntry = defineEntry<{ card: string; summary: string; toolCallId: string }>(
  'onboarding.choice',
)
