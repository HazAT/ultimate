/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createMemo, createRoot, flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Op } from '@earendil-works/chord/delta'
import { docRef } from '../../shared/extension-api.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: async (path, init) =>
      harness.server?.handle(path as string, init) ?? Response.json({ ok: true }),
  })
  return { store, uiState: createUiState(undefined), api: {} }
})

import { store } from '../../web/src/sdk/client.ts'
import { useDoc, useDocOf } from '../../web/src/sdk/solid.ts'

type Board = {
  title: string
  columns: { name: string; cards: string[] }[]
  meta?: { owner: string }
  note?: string
}
const board = docRef<Board>('test.board')
const initial: Board = {
  title: 'Plan',
  columns: [
    { name: 'todo', cards: ['a', 'b'] },
    { name: 'done', cards: [] },
  ],
  meta: { owner: 'me' },
}

harness.server = fakeSubscriptions(harness.sources)
const disposers: (() => void)[] = []
beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  harness.server!.subscriptions.length = 0
  store.show(undefined)
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  flush()
  store.stop()
  vi.useRealTimers()
})
const tick = () => vi.advanceTimersByTimeAsync(10)
const source = (id?: number) => harness.server!.of(id)!
function mount<T>(read: () => T): T {
  return createRoot((dispose) => {
    disposers.push(dispose)
    return read()
  })
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

it('reruns only the readers of the path a docOps batch changed', async () => {
  const doc = mount(() => useDoc(board))
  flush()
  await tick()
  source().send('doc', { kind: board.kind, value: initial })
  let titleRuns = 0
  let cardsRuns = 0
  const title = mount(() => createMemo(() => (titleRuns++, doc()?.title)))
  const cards = mount(() => createMemo(() => (cardsRuns++, doc()?.columns[0].cards.join())))
  flush()
  expect([title(), cards()]).toEqual(['Plan', 'a,b'])
  const before = { titleRuns, cardsRuns }

  source().send('docOps', { kind: board.kind, ops: [['s', ['columns', 0, 'cards', 1], 'c']] })
  flush()
  expect([title(), cards()]).toEqual(['Plan', 'a,c'])
  expect(cardsRuns).toBe(before.cardsRuns + 1)
  expect(titleRuns).toBe(before.titleRuns)
})

it('matches the immutable replica after every kind of op, and never writes into it', async () => {
  const id = 7 as ConversationId
  const doc = mount(() => useDocOf(() => id, board))
  flush()
  await tick()
  source(7).send('doc', { kind: board.kind, value: initial })
  flush()
  const immutable = () => store.getState().docsOf[7]?.[board.kind]
  deepFreeze(immutable())

  const batches: Op[][] = [
    [
      ['s', ['note'], 'x'],
      ['a', ['note'], 'yz'],
      ['d', ['meta']],
      ['p', ['columns', 0, 'cards'], 1, 1, ['b2', 'b3']],
      ['s', ['columns', 1, 'cards'], ['z']],
      ['t', ['note'], 2],
    ],
    [['r', { title: 'Reset', columns: [{ name: 'only', cards: ['q'] }] }]],
    [
      ['s', ['title'], 'After'],
      ['p', ['columns'], 1, 0, [{ name: 'new', cards: [] }]],
    ],
  ]
  for (const ops of batches) {
    const copy = structuredClone(immutable())
    source(7).send('docOps', { kind: board.kind, ops })
    flush()
    expect(doc()).toEqual(immutable())
    expect(JSON.parse(JSON.stringify(doc()))).toEqual(immutable())
    deepFreeze(immutable())
    expect(copy).not.toEqual(immutable())
  }
  expect(doc()).toEqual({
    title: 'After',
    columns: [
      { name: 'only', cards: ['q'] },
      { name: 'new', cards: [] },
    ],
  })
})

it('follows appends, prepends and replace-then-edit batches exactly, rows included', async () => {
  const doc = mount(() => useDoc(board))
  flush()
  await tick()
  source().send('doc', { kind: board.kind, value: initial })
  const length = mount(() => createMemo(() => doc()?.columns[0].cards.length))
  const names = mount(() =>
    createMemo(() =>
      doc()
        ?.columns.map((column) => column.name)
        .join(),
    ),
  )
  flush()
  expect([length(), names()]).toEqual([2, 'todo,done'])
  const replica = () => store.getState().docs[board.kind]

  source().send('docOps', { kind: board.kind, ops: [['s', ['columns', 0, 'cards', 2], 'c']] })
  flush()
  expect(length()).toBe(3)
  expect(JSON.parse(JSON.stringify(doc()))).toEqual(replica())

  source().send('docOps', {
    kind: board.kind,
    ops: [['p', ['columns'], 0, 0, [{ name: 'first', cards: [] }]]],
  })
  flush()
  expect(names()).toBe('first,todo,done')
  expect(JSON.parse(JSON.stringify(doc()))).toEqual(replica())

  source().send('docOps', {
    kind: board.kind,
    ops: [
      ['r', { ...initial, note: 'start' }],
      ['a', ['note'], '!'],
    ],
  })
  flush()
  expect(doc()?.note).toBe('start!')
  expect(replica()).toMatchObject({ note: 'start!' })
})

it('drops a shown document from the server subscription once its last reader is gone', async () => {
  const dispose = createRoot((done) => {
    useDoc(board)
    return done
  })
  flush()
  await tick()
  expect(source().docs).toContain(board.kind)
  dispose()
  flush()
  await tick()
  expect(source().docs).not.toContain(board.kind)
})

it('clears the shown documents when show() switches conversations', async () => {
  const doc = mount(() => useDoc(board))
  flush()
  await tick()
  source().send('doc', { kind: board.kind, value: initial })
  flush()
  expect(doc()?.title).toBe('Plan')

  store.show(9 as ConversationId)
  flush()
  expect(doc()).toBeUndefined()
  await tick()
  source(9).send('doc', { kind: board.kind, value: { ...initial, title: 'Nine' } })
  flush()
  expect(doc()?.title).toBe('Nine')
})

it('reads a kind named like an Object method as missing, and releases its watch', async () => {
  const odd = docRef<Board>('toString')
  const dispose = createRoot((done) => {
    const doc = useDoc(odd)
    expect(doc()).toBeUndefined()
    return done
  })
  flush()
  await tick()
  expect(source().docs).toContain('toString')
  dispose()
  flush()
  await tick()
  expect(source().docs).not.toContain('toString')
})
