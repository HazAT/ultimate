import { expect, it, vi } from 'vitest'
import { ActionError } from '../../web/src/sdk/api.ts'
import type { Api } from '../../web/src/sdk/api.ts'
import { createReads } from '../../web/src/sdk/reads.ts'

it('answers readers of one action and args with one call, and asks again after a server restart', async () => {
  const listeners = new Set<() => void>()
  let system: unknown
  const store = {
    getState: () => ({ system, connection: { status: 'open' } }),
    subscribe: (listener: () => void) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
    notify: vi.fn<(notice: unknown) => void>(),
  }
  /** What the stream's `system` event does to the store: a server process, a new one after a restart. */
  const serve = (generation: number) => {
    system = { process: { pid: 1, generation } }
    for (const listener of listeners) listener()
  }
  const action = vi.fn<() => Promise<string>>(async () => 'answer')
  const reads = createReads({ action } as unknown as Api, store as never)
  serve(1)

  const read = reads.get('test', 'status', null)
  read.use({})
  reads.get('test', 'status', null).use({})
  await vi.waitFor(() => expect(read.get().settled).toBe(true))
  expect(action).toHaveBeenCalledTimes(1)
  expect(read.get().data).toBe('answer')

  serve(2)
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2))
})

it('keeps a read quiet when its request never reached the server, and asks again when the page is back', async () => {
  let connection = 'open'
  const listeners = new Set<() => void>()
  const store = {
    getState: () => ({ connection: { status: connection } }),
    subscribe: (listener: () => void) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
    notify: vi.fn<(notice: unknown) => void>(),
  }
  const connect = (status: string) => {
    connection = status
    for (const listener of listeners) listener()
  }
  const action = vi.fn<() => Promise<string>>()
  const reads = createReads({ action } as unknown as Api, store as never)

  // A tab put to sleep: the browser cancels the request before it reaches the server.
  action
    .mockResolvedValueOnce('first')
    .mockRejectedValueOnce(new ActionError('test', 'status', 0, 'Failed to fetch'))
  const read = reads.get('test', 'status', null)
  read.use({})
  await vi.waitFor(() => expect(read.get().data).toBe('first'))
  await read.refetch()
  expect(store.notify).not.toHaveBeenCalled()
  expect(read.get()).toMatchObject({ data: 'first', error: undefined, loading: false })

  action.mockResolvedValueOnce('again')
  connect('reconnecting')
  connect('open')
  await vi.waitFor(() => expect(read.get().data).toBe('again'))

  // A real answer from the server still shows.
  action.mockRejectedValueOnce(new ActionError('test', 'status', 500, 'boom'))
  await read.refetch()
  expect(store.notify).toHaveBeenCalledTimes(1)
})
