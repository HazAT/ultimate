/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type { AutomationInput } from './refs.ts'

/** Script failure delivered to a subscriber. */
export const FailedEntry = defineEntry<AutomationInput>('automations.failed')

/** Watcher escalation delivered to a subscriber. */
export const EscalatedEntry = defineEntry<AutomationInput>('automations.escalated')

/** Watcher's first task. */
export const WritingEntry = defineEntry<AutomationInput>('automations.writing')
