/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
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

import { ROOT } from '../../../../web/src/sdk/api.ts'
import { reads, store } from '../../../../web/src/sdk/client.ts'
import { Chip } from '../../chip.solid.tsx'
import { StatusAction } from '../../refs.ts'

const agent = createAgent()

beforeEach(() => {
  harness.sources.length = 0
  harness.requests.length = 0
})

it('lets an agent reconnect a failed MCP server from the status chip', async ({
  onTestFinished,
}) => {
  harness.servers = [
    {
      name: 'example',
      source: 'user',
      state: 'failed',
      transport: 'stdio',
      error: 'connection closed',
    },
  ]
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  await reads.get(StatusAction.extension, StatusAction.name, null, ROOT).refetch()
  const container = renderSolid(() => <Chip />)
  await settle()
  flush()

  const chip = agent.snapshot().find((item) => item.label === 'MCP servers')
  expect(
    await agent.act({ steps: [{ ref: chip!.ref, action: 'setOpen', args: [true] }] }),
  ).toMatchObject({ ok: true })
  expect(container.querySelector('[data-mcp-server="example"]')?.getAttribute('data-state')).toBe(
    'failed',
  )
  const reconnect = agent.snapshot().find((item) => item.label === 'Reconnect example')
  expect(await agent.act({ steps: [{ ref: reconnect!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(harness.requests).toContainEqual({
    name: 'reconnect',
    args: { name: 'example' },
    source: 'agent',
  })
  expect(container.querySelector('[data-mcp-server="example"]')?.getAttribute('data-state')).toBe(
    'connected',
  )
})

it('polls every 2 s while a server connects, then every minute', async ({ onTestFinished }) => {
  vi.useFakeTimers()
  onTestFinished(() => {
    store.stop()
    vi.useRealTimers()
  })
  harness.servers = [{ name: 'example', source: 'user', state: 'connecting', transport: 'stdio' }]
  store.start()
  harness.sources[0].open()
  await reads.get(StatusAction.extension, StatusAction.name, null, ROOT).refetch()
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
