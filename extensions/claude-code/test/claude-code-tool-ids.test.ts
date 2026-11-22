import { expect, it } from 'vitest'
import type { Message } from '@earendil-works/pi-ai'
import { prepareFrames, prepareMessages } from '@earendil-works/pi-claude-code/src/transcript.ts'
import { CLAUDE_CODE_MODELS } from '@earendil-works/pi-claude-code/src/model-catalog.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/transcript.ts — tool calls made on openai-codex carry
// `call_…|fc_…` ids, which Anthropic rejects (^[a-zA-Z0-9_-]+$), so a conversation that switched to Claude Code
// failed every turn with a 400. Upstream's prepareMessages replaces the invalid characters and cuts at 64, so two
// distinct ids could become one; the patch adds a hash. Drop with the matching pnpm patch when upstream keeps them
// distinct.
const codexId = `call_f288e9ad4aff415d9db1f85caddf8936|fc_0de07bd9${'a'.repeat(40)}`
const twinId = `call_f288e9ad4aff415d9db1f85caddf8936_fc_0de07bd9${'a'.repeat(40)}`

it('sends Codex tool ids as valid, distinct ids matching on tool_use and tool_result', () => {
  const history = [
    { role: 'user', content: 'List files', timestamp: 0 },
    {
      role: 'assistant',
      content: [codexId, twinId].map((id) => ({
        type: 'toolCall',
        id,
        name: 'bash',
        arguments: { command: 'ls' },
      })),
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      usage: {},
      stopReason: 'toolUse',
      timestamp: 0,
    },
    ...[codexId, twinId].map((toolCallId) => ({
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text: 'a.ts' }],
      isError: false,
      timestamp: 0,
    })),
  ] as unknown as Message[]

  const [, call, results] = prepareFrames(prepareMessages(history, CLAUDE_CODE_MODELS[0]))
  const ids = (call.message.content as { id: string }[]).map((block) => block.id)
  for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  expect(new Set(ids).size).toBe(2)
  expect(
    (results.message.content as { tool_use_id: string }[]).map((block) => block.tool_use_id),
  ).toEqual(ids)
})
