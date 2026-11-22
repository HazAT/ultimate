import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { EVENT_FEED } from '../../../../shared/events.ts'
import type { ConversationSummary } from '../../../../shared/protocol.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { OverviewDoc } from '../../../conversations/refs.ts'
import { SubmissionLanded } from '../../../workspaces/refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  switched: { at: Date.parse('2026-11-20T10:00:00Z'), changed: ['extensions/self/web.tsx'] },
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const server = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(input as string, init) ?? Response.json({ ok: true })
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch,
  })
  return {
    store,
    api: createApi(store, { fetch }),
    uiState: createUiState(undefined),
    registry: createRegistry(),
    bundle: 'browser-build',
    switched: harness.switched,
  }
})

import { store, uiState } from '../../../../web/src/sdk/client.ts'
import { Updated } from '../../updated.solid.tsx'

const tick = async (ms = 10) => {
  await vi.advanceTimersByTimeAsync(ms)
  flush()
}

it('names the landing that switched the page with its feature, opens it for an agent, and fades', async ({
  onTestFinished,
}) => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  onTestFinished(() => void vi.unstubAllGlobals())
  vi.useFakeTimers()
  onTestFinished(() => void vi.useRealTimers())
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  const agent = createAgent()
  const container = renderSolid(() => <Updated />)
  await tick()
  expect(container.textContent).toContain('Updated')
  expect(container.textContent).toContain('self/web.tsx')

  harness.sources[0].send('conversations', [
    { id: 42, title: 'Live title' },
  ] as unknown as ConversationSummary[])
  const reading = (kind: string) =>
    harness.server!.subscriptions.find((sub) => !sub.closed && sub.docs.includes(kind))!
  reading(EVENT_FEED).send('doc', {
    kind: EVENT_FEED,
    value: {
      events: [
        {
          id: 1,
          kind: SubmissionLanded.kind,
          at: new Date(harness.switched.at - 5000).toISOString(),
          data: { conversationId: 42, title: 'Submitted title' },
        },
      ],
    },
  })
  await tick()
  expect(container.textContent).toContain('Landed')
  expect(container.querySelector('[data-conversation-ref="42"]')?.textContent).toBe(
    'Submitted title#42',
  )
  reading(OverviewDoc.kind).send('doc', {
    kind: OverviewDoc.kind,
    value: { conversations: { 42: { feature: 'Solid UI' } } },
  })
  await tick()
  expect(container.querySelector('[data-conversation-ref="42"]')?.textContent).toBe(
    'Solid UISubmitted title#42',
  )
  expect(container.querySelector('[data-feature="Solid UI"]')).not.toBeNull()

  const open = agent
    .snapshot()
    .find((entry) => !entry.offPage && entry.label === 'Open the landed conversation #42')
  expect(open).toBeDefined()
  const result = agent.act({ steps: [{ ref: open!.ref, action: 'press' }] })
  await tick(100)
  expect(await result).toMatchObject({ ok: true })
  expect(uiState.snapshot()['shell.conversation']).toBe(42)

  await tick(4000)
  expect(container.textContent).toBe('')
})
