import type { ConversationView, ConversationId } from '@earendil-works/pi-durable'
import type { Op } from '@earendil-works/chord/delta'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../../web/src/sdk/store.ts'
import type { ReadPayload, ServerEvents, SubscriptionsRequest } from '../../shared/protocol.ts'

import { FakeSource, fakeSubscriptions } from './fake-source.ts'

function setup(
  retryMs = 5,
  answerRead?: Parameters<typeof fakeSubscriptions>[1],
  flushTimeoutMs?: number,
) {
  const sources: FakeSource[] = []
  const server = fakeSubscriptions(sources, answerRead)
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (path, init) =>
      server.handle(path as string, init) ?? Response.json({ providers: [], models: [] }),
  )
  const onFallback = vi.fn<() => void>()
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    fetch,
    retryMs,
    flushTimeoutMs,
    onFallback,
  })
  store.start()
  const models = () => fetch.mock.calls.filter(([path]) => path === '/api/models').length
  return { store, sources, server, fetch, models, onFallback, latest: () => sources.at(-1)! }
}

const user = (id: number, text: string) => ({
  id,
  conversationId: 1,
  kind: 'pi.user',
  model: [{ role: 'user' as const, content: text, timestamp: id }],
})
const view = (
  entries: ReturnType<typeof user>[],
  docs: ConversationView['docs'] = {},
  id = 1,
): ConversationView => ({ conversation: { id }, entries, docs }) as unknown as ConversationView
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const tick = () => vi.advanceTimersByTimeAsync(10)
const subscriptionBatches = (fetch: ReturnType<typeof setup>['fetch']) =>
  fetch.mock.calls
    .filter(([path]) => (path as string).startsWith('/api/events/'))
    .map(([, init]) => JSON.parse(init?.body as string) as SubscriptionsRequest)

