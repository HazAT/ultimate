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
import {
  defineExtension,
  GenerationTask,
  hook,
  ProviderDoc,
  ToolTask,
} from '@earendil-works/pi-durable'
import { traceContext } from './trace.ts'
import { inProcess } from '../lib/errors.ts'
import { deadline } from '../lib/timers.ts'
import type { Cancel } from '../lib/timers.ts'
import type { CallTrace } from './trace.ts'

export const MAX_WHITESPACE_RUN = 1000
const LISTED_VALUES = 20
const VALIDATION_ERROR_PREFIX = 'Validation failed for tool '
const RECEIVED_ARGUMENTS_MARKER = '\n\nReceived arguments:\n'
const VALIDATION_LINE = /^  - ([^:\n]+): (.+)$/

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deref(
  root: Record<string, unknown>,
  node: unknown,
  seen = new Set<string>(),
): Record<string, unknown> | undefined {
  if (!isSchemaObject(node)) return undefined
  if (typeof node.$ref !== 'string' || !node.$ref.startsWith('#/')) return node
  if (seen.has(node.$ref)) return undefined
  seen.add(node.$ref)
  let target: unknown = root
  for (const raw of node.$ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isSchemaObject(target) || !Object.hasOwn(target, key)) return undefined
    target = target[key]
  }
  return deref(root, target, seen)
}

function stepSchema(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
  segment: string,
): Record<string, unknown> | undefined {
  if (isSchemaObject(node.properties) && Object.hasOwn(node.properties, segment))
    return deref(root, node.properties[segment])
  if (/^\d+$/.test(segment)) {
    const index = Number(segment)
    if (Array.isArray(node.prefixItems) && index < node.prefixItems.length)
      return deref(root, node.prefixItems[index])
    if (Array.isArray(node.items) && index < node.items.length)
      return deref(root, node.items[index])
    if (isSchemaObject(node.items)) return deref(root, node.items)
  }
  const branches = [
    ...(Array.isArray(node.allOf) ? node.allOf : []),
    ...(Array.isArray(node.anyOf) ? node.anyOf : []),
    ...(Array.isArray(node.oneOf) ? node.oneOf : []),
  ]
  const matches: Record<string, unknown>[] = []
  for (const branch of branches) {
    const resolved = deref(root, branch)
    const stepped = resolved ? stepSchema(root, resolved, segment) : undefined
    if (stepped) matches.push(stepped)
  }
  if (matches.length === 1) return matches[0]
  if (isSchemaObject(node.additionalProperties)) return deref(root, node.additionalProperties)
  return undefined
}

function schemaAt(
  root: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  let current = deref(root, root)
  if (!current || path === 'root') return current
  for (const segment of path.split('.')) {
    current = stepSchema(root, current, segment)
    if (!current) return undefined
  }
  return current
}

function listValues(values: readonly unknown[]): string {
  if (values.length <= LISTED_VALUES) return JSON.stringify(values)
  const listed = JSON.stringify(values.slice(0, LISTED_VALUES))
  return `${listed.slice(0, -1)}, ... and ${values.length - LISTED_VALUES} more]`
}

function listNames(names: readonly string[]): string {
  if (names.length <= LISTED_VALUES) return names.join(', ')
  return `${names.slice(0, LISTED_VALUES).join(', ')}, ... and ${names.length - LISTED_VALUES} more`
}

function enumValues(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
): unknown[] | undefined {
  if (Array.isArray(node.enum) && node.enum.length) return node.enum
  const branches = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : undefined
  if (!branches?.length) return undefined
  const values: unknown[] = []
  for (const raw of branches) {
    const branch = deref(root, raw)
    if (!branch) return undefined
    if (Array.isArray(branch.enum)) values.push(...branch.enum)
    else if (Object.hasOwn(branch, 'const')) values.push(branch.const)
    else return undefined
  }
  return values.length ? values : undefined
}

function propertyNames(node: Record<string, unknown> | undefined): string[] {
  return node && isSchemaObject(node.properties) ? Object.keys(node.properties) : []
}

function describeObjectFields(node: Record<string, unknown>): string | undefined {
  const names = propertyNames(node)
  if (!names.length) return undefined
  const requiredSet = new Set(
    Array.isArray(node.required)
      ? node.required.filter((name): name is string => typeof name === 'string')
      : [],
  )
  const required = names.filter((name) => requiredSet.has(name))
  const optional = names.filter((name) => !requiredSet.has(name))
  if (required.length && optional.length)
    return `required: ${listNames(required)}; optional: ${listNames(optional)}`
  if (required.length) return `required: ${listNames(required)}`
  return `properties: ${listNames(optional)}`
}

function hintForError(
  root: Record<string, unknown>,
  path: string,
  reason: string,
): string | undefined {
  if (reason === 'unknown field') {
    const parent = schemaAt(
      root,
      path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : 'root',
    )
    const keys = propertyNames(parent)
    return keys.length ? `allowed: ${listNames(keys)}` : undefined
  }
  const node = schemaAt(root, path)
  if (!node) return undefined
  const values = enumValues(root, node)
  if (values && !reason.startsWith('expected one of '))
    return `expected one of ${listValues(values)}`
  if (Object.hasOwn(node, 'const') && reason !== `expected ${JSON.stringify(node.const)}`)
    return `expected ${JSON.stringify(node.const)}`
  if (
    reason === 'missing' ||
    reason.startsWith('required when ') ||
    reason.startsWith('expected object, got ')
  ) {
    const fields = describeObjectFields(node)
    if (fields)
      return reason.startsWith('expected object, got ') ? fields : `expected object; ${fields}`
  }
  return undefined
}

export function enrichValidationMessage(message: string, schema: unknown): string {
  if (!isSchemaObject(schema) || !message.startsWith(VALIDATION_ERROR_PREFIX)) return message
  const split = message.indexOf(RECEIVED_ARGUMENTS_MARKER)
  const header = split === -1 ? message : message.slice(0, split)
  const tail = split === -1 ? '' : message.slice(split)
  const lines = header.split('\n').map((line) => {
    const match = VALIDATION_LINE.exec(line)
    if (!match) return line
    const hint = hintForError(schema, match[1], match[2])
    return hint ? `${line} (${hint})` : line
  })
  return `${lines.join('\n')}${tail}`
}

export function validationHints(schemaOf: (toolName: string) => unknown) {
  return defineExtension({
    name: 'validation-hints',
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result) => {
          if (
            !result.isError ||
            !result.diagnostics?.some((diagnostic) => diagnostic.code === 'invalid_arguments')
          )
            return undefined
          const schema = schemaOf(call.name)
          if (!schema) return undefined
          let changed = false
          const diagnostics = result.diagnostics.map((diagnostic) => {
            if (diagnostic.code !== 'invalid_arguments') return diagnostic
            const message = enrichValidationMessage(diagnostic.message, schema)
            if (message === diagnostic.message) return diagnostic
            changed = true
            return { ...diagnostic, message }
          })
          return changed ? { ...result, diagnostics } : undefined
        },
      }),
    ],
  })
}

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
