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
    if (match[1] === 'set' && args)
      harness.models = args.on
        ? [...harness.models, args.model]
        : harness.models.filter((model) => model !== args.model)
    return Response.json({ result: { models: harness.models, project: false } })
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

import { store } from '../../../../web/src/sdk/client.ts'
import { FastToggle } from '../../toggle.solid.tsx'

const view = (provider: string) =>
  ({
    conversation: { id: 1 },
    entries: [],
    docs: { 'pi.agent': { model: { provider, modelId: 'gpt-test' } } },
  }) as unknown as StreamedView

const agent = createAgent()
beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  harness.requests.length = 0
  harness.models = []
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
  expect(await agent.act({ steps: [{ ref: toggle!.ref, action: 'press' }] })).toMatchObject({
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

it('shows nothing for a model without a fast tier', async () => {
  harness.server!.of()!.send('view', view('anthropic'))
  const container = renderSolid(() => <FastToggle />)
  await settle()
  flush()
  expect(container.querySelector('[aria-label="Fast mode"]')).toBeNull()
})
