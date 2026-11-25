import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { setVoiceOpen } from '../../dock.solid.tsx'
import { VoicePanel } from '../../panel.solid.tsx'

vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  useAction: () => ({ data: () => ({ model: 'antigravity/gemini-4-neon-low' }), refetch() {} }),
  useDocOf: () => () => undefined,
  useEvent: () => undefined,
  useExtensionUiState: (_key: string, initial: unknown) => createSignal(initial),
}))
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {}, getVoices: () => [] })
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} }))

it('a press inside the settings popover reaches it instead of starting a drag of the dock', () => {
  const captured: Element[] = []
  HTMLElement.prototype.setPointerCapture = function () {
    captured.push(this)
  }
  setVoiceOpen(true)
  const view = renderSolid(() => <VoicePanel />)
  const header = view.querySelector('[data-voice-panel] header')!
  header.querySelector<HTMLElement>('[aria-label="Voice settings"]')!.click()
  flush()
  const settings = header.querySelector('[aria-label="Voice settings options"]')!
  settings.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  expect(captured).toEqual([])
  header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  expect(captured).toEqual([header])
})
