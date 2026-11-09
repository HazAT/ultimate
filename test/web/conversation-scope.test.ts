import { createElement as h, Fragment } from 'react'
import type { EffectCallback, ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StreamedView } from '../../shared/protocol.ts'
import { actionRef, docRef } from '../../shared/extension-api.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  effects: [] as EffectCallback[],
  submit: undefined as (() => void) | undefined,
  change: undefined as ((event: { target: { value: string } }) => void) | undefined,
  keyDown: undefined as ((event: object) => void) | undefined,
  stop: undefined as (() => void) | undefined,
  cancel: undefined as (() => void) | undefined,
  fetch: vi.fn<typeof fetch>(
    async (path, init): Promise<Response> =>
      harness.server?.handle(path as string, init) ?? Response.json({ ok: true }),
  ),
}))
// Server rendering supplies real React context but has no commit phase. Run captured effects explicitly, and read
// external-store snapshots directly, to exercise scopes and composer callbacks without a DOM or a new dependency.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => harness.effects.push(effect),
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createApi } = await import('../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { FakeSource } = await import('./fake-source.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: harness.fetch,
    retryMs: 5,
  })
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const api = createApi(store, { fetch: harness.fetch })
  return { store, api, reads: createReads(api, store), registry: createRegistry() }
})
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
vi.mock('@/components/ai/prompt-input', () => ({
  PromptInput: ({
    children,
    onSubmit,
  }: {
    children: ReactNode
    onSubmit: (event: object) => void
  }) => {
    harness.submit = () => onSubmit({ preventDefault() {} })
    return h('form', null, children)
  },
  PromptInputTextarea: (props: {
    id: string
    value: string
    onChange: typeof harness.change
    onKeyDown: typeof harness.keyDown
  }) => {
    harness.change = props.onChange
    harness.keyDown = props.onKeyDown
    return h('textarea', { id: props.id, defaultValue: props.value })
  },
  PromptInputSubmit: ({ mode, onClick }: { mode?: string; onClick?: () => void }) => {
    if (mode === 'stop') harness.stop = onClick
    return h('button', null, mode ?? 'send')
  },
  PromptInputFooter: ({ children }: { children: ReactNode }) => children,
  PromptInputTools: ({ children }: { children: ReactNode }) => children,
}))

import { registry, store } from '../../web/src/sdk/client.ts'
import { ConversationScope } from '../../web/src/sdk/conversation-scope.tsx'
import { Conversation } from '../../web/src/app/primitives.tsx'
import {
  getConversation,
  TranscriptContext,
  useAction,
  useConversation,
  useDoc,
  useTranscript,
  useUltimate,
} from '../../web/src/sdk/hooks.ts'

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
const scoped = (id: number, children: ReactNode) => h(ConversationScope, { id, children })
function renderScopes() {
  return renderToStaticMarkup(h(Fragment, null, scoped(7, h(Probe)), scoped(9, h(Probe)), h(Probe)))
}

it('keeps two scoped snapshots, ops, transcripts and documents independent of the shown conversation', async () => {
  source().send('view', view(1, 'shown'))
  renderScopes()
  commitEffects()
  await tick()
  expect(harness.sources).toHaveLength(1)
  expect(source(7)).toMatchObject({ docs: [counter.kind], view: true })
  expect(source(9)).toMatchObject({ docs: [counter.kind], view: true })
  source(7).send('view', view(7, 'seven'))
  source(9).send('view', view(9, 'nine'))
  source(7).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' updated']])
  source(9).send('ops', [['a', ['entries', 0, 'model', 0, 'content'], ' live']])
  source(7).send('doc', { kind: counter.kind, value: { n: 7 } })
  source(9).send('doc', { kind: counter.kind, value: { n: 9 } })
  source(7).send('docOps', { kind: counter.kind, ops: [['s', ['n'], 8]] })
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
  const nested = renderToStaticMarkup(
    h(TranscriptContext, { value: view(7, 'parent history').entries }, scoped(9, h(Probe))),
  )
  expect(nested).toContain('nine live')
  expect(nested).not.toContain('parent history')
  store.show(11)
  await tick()
  expect(source(7).closed).toBe(false)
  expect(source(9).closed).toBe(false)
  expect(renderScopes()).toContain('seven updated')
})

