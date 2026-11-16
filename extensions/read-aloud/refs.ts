/** Read aloud in the browser: the action that turns one section of a message into speech. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One section of a message, ready to hear: `audio` is base64 MP3, or null to leave `spoken` to the browser's voice. */
export type SpokenSection = { sections: number; spoken: string; audio: string | null }

/**
 * `{ text, section }` → section `section` (from 0) of the Markdown `text`, rewritten for listening and voiced, with the
 * number of sections the text has. Cached by the section's text.
 */
export const SpeakAction = actionRef<{ text: string; section: number }, SpokenSection>(
  'read-aloud',
  'speak',
)
