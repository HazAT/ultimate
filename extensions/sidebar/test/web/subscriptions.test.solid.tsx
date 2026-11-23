import type { TaskId } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ROOT } from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import { ActivityAction } from '../../../conversations/refs.ts'
import { RootsDoc } from '../../../lineage/refs.ts'
import { StandingDoc } from '../../../subagents/refs.ts'
import { ProgressAction, WorkspacesDoc } from '../../../workspaces/refs.ts'
import { Conversations } from '../../sidebar.solid.tsx'

const harness = vi.hoisted(() => ({ sources: [] as FakeSource[] }))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch: typeof globalThis.fetch = async (input, init) =>
    server.handle(input as string, init) ?? Response.json({ result: null })
  const clientStore = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  const api = createApi(clientStore, { fetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    registry: createRegistry(),
    uiState: createUiState(undefined),
  }
})

const server = fakeSubscriptions(harness.sources, () => Response.json({ result: null }))

function mount(onTestFinished: (cleanup: () => void) => void) {
  store.start()
  onTestFinished(() => store.stop())
  const stream = harness.sources.at(-1)!
  stream.open()
  const container = renderSolid(() => <Conversations />)
  return { stream, container }
}

it('keeps one @ultimate row while the standing document loads', async ({ onTestFinished }) => {
  const { stream, container } = mount(onTestFinished)
  const ultimate = parseConversationId(2)
  const voice = parseConversationId(3)
  const lander = parseConversationId(4)
  stream.send('conversations', [
    { id: ROOT, busy: false },
    { id: ultimate, title: '@ultimate', label: 'agent', busy: false },
    { id: voice, title: '@voice', label: 'agent', busy: false },
    { id: lander, title: 'Lander', label: 'lander', busy: false },
  ])
  await settle()
  flush()
  const standing = () => [...container.querySelectorAll<HTMLElement>('[data-standing]')]
  expect(standing().map((row) => row.dataset.standing)).toEqual(['ultimate', 'lander'])

  server.of(ROOT)!.send('doc', { kind: StandingDoc.kind, value: { ultimate, voice } })
  flush()
  expect(standing().map((row) => [row.dataset.standing, row.dataset.conversation])).toEqual([
    ['ultimate', '2'],
    ['lander', '4'],
    ['voice', '3'],
  ])
})

it('keeps the same work and activity subscriptions when in-flight branches reorder', async ({
  onTestFinished,
}) => {
  const { stream, container } = mount(onTestFinished)
  const first = parseConversationId(3)
  const second = parseConversationId(12)
  const child = parseConversationId(10)
  const branchOf = { conversationId: ROOT, at: parseEntryId(1) }
  const publish = (inputAt: number) =>
    stream.send('conversations', [
      { id: ROOT, busy: false },
      { id: first, branchOf, busy: false, inputAt },
      { id: second, branchOf, busy: false, inputAt: 2 },
      { id: child, parentConversationId: first, ownerTaskId: 4 as TaskId, busy: false },
    ])
  publish(1)
  await settle()
  const root = server.of(ROOT)!
  root.send('doc', { kind: RootsDoc.kind, value: { roots: [ROOT] } })
  root.send('doc', {
    kind: WorkspacesDoc.kind,
    value: {
      items: { [first]: { state: 'ready' }, [second]: { state: 'ready' } },
      queue: [],
      results: {},
    },
  })
  flush()
  await settle()
  const order = () =>
    [...container.querySelectorAll<HTMLElement>('[data-in-flight]')].map(
      (row) => row.dataset.inFlight,
    )
  const opened = (ref: { extension: string; name: string }) =>
    server.reads.filter(
      ({ stream: id, read }) =>
        id === stream.id && read.extension === ref.extension && read.action === ref.name,
    )
  const work = opened(ProgressAction)
  const activity = opened(ActivityAction)
  expect(order()).toEqual(['12', '3'])
  expect(work.map(({ read }) => read.args)).toEqual([{ ids: [first, second] }])
  expect(activity.map(({ read }) => read.args)).toEqual([{ ids: [first, child, second] }])

  publish(3)
  flush()
  await settle()
  expect(order()).toEqual(['3', '12'])
  expect(opened(ProgressAction)).toEqual(work)
  expect(opened(ActivityAction)).toEqual(activity)
  expect([...work, ...activity].every((read) => !read.closed)).toBe(true)
})
