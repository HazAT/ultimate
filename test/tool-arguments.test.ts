import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from '@earendil-works/pi-durable'
import { arr, bool, obj, opt, str } from '@earendil-works/pi-schema'
import { afterEach, expect, it, vi } from 'vitest'
import { strEnum } from '../lib/schema.ts'
import { context } from '../server/harness.ts'
import {
  enrichValidationMessage,
  guardStream,
  guardToolArguments,
  MAX_WHITESPACE_RUN,
  validationHints,
} from '../server/tool-arguments.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

/** A provider stream of one tool call whose arguments arrive as `deltas`, and the signal it was opened with. */
function source(deltas: string[]) {
  const opened: { signal?: AbortSignal } = {}
  const pushed: AssistantMessageEvent[] = []
  const call = fauxToolCall('write', {}, { id: 'call' })
  const message = fauxAssistantMessage([call], { stopReason: 'toolUse' })
  const open = (signal: AbortSignal) => {
    opened.signal = signal
    const stream = createAssistantMessageEventStream()
    const partial: AssistantMessage = { ...message, content: [{ ...call, arguments: {} }] }
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'toolcall_start', contentIndex: 0, partial },
      ...deltas.map((delta) => ({
        type: 'toolcall_delta' as const,
        contentIndex: 0,
        delta,
        partial,
      })),
      { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial },
      { type: 'done', reason: 'toolUse', message },
    ]
    for (const event of events) {
      pushed.push(event)
      stream.push(event)
    }
    return stream
  }
  return { open, opened, pushed, message }
}

const model = { api: 'faux', provider: 'faux', id: 'faux-1' }

async function drain(stream: ReturnType<typeof guardStream>) {
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return { events, result: await stream.result() }
}

it('ends a tool call whose arguments gain a long whitespace run with a retryable error', async () => {
  const spaces = ' '.repeat(MAX_WHITESPACE_RUN / 2)
  const fake = source(['{"schedule":"in 30m","} 、】【 retry.', spaces, spaces, spaces, '"}'])
  const { events, result } = await drain(guardStream(fake.open, model))
  expect(events.map((event) => event.type)).toEqual([
    'start',
    'toolcall_start',
    'toolcall_delta',
    'toolcall_delta',
    'toolcall_delta',
    'error',
  ])
  expect(fake.opened.signal?.aborted).toBe(true)
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toBe(
    `Aborted degenerate tool-call arguments: write arguments contain more than ${MAX_WHITESPACE_RUN} whitespace characters in a row; you can retry your request`,
  )
  expect(isRetryableAssistantError(result)).toBe(true)
})

it('passes a normal tool call and a large legitimate write through untouched', async () => {
  const file = `export function line() {\n${'  return 1\n'.repeat(20000)}}\n`
  const indented = `${' '.repeat(MAX_WHITESPACE_RUN)}x`
  for (const args of [{ command: 'pnpm test' }, { path: 'big.ts', content: file + indented }]) {
    const json = JSON.stringify(args)
    const deltas = json.match(/[\s\S]{1,7}/g) ?? []
    const fake = source(deltas)
    const { events, result } = await drain(guardStream(fake.open, model))
    expect(events).toEqual(fake.pushed)
    expect(result).toBe(fake.message)
    expect(fake.opened.signal?.aborted).toBe(false)
  }
})

it('settles when the source ends by its result alone', async () => {
  const { message } = source([])
  const stream = guardStream(() => {
    const silent = createAssistantMessageEventStream()
    silent.end(message)
    return silent
  }, model)
  expect(await drain(stream)).toEqual({ events: [], result: message })
})

it('ends with an error when the source fails', async () => {
  const failing = createAssistantMessageEventStream()
  failing[Symbol.asyncIterator] = async function* () {
    yield* []
    throw new Error('socket closed')
  }
  const { events, result } = await drain(guardStream(() => failing, model))
  expect(events.map((event) => event.type)).toEqual(['error'])
  expect(result).toMatchObject({
    stopReason: 'error',
    errorMessage: 'Model stream failed: Error: socket closed',
    provider: 'faux',
    model: 'faux-1',
  })
})

it('ends a stream that goes silent with an error Pi does not retry by itself', async () => {
  // A provider kept connections open without sending anything: calls hung 13 to 65 minutes, then Pi retried them.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  cleanups.push(async () => void vi.useRealTimers())
  const { message } = source([])
  let opened: AbortSignal | undefined
  const stream = guardStream(
    (signal) => {
      opened = signal
      const silent = createAssistantMessageEventStream()
      const partial = { ...message, content: [] }
      silent.push({ type: 'start', partial })
      return silent
    },
    model,
    undefined,
    300_000,
  )
  const drained = drain(stream)
  await vi.advanceTimersByTimeAsync(299_000)
  expect(opened?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(2_000)
  const { events, result } = await drained
  expect(events.map((event) => event.type)).toEqual(['start', 'error'])
  expect(opened?.aborted).toBe(true)
  expect(result.errorMessage).toBe('Model stream stalled: faux/faux-1 sent nothing for 300 s')
  expect(isRetryableAssistantError(result)).toBe(false)
})

it('lets the generation retry a degenerate response and answer', async () => {
  const faux = fauxProvider()
  const collection = createModels()
  collection.setProvider(faux.provider)
  const models = guardToolArguments(collection)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('automation', { schedule: `in 30m${' '.repeat(8000)}` })], {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Scheduled.'),
  ])
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const settings = { retry: { baseDelayMs: 0 } }
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), settings },
    context,
  )
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  const submitted = await root.submit({ type: 'input', content: 'Schedule it.' }, context)
  expect((await submitted.wait(context)).status).toBe('done')
  const answers = (await root.context(context)).entries.flatMap((entry) =>
    entry.kind === 'pi.assistant' ? (entry.model as AssistantMessage[]) : [],
  )
  expect(answers.map(({ stopReason, errorMessage }) => ({ stopReason, errorMessage }))).toEqual([
    {
      stopReason: 'error',
      errorMessage: expect.stringContaining('Aborted degenerate tool-call arguments: automation'),
    },
    { stopReason: 'stop', errorMessage: undefined },
  ])
  expect(faux.state.callCount).toBe(2)
})

