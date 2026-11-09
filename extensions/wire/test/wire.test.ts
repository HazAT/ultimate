import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TurnRelay } from '@earendil-works/pi-claude-code/src/turn-relay.ts'
import type { RelayExchange } from '@earendil-works/pi-claude-code/src/turn-relay.ts'
import { diffBodies } from '../diff.ts'
import { list, load, PER_CONVERSATION, save } from '../store.ts'

// Pi upstream: @earendil-works/pi-claude-code@0.1.0 src/turn-relay.ts — the patched relay keeps each turn's exchange
// for useExchangeTap (Wire). Drop with the patch when upstream exposes the relay's exchanges.
it('keeps the relayed request as sent and the raw stream, never the credentials', async () => {
  const stream = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response
      .writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'a=b' })
      .end(stream)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn(undefined, (body) => Buffer.from(body.toString().replace('1', '2')), ['beta-x'])
  const exchanges: RelayExchange[] = []
  relay.onExchange = (exchange) => exchanges.push(exchange)
  try {
    const response = await fetch(`${url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'x-api-key': 'k', 'anthropic-beta': 'a' },
      body: '{"turn":1}',
    })
    await response.text()
    await relay.settled()
    const [exchange] = exchanges
    expect(exchange.requestBody.toString()).toBe('{"turn":2}')
    expect(exchange.response.toString()).toBe(stream)
    expect(exchange.url).toMatch(/\/v1\/messages\?beta=true$/)
    expect(exchange.requestHeaders).toMatchObject({
      authorization: '[redacted]',
      'x-api-key': '[redacted]',
      'anthropic-beta': 'a,beta-x',
    })
    expect(exchange.responseHeaders['set-cookie']).toBe('[redacted]')
    expect(JSON.stringify(exchange)).not.toMatch(/secret|"k"/)
  } finally {
    await relay.close()
    upstream.close()
  }
})

// Review of #540587: the exchange was read when the turn ended, before an aborted request's handler had recorded it.
it('hands over an aborted request once its handler ends', async () => {
  let reached: () => void
  const started = new Promise<void>((resolve) => (reached = resolve))
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response.writeHead(200, { 'content-type': 'text/event-stream' }).write('event: ping\n\n')
    reached()
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 1_000)
  const url = await relay.start()
  relay.beginTurn()
  const exchanges: RelayExchange[] = []
  relay.onExchange = (exchange) => exchanges.push(exchange)
  try {
    const response = fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' }).catch(
      () => undefined, // The abort below cuts the connection; only the relay's record matters here.
    )
    await started
    relay.abort()
    await response
    await relay.settled()
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].requestBody.toString()).toBe('{}')
    expect(exchanges[0].failure).toMatch(/aborted/)
  } finally {
    await relay.close()
    upstream.closeAllConnections()
    upstream.close()
  }
})

it('points at the first change in cache order, not JSON order', () => {
  // Anthropic caches tools, system, then messages; the body lists messages first.
  const previous = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: [{ type: 'text', text: 'You are helpful.' }],
    tools: [{ name: 'read' }],
    max_tokens: 100,
  }
  const appended = {
    ...previous,
    messages: [
      ...previous.messages,
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ],
  }
  const append = diffBodies(previous, appended, 1)
  expect(append.firstChange).toBeUndefined()
  expect(append.added.map((segment) => segment.path)).toEqual([
    'messages[1]',
    'messages[1].content[0]',
  ])

  const changed = diffBodies(
    appended,
    { ...appended, system: [{ type: 'text', text: 'You are terse.' }] },
    2,
  )
  expect(changed.same).toBe(1)
  expect(changed.firstChange).toMatchObject({
    path: 'system[0]',
    before: expect.stringMatching(/^helpful/),
  })
})

it('keeps the newest calls of a conversation', async () => {
  const queue = { tail: Promise.resolve() as Promise<unknown> }
  const home = await mkdtemp(join(tmpdir(), 'wire-'))
  try {
    const call = {
      conversationId: 7,
      source: 'payload' as const,
      provider: 'p',
      model: 'm',
      startedAt: 0,
      endedAt: 1,
      request: '{}',
    }
    for (let i = 0; i < PER_CONVERSATION + 2; i++) await save(queue, home, call)
    const kept = await list(home, 7)
    expect(kept.map((summary) => summary.n)).toEqual(
      Array.from({ length: PER_CONVERSATION }, (_, i) => i + 3),
    )
    expect((await load(home, 7, 3))?.request).toBe('{}')
    expect(await readdir(join(home, 'wire', '7'))).toHaveLength(PER_CONVERSATION * 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
