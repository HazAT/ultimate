/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../lib/ids.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  posts: [] as { path: string; body: unknown; source: string | null }[],
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const subscriptions = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const answered = subscriptions.handle(path, init)
    if (answered) return answered
    if (path === '/api/models') return Response.json({ providers: [], models: [faux] })
    harness.posts.push({
      path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      source: new Headers(init?.headers).get('x-ultimate-source'),
    })
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
  }
})

import { getDraft } from '../../web/src/app/drafts.ts'
import { Composer } from '../../web/src/app/composer.solid.tsx'
import { registry, store } from '../../web/src/sdk/client.ts'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'

const faux = { provider: 'faux', id: 'faux-1', available: true }
const agent = createAgent()

beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  harness.posts.length = 0
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
})
afterEach(() => vi.unstubAllGlobals())

async function show(id: number, docs: Record<string, unknown> = {}) {
  const conversation = parseConversationId(id)
  store.show(conversation)
  await settle()
  harness.server!.of(id)!.send('view', {
    conversation: { id: conversation },
    entries: [],
    docs: { 'pi.agent': { model: { provider: 'faux', modelId: 'faux-1' } }, ...docs },
  })
  await store.refreshModels()
  flush()
}

async function act(steps: { ref: string; action: string; args?: unknown[] }[]) {
  const result = await agent.act({ steps })
  await settle()
  flush()
  return result
}

const submits = () => harness.posts.filter((post) => post.path.endsWith('/submit'))

it('sends what an agent types as the agent’s, and clears the draft', async () => {
  await show(7)
  renderSolid(() => <Composer />)
  await settle()
  flush()
  await expectDistinctAgentNames(agent)
  expect(
    await act([
      { ref: 'Prompt for conversation #7', action: 'setValue', args: ['hello'] },
      { ref: 'Send prompt to conversation #7', action: 'press' },
    ]),
  ).toMatchObject({ ok: true })
  expect(submits()).toEqual([
    {
      path: '/api/conversations/7/submit',
      body: { text: 'hello', images: [] },
      source: 'agent',
    },
  ])
  expect(getDraft(7).get().text).toBe('')
  expect(localStorage.getItem('ultimate.draft.7')).toBeNull()
})

it('steers on Enter, queues a follow-up on Alt+Enter, cancels a queued input and stops the run', async () => {
  await show(8, {
    'pi.live': { run: { taskId: 2, inputs: [], turns: 0 } },
    'pi.inbox': { items: [{ id: 80, mode: 'followUp', content: 'queued later' }] },
  })
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  const editor = container.querySelector<HTMLTextAreaElement>('#composer-input')!
  const type = async (text: string, keys: KeyboardEventInit) => {
    await act([{ ref: 'Prompt for conversation #8', action: 'setValue', args: [text] }])
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...keys }))
    await settle()
    flush()
  }
  await type('steer now', {})
  await type('after this', { altKey: true })
  expect(
    await act([
      { ref: 'Prompt for conversation #8', action: 'setValue', args: ['agent steer'] },
      { ref: 'Send prompt to conversation #8', action: 'press' },
    ]),
  ).toMatchObject({ ok: true })
  expect(submits().map(({ body, source }) => [body, source])).toEqual([
    [{ text: 'steer now', whenBusy: 'steer', images: [] }, 'person'],
    [{ text: 'after this', whenBusy: 'followUp', images: [] }, 'person'],
    [{ text: 'agent steer', whenBusy: 'steer', images: [] }, 'agent'],
  ])
  await expectDistinctAgentNames(agent)
  expect(
    await act([
      { ref: 'Cancel queued input 80: queued later', action: 'press' },
      { ref: 'Stop the run in conversation #8', action: 'press' },
    ]),
  ).toMatchObject({ ok: true })
  expect(harness.posts.slice(-2)).toEqual([
    { path: '/api/conversations/8/inbox/80/cancel', body: {}, source: 'agent' },
    { path: '/api/conversations/8/abort', body: {}, source: 'agent' },
  ])
})

it('mounts a React inbox renderer through the bridge, with the core row as its core', async () => {
  await registry.setLoaders({
    '/extensions/legacy/web.tsx': async () => ({
      default: {
        inbox: ({ item, core }: { item: { id: number }; core: ReactNode }) =>
          h('div', { 'data-legacy-inbox': item.id }, core),
      },
    }),
  })
  await show(11, {
    'pi.live': { run: { taskId: 2, inputs: [], turns: 0 } },
    'pi.inbox': { items: [{ id: 110, mode: 'steer', content: 'queued steer' }] },
  })
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  const legacy = container.querySelector('[data-legacy-inbox="110"]')
  expect(legacy?.textContent).toContain('queued steer')
  expect(legacy?.querySelector('[aria-label^="Cancel queued input 110"]')).not.toBeNull()
  await registry.setLoaders({})
})

it('keeps a typed draft per conversation across a remount', async () => {
  await show(9)
  const first = renderSolid(() => <Composer />)
  await settle()
  flush()
  await act([{ ref: 'Prompt for conversation #9', action: 'setValue', args: ['half a thought'] }])
  expect(localStorage.getItem('ultimate.draft.9')).toBe('half a thought')
  first.remove()
  await show(10)
  const second = renderSolid(() => <Composer />)
  await settle()
  flush()
  expect(second.querySelector<HTMLTextAreaElement>('#composer-input')!.value).toBe('')
  await show(9)
  expect(second.querySelector<HTMLTextAreaElement>('#composer-input')!.value).toBe('half a thought')
})
