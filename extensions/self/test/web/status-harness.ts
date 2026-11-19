import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import type { SystemInfo } from '../../../../shared/protocol.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  restart: vi.fn<(source: string | null) => Response>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    input === '/api/restart'
      ? harness.restart(new Headers(init?.headers).get('x-ultimate-source'))
      : (harness.server?.handle(input as string, init) ?? Response.json({ ok: true }))
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  return {
    store,
    api: createApi(store, { fetch }),
    uiState: createUiState(undefined),
    registry: createRegistry(),
    bundle: 'browser-build',
    switched: undefined,
  }
})

import { store } from '../../../../web/src/sdk/client.ts'

export const approval = { given: true }
export const agent = createAgent({ allow: (step) => !step.confirm || approval.given })
export const restart = harness.restart
harness.server = fakeSubscriptions(harness.sources)
export const tick = async (ms = 10) => {
  await vi.advanceTimersByTimeAsync(ms)
  flush()
}
export function system(web: Partial<SystemInfo['web']> = {}, id = 'abc1234new', coreStale = false) {
  harness.sources[0].send('system', {
    code: { coreStale },
    process: { generation: 3 },
    web: { id: 'browser-build', changed: [], ...web },
    build: {
      id,
      generation: 3,
      core: 'core-long-hash',
      extensions: { self: 'self-long-hash' },
      history: [],
    },
  } as unknown as SystemInfo)
  flush()
}
export async function act(label: string, action: string, args?: unknown[], ok = true) {
  const entry = agent
    .snapshot()
    .find((item) => item.label === label && item.actions.includes(action))
  expect(entry).toBeDefined()
  const result = agent.act({ steps: [{ ref: entry!.ref, action, args }] })
  await tick(100)
  expect(await result).toMatchObject({ ok })
}

beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  approval.given = true
  harness.restart.mockReset()
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})
