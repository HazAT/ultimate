/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseEntryId } from '../../../../lib/ids.ts'
import { EVENT_FEED } from '../../../../shared/events.ts'
import type { EventContext, EventRecord } from '../../../../shared/events.ts'
import { UI_REVISION } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { UiWrite } from '../../../../web/src/sdk/ui-state.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  page: vi.fn<(args: unknown, source: string | null) => Promise<Response>>(),
  write: vi.fn<UiWrite>(),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
    if (path === '/api/extensions/activity/actions/page') {
      const { args } = JSON.parse(init!.body as string) as { args: unknown }
      return harness.page(args, new Headers(init!.headers).get('x-ultimate-source'))
    }
    if (path === '/api/extensions/workspaces/actions/github')
      return Response.json({ result: 'github.com/example/ultimate' })
    return harness.server?.handle(path, init) ?? Response.json({ ok: true })
  }
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  const api = createApi(store, { fetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    registry: createRegistry(),
    uiState: createUiState(harness.write),
  }
})

import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import { ExtensionName, ROOT, events } from '../../../../web/src/sdk/solid.ts'
import { writerNow } from '../../../../web/src/sdk/writer.ts'
import { provide } from '../../../../web/src/sdk/types.ts'
import { Review } from '../../../workspaces/landing-points.ts'
import { ActivityPanel } from '../../panel.solid.tsx'

const agent = createAgent()
const { page, write } = harness
const server = fakeSubscriptions(harness.sources)
harness.server = server
const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const event = (
  id: number,
  name: string,
  ago: number,
  data: EventRecord['data'],
  context?: EventContext,
): EventRecord => ({
  id: parseEntryId(id),
  name,
  kind: `event.${name}`,
  v: 1,
  at: minutes(ago),
  data,
  context,
})
const notice = (id: number, level: string, ago = 3) =>
  event(id, 'ultimate.notice', ago, { extension: 'example', message: `Notice ${id}`, level })
const backup = (id: number, phase: string) =>
  event(id, 'cloud.backup', 2, { project: 'example', phase, reason: `Backup ${id}` })

beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  page.mockReset().mockImplementation(async () => Response.json({ result: { events: [] } }))
  let rev = 0
  write.mockReset().mockImplementation(async () => ({ ok: true, rev: ++rev }))
  await registry.setLoaders({})
  uiState.restarted()
  uiState.receive({ [UI_REVISION]: rev })
  store.start()
  harness.sources.at(-1)!.open()
})
afterEach(async () => {
  await uiState.flush()
  store.stop()
  vi.unstubAllGlobals()
})

function live(records: EventRecord[]) {
  server.of(ROOT)!.send('doc', { kind: EVENT_FEED, value: { events: records } })
  flush()
}

async function mount(records: EventRecord[]) {
  const container = renderSolid(() => (
    <ExtensionName value="activity">
      <ActivityPanel />
    </ExtensionName>
  ))
  await settle()
  live(records)
  await settle()
  return container
}

const control = (label: string) =>
  agent.snapshot().find((entry) => !entry.offPage && entry.label?.startsWith(label))!
async function act(label: string, action: string, ...args: string[]) {
  const result = await agent.act({ steps: [{ ref: control(label).ref, action, args }] })
  flush()
  await settle()
  expect(result).toMatchObject({ ok: true })
}

function rows(container: HTMLElement) {
  return [...container.querySelectorAll('li[data-activity]')].map((row) => ({
    kind: row.getAttribute('data-activity'),
    tone: row.getAttribute('data-tone'),
    text: row.textContent,
    age: row.querySelector('time')?.textContent,
  }))
}

