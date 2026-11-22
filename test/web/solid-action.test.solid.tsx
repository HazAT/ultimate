import { createSignal, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { actionRef } from '../../shared/extension-api.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  calls: [] as unknown[],
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path !== '/api/extensions/test/actions/echo')
      return harness.server?.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: { name: string } }
    harness.calls.push(args)
    return Response.json({ result: `hello ${args.name}` })
  }
  const { answerReadsWith } = await import('./fake-source.ts')
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

import { reads, store } from '../../web/src/sdk/client.ts'
import { ROOT, useAction } from '../../web/src/sdk/solid.ts'

const Echo = actionRef<{ name: string }, string>('test', 'echo')

harness.server = fakeSubscriptions(harness.sources)
beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  harness.calls.length = 0
  store.start()
  harness.sources[0].open()
  await vi.advanceTimersByTimeAsync(10)
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

it('shows the new read’s cached data at once when its args switch to an already-warm read', async () => {
  const warm = reads.get('test', 'echo', { name: 'bob' }, ROOT)
  const release = warm.use({})
  await vi.advanceTimersByTimeAsync(10)
  expect(warm.get().data).toBe('hello bob')

  const [name, setName] = createSignal('ada')
  function Greeting() {
    const action = useAction(Echo, {
      get name() {
        return name()
      },
    })
    return <output>{action.data() ?? 'none'}</output>
  }
  const container = renderSolid(() => <Greeting />)
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(container.textContent).toBe('hello ada')

  setName('bob')
  flush()
  expect(container.textContent).toBe('hello bob')

  setName('cy')
  flush()
  setName('ada')
  flush()
  expect(container.textContent).toBe('hello ada')
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(container.textContent).toBe('hello ada')
  release()
})

it('subscribes a read with the args of its key, and never a read its args left before it went', async () => {
  const [name, setName] = createSignal('dee')
  function Greeting() {
    const action = useAction(Echo, {
      get name() {
        return name()
      },
    })
    return <output>{action.data() ?? 'none'}</output>
  }
  renderSolid(() => <Greeting />)
  flush()
  setName('eve')
  flush()
  await vi.advanceTimersByTimeAsync(10)
  expect(reads.get('test', 'echo', { name: 'eve' }, ROOT).get().data).toBe('hello eve')
  expect(harness.calls).toEqual([{ name: 'eve' }])
})
