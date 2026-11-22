import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush, For } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseConversationId } from '../../lib/ids.ts'
import { expectDistinctAgentNames } from './agent-names.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  posts: [] as { path: string; body: unknown; source: string | null }[],
  failSubmit: false,
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
    if (harness.failSubmit && path.endsWith('/submit'))
      return Response.json({ error: 'model offline' }, { status: 503 })
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
import { Dock, StatusLine } from '../../web/src/app/shell.solid.tsx'
import { registry, store, uiState } from '../../web/src/sdk/client.ts'
import type { SolidInboxProps } from '../../web/src/sdk/solid.ts'

const faux = { provider: 'faux', id: 'faux-1', available: true }
const agent = createAgent()

beforeEach(({ onTestFinished }) => {
  harness.sources.length = 0
  harness.posts.length = 0
  harness.failSubmit = false
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
  for (const ref of ['Cancel queued input 80: queued later', 'Stop the run in conversation #8']) {
    const before = harness.posts.length
    const result = await act([{ ref, action: 'press' }])
    expect(result.error?.message).toContain('Needs a person')
    expect(harness.posts).toHaveLength(before)
    container.querySelector<HTMLButtonElement>(`[aria-label="${ref}"]`)!.click()
  }
  expect(harness.posts.slice(-2)).toEqual([
    { path: '/api/conversations/8/inbox/80/cancel', body: {}, source: 'person' },
    { path: '/api/conversations/8/abort', body: {}, source: 'person' },
  ])
})

it('withdraws a queued steer into the next steer, and restores both when the submit fails', async () => {
  await show(12, {
    'pi.live': { run: { taskId: 2, inputs: [], turns: 0 } },
    'pi.inbox': { items: [{ id: 120, mode: 'steer', content: 'first steer' }] },
  })
  renderSolid(() => <Composer />)
  await settle()
  flush()
  harness.failSubmit = true
  await act([
    { ref: 'Prompt for conversation #12', action: 'setValue', args: ['second steer'] },
    { ref: 'Send prompt to conversation #12', action: 'press' },
  ])
  expect(harness.posts.map(({ path, body, source }) => [path, body, source])).toEqual([
    ['/api/conversations/12/inbox/120/cancel', {}, 'agent'],
    [
      '/api/conversations/12/submit',
      { text: 'first steer\nsecond steer', whenBusy: 'steer', images: [] },
      'agent',
    ],
  ])
  expect(getDraft(12).get()).toMatchObject({
    text: 'first steer\nsecond steer',
    error: 'model offline',
  })
})

it('shows a draft another tab changed while the composer was away, and sends that text', async () => {
  await show(13)
  renderSolid(() => <Composer />)
  await settle()
  flush()
  await act([{ ref: 'Prompt for conversation #13', action: 'setValue', args: ['mine'] }])
  await show(14)
  localStorage.setItem('ultimate.draft.13', 'from the other tab')
  await show(13)
  await settle()
  flush()
  expect(document.querySelector<HTMLTextAreaElement>('#composer-input')!.value).toBe(
    'from the other tab',
  )
  await act([{ ref: 'Send prompt to conversation #13', action: 'press' }])
  expect(submits().map((post) => post.body)).toEqual([{ text: 'from the other tab', images: [] }])
})

it('leaves no live editor when a composer wrapper replaces the composer', async () => {
  await registry.setLoaders({
    '/extensions/dock/web.solid.tsx': async () => ({
      default: { composer: () => <div data-dock>docked</div> },
    }),
  })
  await show(15)
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  expect(container.querySelector('[data-dock]')).not.toBeNull()
  expect(container.querySelector('#composer-input')).toBeNull()
  const drop = new Event('drop', { bubbles: true }) as DragEvent
  const image = new File(['x'], 'shot.png', { type: 'image/png' })
  Object.defineProperty(drop, 'dataTransfer', {
    value: { types: ['Files'], files: [image] },
  })
  document.body.dispatchEvent(drop)
  await settle()
  expect(getDraft(15).get().error).toBeUndefined()
  expect(getDraft(15).get().images).toEqual([])
  await registry.setLoaders({})
})

