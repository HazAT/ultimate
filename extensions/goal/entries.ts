import { defineEntry } from '@earendil-works/pi-durable'
import type { GoalEntry } from './refs.ts'

export const GoalStartedEntry = defineEntry<GoalEntry>('goal.started')

export const GoalReportEntry = defineEntry<GoalEntry>('goal.report')
