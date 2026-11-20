/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { StreamedView, SystemInfo } from '../../../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { RateSample } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  rates: null as RateSample | null,
  hang: false,
  requests: 0,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/status-line/actions/rates') {
      harness.requests++
      if (harness.hang)
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
        )
      return Response.json({ result: harness.rates })
    }
    if (path === '/api/models') return Response.json({ providers: [], models: [] })
    return harness.server?.handle(path, init) ?? Response.json({ ok: true })
  }
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  const api = createApi(store, { fetch })
  return { store, api, reads: createReads(api, store), uiState: createUiState(undefined) }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { Connection, Context, GlobalUsage, Tokens } from '../../status.solid.tsx'

harness.server = fakeSubscriptions(harness.sources)
const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
})

it('shows the conversation’s spend, its context fill, the project’s rate and the connection', async ({
  onTestFinished,
}) => {
  harness.rates = {
    rates: { input: 10, output: 42.4, cacheRead: 0, cacheWrite: 0 },
    elapsed: 30,
    totals: { input: 1500, output: 2500, cacheRead: 0, cacheWrite: 0, cost: 1.25 },
  }
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  harness.sources[0].send('system', system(1))
  const container = renderSolid(() => (
    <>
      <Tokens />
      <Context />
      <GlobalUsage />
      <Connection />
    </>
  ))
  expect(container.querySelector('[aria-label="Output token rate"]')?.textContent).toBe('↓? tok/s')

  const view = {
    conversation: { id: 7 },
    entries: [],
    docs: {
      'pi.usage': { models: { 'claude-x': usage(1200, 300, 0.5) }, tools: {} },
    },
  } as unknown as StreamedView
  harness.server!.of()!.send('view', view)
  harness.server!.of()!.send('doc', {
    kind: 'conversations.context',
    value: { tokens: 160_000, window: 200_000, percent: 80, at: 1 },
  })
  await settle()
  flush()

  expect(container.textContent).toContain('↑1.2k↓300$0.500')
  const meter = container.querySelector('[aria-label="Context use"]')
  expect(meter?.textContent).toBe('80.0%/200k')
  expect(meter?.className).toContain('text-warning')
  expect(container.querySelector('[aria-label="Output token rate"]')?.textContent).toBe('↓42 tok/s')
  expect(container.querySelector('[aria-label="Global spend"]')?.textContent).toBe(
    '↑1.5k ↓2.5k $1.250',
  )
  expect(container.textContent).toContain('live')
})

const sample = (output: number): RateSample => ({
  rates: { input: 0, output, cacheRead: 0, cacheWrite: 0 },
  elapsed: 30,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
})
const system = (generation: number) =>
  ({ process: { pid: 7, generation, startedAt: '2026-01-01T00:00:00Z' } }) as unknown as SystemInfo

it('gives up on a hung rates request after 5 s and polls on, and forgets the rate when the server restarts', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers()
  onTestFinished(() => void vi.useRealTimers())
  harness.rates = sample(10)
  harness.hang = false
  store.start()
  onTestFinished(() => store.stop())
  const stream = harness.sources.at(-1)!
  stream.open()
  stream.send('system', system(1))
  const container = renderSolid(() => <GlobalUsage />)
  const rate = () => container.querySelector('[aria-label="Output token rate"]')?.textContent
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(rate()).toBe('↓10 tok/s')

  harness.hang = true
  await vi.advanceTimersByTimeAsync(1000)
  const hung = harness.requests
  await vi.advanceTimersByTimeAsync(5000)
  flush()
  expect(rate()).toBe('↓? tok/s')
  harness.hang = false
  harness.rates = sample(20)
  await vi.advanceTimersByTimeAsync(1000)
  flush()
  expect(harness.requests).toBeGreaterThan(hung)
  expect(rate()).toBe('↓20 tok/s')

  harness.hang = true
  stream.send('system', system(2))
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(rate()).toBe('↓? tok/s')
})
