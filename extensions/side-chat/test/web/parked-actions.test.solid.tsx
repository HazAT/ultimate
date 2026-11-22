/** @jsxImportSource @solidjs/web */
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { StreamedView, UiUpdateRequest } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  writes: [] as UiUpdateRequest[],
  errors: [] as unknown[],
  reject: false,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const server = (harness.server = fakeSubscriptions(harness.sources))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(input as string, init) ?? Response.json({ ok: true })
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch,
  })
  return {
    store,
    api: createApi(store, { fetch }),
    registry: createRegistry(),
    reportCompact: () => {},
    uiState: createUiState(
      async (request) => {
        harness.writes.push(request)
        if (harness.reject) throw new Error('save refused')
        return { ok: true, rev: 1 }
      },
      { onError: (error) => harness.errors.push(error) },
    ),
  }
})

import { registry, store, uiState } from '../../../../web/src/sdk/client.ts'
import { PresentationProvider } from '../../../../web/src/sdk/presentation.solid.tsx'
import { PresentationPoint, provide } from '../../../../web/src/sdk/types.ts'
import { ComposerFrame } from '../../frame.solid.tsx'

it('names parked controls distinctly, attributes writes, and restores the UI after a rejected save', async ({
  onTestFinished,
}) => {
  const agent = createAgent()
  await registry.setLoaders({
    'extensions/presentation/web.solid.tsx': async () => ({
      default: { provides: [provide(PresentationPoint, () => () => ({ composer: 'bare' }))] },
    }),
  })
  uiState.receive({ 'ext.side-chat.front': null })
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  store.show(parseConversationId(44))
  await settle()
  harness
    .server!.of(44)!
    .send('view', { conversation: { id: 44 }, entries: [], docs: {} } as unknown as StreamedView)
  const container = renderSolid(() => (
    <PresentationProvider>
      <ComposerFrame core={<textarea />} />
    </PresentationProvider>
  ))
  await settle()
  harness.server!.of(1)!.send('doc', { kind: 'ultimate.standing-agents', value: { ultimate: 44 } })
  harness.server!.of(44)!.send('doc', {
    kind: 'sidechat.index',
    value: {
      sides: [
        { id: 82, at: 40, openedAt: 0 },
        { id: 83, at: 41, openedAt: 0, question: 7 },
      ],
    },
  })
  flush()
  await expectDistinctAgentNames(agent)
  harness.reject = true
  expect(
    await agent.act({ steps: [{ ref: 'Show question side chat #83', action: 'press' }] }),
  ).toMatchObject({ ok: true })
  await uiState.flush()
  flush()
  expect(harness.writes[0].ops[0]).toMatchObject({
    key: 'ext.side-chat.front',
    value: 83,
    who: 'agent',
  })
  expect(harness.errors).toHaveLength(1)
  expect(uiState.get('ext.side-chat.front')).toBeNull()
  expect(container.querySelector('[data-main-composer]')?.hasAttribute('inert')).toBe(false)
  harness.reject = false
  container.querySelector<HTMLButtonElement>('button[aria-label="Show side chat #82"]')!.click()
  await uiState.flush()
  flush()
  expect(harness.writes[1].ops[0]).toMatchObject({
    key: 'ext.side-chat.front',
    value: 82,
    who: 'person',
  })
  expect(container.querySelector('[data-main-composer]')?.hasAttribute('inert')).toBe(true)
  await registry.setLoaders({})
})