describe('web replica store', () => {
  it('applies ops to the snapshot and starts over from a fresh snapshot after a reconnect', () => {
    const { store, server, latest } = setup()
    const source = latest()
    expect(source.url).toBe('/api/events')
    expect(store.getState().connection.status).toBe('connecting')
    source.open()
    expect(store.getState().connection.status).toBe('open')
    // The shown conversation (the root) is a subscription on the stream.
    const main = server.of()!
    expect(main).toMatchObject({ stream: source.id, docs: [], view: true })

    main.send('view', view([user(1, 'hello')], { 'pi.live': {} }))
    const ops: Op[] = [
      ['s', ['docs', 'pi.live', 'run'], { taskId: 2, inputs: [1], turns: 0 }],
      ['p', ['entries'], 1, 0, [user(3, 'steer')]],
    ]
    main.send('ops', ops)
    main.send('ops', [['a', ['entries', 1, 'model', 0, 'content'], ' now']])
    const replica = store.getState().view!
    expect(replica.entries.map((entry) => entry.id)).toEqual([1, 3])
    expect(replica.entries[1].model?.[0]).toMatchObject({
      content: 'steer now',
    })
    expect(replica.docs['pi.live']).toEqual({
      run: { taskId: 2, inputs: [1], turns: 0 },
    })
    // Unchanged entries keep their identity, so the transcript re-renders only what changed.
    main.send('ops', [['d', ['docs', 'pi.live', 'run']]])
    expect(store.getState().view!.entries[0]).toBe(replica.entries[0])

    // The root conversation's UI document belongs to the stream, not to a subscription.
    source.send('ui', { value: { 'shell.panelOpen': true } })
    source.send('uiOps', { ops: [['s', ['shell.surface'], 'example']] })
    expect(store.getState().shared).toEqual({
      'shell.panelOpen': true,
      'shell.surface': 'example',
    })

    source.drop()
    expect(store.getState().connection.status).toBe('reconnecting')
    // EventSource reopened the stream: a new one, whose subscription sends a full snapshot first.
    source.open()
    const resumed = server.of()!
    expect(resumed.stream).toBe(source.id)
    expect(resumed.sub).not.toBe(main.sub)
    resumed.send('view', view([user(1, 'hello'), user(3, 'steer now'), user(4, 'next')]))
    // Events of the old stream's subscription are not this one's.
    main.send('ops', [['p', ['entries'], 3, 0, [user(5, 'stale')]]])
    expect(store.getState().view!.entries.map((entry) => entry.id)).toEqual([1, 3, 4])
    expect(store.getState().view!.docs).toEqual({})
    expect(store.getState().connection.status).toBe('open')
    store.stop()
  })

  it('streams extension documents of the shown conversation', async () => {
    const { store, sources, server, latest } = setup()
    latest().open()
    const first = server.of(undefined, true)!
    const release = store.watchDoc('test.counter')
    await tick()
    // Documents get their own subscription on the same stream; the view's stays, so it is not sent again.
    expect(sources).toHaveLength(1)
    expect(first.closed).toBe(false)
    const main = server.of(undefined, false)!
    expect(main).toMatchObject({ docs: ['test.counter'], view: false })

    main.send('doc', { kind: 'test.counter', value: { count: 0 } })
    main.send('docOps', {
      kind: 'test.counter',
      ops: [['s', ['count'], 1]],
    })
    expect(store.getState().docs['test.counter']).toEqual({ count: 1 })
    // Documents nobody asked for are ignored.
    main.send('doc', { kind: 'other', value: { x: 1 } })
    expect(store.getState().docs.other).toBeUndefined()

    // Released and watched again in the same tick: the subscription and its replica carry on, and its ops apply.
    release()
    const again = store.watchDoc('test.counter')
    await tick()
    expect(main.closed).toBe(false)
    main.send('docOps', { kind: 'test.counter', ops: [['s', ['count'], 2]] })
    expect(store.getState().docs['test.counter']).toEqual({ count: 2 })

    // Released for good: the subscription closes, the replica goes, and late ops are ignored.
    again()
    await tick()
    expect(main.closed).toBe(true)
    expect(store.getState().docs['test.counter']).toBeUndefined()
    main.send('docOps', { kind: 'test.counter', ops: [['s', ['count'], 3]] })
    expect(store.getState().docs['test.counter']).toBeUndefined()

    // Watched again later: a new subscription's snapshot.
    store.watchDoc('test.counter')
    await tick()
    const reopened = server.of(undefined, false)!
    expect(reopened).not.toBe(main)
    reopened.send('doc', { kind: 'test.counter', value: { count: 3 } })
    expect(store.getState().docs['test.counter']).toEqual({ count: 3 })
    store.stop()
  })

  it('streams documents of given conversations, one subscription per kind, opened together in one request', async () => {
    const { store, sources, server, latest, fetch } = setup()
    latest().open()
    await tick()
    const posts = () =>
      fetch.mock.calls.filter(([path]) => (path as string).startsWith('/api/events/')).length
    const before = posts()
    const tasks = store.watchDocOf(1 as ConversationId, 'test.tasks')
    const tasksAgain = store.watchDocOf(1 as ConversationId, 'test.tasks')
    const overview = store.watchDocOf(1 as ConversationId, 'test.overview')
    const plan = store.watchDocOf(7 as ConversationId, 'test.plan')
    const counter = store.watchDoc('test.counter')
    const branches = Array.from({ length: 20 }, (_, index) =>
      store.watchDocOf((100 + index) as ConversationId, 'board.started'),
    )
    await tick()
    // Everything watched in one tick goes to the server in one request, all on the tab's one stream.
    expect(posts() - before).toBe(1)
    expect(sources).toHaveLength(1)
    const doc = (conversation: number | undefined, kind: string) =>
      server.subscriptions.findLast(
        (item) => !item.closed && item.conversation === conversation && item.docs.includes(kind),
      )!
    expect(doc(1, 'test.tasks').docs).toEqual(['test.tasks'])
    expect(doc(1, 'test.overview').docs).toEqual(['test.overview'])
    expect(doc(undefined, 'test.counter').docs).toEqual(['test.counter'])
    const root = doc(1, 'test.tasks')
    const coordinator = doc(7, 'test.plan')

    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 0]] })
    expect(store.getState().docsOf[1]).toEqual({})
    root.send('doc', { kind: 'test.tasks', value: { n: 1 } })
    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 2]] })
    coordinator.send('doc', { kind: 'test.plan', value: { epics: {} } })
    expect(store.getState().docsOf).toMatchObject({
      1: { 'test.tasks': { n: 2 } },
      7: { 'test.plan': { epics: {} } },
    })
    // Documents of the shown conversation are a separate replica.
    expect(store.getState().docs).toEqual({})

    // Showing another conversation leaves these subscriptions alone.
    store.show(7 as ConversationId)
    await tick()
    expect([root.closed, coordinator.closed]).toEqual([false, false])

    // Releasing one kind closes only its subscription on the server.
    const overviewSub = doc(1, 'test.overview')
    overview()
    await tick()
    expect([overviewSub.closed, root.closed]).toEqual([true, false])

    // A refused subscription is tried again, alone.
    server.refuse(1, 500)
    const retried = store.watchDocOf(1 as ConversationId, 'test.overview')
    await tick()
    expect(
      server.subscriptions.some((item) => !item.closed && item.docs.includes('test.overview')),
    ).toBe(false)
    server.refuse(1, undefined)
    await tick()
    expect(doc(1, 'test.overview').docs).toEqual(['test.overview'])
    expect(root.closed).toBe(false)

    // A new stream (a restart) gets every subscription again; the value stays until its snapshot.
    latest().drop()
    latest().open()
    const reopened = doc(1, 'test.tasks')
    expect(reopened.stream).toBe(latest().id)
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 2 })
    reopened.send('doc', { kind: 'test.tasks', value: { n: 3 } })
    root.send('doc', { kind: 'test.tasks', value: { n: 0 } })
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 3 })
    expect(doc(7, 'test.plan').stream).toBe(latest().id)

    // The last reader of a kind closes its subscription.
    tasks()
    await tick()
    expect(reopened.closed).toBe(false)
    tasksAgain()
    retried()
    await tick()
    expect(reopened.closed).toBe(true)
    expect(store.getState().docsOf[1]).toBeUndefined()
    plan()
    counter()
    for (const release of branches) release()
    await tick()
    // Only the shown conversation's view is left.
    expect(
      server.subscriptions.filter((item) => !item.closed).map((item) => item.conversation),
    ).toEqual([7])
    expect(store.getState().docsOf[7]).toBeUndefined()

    store.stop()
    expect(latest().closed).toBe(true)
  })

  it('serializes subscription requests and coalesces changes queued during an open', async () => {
    const { store, server, fetch, latest } = setup()
    const pending = Promise.withResolvers<void>()
    fetch.mockImplementationOnce(async (path, init) => {
      await pending.promise
      return server.handle(path as string, init)!
    })
    latest().open()
    const fleeting = store.watchDoc('test.fleeting')
    await tick()
    fleeting()
    store.show(7 as ConversationId)
    store.watchDoc('test.final')
    await tick()
    const [first] = subscriptionBatches(fetch)
    expect(subscriptionBatches(fetch)).toHaveLength(1)
    expect(first.subscribe).toMatchObject([{ docs: [], view: true }])
    pending.resolve()
    await tick()
    const batches = subscriptionBatches(fetch)
    expect(batches).toHaveLength(2)
    expect(batches[1]).toMatchObject({
      subscribe: [
        { conversation: 7, docs: [], view: true },
        { conversation: 7, docs: ['test.final'], view: false },
      ],
      unsubscribe: [first.subscribe[0].sub],
    })
    expect(
      server.subscriptions.filter((item) => !item.closed).map((item) => item.conversation),
    ).toEqual([7, 7])
    store.stop()
  })

  it('immediately replaces a stream rejected with 410 instead of waiting for its error event', async () => {
    const { store, fetch, latest, sources, server } = setup(1000)
    fetch.mockResolvedValueOnce(Response.json({ error: 'Event stream ended' }, { status: 410 }))
    const first = latest()
    first.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(first.closed).toBe(true)
    expect(sources).toHaveLength(2)
    expect(store.getState().connection.status).toBe('reconnecting')
    latest().open()
    expect(server.of()?.stream).toBe(latest().id)
    expect(store.getState().connection.status).toBe('open')
    store.stop()
  })

  it('does not notify when reconciliation preserves the same document and view records', async () => {
    const { store, server, latest } = setup()
    latest().open()
    const id = 7 as ConversationId
    const releaseDoc = store.watchDocOf(id, 'test.counter')
    const releaseView = store.watchConversation(id)
    await tick()
    server.of(7, false)!.send('doc', { kind: 'test.counter', value: { count: 1 } })
    server.of(7, true)!.send('view', view([], {}, 7))
    const before = store.getState()
    const listener = vi.fn<() => void>()
    store.subscribe(listener)
    releaseDoc()
    releaseView()
    store.watchDocOf(id, 'test.counter')
    store.watchConversation(id)
    await tick()
    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    store.stop()
  })

  it('shows another conversation on the same stream and falls back to the root when it cannot open', async () => {
    const { store, sources, server, latest, onFallback } = setup()
    latest().open()
    server.of()!.send('view', view([user(1, 'root')]))
    server.refuse(7, 404)
    store.show(7 as ConversationId)
    expect(store.getState().view).toBeUndefined()
    await tick()
    // The server answered 404: the store subscribes the root instead.
    expect(store.getState().requested).toBeUndefined()
    expect(onFallback).toHaveBeenCalledOnce()
    expect(server.of()!.closed).toBe(false)
    expect(server.subscriptions.filter((item) => !item.closed)).toHaveLength(1)
    expect(sources).toHaveLength(1)
    store.stop()
  })

  it('falls back to the root when a restored conversation is refused, and forgets the cached view', async () => {
    const { store, server, latest, onFallback } = setup()
    latest().open()
    const id = 7 as ConversationId
    store.show(id)
    await tick()
    server.of(7)!.send('view', view([user(2, 'cached')], {}, 7))
    store.show(undefined)
    await tick()
    server.refuse(7, 404)
    store.show(id)
    expect(store.getState()).toMatchObject({ restored: true, view: { conversation: { id } } })
    await tick()
    expect(store.getState()).toMatchObject({
      requested: undefined,
      view: undefined,
      restored: false,
    })
    expect(onFallback).toHaveBeenCalledOnce()
    expect(server.of(undefined, true)).toBeDefined()
    store.show(id)
    expect(store.getState()).toMatchObject({ view: undefined, restored: false })
    store.stop()
  })

  it('replaces the stream after an ambiguous batch failure so no watch can be orphaned', async () => {
    for (const failure of [
      'lost after the server handled it',
      'lost before the server saw it',
      'not json',
      'bad shape',
      'bad status',
      'hex key',
      'endpoint 404',
      'status 202',
    ] as const) {
      const { store, server, sources, latest, fetch, onFallback } = setup(1000)
      latest().open()
      await tick()
      const firstStream = latest()
      fetch.mockImplementationOnce(async (path, init) => {
        const { subscribe } = JSON.parse(init?.body as string) as SubscriptionsRequest
        const sub = subscribe[0]?.sub
        if (failure === 'lost before the server saw it') throw new Error('offline')
        if (failure === 'endpoint 404')
          return Response.json({ error: 'Unknown endpoint' }, { status: 404 })
        if (failure === 'status 202')
          return Response.json({ ok: true, refused: {} }, { status: 202 })
        server.handle(path as string, init)
        if (failure === 'not json') return new Response('not json')
        if (failure === 'bad shape') return Response.json({ ok: true, refused: [] })
        if (failure === 'bad status') return Response.json({ ok: true, refused: { [sub]: 200 } })
        if (failure === 'hex key')
          return Response.json({ ok: true, refused: { [`0x${sub.toString(16)}`]: 404 } })
        throw new Error('connection reset')
      })
      store.watchDoc('test.counter')
      await tick()
      expect(firstStream.closed).toBe(true)
      expect(store.getState().connection.status).toBe('reconnecting')
      expect(server.subscriptions.filter((item) => !item.closed)).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(sources).toHaveLength(2)
      latest().open()
      await tick()
      expect(onFallback).not.toHaveBeenCalled()
      const counters = server.subscriptions.filter(
        (item) => !item.closed && item.docs.includes('test.counter'),
      )
      expect(counters).toHaveLength(1)
      counters[0].send('doc', { kind: 'test.counter', value: { count: 1 } })
      expect(store.getState().docs['test.counter']).toEqual({ count: 1 })
      store.stop()
    }
  })

  it('aborts a stalled subscription POST at its deadline and replaces the stream so later changes proceed', async () => {
    const { store, server, sources, fetch, latest } = setup(50, undefined, 200)
    latest().open()
    await tick()
    let aborted = false
    fetch.mockImplementationOnce(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(init.signal?.reason)
          })
        }),
    )
    const first = latest()
    store.show(7 as ConversationId)
    await tick()
    store.watchDoc('test.counter')
    await vi.advanceTimersByTimeAsync(200)
    expect(aborted).toBe(true)
    expect(first.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(sources).toHaveLength(2)
    latest().open()
    await tick()
    expect(server.of(7, true)).toBeDefined()
    expect(server.of(7, false)?.docs).toEqual(['test.counter'])
    store.stop()
  })

  it('aborts an in-flight subscription POST immediately when SSE drops, even without a replacement stream', async () => {
    const { store, fetch, latest } = setup(50, undefined, 200)
    latest().open()
    await tick()
    let aborted = false
    fetch.mockImplementationOnce(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(init.signal?.reason)
          })
        }),
    )
    store.show(7 as ConversationId)
    await tick()
    expect(aborted).toBe(false)
    latest().drop()
    expect(aborted).toBe(true)
    store.stop()
  })

  it('splits a multi-item 413 batch so valid reads still open and only an individually oversized read is refused', async () => {
    const { store, server, sources, fetch, latest } = setup(5)
    latest().open()
    await tick()
    fetch.mockImplementation(async (path, init) => {
      if ((path as string).startsWith('/api/events/')) {
        const body = init?.body as string
        if (body.length > 200) return Response.json({ error: 'Request too large' }, { status: 413 })
      }
      return server.handle(path as string, init) ?? Response.json({ providers: [], models: [] })
    })
    const smallEvents: unknown[] = []
    const bigEvents: unknown[] = []
    store.watchRead(
      { extension: 'test', action: 'small', args: null },
      undefined,
      (event) => void smallEvents.push(event),
    )
    store.watchRead(
      { extension: 'test', action: 'big', args: 'x'.repeat(250) },
      undefined,
      (event) => void bigEvents.push(event),
    )
    await tick()
    expect(sources).toHaveLength(2)
    latest().open()
    await tick()
    await tick()
    expect(bigEvents).toEqual([{ error: 'The server refused this read', status: 413 }])
    const small = server.reads.find((item) => !item.closed && item.read.action === 'small')!
    expect(small).toBeDefined()
    latest().send('read', { result: 'ok', rev: 1 }, small.sub)
    expect(smallEvents).toEqual([{ result: 'ok', rev: 1 }])
    store.stop()
  })

  it('bounds subscription batches by exact UTF-8 byte size including separators', async () => {
    const { store, server, fetch, latest } = setup(5)
    latest().open()
    await tick()
    const before = fetch.mock.calls.length
    const encoder = new TextEncoder()

    // Exact 1 MiB singleton boundary using multibyte UTF-8 ('é' = 1 UTF-16 char, 2 UTF-8 bytes).
    const nextSub = server.subscriptions.length + 1
    const baseSpec = {
      sub: nextSub,
      read: { extension: 'test', action: 'exct1', args: '' },
    }
    const overhead = encoder.encode(
      JSON.stringify({ subscribe: [baseSpec], unsubscribe: [] }),
    ).byteLength
    const exactBytes = 1024 * 1024 - overhead
    const exactArgs = 'é'.repeat(Math.floor(exactBytes / 2)) + (exactBytes % 2 ? 'a' : '')
    const overArgs = `${exactArgs}a`

    const exactEvents: unknown[] = []
    store.watchRead(
      { extension: 'test', action: 'exct1', args: exactArgs },
      undefined,
      (event) => void exactEvents.push(event),
    )
    await tick()
    expect(exactEvents).toEqual([])
    const exactPost = fetch.mock.calls.at(-1)![1]!.body as string
    expect(encoder.encode(exactPost).byteLength).toBe(1024 * 1024)
    expect(server.reads.some((item) => !item.closed && item.read.action === 'exct1')).toBe(true)

    // 1 byte over 1 MiB (same-length action name) is refused locally.
    const overEvents: unknown[] = []
    store.watchRead(
      { extension: 'test', action: 'over1', args: overArgs },
      undefined,
      (event) => void overEvents.push(event),
    )
    await tick()
    expect(overEvents).toEqual([{ error: 'The server refused this read', status: 413 }])

    // Multi-item separator boundary: two reads whose combined size without the comma is 1 MiB, so the comma forces a split.
    const subA = nextSub + 2
    const subB = nextSub + 3
    const twoEmpty = encoder.encode(
      JSON.stringify({
        subscribe: [
          { sub: subA, read: { extension: 'test', action: 'pairA', args: '' } },
          { sub: subB, read: { extension: 'test', action: 'pairB', args: '' } },
        ],
        unsubscribe: [],
      }),
    ).byteLength
    const pairPayloadBytes = 1024 * 1024 - twoEmpty + 1
    const half = Math.floor(pairPayloadBytes / 2)
    const beforePair = fetch.mock.calls.length
    store.watchRead(
      { extension: 'test', action: 'pairA', args: 'a'.repeat(half) },
      undefined,
      () => {},
    )
    store.watchRead(
      { extension: 'test', action: 'pairB', args: 'b'.repeat(pairPayloadBytes - half) },
      undefined,
      () => {},
    )
    await tick()
    await tick()
    const pairPosts = fetch.mock.calls
      .slice(beforePair)
      .filter(([path]) => (path as string).startsWith('/api/events/'))
    expect(pairPosts).toHaveLength(2)

    const allPosts = fetch.mock.calls
      .slice(before)
      .filter(([path]) => (path as string).startsWith('/api/events/'))
    for (const [, init] of allPosts)
      expect(encoder.encode(init?.body as string).byteLength).toBeLessThanOrEqual(1024 * 1024)
    store.stop()
  })

  it('keeps document 413 refusals scoped to their target across reconnect, clears on release, and retries on another conversation', async () => {
    const { store, server, fetch, latest } = setup(5)
    latest().open()
    await tick()

    // Locally oversized doc.
    const hugeDoc = 'd'.repeat(1024 * 1024)
    const releaseHuge = store.watchDoc(hugeDoc)
    await tick()
    const hugeNotices = store
      .getState()
      .notices.filter((n) => n.message.includes('Subscription too large'))
    expect(hugeNotices).toHaveLength(1)
    expect(hugeNotices[0].message.length).toBeLessThan(200)

    // Server-refused 413 on a single doc whose kind has a suffix matching another doc kind ('b').
    fetch.mockResolvedValueOnce(Response.json({ error: 'Request too large' }, { status: 413 }))
    const releaseCompound = store.watchDoc('a:doc:b')
    await tick()
    const releaseSuffix = store.watchDoc('b')
    await tick()
    // Releasing 'b' must NOT clear the refusal on 'a:doc:b'.
    releaseSuffix()
    await tick()
    expect(
      store.getState().notices.filter((n) => n.message.includes('Subscription too large')),
    ).toHaveLength(2)

    // Reconnect on the same target: neither refused doc is POSTed again and no second notice is emitted.
    const beforeReconnect = fetch.mock.calls.length
    latest().drop()
    latest().open()
    await tick()
    await tick()
    const reconnectDocs = fetch.mock.calls
      .slice(beforeReconnect)
      .filter(([path]) => (path as string).startsWith('/api/events/'))
      .flatMap(
        ([, init]) =>
          (JSON.parse(init?.body as string) as SubscriptionsRequest).subscribe as {
            docs?: string[]
          }[],
      )
    expect(reconnectDocs.some((spec) => spec.docs?.includes(hugeDoc))).toBe(false)
    expect(reconnectDocs.some((spec) => spec.docs?.includes('a:doc:b'))).toBe(false)
    expect(
      store.getState().notices.filter((n) => n.message.includes('Subscription too large')),
    ).toHaveLength(2)

    // Explicit root (1) stays quiet; navigating to a non-root conversation (7) attempts the watch; returning to root stays quiet.
    const beforeExplicitRoot = fetch.mock.calls.length
    store.show(1 as ConversationId)
    await tick()
    const explicitRootDocs = fetch.mock.calls
      .slice(beforeExplicitRoot)
      .filter(([path]) => (path as string).startsWith('/api/events/'))
      .flatMap(
        ([, init]) =>
          (JSON.parse(init?.body as string) as SubscriptionsRequest).subscribe as {
            docs?: string[]
          }[],
      )
    expect(explicitRootDocs.some((spec) => spec.docs?.includes('a:doc:b'))).toBe(false)

    store.show(7 as ConversationId)
    await tick()
    expect(server.of(7, false)?.docs).toEqual(['a:doc:b'])

    const beforeBackToRoot = fetch.mock.calls.length
    store.show(undefined)
    await tick()
    const backToRootDocs = fetch.mock.calls
      .slice(beforeBackToRoot)
      .filter(([path]) => (path as string).startsWith('/api/events/'))
      .flatMap(
        ([, init]) =>
          (JSON.parse(init?.body as string) as SubscriptionsRequest).subscribe as {
            docs?: string[]
          }[],
      )
    expect(backToRootDocs.some((spec) => spec.docs?.includes('a:doc:b'))).toBe(false)

    // Releasing and reacquiring 'a:doc:b' on root clears the refusal and opens a fresh subscription.
    releaseCompound()
    await tick()
    const releaseRecovered = store.watchDoc('a:doc:b')
    await tick()
    expect(
      server.subscriptions.some(
        (item) => !item.closed && item.conversation === undefined && item.docs.includes('a:doc:b'),
      ),
    ).toBe(true)

    releaseHuge()
    releaseRecovered()
    store.stop()
  })

  it('does not let a late 413 suppress a reacquired document watch, and reconnects on a singleton view 413', async () => {
    const { store, server, sources, fetch, latest } = setup(5)
    latest().open()
    await tick()

    // Release -> pending 413 resolves -> reacquire must send a fresh POST.
    const pending413 = Promise.withResolvers<Response>()
    fetch.mockImplementationOnce(() => pending413.promise)
    const releaseFirst = store.watchDoc('late.doc')
    await tick()
    releaseFirst()
    pending413.resolve(Response.json({ error: 'Request too large' }, { status: 413 }))
    await Promise.resolve()
    await Promise.resolve()
    const beforeReacquire = fetch.mock.calls.length
    const releaseSecond = store.watchDoc('late.doc')
    await tick()
    const reacquirePosts = fetch.mock.calls
      .slice(beforeReacquire)
      .filter(([path]) => (path as string).startsWith('/api/events/'))
    expect(reacquirePosts.length).toBeGreaterThanOrEqual(1)
    expect(server.of(undefined, false)?.docs).toEqual(['late.doc'])
    releaseSecond()
    await tick()

    // Singleton view 413 (opens.size === 1, closes.length === 0) triggers stream reconnect instead of leaving the view disconnected.
    const sourcesBefore = sources.length
    fetch.mockResolvedValueOnce(Response.json({ error: 'Request too large' }, { status: 413 }))
    const releaseView = store.watchConversation(7 as ConversationId)
    await tick()
    expect(sources.length).toBe(sourcesBefore + 1)
    latest().open()
    await tick()
    expect(server.of(7, true)).toBeDefined()
    releaseView()
    store.stop()
  })

  it('still dispatches valid opens and notifies other refusals when one local 413 callback throws', async () => {
    const { store, server, latest } = setup(5)
    latest().open()
    await tick()
    const secondRefusal: unknown[] = []
    const microtasks: (() => void)[] = []
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementationOnce((fn) => {
      microtasks.push(fn)
    })
    try {
      store.watchRead(
        { extension: 'test', action: 'big-1', args: 'x'.repeat(1_100_000) },
        undefined,
        () => {
          throw new Error('refusal boom')
        },
      )
      store.watchRead(
        { extension: 'test', action: 'big-2', args: 'y'.repeat(1_100_000) },
        undefined,
        (event) => void secondRefusal.push(event),
      )
      store.watchRead({ extension: 'test', action: 'valid', args: null }, undefined, () => {})
      await vi.advanceTimersByTimeAsync(10)
      expect(microtasks).toHaveLength(1)
      expect(() => microtasks[0]()).toThrow('refusal boom')
      await tick()
      expect(server.reads.some((item) => !item.closed && item.read.action === 'valid')).toBe(true)
      expect(secondRefusal).toEqual([{ error: 'The server refused this read', status: 413 }])
    } finally {
      spy.mockRestore()
      store.stop()
    }
  })

  it('sends the closes and opens of a switch in one request', async () => {
    const { store, server, latest, fetch } = setup()
    latest().open()
    store.watchDoc('test.counter')
    await tick()
    const posts = () =>
      fetch.mock.calls.filter(([path]) => (path as string).startsWith('/api/events/')).length
    const before = posts()
    store.show(7 as ConversationId)
    await tick()
    expect(posts() - before).toBe(1)
    expect(
      server.subscriptions.filter((item) => !item.closed).map((item) => item.conversation),
    ).toEqual([7, 7])
    store.stop()
  })

  it('replaces the stream when a close POST fails ambiguously, closing the old watch cleanly', async () => {
    const { store, server, sources, latest, fetch } = setup(1000)
    latest().open()
    const release = store.watchDoc('test.counter')
    await tick()
    const counter = server.of(undefined, false)!
    fetch.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    release()
    await tick()
    expect(counter.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sources).toHaveLength(2)
    latest().open()
    await tick()
    expect(server.subscriptions.filter((item) => !item.closed && item.docs.length)).toEqual([])
    store.stop()
  })

  it('falls back to the root without closing what the server refused alongside the view', async () => {
    const { store, server, latest, fetch, onFallback } = setup()
    latest().open()
    store.watchDoc('test.counter')
    await tick()
    server.refuse(7, 404)
    store.show(7 as ConversationId)
    await tick()
    await tick()
    expect(onFallback).toHaveBeenCalledOnce()
    const batches = fetch.mock.calls
      .filter(([path]) => (path as string).startsWith('/api/events/'))
      .map(
        ([, init]) =>
          JSON.parse(init?.body as string) as {
            subscribe: { sub: number; conversation?: number }[]
            unsubscribe: number[]
          },
      )
    const refused = batches.flatMap((batch) =>
      batch.subscribe.filter((open) => open.conversation === 7).map((open) => open.sub),
    )
    expect(refused).toHaveLength(2)
    expect(
      batches.flatMap((batch) => batch.unsubscribe).filter((sub) => refused.includes(sub)),
    ).toEqual([])
    expect(
      server.subscriptions.filter((item) => !item.closed).map((item) => item.conversation),
    ).toEqual([undefined, undefined])
    store.stop()
  })

  it('does not ask the server to close a subscription it refused', async () => {
    const { store, server, latest, fetch } = setup()
    latest().open()
    await tick()
    server.refuse(9, 404)
    const release = store.watchDocOf(9 as ConversationId, 'test.plan')
    await tick()
    await tick()
    const closes = fetch.mock.calls
      .filter(([path]) => (path as string).startsWith('/api/events/'))
      .flatMap(
        ([, init]) => (JSON.parse(init?.body as string) as { unsubscribe: number[] }).unsubscribe,
      )
    expect(closes).toEqual([])
    release()
    store.stop()
  })

  it('keeps the conversation list as it was when a reconnect resends it unchanged', async () => {
    const { store, latest } = setup()
    latest().open()
    const list = [{ id: 1 as ConversationId, cwd: '/my-app', busy: false }]
    latest().send('conversations', list)
    const before = store.getState().conversations
    latest().drop()
    latest().open()
    latest().send('conversations', list)
    // The same object: nothing that reads the list renders again on a reconnect.
    expect(store.getState().conversations).toBe(before)
    latest().send('conversations', [{ ...list[0], busy: true }])
    expect(store.getState().conversations[0].busy).toBe(true)
    store.stop()
  })

  it('keeps unchanged rows when the list is resent for another row', () => {
    const { store, latest } = setup()
    latest().open()
    latest().send('conversations', [
      { id: 1 as ConversationId, title: 'my-app', busy: false },
      { id: 2 as ConversationId, title: 'fix login', busy: false },
    ])
    const [root, branch] = store.getState().conversations
    latest().send('conversations', [
      { id: 1 as ConversationId, title: 'my-app', busy: false },
      { id: 2 as ConversationId, title: 'fix login', busy: true, answerAt: 5 },
    ])
    // Readers of row 1 (`useConversationSummary(1)`) see the same object and skip the re-render.
    expect(store.getState().conversations[0]).toBe(root)
    expect(store.getState().conversations[1]).not.toBe(branch)
    expect(store.getState().conversations[1]).toMatchObject({ busy: true, answerAt: 5 })
    store.stop()
  })

  it('shows a conversation seen before at once, until its subscription brings a different snapshot', async () => {
    const { store, server, latest } = setup()
    latest().open()
    server.of()!.send('view', view([user(1, 'root')]))
    store.show(7 as ConversationId)
    await tick()
    const seven = view([user(2, 'seven')], {}, 7)
    server.of(7)!.send('view', seven)
    expect(store.getState().restored).toBe(false)

    // Back to the root, then to 7 again: its last replica shows before any subscription answers.
    store.show(undefined)
    expect(store.getState().view).toBeUndefined()
    store.show(7 as ConversationId)
    const kept = store.getState()
    expect(kept.restored).toBe(true)
    expect(kept.view?.entries.map((entry) => entry.id)).toEqual([2])
    await tick()
    // The same snapshot as last time changes nothing but the flag; a different one replaces the replica.
    server.of(7)!.send('view', seven)
    expect(store.getState().view).toBe(kept.view)
    expect(store.getState().restored).toBe(false)
    server.of(7)!.send('view', view([user(2, 'seven'), user(4, 'new')], {}, 7))
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2, 4])

    // Ops applied since make the replica newer than its snapshot: the next snapshot replaces it again.
    server.of(7)!.send('ops', [['p', ['entries'], 2, 0, [user(5, 'later')]]])
    store.show(undefined)
    store.show(7 as ConversationId)
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2, 4, 5])
    await tick()
    server.of(7)!.send('view', seven)
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2])
    store.stop()
  })

  it('ignores what the conversation shown before still sends once another is shown', async () => {
    const { store, server, latest } = setup()
    latest().open()
    const root = server.of()!
    root.send('view', view([user(1, 'root')], { 'pi.live': { tools: [{ id: 'a' }] } }))
    store.show(7 as ConversationId)
    await tick()
    server.of(7)!.send('view', view([user(2, 'seven')], { 'pi.live': {} }, 7))
    store.show(undefined)
    await tick()
    const back = server.of()!
    back.send('view', view([user(1, 'root')], { 'pi.live': { tools: [{ id: 'a' }] } }))

    store.show(7 as ConversationId)
    await tick()
    expect(back.closed).toBe(true)
    const kept = store.getState().view
    expect(() =>
      back.send('ops', [['s', ['docs', 'pi.live', 'tools', 0, 'id'], 'b']]),
    ).not.toThrow()
    back.send('view', view([user(3, 'root again')]))
    expect(store.getState().view).toBe(kept)
    expect(kept?.conversation.id).toBe(7)
    store.stop()
  })

  it('keeps the last six views shown and forgets the rest', async () => {
    const { store, server, latest } = setup()
    latest().open()
    for (let id = 2; id <= 8; id++) {
      store.show(id as ConversationId)
      await tick()
      server.of(id)!.send('view', view([user(id, `c${id}`)], {}, id))
    }
    // Seven shown after the root: the oldest, 2, is gone; 3 is still at hand.
    store.show(2 as ConversationId)
    expect(store.getState().view).toBeUndefined()
    expect(store.getState().restored).toBe(false)
    store.show(3 as ConversationId)
    expect(store.getState().restored).toBe(true)
    expect(store.getState().view?.conversation.id).toBe(3)
    store.stop()
  })

  it('refreshes models after (re)starts and keeps notices', async () => {
    const { store, latest, models } = setup()
    const source = latest()
    source.open()
    const system = {
      process: { pid: 1, generation: 1, node: 'v26', startedAt: '', url: '' },
    } as ServerEvents['system']
    source.send('system', system)
    await vi.waitFor(() => expect(store.getState().models).toEqual({ providers: [], models: [] }))
    expect(models()).toBe(1)
    source.send('system', {
      ...system,
      process: { ...system.process, generation: 2 },
    })
    expect(models()).toBe(2)

    source.send('notice', {
      level: 'warning',
      message: 'Unknown extension document: x',
    })
    expect(store.getState().notices.map((notice) => notice.message)).toEqual([
      'Unknown extension document: x',
    ])
    store.stop()
  })

  it('retries models a failed fetch left missing, also when the system info is unchanged', async () => {
    const { store, latest, fetch, models } = setup()
    latest().open()
    fetch.mockRejectedValueOnce(new Error('offline'))
    const system = {
      process: { pid: 1, generation: 1, node: 'v26', startedAt: '', url: '' },
    } as ServerEvents['system']
    latest().send('system', system)
    await vi.waitFor(() => expect(models()).toBe(1))
    expect(store.getState().models).toBeUndefined()
    latest().send('system', system)
    await vi.waitFor(() => expect(store.getState().models).toEqual({ providers: [], models: [] }))
    store.stop()
  })
})

