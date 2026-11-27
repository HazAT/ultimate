import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import type { FakeSource } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { Row } from '../../items.web.ts'
import { List } from '../../list.solid.tsx'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  writes: [] as { key: string; value: unknown; source: string | null }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { FakeSource, fakeSubscriptions } = await import('../../../../test/web/fake-source.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input !== '/api/ui')
      return subscriptions.handle(input as string, init) ?? Response.json({ ok: true })
    const source = new Headers(init?.headers).get(SOURCE_HEADER)
    const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
    for (const { key, value } of ops) harness.writes.push({ key, value, source })
    return Response.json({ ok: true, rev: 1 })
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
  return { store, api, uiState: createUiState(api.updateUi) }
})

import { store, uiState } from '../../../../web/src/sdk/client.ts'

const agent = createAgent()

it('records the agent selecting the right one of two same-title questions', async ({
  onTestFinished,
}) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  const rows: Row[] = [12, 13].map((id) => ({
    key: `message:${id}`,
    at: 100 * id,
    message: id,
    tag: 'question',
    title: 'Renew the cert',
  }))
  const container = renderSolid(() => (
    <ExtensionName value="sidebar">
      <List phone={false} rows={rows} />
    </ExtensionName>
  ))
  await settle()
  expect(container.querySelector('[aria-current="true"]')?.getAttribute('data-inbox-row')).toBe(
    '12',
  )
  await expectDistinctAgentNames(agent)
  const row = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Read Renew the cert (#13)')!
  expect(row).toMatchObject({ component: 'button' })
  const result = await agent.act({ steps: [{ ref: row.ref, action: 'press' }] })
  expect(result).toMatchObject({ ok: true })
  flush()
  expect(container.querySelector('[aria-current="true"]')?.getAttribute('data-inbox-row')).toBe(
    '13',
  )
  await uiState.flush()
  expect(harness.writes).toEqual([
    {
      key: 'ext.inbox.selected',
      value: { key: 'message:13', at: 1300, open: true },
      source: 'agent',
    },
  ])
})
