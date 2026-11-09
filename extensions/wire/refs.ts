/** Wire in the browser: the raw requests a conversation's model calls sent and what came back. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

export type WireUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * One model call of a conversation as Wire keeps it. `source` says how close to the wire it is: `relay` is the HTTP
 * exchange Claude Code made through Pi's turn relay, byte for byte; `payload` is the request body pi-ai built (after
 * every `beforeProviderRequest` hook) and the reply as Pi assembled it, without the transport's own bytes.
 */
export type WireCall = {
  /** The call's number in its conversation, counting up. */
  n: number
  conversationId: number
  source: 'relay' | 'payload'
  provider: string
  model: string
  api?: string
  startedAt: number
  endedAt: number
  /** The provider's message id; the transcript's `pi.assistant` entry carries it as `responseId`. */
  responseId?: string
  url?: string
  /** Request headers as sent, credentials `[redacted]`; relay only. */
  requestHeaders?: Record<string, string>
  /** The request body, exactly as sent (relay) or as built (payload). */
  request: string
  status?: number
  responseHeaders?: Record<string, string>
  /** The raw response bytes (the event stream or an error body); relay only. */
  response?: string
  /** The assembled answer: Anthropic's message (relay) or Pi's assistant message (payload). */
  message?: unknown
  usage?: WireUsage
  failure?: string
  /**
   * What the transport did with the body, when it differs from `request`: a Codex WebSocket continuation sends only
   * the input items after the last response, with `previous_response_id`.
   */
  transport?: string
}

/** A call without its bodies, for the list. */
export type WireSummary = Omit<
  WireCall,
  'request' | 'response' | 'message' | 'requestHeaders' | 'responseHeaders'
> & { requestBytes: number; responseBytes?: number }

/**
 * How a request differs from the conversation's previous one, comparing the cacheable prefix in the order the provider
 * caches it (Anthropic: tools, system, messages; OpenAI Responses: instructions, tools, input), segment by segment.
 */
export type WireDiff = {
  /** The call it is compared with. */
  previous: number
  /** Segments in this request's prefix, and how many lead it unchanged. */
  segments: number
  same: number
  /** JSON characters of the unchanged leading segments. */
  prefixBytes: number
  /**
   * The first segment present in both that changed, where the cached prefix breaks: its path, the offset of the first
   * differing character in its JSON, the text before that point and both sides after it. Absent for a pure append.
   */
  firstChange?: { path: string; offset: number; lead: string; before: string; after: string }
  /** This request's segments from the first difference on, in order. */
  added: { path: string; json: string }[]
  /** The previous request's segment paths from the first difference on. */
  removed: string[]
  /** Request settings outside the prefix (model, max_tokens, thinking …) that changed, as JSON. */
  settings: { key: string; before?: string; after?: string }[]
}

/** No arguments → the shown conversation's stored calls, oldest first, without bodies. */
export const ListAction = actionRef<null, WireSummary[]>('wire', 'list')
/** `{ n }` → that call of the shown conversation in full, or null once it left the window. */
export const CallAction = actionRef<{ n: number }, WireCall | null>('wire', 'call')
/**
 * `{ n }` → how call `n` differs from the conversation's call before it, or null when there is no earlier call still
 * kept, the two went to different APIs, or a body is not JSON.
 */
export const DiffAction = actionRef<{ n: number }, WireDiff | null>('wire', 'diff')
