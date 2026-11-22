import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { Status } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  requests: [] as { name: string; source: string | null }[],
  status: { state: 'not-running', allow: [] } as Status,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const match = /^\/api\/extensions\/tailscale\/actions\/(\w+)$/.exec(input as string)
    if (!match) return subscriptions.handle(input as string, init) ?? Response.json({ ok: true })
    harness.requests.push({
      name: match[1],
      source: new Headers(init?.headers).get('x-ultimate-source'),
    })
    if (match[1] === 'retry')
      harness.status = {
        state: 'ready',
        allow: ['owner@example.test'],
        url: 'https://device.example.test',
      }
    return Response.json({ result: harness.status })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch: pageFetch,
  })
  const api = createApi(store, { fetch: pageFetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { ROOT } from '../../../../web/src/sdk/api.ts'
import { reads, store } from '../../../../web/src/sdk/client.ts'
import { events } from '../../../../web/src/sdk/events.ts'
import { Chip } from '../../chip.solid.tsx'

const agent = createAgent()
beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  harness.requests.length = 0
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
})

it('lets an agent check Tailscale again and shows the ready link and QR code', async () => {
  harness.status = { state: 'not-running', allow: [] }
  const container = renderSolid(() => <Chip />)
  await settle()
  flush()

  const chip = agent.snapshot().find((item) => !item.offPage && item.component === 'popover')
  expect(chip?.label).toMatch(/tailnet/i)
  expect(
    await agent.act({ steps: [{ ref: chip!.ref, action: 'setOpen', args: [true] }] }),
  ).toMatchObject({ ok: true })
  expect(container.textContent).toContain('Tailscale is not running')
  const retry = agent.snapshot().find((item) => item.label === 'Check again')
  expect(await agent.act({ steps: [{ ref: retry!.ref, action: 'press' }] })).toMatchObject({
    ok: true,
  })
  expect(harness.requests).toContainEqual({ name: 'retry', source: 'agent' })
  expect(container.querySelector('[data-tailnet]')?.getAttribute('data-tailnet')).toBe('ready')
  expect(
    container.querySelector('svg[aria-label="QR code for https://device.example.test"] path'),
  ).not.toBeNull()
  expect(container.querySelector('a[href="https://device.example.test"]')?.textContent).toContain(
    'Open',
  )
})

it('opens from the Tailscale command when the chip is hidden', async () => {
  harness.status = { state: 'disabled', allow: [] }
  await reads.get('tailscale', 'status', null, ROOT).refetch()
  const container = renderSolid(() => <Chip />)
  await settle()
  flush()
  expect(container.querySelector('[data-tailnet]')).toBeNull()

  events.emit('tailscale:open', undefined)
  flush()
  await settle()
  expect(
    container.querySelector('[data-slot="popover-content"][data-open]')?.textContent,
  ).toContain('off')
})
