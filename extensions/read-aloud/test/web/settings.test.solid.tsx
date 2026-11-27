import { settle } from '@ui-sdk/core/testing'
import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'

vi.mock('@/sdk/solid', async (original) => {
  const { createSignal } = await import('solid-js')
  return {
    ...(await original<typeof import('@/sdk/solid')>()),
    api: { action: () => new Promise(() => undefined) },
    useUiState: (_key: string, initial: unknown) => createSignal<unknown>(initial),
  }
})
vi.stubGlobal('speechSynthesis', {
  cancel() {},
  speak() {},
  getVoices: () => [{ name: 'Test voice' }],
  addEventListener() {},
})
vi.stubGlobal('SpeechSynthesisUtterance', EventTarget)

const { PlaybackBar } = await import('../../bar.solid.tsx')
const { speech } = await import('../../voice.solid.tsx')
const agent = createAgent()

it("the playback bar's speed opens read aloud's own voice and speed settings", async () => {
  speech.setKeyed(true)
  const view = renderSolid(() => (
    <>
      <PlaybackBar name="Composer" status="Reading" toggle={() => undefined} />
      <PlaybackBar name="Voice dock" status="Speaking" toggle={() => undefined} />
    </>
  ))
  await expectDistinctAgentNames(agent)
  await settle()
  const trigger = view.querySelector<HTMLElement>('[aria-label="Speech settings in Composer"]')!
  expect(trigger.textContent).toBe('1.1×')
  trigger.click()
  flush()
  expect(
    document.querySelector('[aria-label="Speech settings options in Composer"]'),
  ).not.toBeNull()
  await expectDistinctAgentNames(agent)
  await agent.act({
    steps: [{ ref: 'OpenAI voice in Composer', action: 'setValue', args: ['marin'] }],
  })
  expect(speech.openaiVoice()).toBe('marin')
  await agent.act({ steps: [{ ref: 'Speech speed in Composer', action: 'setValue', args: [1.5] }] })
  flush()
  expect(trigger.textContent).toBe('1.5×')
  await agent.act({
    steps: [{ ref: 'Speech voice in Composer', action: 'setValue', args: ['system'] }],
  })
  flush()
  expect(speech.voice()).toBe('system')
  expect(document.querySelector('[aria-label="OpenAI voice in Composer"]')).toBeNull()
})
