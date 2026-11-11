import type { Context } from '@earendil-works/chord/context'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Models,
} from '@earendil-works/pi-ai'
import { defineExtension, GenerationTask, hook, ProviderDoc } from '@earendil-works/pi-durable'
import type { HookApi } from '@earendil-works/pi-durable'
import { traceContext } from './trace.ts'
import type { CallTrace } from './trace.ts'

/**
 * Whitespace characters in a row past which a tool call's arguments count as degenerate. JSON never needs that much,
 * and inside a string a file's newlines arrive escaped, so even a large `write` stays far below it. Runs inside strings
 * count too: the degenerate streams seen so far pad an unterminated string, so only a line of over 1000 spaces in a
 * legitimate value would trip it.
 */
export const MAX_WHITESPACE_RUN = 1000

/** Records one model call: the trace's `begin`, and the conversation of a provider session id, when known. */
export type ModelTrace = {
  begin: CallTrace['begin']
  conversationOf(sessionId: string | undefined): number | undefined
}

/**
 * Model calls of `trace`, linked to their conversations. Pi sends a conversation's provider session id (`pi.provider`)
 * with each generation and compaction request but runs them outside any traced call, so the `model-trace` extension's
 * `beforeRequest` hook maps each session id to its conversation; a request before its conversation's first generation
 * in this process (a compaction right after a restart) and extensions' own calls stay unlinked.
 */
export function modelTrace(trace: Pick<CallTrace, 'begin'>) {
  const sessions = new Map<string, number>()
  const remember = async (api: HookApi, context: Context) => {
    const provider = await api.snapshot(ProviderDoc, api.conversationId, context)
    if (!provider) return
    sessions.delete(provider.sessionId)
    sessions.set(provider.sessionId, api.conversationId)
    if (sessions.size > 10_000) sessions.delete(sessions.keys().next().value!)
  }
  return {
    begin: trace.begin,
    conversationOf: (sessionId: string | undefined) =>
      sessionId === undefined ? undefined : sessions.get(sessionId),
    extension: defineExtension({
      name: 'model-trace',
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (_request, api, context) => {
            await remember(api, context)
          },
        }),
      ],
    }),
  } satisfies ModelTrace & { extension: unknown }
}

/**
 * `models` whose `streamSimple` ends a response with an error as soon as a tool call's arguments degenerate, instead of
 * streaming whitespace until the request times out. The error is retryable, so the generation's retry policy decides.
 * With `trace`, every stream becomes one `model` row: provider/model, duration, token counts and stop reason, never
 * the prompt or the response.
 */
