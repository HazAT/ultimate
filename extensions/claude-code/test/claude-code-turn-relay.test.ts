import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/turn-relay.ts — one TLS "bad record mac" from a flaky network
// ended the turn as an incomplete response. The pnpm patch retries a transport failure before any response byte
// reached Claude Code. Drop with the matching patch when upstream does this.
const delays = TurnRelay.transportRetryDelaysMs
afterEach(() => {
  TurnRelay.transportRetryDelaysMs = delays
})

const completed = [
  {
    type: 'message_start',
    message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 2 } },
  },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
]
  .map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`)
  .join('')

it('retries a request whose connection broke before the response', async () => {
  TurnRelay.transportRetryDelaysMs = [0]
  const bodies: string[] = []
  const upstream = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    bodies.push(body)
    // The first connection dies the way a corrupted TLS record kills it: no status, no bytes.
    if (bodies.length === 1) request.socket.destroy()
    else response.writeHead(200, { 'content-type': 'text/event-stream' }).end(completed)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn()
  try {
    const response = await fetch(`${url}/v1/messages`, { method: 'POST', body: '{"turn":1}' })
    await response.text()
    await relay.settled()
    expect(response.status).toBe(200)
    expect(relay.failure).toBeUndefined()
    expect(relay.capture.complete).toBe(true)
    expect(bodies).toEqual(['{"turn":1}', '{"turn":1}'])
  } finally {
    await relay.close()
    upstream.close()
  }
})
