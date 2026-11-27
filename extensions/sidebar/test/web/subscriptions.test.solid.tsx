import type { TaskId } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ROOT } from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.shared.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import { ActivityAction, OverviewDoc } from '../../../conversations/refs.ts'
import { RootsDoc } from '../../../lineage/refs.ts'
import { MessagesDoc, StartedDoc } from '../../../messages/refs.ts'
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

it('nests branches a standing agent started under its row, folded, with an attention count', async ({
  onTestFinished,
}) => {
  const { stream, container } = mount(onTestFinished)
  const ultimate = parseConversationId(2)
  const triage = parseConversationId(3)
  const own = parseConversationId(10)
  const asking = parseConversationId(11)
  const quiet = parseConversationId(12)
  const branchOf = { conversationId: ROOT, at: parseEntryId(1) }
  stream.send('conversations', [
    { id: ROOT, busy: false },
    { id: ultimate, title: '@ultimate', label: 'agent', busy: false },
    { id: triage, title: '@triage', label: 'agent', busy: false },
    { id: own, branchOf, busy: false, inputAt: 3 },
    { id: asking, branchOf, busy: false, inputAt: 2 },
    { id: quiet, branchOf, busy: false, inputAt: 1 },
  ])
  await settle()
  const root = server.of(ROOT)!
  root.send('doc', { kind: RootsDoc.kind, value: { roots: [ROOT] } })
  root.send('doc', { kind: StandingDoc.kind, value: { ultimate, triage } })
  root.send('doc', { kind: WorkspacesDoc.kind, value: { items: {}, queue: [], results: {} } })
  root.send('doc', {
    kind: MessagesDoc.kind,
    value: {
      messages: [
        { id: 1, from: asking, to: 'user', text: 'Merge?', at: 1, reply: true, state: 'delivered' },
      ],
      next: 2,
    },
  })
  flush()
  await settle()
  for (const [id, by] of [
    [own, ultimate],
    [asking, triage],
    [quiet, triage],
  ])
    server.of(id)!.send('doc', { kind: StartedDoc.kind, value: { by } })
  flush()
  const rows = (selector: string) =>
    [...container.querySelectorAll<HTMLElement>(`${selector} [data-in-flight]`)].map(
      (row) => row.dataset.inFlight,
    )
  const group = () => container.querySelector('[data-standing-flights="triage"]')!
  expect(rows('[data-sidebar-section="in-flight"]')).toEqual(['10'])
  expect(group().previousElementSibling?.querySelector('[data-standing="triage"]')).not.toBeNull()
  expect(group().querySelector('[aria-label="Branches of @triage"]')?.textContent).toContain('2')
  expect(group().querySelector('[data-attention]')?.textContent).toBe('1')
  expect(rows('[data-standing-flights="triage"]')).toEqual([])
  root.send('doc', {
    kind: OverviewDoc.kind,
    value: { conversations: { [quiet]: { runState: 'error' } } },
  })
  flush()
  expect(group().querySelector('[data-attention]')?.textContent).toBe('2')

  group().querySelector<HTMLElement>('[aria-label="Branches of @triage"]')!.click()
  flush()
  await settle()
  expect(rows('[data-standing-flights="triage"]')).toEqual(['11', '12'])
})
