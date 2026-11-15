import { defineEntry } from '@earendil-works/pi-durable'
import type { SideChatSummary } from './refs.ts'

/** Passive summary injected into @ultimate. */
export const SideChatSummaryEntry = defineEntry<SideChatSummary>('sidechat.summary')
