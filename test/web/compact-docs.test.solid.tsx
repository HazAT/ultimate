import { createMemo, createRoot, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: async (path, init) =>
      harness.server?.handle(path as string, init) ?? Response.json({ ok: true }),
  })
  return {
    store,
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
    reportCompact: () => {},
  }
})

import { registry, store } from '../../web/src/sdk/client.ts'
import { ROOT, docRef, useCompact, useDocOf } from '../../web/src/sdk/solid.ts'

harness.server = fakeSubscriptions(harness.sources)
const tick = () => vi.advanceTimersByTimeAsync(10)
let dispose = () => {}
beforeEach(async () => {
  vi.useFakeTimers()
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  dispose()
  flush()
  store.stop()
  vi.useRealTimers()
})

it('folds again only when a root document it declared changes, not when another root document does', async () => {
  await registry.setLoaders({
    '/extensions/folding/web.solid.tsx': async () => ({
      default: { compact: { when: () => true, docs: ['board'], tools: ['message'] } },
    }),
  })
  harness.sources[0].send('conversations', [{ id: 7, title: 'shown' }] as never)
  const real = store.getState
  vi.spyOn(store, 'getState').mockImplementation(() => ({
    ...real(),
    view: { conversation: { id: 7 }, entries: [], docs: {} } as never,
  }))
  let folds = 0
  const compact = createRoot((done) => {
    dispose = done
    useDocOf(() => ROOT, docRef('phases'))
    const value = useCompact()
    return createMemo(() => (folds++, value()))
  })
  flush()
  await tick()
  const root = harness.server!.of(1)!
  root.send('doc', { kind: 'board', value: { messages: [] } })
  root.send('doc', { kind: 'phases', value: { busy: [] } })
  flush()
  expect(compact()).toBeDefined()
  const settled = folds

  root.send('docOps', { kind: 'phases', ops: [['s', ['busy'], [7]]] })
  flush()
  expect(folds).toBe(settled)

  root.send('docOps', { kind: 'board', ops: [['s', ['messages'], [{ id: 1 }]]] })
  flush()
  expect(folds).toBe(settled + 1)
})
