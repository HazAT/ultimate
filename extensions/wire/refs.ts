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

/** No arguments → the shown conversation's stored calls, oldest first, without bodies. */
export const ListAction = actionRef<null, WireSummary[]>('wire', 'list')
/** `{ n }` → that call of the shown conversation in full, or null once it left the window. */
export const CallAction = actionRef<{ n: number }, WireCall | null>('wire', 'call')
