import { settle } from '@ui-sdk/core/testing'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ROOT } from '@/sdk/solid'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { registry, store } from '../../../../web/src/sdk/client.ts'
import { provide } from '../../../../web/src/sdk/types.ts'
import { MessagesDoc } from '../../../messages/refs.ts'
import type { InboxItem } from '../../points.web.ts'
import { InboxItems } from '../../points.web.ts'
import { AppBadge } from '../../surface.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { FakeSource, answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const fetch = answerReadsWith(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      harness.server?.handle(input as string, init) ?? Response.json({ ok: true }),
  )
  return {
    store: createStore({
      eventSource: (url) => {
        const stream = new FakeSource(url)
        harness.sources.push(stream)
        return stream
      },
      fetch,
    }),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
  }
})

harness.server = fakeSubscriptions(harness.sources)

it('shows the waiting count on the app icon once it has loaded, and clears it at zero', async ({
  onTestFinished,
}) => {
  const setAppBadge = vi.fn<Navigator['setAppBadge']>(async () => {})
  const clearAppBadge = vi.fn<Navigator['clearAppBadge']>(async () => {})
  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), { setAppBadge, clearAppBadge }),
  )
  store.start()
  onTestFinished(() => {
    store.stop()
    vi.unstubAllGlobals()
  })
  harness.sources[0].open()
  const item = (key: string): InboxItem => ({ key, at: 1, tag: 'task', title: key, pane: null })
  const [items, setItems] = createSignal([item('a:1'), item('a:2')])
  await registry.setLoaders({
    'extensions/provider/web.solid.tsx': async () => ({
      default: { provides: [provide(InboxItems, () => items)] },
    }),
  })
  renderSolid(() => <AppBadge />)
  flush()
  await settle()
  expect(setAppBadge).not.toHaveBeenCalled()
  expect(clearAppBadge).not.toHaveBeenCalled()

  harness
    .server!.of(ROOT)!
    .send('doc', { kind: MessagesDoc.kind, value: { messages: [], next: 1 } })
  flush()
  await settle()
  expect(setAppBadge).toHaveBeenLastCalledWith(2)

  setItems([])
  flush()
  await settle()
  expect(clearAppBadge).toHaveBeenCalledOnce()
})
