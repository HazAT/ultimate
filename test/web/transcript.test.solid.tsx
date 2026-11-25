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
import { ConversationScope, useTranscript } from '../../web/src/sdk/solid.ts'
import type { SolidEntryProps } from '../../web/src/sdk/solid.ts'
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

function ProbeNote(props: SolidEntryProps) {
  const transcript = useTranscript()
  return (
    <aside data-probe-note>
      sees {transcript().length} rows of {props.entry.kind}
      {props.core}
    </aside>
  )
}

it('renders its scoped conversation with contributed entry renderers and a top slot', async () => {
  await registry.setLoaders({
    'extensions/notes/web.solid.tsx': async () => ({
      default: {
        entries: { 'probe.note': ProbeNote, 'pi.user': () => <em data-user-note /> },
        slots: { 'transcript.top': [() => <b data-top-overlay>top</b>] },
      },
    }),
  })
  vi.spyOn(store, 'getState').mockReturnValue({
    ...store.getState(),
    view: view(1, 'shown'),
    viewsOf: { 7: view(7, 'scoped') },
  })
  const container = renderSolid(() => (
    <ConversationScope value={7 as ConversationId}>
      <Transcript />
    </ConversationScope>
  ))
  flush()
  const transcript = container.querySelector('[data-ui="transcript"]')!
  const note = transcript.querySelector('[data-probe-note]')
  expect(note?.textContent).toContain('sees 2 rows of probe.note')
  expect(note?.querySelector('[data-slot="collapsible"]')?.textContent).toContain('#71')
  expect(transcript.querySelector('[data-user-note]')).not.toBeNull()
  expect(transcript.textContent).not.toContain('shown')
  expect(transcript.querySelectorAll('[data-entry-id]')).toHaveLength(2)
  const top = transcript.querySelector('[data-top-overlay]')!
  expect(top.parentElement?.className).not.toContain('contents')
})
