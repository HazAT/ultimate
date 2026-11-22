import type { ConversationId } from '@earendil-works/pi-durable'
import { createSignal, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'
import { renderSolid } from './solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  fetch: vi.fn<typeof fetch>(
    async (path, init): Promise<Response> =>
      harness.server?.handle(path as string, init) ?? Response.json({ ok: true }),
  ),
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
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
  const api = createApi(store, { fetch: pageFetch })
  return { store, api, reads: createReads(api, store), uiState: createUiState(undefined) }
})
import { store } from '../../web/src/sdk/client.ts'
import {
  actionRef,
  ConversationScope,
  createTranscriptFrame,
  docRef,
  getConversation,
  ScopedConversation,
  Transcript,
  useAction,
  useConversation,
  useConversationId,
  useDoc,
  useTranscript,
} from '../../web/src/sdk/solid.ts'

harness.server = fakeSubscriptions(harness.sources)
const counter = docRef<{ n: number }>('test.counter')
beforeEach(async () => {
  vi.useFakeTimers()
  harness.fetch.mockClear()
  harness.sources.length = 0
  harness.server!.subscriptions.length = 0
  store.show(undefined)
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})
const tick = () => vi.advanceTimersByTimeAsync(10)
const live = (id?: number, withView = true) => harness.server!.of(id, withView)!
function view(id: number, text: string): StreamedView {
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
    docs: {},
  } as unknown as StreamedView
}

function Probe() {
  const conversation = useConversation()
  const scope = useConversationId()
  const transcript = useTranscript()
  const doc = useDoc(counter)
  return (
    <output>
      {JSON.stringify({
        id: conversation().id,
        scope: scope(),
        entries: conversation().entries,
        transcript: transcript(),
        count: doc()?.n,
      })}
    </output>
  )
}
const outputs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('output'), (output) => JSON.parse(output.textContent))
function expected(id: number, text: string, count?: number) {
  const { entries } = view(id, text)
  return { id, scope: id, entries, transcript: entries, count }
}

it('keeps two scoped snapshots, ops, transcripts and documents independent of the shown conversation', async () => {
  live().send('view', view(1, 'shown'))
  const container = renderSolid(() => (
    <>
      <ScopedConversation id={7 as ConversationId}>
        <Probe />
      </ScopedConversation>
      <ScopedConversation id={9 as ConversationId}>
        <Probe />
      </ScopedConversation>
      <Probe />
    </>
  ))
  await tick()
  expect(harness.sources).toHaveLength(1)
  expect(live(7)).toMatchObject({ docs: [], view: true })
  expect(live(7, false)).toMatchObject({ docs: [counter.kind], view: false })
  expect(live(9, false)).toMatchObject({ docs: [counter.kind], view: false })
  live(7).send('view', view(7, 'seven'))
  live(9).send('view', view(9, 'nine'))
  live(7).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' updated']])
  live(9).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' live']])
  live(7, false).send('doc', { kind: counter.kind, value: { n: 7 } })
  live(9, false).send('doc', { kind: counter.kind, value: { n: 9 } })
  live(7, false).send('docOps', { kind: counter.kind, ops: [['s', ['n'], 8]] })
  flush()
  const seven = expected(7, 'seven updated', 8)
  const nine = expected(9, 'nine live', 9)
  expect(outputs(container)).toEqual([seven, nine, expected(1, 'shown')])
  expect(getConversation().id).toBe(1)

  const parentHistory = view(7, 'parent history').entries
  const nested = renderSolid(() => (
    <Transcript value={createTranscriptFrame(() => parentHistory).frame}>
      <ScopedConversation id={9 as ConversationId}>
        <Probe />
      </ScopedConversation>
    </Transcript>
  ))
  expect(outputs(nested)).toEqual([nine])

  const scopes = [live(7), live(7, false), live(9), live(9, false)]
  store.show(11 as ConversationId)
  await tick()
  expect(scopes.map((item) => item.closed)).toEqual([false, false, false, false])
  live(11).send('view', view(11, 'now shown'))
  flush()
  expect(outputs(container)).toEqual([seven, nine, expected(11, 'now shown')])
})

