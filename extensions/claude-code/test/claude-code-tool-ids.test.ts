import { expect, it } from 'vitest'
import type { Message } from '@earendil-works/pi-ai'
import { prepareFrames } from '@earendil-works/pi-claude-code/src/transcript.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/transcript.ts — tool calls made on openai-codex carry
// `call_…|fc_…` ids, which Anthropic rejects (^[a-zA-Z0-9_-]+$), so a conversation that switched to Claude Code
// failed every turn with a 400. Drop with the matching pnpm patch when upstream normalises tool ids.
const codexId = `call_f288e9ad4aff415d9db1f85caddf8936|fc_0de07bd9${'a'.repeat(40)}`

it('sends a Codex tool id as a valid id matching on tool_use and tool_result', () => {
  const history = [
    { role: 'user', content: 'List files', timestamp: 0 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: codexId, name: 'bash', arguments: { command: 'ls' } }],
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      usage: {},
      stopReason: 'toolUse',
      timestamp: 0,
    },
    {
      role: 'toolResult',
      toolCallId: codexId,
      toolName: 'bash',
      content: [{ type: 'text', text: 'a.ts' }],
      isError: false,
      timestamp: 0,
    },
  ] as unknown as Message[]

  const [, call, result] = prepareFrames(history)
  const id = (call.message.content[0] as { id: string }).id
  expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  expect(result.message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: id })
})