it('retries a read by reconnecting after an unconfirmed batch-level 403', async () => {
  const { store, fetch, server, sources, latest } = setup()
  latest().open()
  await tick()
  fetch.mockResolvedValueOnce(Response.json({ error: 'Forbidden' }, { status: 403 }))
  const onEvent = vi.fn<(event: ReadPayload & { rev?: number }) => void>()
  store.watchRead({ extension: 'test', action: 'read', args: null }, undefined, onEvent)
  await tick()
  expect(onEvent).not.toHaveBeenCalled()
  expect(sources).toHaveLength(2)
  latest().open()
  await tick()
  const reopened = server.reads.at(-1)!
  expect(reopened.closed).toBe(false)
  latest().send('read', { result: 'available', rev: 1 }, reopened.sub)
  expect(onEvent).toHaveBeenCalledExactlyOnceWith({ result: 'available', rev: 1 })
  store.stop()
})

it('does not retry a terminally refused read until its watch is replaced, even in the same tick', async () => {
  const { store, fetch, server, latest } = setup()
  latest().open()
  await tick()
  fetch.mockImplementationOnce(async (_path, init) => {
    const { subscribe } = JSON.parse(init?.body as string) as SubscriptionsRequest
    return Response.json({ ok: true, refused: { [subscribe[0].sub]: 403 } })
  })
  const read = { extension: 'test', action: 'read', args: null }
  const onRefusal = vi.fn<(event: ReadPayload & { rev?: number }) => void>()
  const release = store.watchRead(read, undefined, onRefusal)
  await tick()
  expect(onRefusal).toHaveBeenCalledExactlyOnceWith({
    error: 'The server refused this read',
    status: 403,
  })
  const before = subscriptionBatches(fetch).length
  await tick()
  expect(subscriptionBatches(fetch)).toHaveLength(before)
  release()
  const onEvent = vi.fn<(event: ReadPayload & { rev?: number }) => void>()
  store.watchRead(read, undefined, onEvent)
  await tick()
  expect(subscriptionBatches(fetch)).toHaveLength(before + 1)
  latest().send('read', { result: 'available', rev: 1 }, server.reads.at(-1)!.sub)
  expect(onEvent).toHaveBeenCalledExactlyOnceWith({ result: 'available', rev: 1 })
  store.stop()
})

