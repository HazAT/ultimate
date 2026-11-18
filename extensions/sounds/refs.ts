/** Sounds' narrator in the browser: the action that speaks a line. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * `{ text }` → the configured voice as base64 WAV, MP3 or AAC;
 * `{ audio: null }` leaves the line to the browser's own voice.
 */
export const SayAction = actionRef<{ text: string }, { audio: string | null }>('sounds', 'say')
