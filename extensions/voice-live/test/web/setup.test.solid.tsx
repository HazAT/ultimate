import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { createSignal, flush } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { setVoiceOpen } from '../../dock.solid.tsx'
import { VoicePanel } from '../../panel.solid.tsx'

const ui = vi.hoisted(() => ({
  picks: [] as unknown[],
  refetched: 0,
}))
vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  api: {
    action: (ref: { name: string }, args: unknown) => {
      if (ref.name === 'pick') ui.picks.push(args)
      return Promise.resolve({})
    },
  },
  useAction: () => {
    const [source, setSource] = createSignal<'picked' | 'default'>('picked')
    return {
      data: () => ({
        model: 'antigravity/gone-model',
        source: source(),
        thinking: 'low',
        route: 'text',
        transcribes: true,
        setup: {
          model: {
            ready: false,
            detail: `antigravity/gone-model (${source()}): model removed`,
            fix: 'Use the default, or pick another model in the prompt box below.',
          },
          transcription: { ready: true, detail: 'OpenAI transcription' },
          handsFree: { ready: true, detail: 'Jev' },
        },
      }),
      refetch: () => {
        ui.refetched++
        setSource('default')
      },
      loading: () => false,
    }
  },
  useModels: () => () => ({ providers: [], models: [] }),
  useDocOf: () => () => undefined,
  useEvent: () => undefined,
  useViewport: () => () => 'desktop',
  useUiState: (_key: string, initial: unknown) => createSignal(initial),
  useExtensionUiState: (_key: string, initial: unknown) => createSignal(initial),
}))
vi.mock('../../../models/ui.solid.tsx', () => ({ PickControl: () => null }))
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

afterEach(() => setVoiceOpen(false))

it('a stored pick shows as picked on the setup card, and Use default clears it', async () => {
  const view = renderSolid(() => <VoicePanel />)
  setVoiceOpen(true)
  flush()
  await settle()
  await vi.waitFor(() =>
    expect(view.querySelector('[data-voice-setup]')?.textContent).toContain(
      'antigravity/gone-model (picked): model removed',
    ),
  )
  await expectDistinctAgentNames(agent)
  expect(await agent.act({ steps: [{ ref: 'Use default', action: 'press' }] })).toMatchObject({
    ok: true,
  })
  await vi.waitFor(() => expect(ui.refetched).toBe(1))
  expect(ui.picks).toEqual([{ model: null }])
  await vi.waitFor(() =>
    expect(view.querySelector('[data-voice-setup]')?.textContent).toContain('(default)'),
  )
  expect(view.querySelector('[data-voice-setup] button')).toBeNull()
})
