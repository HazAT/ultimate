/** Claude Code: an optional per-conversation environment for its CLI requests. */
import { defineApi } from '../../shared/extension-api.ts'

export type ClaudeCodeEnvService = {
  /**
   * Extra environment for one Claude Code request, merged over the request's own (for example
   * `PI_CLAUDE_CODE_CONFIG_DIR`). `conversationId` is the conversation the request generates for, or undefined when it
   * is not known (an extension's one-shot call, a compaction resumed after a restart). Return undefined to change
   * nothing. Each distinct environment gets its own warm CLI process.
   */
  env(conversationId: number | undefined): Record<string, string> | undefined
}
/** Implemented by another extension; claude-code `want`s it on every request. */
export const ClaudeCodeEnv = defineApi<ClaudeCodeEnvService>()('claude-code.env')

/** One HTTP request Claude Code sent upstream through the turn relay, and the answer, as bytes on the wire. */
export type ClaudeCodeExchange = {
  /** The conversation the request generated for; undefined when not known (an extension's one-shot call). */
  conversationId: number | undefined
  model: string
  url: string
  startedAt: number
  endedAt: number
  /** Request headers as sent; credentials are `[redacted]`. */
  requestHeaders: Record<string, string>
  /** The exact request body sent upstream (after Pi's rewrite of Claude Code's own body). */
  requestBody: string
  status?: number
  /** Response headers as received; credentials are `[redacted]`. */
  responseHeaders: Record<string, string>
  /** The response bytes: the server-sent event stream, or an error body. */
  response: string
  /** Why the relay failed, when it did. */
  failure?: string
  /** The answer the relay assembled from the stream (Anthropic's message shape), when it got that far. */
  message?: unknown
}

export type ClaudeCodeExchangesService = {
  /** Called once per relayed request, after its turn ended; must return at once and never throw. */
  record(exchange: ClaudeCodeExchange): void
}
/** Implemented by another extension (wire); claude-code `want`s it after every relayed request. */
export const ClaudeCodeExchanges = defineApi<ClaudeCodeExchangesService>()('claude-code.exchanges')