it('shares scopes, reconnects from a snapshot, ignores stale streams, and releases the last view', async () => {
  const release = store.watchConversation(7)
  const again = store.watchConversation(7)
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

it('renders <ConversationScope><Conversation/></ConversationScope> and sends, steers, cancels and stops on its id', async () => {
  await registry.setLoaders({
    '/extensions/test/web.tsx': async () => ({
      default: {
        inbox: ({
          core,
          cancel,
        }: {
          core: ReactNode
          cancel: ReactElement<{ onClick: () => void }>
        }) => {
          harness.cancel = cancel.props.onClick
          return core
        },
      },
    }),
  })
  const release = store.watchConversation(17)
  effects.push(release)
  await tick()
  source().send('view', view(1, 'other transcript'))
  source(17).send('view', view(17, 'side transcript'))
  const render = () => renderToStaticMarkup(scoped(17, h(Conversation)))
  let html = render()
  expect(html).toContain('side transcript')
  expect(html).not.toContain('other transcript')
  expect(html).toContain('composer-input-17')
  expect(html).toContain('queued 17')
  harness.cancel!()
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith(
    '/api/conversations/17/inbox/1700/cancel',
    expect.anything(),
  )
  harness.change!({ target: { value: 'hello side' } })
  render()
  harness.submit!()
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith(
    '/api/conversations/17/submit',
    expect.objectContaining({ body: JSON.stringify({ text: 'hello side', images: [] }) }),
  )

  source(17).send('view', view(17, 'side transcript', true))
  html = render()
  expect(html).toContain('queued 17')
  harness.change!({ target: { value: 'steer side' } })
  render()
  harness.keyDown!({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    nativeEvent: {},
    preventDefault() {},
  })
  await tick()
  // A steer behind the queued one withdraws it and sends both as one.
  const calls = harness.fetch.mock.calls.map(([path]) => path)
  expect(calls.at(-2)).toBe('/api/conversations/17/inbox/1700/cancel')
  expect(harness.fetch).toHaveBeenLastCalledWith(
    '/api/conversations/17/submit',
    expect.objectContaining({
      body: JSON.stringify({ text: 'queued 17\nsteer side', whenBusy: 'steer', images: [] }),
    }),
  )
  harness.change!({ target: { value: 'follow side' } })
  render()
  harness.keyDown!({
    key: 'Enter',
    shiftKey: false,
    altKey: true,
    nativeEvent: {},
    preventDefault() {},
  })
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith(
    '/api/conversations/17/submit',
    expect.objectContaining({
      body: JSON.stringify({ text: 'follow side', whenBusy: 'followUp', images: [] }),
    }),
  )
  render()
  harness.stop!()
  await tick()
  expect(harness.fetch).toHaveBeenLastCalledWith('/api/conversations/17/abort', expect.anything())
})

it('sends on Cmd or Ctrl+Enter on a coarse pointer, but not on plain Enter or while composing', async () => {
  // iPadOS reports a coarse primary pointer even with a Magic Keyboard attached.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    addEventListener() {},
    removeEventListener() {},
  }))
  effects.push(store.watchConversation(19))
  await tick()
  source(19).send('view', view(19, 'ipad transcript'))
  const render = () => renderToStaticMarkup(scoped(19, h(Conversation)))
  render()
  async function enter(text: string, keys: object, nativeEvent = {}) {
    harness.change!({ target: { value: text } })
    render()
    let prevented = false
    harness.keyDown!({
      key: 'Enter',
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      ...keys,
      nativeEvent,
      preventDefault: () => (prevented = true),
    })
    await tick()
    return prevented
  }
  const sent = () =>
    harness.fetch.mock.calls.flatMap(([path, init]) =>
      path === '/api/conversations/19/submit' ? [JSON.parse(init!.body as string).text] : [],
    )
  // Plain Return on a touch keyboard keeps its newline; Return that commits an IME candidate never sends.
  expect(await enter('plain', {})).toBe(false)
  expect(await enter('composing', { metaKey: true }, { isComposing: true })).toBe(false)
  expect(sent()).toEqual([])
  expect(await enter('cmd', { metaKey: true })).toBe(true)
  expect(await enter('ctrl', { ctrlKey: true })).toBe(true)
  expect(sent()).toEqual(['cmd', 'ctrl'])
})

it('adds a view to a document-only subscription, keeps documents after the scope releases, and watches the view again from a snapshot', async () => {
  const releaseDoc = store.watchDocOf(23, counter.kind)
  effects.push(releaseDoc)
  await tick()
  const docs = source(23)
  docs.send('view', view(23, 'ignored'))
  docs.send('doc', { kind: counter.kind, value: { n: 1 } })
  expect(store.getState().viewsOf[23]).toBeUndefined()
  const releaseView = store.watchConversation(23)
  await tick()
  expect(docs.closed).toBe(true)
  const both = source(23)
  both.send('view', view(23, 'now retained'))
  both.send('doc', { kind: counter.kind, value: { n: 2 } })
  releaseView()
  await tick()
  // Documents only again: the value stays until the new subscription's snapshot.
  expect(both.closed).toBe(true)
  expect(store.getState().viewsOf[23]).toBeUndefined()
  expect(store.getState().docsOf[23]?.[counter.kind]).toEqual({ n: 2 })
  const only = source(23)
  expect(only.view).toBe(false)
  only.send('doc', { kind: counter.kind, value: { n: 2 } })
  only.send('docOps', { kind: counter.kind, ops: [['s', ['n'], 3]] })
  expect(store.getState().docsOf[23]?.[counter.kind]).toEqual({ n: 3 })

  // Watched again, the view comes from a new subscription's snapshot, and its ops apply to it.
  effects.push(store.watchConversation(23))
  await tick()
  expect(only.closed).toBe(true)
  const again = source(23)
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
