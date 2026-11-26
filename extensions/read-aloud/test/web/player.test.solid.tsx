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
const utterances: { listeners: Map<string, (event: unknown) => void> }[] = []
vi.stubGlobal('speechSynthesis', {
  speaking: false,
  cancel() {},
  speak: (utterance: { text: string; listeners: Map<string, (event: unknown) => void> }) => {
    said.push(utterance.text)
    utterances.push(utterance)
  },
  getVoices: () => [{ name: 'Test voice' }],
  addEventListener() {},
})
vi.stubGlobal(
  'SpeechSynthesisUtterance',
  class {
    text: string
    listeners = new Map<string, (event: unknown) => void>()
    constructor(text: string) {
      this.text = text
    }
    addEventListener(type: string, listener: (event: unknown) => void) {
      this.listeners.set(type, listener)
    }
  },
)

const { read, resume, stop, current, playSection, sectionOf } =
  await import('../../player.solid.tsx')
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

it('a tap primes the system voice, and a voice the browser refuses waits paused for ▶', async () => {
  stop()
  said.length = 0
  prepares.length = 0
  dispatchEvent(new Event('pointerdown'))
  expect(said).toEqual([' '])
  read(conversation, 4, 'Blocked.')
  prepares[0].resolve({ sections: 1, spoken: 'Blocked here.' })
  await vi.waitFor(() => expect(said.at(-1)).toBe('Blocked here.'))
  utterances.at(-1)!.listeners.get('error')!({ error: 'not-allowed' })
  expect(current()).toMatchObject({ entry: 4, status: 'paused', blocked: true })
  expect(current()?.error).toBeUndefined()
  resume()
  expect(current()).toMatchObject({ entry: 4, status: 'playing', blocked: false })
  expect(said.at(-1)).toBe('Blocked here.')
  expect(prepares).toHaveLength(1)
  stop()
})
