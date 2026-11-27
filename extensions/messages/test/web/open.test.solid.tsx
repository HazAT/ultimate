import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ROOT } from '@/sdk/solid'
import { parseConversationId, parseEntryId } from '../../../../lib/ids.shared.ts'
import { FakeSource } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import { OpenMessages } from '../../open.solid.tsx'
import { StartedDoc } from '../../refs.ts'

const harness = vi.hoisted(() => ({ stream: undefined as FakeSource | undefined }))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const clientStore = createStore({
    eventSource: (url) => (harness.stream = new FakeSource(url)),
    fetch: async () => Response.json({ ok: true, refused: {} }),
  })
  const uiState = createUiState(undefined)
  clientStore.subscribe(() => {
    const { shared } = clientStore.getState()
    if (shared) uiState.receive(shared)
  })
  return { store: clientStore, uiState, registry: createRegistry() }
})

it('waits for the conclusion snapshot and only watches starters of open branches', ({
  onTestFinished,
}) => {
  store.start()
  const watch = vi.spyOn(store, 'watchDocOf')
  onTestFinished(() => {
    watch.mockRestore()
    store.stop()
  })
  const concluded = parseConversationId(7)
  const open = parseConversationId(12)
  const branchOf = { conversationId: ROOT, at: parseEntryId(1) }
  const stream = harness.stream!
  stream.open()
  renderSolid(() => <OpenMessages />)
  stream.send('conversations', [
    { id: ROOT, busy: false },
    { id: concluded, branchOf, busy: false },
    { id: open, branchOf, busy: false },
  ])
  flush()
  const starters = () => watch.mock.calls.filter(([, kind]) => kind === StartedDoc.kind)
  expect(starters()).toEqual([])

  stream.send('ui', { value: { 'ext.conversations.concluded': [concluded] } })
  flush()
  expect(starters()).toEqual([[open, StartedDoc.kind]])
})
