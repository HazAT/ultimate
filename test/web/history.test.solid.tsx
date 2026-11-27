import type { EntryRecord } from '@earendil-works/pi-durable'
import { createRoot, createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId, parseEntryId } from '../../lib/ids.shared.ts'
import { createHistory } from '../../web/src/app/history.solid.tsx'
import { api } from '../../web/src/sdk/client.ts'
import type { Api } from '../../web/src/sdk/api.ts'

vi.mock('../../web/src/sdk/client.ts', () => ({ api: { history: vi.fn<Api['history']>() } }))

it('aborts in-flight history gap-fills on cleanup without reporting an error', async () => {
  const id = parseConversationId(4)
  const row = (entry: number) =>
    ({ id: parseEntryId(entry), conversationId: id, kind: 'pi.user' }) as EntryRecord
  const request = vi.mocked(api.history)
  const page = Promise.withResolvers<Awaited<ReturnType<Api['history']>>>()
  request.mockImplementation((_id, _before, signal) => {
    signal?.addEventListener('abort', () => page.reject(signal.reason), { once: true })
    return page.promise
  })
  const [active, setActive] = createSignal([row(120)])
  const [older, setOlder] = createSignal(parseEntryId(100))
  const { history, dispose } = createRoot((cleanup) => ({
    history: createHistory(id, active, older),
    dispose: cleanup,
  }))
  try {
    flush()
    setActive([row(600)])
    setOlder(parseEntryId(500))
    flush()
    expect(request).toHaveBeenCalledWith(id, 500, expect.any(AbortSignal), 121)
    expect(request.mock.calls[0][2]?.aborted).toBe(false)
  } finally {
    dispose()
  }
  expect(request.mock.calls[0][2]?.aborted).toBe(true)
  await expect(page.promise).rejects.toMatchObject({ name: 'AbortError' })
  flush()
  expect(history.error()).toBe('')
})
