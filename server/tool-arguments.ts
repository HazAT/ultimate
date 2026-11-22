import type { HookApi, ConversationId } from '@earendil-works/pi-durable'
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
import { traceContext } from './trace.ts'
import { inProcess } from '../lib/errors.ts'
import { deadline } from '../lib/timers.ts'
import type { Cancel } from '../lib/timers.ts'
import type { CallTrace } from './trace.ts'

export const MAX_WHITESPACE_RUN = 1000

export type ModelTrace = {
  begin: CallTrace['begin']
  conversationOf(sessionId: string | undefined): ConversationId | undefined
}

export function modelTrace(trace: Pick<CallTrace, 'begin'>) {
  const sessions = new Map<string, ConversationId>()
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

export function guardToolArguments<T extends Models>(models: T, trace?: ModelTrace): T {
  const streamSimple: Models['streamSimple'] = (model, context, options) => {
    const stream = guardStream(
      (signal) => models.streamSimple(model, context, { ...options, signal }),
      model,
      options?.signal,
      options?.timeoutMs,
    )
    if (trace) record(trace, stream, model, options?.sessionId)
    return stream
  }
  const completeThroughGuardedStream: Models['completeSimple'] = (model, context, options) =>
    streamSimple(model, context, options).result()
  return new Proxy(models, {
    get(target, key) {
      if (key === 'streamSimple') return streamSimple
      if (key === 'completeSimple') return completeThroughGuardedStream
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function record(
  trace: ModelTrace,
  stream: AssistantMessageEventStream,
  model: Pick<Model<Api>, 'provider' | 'id'>,
  sessionId: string | undefined,
) {
  const conversationId = trace.conversationOf(sessionId)
  const extensionCallInheritsTrace = sessionId === undefined
  const { finish } = trace.begin(
    {
      kind: 'model',
      caller: sessionId === undefined ? 'extension' : 'agent',
      callee: model.provider,
      name: `${model.provider}/${model.id}`,
      ...(conversationId === undefined ? {} : { conversationId }),
    },
    extensionCallInheritsTrace ? (traceContext() ?? null) : null,
  )
  inProcess(
    'the model trace records a stream owned by this process',
    stream.result().then(
      (message) => {
        const { input, output, cacheRead, cacheWrite } = message.usage
        const result = { input, output, cacheRead, cacheWrite, stopReason: message.stopReason }
        if (message.stopReason === 'error' || message.stopReason === 'aborted')
          finish(false, new Error(classify(message.stopReason, message.errorMessage)))
        else finish(true, result)
      },
      (error: unknown) =>
        finish(false, new Error(classify('error', error instanceof Error ? error.message : ''))),
    ),
  )
}

const SAFE_MODEL_ERROR_CODES = new Set([
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

export function classify(stopReason: string, message = '') {
  const parts = [stopReason]
  const status = /^\s*([45]\d\d)\b|\b(?:status|http)[\s:=]*([45]\d\d)\b/i.exec(message)
  if (status) parts.push(status[1] ?? status[2])
  for (const word of message.split(/[^A-Za-z_]+/)) {
    const code = SAFE_MODEL_ERROR_CODES.has(word)
      ? word
      : SAFE_MODEL_ERROR_CODES.has(word.toLowerCase())
        ? word.toLowerCase()
        : ''
    if (code && !parts.includes(code)) parts.push(code)
    if (parts.length >= 5) break
  }
  return parts.join(' ')
}

export function guardStream(
  open: (signal: AbortSignal) => AssistantMessageEventStream,
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  signal?: AbortSignal,
  silenceMs?: number,
): AssistantMessageEventStream {
  const controller = new AbortController()
  const sourceWithFinalResult = open(
    signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
  )
  const guarded = createAssistantMessageEventStream()
  const whitespaceRunsIncludingStringValues = new Map<number, number>()
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
  let stalled = false
  let cancelStall: Cancel | undefined
  const restartStallDeadline = () => {
    cancelStall?.()
    if (silenceMs === undefined) return
    cancelStall = deadline(silenceMs, () => {
      stalled = true
      controller.abort()
      fail(
        `Model stream stalled: ${model.provider}/${model.id} sent nothing for ${Math.round(silenceMs / 1000)} s`,
      )
    })
  }
  restartStallDeadline()
  inProcess(
    'the guarded model stream belongs to this process',
    (async () => {
      for await (const event of sourceWithFinalResult) {
        if (stalled) return
        restartStallDeadline()
        if ('partial' in event) partial = event.partial
        if (event.type === 'toolcall_delta') {
          let run = whitespaceRunsIncludingStringValues.get(event.contentIndex) ?? 0
          for (const char of event.delta) {
            run = /\s/.test(char) ? run + 1 : 0
            if (run > MAX_WHITESPACE_RUN) break
          }
          whitespaceRunsIncludingStringValues.set(event.contentIndex, run)
          if (run > MAX_WHITESPACE_RUN) {
            controller.abort()
            const call = event.partial.content[event.contentIndex]
            const name = call?.type === 'toolCall' ? `${call.name} ` : ''
            // Pi upstream: @earendil-works/pi-ai@1.6.0 src/utils/retry.ts — RETRYABLE_PROVIDER_ERROR_PATTERN decides which errors a generation retries. Drop when Pi Durable lets a stream mark its error retryable.
            const errorMessage = `Aborted degenerate tool-call arguments: ${name}arguments contain more than ${MAX_WHITESPACE_RUN} whitespace characters in a row; you can retry your request`
            fail(errorMessage)
            return
          }
        }
        guarded.push(event)
        if (event.type === 'done' || event.type === 'error') return guarded.end()
      }
      const result = await sourceWithFinalResult.result()
      if (!stalled) guarded.end(result)
    })()
      .catch((error: unknown) => {
        if (stalled) return
        fail(`Model stream failed: ${String(error)}`)
        guarded.end()
      })
      .finally(() => cancelStall?.()),
  )
  return guarded
}
