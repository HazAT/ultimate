/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { createElement as h, act } from 'react'
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
vi.mock('../../web/src/sdk/resume.ts', () => ({ covered: () => false }))
vi.stubGlobal('matchMedia', () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

import { Transcript } from '../../web/src/app/transcript.solid.tsx'
import { registry, store } from '../../web/src/sdk/client.ts'
import { useTranscript } from '../../web/src/sdk/hooks.ts'
import { island } from '../../web/src/sdk/island.tsx'
import { ConversationScope } from '../../web/src/sdk/solid.ts'
import type { EntryRenderer } from '../../web/src/sdk/types.ts'
import { renderSolid } from './solid-dom-setup.ts'

const view = (id: number, text: string): StreamedView =>
  ({
    conversation: { id },
    entries: [
      {
        id: id * 10,
        conversationId: id,
        kind: 'pi.user',
        model: [{ role: 'user', content: text, timestamp: 0 }],
      },
      { id: id * 10 + 1, conversationId: id, kind: 'probe.note', data: { text: `note ${id}` } },
    ],
    docs: {},
  }) as unknown as StreamedView

const ReactNote: EntryRenderer = ({ entry, core }) =>
  h(
    'aside',
    { 'data-react-note': '' },
    `react sees ${useTranscript().length} rows of ${entry.kind}`,
    core,
  )

function SolidNote(props: { entry: { data?: { text?: string } }; core: unknown }) {
  return <em data-solid-note>{props.entry.data?.text}</em>
}

it('renders its scoped conversation, mounting React renderers through the bridge and island(C) entries and slots as Solid', async () => {
  await registry.setLoaders({
    'extensions/react-note/web.tsx': async () => ({
      default: { entries: { 'probe.note': ReactNote } },
    }),
    'extensions/solid-note/web.tsx': async () => ({
      default: {
        entries: { 'pi.user': island(SolidNote as never) },
        slots: { 'transcript.top': [island(() => <b data-top-overlay>top</b>)] },
      },
    }),
  })
  vi.spyOn(store, 'getState').mockReturnValue({
    ...store.getState(),
    view: view(1, 'shown'),
    viewsOf: { 7: view(7, 'scoped') },
  })
  let container!: HTMLElement
  await act(async () => {
    container = renderSolid(() => (
      <ConversationScope value={7 as ConversationId}>
        <Transcript />
      </ConversationScope>
    ))
    flush()
  })
  const transcript = container.querySelector('[data-ui="transcript"]')!
  const react = transcript.querySelector('[data-react-note]')
  expect(react?.textContent).toContain('react sees 2 rows of probe.note')
  expect(react?.querySelector('[data-slot="collapsible"]')?.textContent).toContain('#71')
  expect(transcript.querySelector('[data-solid-note]')).not.toBeNull()
  expect(transcript.textContent).not.toContain('shown')
  expect(transcript.querySelectorAll('[data-entry-id]')).toHaveLength(2)
  const top = transcript.querySelector('[data-top-overlay]')!
  expect(top.parentElement?.className).not.toContain('contents')
})
