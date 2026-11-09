import { expect, it } from 'vitest'
import { rewriteInitialRequest } from '@earendil-works/pi-claude-code/src/claude-cli.ts'
import { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/claude-cli.ts — replaying a history whose first user message
// starts with "/" makes Claude Code send that message as a bare string, which the rewrite rejected. Drop with the
// matching pnpm patch when upstream fixes this.
const cache = { type: 'ephemeral', ttl: '1h' }
const text = (value: string) => ({ type: 'text', text: value })
const reminder = [text('<system-reminder>Repository context</system-reminder>')]
const ask = '/home/me/Notes/Post.md Draft this post'
const date = [
  { role: 'system', content: [{ ...text("Today's date is 2026-10-22."), cache_control: cache }] },
]

// The request Claude Code sent for conversation #2101 in danielgriesser.com, shortened: a slash-leading first
// message as a string, an emptied environment, and a parallel batch of results, one of them an error.
const slashReplay = {
  system: [text('Identity'), { ...text('Instructions'), cache_control: cache }],
  messages: [
    { role: 'user', content: ask },
    { role: 'system', content: [] },
    {
      role: 'assistant',
      content: ['memory', 'read', 'read'].map((name, index) => ({
        type: 'tool_use',
        id: `tool-${index}`,
        name: `mcp__pi__${name}`,
        input: {},
      })),
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-0', content: 'memory index', is_error: false },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'ENOENT', is_error: true },
        { type: 'tool_result', tool_use_id: 'tool-2', content: 'skill file', is_error: false },
      ],
    },
    { role: 'system', content: [{ ...text('# Environment\nlinux'), cache_control: cache }] },
  ],
}

it('replays a history whose first user message starts with a slash', () => {
  const rewritten = JSON.parse(
    rewriteInitialRequest(
      Buffer.from(JSON.stringify(slashReplay)),
      reminder,
      [text(ask)],
      date,
      undefined,
    ).toString(),
  )
  expect(rewritten.messages.map((message: { role: string }) => message.role)).toEqual([
    'user',
    'system',
    'assistant',
    'user',
    'system',
  ])
  expect(rewritten.messages[0].content).toEqual([...reminder, text(ask)])
  expect(rewritten.messages[1].content[0].text).toBe("Today's date is 2026-10-22.")
  expect(
    rewritten.messages[3].content.map((block: { is_error: boolean }) => block.is_error),
  ).toEqual([false, true, false])
})

it('names the error when the relay fails before reaching upstream', async () => {
  const relay = new TurnRelay('http://127.0.0.1:9', 1_000)
  const url = await relay.start()
  relay.beginTurn(undefined, () => {
    throw new Error('Claude Code request is missing its initial user message')
  })
  try {
    const response = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(502)
    await relay.settled()
    expect(relay.status).toBeUndefined()
    expect(relay.failure).toBe('Error: Claude Code request is missing its initial user message')
  } finally {
    await relay.close()
  }
})
