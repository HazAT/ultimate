/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import type { FakeSource } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { ROOT } from '../../../../web/src/sdk/api.ts'
import { reads, store, uiState } from '../../../../web/src/sdk/client.ts'
import type { AutomationListItem } from '../../refs.ts'
import { AutomationsSection } from '../../sidebar.solid.tsx'

const harness = vi.hoisted(() => ({
  stream: undefined as FakeSource | undefined,
  updated: undefined as AutomationListItem[] | undefined,
  writes: [] as { key: string; value: unknown; source: string | null }[],
}))
const automations: AutomationListItem[] = ['Check reports', 'Review notes'].map((name, index) => ({
  id: `A${index + 1}`,
  name,
  enabled: true,
  createdAt: index,
  updatedAt: index,
  schedule: { kind: 'every', ms: 60_000 },
  subscribers: [],
  runs: [],
  fires: 0,
  alive: false,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const fetch = async (path: RequestInfo | URL, init?: RequestInit) => {
    if (path === '/api/extensions/automations/actions/list')
      return Response.json({ result: harness.updated ?? automations })
    if (path !== '/api/ui')
      return server.handle(path as string, init) ?? Response.json({ ok: true })
    const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
    const source = new Headers(init?.headers).get(SOURCE_HEADER)
    for (const { key, value } of ops) harness.writes.push({ key, value, source })
    return Response.json({ ok: true, rev: 1 })
  }
  const {
    FakeSource: Source,
    answerReadsWith,
    fakeSubscriptions: fake,
  } = await import('../../../../test/web/fake-source.ts')
  const sources: FakeSource[] = []
  const server = fake(sources)
  const pageFetch = answerReadsWith(fetch)
  const clientStore = createStore({
    eventSource: (url) => {
      harness.stream = new Source(url)
      sources.push(harness.stream)
      return harness.stream
    },
    fetch: pageFetch,
  })
  const api = createApi(clientStore, { fetch: pageFetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    uiState: createUiState(api.updateUi),
  }
})

const agent = createAgent()

it('lets an agent collapse the automation rows and persist the change as theirs', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.stream!.open()
  const container = renderSolid(() => (
    <ExtensionName value="automations">
      <AutomationsSection />
    </ExtensionName>
  ))
  await settle()
  flush()
  const rows = () => container.querySelectorAll('[data-sidebar-automation]')
  expect(rows()).toHaveLength(2)
  harness.updated = [{ ...automations[0], name: 'Read reports' }, automations[1]]
  await reads.get('automations', 'list', null, ROOT).refetch()
  flush()
  expect(container.querySelector('[data-sidebar-automation="A1"]')?.textContent).toContain(
    'Read reports',
  )
  const collapsible = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Active automations')
  expect(collapsible).toMatchObject({ component: 'collapsible', open: true })
  const changes = vi.fn<Parameters<typeof agent.subscribe>[0]>()
  onTestFinished(agent.subscribe(changes))
  const result = await agent.act({
    steps: [{ ref: collapsible!.ref, action: 'setOpen', args: [false] }],
  })
  expect(result).toMatchObject({ ok: true })
  flush()
  expect(rows()).toHaveLength(0)
  await uiState.flush()
  expect(harness.writes).toEqual([
    { key: 'ext.automations.sidebarOpen', value: false, source: 'agent' },
  ])
  expect(changes).toHaveBeenCalledWith(
    expect.objectContaining({
      label: 'Active automations',
      key: 'open',
      value: false,
      source: 'agent',
    }),
  )
})
