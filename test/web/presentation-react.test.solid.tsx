/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { act, createElement as h } from 'react'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../lib/ids.ts'
import type { StreamedView } from '../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  posts: [] as { path: string; source: string | null }[],
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const server = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const subscription = server.handle(path, init)
    if (subscription) return subscription
    if (path === '/api/models')
      return Response.json({
        providers: [],
        models: [{ provider: 'faux', id: 'faux-1', available: true }],
      })
    harness.posts.push({ path, source: new Headers(init?.headers).get('x-ultimate-source') })
    return Response.json({ ok: true, submissionId: 1 })
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
    reportCompact: () => {},
  }
})
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false, rendered: () => {} }))
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

import { App } from '../../web/src/app/App.solid.tsx'
import { Conversation as ReactConversation } from '../../web/src/compat/shell.tsx'
import { ConversationScope as ReactScope } from '../../web/src/compat/conversation-scope.tsx'
import { registry, store, uiState } from '../../web/src/sdk/client.ts'
import { PresentationPoint, provide } from '../../web/src/sdk/types.ts'

it('keeps a React surface’s scoped conversation and writer while presentation changes and falls back', async ({
  onTestFinished,
}) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const [mode, setMode] = createSignal<'full' | 'reduced' | 'failed'>('full')
  const ReactSurface = () =>
    h(ReactScope, { id: parseConversationId(8), children: h(ReactConversation) })
  await registry.setLoaders({
    'extensions/agent/web.solid.tsx': async () => ({
      default: {
        surfaces: [
          { id: 'agent', title: 'Agent', icon: () => null, component: () => <span>Agent</span> },
        ],
      },
    }),
    'extensions/presentation/web.solid.tsx': async () => ({
      default: {
        provides: [
          provide(PresentationPoint, () => () => {
            if (mode() === 'failed') throw new Error('presentation failed')
            return mode() === 'reduced'
              ? { titlebar: 'essential', composer: 'bare', backgroundUpdates: 'hide' }
              : {}
          }),
        ],
        slots: {
          'composer.toolbar': () => <span data-toolbar>toolbar</span>,
          'titlebar.persistent': () => <span data-persistent>persistent</span>,
        },
        compact: {
          when: () => true,
          thread: ({ entry }: { entry: { kind: string } }) => entry.kind === 'pi.user',
        },
      },
    }),
    'extensions/sample/web.tsx': async () => ({
      default: {
        surfaces: [{ id: 'sample', title: 'Sample', icon: () => null, component: ReactSurface }],
      },
    }),
  })
  registry.receiveSystem()
  uiState.receive({ 'shell.surface': 'sample' })
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  store.show(parseConversationId(7))
  harness.sources[0].send('conversations', [{ id: 7 }, { id: 8 }] as never)
  await settle()
  harness
    .server!.of(7)!
    .send('view', { conversation: { id: 7 }, entries: [], docs: {} } as unknown as StreamedView)
  await store.refreshModels()
  let container!: HTMLElement
  await act(async () => {
    container = renderSolid(() => <App />)
    await settle()
    flush()
  })
  await settle()
  harness.server!.of(8)!.send('view', {
    conversation: { id: 8 },
    entries: [
      {
        id: 80,
        conversationId: 8,
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Scoped question', timestamp: 0 }],
      },
      { id: 81, conversationId: 8, kind: 'probe.note', data: {} },
    ],
    docs: { 'pi.agent': { model: { provider: 'faux', modelId: 'faux-1' } } },
  } as unknown as StreamedView)
  await settle()
  flush()
  const editor = container.querySelector<HTMLTextAreaElement>('#composer-input-8')!
  expect(editor).not.toBeNull()
  expect(container.querySelector('[data-toolbar]')).not.toBeNull()
  expect(container.querySelector('[data-between]')).not.toBeNull()
  expect(container.querySelector('[data-ui="surface-tabs"]')).not.toBeNull()
  await act(async () => {
    setMode('reduced')
    flush()
    await settle()
  })
  expect(container.querySelector('#composer-input-8')).toBe(editor)
  expect(container.querySelector('[data-toolbar]')).toBeNull()
  expect(container.querySelector('[data-between]')).toBeNull()
  expect(container.querySelector('[data-ui="surface-tabs"]')).toBeNull()
  expect(container.querySelector('[data-persistent]')).not.toBeNull()
  const agent = createAgent()
  expect(
    await agent.act({
      steps: [
        { ref: 'Prompt for conversation #8', action: 'setValue', args: ['Scoped message'] },
        { ref: 'Send prompt to conversation #8', action: 'press' },
      ],
    }),
  ).toMatchObject({ ok: true })
  await settle()
  expect(harness.posts).toContainEqual({ path: '/api/conversations/8/submit', source: 'agent' })
  await act(async () => {
    setMode('failed')
    flush()
    await settle()
  })
  expect(container.querySelector('#composer-input-8')).toBe(editor)
  expect(container.querySelector('[data-toolbar]')).not.toBeNull()
  expect(container.querySelector('[data-between]')).not.toBeNull()
  expect(container.querySelector('[data-ui="surface-tabs"]')).not.toBeNull()
  expect(container.querySelector('[data-extension-error="presentation"]')).not.toBeNull()
})
