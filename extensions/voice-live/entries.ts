/** Typed transcript entries written by this extension. Browser-safe. */
import { defineEntry } from '@earendil-works/pi-durable'
import type {
  VoiceLine,
  VoiceSession,
  VoiceContext,
  VoiceQuestion,
  VoiceUtterance,
  VoiceAnswer,
} from './refs.ts'

/** Voice transcript payloads, shared by the relay writer and its views. */
export const VoiceLineEntry = defineEntry<VoiceLine>('voice.line')

/** Session boundary in the voice transcript. */
export const VoiceSessionEntry = defineEntry<VoiceSession>('voice.session')

/** Context supplied to Voice. */
export const VoiceContextEntry = defineEntry<VoiceContext>('voice.context')

/** Question announced by Voice. */
export const VoiceQuestionEntry = defineEntry<VoiceQuestion>('voice.question')

/** Spoken input delivered to @ultimate. */
export const VoiceUtteranceEntry = defineEntry<VoiceUtterance>('voice.utterance')

/** Full answer received from @ultimate. */
export const VoiceAnswerEntry = defineEntry<VoiceAnswer>('voice.answer')

/** Raw microphone transcript. */
export const VoiceHeardEntry = defineEntry<{ text: string }>('voice.heard')
