/**
 * Antigravity: raw Gemini requests through the signed-in `agy` relay, for extensions that need what Pi's content
 * blocks cannot carry (`videoMetadata`, `mediaResolution`, `fileData` URLs).
 */
import { defineApi } from '../../shared/extension-api.ts'

/** Token counts Google reports for one request, as its `usageMetadata` names them. */
export type GeminiUsage = {
  promptTokenCount: number
  candidatesTokenCount: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount: number
}

/** The answer to one request: the model's text without its thoughts, why it stopped and what it used. */
export type GenerateResult = { text: string; finishReason?: string; usage: GeminiUsage }

export type AntigravityService = {
  /**
   * Send one Gemini `generateContent` request (`{ contents, systemInstruction?, generationConfig? }`) to `model`, an
   * Antigravity model id such as `gemini-4-neon-low`, and collect its streamed answer. Pass the request as an object,
   * or as its JSON bytes in chunks so a body of hundreds of megabytes (inline video) never sits in memory whole.
   * Rejects with an `Error` whose `status` is the HTTP status and whose message carries Google's own error message
   * (429 when the subscription's quota or rate limit is reached), or when `agy` is missing or signed out.
   */
  generate(
    model: string,
    request: object | AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<GenerateResult>
}
/** Raw Gemini requests on the Antigravity subscription; `need` it, video understanding has no other path. */
export const AntigravityApi = defineApi<AntigravityService>()('antigravity')
