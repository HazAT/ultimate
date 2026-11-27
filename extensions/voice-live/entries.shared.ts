import { defineEntry } from '@earendil-works/pi-durable'
import type { VoiceHandoff, VoiceTurn } from './refs.ts'

export const VoiceTurnEntry = defineEntry<VoiceTurn>('voice.turn')

export const VoiceHandoffEntry = defineEntry<VoiceHandoff>('voice.handoff')
