/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ConversationScope, ExtensionName } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import type { UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { WireSummary } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  calls: [] as WireSummary[],
  writes: [] as { key: string; value: unknown; source: string | null }[],
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/ui') {
      const { ops } = JSON.parse(init!.body as string) as UiUpdateRequest
      const source = new Headers(init?.headers).get(SOURCE_HEADER)
      for (const { key, value } of ops) harness.writes.push({ key, value, source })
      return Response.json({ ok: true, rev: 1 })
    }
    if (path === '/api/extensions/wire/actions/list')
      return Response.json({ result: harness.calls })
    if (path === '/api/extensions/wire/actions/call') {
      const { args } = JSON.parse(init!.body as string) as {
        args: { n: number }
      }
      const call = harness.calls.find(({ n }) => n === args.n)
      return Response.json({
        result: call
          ? {
              ...call,
              request: '{"messages":[{"role":"user","content":[{"text":"Request text"}]}]}',
              message: { content: [{ text: `Response for call ${call.n}` }] },
            }
          : null,
      })
    }
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
    uiState: createUiState(api.updateUi),
  }
})

import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { WireTab } from '../../tab.solid.tsx'

const agent = createAgent()
harness.server = fakeSubscriptions(harness.sources)
const control = (label: string) => {
  const found = agent.snapshot().find((entry) => !entry.offPage && entry.label === label)
  if (!found) throw new Error(`Missing control: ${label}`)
  return found
}

it('records an agent’s call and part under Wire without changing the System tab', async ({
  onTestFinished,
}) => {
  const conversation = parseConversationId(42)
  harness.calls = [12, 13].map((n) => ({
    n,
    conversationId: conversation,
    source: 'payload',
    provider: 'anthropic',
    model: 'claude-test',
    startedAt: n * 1000,
    endedAt: n * 1000 + 100,
    requestBytes: 68,
  }))
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  uiState.receive({ 'ext.system.tab': 'wire' })
  const [phone, setPhone] = createSignal(false)
  const container = renderSolid(() => (
    <ExtensionName value="system">
      <ConversationScope value={conversation}>
        <WireTab busy={false} phone={phone()} />
      </ConversationScope>
    </ExtensionName>
  ))
  await settle()
  flush()
  expect(container.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe(
    'Call #13 claude-test',
  )
  await expectDistinctAgentNames(agent)

  expect(
    await agent.act({
      steps: [{ ref: control('Call #12 claude-test').ref, action: 'press' }],
    }),
  ).toMatchObject({ ok: true })
  await settle()
  flush()
  expect(container.querySelector('[aria-current="true"]')?.getAttribute('aria-label')).toBe(
    'Call #12 claude-test',
  )
  const part = control('Part of the call')
  expect(part).toMatchObject({
    component: 'segmented-control',
    value: 'request',
  })
  expect(
    await agent.act({
      steps: [{ ref: part.ref, action: 'setValue', args: ['response'] }],
    }),
  ).toMatchObject({ ok: true })
  await settle()
  flush()
  expect(container.textContent).toContain('Response for call 12')
  await uiState.flush()
  expect(harness.writes).toEqual([
    { key: 'ext.wire.picked', value: { conversation, n: 12 }, source: 'agent' },
    { key: 'ext.wire.tab', value: 'response', source: 'agent' },
  ])
  expect(uiState.get('ext.system.tab')).toBe('wire')
  await expectDistinctAgentNames(agent)

  setPhone(true)
  flush()
  const result = await agent.act({
    steps: [
      {
        ref: control('Choose Wire call').ref,
        action: 'press',
        args: ['#13 claude-test'],
      },
    ],
  })
  expect(result.error?.message).toBeUndefined()
  expect(result).toMatchObject({ ok: true })
  await settle()
  flush()
  expect(container.textContent).toContain('Response for call 13')
  await uiState.flush()
  expect(harness.writes.at(-1)).toEqual({
    key: 'ext.wire.picked',
    value: { conversation, n: 13 },
    source: 'agent',
  })
})
