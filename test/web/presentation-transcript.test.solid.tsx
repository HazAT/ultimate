/** @jsxImportSource @solidjs/web */
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import type { StreamedView, ConversationSummary } from '../../shared/protocol.ts'

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
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))

import { Transcript } from '../../web/src/app/transcript.solid.tsx'
import { registry, store } from '../../web/src/sdk/client.ts'
import { PresentationProvider } from '../../web/src/sdk/presentation.solid.tsx'
import { PresentationPoint, provide } from '../../web/src/sdk/types.ts'
import { renderSolid } from './solid-dom-setup.ts'

it('hides only closed update lines and restores them while keeping open updates visible', async () => {
  const [updates, setUpdates] = createSignal<'show' | 'hide'>('show')
  await registry.setLoaders({
    'extensions/presentation/web.solid.tsx': async () => ({
      default: {
        provides: [provide(PresentationPoint, () => () => ({ backgroundUpdates: updates() }))],
        compact: {
          when: () => true,
          thread: ({ entry }: { entry: { kind: string } }) => entry.kind === 'pi.user',
        },
      },
    }),
  })
  const view = {
    conversation: { id: 70 },
    entries: [
      {
        id: 700,
        conversationId: 70,
        kind: 'pi.user',
        model: [{ role: 'user', content: 'Question', timestamp: 0 }],
      },
      { id: 701, conversationId: 70, kind: 'probe.note', data: { text: 'Update' } },
    ],
    docs: {},
  } as unknown as StreamedView
  vi.spyOn(store, 'getState').mockReturnValue({
    ...store.getState(),
    view,
    conversations: [{ id: 70 }] as ConversationSummary[],
  })
  const container = renderSolid(() => (
    <PresentationProvider>
      <Transcript />
    </PresentationProvider>
  ))
  const line = () => container.querySelector<HTMLButtonElement>('[data-between]')
  expect(line()).not.toBeNull()
  setUpdates('hide')
  flush()
  expect(line()).toBeNull()
  setUpdates('show')
  flush()
  expect(line()).not.toBeNull()
  line()!.click()
  flush()
  expect(line()?.getAttribute('aria-expanded')).toBe('true')
  setUpdates('hide')
  flush()
  expect(line()?.getAttribute('aria-expanded')).toBe('true')
})
