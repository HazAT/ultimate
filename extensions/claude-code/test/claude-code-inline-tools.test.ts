import { expect, it } from 'vitest'
import type { Message } from '@earendil-works/pi-ai'
import { prepareNativeTranscript } from '@earendil-works/pi-claude-code/src/transcript.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/transcript.ts — a redefined tool falls back to one merged system prompt, rewriting the whole cache on every later change. The pnpm patch defines tools inline instead. Drop with the matching patch when upstream does this.
const tool = (name: string, description: string) => ({
  name,
  description,
  parameters: { type: 'object', properties: {} },
})
const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })
const assistant = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'claude-code-stream-json',
    provider: 'claude-code',
    model: 'claude-opus-5-5',
    usage: {},
    stopReason: 'stop',
    timestamp: 0,
  }) as unknown as Message

const before: Message[] = [
  {
    role: 'system',
    content: '',
    sections: { identity: '<identity>Ultimate</identity>', skills: '<skills>a</skills>' },
    toolsAdded: [tool('read', 'Read a file'), tool('branch', 'Start a branch')],
    timestamp: 0,
  },
  user('Hi'),
  assistant('Hello'),
  user('Land it'),
]
// A landing changes the branch tool and the skills section: Pi Durable removes and re-adds both tools.
const after: Message[] = [
  ...before,
  assistant('Landed'),
  {
    role: 'system',
    content: '',
    sections: { skills: '<skills>b</skills>' },
    toolsRemoved: [{ name: 'read' }, { name: 'branch' }],
    toolsAdded: [tool('read', 'Read a file'), tool('branch', 'Start a coordinator branch')],
    timestamp: 0,
  },
  user('Next'),
]

it('sends a tool redefinition and a section change as appended blocks, keeping the cached prefix', () => {
  const first = prepareNativeTranscript(before, true)!
  const second = prepareNativeTranscript(after, true)
  // No fallback to one merged system prompt: the native plan still applies.
  expect(second).toBeDefined()
  // The request tool list (the start of the cached prefix) does not change.
  expect(second!.requestTools).toEqual(first.requestTools)
  expect(second!.requestTools.map((t) => t.name)).toEqual([
    'mcp__pi__read',
    'mcp__pi__branch',
    '__pi_deferred_placeholder__',
  ])
  // Everything earlier stays as it was; the change is appended at the request tail.
  expect(first.systemInjections).toEqual([])
  expect(second!.systemInjections).toEqual([
    {
      beforeAssistant: null,
      content: [
        { type: 'text', text: 'Updated system prompt section "skills":\n\n<skills>b</skills>' },
        {
          type: 'tool_addition',
          tool: {
            type: 'tool_definition',
            definition: {
              name: 'mcp__pi__read',
              description: 'Read a file',
              input_schema: { type: 'object', properties: {} },
            },
          },
        },
        {
          type: 'tool_addition',
          tool: {
            type: 'tool_definition',
            definition: {
              name: 'mcp__pi__branch',
              description: 'Start a coordinator branch',
              input_schema: { type: 'object', properties: {} },
            },
          },
        },
      ],
    },
  ])
})

it('withdraws a removed tool by reference', () => {
  const plan = prepareNativeTranscript(
    [
      ...before,
      assistant('Done'),
      { role: 'system', content: '', toolsRemoved: [{ name: 'branch' }], timestamp: 0 },
      user('Next'),
    ],
    true,
  )!
  expect(plan.systemInjections[0]?.content).toEqual([
    { type: 'tool_removal', tool: { type: 'tool_reference', name: 'mcp__pi__branch' } },
  ])
})
