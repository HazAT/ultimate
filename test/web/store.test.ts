import type { Op } from '@earendil-works/chord/delta'
import type { ConversationView } from '@earendil-works/pi-durable'
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
    const first = server.of()!
    const release = store.watchDoc('test.counter')
    await tick()
    // The shown conversation's subscription is replaced on the same stream.
    expect(sources).toHaveLength(1)
    expect(first.closed).toBe(true)
    const main = server.of()!
    expect(main.docs).toEqual(['test.counter'])

    main.send('doc', { kind: 'test.counter', value: { count: 0 } })
    main.send('docOps', {
      kind: 'test.counter',
      ops: [['s', ['count'], 1]],
    })
    expect(store.getState().docs['test.counter']).toEqual({ count: 1 })
    // Documents nobody asked for are ignored.
    main.send('doc', { kind: 'other', value: { x: 1 } })
    expect(store.getState().docs.other).toBeUndefined()

    release()
    expect(store.getState().docs['test.counter']).toBeUndefined()
    main.send('docOps', {
      kind: 'test.counter',
      ops: [['s', ['count'], 2]],
    })
    expect(store.getState().docs['test.counter']).toBeUndefined()
    // Watched again: the old subscription's ops wait for the new subscription's snapshot.
    store.watchDoc('test.counter')
    main.send('docOps', {
      kind: 'test.counter',
      ops: [['s', ['count'], 3]],
    })
    expect(store.getState().docs['test.counter']).toBeUndefined()
    await tick()
    server.of()!.send('doc', { kind: 'test.counter', value: { count: 3 } })
    expect(store.getState().docs['test.counter']).toEqual({ count: 3 })
    store.stop()
  })

  it('streams documents of given conversations on one subscription per conversation', async () => {
    const { store, sources, server, latest } = setup()
    latest().open()
    const tasks = store.watchDocOf(1, 'test.tasks')
    const tasksAgain = store.watchDocOf(1, 'test.tasks')
    const overview = store.watchDocOf(1, 'test.overview')
    const plan = store.watchDocOf(7, 'test.plan')
    await tick()
    // All on the tab's one stream: the shown conversation, then one subscription of all kinds per conversation.
    expect(sources).toHaveLength(1)
    expect(
      server.subscriptions.map((item) => ({
        conversation: item.conversation,
        docs: item.docs,
        view: item.view,
        closed: item.closed,
      })),
    ).toEqual([
      { docs: [], view: true, closed: false },
      { conversation: 1, docs: ['test.overview', 'test.tasks'], view: false, closed: false },
      { conversation: 7, docs: ['test.plan'], view: false, closed: false },
    ])
    const root = server.of(1)!
    const coordinator = server.of(7)!

    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 0]] })
    expect(store.getState().docsOf[1]).toEqual({})
    root.send('doc', { kind: 'test.tasks', value: { n: 1 } })
    root.send('docOps', { kind: 'test.tasks', ops: [['s', ['n'], 2]] })
    coordinator.send('doc', { kind: 'test.plan', value: { epics: {} } })
    expect(store.getState().docsOf).toEqual({
      1: { 'test.tasks': { n: 2 } },
      7: { 'test.plan': { epics: {} } },
    })
    // Documents of the shown conversation are a separate replica.
    expect(store.getState().docs).toEqual({})

    // Showing another conversation leaves these subscriptions alone.
    store.show(7)
    await tick()
    expect([root.closed, coordinator.closed]).toEqual([false, false])

    // A refused subscription is tried again.
    server.refuse(1, 500)
    overview()
    await tick()
    expect(server.of(1)).toBeUndefined()
    server.refuse(1, undefined)
    await tick()
    expect(server.of(1)!.docs).toEqual(['test.tasks'])

    // A new stream (a restart) gets every subscription again; the value stays until its snapshot.
    latest().drop()
    latest().open()
    const reopened = server.of(1)!
    expect(reopened.stream).toBe(latest().id)
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 2 })
    reopened.send('doc', { kind: 'test.tasks', value: { n: 3 } })
    root.send('doc', { kind: 'test.tasks', value: { n: 0 } })
    expect(store.getState().docsOf[1]['test.tasks']).toEqual({ n: 3 })
    expect(server.of(7)!.stream).toBe(latest().id)

    // Released and watched again before the next tick: the subscription carries on.
    overview()
    const watched = store.watchDocOf(1, 'test.overview')
    await tick()
    const both = server.of(1)!
    expect(both.docs).toEqual(['test.overview', 'test.tasks'])
    watched()
    store.watchDocOf(1, 'test.overview')
    await tick()
    expect(both.closed).toBe(false)

    // A kind nobody watches leaves its conversation's subscription; the last one closes it.
    tasks()
    await tick()
    expect(both.closed).toBe(false)
    tasksAgain()
    await tick()
    expect(both.closed).toBe(true)
    expect(server.of(1)!.docs).toEqual(['test.overview'])
    expect(store.getState().docsOf[1]).toEqual({})
    plan()
    await tick()
    // Only the shown conversation's own subscription of 7 is left.
    const seven = server.subscriptions.filter((item) => !item.closed && item.conversation === 7)
    expect(seven.map((item) => item.docs)).toEqual([[]])
    expect(store.getState().docsOf[7]).toBeUndefined()

    store.stop()
    expect(latest().closed).toBe(true)
  })

  it('shows another conversation on the same stream and falls back to the root when it cannot open', async () => {
    const { store, sources, server, latest, onFallback } = setup()
    latest().open()
    server.of()!.send('view', view([user(1, 'root')]))
    server.refuse(7, 404)
    store.show(7)
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

  it('keeps the conversation list as it was when a reconnect resends it unchanged', async () => {
    const { store, latest } = setup()
    latest().open()
    const list = [{ id: 1, cwd: '/my-app', busy: false }]
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
      { id: 1, title: 'my-app', busy: false },
      { id: 2, title: 'fix login', busy: false },
    ])
    const [root, branch] = store.getState().conversations
    latest().send('conversations', [
      { id: 1, title: 'my-app', busy: false },
      { id: 2, title: 'fix login', busy: true, answerAt: 5 },
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
    store.show(7)
    await tick()
    const seven = view([user(2, 'seven')], {}, 7)
    server.of(7)!.send('view', seven)
    expect(store.getState().restored).toBe(false)

    // Back to the root, then to 7 again: its last replica shows before any subscription answers.
    store.show(undefined)
    expect(store.getState().view).toBeUndefined()
    store.show(7)
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
    store.show(7)
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2, 4, 5])
    await tick()
    server.of(7)!.send('view', seven)
    expect(store.getState().view?.entries.map((entry) => entry.id)).toEqual([2])
    store.stop()
  })

  it('keeps the last six views shown and forgets the rest', async () => {
    const { store, server, latest } = setup()
    latest().open()
    for (let id = 2; id <= 8; id++) {
      store.show(id)
      await tick()
      server.of(id)!.send('view', view([user(id, `c${id}`)], {}, id))
    }
    // Seven shown after the root: the oldest, 2, is gone; 3 is still at hand.
    store.show(2)
    expect(store.getState().view).toBeUndefined()
    expect(store.getState().restored).toBe(false)
    store.show(3)
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
