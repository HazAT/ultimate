import { expect, it, vi } from 'vitest'
import type { ReadEvent, ReadSpec } from '../../shared/protocol.ts'
import { ActionError } from '../../web/src/sdk/api.ts'
import type { ReadAction } from '../../web/src/sdk/api.ts'
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
  const action = vi.fn<() => Promise<{ result: unknown; rev?: number; superseded?: true }>>()
  return {
    watched,
    store,
    action,
    connect,
    reads: createReads(action as unknown as ReadAction, store as never),
  }
}

it('subscribes once per action and args for all readers, at the fastest interval, until the last leaves', () => {
  const { watched, reads, action } = setup()
  const read = reads.get('test', 'status', null)
  const first = read.use({})
  const second = reads.get('test', 'status', null).use({ every: 5000 })
  expect(watched).toMatchObject([{ read: { extension: 'test', action: 'status' }, every: 5000 }])
  watched[0].send({ result: 'answer', rev: 1 })
  expect(read.get()).toMatchObject({ data: 'answer', settled: true })
  second()
  expect(watched).toMatchObject([{ every: undefined }])
  first()
  expect(watched).toEqual([])
  expect(action).not.toHaveBeenCalled()
})

it("shows a read's failure through its reader's onError, or else as a notice, once per new answer", async () => {
  const { watched, reads, store, action } = setup()
  const onError = vi.fn<(error: ActionError) => void>()
  const read = reads.get('test', 'status', null)
  const release = read.use({ onError })
  watched[0].send({ error: 'boom', status: 500, rev: 1 })
  action.mockRejectedValueOnce(new ActionError('test', 'status', 500, 'boom', 2))
  await read.refetch()
  watched[0].send({ error: 'boom', status: 500, rev: 2 })
  expect(onError).toHaveBeenCalledTimes(1)
  expect(read.get().error).toMatchObject({ extension: 'test', action: 'status', status: 500 })
  release()
  read.use({})
  watched[0].send({ error: 'other', status: 404, rev: 3 })
  expect(store.notify).toHaveBeenCalledWith({ level: 'error', message: 'test/status: other' })
})

it("keeps the stream's newer answer when an older refetch answers last", async () => {
  const { watched, reads, action } = setup()
  const read = reads.get('test', 'status', null)
  read.use({})
  const older = Promise.withResolvers<{ result: string; rev: number }>()
  action.mockReturnValueOnce(older.promise)
  const refetched = read.refetch()
  await Promise.resolve()
  watched[0].send({ result: 'newer', rev: 2 })
  older.resolve({ result: 'older', rev: 1 })
  expect(await refetched).toBe('older')
  expect(read.get()).toMatchObject({ data: 'newer', loading: false, settled: true })
})

it('lets a running refetch finish and runs once more after it, however often it is asked meanwhile', async () => {
  const { reads, action } = setup()
  const read = reads.get('test', 'status', null)
  const first = Promise.withResolvers<{ result: string; rev: number }>()
  action.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ result: 'second', rev: 2 })
  const running = read.refetch()
  await Promise.resolve()
  const again = [read.refetch(), read.refetch(), read.refetch()]
  await Promise.resolve()
  await Promise.resolve()
  expect(action).toHaveBeenCalledTimes(1)
  first.resolve({ result: 'first', rev: 1 })
  expect(await running).toBe('first')
  expect(await Promise.all(again)).toEqual(['second', 'second', 'second'])
  expect(action).toHaveBeenCalledTimes(2)
  expect(read.get()).toMatchObject({ data: 'second', loading: false })
})

it('applies an HTTP refetch immediately and settles UI steps without waiting for the stream', async () => {
  const { watched, reads, action } = setup()
  const read = reads.get('test', 'status', null)
  read.use({})
  const done = reads.settledInUse()
  action.mockResolvedValueOnce({ result: 'over http', rev: 2 })
  await read.refetch()
  expect(read.get()).toMatchObject({ data: 'over http', settled: true, loading: false })
  await done
  watched[0].send({ result: 'older from the stream', rev: 1 })
  expect(read.get().data).toBe('over http')
  watched[0].send({ result: 'newer from the stream', rev: 3 })
  expect(read.get().data).toBe('newer from the stream')
})

it('cancels a queued refetch and suppresses errors from an in-flight refetch when the last reader leaves', async () => {
  const { reads, action, store } = setup()
  const read = reads.get('test', 'status', null)
  const onError = vi.fn<(error: ActionError) => void>()
  const release = read.use({ onError })
  const attempt = Promise.withResolvers<never>()
  action.mockReturnValueOnce(attempt.promise)
  const running = read.refetch()
  await Promise.resolve()
  const queued = read.refetch()
  release()
  attempt.reject(new ActionError('test', 'status', 500, 'late failure', 1))
  await Promise.all([running, queued])
  expect(action).toHaveBeenCalledOnce()
  expect(onError).not.toHaveBeenCalled()
  expect(store.notify).not.toHaveBeenCalled()
  expect(read.get()).toEqual({ settled: false, loading: false })
})

it('can refetch again after a loading listener throws', async () => {
  const { reads, action } = setup()
  const read = reads.get('test', 'status', null)
  const stop = read.subscribe(() => {
    if (read.get().loading) throw new Error('listener failed')
  })
  await expect(read.refetch()).rejects.toThrow('listener failed')
  expect(read.get().loading).toBe(false)
  expect(action).not.toHaveBeenCalled()
  stop()
  action.mockResolvedValueOnce({ result: 'recovered', rev: 1 })
  await expect(read.refetch()).resolves.toBe('recovered')
  expect(read.get()).toMatchObject({ data: 'recovered', loading: false })
})

