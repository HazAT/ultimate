import type { TaskId } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ROOT } from '@/sdk/solid'
import { provide } from '@/sdk/types.ts'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { ExtensionActionRequest, UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import { OverviewDoc } from '../../../conversations/refs.ts'
import { ConversationPhase } from '../../../conversations/ui.solid.tsx'
import { RootsDoc } from '../../../lineage/refs.ts'
import { MessagesDoc } from '../../../messages/refs.ts'
import { RunsDoc, StandingDoc } from '../../../subagents/refs.ts'
import { PreviewUp } from '../../points.ts'
import { Conversations } from '../../sidebar.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  writes: [] as { key: string; value: unknown; source: string | null }[],
  renames: [] as { body: ExtensionActionRequest; source: string | null }[],
  activity: {} as Record<string, unknown>,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    const source = new Headers(init?.headers).get(SOURCE_HEADER)
    if (path === '/api/ui') {
      const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
      for (const { key, value } of ops) harness.writes.push({ key, value, source })
      return Response.json({ ok: true, rev: 1 })
    }
    if (path.endsWith('/conversations/actions/rename')) {
      harness.renames.push({
        body: JSON.parse(init!.body as string) as ExtensionActionRequest,
        source,
      })
      return Response.json({ result: {} })
    }
    if (path.endsWith('/workspaces/actions/repo')) return Response.json({ result: null })
    if (path.endsWith('/conversations/actions/activity'))
      return Response.json({ result: harness.activity })
    return harness.server?.handle(path, init) ?? Response.json({ result: [] })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const clientStore = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
  })
  const api = createApi(clientStore, { fetch: pageFetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    registry: createRegistry(),
    uiState: createUiState(api.updateUi),
  }
})

const agent = createAgent()
harness.server = fakeSubscriptions(harness.sources)
const branch = parseConversationId(12)
const ultimate = parseConversationId(2)
const child = parseConversationId(13)
const earlier = parseConversationId(17)
const conversations = [
  { id: ROOT, title: 'History', busy: false },
  { id: ultimate, title: '@ultimate', label: 'agent', busy: false },
  {
    id: branch,
    title: 'A branch',
    branchOf: { conversationId: ROOT, at: parseEntryId(1) },
    busy: false,
    inputAt: 2,
  },
  { id: earlier, title: 'Earlier chat', busy: false, inputAt: 1 },
]

async function mount(onTestFinished: (cleanup: () => void) => void) {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  store.start()
  onTestFinished(() => {
    store.stop()
    vi.unstubAllGlobals()
  })
  const stream = harness.sources.at(-1)!
  stream.open()
  stream.send('conversations', conversations)
  const container = renderSolid(() => <Conversations />)
  await settle()
  const root = () => harness.server!.of(ROOT)!
  root().send('doc', { kind: RootsDoc.kind, value: { roots: [ROOT] } })
  root().send('doc', { kind: StandingDoc.kind, value: { ultimate } })
  root().send('doc', { kind: OverviewDoc.kind, value: { conversations: {} } })
  root().send('doc', { kind: MessagesDoc.kind, value: { messages: [], next: 1 } })
  root().send('doc', { kind: RunsDoc.kind, value: {} })
  flush()
  return { container, root, stream }
}

it('shows working, a phase word or reviewing for a busy direct reviewer by definition, not label', async ({
  onTestFinished,
}) => {
  await registry.setLoaders({})
  const { container, root, stream } = await mount(onTestFinished)
  root().send('doc', {
    kind: OverviewDoc.kind,
    value: { conversations: { [branch]: { runState: 'working' } } },
  })
  flush()
  const row = container.querySelector(`[data-in-flight="${branch}"]`)!
  expect(row.querySelector('[title="working"]')).not.toBeNull()
  await registry.setLoaders({
    'extensions/sample/web.solid.tsx': async () => ({
      default: {
        provides: [
          provide(
            ConversationPhase,
            (id) => () => (id() === branch ? { word: 'implementing', waiting: false } : undefined),
          ),
        ],
      },
    }),
  })
  await settle()
  flush()
  expect(row.querySelector('[title="implementing"]')).not.toBeNull()
  stream.send('conversations', [
    ...conversations,
    {
      id: child,
      parentConversationId: branch,
      ownerTaskId: 3 as TaskId,
      busy: false,
      label: 'Check changes',
    },
  ])
  root().send('doc', {
    kind: OverviewDoc.kind,
    value: {
      conversations: { [branch]: { runState: 'working' }, [child]: { runState: 'working' } },
    },
  })
  for (const reviewer of ['reviewer', 'reviewer-simplicity']) {
    root().send('doc', { kind: RunsDoc.kind, value: { [child]: { agent: reviewer } } })
    flush()
    expect(row.querySelector('[title="reviewing"]')).not.toBeNull()
  }
  root().send('doc', { kind: RunsDoc.kind, value: {} })
  flush()
  expect(row.querySelector('[title="implementing"]')).not.toBeNull()
  expect(container.querySelector(`[data-in-flight="${branch}"]`)).toBe(row)
})