it('attaches no dropped file to the composer of a collapsed Dock, and reopens one live editor', async () => {
  await show(16)
  uiState.set('shell.dock.agent.right', { open: true })
  const container = renderSolid(() => (
    <Dock>
      <Composer />
    </Dock>
  ))
  await settle()
  flush()
  expect(container.querySelectorAll('[data-ui="composer"]')).toHaveLength(1)
  uiState.set('shell.dock.agent.right', { open: false })
  await settle()
  flush()
  expect(container.querySelector('[data-ui="composer"]')).toBeNull()
  const drop = new Event('drop', { bubbles: true }) as DragEvent
  Object.defineProperty(drop, 'dataTransfer', {
    value: { types: ['Files'], files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
  })
  document.body.dispatchEvent(drop)
  await settle()
  expect(getDraft(16).get().images).toEqual([])
  uiState.set('shell.dock.agent.right', { open: true })
  await settle()
  flush()
  expect(container.querySelectorAll('[data-ui="composer"]')).toHaveLength(1)
  await act([
    { ref: 'Prompt for conversation #16', action: 'setValue', args: ['docked'] },
    { ref: 'Send prompt to conversation #16', action: 'press' },
  ])
  expect(submits().map((post) => [post.path, post.body])).toEqual([
    ['/api/conversations/16/submit', { text: 'docked', images: [] }],
  ])
})

it('keeps the queued row and its cancel when an inbox renderer throws', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await registry.setLoaders({
    '/extensions/broken/web.solid.tsx': async () => ({
      default: {
        inbox: () => {
          throw new Error('broken renderer')
        },
      },
    }),
  })
  await show(16, {
    'pi.live': { run: { taskId: 2, inputs: [], turns: 0 } },
    'pi.inbox': { items: [{ id: 160, mode: 'followUp', content: 'still here' }] },
  })
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  expect(container.querySelector('[data-extension-error="broken"]')?.textContent).toContain(
    'broken renderer',
  )
  expect(container.textContent).toContain('still here')
  container
    .querySelector<HTMLButtonElement>('[aria-label="Cancel queued input 160: still here"]')!
    .click()
  expect(harness.posts.at(-1)?.path).toBe('/api/conversations/16/inbox/160/cancel')
  await registry.setLoaders({})
})

it('passes the core row to an inbox renderer', async () => {
  await registry.setLoaders({
    '/extensions/outside/web.solid.tsx': async () => ({
      default: {
        inbox: (props: SolidInboxProps) => (
          <div data-custom-inbox={props.item.id}>{props.core}</div>
        ),
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
  const row = container.querySelector('[data-custom-inbox="110"]')
  expect(row?.textContent).toContain('queued steer')
  expect(row?.querySelector('[aria-label^="Cancel queued input 110"]')).not.toBeNull()
  await registry.setLoaders({})
})

it('keeps a typed draft per conversation across a switch', async () => {
  await show(9)
  const container = renderSolid(() => <Composer />)
  await settle()
  flush()
  await act([{ ref: 'Prompt for conversation #9', action: 'setValue', args: ['half a thought'] }])
  expect(localStorage.getItem('ultimate.draft.9')).toBe('half a thought')
  await show(10)
  expect(container.querySelector<HTMLTextAreaElement>('#composer-input')!.value).toBe('')
  await show(9)
  expect(container.querySelector<HTMLTextAreaElement>('#composer-input')!.value).toBe(
    'half a thought',
  )
})

it('moves the phone status into the status line when both mount together', async () => {
  await registry.setLoaders({
    '/extensions/state/web.solid.tsx': async () => ({
      default: { slots: { 'composer.status': () => <span data-status>ready</span> } },
    }),
  })
  await show(19)
  const container = renderSolid(() => (
    <>
      <Composer />
      <For each={[0]}>{() => <StatusLine />}</For>
    </>
  ))
  await settle()
  flush()
  expect(container.querySelector('[data-ui="status-line"] [data-status]')?.textContent).toBe(
    'ready',
  )
  await registry.setLoaders({})
})
