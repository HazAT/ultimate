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

const { read, stop, current, playSection, sectionOf } = await import('../../player.solid.tsx')
const { speech } = await import('../../voice.solid.tsx')
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

it('after a playback failure, a later section waits for Retry instead of playing', async () => {
  said.length = 0
  prepares.length = 0
  read(conversation, 2, 'Long message.')
  prepares[0].resolve({ sections: 2, spoken: 'First part.' })
  await vi.waitFor(() => expect(said).toEqual(['First part.']))
  speech.failure.set({ key: speech.state.get().key, message: 'The audio could not play' })
  speech.stop()
  await vi.waitFor(() => expect(prepares).toHaveLength(2))
  prepares[1].resolve({ sections: 2, spoken: 'Second part.' })
  await Promise.resolve()
  expect(said).toEqual(['First part.'])
  expect(current()).toMatchObject({ entry: 2, error: 'The audio could not play' })
})

it('a click on a section plays it: from where it was read, or preparing from that section on', async () => {
  stop()
  said.length = 0
  prepares.length = 0
  read(conversation, 3, 'Three sections.')
  prepares[0].resolve({ sections: 3, spoken: 'Zero one. Zero two.' })
  await vi.waitFor(() => expect(prepares).toHaveLength(2))
  prepares[1].resolve({ sections: 3, spoken: 'One.' })
  await vi.waitFor(() => expect(prepares).toHaveLength(3))
  expect([0, 1, 2].map(sectionOf)).toEqual([0, 0, 1])

  playSection(conversation, 3, 'Three sections.', 1)
  expect(speech.state.get()).toMatchObject({ index: 2, playing: true })
  expect(said.at(-1)).toBe('One.')

  playSection(conversation, 3, 'Three sections.', 2)
  await vi.waitFor(() => expect(prepares).toHaveLength(4))
  expect(prepares[3].args).toMatchObject({ section: 2 })
  prepares[3].resolve({ sections: 3, spoken: 'Two.' })
  await vi.waitFor(() => expect(said.at(-1)).toBe('Two.'))
  expect(sectionOf(0)).toBe(2)
  stop()
})