it('waits for a fresh answer on remount even when it matches the cached answer', async () => {
  const { watched, reads } = setup()
  const read = reads.get('test', 'status', null)
  const release = read.use({})
  watched[0].send({ result: 'answer', rev: 10 })
  release()
  read.use({})
  let settled = false
  const done = reads.settledInUse().then(() => (settled = true))
  await Promise.resolve()
  expect(settled).toBe(false)
  watched[0].send({ result: 'answer', rev: 1 })
  await done
  expect(settled).toBe(true)
})

it('resolves error handling from currently mounted readers instead of notifying a departed reader', async () => {
  const { reads, action, store } = setup()
  const read = reads.get('test', 'status', null)
  const firstError = vi.fn<(error: ActionError) => void>()
  const secondError = vi.fn<(error: ActionError) => void>()
  const releaseFirst = read.use({ onError: firstError })
  const releaseSecond = read.use({ onError: secondError })
  const attempt = Promise.withResolvers<never>()
  action.mockReturnValueOnce(attempt.promise)
  const pending = read.refetch()
  await Promise.resolve()
  releaseFirst()
  attempt.reject(new ActionError('test', 'status', 500, 'shared failure', 1))
  await pending
  expect(firstError).not.toHaveBeenCalled()
  expect(secondError).toHaveBeenCalledOnce()
  expect(store.notify).not.toHaveBeenCalled()
  releaseSecond()
})

it('accepts a lower revision after reconnecting, even if an HTTP refetch ran while disconnected', async () => {
  const { watched, reads, action, connect } = setup()
  const read = reads.get('test', 'status', null)
  read.use({})
  watched[0].send({ result: 'old process', rev: 10 })
  const late = Promise.withResolvers<{ result: string; rev: number }>()
  action.mockReturnValueOnce(late.promise)
  const running = read.refetch()
  await Promise.resolve()
  connect('reconnecting')
  const duringDrop = Promise.withResolvers<{ result: string; rev: number }>()
  action.mockReturnValueOnce(duringDrop.promise)
  const reconnectingFetch = read.refetch()
  late.resolve({ result: 'old process, late', rev: 11 })
  await running
  await Promise.resolve()
  duringDrop.resolve({ result: 'old process during reconnect', rev: 500 })
  await reconnectingFetch
  connect('open')
  watched[0].send({ result: 'new process', rev: 1 })
  expect(read.get()).toMatchObject({ data: 'new process', loading: false })
})

it('does not mark a mounted read settled after a status-0 network failure before SSE answers', async () => {
  const { watched, reads, action } = setup()
  const read = reads.get('test', 'status', null)
  read.use({})
  let settled = false
  const done = reads.settledInUse().then(() => (settled = true))
  action.mockRejectedValueOnce(new ActionError('test', 'status', 0, 'Failed to fetch'))
  await read.refetch()
  await Promise.resolve()
  expect(settled).toBe(false)
  watched[0].send({ result: 'from sse', rev: 1 })
  await done
  expect(settled).toBe(true)
})

it('does not let an unversioned HTTP error overwrite an authoritative sequenced answer, and recovers after an initial unversioned 500', async () => {
  const { watched, reads, action, store } = setup()
  const onError = vi.fn<(error: ActionError) => void>()
  const read = reads.get('test', 'status', null)
  read.use({ onError })
  action.mockRejectedValueOnce(new ActionError('test', 'status', 500, 'temporary', undefined))
  await read.refetch()
  expect(read.get().error).toMatchObject({ status: 500, message: 'temporary' })
  watched[0].send({ result: 'good', rev: 5 })
  expect(read.get()).toMatchObject({
    data: 'good',
    error: undefined,
    loading: false,
    settled: true,
  })
  action.mockRejectedValueOnce(new ActionError('test', 'status', 503, 'Bad gateway'))
  await read.refetch()
  expect(read.get()).toMatchObject({
    data: 'good',
    error: undefined,
    loading: false,
    settled: true,
  })
  expect(onError).toHaveBeenCalledTimes(1)
  expect(store.notify).not.toHaveBeenCalled()
})

it('ignores a superseded HTTP failure even when HTTP arrives before the corrective SSE frame', async () => {
  const { watched, reads, action, store } = setup()
  const onError = vi.fn<(error: ActionError) => void>()
  const read = reads.get('test', 'status', null)
  read.use({ onError })
  watched[0].send({ result: 'A', rev: 1 })
  action.mockRejectedValueOnce(new ActionError('test', 'status', 500, 'stale failure', 2, true))
  await read.refetch()
  expect(read.get()).toMatchObject({ data: 'A', error: undefined, loading: false, settled: true })
  expect(onError).not.toHaveBeenCalled()
  expect(store.notify).not.toHaveBeenCalled()
  watched[0].send({ result: 'A', rev: 3 })
  expect(read.get()).toMatchObject({ data: 'A', error: undefined, loading: false, settled: true })
})

it('answers a refetch of an unwatched read itself, and stays quiet when its request never reached the server', async () => {
  const { reads, action, store } = setup()
  const read = reads.get('test', 'status', null)
  action.mockResolvedValueOnce({ result: 'fresh', rev: 1 })
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
  watched[0].send({ result: 'answer', rev: 1 })
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
