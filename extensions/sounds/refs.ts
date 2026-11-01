/** Sounds' narrator in the browser: the action that speaks a line. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * `{ text }` → the line spoken by OpenAI's realtime voice, as base64 16-bit mono PCM at 24 kHz; `{ audio: null }` without an
 * OpenAI API key, for the browser's own voice to say it.
 */
export const SayAction = actionRef<{ text: string }, { audio: string | null }>('sounds', 'say')
