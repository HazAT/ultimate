/** Voice input in the browser: whether an OpenAI API key can transcribe, and the transcription action. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Whether voice input works: `available` with an OpenAI API key, else `reason` says what to do. */
export type VoiceStatus = { available: true } | { available: false; reason: string }

/** No arguments → whether an OpenAI API key exists to transcribe with. */
export const StatusAction = actionRef<null, VoiceStatus>('dictation', 'status')
/** `{ audio: base64, mimeType }` → the transcribed text. Fails with a message the composer shows as is. */
export const TranscribeAction = actionRef<{ audio: string; mimeType: string }, { text: string }>(
  'dictation',
  'transcribe',
)
