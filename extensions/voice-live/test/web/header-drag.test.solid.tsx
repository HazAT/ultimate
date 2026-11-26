import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { dock, setVoiceOpen } from '../../dock.solid.tsx'
import { VoicePanel } from '../../panel.solid.tsx'

const ui = vi.hoisted(() => ({ folded: false }))
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  useAction: () => ({
    data: () => ({ model: 'google/gemini-4-neon', thinking: 'low' }),
    refetch() {},
  }),
  useModels: () => () => ({
    providers: [],
    models: [
      {
        provider: 'google',
        id: 'gemini-4-neon',
        reasoning: true,
        thinkingLevels: ['off', 'low', 'high'],
      },
    ],
  }),
  useDocOf: () => () => undefined,
  useEvent: () => undefined,
  useExtensionUiState: (key: string, initial: unknown) =>
    createSignal(key === 'folded' ? ui.folded : initial),
}))
vi.stubGlobal('speechSynthesis', { cancel() {}, speak() {}, getVoices: () => [] })
vi.stubGlobal('SpeechSynthesisUtterance', EventTarget)
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} }))

const agent = createAgent()

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

it('before a session exists, the prompt box shows the voice model chip', async () => {
  ui.folded = false
  const view = renderSolid(() => <VoicePanel />)
  await settle()
  setVoiceOpen(true)
  flush()
  const chip = () => view.querySelector('[data-ui="prompt-box"] [aria-label="Voice model"]')
  expect(chip()?.textContent).toContain('gemini-4-neon·low')
  await expectDistinctAgentNames(agent)
  dock.setPhase('recording')
  flush()
  expect(chip()).toBeNull()
  dock.setPhase('idle')
  flush()
  expect(chip()).not.toBeNull()
})

it('folded, the dock is its prompt box, with a status line only while voice has something to say', async () => {
  ui.folded = true
  const view = renderSolid(() => <VoicePanel />)
  await settle()
  setVoiceOpen(true)
  flush()
  expect(view.querySelectorAll('[data-ui="prompt-box"]')).toHaveLength(1)
  expect(view.querySelector('[data-voice-line]')).toBeNull()
  await expectDistinctAgentNames(agent)
  dock.setStatus('Thinking…')
  flush()
  expect(view.querySelector('[data-voice-line]')?.textContent).toBe('Thinking…')
  dock.setStatus(undefined)
})
