/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { EntryRecord, ToolCallView } from '@/sdk/solid'
import { ConversationScope, events, ROOT } from '@/sdk/solid'
import { provide } from '@/sdk/types.ts'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { WorkspaceCall } from '../../call.solid.tsx'
import { LandingNote } from '../../landing-note.solid.tsx'
import { Review } from '../../landing-points.ts'
import { LandingCard } from '../../landing.solid.tsx'
import { WorkspacesDoc } from '../../refs.ts'
import type { LanderStep, WorkspaceIndex } from '../../types.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/extensions/workspaces/actions/github')
      return Response.json({ result: 'sample/project' })
    return harness.server?.handle(path, init) ?? Response.json({ ok: true })
  }
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
    reportCompact: () => {},
    uiState: createUiState(undefined),
  }
})

const agent = createAgent()
harness.server = fakeSubscriptions(harness.sources)
const branch = parseConversationId(43)
const lander = parseConversationId(71)

it("folds a standing agent's landing to its @name, not the feature it carried at submit time", async ({
  onTestFinished,
}) => {
  const other = parseConversationId(60)
  await registry.setLoaders({
    'extensions/compact/web.solid.tsx': async () => ({
      default: { compact: { when: () => true } },
    }),
  })
  store.start()
  const stream = harness.sources.at(-1)!
  stream.open()
  stream.send('conversations', [
    { id: branch, title: '@ultimate', label: 'agent', busy: false },
    { id: other, title: 'Fold cards in the chat', busy: false },
  ])
  onTestFinished(() => store.stop())
  await settle()
  const landing = (from: typeof branch, card: number) => (
    <LandingCard
      card={card}
      from={from}
      headline="Landed"
      sha="5e1f0a2abc"
      subject={{ feature: 'Chat Cards', title: 'Fold cards in the chat' }}
      tone="landed"
    />
  )
  const container = renderSolid(() => (
    <ConversationScope value={branch}>
      {landing(branch, 43)}
      {landing(other, 60)}
    </ConversationScope>
  ))
  const summary = (card: number) =>
    container.querySelector(`button[aria-label="Toggle landing card #${card}"]`)?.textContent
  expect(summary(43)).toContain('@ultimate')
  expect(summary(43)).not.toContain('Chat Cards')
  expect(summary(60)).toContain('Chat Cards')
  expect(summary(60)).toContain('Fold cards in the chat')
})

it('replaces running checks as results arrive, leaving their unfinished siblings spinning', async ({
  onTestFinished,
}) => {
  store.start()
  const stream = harness.sources.at(-1)!
  stream.open()
  onTestFinished(() => store.stop())
  const call: ToolCallView = {
    id: 'submit-1',
    name: 'workspace',
    status: 'done',
    args: { action: 'submit' },
    images: [],
    diagnostics: [],
    output: JSON.stringify({ id: 'submit', lander, text: 'Submitted' }),
  }
  const container = renderSolid(() => <WorkspaceCall call={call} />)
  await settle()
  const steps = [
    { step: 'setting up', at: 1_000 },
    { step: 'checking: a', at: 2_000, runs: 'a' },
    { step: 'checking: b', at: 3_000, runs: 'b' },
    { step: 'checked: a', at: 4_000, check: { command: 'a', result: 'passed', summary: 'a ok' } },
  ] satisfies LanderStep[]
  const publish = async (next: LanderStep[]) => {
    const value: WorkspaceIndex = {
      items: {},
      results: {},
      landers: {},
      landerConversations: {},
      queue: [
        {
          id: 'submit',
          source: '/repo',
          target: 'main',
          tip: 'abcdef0',
          state: 'landing',
          at: parseEntryId(50),
          conversationId: branch,
          divergence: '',
          steps: next,
        },
      ],
    }
    harness.server!.of(ROOT)!.send('doc', { kind: WorkspacesDoc.kind, value })
    await settle()
    flush()
  }
  const running = () =>
    [...container.querySelectorAll('.animate-spin')]
      .filter((icon) => icon.parentElement?.querySelector('time'))
      .map((icon) => icon.nextElementSibling?.textContent)
  const duration = (label: string) =>
    [...container.querySelectorAll('time')]
      .map((time) => time.parentElement)
      .find((row) => row?.textContent?.includes(label))
      ?.querySelector('.tabular-nums')?.textContent
  await publish(steps)
  expect(container.textContent).toContain('a · a ok')
  expect(container.textContent).not.toContain('checking: a')
  expect(running()).toEqual(['checking: b'])
  expect(duration('setting up')).toBe('2.0s')
  expect(duration('a · a ok')).toBe('2.0s')
  await publish([
    ...steps,
    { step: 'checked: b', at: 7_000, check: { command: 'b', result: 'failed' } },
  ])
  expect(container.textContent).toContain('b · failed')
  expect(container.textContent).not.toContain('checking: b')
  expect(duration('setting up')).toBeUndefined()
  expect(duration('b · failed')).toBe('4.0s')
  expect(running()).toEqual([])
  const advance = { step: 'fast-forwarding', at: 8_000 }
  await publish([
    ...steps,
    { step: 'checked: b', at: 7_000, check: { command: 'b', result: 'failed' } },
    advance,
  ])
  expect(running()).toEqual(['fast-forwarding'])
})