it("shows the coordinator's own turns and calls, the tree's cost, its workers and its own silence", async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ now: 30 * 60_000, toFake: ['Date'] })
  onTestFinished(() => {
    vi.useRealTimers()
  })
  harness.activity = {
    [branch]: { turns: 3, calls: 41, cost: 1.5, lastAt: 10 * 60_000 },
    [child]: { turns: 1, calls: 9, cost: 0.75, lastAt: 29 * 60_000 },
  }
  await registry.setLoaders({})
  const { container, root, stream } = await mount(onTestFinished)
  stream.send('conversations', [
    ...conversations,
    { id: child, parentConversationId: branch, ownerTaskId: 3 as TaskId, busy: true },
  ])
  root().send('doc', {
    kind: OverviewDoc.kind,
    value: {
      conversations: { [branch]: { runState: 'working' }, [child]: { runState: 'working' } },
    },
  })
  const line = () =>
    container
      .querySelector(`[data-in-flight="${branch}"]`)
      ?.closest('li')
      ?.querySelector(`[data-flight-activity="${branch}"]`)
  await vi.waitFor(() => {
    flush()
    expect(line()?.textContent).toContain('3 turns · 41 calls · $2.25 · with 1 worker')
  })
  expect(line()?.textContent).toContain('with 1 worker·idle 20m')
  expect(line()?.querySelector('[data-silent]')).not.toBeNull()
  root().send('doc', {
    kind: OverviewDoc.kind,
    value: { conversations: { [child]: { runState: 'working' } } },
  })
  flush()
  expect(line()?.textContent).toContain('with 1 worker')
  expect(line()?.querySelector('[data-silent]')).toBeNull()
  stream.send('conversations', conversations)
  root().send('doc', { kind: OverviewDoc.kind, value: { conversations: {} } })
  await vi.waitFor(() => {
    flush()
    expect(line()?.textContent).toContain('· alone')
  })
  expect(line()?.querySelector('[data-silent]')).toBeNull()
  harness.activity = {}
})

it('uses the running preview for user waits and idle branches', async ({ onTestFinished }) => {
  await registry.setLoaders({})
  const { container, root } = await mount(onTestFinished)
  const row = container.querySelector(`[data-in-flight="${branch}"]`)!
  expect(row.querySelector('[title="idle"]')).not.toBeNull()
  await registry.setLoaders({
    'extensions/sample/web.solid.tsx': async () => ({
      default: { provides: [provide(PreviewUp, (id) => () => id() === branch)] },
    }),
  })
  await settle()
  flush()
  expect(row.querySelector('[title="preview up"]')).not.toBeNull()
  expect(row.querySelector('[data-status="awaiting"]')?.className).not.toContain(
    'animate-pulse-dot',
  )
  root().send('doc', {
    kind: MessagesDoc.kind,
    value: {
      messages: [
        { id: 1, from: branch, to: 'user', text: 'Ready?', at: 1, reply: true, state: 'delivered' },
      ],
      next: 2,
    },
  })
  flush()
  expect(row.querySelector('[title="preview awaits you"]')).not.toBeNull()
  await registry.setLoaders({})
  await settle()
  flush()
  expect(row.querySelector('[title="waits on you"]')).not.toBeNull()
})

it('lets an agent switch, rename, and persist a folded section', async ({ onTestFinished }) => {
  await registry.setLoaders({})
  const { container } = await mount(onTestFinished)
  const ref = (label: string) =>
    agent.snapshot().find((entry) => !entry.offPage && entry.label === label)?.ref ?? label
  const act = async (label: string, action: string, args?: unknown[]) => {
    const result = await agent.act({ steps: [{ ref: ref(label), action, args }] })
    expect(result).toMatchObject({ ok: true })
    flush()
  }
  await act('Earlier', 'setOpen', [true])
  await expectDistinctAgentNames(agent)
  await act('A branch · #12', 'press')
  await uiState.flush()
  expect(harness.writes).toContainEqual({
    key: 'shell.conversation',
    value: branch,
    source: 'agent',
  })
  const row = container.querySelector<HTMLButtonElement>(`[data-in-flight="${branch}"]`)
  row?.focus()
  expect(document.activeElement).toBe(row)
  await act('Conversation actions for #12', 'setOpen', [true])
  await expectDistinctAgentNames(agent)
  await act('Conversation actions for #12', 'press', ['Rename'])
  await act('Edit title of #12', 'setValue', ['  Renamed branch  '])
  await act('Save title of #12', 'press')
  expect(harness.renames).toEqual([
    {
      body: { args: { id: branch, title: 'Renamed branch' }, conversationId: expect.any(Number) },
      source: 'agent',
    },
  ])
  await act('In flight', 'setOpen', [false])
  expect(container.querySelector(`[data-in-flight="${branch}"]`)).toBeNull()
  await uiState.flush()
  expect(harness.writes).toContainEqual({
    key: 'ext.conversations.closedSections',
    value: ['in-flight'],
    source: 'agent',
  })
})
