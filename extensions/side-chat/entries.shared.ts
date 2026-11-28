import { defineEntry, type ConversationId } from '@earendil-works/pi-durable'
import type { SideChatHandoff, SideChatSummary, SideChatTurn } from './refs.ts'

export const SideChatTurnEntry = defineEntry<SideChatTurn>('side-chat.turn')

export const SideChatHandoffEntry = defineEntry<SideChatHandoff>('side-chat.handoff')

export const SideChatSummaryEntry = defineEntry<SideChatSummary>('side-chat.summary')

export const LegacyVoiceTurnEntry = defineEntry<SideChatTurn>('voice.turn')

export const LegacyVoiceHandoffEntry = defineEntry<SideChatHandoff>('voice.handoff')

export const LegacyVoiceSummaryEntry = defineEntry<SideChatSummary>('voice.summary')

export const LegacySummaryEntry = defineEntry<{ side: ConversationId; text: string }>(
  'sidechat.summary',
)

export const QUIET_MINUTES = 20
