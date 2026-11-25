import { expect, it, vi } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'

const prepares = vi.hoisted(
  () => [] as { args: { section: number }; resolve: (value: unknown) => void }[],
)
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    api: {
      action: (ref: { name: string }, args: { section: number }) =>
        ref.name === 'prepare'
          ? new Promise((resolve) => prepares.push({ args, resolve }))
          : new Promise(() => undefined),
    },
    errorMessage: String,
    ROOT: 1,
    useUiState: (key: string, initial: unknown) =>
      createSignal<unknown>(key === 'ext.read-aloud.voice' ? 'system' : initial),
  }
})
const said: string[] = []
vi.stubGlobal('speechSynthesis', {
  cancel() {},
  speak: (utterance: { text: string }) => said.push(utterance.text),
  getVoices: () => [{ name: 'Test voice' }],
  addEventListener() {},
})
vi.stubGlobal(
  'SpeechSynthesisUtterance',
  class {
    text: string
    constructor(text: string) {
      this.text = text
    }
    addEventListener() {}
  },
)

const { read, stop, current } = await import('../../player.solid.tsx')
const conversation = 5 as ConversationId

it('a section prepared after Stop, or for an earlier read of the same message, never plays', async () => {
  read(conversation, 1, 'Hello.')
  expect(current()).toMatchObject({ entry: 1, status: 'loading' })
  stop()
  read(conversation, 1, 'Hello.')
  prepares[0].resolve({ sections: 1, spoken: 'Stale.' })
  await Promise.resolve()
  expect(said).toEqual([])

  prepares[1].resolve({ sections: 1, spoken: 'Fresh.' })
  await vi.waitFor(() => expect(said).toEqual(['Fresh.']))
  stop()
  expect(current()).toBeUndefined()
})
