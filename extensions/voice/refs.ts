/** Voice input in the browser: whether a ChatGPT login or an OpenAI API key can transcribe, and the action that does. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Whether voice input works: `available` with a ChatGPT login or an OpenAI API key, else `reason` says what to do. */
export type VoiceStatus = { available: true } | { available: false; reason: string }

/** No arguments → whether a ChatGPT login or an OpenAI API key exists to transcribe with. */
export const StatusAction = actionRef<null, VoiceStatus>('voice', 'status')
/** `{ audio: base64, mimeType }` → the transcribed text. Fails with a message the composer shows as is. */
export const TranscribeAction = actionRef<{ audio: string; mimeType: string }, { text: string }>(
  'voice',
  'transcribe',
)