it('lets an agent open the review range, expand the landing state, and switch to the branch', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  onTestFinished(() => {
    vi.unstubAllGlobals()
  })
  await registry.setLoaders({ 'extensions/review/web.solid.tsx': async () => ({ default: {} }) })
  const entry = {
    id: 89,
    kind: 'lineage.note',
    data: {
      source: 'lander',
      text: 'Landed',
      from: branch,
      at: 42,
      base: '1234567',
      sha: 'abcdef0',
      target: 'main',
      title: 'Build the fold',
      commits: [{ sha: 'abcdef0', subject: 'Ship fold' }],
      more: 0,
      paths: ['fold.ts'],
      abstract: { at: 41, text: 'The branch has a working fold.' },
    },
  } as unknown as EntryRecord
  const container = renderSolid(() => <LandingNote core={null} entry={entry} />)
  await settle()
  const findControl = (label: string) =>
    agent.snapshot().find((item) => !item.offPage && item.label === label)
  const reviewLabel = 'Review landing #89: 1234567...abcdef0'
  expect(findControl(reviewLabel)).toBeUndefined()
  expect(findControl('Compare landing #89: 1234567...abcdef0 on DiffsHub')).toBeDefined()

  const open = vi.fn<(spec: string, source: string) => void>()
  await registry.setLoaders({
    'extensions/local-review/web.solid.tsx': async () => ({
      default: {
        provides: [provide(Review, (spec) => () => () => open(spec(), writerNow()))],
      },
    }),
  })
  await settle()
  await expectDistinctAgentNames(agent)
  const emitted = vi.fn<() => void>()
  onTestFinished(events.on('review:open', emitted))
  const control = (label: string) => findControl(label)!.ref
  expect(findControl(reviewLabel)).toBeDefined()
  expect(
    await agent.act({ steps: [{ ref: control(reviewLabel), action: 'press' }] }),
  ).toMatchObject({
    ok: true,
  })
  expect(open).toHaveBeenCalledExactlyOnceWith('1234567...abcdef0', 'agent')
  expect(emitted).not.toHaveBeenCalled()
  expect(
    await agent.act({
      steps: [{ ref: control('State at landing #89'), action: 'setOpen', args: [true] }],
    }),
  ).toMatchObject({ ok: true })
  expect(container.textContent).toContain('The branch has a working fold.')
  expect(
    await agent.act({
      steps: [{ ref: control('Open branch from landing row #89: #43/42'), action: 'press' }],
    }),
  ).toMatchObject({ ok: true })
  expect(uiState.get('shell.conversation')).toBe(branch)
})
