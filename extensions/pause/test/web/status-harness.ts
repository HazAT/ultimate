import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import type { PauseState } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  actions: [] as { name: string; args: unknown; source: string | null }[],
  state: { paused: false, autoPlay: 30, running: [] } as PauseState,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const action = /^\/api\/extensions\/pause\/actions\/(\w+)$/.exec(path)
    if (!action) return harness.server?.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    const source = new Headers(init?.headers).get('x-ultimate-source')
    harness.actions.push({ name: action[1], args, source })
    if (action[1] !== 'state') {
      if (action[1] === 'autoPlay') {
        harness.state.autoPlay = (args as { minutes: number | null }).minutes ?? undefined
      } else {
        harness.state.paused = action[1] === 'pause'
      }
      updateDoc()
    }
    return Response.json({ result: harness.state })
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
  return {
    store,
    api,
    reads: createReads(api, store),
    uiState: createUiState(undefined),
    registry: createRegistry(),
  }
})

import { ROOT } from '../../../../web/src/sdk/api.ts'
import { reads, store } from '../../../../web/src/sdk/client.ts'
import { PauseDoc, StateAction } from '../../refs.ts'

export const approval = { given: true }
export const agent = createAgent({ allow: (step) => !step.confirm || approval.given })
export const actions = harness.actions
export const state = () => harness.state
export const server = () => harness.server!
export const stream = () => harness.sources.at(-1)!
harness.server = fakeSubscriptions(harness.sources)
const updateDoc = () => {
  const { paused, autoPlay } = harness.state
  harness.server!.of(1)?.send('doc', {
    kind: PauseDoc.kind,
    value: { paused, ...(autoPlay === undefined ? {} : { autoPlay }) },
  })
}
export function pause() {
  harness.state.paused = true
  updateDoc()
}
export const tick = async (ms = 10) => {
  await vi.advanceTimersByTimeAsync(ms)
  flush()
}
export function refetchState() {
  return reads.get(StateAction.extension, StateAction.name, null, ROOT).refetch()
}
export async function act(label: string, action: string, args?: unknown[], ok = true) {
  const result = agent.act({ steps: [{ ref: label, action, args }] })
  await tick(100)
  expect(await result).toMatchObject({ ok })
}

beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  harness.actions.length = 0
  approval.given = true
  harness.state = { paused: false, autoPlay: 30, running: [] }
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})
