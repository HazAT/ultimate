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
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/status-line/actions/rates')
      return Response.json({ result: harness.rates })
    if (path === '/api/models') return Response.json({ providers: [], models: [] })
    return harness.server?.handle(path, init) ?? Response.json({ ok: true })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
  })
  const api = createApi(store, { fetch: pageFetch })
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
  await settle()
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

it('updates the closed usage tooltip in place while usage streams', async ({ onTestFinished }) => {
  store.start()
  onTestFinished(() => store.stop())
  const stream = harness.sources.at(-1)!
  stream.open()
  stream.send('system', system(1))
  const container = renderSolid(() => <Tokens />)
  const usageOf = (output: number) => ({
    models: { 'claude-x': usage(1200, output, 0.5), 'claude-y': usage(10, 20, 0.1) },
    tools: { search: usage(0, 0, 0.01) },
  })
  const tick = (output: number) =>
    harness.server!.of()!.send('view', {
      conversation: { id: 7 },
      entries: [],
      docs: { 'pi.usage': usageOf(output) },
    } as unknown as StreamedView)
  tick(300)
  await settle()
  flush()
  const tip = container.querySelector('[role="tooltip"]')!
  expect(tip.textContent).toContain('claude-x↑1.2k ↓300')
  const rows = [...tip.querySelectorAll('span')]
  const replaced: Node[] = []
  const observer = new MutationObserver((records) =>
    records.forEach((record) => replaced.push(...record.removedNodes)),
  )
  observer.observe(tip, { childList: true, subtree: true })
  onTestFinished(() => observer.disconnect())

  for (const output of [400, 500, 600]) {
    tick(output)
    await settle()
    flush()
  }

  expect(tip.textContent).toContain('claude-x↑1.2k ↓600')
  expect(replaced.filter((node) => rows.includes(node as HTMLSpanElement))).toEqual([])
})

const sample = (output: number): RateSample => ({
  rates: { input: 0, output, cacheRead: 0, cacheWrite: 0 },
  elapsed: 30,
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
})
const system = (generation: number) =>
  ({ process: { pid: 7, generation, startedAt: '2026-01-01T00:00:00Z' } }) as unknown as SystemInfo

it('follows the rate the server samples every second, and forgets it while the stream is down', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers()
  onTestFinished(() => void vi.useRealTimers())
  harness.rates = sample(10)
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
  expect(harness.server!.reads.at(-1)).toMatchObject({
    read: { extension: 'status-line', action: 'rates' },
    every: 1000,
  })

  harness.rates = sample(20)
  await vi.advanceTimersByTimeAsync(1000)
  flush()
  expect(rate()).toBe('↓20 tok/s')

  stream.drop()
  flush()
  expect(rate()).toBe('↓? tok/s')
  harness.rates = sample(30)
  stream.open()
  stream.send('system', system(2))
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(rate()).toBe('↓30 tok/s')
})
