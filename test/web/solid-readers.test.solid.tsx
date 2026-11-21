/** @jsxImportSource @solidjs/web */
import { createSignal, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SystemInfo } from '../../shared/protocol.ts'
import { defineEvent } from '../../shared/events.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  restart: undefined as Response | Promise<Response> | undefined,
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/restart') return await harness.restart!
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
  return {
    store,
    api,
    reads: createReads(api, store),
    uiState: createUiState(undefined),
    registry: createRegistry(),
  }
})

import { store } from '../../web/src/sdk/client.ts'
import { events, useCopy, useEvent, useEvents, useRestart } from '../../web/src/sdk/solid.ts'

const system = (generation: number, booted = 0) =>
  ({ process: { pid: 7, generation, booted } }) as unknown as SystemInfo

harness.server = fakeSubscriptions(harness.sources)
beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  store.start()
  harness.sources[0].open()
  harness.sources[0].send('system', system(1))
  await vi.advanceTimersByTimeAsync(10)
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

function mountRestart() {
  let restart!: ReturnType<typeof useRestart>
  renderSolid(() => {
    restart = useRestart(5_000)
    return null
  })
  return restart
}

it('restarts until the new generation serves', async () => {
  harness.restart = Response.json({ generation: 2 })
  const restart = mountRestart()
  restart.run()
  flush()
  expect(restart.busy()).toBe(true)
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(restart.pending()).toBe(2)

  harness.sources[0].send('system', system(2))
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect([restart.busy(), restart.pending(), restart.error()]).toEqual([
    false,
    undefined,
    undefined,
  ])
})

it('finishes when the new generation serves before the restart request answers', async () => {
  let answer!: (response: Response) => void
  harness.restart = new Promise<Response>((resolve) => (answer = resolve))
  const restart = mountRestart()
  restart.run()
  harness.sources[0].send('system', system(2))
  await vi.advanceTimersByTimeAsync(10)
  answer(Response.json({ generation: 2 }))
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect([restart.busy(), restart.error()]).toEqual([false, undefined])
})

it('reports a rollback when the stream comes back on the old generation', async () => {
  harness.restart = Response.json({ generation: 2 })
  const restart = mountRestart()
  restart.run()
  await vi.advanceTimersByTimeAsync(10)
  flush()
  harness.sources[0].drop()
  await vi.advanceTimersByTimeAsync(10)
  flush()
  harness.sources[0].open()
  harness.sources[0].send('system', system(1, 1))
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(restart.busy()).toBe(false)
  expect(restart.error()).toMatch(/Generation 2 failed to activate and was rolled back/)
})

it('gives up when the new generation never serves', async () => {
  harness.restart = Response.json({ generation: 2 })
  const restart = mountRestart()
  restart.run()
  await vi.advanceTimersByTimeAsync(4_000)
  harness.sources[0].send('system', system(1, 2))
  await vi.advanceTimersByTimeAsync(1_100)
  flush()
  expect(restart.error()).toBe('Generation 2 did not start serving within 5 s.')
})

it('reads the newest events of the kinds asked for, newest first, following the options', async () => {
  const Wanted = defineEvent<{ n: number }>('test.wanted')
  const [limit, setLimit] = createSignal(2)
  let latest!: ReturnType<typeof useEvents<typeof Wanted>>
  renderSolid(() => {
    latest = useEvents({
      events: [Wanted],
      get limit() {
        return limit()
      },
    })
    return null
  })
  await vi.advanceTimersByTimeAsync(10)
  const record = (kind: string, n: number) => ({ id: `e${n}`, kind, at: '', data: { n } })
  harness.server!.of(1)!.send('doc', {
    kind: 'ultimate.event-feed',
    value: {
      events: [
        record('event.test.wanted', 1),
        record('other', 2),
        record('event.test.wanted', 3),
        record('event.test.wanted', 4),
      ],
    },
  })
  await vi.advanceTimersByTimeAsync(10)
  flush()
  expect(latest()?.map((event) => event.data.n)).toEqual([4, 3])
  setLimit(3)
  flush()
  expect(latest()?.map((event) => event.data.n)).toEqual([4, 3, 1])
})

it('hears bus events while mounted', () => {
  const heard: unknown[] = []
  renderSolid(() => {
    useEvent('test:ping', (data) => heard.push(data))
    return null
  })
  flush()
  events.emit('test:ping', 1)
  expect(heard).toEqual([1])
})

it('marks a copy for a moment', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
  Object.assign(navigator, { clipboard: { writeText } })
  let copy!: ReturnType<typeof useCopy>
  renderSolid(() => {
    copy = useCopy()
    return null
  })
  flush()
  await copy.copy('hello')
  flush()
  expect([writeText.mock.calls[0], copy.copied()]).toEqual([['hello'], true])
  await vi.advanceTimersByTimeAsync(1_300)
  flush()
  expect(copy.copied()).toBe(false)
})
