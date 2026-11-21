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
})
