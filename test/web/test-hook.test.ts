import type { ConversationView } from '@earendil-works/pi-durable'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApi } from '../../web/src/sdk/api.ts'
import { createStore } from '../../web/src/sdk/store.ts'
import { createTestHook } from '../../web/src/sdk/test-hook.ts'
import type { ConversationSummary, SystemInfo } from '../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from './fake-source.ts'

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.clear()
})
afterEach(() => vi.useRealTimers())

function setup() {
  const sources: FakeSource[] = []
  const server = fakeSubscriptions(sources)
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (path, init) => server.handle(path as string, init) ?? Response.json({ submissionId: 9 }),
  )
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    fetch,
  })
  store.start()
  const hook = createTestHook(store, createApi(store, { fetch }))
  const main = sources[0]
  main.open()
  server.of()!.send('view', {
    conversation: { id: 1 },
    entries: [],
    docs: {},
  } as unknown as ConversationView)
  main.send('tasks', { tasks: {} })
  const list = (busy: boolean, answerAt?: number) =>
    main.send('conversations', [
      { id: 1, busy, ...(answerAt === undefined ? {} : { answerAt }) } as ConversationSummary,
    ])
  list(false)
  return { hook, list, fetch, main, server }
}

it('until idle waits for the sent turn, not the idle state before it starts', async () => {
  const { hook, list, fetch } = setup()
  expect(await hook.send('hello')).toEqual({ conversation: 1, submissionId: 9 })
  expect(fetch).toHaveBeenCalledWith('/api/conversations/1/submit', expect.anything())
  let done = false
  const waiting = hook.until('idle').then((value) => {
    done = true
    return value
  })
  // Right after the submit the list still says idle: that is the turn not started, not finished.
  list(false)
  await vi.advanceTimersByTimeAsync(10)
  expect(done).toBe(false)
  list(true)
  await vi.advanceTimersByTimeAsync(10)
  expect(done).toBe(false)
  list(false)
  expect(await waiting).toEqual({ conversation: 1 })
})

it('a page reloaded after a send still waits for the sent turn, without sending again', async () => {
  const first = setup()
  await first.hook.send('hello')
  // The reload: a new store and hook, with only sessionStorage carried over.
  const { hook, list, fetch } = setup()
  let done = false
  const waiting = hook.until('idle').then(() => (done = true))
  list(false)
  await vi.advanceTimersByTimeAsync(10)
  expect(done).toBe(false)
  list(true)
  list(false)
  await waiting
  expect(fetch).not.toHaveBeenCalledWith('/api/conversations/1/submit', expect.anything())
})

it('until idle counts a turn too short to show busy by its answer, and times out naming what is busy', async () => {
  const { hook, list } = setup()
  await hook.send('quick')
  const waiting = hook.until('idle')
  list(false, Date.now())
  expect(await waiting).toEqual({ conversation: 1 })

  await hook.send('slow')
  list(true)
  const late = hook.until('idle', { timeoutMs: 1000 }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(1000)
  expect(String(await late)).toContain('Timed out after 1s: #1 is still busy')
})

// A branch waited 35 minutes on `workspaces.submission-landed`, a name nothing emits, while its landing failed (#531986).
it('until fails at once on an unknown event, and on the event that fails the awaited one', async () => {
  const { hook, main, server } = setup()
  main.send('system', {
    extensions: [
      { name: 'workspaces', events: ['workspaces.landed', 'workspaces.landing-failed'] },
    ],
  } as unknown as SystemInfo)
  expect(
    String(await hook.until({ event: 'workspaces.submission-landed' }).catch((error) => error)),
  ).toContain(
    'Unknown event workspaces.submission-landed; did you mean workspaces.landed, workspaces.landing-failed?',
  )
  const landing = hook
    .until({ event: 'workspaces.landed', where: { submission: 's1' } })
    .catch((error: unknown) => error)
  const failed = (submission: string, id: number) => ({
    id,
    name: 'workspaces.landing-failed',
    fails: 'workspaces.landed',
    data: { submission, reason: 'check failed twice: pnpm test' },
  })
  await vi.advanceTimersByTimeAsync(10)
  server.of(1)!.send('doc', {
    kind: 'ultimate.event-feed',
    value: { events: [failed('s0', 1), failed('s1', 2)] },
  })
  expect(String(await landing)).toContain(
    'workspaces.landing-failed instead of workspaces.landed: {"submission":"s1"',
  )
})

it('exposes the page api, so a driven page sets up state with one call', async () => {
  const { hook, fetch } = setup()
  await hook.api.configure({ model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' } }, 1)
  const [url, init] = fetch.mock.calls.at(-1)!
  expect(url).toBe('/api/conversations/1/configure')
  expect(JSON.parse(init?.body as string)).toEqual({
    model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' },
  })
})
