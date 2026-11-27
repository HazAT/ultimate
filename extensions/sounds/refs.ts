/** Sounds' narrator in the browser: the action that speaks a line. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'
import type { OpenAiVoice } from '../read-aloud/refs.ts'

/**
 * `{ text, voice? }` → base64 mono PCM16 at 24 kHz from the local command or read-aloud's selected OpenAI `voice`.
 * Pass `voice` only when the Speech setting uses OpenAI. `{ audio: null }` leaves the line to the browser.
 */
export const SayAction = actionRef<{ text: string; voice?: OpenAiVoice }, { audio: string | null }>(
  'sounds',
  'say',
)
