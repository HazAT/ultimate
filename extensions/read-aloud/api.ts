/** Read aloud: text-to-speech with the same OpenAI Realtime voice used by the speech player. */
import { defineApi } from '../../shared/extension-api.ts'
import type { OpenAiVoice } from './refs.ts'

export type ReadAloudService = {
  /** Return signed little-endian PCM16, mono at 24 kHz, or undefined when no OpenAI key is available. */
  speak(text: string, voice: OpenAiVoice, signal: AbortSignal): Promise<Buffer | undefined>
}

/** OpenAI speech for other extensions; `want` it, read-aloud is optional. */
export const ReadAloudApi = defineApi<ReadAloudService>()('read-aloud')