it('adds schema hints to missing enum, object and unknown-field validation errors without duplicating them', () => {
  const schema = {
    ...obj({
      action: strEnum(['start', 'stop', 'list']),
      questions: opt(
        arr(
          obj({
            text: str({ minLength: 1 }),
            kind: strEnum(['choice', 'multi', 'confirm', 'text', 'scale']),
            options: opt(
              arr(
                obj({
                  label: str({ minLength: 1 }),
                  key: opt(str()),
                  detail: opt(str()),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
    additionalProperties: false,
  }

  const message = [
    'Validation failed for tool "demo":',
    '  - action: missing',
    '  - questions.0.kind: missing',
    '  - questions.0.options.0: expected object, got string',
    '  - extra: unknown field',
    '',
    'Received arguments:',
    '{\n  "note": "  - action: missing"\n}',
  ].join('\n')

  expect(enrichValidationMessage(message, schema)).toBe(
    [
      'Validation failed for tool "demo":',
      '  - action: missing (expected one of ["start","stop","list"])',
      '  - questions.0.kind: missing (expected one of ["choice","multi","confirm","text","scale"])',
      '  - questions.0.options.0: expected object, got string (required: label; optional: key, detail)',
      '  - extra: unknown field (allowed: action, questions)',
      '',
      'Received arguments:',
      '{\n  "note": "  - action: missing"\n}',
    ].join('\n'),
  )

  const alreadyEnumerated =
    'Validation failed for tool "demo":\n  - action: expected one of ["start","stop","list"]\n\nReceived arguments:\n{"action":"bad"}'
  expect(enrichValidationMessage(alreadyEnumerated, schema)).toBe(alreadyEnumerated)
})

it('enriches invalid_arguments diagnostics through the validationHints afterTool hook', async () => {
  const faux = fauxProvider()
  const collection = createModels()
  collection.setProvider(faux.provider)
  const demo = defineExtension({
    name: 'demo-tools',
    tools: [
      defineTool({
        name: 'subagent',
        description: 'Delegate work.',
        parameters: obj({
          action: strEnum(['start', 'message', 'wait', 'stop', 'list', 'land', 'discard']),
          agent: opt(str()),
        }),
        execute: async () => ({ output: [{ type: 'text', text: 'ok' }] }),
      }),
      defineTool({
        name: 'message',
        description: 'Send a message.',
        parameters: obj({
          to: str(),
          text: str({ minLength: 1 }),
          questions: opt(
            arr(
              obj({
                text: str({ minLength: 1 }),
                kind: strEnum(['choice', 'multi', 'confirm', 'text', 'scale']),
                options: opt(
                  arr(
                    obj({
                      label: str({ minLength: 1 }),
                      key: opt(str()),
                      recommended: opt(bool()),
                    }),
                  ),
                ),
              }),
            ),
          ),
        }),
        execute: async () => ({ output: [{ type: 'text', text: 'ok' }] }),
      }),
    ],
  })
  const registry = createRegistry()
  const hints = validationHints(
    (name) =>
      registry
        .snapshot()
        .tools()
        .findLast((entry) => entry.tool.name === name)?.tool.parameters,
  )
  registry.install(hints)
  registry.install(demo)
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('subagent', {}, { id: 'c1' }),
        fauxToolCall(
          'message',
          { to: 'user', text: 'Pick', questions: [{ text: 'Which?', options: ['a', 'b'] }] },
          { id: 'c2' },
        ),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Fixed.'),
  ])
  const storage = new MemoryStorage()
  storage.close = async () => {}
  const harness = await Harness.open(
    storage,
    { models: collection, registry, settings: { extensions: [hints, demo] } },
    context,
  )
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  const submitted = await root.submit({ type: 'input', content: 'Run tools.' }, context)
  expect((await submitted.wait(context)).status).toBe('done')
  const results = (await root.context(context)).entries.filter(
    (entry) => entry.kind === 'pi.tool-result',
  )
  const textOf = (entry: (typeof results)[number]) =>
    (
      (entry.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content ??
      []
    )
      .map((part) => part.text ?? '')
      .join('\n')
  expect(textOf(results[0])).toContain(
    'action: missing (expected one of ["start","message","wait","stop","list","land","discard"])',
  )
  expect(textOf(results[1])).toContain(
    'questions.0.kind: missing (expected one of ["choice","multi","confirm","text","scale"])',
  )
  expect(textOf(results[1])).toContain(
    'questions.0.options.0: expected object, got string (required: label; optional: key, recommended)',
  )
})
