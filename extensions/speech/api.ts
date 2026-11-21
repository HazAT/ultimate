/**
 * Speech: the one place Ultimate generates a spoken voice. Other extensions hand it text and get audio back, from
 * OpenAI, a local command or an engine another extension provides, as the `speech` setting chooses.
 */
import { defineApi } from '../../shared/extension-api.ts'

/** Audio ready for the browser: base64 in `mimeType` (WAV, MP3 or AAC). */
export type Spoken = { audio: string; mimeType: string }

/** How OpenAI speaks for one caller when it is the engine: a realtime model answers over a socket, any other over `/v1/audio/speech`. */
export type OpenAiVoice = { model: string; voice: string; instructions: string }

export type SpeechService = {
  /**
   * Speak `text` with the engine the `speech` setting selects, within `timeoutMs`; `openai` applies only when OpenAI
   * is that engine. Null leaves the text to the browser's own voice: speech is off, OpenAI has no key, or a local
   * engine is missing or failed (a local engine never falls back to OpenAI). Throws when OpenAI fails or `signal`
   * aborts. Results are kept in memory by engine and text,
   * the newest 64 MB of them.
   */
  speak(
    request: { text: string; openai: OpenAiVoice; timeoutMs: number },
    signal: AbortSignal,
  ): Promise<Spoken | null>
}
/** The speech service; `want` it and leave the text to the browser's voice without it. */
export const SpeechApi = defineApi<SpeechService>()('speech')

export type SpeechEngineService = {
  /** The engine's name: `speech.voice` set to it selects this engine. */
  id: string
  /** Speak `text` as one audio file; throw to leave it to the browser. `audioOf` in lib/speech.ts names a file's type and wraps raw PCM. */
  speak(text: string, signal: AbortSignal): Promise<Spoken>
}
/** The extension point another extension provides a speech engine through, such as an in-process local model. */
export const SpeechEngine = defineApi<SpeechEngineService>()('speech.engine')
