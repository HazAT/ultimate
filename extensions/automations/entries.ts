import { defineEntry } from '@earendil-works/pi-durable'
import type { AutomationInput } from './refs.ts'

export const FailedEntry = defineEntry<AutomationInput>('automations.failed')

export const EscalatedEntry = defineEntry<AutomationInput>('automations.escalated')

export const WritingEntry = defineEntry<AutomationInput>('automations.writing')
