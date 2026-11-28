import type { ConversationId } from '@earendil-works/pi-durable'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { StreamedView } from '../../shared/protocol.ts'

vi.mock('../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../web/src/sdk/store.ts')
  const { createRegistry } = await import('../../web/src/sdk/registry.ts')
  const { createUiState } = await import('../../web/src/sdk/ui-state.ts')
  return {
    store: createStore(),
    registry: createRegistry(),
    uiState: createUiState(undefined),
    api: {},
    reportCompact: () => {},
  }
})
vi.mock('../../web/src/sdk/resume.ts', () => ({
  covered: () => false,
  keepAcrossReload: () => () => {},
  takeFromLastPage: () => undefined,
}))
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

import { Transcript } from '../../web/src/app/transcript.solid.tsx'
import { registry, store } from '../../web/src/sdk/client.ts'
import { ConversationScope } from '../../web/src/sdk/solid.ts'
import { renderSolid } from './solid-dom-setup.ts'

it('keeps the start slot while a fresh fork streams its first message', async () => {
  await registry.setLoaders({
    'extensions/forks/web.solid.tsx': async () => ({
      default: { slots: { 'transcript.start': [() => <i data-fork-marker />] } },
    }),
  })
  const streamingFirstMessage = {
    conversation: { id: 9 },
    entries: [],
    docs: {
      'pi.live': {
        run: { taskId: 1, inputs: [] },
        generation: { message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }] } },
      },
    },
  } as unknown as StreamedView
  vi.spyOn(store, 'getState').mockReturnValue({
    ...store.getState(),
    viewsOf: { 9: streamingFirstMessage },
  })
  const container = renderSolid(() => (
    <ConversationScope value={9 as ConversationId}>
      <Transcript />
    </ConversationScope>
  ))
  flush()
  expect(container.querySelector('[data-fork-marker]')).not.toBeNull()
})
