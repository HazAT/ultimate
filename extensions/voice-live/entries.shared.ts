import { defineEntry } from '@earendil-works/pi-durable'
import type { VoiceHandoff, VoiceSummary, VoiceTurn } from './refs.ts'

export const VoiceTurnEntry = defineEntry<VoiceTurn>('voice.turn')

export const VoiceHandoffEntry = defineEntry<VoiceHandoff>('voice.handoff')

export const VoiceSummaryEntry = defineEntry<VoiceSummary>('voice.summary')

export const QUIET_MINUTES = 20
