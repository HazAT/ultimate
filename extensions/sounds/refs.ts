/** Sounds' narrator in the browser: the action that speaks a line. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/**
 * `{ text }` → the configured voice as base64 16-bit mono PCM at 24 kHz;
 * `{ audio: null }` leaves the line to the browser's own voice.
 */
export const SayAction = actionRef<{ text: string }, { audio: string | null }>('sounds', 'say')
