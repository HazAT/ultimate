/** Voice input in the browser: whether an OpenAI API key can transcribe, and the transcription action. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** Whether voice input works: `available` with an OpenAI API key, else `reason` says what to do. */
export type VoiceStatus = { available: true } | { available: false; reason: string }

/** The page-wide dictation settings, kept under `dictation` in the user's settings for every project. */
export type DictationSettings = { talk: 'hold' | 'tap'; shortcut: string; cues: boolean }

/** No arguments → the user's dictation settings, defaults filled in. */
export const SettingsAction = actionRef<null, DictationSettings>('dictation', 'settings')
/** Some of the dictation settings → all of them, after writing the given ones to the user's settings. */
export const SetSettingsAction = actionRef<Partial<DictationSettings>, DictationSettings>(
  'dictation',
  'setSettings',
)

/** No arguments → whether an OpenAI API key exists to transcribe with. */
export const StatusAction = actionRef<null, VoiceStatus>('dictation', 'status')
/** `{ audio: base64, mimeType }` → the transcribed text. Fails with a message the composer shows as is. */
export const TranscribeAction = actionRef<{ audio: string; mimeType: string }, { text: string }>(
  'dictation',
  'transcribe',
)
