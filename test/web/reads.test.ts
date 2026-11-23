import { expect, it, vi } from 'vitest'
import type { ReadEvent, ReadSpec } from '../../shared/protocol.ts'
import { ActionError } from '../../web/src/sdk/api.ts'
import type { Api } from '../../web/src/sdk/api.ts'
import { createReads } from '../../web/src/sdk/reads.ts'

function setup(status = 'open') {
  const watched: { read: ReadSpec; every?: number; send: (event: ReadEvent) => void }[] = []
  const listeners = new Set<() => void>()
  let connection = status
  const store = {
    notify: vi.fn<(notice: unknown) => void>(),
    getState: () => ({ connection: { status: connection } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    watchRead: (read: ReadSpec, every: number | undefined, send: (event: ReadEvent) => void) => {
      const watch = { read, every, send }
      watched.push(watch)
      return () => void watched.splice(watched.indexOf(watch), 1)
    },
  }
  const connect = (next: string) => {
    connection = next
    for (const listener of listeners) listener()
  }
  const action = vi.fn<() => Promise<unknown>>()
  return {
    watched,
    store,
    action,
    connect,
    reads: createReads({ action } as unknown as Api, store as never),
  }
}

it('subscribes once per action and args for all readers, at the fastest interval, until the last leaves', () => {
  const { watched, reads, action } = setup()
  const read = reads.get('test', 'status', null)
  const first = read.use({})
  const second = reads.get('test', 'status', null).use({ every: 5000 })
  expect(watched).toMatchObject([{ read: { extension: 'test', action: 'status' }, every: 5000 }])
  watched[0].send({ result: 'answer' })
  expect(read.get()).toMatchObject({ data: 'answer', settled: true })
  second()
  expect(watched).toMatchObject([{ every: undefined }])
  first()
  expect(watched).toEqual([])
  expect(action).not.toHaveBeenCalled()
})

it("shows a read's failure through its reader's onError, or else as a notice, once per new answer", () => {
  const { watched, reads, store } = setup()
  const onError = vi.fn<(error: ActionError) => void>()
  const read = reads.get('test', 'status', null)
  const release = read.use({ onError })
  watched[0].send({ error: 'boom', status: 500 })
  watched[0].send({ error: 'boom', status: 500 })
  expect(onError).toHaveBeenCalledTimes(1)
  expect(read.get().error).toMatchObject({ extension: 'test', action: 'status', status: 500 })
  release()
  read.use({})
  watched[0].send({ error: 'other', status: 404 })
  expect(store.notify).toHaveBeenCalledWith({ level: 'error', message: 'test/status: other' })
})

it("keeps the stream's newer answer when an older refetch answers last", async () => {
  const { watched, reads, action } = setup()
  const read = reads.get('test', 'status', null)
  read.use({})
  const older = Promise.withResolvers<unknown>()
  action.mockReturnValueOnce(older.promise)
  const refetched = read.refetch()
  watched[0].send({ result: 'newer' })
  older.resolve('older')
  expect(await refetched).toBe('older')
  expect(read.get()).toMatchObject({ data: 'newer', loading: false, settled: true })
})

it('lets a running refetch finish and runs once more after it, however often it is asked meanwhile', async () => {
  const { reads, action } = setup()
  const read = reads.get('test', 'status', null)
  const first = Promise.withResolvers<unknown>()
  action.mockReturnValueOnce(first.promise).mockResolvedValueOnce('second')
  const running = read.refetch()
  await Promise.resolve()
  const again = [read.refetch(), read.refetch(), read.refetch()]
  await Promise.resolve()
  await Promise.resolve()
  expect(action).toHaveBeenCalledTimes(1)
  first.resolve('first')
  expect(await running).toBe('first')
  expect(await Promise.all(again)).toEqual(['second', 'second', 'second'])
  expect(action).toHaveBeenCalledTimes(2)
  expect(read.get()).toMatchObject({ data: 'second', loading: false })
})

it('keeps ui steps waiting for the stream even when a refetch answers first', async () => {
  const { watched, reads, action } = setup()
  const read = reads.get('test', 'status', null)
  read.use({})
  action.mockResolvedValueOnce('over http')
  await read.refetch()
  let settled = false
  const done = reads.settledInUse().then(() => (settled = true))
  await Promise.resolve()
  expect(settled).toBe(false)
  watched[0].send({ result: 'from the stream' })
  await done
  expect(read.get().data).toBe('from the stream')
})

it('answers a refetch of an unwatched read itself, and stays quiet when its request never reached the server', async () => {
  const { reads, action, store } = setup()
  const read = reads.get('test', 'status', null)
  action.mockResolvedValueOnce('fresh')
  await read.refetch()
  expect(read.get()).toMatchObject({ data: 'fresh', loading: false })
  action.mockRejectedValueOnce(new ActionError('test', 'status', 0, 'Failed to fetch'))
  await read.refetch()
  expect(store.notify).not.toHaveBeenCalled()
  expect(read.get()).toMatchObject({ data: 'fresh', loading: false })
})

it('settles in-use reads once each mounted read has its first answer, so ui steps see the controls it renders', async () => {
  const { watched, reads } = setup()
  reads.get('test', 'idle', null)
  reads.get('test', 'status', null).use({})
  let settled = false
  const done = reads.settledInUse().then(() => (settled = true))
  await Promise.resolve()
  expect(settled).toBe(false)
  watched[0].send({ result: 'answer' })
  await done
  expect(settled).toBe(true)
})

it('does not hold ui steps for reads while the stream is down, and holds them again once it is up', async () => {
  const { reads, connect } = setup('connecting')
  reads.get('test', 'status', null).use({})
  await expect(reads.settledInUse()).resolves.toBeUndefined()
  connect('open')
  let settled = false
  const done = reads.settledInUse().then(() => (settled = true))
  await Promise.resolve()
  expect(settled).toBe(false)
  connect('reconnecting')
  await done
  await Promise.resolve()
  expect(settled).toBe(true)
})

it('rechecks readiness when the last reader of a pending read goes', async () => {
  const { reads } = setup()
  const release = reads.get('test', 'status', null).use({})
  const done = reads.settledInUse()
  release()
  await expect(done).resolves.toBeUndefined()
})

it('stops waiting for readiness when its signal aborts', async () => {
  const { reads } = setup()
  reads.get('test', 'status', null).use({})
  const stop = new AbortController()
  const done = reads.settledInUse(stop.signal)
  stop.abort(new Error('gave up'))
  await expect(done).rejects.toThrow('gave up')
})
