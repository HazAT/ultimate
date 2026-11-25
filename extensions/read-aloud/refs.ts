/** Read aloud in the browser: the actions that prepare a message for listening and voice it. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** An OpenAI voice of the realtime speech model; cedar and marin sound best. */
export type OpenAiVoice =
  | 'cedar'
  | 'marin'
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'sage'
  | 'shimmer'
  | 'verse'

/** One section of a message, rewritten for listening, with the number of sections the message has. */
export type PreparedSection = { sections: number; spoken: string }

/**
 * `{ text, section }` → section `section` (from 0) of the Markdown `text`, rewritten for listening, with the number of
 * sections the text has. Cached by the section's text.
 */
export const PrepareAction = actionRef<{ text: string; section: number }, PreparedSection>(
  'read-aloud',
  'prepare',
)

/**
 * `{ voice, text }` → `{ audio }`, the text read aloud by that OpenAI voice as base64 WAV; aborting the request cancels
 * it. Without text it only opens the connection, so the first sentence starts sooner.
 */
export const SpeakAction = actionRef<{ voice: OpenAiVoice; text?: string }, { audio?: string }>(
  'read-aloud',
  'speak',
)

/** `null` → `{ openai }`: whether an OpenAI key is available, so the OpenAI voice can speak. */
export const SpeechStatusAction = actionRef<null, { openai: boolean }>('read-aloud', 'status')
