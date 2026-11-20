/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => {
  const endpoint = 'https://push.example.test/device'
  const unsubscribe = vi.fn<() => Promise<boolean>>(async () => true)
  const subscription = { endpoint, unsubscribe, toJSON: () => ({ endpoint }) }
  const pushManager = { getSubscription: async () => subscription }
  class Registration {
    get pushManager() {
      return pushManager
    }
    async getNotifications() {
      return []
    }
  }
  vi.stubGlobal('ServiceWorkerRegistration', Registration)
  vi.stubGlobal('Notification', { permission: 'granted' })
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: Object.assign(new EventTarget(), { register: async () => new Registration() }),
  })
  return {
    endpoint,
    unsubscribe,
    sources: [] as FakeSource[],
    actions: [] as { name: string; args: unknown; source: string | null }[],
  }
})
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const server = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const action = /^\/api\/extensions\/push\/actions\/(\w+)$/.exec(path)
    if (!action) return server.handle(path, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init!.body as string) as { args: unknown }
    const source = new Headers(init!.headers).get('x-ultimate-source')
    harness.actions.push({ name: action[1], args, source })
    return Response.json({ result: null })
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
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { Bell, Pusher } from '../../notifications.solid.tsx'

const agent = createAgent()
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

async function act(step: Parameters<typeof agent.act>[0]['steps'][number]) {
  const result = agent.act({ steps: [step] })
  await vi.advanceTimersByTimeAsync(100)
  flush()
  return result
}

it('lets an agent open notifications and unsubscribe this device', async ({ onTestFinished }) => {
  const { endpoint, unsubscribe } = harness
  vi.useFakeTimers()
  store.start()
  harness.sources[0].open()
  const container = renderSolid(() => (
    <>
      <Pusher />
      <Bell />
    </>
  ))
  await vi.advanceTimersByTimeAsync(10)
  flush()

  expect(container.querySelector('button[aria-label="Notifications"]')?.textContent).toBe('notify')
  const trigger = agent.snapshot().find((entry) => entry.label === 'Notifications')
  expect(trigger).toMatchObject({ component: 'popover', open: false })
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  expect(await act({ ref: trigger!.ref, action: 'setOpen', args: [true] })).toMatchObject({
    ok: true,
  })
  const toggle = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Notifications on this device')
  expect(toggle).toMatchObject({ component: 'switch', checked: true })
  expect(await act({ ref: toggle!.ref, action: 'setChecked', args: [false] })).toMatchObject({
    ok: true,
  })
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(harness.actions).toContainEqual({
    name: 'unsubscribe',
    args: { endpoint },
    source: 'agent',
  })
  expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Notifications on this device',
      key: 'checked',
      value: false,
      source: 'agent',
    }),
  )
})
