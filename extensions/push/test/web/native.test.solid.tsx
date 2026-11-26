import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => {
  const subscription = {
    endpoint: 'https://ntfy.example.test/upAbc?up=1',
    keys: { p256dh: 'p256', auth: 'auth' },
  }
  const calls: { call: string; args?: unknown }[] = []
  const listeners: ((event: { data: string }) => void)[] = []
  const answers: Record<string, unknown> = {
    info: { version: 1, app: '0.1.0', capabilities: ['push', 'share', 'theme'] },
    pushSubscription: null,
    pushSubscribe: subscription,
    pushUnsubscribe: null,
    closeNotifications: null,
  }
  vi.stubGlobal('UltimateNative', {
    postMessage(message: string) {
      const { id, call, args } = JSON.parse(message) as { id: number; call: string; args?: unknown }
      calls.push({ call, args })
      const data = JSON.stringify({ id, result: answers[call] })
      queueMicrotask(() => {
        for (const listener of listeners) listener({ data })
      })
    },
    addEventListener: (_: string, listener: (event: { data: string }) => void) =>
      listeners.push(listener),
  })
  return {
    subscription,
    calls,
    sources: [] as FakeSource[],
    actions: [] as { name: string; args: unknown }[],
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
    harness.actions.push({ name: action[1], args })
    return Response.json({ result: action[1] === 'key' ? { key: 'vapid-key' } : null })
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

it('subscribes through the native app where the WebView has no Push API', async () => {
  vi.useFakeTimers()
  store.start()
  harness.sources[0].open()
  renderSolid(() => (
    <>
      <Pusher />
      <Bell />
    </>
  ))
  await vi.advanceTimersByTimeAsync(10)
  flush()

  const trigger = agent.snapshot().find((entry) => entry.label === 'Notifications')
  await act({ ref: trigger!.ref, action: 'setOpen', args: [true] })
  const toggle = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Notifications on this device')
  expect(toggle).toMatchObject({ component: 'switch', checked: false })
  expect(await act({ ref: toggle!.ref, action: 'setChecked', args: [true] })).toMatchObject({
    ok: true,
  })

  expect(harness.calls).toContainEqual({ call: 'pushSubscribe', args: { key: 'vapid-key' } })
  expect(harness.actions).toContainEqual({
    name: 'subscribe',
    args: { subscription: { ...harness.subscription, origin: location.origin } },
  })
  expect(
    agent.snapshot().find((entry) => entry.label === 'Notifications on this device'),
  ).toMatchObject({ checked: true })
})
