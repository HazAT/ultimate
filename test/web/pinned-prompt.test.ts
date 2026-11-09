import { createElement as h } from 'react'
import type { EffectCallback } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  effects: [] as EffectCallback[],
  fetch: vi.fn<typeof fetch>(),
}))
// As in conversation-scope.test.ts: server rendering with captured effects and direct external-store snapshots.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => harness.effects.push(effect),
}))
vi.mock('use-stick-to-bottom', async (original) => ({
  ...(await original<typeof import('use-stick-to-bottom')>()),
  useStickToBottomContext: () => ({
    scrollRef: { current: null },
    contentRef: { current: null },
    isAtBottom: true,
  }),
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const { FakeSource } = await import('./fake-source.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: harness.fetch,
    retryMs: 5,
  })
  const api = createApi(store, { fetch: harness.fetch })
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false }))

import { store, uiState } from '../../web/src/sdk/client.ts'
import { PinnedPrompt } from '../../extensions/context/pinned.tsx'

const server = fakeSubscriptions(harness.sources)
const effects: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  harness.fetch.mockReset()
  harness.fetch.mockImplementation(
    async (url, init) =>
      server.handle(url as string, init) ??
      Response.json({ result: { prompt: { sections: [], tools: [] }, at: 70 } }),
  )
  harness.sources.length = 0
  server.subscriptions.length = 0
  harness.effects.length = 0
  store.show(undefined)
  store.start()
  harness.sources[0].open()
})
afterEach(() => {
  for (const release of effects.splice(0)) release()
  store.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function render() {
  renderToStaticMarkup(h(PinnedPrompt))
  for (const effect of harness.effects.splice(0)) {
    const release = effect()
    if (release) effects.push(release)
  }
  await vi.advanceTimersByTimeAsync(10)
}
/** Every distinct `context/currentPrompt` request so far. */
const prompts = () => [
  ...new Set(
    harness.fetch.mock.calls.flatMap(([url, init]) =>
      (url as string).endsWith('/context/actions/currentPrompt') ? [init?.body as string] : [],
    ),
  ),
]
const view = (id: number) =>
  ({
    conversation: { id },
    entries: [{ id: 70, conversationId: id, kind: 'pi.system', model: [] }],
    docs: {},
  }) as unknown as StreamedView

it('asks for the prompt only once the conversation is known, against its own baseline', async () => {
  // As found on a host: a baseline from another conversation, stored while one was still loading.
  uiState.set('context.seen.undefined', 50)
  uiState.set('context.seen.7', 70)
  store.show(7)
  await render()
  // Asking now would send entry 50 to conversation 7: "Entry 50 is not visible from conversation 7".
  expect(prompts()).toEqual([])
  server.of(7)!.send('view', view(7))
  await render()
  expect(prompts()).toEqual([JSON.stringify({ args: { since: 70 }, conversationId: 7 })])
})
