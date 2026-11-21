import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement as h, Fragment } from 'react'
import type { EffectCallback, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../shared/protocol.ts'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  effects: [] as EffectCallback[],
  fetch: vi.fn<typeof fetch>(
    async (path, init): Promise<Response> =>
      harness.server?.handle(path as string, init) ?? Response.json({ ok: true }),
  ),
}))
// Server rendering supplies real React context but has no commit phase. Run captured effects explicitly, and read
// external-store snapshots directly, to exercise scopes without a DOM or a new dependency.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => harness.effects.push(effect),
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { FakeSource, answerReadsWith } = await import('./fake-source.ts')
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
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const api = createApi(store, { fetch: pageFetch })
  return { store, api, reads: createReads(api, store) }
})
import { store } from '../../web/src/sdk/client.ts'
import { ConversationScope } from '../../web/src/compat/conversation-scope.tsx'
import { createTranscriptFrame } from '../../web/src/sdk/transcript-frame.ts'
import {
  getConversation,
  TranscriptContext,
  useAction,
  useConversation,
  useDoc,
  useTranscript,
  useUltimate,
} from '../../web/src/compat/hooks.ts'

harness.server = fakeSubscriptions(harness.sources)
const counter = docRef<{ n: number }>('test.counter')
const effects: (() => void)[] = []
const storage = new Map<string, string>()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('location', { search: '' })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  harness.fetch.mockClear()
  harness.sources.length = 0
  harness.server!.subscriptions.length = 0
  harness.effects.length = 0
  storage.clear()
  store.show(undefined)
  store.start()
  harness.sources[0].open()
})
afterEach(() => {
  for (const release of effects.splice(0)) release()
  store.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function commitEffects() {
  for (const effect of harness.effects.splice(0)) {
    const release = effect()
    if (release) effects.push(release)
  }
}
const tick = () => vi.advanceTimersByTimeAsync(10)
/** The open subscription of a conversation (undefined: the root) on the tab's stream. */
const source = (id?: number) => harness.server!.of(id)!
const live = (id: number, withView: boolean) => harness.server!.of(id, withView)!
function view(id: number, text: string, busy = false): StreamedView {
  return {
    conversation: { id },
    entries: [
      {
        id: id * 10,
        conversationId: id,
        kind: 'pi.user',
        model: [{ role: 'user', content: text, timestamp: 0 }],
      },
    ],
    docs: {
      'pi.agent': { model: { provider: 'faux', modelId: 'faux-1' } },
      'pi.live': busy ? { run: { taskId: 2, inputs: [], turns: 0 } } : {},
      'pi.inbox': { items: [{ id: id * 100, mode: 'steer', content: `queued ${id}` }] },
    },
  } as unknown as StreamedView
}
function Probe() {
  const { id, entries } = useConversation()
  const selected = useConversation((conversation) => conversation.id)
  const transcript = useTranscript()
  const doc = useDoc(counter)
  const ultimate = useUltimate()
  return h(
    'output',
    null,
    JSON.stringify({ id, selected, entries, transcript, doc, ultimate: ultimate.conversationId }),
  )
}
const scoped = (id: number, children: ReactNode) =>
  h(ConversationScope, { id: id as ConversationId, children })
function renderScopes() {
  return renderToStaticMarkup(h(Fragment, null, scoped(7, h(Probe)), scoped(9, h(Probe)), h(Probe)))
}

it('keeps two scoped snapshots, ops, transcripts and documents independent of the shown conversation', async () => {
  source().send('view', view(1, 'shown'))
  renderScopes()
  commitEffects()
  await tick()
  expect(harness.sources).toHaveLength(1)
  expect(live(7, true)).toMatchObject({ docs: [], view: true })
  expect(live(7, false)).toMatchObject({ docs: [counter.kind], view: false })
  expect(live(9, false)).toMatchObject({ docs: [counter.kind], view: false })
  live(7, true).send('view', view(7, 'seven'))
  live(9, true).send('view', view(9, 'nine'))
  live(7, true).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' updated']])
  live(9, true).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' live']])
  live(7, false).send('doc', { kind: counter.kind, value: { n: 7 } })
  live(9, false).send('doc', { kind: counter.kind, value: { n: 9 } })
  live(7, false).send('docOps', { kind: counter.kind, ops: [['s', ['n'], 8]] })
  const outputs = renderScopes().split('</output>')
  expect(outputs[0]).toContain('seven updated')
  expect(outputs[0]).not.toContain('nine')
  expect(outputs[0]).toContain('&quot;doc&quot;:{&quot;n&quot;:8}')
  expect(outputs[1]).toContain('nine live')
  expect(outputs[1]).not.toContain('seven')
  expect(outputs[1]).toContain('&quot;doc&quot;:{&quot;n&quot;:9}')
  expect(outputs[2]).toContain('shown')
  expect(getConversation().id).toBe(1)

  // A nested scope must not inherit its parent's paged transcript.
  const parentHistory = view(7, 'parent history').entries
  const nested = renderToStaticMarkup(
    h(
      TranscriptContext,
      { value: createTranscriptFrame(() => parentHistory).frame },
      scoped(9, h(Probe)),
    ),
  )
  expect(nested).toContain('nine live')
  expect(nested).not.toContain('parent history')
  const scopes = [live(7, true), live(7, false), live(9, true), live(9, false)]
  store.show(11 as ConversationId)
  await tick()
  expect(scopes.map((item) => item.closed)).toEqual([false, false, false, false])
  expect(renderScopes()).toContain('seven updated')
})

