// Pi upstream: @earendil-works/pi-ai@1.6.0 dist/api/openai-codex-responses.js — exercises the grammar argument framing and WebSocket continuation patch. Drop with those hunks.
import type { Message, Model, Tool } from '@earendil-works/pi-ai'
import {
  closeOpenAICodexWebSocketSessions,
  stream as streamOpenAICodexResponses,
} from '@earendil-works/pi-ai/api/openai-codex-responses'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createCodemodeTool } from '@earendil-works/pi-durable/codemode'
import type { CodemodeToolOptions } from '@earendil-works/pi-durable/codemode'
import { afterEach, expect, it, vi } from 'vitest'

const model: Model<'openai-codex-responses'> = {
  id: 'gpt-test',
  name: 'gpt-test',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
  compat: {
    supportsOpenAIGrammarTools: true,
    supportsMidConvoSystemMessages: true,
    supportsAdditionalTools: true,
  },
}
const codemode = createCodemodeTool({ sandbox: {} } as CodemodeToolOptions) as unknown as Tool
const apiKey = `test.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test' } }))}.test`
const code = '{ const n = 7;\n return n; }'
const sessionId = 'grammar-stream-test'
const options = {
  apiKey,
  sessionId,
  transport: 'websocket-cached' as const,
  maxRetries: 0,
  fetch: () => {
    throw new Error('Unexpected SSE fallback')
  },
}

function completion(id: string) {
  return { type: 'response.completed', response: { id, status: 'completed' } }
}

function fakeWebSocket(...responses: object[][]) {
  const requests: { previous_response_id?: string; input: { type: string; tools?: object[] }[] }[] =
    []
  let connections = 0
  vi.stubGlobal(
    'WebSocket',
    class extends EventTarget {
      readyState = 1
      constructor() {
        super()
        connections++
        queueMicrotask(() => this.dispatchEvent(new Event('open')))
      }
      send(json: string) {
        const events = responses[requests.length]
        requests.push(JSON.parse(json))
        queueMicrotask(() => {
          for (const data of events ?? [])
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
          if (!events) this.dispatchEvent(new Event('error'))
        })
      }
      close() {
        this.readyState = 3
      }
    },
  )
  return { requests, connections: () => connections }
}

afterEach(() => {
  closeOpenAICodexWebSocketSessions(sessionId)
  vi.unstubAllGlobals()
})

it.each([
  { framing: 'streamed raw program', expectedCode: code },
  { framing: 'JSON wrapper', wireArguments: JSON.stringify({ code }), expectedCode: code },
  { framing: 'repairable JSON wrapper', wireArguments: `{"code":"${code}"}`, expectedCode: code },
  { framing: 'raw empty block', wireArguments: '{ }', expectedCode: '{ }' },
])(
  'replays a Codex function-framed grammar call: $framing',
  async ({ wireArguments, expectedCode }) => {
    const item = {
      type: 'function_call',
      name: 'codemode',
      call_id: 'call_code',
      id: 'fc_code',
      arguments: '',
    }
    const correct = {
      type: 'custom_tool_call',
      name: 'codemode',
      call_id: 'call_custom',
      id: 'ctc_code',
      input: code,
    }
    const events =
      wireArguments === undefined
        ? [
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, arguments: code.slice(0, 2) },
            },
            {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: code.slice(2),
            },
            { type: 'response.output_item.done', output_index: 0, item },
          ]
        : [
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: { ...item, arguments: wireArguments },
            },
          ]
    const { requests, connections } = fakeWebSocket(
      [...events, completion('resp_framed')],
      [
        { type: 'response.output_item.done', output_index: 0, item: correct },
        completion('resp_custom'),
      ],
      [completion('resp_after_custom')],
    )
    const messages: Message[] = [
      { role: 'user', content: 'go', timestamp: 1 },
      { role: 'system', content: '', toolsAdded: [codemode], timestamp: 2 },
    ]
    const run = () => streamOpenAICodexResponses(model, normalizeContext({ messages }), options)
    const stream = run()
    const deltas: string[] = []
    for await (const event of stream) {
      if (event.type === 'toolcall_delta') deltas.push(event.delta)
    }
    const first = await stream.result()
    const firstRequest = requests[0]
    expect(firstRequest.input).toContainEqual(
      expect.objectContaining({
        type: 'additional_tools',
        tools: [expect.objectContaining({ type: 'custom', name: 'codemode' })],
      }),
    )
    expect(first.stopReason).toBe('toolUse')
    expect(first.content).toEqual([
      {
        type: 'toolCall',
        id: 'call_code|fc_code',
        name: 'codemode',
        arguments: { code: expectedCode },
      },
    ])
    const result = (toolCallId: string): Message => ({
      role: 'toolResult',
      toolCallId,
      toolName: 'codemode',
      content: [{ type: 'text', text: '7' }],
      isError: false,
      timestamp: 2,
    })
    messages.push(first, result('call_code|fc_code'))
    const second = await run().result()
    expect(connections()).toBe(1)
    expect(requests[1]?.previous_response_id).toBeUndefined()
    expect(JSON.parse(deltas.join(''))).toEqual({ code: expectedCode })
    expect(requests[1]?.input).toEqual([
      ...firstRequest.input,
      { type: 'custom_tool_call', name: 'codemode', call_id: 'call_code', input: expectedCode },
      { type: 'custom_tool_call_output', call_id: 'call_code', output: '7' },
    ])
    expect(second.content).toEqual([
      { type: 'toolCall', id: 'call_custom|ctc_code', name: 'codemode', arguments: { code } },
    ])
    messages.push(second, result('call_custom|ctc_code'))
    expect((await run().result()).stopReason).toBe('stop')
    expect(requests[2]?.previous_response_id).toBe('resp_custom')
    expect(requests[2]?.input).toEqual([
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: '7' },
    ])
  },
)

it('keeps invalid arguments invalid when codemode is sent as a function', async () => {
  const { requests } = fakeWebSocket([
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        name: 'codemode',
        call_id: 'call_json',
        id: 'fc_json',
        arguments: code,
      },
    },
    completion('resp_json'),
  ])
  const response = await streamOpenAICodexResponses(
    { ...model, compat: { supportsOpenAIGrammarTools: true } },
    normalizeContext({
      tools: [codemode],
      messages: [{ role: 'user', content: 'go', timestamp: 1 }],
    }),
    {
      ...options,
      onPayload: (body) => ({
        ...(body as object),
        tools: [{ type: 'function', name: 'codemode', parameters: codemode.parameters }],
      }),
    },
  ).result()
  expect(requests[0]).toMatchObject({ tools: [{ type: 'function', name: 'codemode' }] })
  expect(response.stopReason).toBe('toolUse')
  expect(response.content).toEqual([
    expect.objectContaining({
      type: 'toolCall',
      name: 'codemode',
      arguments: {},
      argumentsError: expect.any(String),
    }),
  ])
})
