/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type { GoalEntry } from './refs.ts'

/** Goal launch card. */
export const GoalStartedEntry = defineEntry<GoalEntry>('goal.started')

/** Goal outcome card. */
export const GoalReportEntry = defineEntry<GoalEntry>('goal.report')
