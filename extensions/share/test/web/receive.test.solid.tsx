/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  actions: [] as string[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const action = /^\/api\/extensions\/(\w+\/actions\/\w+)$/.exec(input as string)
    if (!action) return subscriptions.handle(input as string, init) ?? Response.json({ ok: true })
    harness.actions.push(action[1])
    return Response.json({ result: 99 })
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

import { getDraft } from '../../../../web/src/app/drafts.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import { ShareTarget } from '../../receive.solid.tsx'

const shared = new Map<string, Response>([
  ['/share/s1', Response.json({ title: '', text: 'Look at this', url: '', files: [] })],
])
const cache = { read: Promise.resolve() }
beforeEach(({ onTestFinished }) => {
  cache.read = Promise.resolve()
  harness.sources.length = 0
  harness.actions.length = 0
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (key: string) => {
        await cache.read
        return shared.get(key)?.clone()
      },
      delete: async () => true,
    }),
  })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  history.replaceState(null, '', '/?share=s1')
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
})

it('shares into the existing @ultimate once its id arrives, without reconfiguring it', async () => {
  renderSolid(() => <ShareTarget />)
  await settle()
  flush()
  expect(location.search).toBe('')
  expect(harness.actions).toEqual([])

  harness.server!.of(1)!.send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: 7 } })
  await settle()
  flush()
  expect(getDraft(7).get().text).toBe('Look at this')
  expect(harness.actions).toEqual([])
})

it('uses an @ultimate created while the shared content was still being read', async () => {
  let release = () => {}
  cache.read = new Promise((resolve) => (release = resolve))
  getDraft(8).set({ text: '', revision: 0 })
  renderSolid(() => <ShareTarget />)
  await settle()
  flush()
  harness.server!.of(1)!.send('doc', { kind: 'ultimate.standing-agents', value: {} })
  await settle()
  harness.server!.of(1)!.send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: 8 } })
  await settle()
  release()
  await settle()
  flush()
  expect(getDraft(8).get().text).toBe('Look at this')
  expect(harness.actions).toEqual([])
})
