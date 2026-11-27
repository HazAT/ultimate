import { defineEntry } from '@earendil-works/pi-durable'
import type { ConversationId } from '@earendil-works/pi-durable'

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

export const WalkthroughEntry = defineEntry<Record<string, never>>('walkthrough.start')

export const ChoiceEntry = defineEntry<{
  card: string
  summary: string
  toolCallId: string
  missing?: string[]
}>('onboarding.choice')