it('opens a read watch again on same-tick remount so a cached answer is replayed', async () => {
  const action = vi.fn<() => Response>(() => Response.json({ result: 'shared' }))
  const { store, server, latest } = setup(5, action)
  latest().open()
  const read = { extension: 'test', action: 'read', args: null }
  const firstEvent = vi.fn<(event: ReadPayload & { rev?: number }) => void>()
  const release = store.watchRead(read, undefined, firstEvent)
  await tick()
  const first = server.reads.at(-1)!
  expect(firstEvent).toHaveBeenCalledExactlyOnceWith({ result: 'shared', rev: expect.any(Number) })
  release()
  const onEvent = vi.fn<(event: ReadPayload & { rev?: number }) => void>()
  store.watchRead(read, undefined, onEvent)
  latest().send('read', { result: 'retired', rev: 99 }, first.sub)
  expect(onEvent).not.toHaveBeenCalled()
  await tick()
  expect(first.closed).toBe(true)
  expect(onEvent).toHaveBeenCalledExactlyOnceWith(firstEvent.mock.calls[0][0])
  expect(action).toHaveBeenCalledOnce()
  store.stop()
})

it('gives a read the server refused as too large its error, instead of retrying it', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers()
  onTestFinished(() => void vi.useRealTimers())
  const { store, fetch, latest } = setup()
  onTestFinished(() => store.stop())
  latest().open()
  await vi.advanceTimersByTimeAsync(10)
  fetch.mockImplementationOnce(async () =>
    Response.json({ error: 'Request too large' }, { status: 413 }),
  )
  const events: unknown[] = []
  store.watchRead(
    { extension: 'test', action: 'big', args: 'x' },
    undefined,
    (event) => void events.push(event),
  )
  await vi.advanceTimersByTimeAsync(10)
  expect(events).toEqual([{ error: 'The server refused this read', status: 413 }])
  const posts = fetch.mock.calls.length
  await vi.advanceTimersByTimeAsync(1000)
  expect(fetch.mock.calls.length).toBe(posts)
})

