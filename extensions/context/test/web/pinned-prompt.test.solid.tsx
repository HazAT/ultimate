import type { ConversationId } from '@earendil-works/pi-durable'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  fetch: vi.fn<typeof fetch>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { FakeSource, answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(harness.fetch)
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
    retryMs: 5,
  })
  const api = createApi(store, { fetch: pageFetch })
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})
vi.mock('../../../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
vi.stubGlobal('matchMedia', () => ({
  matches: true,
  addEventListener() {},
  removeEventListener() {},
}))

import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { createTranscriptFrame, Transcript } from '../../../../web/src/sdk/solid.ts'
import { PinnedPrompt } from '../../pinned.solid.tsx'

const server = fakeSubscriptions(harness.sources)
const agent = createAgent()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  harness.fetch.mockReset()
  harness.fetch.mockImplementation(
    async (url, init) =>
      server.handle(url as string, init) ??
      Response.json({ result: { prompt: { sections: [], tools: [] }, at: 70 } }),
  )
  harness.sources.length = 0
  server.subscriptions.length = 0
  store.show(undefined)
  store.start()
  harness.sources[0].open()
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function settle() {
  await vi.advanceTimersByTimeAsync(10)
  flush()
}
/** Every distinct `context/currentPrompt` request so far. */
const prompts = () => [
  ...new Set(
    harness.fetch.mock.calls.flatMap(([url, init]) =>
      (url as string).endsWith('/context/actions/currentPrompt') ? [init?.body as string] : [],
    ),
  ),
]
const view = (id: number) =>
  ({
    conversation: { id },
    entries: [{ id: 70, conversationId: id, kind: 'pi.system', model: [] }],
    docs: {},
  }) as unknown as StreamedView

it('asks for the prompt only once the conversation is known, against its own baseline', async () => {
  // As found on a host: a baseline from another conversation, stored while one was still loading.
  uiState.set('context.seen.undefined', 50)
  uiState.set('context.seen.7', 70)
  store.show(7 as ConversationId)
  const pin = renderSolid(() => <PinnedPrompt />)
  await settle()
  // Asking now would send entry 50 to conversation 7: "Entry 50 is not visible from conversation 7".
  expect(prompts()).toEqual([])
  server.of(7)!.send('view', view(7))
  await settle()
  expect(prompts()).toEqual([JSON.stringify({ args: { since: 70 }, conversationId: 7 })])
  expect(
    pin.querySelector('[data-ui="pinned-prompt"] [data-context-header="start"]'),
  ).not.toBeNull()
})

it('lets an agent inspect prompt changes and dismiss them against the new baseline', async () => {
  uiState.set('context.seen.8', 69)
  const section = { key: 'instructions', change: 'added', text: 'New instruction', delta: 4 }
  harness.fetch.mockImplementation(async (url, init) => {
    const subscription = server.handle(url as string, init)
    if (subscription) return subscription
    return Response.json({
      result: {
        prompt: { sections: [], tools: [] },
        at: 70,
        ...(init?.body === JSON.stringify({ args: { since: 69 }, conversationId: 8 }) && {
          diff: { sections: [section], tools: [], delta: 4 },
        }),
      },
    })
  })
  const observe = vi.fn<(target: Element) => void>()
  let enterView: (() => void) | undefined
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(onChange: IntersectionObserverCallback) {
        enterView = () =>
          onChange(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          )
      }
      observe = observe
      disconnect() {}
    },
  )
  const transcript = createTranscriptFrame()
  const content = document.createElement('div')
  transcript.mount({ scroll: document.createElement('div'), content })
  store.show(8 as ConversationId)
  const pin = renderSolid(() => (
    <Transcript value={transcript.frame}>
      <PinnedPrompt />
    </Transcript>
  ))
  await settle()
  server.of(8)!.send('view', view(8))
  await settle()
  const start = document.createElement('div')
  start.dataset.contextHeader = 'start'
  content.append(start)
  await settle()
  expect(observe).toHaveBeenCalledWith(start)
  enterView?.()
  flush()
  expect(pin.querySelector('[data-pinned-notice]')?.textContent).toBe('1 section changed · +4')
  const toggle = pin.querySelector<HTMLButtonElement>('[aria-label="Toggle Pinned prompt #8"]')!
  toggle.click()
  flush()
  await expectDistinctAgentNames(agent)
  const dismiss = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Dismiss changes (Pinned prompt #8)')
  const result = agent.act({ steps: [{ ref: dismiss!.ref, action: 'press' }] })
  await vi.advanceTimersByTimeAsync(100)
  flush()
  expect(await result).toMatchObject({ ok: true })
  expect(uiState.get('context.seen.8')).toBe(70)
  expect(prompts()).toContain(JSON.stringify({ args: { since: 70 }, conversationId: 8 }))
  expect(pin.querySelector('[data-ui="pinned-prompt"]')).toBeNull()
})
