import { defineEntry } from '@earendil-works/pi-durable'
import type {
  VoiceLine,
  VoiceSession,
  VoiceContext,
  VoiceQuestion,
  VoiceUtterance,
  VoiceAnswer,
} from './refs.ts'

export const VoiceLineEntry = defineEntry<VoiceLine>('voice.line')

export const VoiceSessionEntry = defineEntry<VoiceSession>('voice.session')

export const VoiceContextEntry = defineEntry<VoiceContext>('voice.context')

export const VoiceQuestionEntry = defineEntry<VoiceQuestion>('voice.question')

export const VoiceUtteranceEntry = defineEntry<VoiceUtterance>('voice.utterance')

export const VoiceAnswerEntry = defineEntry<VoiceAnswer>('voice.answer')

export const VoiceHeardEntry = defineEntry<{ text: string }>('voice.heard')
