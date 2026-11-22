/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  requests: [] as { name: string; body: unknown; source: string | null }[],
  models: [] as string[],
  write: undefined as Promise<Response> | undefined,
  refresh: undefined as Promise<Response> | undefined,
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
    const match = /^\/api\/extensions\/fast\/actions\/(\w+)$/.exec(input as string)
    if (!match) return subscriptions.handle(input as string, init) ?? Response.json({ ok: true })
    const { args } = JSON.parse(init?.body as string) as {
      args: { model: string; on: boolean } | null
    }
    harness.requests.push({
      name: match[1],
      body: args,
      source: new Headers(init?.headers).get('x-ultimate-source'),
    })
    if (match[1] === 'status' && harness.refresh) return harness.refresh
    if (match[1] === 'set' && harness.write) return harness.write
    if (match[1] === 'set' && args)
      harness.models = args.on
        ? [...harness.models, args.model]
        : harness.models.filter((model) => model !== args.model)
    return Response.json({ result: { models: harness.models, project: false } })
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

import { store } from '../../../../web/src/sdk/client.ts'
import { FastToggle } from '../../toggle.solid.tsx'

const view = (provider: string, modelId = 'gpt-test') =>
  ({
    conversation: { id: 1 },
    entries: [],
    docs: { 'pi.agent': { model: { provider, modelId } } },
  }) as unknown as StreamedView

const agent = createAgent()
beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  harness.requests.length = 0
  harness.models = []
  harness.write = undefined
  harness.refresh = undefined
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
})

it('lets an agent turn fast mode on for the shown OpenAI model', async () => {
  harness.server!.of()!.send('view', view('openai-codex'))
  const container = renderSolid(() => <FastToggle />)
  await settle()
  flush()

  const toggle = agent.snapshot().find((item) => item.label === 'Fast mode')
  expect(container.querySelector('[aria-label="Fast mode"]')?.getAttribute('aria-pressed')).toBe(
    'false',
  )
  expect(toggle).toMatchObject({ component: 'toggle', pressed: false })
  expect(
    await agent.act({ steps: [{ ref: toggle!.ref, action: 'setPressed', args: [true] }] }),
  ).toMatchObject({
    ok: true,
  })
  await settle()
  flush()
  expect(harness.requests).toContainEqual({
    name: 'set',
    body: { model: 'openai-codex/gpt-test', on: true },
    source: 'agent',
  })
  expect(container.querySelector('[aria-label="Fast mode"]')?.getAttribute('aria-pressed')).toBe(
    'true',
  )
})

it('holds the stored Fast state while a write is pending and shows its rejection', async () => {
  const pending = Promise.withResolvers<Response>()
  harness.write = pending.promise
  harness.server!.of()!.send('view', view('openai-codex', 'gpt-pending'))
  const page = renderSolid(() => <FastToggle />)
  await settle()
  const toggle = () =>
    agent
      .snapshot()
      .find(
        (entry) => !entry.offPage && entry.component === 'toggle' && entry.label === 'Fast mode',
      )!
  const step = { ref: toggle().ref, action: 'setPressed', args: [true] }
  expect((await agent.act({ steps: [step] })).ok).toBe(true)
  flush()
  const button = page.querySelector('[aria-label="Fast mode"]')!
  expect(button.hasAttribute('data-pending')).toBe(true)
  expect(toggle()).toMatchObject({ pressed: false, disabled: true })
  expect((await agent.act({ steps: [step] })).ok).toBe(false)
  expect(harness.requests.filter((call) => call.name === 'set')).toHaveLength(1)
  pending.resolve(Response.json({ error: 'Settings are read-only' }, { status: 500 }))
  await settle()
  flush()
  expect(button.hasAttribute('data-pending')).toBe(false)
  expect(toggle().pressed).toBe(false)
  expect(page.textContent).toContain('Settings are read-only')
})

it('blocks another Fast write until the saved status has been read back', async () => {
  harness.server!.of()!.send('view', view('openai-codex', 'gpt-refresh'))
  renderSolid(() => <FastToggle />)
  await settle()
  const toggle = () =>
    agent
      .snapshot()
      .find(
        (entry) => !entry.offPage && entry.component === 'toggle' && entry.label === 'Fast mode',
      )!
  expect(toggle().pressed).toBe(false)
  const refresh = Promise.withResolvers<Response>()
  harness.refresh = refresh.promise
  const before = harness.requests.filter((call) => call.name === 'status').length
  const step = { ref: toggle().ref, action: 'setPressed', args: [true] }
  expect((await agent.act({ steps: [step] })).ok).toBe(true)
  flush()
  expect(harness.requests.filter((call) => call.name === 'status')).toHaveLength(before + 1)
  expect(toggle()).toMatchObject({ pressed: false, disabled: true })
  expect((await agent.act({ steps: [step] })).ok).toBe(false)
  const second = renderSolid(() => <FastToggle />)
  await settle()
  flush()
  expect(second.querySelector('[aria-label="Fast mode"]')?.getAttribute('aria-disabled')).toBe(
    'true',
  )
  expect(harness.requests.filter((call) => call.name === 'set')).toHaveLength(1)
  refresh.resolve(Response.json({ result: { models: harness.models, project: false } }))
  await settle()
  flush()
  expect(toggle().pressed).toBe(true)
  expect(toggle().disabled).not.toBe(true)
  expect(second.querySelector('[aria-label="Fast mode"]')?.hasAttribute('aria-disabled')).toBe(
    false,
  )
})

it('shows nothing for a model without a fast tier', async () => {
  harness.server!.of()!.send('view', view('anthropic'))
  const container = renderSolid(() => <FastToggle />)
  await settle()
  flush()
  expect(container.querySelector('[aria-label="Fast mode"]')).toBeNull()
})
