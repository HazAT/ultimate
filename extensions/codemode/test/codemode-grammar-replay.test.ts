// Pi upstream: @earendil-works/pi-ai@1.6.0 dist/api/openai-responses-shared.js convertResponsesMessages — the replay
// patches/@earendil-works__pi-ai@1.6.0.patch fixes. Drop with the patch.
import type { AssistantMessage, Message, Model, Tool } from '@earendil-works/pi-ai'
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling'
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createCodemodeTool } from '@earendil-works/pi-durable/codemode'
import type { CodemodeToolOptions } from '@earendil-works/pi-durable/codemode'
import { expect, it } from 'vitest'

const model: Model<'openai-codex-responses'> = {
  id: 'gpt-test',
  name: 'gpt-test',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
}

function call(id: string, args: { code?: string }, argumentsError?: string): Message[] {
  const assistant: AssistantMessage = {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id,
        name: 'codemode',
        arguments: args,
        ...(argumentsError ? { argumentsError } : {}),
      },
    ],
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
    stopReason: 'toolUse',
    timestamp: 2,
  }
  return [
    assistant,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: 'codemode',
      content: [{ type: 'text', text: 'result' }],
      isError: argumentsError !== undefined,
      timestamp: 3,
    },
  ]
}

// The codemode tool Pi Durable registers, as declared to the model: a grammar tool whose raw input is `code`.
const codemode = createCodemodeTool({ sandbox: {} } as CodemodeToolOptions) as unknown as Tool
const grammarToolInputProperties = createGrammarToolInputProperties([codemode], true)

it('declares codemode as a grammar tool whose raw input is the code', () => {
  expect(grammarToolInputProperties.get('codemode')).toBe('code')
})

// A grammar-capable model once answered with JSON its grammar did not accept: Pi recorded that call with `{}` and an
// argumentsError, and every later request of the conversation threw while replaying it, so three runs died.
it('replays a codemode call whose arguments failed to parse instead of failing every later request', () => {
  const context = normalizeContext({
    systemPrompt: 'system',
    tools: [codemode],
    messages: [
      { role: 'user', content: 'go', timestamp: 1 },
      ...call('call_bad|ctc_bad', {}, 'Unexpected token'),
      ...call('call_ok|ctc_ok', { code: 'return 1' }),
      { role: 'user', content: 'again', timestamp: 4 },
    ],
  })
  const input = convertResponsesMessages(model, context, new Set(['openai-codex']), {
    grammarToolInputProperties,
  })
  const calls = input.filter((item) => item.type === 'custom_tool_call')
  expect(calls.map((item) => item.input)).toEqual(['{}', 'return 1'])
})
