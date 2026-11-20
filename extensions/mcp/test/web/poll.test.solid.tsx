/** @jsxImportSource @solidjs/web */
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { McpServerStatus } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  requests: [] as { name: string; args: unknown; source: string | null }[],
  servers: [] as McpServerStatus[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const match = /^\/api\/extensions\/mcp\/actions\/(\w+)$/.exec(input as string)
    if (!match) return subscriptions.handle(input as string, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    harness.requests.push({
      name: match[1],
      args,
      source: new Headers(init?.headers).get('x-ultimate-source'),
    })
    if (match[1] === 'reconnect')
      harness.servers = harness.servers.map((server) => ({
        ...server,
        error: undefined,
        state: 'connected',
        tools: 1,
      }))
    return Response.json({ result: harness.servers })
  }
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch,
  })
  const api = createApi(store, { fetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { Chip } from '../../chip.solid.tsx'

it('polls every 2 s while a server connects, then every minute', async ({ onTestFinished }) => {
  vi.useFakeTimers()
  onTestFinished(() => void vi.useRealTimers())
  harness.requests.length = 0
  harness.servers = [{ name: 'example', source: 'user', state: 'connecting', transport: 'stdio' }]
  store.start()
  onTestFinished(() => store.stop())
  harness.sources.at(-1)!.open()
  renderSolid(() => <Chip />)
  const polls = () => harness.requests.filter((request) => request.name === 'status').length
  await vi.advanceTimersByTimeAsync(2_100)
  flush()
  const connecting = polls()
  await vi.advanceTimersByTimeAsync(4_000)
  flush()
  expect(polls()).toBe(connecting + 2)

  harness.servers = [{ ...harness.servers[0], state: 'connected', tools: 1 }]
  await vi.advanceTimersByTimeAsync(2_100)
  flush()
  const settled = polls()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(polls()).toBe(settled)
  await vi.advanceTimersByTimeAsync(30_100)
  expect(polls()).toBe(settled + 1)
})