it('recovers from a raw SSE read frame with a non-safe-integer revision without reconnecting', async () => {
  const { store, server, sources, latest } = setup()
  const { createReads } = await import('../../web/src/sdk/reads.ts')
  const readAction = vi.fn<() => Promise<{ result: unknown; rev?: number }>>()
  const reads = createReads(readAction as never, store)
  latest().open()
  await tick()
  const onError = vi.fn<(error: unknown) => void>()
  const read = reads.get('test', 'status', null)
  read.use({ onError })
  await tick()
  const sub = server.reads.at(-1)!.sub
  latest().dispatchEvent(
    new MessageEvent('read', {
      data: `${sub}\n{"error":"temporary","status":500,"rev":1e400}`,
    }),
  )
  expect(read.get().error).toMatchObject({ status: 500, message: 'temporary', rev: undefined })
  expect(onError).toHaveBeenCalledTimes(1)
  latest().send('read', { result: 'recovered', rev: 2 }, sub)
  expect(read.get()).toMatchObject({ data: 'recovered', error: undefined, settled: true })
  latest().dispatchEvent(
    new MessageEvent('read', {
      data: `${sub}\n{"error":"late malformed","status":500,"rev":1e400}`,
    }),
  )
  expect(read.get()).toMatchObject({ data: 'recovered', error: undefined, settled: true })
  expect(onError).toHaveBeenCalledTimes(1)
  expect(sources).toHaveLength(1)
  store.stop()
})
