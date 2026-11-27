import { defineEntry } from '@earendil-works/pi-durable'
import type { SideChatSummary } from './refs.ts'

export const SideChatSummaryEntry = defineEntry<SideChatSummary>('sidechat.summary')
