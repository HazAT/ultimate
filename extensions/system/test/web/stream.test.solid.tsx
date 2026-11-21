/** @jsxImportSource @solidjs/web */
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { SystemRow } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  follows: [] as { after?: string; answer: (rows: SystemRow[], head: string) => void }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fake = await import('../../../../test/web/fake-source.ts')
  const server = (harness.server = fake.fakeSubscriptions(
    harness.sources,
    () => new Promise<Response>(() => {}),
  ))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path.endsWith('/system/actions/stream')) {
      const { args } = JSON.parse(init!.body as string) as { args: { after?: string } }
      return new Promise<Response>((resolve) =>
        harness.follows.push({
          after: args.after,
          answer: (rows, head) => resolve(Response.json({ result: { rows, head } })),
        }),
      )
    }
    return server.handle(path, init) ?? Response.json({ ok: true })
  }
  const store = createStore({
    fetch,
    eventSource: (url) => {
      const source = new fake.FakeSource(url)
      harness.sources.push(source)
      return source
    },
  })
  const api = createApi(store, { fetch })
  return { api, store, reads: createReads(api, store), uiState: createUiState(undefined) }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { Stream } from '../../stream.solid.tsx'

const row = (id: string): SystemRow => ({
  id,
  source: 'event',
  at: new Date(0).toISOString(),
  kind: 'event',
  name: `row ${id}`,
  ok: true,
  summary: '',
})
const settle = async () => {
  await vi.advanceTimersByTimeAsync(10)
  flush()
}

it('reaches a newer page that arrived while an older follow came back empty', async ({
  onTestFinished,
}) => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  onTestFinished(() => void vi.unstubAllGlobals())
  vi.useFakeTimers()
  onTestFinished(() => void vi.useRealTimers())
  store.start()
  onTestFinished(() => store.stop())
  const stream = harness.sources.at(-1)!
  stream.open()
  const view = renderSolid(() => (
    <Stream live view={{ source: 'all', errors: false, text: '' }} setView={() => {}} />
  ))
  await settle()
  const newest = harness.server!.reads.find((read) => read.read.action === 'stream')!
  const page = (rows: SystemRow[], head: string) =>
    stream.send('read', { result: { rows, head } }, newest.sub)

  page([row('a')], 'h1')
  await settle()
  expect(view.textContent).toContain('row a')
  page([row('b'), row('a')], 'h2')
  await settle()
  expect(harness.follows.map((follow) => follow.after)).toEqual(['h1'])

  page([row('c'), row('b'), row('a')], 'h3')
  harness.follows[0].answer([], 'h1')
  await settle()
  expect(harness.follows.map((follow) => follow.after)).toEqual(['h1', 'h1'])
  harness.follows[1].answer([row('c'), row('b')], 'h3')
  await settle()
  expect(view.textContent).toContain('row c')

  page([row('d'), row('c')], 'h4')
  await settle()
  expect(harness.follows.map((follow) => follow.after)).toEqual(['h1', 'h1', 'h3'])
  harness.follows[2].answer([row('e'), row('d')], 'h5')
  await settle()
  expect(view.textContent).toContain('row e')
  expect(harness.follows).toHaveLength(3)
})

it('reloads the newest page when a partial follow grows the feed past KEEP', async ({
  onTestFinished,
}) => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  onTestFinished(() => void vi.unstubAllGlobals())
  vi.useFakeTimers()
  onTestFinished(() => void vi.useRealTimers())
  harness.follows.length = 0
  store.start()
  onTestFinished(() => store.stop())
  const stream = harness.sources.at(-1)!
  stream.open()
  const view = renderSolid(() => (
    <Stream live view={{ source: 'events', errors: false, text: '' }} setView={() => {}} />
  ))
  await settle()
  const newest = harness.server!.reads.findLast(
    (read) => read.read.action === 'stream' && !read.closed,
  )!
  const rows = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => row(`${prefix}${index}`))
  stream.send('read', { result: { rows: rows('old', 990), head: 'h1' } }, newest.sub)
  await settle()
  stream.send('read', { result: { rows: rows('top', 100), head: 'h2' } }, newest.sub)
  await settle()
  harness.follows[0].answer(rows('new', 20), 'h2')
  await settle()
  expect(view.querySelectorAll('[data-row]')).toHaveLength(100)
  expect(view.textContent).toContain('row top0')
})
