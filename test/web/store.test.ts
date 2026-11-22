import type { ConversationView, ConversationId } from '@earendil-works/pi-durable'
import type { Op } from '@earendil-works/chord/delta'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../../web/src/sdk/store.ts'
import type { ServerEvents } from '../../shared/protocol.ts'

import { FakeSource, fakeSubscriptions } from './fake-source.ts'

function setup(retryMs = 5) {
  const sources: FakeSource[] = []
  const server = fakeSubscriptions(sources)
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

  it('retires an open whose answer was lost, and keeps its close until the server confirms it', async () => {
    const { store, server, latest, fetch } = setup(1000)
    latest().open()
    await tick()
    const batches: { subscribe: { sub: number }[]; unsubscribe: number[] }[] = []
    const answer = (
      kind: 'lost after the server handled it' | 'lost before the server saw it' | 'not json',
    ) =>
      fetch.mockImplementationOnce(async (path, init) => {
        batches.push(JSON.parse(init?.body as string))
        if (kind === 'lost before the server saw it') throw new Error('offline')
        server.handle(path as string, init)
        if (kind === 'not json') return new Response('not json')
        throw new Error('connection reset')
      })
    fetch.mockImplementation(async (path, init) => {
      if ((path as string).startsWith('/api/events/'))
        batches.push(JSON.parse(init?.body as string))
      return server.handle(path as string, init) ?? Response.json({ providers: [], models: [] })
    })
    const live = () => server.subscriptions.filter((item) => !item.closed && item.docs.length)

    // The open reaches the server but its answer is lost; the close sent at once never reaches it.
    answer('lost after the server handled it')
    answer('lost before the server saw it')
    store.watchDoc('test.counter')
    await tick()
    const [first] = batches[0].subscribe
    expect(batches[1]).toEqual({ subscribe: [], unsubscribe: [first.sub] })
    expect(live().map((item) => item.sub)).toEqual([first.sub])

    // The retry carries that close again; the server handles it, but its answer cannot be read, so the retried open
    // is closed in turn and opened once more.
    answer('not json')
    await vi.advanceTimersByTimeAsync(1000)
    expect(batches[2].unsubscribe).toEqual([first.sub])
    const second = batches[2].subscribe[0].sub
    expect(batches[3]).toEqual({ subscribe: [], unsubscribe: [first.sub, second] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(batches.at(-1)!.subscribe).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)
    const settled = batches.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(batches).toHaveLength(settled)
    expect(live()).toHaveLength(1)
    const [only] = live()
    expect(only.sub).toBeGreaterThan(second)
    only.send('doc', { kind: 'test.counter', value: { count: 1 } })
    expect(store.getState().docs['test.counter']).toEqual({ count: 1 })
    store.stop()
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

  it('sends a lost close again by itself, also after an answer of the wrong shape', async () => {
    const { store, server, latest, fetch } = setup(1000)
    latest().open()
    const release = store.watchDoc('test.counter')
    await tick()
    const counter = server.of(undefined, false)!
    fetch.mockImplementationOnce(async () => {
      throw new Error('offline')
    })
    fetch.mockImplementationOnce(async () => Response.json({}))
    release()
    await tick()
    expect(counter.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(counter.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(counter.closed).toBe(true)
    store.stop()
  })

  it('takes an answer that does not match its request for a lost one, and leaves other subscriptions alone', async () => {
    for (const refused of [[], 'shown view'] as const) {
      const { store, server, latest, fetch } = setup(1000)
      latest().open()
      const counter = store.watchDoc('test.counter')
      await tick()
      const shown = server.of(undefined, true)!
      const doc = server.of(undefined, false)!
      // The close never reaches the server, and the answer that comes back does not fit the request.
      fetch.mockImplementationOnce(async () =>
        Response.json({
          ok: true,
          refused: refused === 'shown view' ? { [shown.sub]: 404 } : refused,
        }),
      )
      counter()
      await tick()
      expect(doc.closed).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)
      expect(doc.closed).toBe(true)
      shown.send('view', view([user(1, 'still shown')]))
      expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([1])
      store.stop()
    }
  })

  it('takes a refusal of its own open with a bad key or status for a lost answer, and closes what may have opened', async () => {
    for (const bad of ['status 200', 'hex key'] as const) {
      const { store, server, latest, fetch } = setup(1000)
      latest().open()
      await tick()
      fetch.mockImplementationOnce(async (path, init) => {
        server.handle(path as string, init)
        const [{ sub }] = (JSON.parse(init?.body as string) as { subscribe: { sub: number }[] })
          .subscribe
        return Response.json({
          ok: true,
          refused: bad === 'status 200' ? { [sub]: 200 } : { [`0x${sub.toString(16)}`]: 404 },
        })
      })
      store.watchDoc('test.counter')
      await tick()
      await vi.advanceTimersByTimeAsync(1000)
      const counters = server.subscriptions.filter((item) => item.docs.includes('test.counter'))
      expect(counters.map((item) => item.closed)).toEqual([true, false])
      store.stop()
    }
  })

  it('retries a request the endpoint answered 404 without leaving the conversation', async () => {
    const { store, server, latest, fetch, onFallback } = setup()
    latest().open()
    await tick()
    fetch.mockImplementationOnce(async () =>
      Response.json({ error: 'Unknown endpoint' }, { status: 404 }),
    )
    store.show(7 as ConversationId)
    await tick()
    await tick()
    expect(onFallback).not.toHaveBeenCalled()
    expect(store.getState().requested).toBe(7)
    expect(server.of(7, true)).toBeDefined()
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
