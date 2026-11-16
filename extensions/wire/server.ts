import type { ConversationId } from '@earendil-works/pi-durable'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { getOpenAICodexWebSocketDebugStats } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { defineExtension, GenerationTask, hook, ProviderDoc } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { inProcess } from '../../lib/errors.ts'
import { ClaudeCodeExchanges } from '../claude-code/api.ts'
import type { ClaudeCodeExchange } from '../claude-code/api.ts'
import { diffBodies } from './diff.ts'
import { CallAction, DiffAction, ListAction } from './refs.ts'
import type { WireCall, WireUsage } from './refs.ts'
import { list, load, save } from './store.ts'

type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

function relayUsage(message: unknown): WireUsage | undefined {
  const usage = (message as { usage?: AnthropicUsage } | undefined)?.usage
  if (!usage) return undefined
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  }
}

export function fromExchange(
  exchange: ClaudeCodeExchange,
  conversationId: ConversationId,
): Omit<WireCall, 'n'> {
  const id = (exchange.message as { id?: unknown } | undefined)?.id
  const usage = relayUsage(exchange.message)
  const actualModelIdBehindCliAlias = (exchange.message as { model?: unknown } | undefined)?.model
  return {
    conversationId,
    source: 'relay',
    provider: 'claude-code',
    model:
      typeof actualModelIdBehindCliAlias === 'string'
        ? actualModelIdBehindCliAlias
        : exchange.model,
    api: 'anthropic-messages',
    startedAt: exchange.startedAt,
    endedAt: exchange.endedAt,
    ...(typeof id === 'string' ? { responseId: id } : {}),
    url: exchange.url,
    requestHeaders: exchange.requestHeaders,
    request: exchange.requestBody,
    ...(exchange.status === undefined ? {} : { status: exchange.status }),
    responseHeaders: exchange.responseHeaders,
    response: exchange.response,
    ...(exchange.message === undefined ? {} : { message: exchange.message }),
    ...(usage ? { usage } : {}),
    ...(exchange.failure === undefined ? {} : { failure: exchange.failure }),
  }
}

export default function wire(host: ExtensionHost) {
  const latestPayloadAwaitingResponse = host.resource(
    'wire.pending',
    () => new Map<number, { payload: unknown; at: number; sessionId?: string }>(),
  )
  const reloadSharedWriteQueue = host.resource('wire.writes', () => ({
    tail: Promise.resolve() as Promise<unknown>,
  }))
  const storeWithoutBlockingGeneration = (call: Omit<WireCall, 'n'>) => {
    inProcess(
      'Wire is a debug log of recent calls: a call a crash cuts off is not worth replaying',
      save(reloadSharedWriteQueue, host.home, call).catch((error: unknown) => {
        console.error('wire: storing a call failed:', error)
      }),
    )
  }
  host.implement(ClaudeCodeExchanges, {
    record(exchange) {
      if (exchange.conversationId === undefined) return
      storeWithoutBlockingGeneration(fromExchange(exchange, exchange.conversationId))
    },
  })
  return defineExtension({
    name: 'wire',
    hooks: [
      hook(GenerationTask, {
        async beforeProviderRequest({ payload }, api, ctx) {
          const session = await api.snapshot(ProviderDoc, api.conversationId, ctx)
          latestPayloadAwaitingResponse.set(api.conversationId, {
            payload,
            at: Date.now(),
            ...(session ? { sessionId: session.sessionId } : {}),
          })
          return undefined
        },
        afterResponse(message: AssistantMessage, api) {
          const lastSentPayload = latestPayloadAwaitingResponse.get(api.conversationId)
          latestPayloadAwaitingResponse.delete(api.conversationId)
          if (!lastSentPayload || message.provider === 'claude-code') return
          const { input, output, cacheRead, cacheWrite } = message.usage
          const stats =
            message.api === 'openai-codex-responses' && lastSentPayload.sessionId
              ? getOpenAICodexWebSocketDebugStats(lastSentPayload.sessionId.slice(0, 64))
              : undefined
          storeWithoutBlockingGeneration({
            conversationId: api.conversationId,
            source: 'payload',
            provider: message.provider,
            model: message.model,
            api: message.api,
            startedAt: lastSentPayload.at,
            endedAt: Date.now(),
            ...(message.responseId ? { responseId: message.responseId } : {}),
            request: JSON.stringify(lastSentPayload.payload),
            message,
            usage: { input, output, cacheRead, cacheWrite },
            ...(message.errorMessage ? { failure: message.errorMessage } : {}),
            ...(stats?.lastPreviousResponseId
              ? {
                  transport: `WebSocket continuation: sent only the last ${stats.lastDeltaInputItems ?? 0} input items, with previous_response_id ${stats.lastPreviousResponseId}`,
                }
              : {}),
          })
        },
      }),
    ],
  })
}

const conversationOf = (id: ConversationId | undefined) => {
  if (id === undefined) throw new Error('No conversation')
  return id
}

const numberArg = (args: unknown) => {
  const n =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { n?: unknown }).n
      : undefined
  if (!Number.isSafeInteger(n)) throw new Error('Expected { n }')
  return n as number
}

const parsed = (text: string) => {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export const actions = {
  list: implementAction(ListAction, (_args, { host, conversationId }) =>
    list(host.home, conversationOf(conversationId)),
  ),
  call: implementAction(
    CallAction,
    async (args, { host, conversationId }) =>
      (await load(host.home, conversationOf(conversationId), numberArg(args))) ?? null,
  ),
  diff: implementAction(DiffAction, async (args, { host, conversationId }) => {
    const id = conversationOf(conversationId)
    const n = numberArg(args)
    const earlier = (await list(host.home, id)).filter((call) => call.n < n).at(-1)
    if (!earlier) return null
    const [before, after] = await Promise.all([
      load(host.home, id, earlier.n),
      load(host.home, id, n),
    ])
    if (!before || !after || before.api !== after.api) return null
    const previous = parsed(before.request)
    const current = parsed(after.request)
    return previous && current ? diffBodies(previous, current, earlier.n) : null
  }),
}
