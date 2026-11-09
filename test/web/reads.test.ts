import { expect, it, vi } from 'vitest'
import type { Api } from '../../web/src/sdk/api.ts'
import { createReads } from '../../web/src/sdk/reads.ts'

it('answers readers of one action and args with one call, and asks again after a server restart', async () => {
  const listeners = new Set<() => void>()
  let system: unknown
  const store = {
    getState: () => ({ system }),
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
