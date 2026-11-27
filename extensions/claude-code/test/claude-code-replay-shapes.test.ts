import { expect, it } from 'vitest'
import type { Message } from '@earendil-works/pi-ai'
import { rewriteInitialRequest } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import {
  prepareFrames,
  prepareNativeTranscript,
} from '@earendil-works/pi-claude-code/src/transcript.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/transcript.ts — two replayed shapes Claude Code 2.1.322
// reshapes, after which the relay's rewrite failed every later turn of the conversation. Drop with the matching pnpm
// patch when upstream fixes this.
const text = (value: string) => ({ type: 'text', text: value })
const turn = { api: 'claude-code-stream-json', provider: 'claude-code', model: 'claude-opus-5-5' }
const assistant = (content: unknown[]) =>
  ({ role: 'assistant', content, ...turn, stopReason: 'stop', timestamp: 0 }) as unknown as Message

// #1100481: a codemode result that failed after saving two images. Claude Code sent it as one text block with the
// images gone, and the rewrite failed with "lost a text block in user message 1". Anthropic rejects images in an error
// result ("all content must be type `text` if `is_error` is true"), so Pi sends its text alone too.
it('sends an error tool result with images as its text alone', () => {
  const frames = prepareFrames([
    { role: 'user', content: 'Take screenshots', timestamp: 0 },
    assistant([{ type: 'toolCall', id: 'tool-1', name: 'codemode', arguments: {} }]),
    {
      role: 'toolResult',
      toolCallId: 'tool-1',
      toolName: 'codemode',
      content: [
        text('Script failed'),
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        text('Script error'),
      ],
      isError: true,
      timestamp: 0,
    },
  ] as Message[])
  const result = {
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'Script failed\nScript error',
    is_error: true,
  }
  expect(frames[2].message.content).toEqual([result])
  const sent = {
    messages: [
      { role: 'user', content: [text('Take screenshots')] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__pi__codemode', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [
              text('Script failed\nScript error\n\n<system-reminder>account</system-reminder>'),
            ],
            is_error: true,
          },
        ],
      },
    ],
  }
  const rewritten = JSON.parse(
    rewriteInitialRequest(Buffer.from(JSON.stringify(sent)), frames, undefined).toString(),
  )
  expect(rewritten.messages[2].content).toEqual([result])
})

// #1111974: an answer whose only text was Claude Code's "(no content)". Claude Code dropped that turn and merged the
// user messages around it, so its request had 190 user messages where Pi's history had 191. Claude Code 2.1.322 also
// drops the turn when signed thinking precedes the placeholder, and keeps it when it has real text too.
it('drops an assistant turn whose only answer is "(no content)", as Claude Code does', () => {
  const thinking = { type: 'thinking', thinking: 'Waiting', thinkingSignature: 'c2ln' }
  const history = (placeholder: unknown[]) =>
    [
      {
        role: 'system',
        content: 'You help.',
        toolsAdded: [{ name: 'subagent', description: 'Start', parameters: { type: 'object' } }],
        timestamp: 0,
      },
      { role: 'user', content: 'Start the reviewer', timestamp: 0 },
      assistant([{ type: 'toolCall', id: 'tool-1', name: 'subagent', arguments: {} }]),
      {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'subagent',
        content: [text('Started')],
        isError: false,
        timestamp: 0,
      },
      assistant(placeholder),
      { role: 'system', content: 'Later section', timestamp: 0 },
      { role: 'user', content: '[subagent answered] APPROVED', timestamp: 0 },
      assistant([text('Done')]),
      { role: 'user', content: 'Thanks', timestamp: 0 },
    ] as Message[]
  for (const placeholder of [[text('(no content)')], [thinking, text('(no content)')]]) {
    const messages = history(placeholder)
    const frames = prepareFrames(messages)
    expect(frames.map((frame) => frame.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(frames[2].message.content.map((block) => (block as { type: string }).type)).toEqual([
      'tool_result',
      'text',
    ])
    // The later section lands before the next answer Claude Code keeps: the second assistant message.
    expect(prepareNativeTranscript(messages, true)!.systemInjections[0].beforeAssistant).toBe(1)
  }
  const kept = prepareFrames(history([text('Real answer.'), text('(no content)')]))
  expect(kept.map((frame) => frame.type)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
    'user',
    'assistant',
    'user',
  ])
  expect(kept[3].message.content).toEqual([text('Real answer.'), text('(no content)')])
})
