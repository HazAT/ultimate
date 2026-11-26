import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { dock, setVoiceOpen } from '../../dock.solid.tsx'
import { SheetComposer, VoicePanel } from '../../panel.solid.tsx'

const ui = vi.hoisted(() => ({ viewport: 'phone' as 'phone' | 'desktop' }))
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  useAction: () => ({ data: () => undefined, refetch() {}, loading: () => false }),
  useModels: () => () => ({ providers: [], models: [] }),
  useDocOf: () => () => undefined,
  useEvent: () => undefined,
  useViewport: () => () => ui.viewport,
  useExtensionUiState: (_key: string, initial: unknown) => createSignal(initial),
}))
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {}, getVoices: () => [] })
vi.stubGlobal('SpeechSynthesisUtterance', EventTarget)
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }))
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
)

const agent = createAgent()
const mainBox = () => <div data-main-box>main prompt box</div>
const page = () => (
  <>
    <SheetComposer core={mainBox()} />
    <VoicePanel />
  </>
)

afterEach(() => {
  setVoiceOpen(false)
  dock.setTalking(false)
})

it('on a phone, the open voice sheet takes the main prompt box\u2019s place', async () => {
  ui.viewport = 'phone'
  const view = renderSolid(page)
  await settle()
  expect(view.querySelector('[data-main-box]')).not.toBeNull()
  setVoiceOpen(true)
  flush()
  expect(view.querySelector('[data-main-box]')).toBeNull()
  expect(view.querySelector('[data-voice-sheet-room]')).not.toBeNull()
  expect(view.querySelector('[data-voice-panel]')?.getAttribute('data-voice-sheet')).toBe('rest')
  expect(view.querySelector('[data-voice-grabber]')).not.toBeNull()
  await expectDistinctAgentNames(agent)
})

it('on desktop, the voice window floats beside the main prompt box, with no sheet', async () => {
  ui.viewport = 'desktop'
  const view = renderSolid(page)
  await settle()
  setVoiceOpen(true)
  flush()
  expect(view.querySelector('[data-main-box]')).not.toBeNull()
  expect(view.querySelector('[data-voice-sheet-room]')).toBeNull()
  expect(view.querySelector('[data-voice-panel]')?.hasAttribute('data-voice-sheet')).toBe(false)
  expect(view.querySelector('[data-voice-grabber]')).toBeNull()
})

it('in Talk mode the main box is one talk bar carrying the switch and the voice settings', async () => {
  ui.viewport = 'phone'
  const view = renderSolid(page)
  await settle()
  dock.setTalking(true)
  flush()
  expect(view.querySelector('[data-main-box]')).toBeNull()
  const bar = view.querySelectorAll('[data-voice-talk-bar]')
  expect(bar).toHaveLength(1)
  expect(bar[0].querySelector('[data-ui="voice-mode-switch"]')).not.toBeNull()
  expect(bar[0].querySelector('[aria-label="Talk bar settings"]')).not.toBeNull()
  await expectDistinctAgentNames(agent)
})
