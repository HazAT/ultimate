import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { parseConversationId } from '../../../../lib/ids.shared.ts'
import type { ConfigureRequest, ModelsResponse, StreamedView } from '../../../../shared/protocol.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  fetch: vi.fn<typeof fetch>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: harness.fetch,
  })
  const api = createApi(store, { fetch: harness.fetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

import { actions, currentContext } from '../../../../web/src/sdk/actions.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import { ConversationScope } from '../../../../web/src/sdk/solid.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { LoginDialog } from '../../login.solid.tsx'
import { ModelPicker } from '../../picker.solid.tsx'
import { ModelControl, PickControl } from '../../toolbar.solid.tsx'
import { openLogin } from '../../state.web.ts'
import models from '../../web.solid.tsx'

const agent = createAgent()
const server = fakeSubscriptions(harness.sources)
const side = parseConversationId(17)
const catalog: ModelsResponse = {
  providers: [
    {
      id: 'faux',
      name: 'Faux',
      authTypes: [{ type: 'api_key', name: 'Faux credentials' }],
      status: { configured: true, source: 'stored' },
      isUsingSubscription: false,
    },
  ],
  models: ['atlas', 'orion'].map((id) => ({
    provider: 'faux',
    id,
    name: id,
    contextWindow: 1000,
    maxTokens: 100,
    available: true,
    reasoning: true,
    thinkingLevels: ['off', 'low', 'high'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
}

function view(id: number, modelId: string, thinkingLevel: string): StreamedView {
  return {
    conversation: { id },
    entries: [],
    docs: { 'pi.agent': { model: { provider: 'faux', modelId }, thinkingLevel } },
  } as unknown as StreamedView
}

async function sync() {
  await vi.advanceTimersByTimeAsync(25)
  flush()
}

beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  server.subscriptions.length = 0
  harness.fetch.mockReset()
  harness.fetch.mockImplementation(async (url, init) => {
    const path = url as string
    const subscription = server.handle(path, init)
    if (subscription) return subscription
    if (path === '/api/models') return Response.json(catalog)
    if (path.endsWith('/families'))
      return Response.json({
        result: {
          families: [{ name: 'Review', model: 'faux/atlas', thinking: 'high', color: 'blue' }],
        },
      })
    if (path.endsWith('/login')) return Response.json({ result: { flowId: 'flow-1' } })
    return Response.json({ result: null })
  })
  store.setUi({ dialogs: {} })
  store.show(undefined)
  store.start()
  harness.sources[0].open()
  await store.refreshModels()
  await sync()
  server.of()!.send('view', view(1, 'atlas', 'off'))
  await sync()
})

afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

function refFor(label: string) {
  const entry = agent.snapshot().find((item) => !item.offPage && item.label === label)
  expect(entry).toBeDefined()
  return entry!.ref
}

async function act(label: string, action: string, ...args: unknown[]) {
  const result = agent.act({ steps: [{ ref: refFor(label), action, args }] })
  await vi.advanceTimersByTimeAsync(200)
  flush()
  return result
}

const writes = () =>
  harness.fetch.mock.calls.flatMap(([url, init]) => {
    const path = url as string
    if (!/\/(configure|setFamily|login|answer|cancel)$/.test(path)) return []
    return [
      {
        path,
        body: JSON.parse(init!.body as string) as unknown,
        source: new Headers(init!.headers).get('x-ultimate-source'),
      },
    ]
  })

it('keeps the picked effort pending across closing the popover, then shows its failure', async () => {
  const pending = Promise.withResolvers<Response>()
  const respond = harness.fetch.getMockImplementation()!
  harness.fetch.mockImplementation((url, init) =>
    typeof url === 'string' && url.endsWith('/configure') ? pending.promise : respond(url, init),
  )
  const page = renderSolid(() => <ModelControl />)
  await sync()
  expect(await act('Model and thinking', 'setOpen', true)).toMatchObject({ ok: true })
  const level = (name: string) =>
    page.querySelector<HTMLButtonElement>(`[aria-label="${name} effort"]`)!
  expect(level('off').hasAttribute('data-checked')).toBe(true)
  level('high').click()
  await sync()
  expect(await act('Model and thinking', 'setOpen', false)).toMatchObject({ ok: true })
  expect(await act('Model and thinking', 'setOpen', true)).toMatchObject({ ok: true })
  expect(level('low').hasAttribute('data-disabled')).toBe(true)
  level('low').click()
  await sync()
  expect(writes()).toEqual([
    { path: '/api/conversations/1/configure', body: { thinkingLevel: 'high' }, source: 'person' },
  ])
  pending.resolve(Response.json({ error: 'refused' }, { status: 500 }))
  await sync()
  expect(level('low').hasAttribute('data-disabled')).toBe(false)
  expect(level('off').hasAttribute('data-checked')).toBe(true)
  expect(page.querySelector('.text-error')?.textContent).toContain('refused')
})

it('lets an agent pick a model and a family by name, recording both writes as the agent', async () => {
  const container = renderSolid(() => (
    <>
      <ModelControl />
      <ModelPicker />
    </>
  ))
  await sync()
  expect(await act('Model and thinking', 'setOpen', true)).toMatchObject({ ok: true })
  await expectDistinctAgentNames(agent)
  expect(await act('Pick another model', 'press')).toMatchObject({ ok: true })
  await expectDistinctAgentNames(agent)
  expect(container.querySelector('[data-highlighted][role="option"]')?.textContent).toContain(
    'atlas',
  )
  expect(await act('Search model catalog', 'setQuery', 'orion faux')).toMatchObject({ ok: true })
  expect(container.querySelector('[data-highlighted][role="option"]')?.textContent).toContain(
    'orion',
  )
  expect(await act('Search model catalog', 'run', 'faux/orion')).toMatchObject({ ok: true })
  expect(await act('Model and thinking', 'setOpen', true)).toMatchObject({ ok: true })
  expect(await act('Review family', 'press')).toMatchObject({ ok: true })
  expect(writes()).toEqual([
    {
      path: '/api/conversations/1/configure',
      body: { model: { provider: 'faux', modelId: 'orion' } },
      source: 'agent',
    },
    {
      path: '/api/extensions/models/actions/setFamily',
      body: { args: { family: null }, conversationId: 1 },
      source: 'agent',
    },
    {
      path: '/api/conversations/1/configure',
      body: { model: { provider: 'faux', modelId: 'atlas' }, thinkingLevel: 'high' },
      source: 'agent',
    },
    {
      path: '/api/extensions/models/actions/setFamily',
      body: { args: { family: 'Review' }, conversationId: 1 },
      source: 'agent',
    },
  ])
})

it('targets the side chat from thinking controls and the picker, including after a provider login', async () => {
  const release = store.watchConversation(side)
  const container = renderSolid(() => (
    <>
      <ConversationScope value={side}>
        <ModelControl />
      </ConversationScope>
      <ModelPicker />
      <LoginDialog />
    </>
  ))
  try {
    await sync()
    server.of(side, true)!.send('view', view(side, 'orion', 'low'))
    await sync()
    expect(container.querySelector('[aria-label="Model and thinking"]')?.textContent).toContain(
      'orion·low',
    )
    expect(await act('Model and thinking', 'setOpen', true)).toMatchObject({ ok: true })
    await expectDistinctAgentNames(agent)
    expect(await act('Thinking level', 'setValue', 'high')).toMatchObject({ ok: true })
    const cycle = models.commands!.find((command) => command.id === 'model.thinking.cycle')!
    expect(cycle).toMatchObject({ keys: 'shift+tab', whileTyping: true })
    await cycle.run(currentContext(side))
    await cycle.run(currentContext())

    expect(await act('Pick another model', 'press')).toMatchObject({ ok: true })
    expect(await act('Search model catalog', 'run', 'accounts/login')).toMatchObject({ ok: true })
    expect(await act('Faux credentials (API key, faux)', 'press')).toMatchObject({ ok: true })
    server.of(1)!.send('doc', {
      kind: 'models.login',
      value: {
        flows: { 'flow-1': { provider: 'faux', type: 'api_key', status: 'complete', events: [] } },
      },
    })
    await sync()
    expect(await act('Pick a model', 'press')).toMatchObject({ ok: true })
    expect(container.querySelector('[data-highlighted][role="option"]')?.textContent).toContain(
      'orion',
    )
    expect(await act('Search model catalog', 'run', 'faux/atlas')).toMatchObject({ ok: true })
    expect(writes()).toEqual([
      { path: '/api/conversations/17/configure', body: { thinkingLevel: 'high' }, source: 'agent' },
      {
        path: '/api/conversations/17/configure',
        body: { thinkingLevel: 'high' },
        source: 'person',
      },
      { path: '/api/conversations/1/configure', body: { thinkingLevel: 'low' }, source: 'person' },
      {
        path: '/api/extensions/models/actions/login',
        body: { args: { provider: 'faux', type: 'api_key' }, conversationId: 17 },
        source: 'agent',
      },
      {
        path: '/api/conversations/17/configure',
        body: { model: { provider: 'faux', modelId: 'atlas' } },
        source: 'agent',
      },
      {
        path: '/api/extensions/models/actions/setFamily',
        body: { args: { family: null }, conversationId: 17 },
        source: 'agent',
      },
    ])
  } finally {
    release()
  }
})

it('picks a model and thinking kept outside any conversation through the pick, not configure', async () => {
  const changes: object[] = []
  const [ref, setRef] = createSignal({ provider: 'faux', modelId: 'orion' })
  const [thinking, setThinking] = createSignal<'off' | 'low' | 'high'>('low')
  const pick = {
    name: 'Next',
    ref,
    thinking,
    configure: async (change: ConfigureRequest) => {
      changes.push({ ...change, by: writerNow() })
      if (change.model) setRef(change.model)
      if (change.thinkingLevel) setThinking(change.thinkingLevel as 'off' | 'low' | 'high')
    },
  }
  const container = renderSolid(() => (
    <>
      <ModelControl />
      <PickControl pick={pick} />
      <ModelPicker />
    </>
  ))
  await sync()
  const chip = () => container.querySelector('[aria-label="Next model"]')
  expect(chip()?.textContent).toContain('orion·low')
  expect(await act('Next model', 'setOpen', true)).toMatchObject({ ok: true })
  await expectDistinctAgentNames(agent)
  expect(await act('Thinking level', 'setValue', 'high')).toMatchObject({ ok: true })
  expect(await act('Pick another model', 'press')).toMatchObject({ ok: true })
  expect(container.querySelector('[data-highlighted][role="option"]')?.textContent).toContain(
    'orion',
  )
  expect(await act('Search model catalog', 'run', 'faux/atlas')).toMatchObject({ ok: true })
  expect(changes).toEqual([
    { thinkingLevel: 'high', by: 'agent' },
    { model: { provider: 'faux', modelId: 'atlas' }, by: 'agent' },
  ])
  expect(writes()).toEqual([])
  expect(chip()?.textContent).toContain('atlas·high')
})

it('lets an agent start a provider login and answer a streamed secret prompt without reading it', async ({
  onTestFinished,
}) => {
  renderSolid(() => <LoginDialog />)
  openLogin(actions)
  await sync()
  await expectDistinctAgentNames(agent)
  expect(await act('Faux credentials (API key, faux)', 'press')).toMatchObject({ ok: true })
  const flow = {
    provider: 'faux',
    type: 'api_key',
    status: 'running',
    prompt: { type: 'secret', message: 'Provider API key' },
    events: [],
  }
  server.of(1)!.send('doc', { kind: 'models.login', value: { flows: { 'flow-1': flow } } })
  await sync()
  await expectDistinctAgentNames(agent)
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const filled = await act('Provider API key', 'setValue', 'a-test-value')
  expect(filled).toMatchObject({ ok: true })
  expect(JSON.stringify([filled.values, agent.snapshot(), changes.mock.calls])).not.toContain(
    'a-test-value',
  )
  expect(JSON.stringify(filled.values)).toContain('[redacted]')
  expect(await act('Continue', 'press')).toMatchObject({ ok: true })
  expect(writes()).toEqual([
    {
      path: '/api/extensions/models/actions/login',
      body: { args: { provider: 'faux', type: 'api_key' }, conversationId: 1 },
      source: 'agent',
    },
    {
      path: '/api/extensions/models/actions/answer',
      body: { args: { flowId: 'flow-1', value: 'a-test-value' }, conversationId: 1 },
      source: 'agent',
    },
  ])
  expect(await act('Log in to a provider', 'setOpen', false)).toMatchObject({ ok: true })
  expect(writes().at(-1)).toEqual({
    path: '/api/extensions/models/actions/cancel',
    body: { args: { flowId: 'flow-1' }, conversationId: 1 },
    source: 'agent',
  })
})

it('attributes cancellation to the agent even when login returns its flow id after close', async () => {
  const pending = Promise.withResolvers<Response>()
  const mockResponse = harness.fetch.getMockImplementation()!
  harness.fetch.mockImplementation((url, init) =>
    url === '/api/extensions/models/actions/login' ? pending.promise : mockResponse(url, init),
  )
  renderSolid(() => <LoginDialog />)
  openLogin(actions)
  await sync()
  expect(await act('Faux credentials (API key, faux)', 'press')).toMatchObject({ ok: true })
  expect(await act('Log in to a provider', 'setOpen', false)).toMatchObject({ ok: true })
  expect(writes().map(({ path }) => path)).toEqual(['/api/extensions/models/actions/login'])
  pending.resolve(Response.json({ result: { flowId: 'late' } }))
  await sync()
  expect(writes().at(-1)).toEqual({
    path: '/api/extensions/models/actions/cancel',
    body: { args: { flowId: 'late' }, conversationId: 1 },
    source: 'agent',
  })
})