it('renders the live rows and opens the landing at its entry, with Review using the same compare range', async ({
  onTestFinished,
}) => {
  const container = await mount([
    event(1, 'lineage.rooted', 60 * 30, { id: 1, intent: 'Project context' }),
    event(2, 'lineage.branched', 90, { id: 12, from: 1, at: 7, intent: 'Build it' }),
    event(3, 'workspaces.landed', 5, {
      conversationId: 12,
      at: 40,
      sha: '45a315f0',
      base: '9057c43',
      target: 'main',
      title: '',
      feature: 'Activity Feed',
      commitCount: 3,
    }),
    notice(4, 'warning'),
    event(5, 'sync.moved', 1, { to: 'elsewhere' }),
  ])
  await expectDistinctAgentNames(agent)
  expect(rows(container)).toEqual([
    {
      kind: 'ultimate.notice',
      tone: 'warning',
      text: expect.stringContaining('Notice 4'),
      age: '3m',
    },
    {
      kind: 'workspaces.landed',
      tone: null,
      text: expect.stringMatching(/Activity Feed.*45a315f.*3 commits/),
      age: '5m',
    },
    {
      kind: 'lineage.branched',
      tone: null,
      text: expect.stringMatching(/#12.*from #1/),
      age: '1h',
    },
    {
      kind: 'lineage.rooted',
      tone: null,
      text: expect.stringMatching(/new root.*Project context.*#1/),
      age: '1d',
    },
  ])
  const compare = 'https://diffshub.com/example/ultimate/compare/9057c43...45a315f0'
  expect(
    container.querySelector('li[data-activity="workspaces.landed"] a')?.getAttribute('href'),
  ).toBe(compare)

  const review = vi.fn<(spec: string, who: string) => void>()
  await registry.setLoaders({
    '/extensions/review/web.tsx': async () => ({
      default: { provides: [provide(Review, (spec) => () => review(spec, writerNow()))] },
    }),
  })
  flush()
  const landing = container.querySelector('li[data-activity="workspaces.landed"]')!
  await act('Review 9057c43...45a315f0', 'press')
  expect(review).toHaveBeenCalledWith('9057c43...45a315f0', 'agent')
  expect(landing.querySelector('a')?.getAttribute('href')).toBe(compare)

  const open = vi.fn<(value: unknown) => void>()
  onTestFinished(events.on('messages:open', open))
  await act('Open activity event 3:', 'press')
  expect(open).toHaveBeenCalledExactlyOnceWith({ conversation: 12, entry: 40 })
  expect(uiState.get('shell.surface')).toBe('agent')
  expect(uiState.get('shell.conversation')).toBe(12)
  await act('Open activity event 1:', 'press')
  expect(uiState.get('shell.conversation')).toBe(1)
  expect(open).toHaveBeenCalledTimes(1)
})

it('filters problems and time through durable state, and offers System only when installed', async () => {
  const container = await mount([
    notice(1, 'warning', 48 * 60),
    notice(2, 'info'),
    backup(3, 'started'),
    backup(4, 'done'),
    backup(5, 'failed'),
    event(6, 'workspaces.check', 1, { command: 'pnpm check', result: 'flaky', ms: 1800 }),
    event(7, 'automations.escalated', 1, { id: 'maintenance', reason: 'Needs attention' }),
  ])
  expect(rows(container).map(({ kind }) => kind)).toEqual([
    'automations.escalated',
    'workspaces.check',
    'cloud.backup',
    'cloud.backup',
    'ultimate.notice',
    'ultimate.notice',
  ])
  expect(control('Open System surface')).toBeUndefined()
  const names = agent
    .snapshot()
    .filter((entry) => !entry.offPage)
    .map((entry) => entry.label)
  expect(names).toEqual(
    expect.arrayContaining([
      'Activity filter',
      'Activity time range',
      '4 problems: Show only problems',
      'Load older activity',
    ]),
  )

  await act('4 problems: Show only problems', 'press')
  expect(rows(container).map(({ tone }) => tone)).toEqual(['error', 'warning', 'error', 'warning'])
  expect(control('4 problems: Show only problems')).toBeUndefined()
  await act('Activity time range', 'setValue', '24h')
  expect(rows(container).map(({ tone }) => tone)).toEqual(['error', 'warning', 'error'])
  await uiState.flush()
  const changes = write.mock.calls.flatMap(([request]) =>
    request.ops.map(({ key, value, who }) => ({ key, value, who })),
  )
  expect(changes).toEqual(
    expect.arrayContaining([
      { key: 'ext.activity.filter', value: 'problems', who: 'agent' },
      { key: 'ext.activity.range', value: '24h', who: 'agent' },
    ]),
  )

  await registry.setLoaders({
    '/extensions/system/web.tsx': async () => ({
      default: {
        surfaces: [{ id: 'system', title: 'System', icon: () => null, component: () => null }],
      },
    }),
  })
  flush()
  await expectDistinctAgentNames(agent)
  await act('Open System surface', 'press')
  expect(uiState.get('shell.surface')).toBe('system')
})

it('retains live rows pushed out during a pending page and starts fresh after either selector changes', async () => {
  const firstLive = [
    notice(100, 'warning'),
    ...Array.from({ length: 99 }, (_, index) => backup(101 + index, 'started')),
  ]
  const container = await mount(firstLive)
  const started = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  page.mockImplementationOnce(() => {
    started.resolve()
    return reply.promise
  })
  const loading = act('Load older activity', 'press')
  await started.promise
  expect(
    container
      .querySelector('button[aria-label="Load older activity"]')
      ?.hasAttribute('data-pending'),
  ).toBe(true)
  const nextLive = [...firstLive.slice(1), notice(200, 'warning')]
  live(nextLive)
  reply.resolve(Response.json({ result: { events: [notice(99, 'warning')], next: 99 } }))
  await loading
  expect(page).toHaveBeenNthCalledWith(
    1,
    {
      kinds: expect.arrayContaining(['ultimate.notice', 'lineage.branched']),
      before: 100,
      since: expect.any(String),
      limit: 50,
    },
    'agent',
  )
  expect(rows(container).map(({ text }) => text)).toEqual([
    expect.stringContaining('Notice 200'),
    expect.stringContaining('Notice 100'),
    expect.stringContaining('Notice 99'),
  ])
  await act('Load older activity', 'press')
  expect(page).toHaveBeenNthCalledWith(2, expect.objectContaining({ before: 99 }), 'agent')
  expect(container.textContent).toContain('start of the last 7d')

  await act('Activity filter', 'setValue', 'problems')
  expect(rows(container)).toHaveLength(1)
  await act('Load older activity', 'press')
  expect(page).toHaveBeenNthCalledWith(
    3,
    {
      kinds: ['ultimate.notice', 'workspaces.check', 'cloud.backup', 'automations.escalated'],
      before: 101,
      since: expect.any(String),
      limit: 50,
    },
    'agent',
  )

  await act('Activity time range', 'setValue', 'all')
  live([])
  expect(container.textContent).toContain('nothing recent · load older to look further back')
  await act('Load older activity', 'press')
  expect(page).toHaveBeenNthCalledWith(4, { kinds: expect.any(Array), limit: 50 }, 'agent')
  expect(container.textContent).toContain('no problems in the log')
})