it('shares scopes, reconnects from a snapshot, ignores stale streams, and releases the last view', async () => {
  const release = store.watchConversation(7 as ConversationId)
  const again = store.watchConversation(7 as ConversationId)
  await tick()
  const first = source(7)
  expect(harness.server!.subscriptions.filter((item) => item.conversation === 7)).toHaveLength(1)
  first.send('ops', [['s', ['older'], 1]])
  expect(store.getState().viewsOf[7]).toBeUndefined()
  first.send('view', view(7, 'initial'))
  // A new stream after a drop subscribes again.
  harness.sources[0].drop()
  harness.sources[0].open()
  const reopened = source(7)
  expect(reopened).not.toBe(first)
  reopened.send('view', view(7, 'fresh'))
  first.send('view', view(7, 'stale'))
  expect(store.getState().viewsOf[7]?.entries).toEqual(view(7, 'fresh').entries)
  release()
  await tick()
  expect(reopened.closed).toBe(false)
  again()
  await tick()
  expect(reopened.closed).toBe(true)
  expect(store.getState().viewsOf[7]).toBeUndefined()
  reopened.send('view', view(7, 'late'))
  expect(store.getState().viewsOf[7]).toBeUndefined()
})

it('keeps documents and the view of a conversation on separate subscriptions, so one never resends the other', async () => {
  const releaseDoc = store.watchDocOf(23 as ConversationId, counter.kind)
  effects.push(releaseDoc)
  await tick()
  const docs = source(23)
  docs.send('doc', { kind: counter.kind, value: { n: 1 } })
  expect(store.getState().viewsOf[23]).toBeUndefined()
  const releaseView = store.watchConversation(23 as ConversationId)
  await tick()
  expect(docs.closed).toBe(false)
  const viewOnly = live(23, true)
  expect(viewOnly.docs).toEqual([])
  viewOnly.send('view', view(23, 'now retained'))
  docs.send('docOps', { kind: counter.kind, ops: [['s', ['n'], 2]] })
  releaseView()
  await tick()
  expect(viewOnly.closed).toBe(true)
  expect(docs.closed).toBe(false)
  expect(store.getState().viewsOf[23]).toBeUndefined()
  expect(store.getState().docsOf[23]?.[counter.kind]).toEqual({ n: 2 })

  // Watched again, the view comes from a new subscription's snapshot, and its ops apply to it.
  effects.push(store.watchConversation(23 as ConversationId))
  await tick()
  const again = live(23, true)
  expect(again).not.toBe(viewOnly)
  again.send('view', view(23, 'back'))
  again.send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' again']])
  expect(store.getState().viewsOf[23]?.entries[0].model?.[0]).toMatchObject({
    content: 'back again',
  })
})

function Action() {
  useAction(actionRef<null, unknown>('test', 'scoped'))
  return null
}
it('runs useAction on the scope even before its snapshot arrives', async () => {
  renderToStaticMarkup(scoped(21, h(Action)))
  commitEffects()
  await tick()
  expect(harness.fetch).toHaveBeenCalledWith(
    '/api/extensions/test/actions/scoped',
    expect.objectContaining({ body: JSON.stringify({ args: null, conversationId: 21 }) }),
  )
})