it('shares scopes, reconnects from a snapshot, ignores stale streams, and releases the last view', async () => {
  const id = 7 as ConversationId
  const [firstMounted, mountFirst] = createSignal(true)
  const [secondMounted, mountSecond] = createSignal(true)
  renderSolid(() => (
    <>
      {firstMounted() && <ScopedConversation id={id}>{null}</ScopedConversation>}
      {secondMounted() && <ScopedConversation id={id}>{null}</ScopedConversation>}
    </>
  ))
  await tick()
  const first = live(7)
  expect(harness.server!.subscriptions.filter((item) => item.conversation === 7)).toHaveLength(1)
  first.send('ops', [['s', ['older'], 1]])
  expect(store.getState().viewsOf[7]).toBeUndefined()
  first.send('view', view(7, 'initial'))
  harness.sources[0].drop()
  harness.sources[0].open()
  const reopened = live(7)
  expect(reopened.sub).not.toBe(first.sub)
  reopened.send('view', view(7, 'fresh'))
  first.send('view', view(7, 'stale'))
  expect(store.getState().viewsOf[7]?.entries).toEqual(view(7, 'fresh').entries)
  mountFirst(false)
  flush()
  await tick()
  expect(reopened.closed).toBe(false)
  mountSecond(false)
  flush()
  await tick()
  expect(reopened.closed).toBe(true)
  expect(store.getState().viewsOf[7]).toBeUndefined()
  reopened.send('view', view(7, 'late'))
  expect(store.getState().viewsOf[7]).toBeUndefined()
})

function Counter() {
  const doc = useDoc(counter)
  return <output>{doc()?.n}</output>
}

it('keeps documents and the view of a conversation on separate subscriptions, so one never resends the other', async () => {
  const id = 23 as ConversationId
  const [watchView, setWatchView] = createSignal(false)
  const container = renderSolid(() => (
    <>
      <ConversationScope value={id}>
        <Counter />
      </ConversationScope>
      {watchView() && <ScopedConversation id={id}>{null}</ScopedConversation>}
    </>
  ))
  await tick()
  const docs = live(23, false)
  docs.send('doc', { kind: counter.kind, value: { n: 1 } })
  expect(store.getState().viewsOf[23]).toBeUndefined()
  setWatchView(true)
  flush()
  await tick()
  expect(docs.closed).toBe(false)
  const viewOnly = live(23)
  expect(viewOnly.docs).toEqual([])
  viewOnly.send('view', view(23, 'now retained'))
  docs.send('docOps', { kind: counter.kind, ops: [['s', ['n'], 2]] })
  setWatchView(false)
  flush()
  await tick()
  expect(viewOnly.closed).toBe(true)
  expect(docs.closed).toBe(false)
  expect(store.getState().viewsOf[23]).toBeUndefined()
  expect(container.textContent).toBe('2')

  setWatchView(true)
  flush()
  await tick()
  const again = live(23)
  expect(again.sub).not.toBe(viewOnly.sub)
  again.send('view', view(23, 'back'))
  again.send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' again']])
  expect(store.getState().viewsOf[23]?.entries).toEqual(view(23, 'back again').entries)
})

function Action() {
  useAction(actionRef<null, unknown>('test', 'scoped'))
  return null
}

it('runs useAction on the scope even before its snapshot arrives', async () => {
  renderSolid(() => (
    <ScopedConversation id={21 as ConversationId}>
      <Action />
    </ScopedConversation>
  ))
  await tick()
  expect(store.getState().viewsOf[21]).toBeUndefined()
  expect(harness.fetch).toHaveBeenCalledWith(
    '/api/extensions/test/actions/scoped',
    expect.objectContaining({ body: JSON.stringify({ args: null, conversationId: 21 }) }),
  )
})
