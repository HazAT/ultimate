import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { piToolName } from '@earendil-works/pi-claude-code/src/stream.ts'
import { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/stream.ts — a tool_use the request did not offer (a bare
// `bash` instead of `mcp__pi__bash`) ended the turn. The pnpm patch resolves it to Pi's name and leaves unknown
// names to Pi's "not available" tool error. Drop with the matching patch when upstream does this.
const sse = (events: object[]) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('')

// The response that failed dream branch #371663 four times: signed thinking, then a tool named without the MCP prefix.
const bareBash = sse([
  {
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 2 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
])

it('resolves prefixed and bare tool names to Pi names', () => {
  expect(piToolName('mcp__pi__bash')).toBe('bash')
  expect(piToolName('bash')).toBe('bash')
  // A name Pi does not have passes through; Pi Durable answers it with "Tool Bash is not available".
  expect(piToolName('Bash')).toBe('Bash')
})

it('completes a turn whose model names a tool without its MCP prefix', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(bareBash)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  const started: string[] = []
  relay.beginTurn((event) => {
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      started.push(piToolName(event.content_block.name))
    }
  })
  try {
    await (await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })).text()
    await relay.settled()
    expect(relay.failure).toBeUndefined()
    expect(relay.capture.complete).toBe(true)
    expect(started).toEqual(['bash'])
    expect(relay.capture.message?.content[1]).toMatchObject({
      type: 'tool_use',
      name: 'bash',
      input: { command: 'ls' },
    })
  } finally {
    await relay.close()
    upstream.close()
  }
})