export function guardToolArguments<T extends Models>(models: T, trace?: ModelTrace): T {
  const streamSimple: Models['streamSimple'] = (model, context, options) => {
    const stream = guardStream(
      (signal) => models.streamSimple(model, context, { ...options, signal }),
      model,
      options?.signal,
    )
    if (trace) record(trace, stream, model, options?.sessionId)
    return stream
  }
  // The target's own completeSimple calls its streamSimple on itself, past this proxy: route it through ours.
  const completeSimple: Models['completeSimple'] = (model, context, options) =>
    streamSimple(model, context, options).result()
  return new Proxy(models, {
    get(target, key) {
      if (key === 'streamSimple') return streamSimple
      if (key === 'completeSimple') return completeSimple
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** One trace row for `stream`, written once it settles. */
function record(
  trace: ModelTrace,
  stream: AssistantMessageEventStream,
  model: Pick<Model<Api>, 'provider' | 'id'>,
  sessionId: string | undefined,
) {
  const conversationId = trace.conversationOf(sessionId)
  // Pi's requests start a trace: the scheduler runs them in whatever context last woke it, which is no caller of
  // theirs. An extension's own call belongs to the call it runs in.
  const { finish } = trace.begin(
    {
      kind: 'model',
      // Pi's generation and compaction send the conversation's provider session; extension calls send none.
      caller: sessionId === undefined ? 'extension' : 'agent',
      callee: model.provider,
      name: `${model.provider}/${model.id}`,
      ...(conversationId === undefined ? {} : { conversationId }),
    },
    sessionId === undefined ? (traceContext() ?? null) : null,
  )
  void stream.result().then(
    (message) => {
      const { input, output, cacheRead, cacheWrite } = message.usage
      const result = { input, output, cacheRead, cacheWrite, stopReason: message.stopReason }
      if (message.stopReason === 'error' || message.stopReason === 'aborted')
        finish(false, new Error(classify(message.stopReason, message.errorMessage)))
      else finish(true, result)
    },
    (error: unknown) =>
      finish(false, new Error(classify('error', error instanceof Error ? error.message : ''))),
  )
}

/**
 * Error codes a model failure row may name: provider and OAuth codes, network errors and a few plain words. A fixed
 * list, so nothing of a prompt, a response body or a credential can pass. Mirrors `KNOWN` in extensions/health/store.ts.
 */
const CODES = new Set([
  'invalid_grant',
  'invalid_token',
  'invalid_client',
  'invalid_request',
  'invalid_api_key',
  'unauthorized_client',
  'access_denied',
  'authentication_error',
  'permission_error',
  'insufficient_quota',
  'rate_limit_error',
  'rate_limit_exceeded',
  'usage_limit_reached',
  'overloaded_error',
  'api_error',
  'server_error',
  'not_found_error',
  'model_not_found',
  'invalid_request_error',
  'context_length_exceeded',
  'request_too_large',
  'unauthorized',
  'forbidden',
  'expired',
  'revoked',
  'overloaded',
  'timeout',
  'aborted',
  'quota',
  'unavailable',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

/**
 * What a failed model row stores instead of the provider's message, which can echo the request: the stop reason, then
 * the HTTP status when the message starts with one or names it (`status 401`, `HTTP 429`) and the allowlisted codes it
 * contains, in order, at most four.
 */
export function classify(stopReason: string, message = '') {
  const parts = [stopReason]
  const status = /^\s*([45]\d\d)\b|\b(?:status|http)[\s:=]*([45]\d\d)\b/i.exec(message)
  if (status) parts.push(status[1] ?? status[2])
  for (const word of message.split(/[^A-Za-z_]+/)) {
    const code = CODES.has(word) ? word : CODES.has(word.toLowerCase()) ? word.toLowerCase() : ''
    if (code && !parts.includes(code)) parts.push(code)
    if (parts.length >= 5) break
  }
  return parts.join(' ')
}

/** The stream `open` returns, ended with an error and aborted once a tool call's arguments degenerate. */
export function guardStream(
  open: (signal: AbortSignal) => AssistantMessageEventStream,
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const controller = new AbortController()
  const source = open(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  const guarded = createAssistantMessageEventStream()
  const runs = new Map<number, number>()
  let partial: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: Date.now(),
  }
  const fail = (errorMessage: string) => {
    const error = { ...partial, content: [...partial.content], stopReason: 'error' as const }
    guarded.push({ type: 'error', reason: 'error', error: { ...error, errorMessage } })
  }
  void (async () => {
    for await (const event of source) {
      if ('partial' in event) partial = event.partial
      if (event.type === 'toolcall_delta') {
        let run = runs.get(event.contentIndex) ?? 0
        for (const char of event.delta) {
          run = /\s/.test(char) ? run + 1 : 0
          if (run > MAX_WHITESPACE_RUN) break
        }
        runs.set(event.contentIndex, run)
        if (run > MAX_WHITESPACE_RUN) {
          controller.abort()
          const call = event.partial.content[event.contentIndex]
          const name = call?.type === 'toolCall' ? `${call.name} ` : ''
          // Pi's retry classification matches "you can retry your request"; a new sample rarely degenerates again.
          // Pi upstream: @earendil-works/pi-ai@1.5.2 src/utils/retry.ts — RETRYABLE_PROVIDER_ERROR_PATTERN decides which errors a generation retries. Drop when Pi Durable lets a stream mark its error retryable.
          const errorMessage = `Aborted degenerate tool-call arguments: ${name}arguments contain more than ${MAX_WHITESPACE_RUN} whitespace characters in a row; you can retry your request`
          fail(errorMessage)
          return
        }
      }
      guarded.push(event)
      if (event.type === 'done' || event.type === 'error') return guarded.end()
    }
    // A source may also settle by its result alone, without a terminal event.
    guarded.end(await source.result())
  })().catch((error: unknown) => {
    fail(`Model stream failed: ${String(error)}`)
    guarded.end()
  })
  return guarded
}
