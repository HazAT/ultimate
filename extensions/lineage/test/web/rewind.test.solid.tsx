/** @jsxImportSource @solidjs/web */
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ConversationScope, ROOT } from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.ts'
import { SOURCE_HEADER } from '../../../../shared/protocol.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { reads, store } from '../../../../web/src/sdk/client.ts'
import { RootsDoc } from '../../refs.ts'
import type { RewindPreview } from '../../refs.ts'
import { GoBackAction } from '../../rewind.solid.tsx'

const { sources, rewind } = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  rewind: vi.fn<(args: unknown, source: string | null) => void>(),
}))
const server = fakeSubscriptions(sources)
const preview = {
  steps: 2,
  files: [{ path: 'notes.md', added: 4, removed: 1 }],
  commits: [],
  dependents: [],
  summaryModel: true,
} satisfies RewindPreview

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (path === '/api/extensions/lineage/actions/rewindPreview')
      return Response.json({ result: preview })
    if (path === '/api/extensions/lineage/actions/rewind') {
      const request = JSON.parse(init?.body as string) as { args: unknown }
      rewind(request.args, new Headers(init?.headers).get(SOURCE_HEADER))
      return Response.json({ result: { entry: 13 } })
    }
    return server.handle(path, init) ?? Response.json({ ok: true })
  }
  const clientStore = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      sources.push(source)
      return source
    },
    fetch,
  })
  const api = createApi(clientStore, { fetch })
  return {
    api,
    store: clientStore,
    reads: createReads(api, clientStore),
    uiState: createUiState(undefined),
  }
})

const agent = createAgent()

it('lets an agent preview and go back to a message only in the shown non-root conversation', async ({
  onTestFinished,
}) => {
  const conversation = parseConversationId(5)
  const at = parseEntryId(12)
  const entry = (conversationId: ConversationId, id: number) =>
    ({ conversationId, id, kind: 'pi.assistant' }) as EntryRecord

  store.start()
  onTestFinished(() => store.stop())
  sources[0].open()
  const container = renderSolid(() => (
    <>
      <ConversationScope value={ROOT}>
        <GoBackAction entry={entry(ROOT, 1)} />
      </ConversationScope>
      <ConversationScope value={conversation}>
        <GoBackAction entry={entry(parseConversationId(6), 2)} />
        <GoBackAction entry={entry(conversation, 11)} />
        <GoBackAction entry={entry(conversation, at)} />
      </ConversationScope>
    </>
  ))
  const buttons = () => [...container.querySelectorAll('[data-lineage-go-back]')]
  expect(buttons()).toEqual([])
  await settle()
  server.of(ROOT)!.send('doc', { kind: RootsDoc.kind, value: { roots: [ROOT] } })
  flush()
  expect(buttons().map((button) => button.getAttribute('data-lineage-go-back'))).toEqual([
    '11',
    '12',
  ])
  await expectDistinctAgentNames(agent)

  const press = async (label: string) => {
    const control = agent.snapshot().find((item) => !item.offPage && item.label === label)!
    expect(await agent.act({ steps: [{ ref: control.ref, action: 'press' }] })).toMatchObject({
      ok: true,
    })
    flush()
  }
  await press(`Go back to message #${at}`)
  await reads.settledInUse()
  flush()
  const dialog = () => container.querySelector('[data-lineage-rewind-dialog]')
  expect(dialog()?.textContent).toContain('Go back to #5/12?')
  expect(dialog()?.textContent).toContain('2 steps set aside')
  expect(dialog()?.textContent).toContain('notes.md')
  await expectDistinctAgentNames(agent)
  await press('Confirm go back')
  expect(rewind).toHaveBeenCalledExactlyOnceWith({ conversation, at, summarize: false }, 'agent')
  expect(dialog()).toBeNull()
})
