import { flush } from 'solid-js'
import { beforeEach, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ spoken: [] as string[], said: [] as string[] }))
vi.mock('@/sdk/solid', async () => {
  const { createSignal } = await import('solid-js')
  return {
    api: {
      action: (ref: { name: string }, args: { text?: string }) => {
        if (ref.name === 'speak' && args.text) harness.spoken.push(args.text)
        return new Promise(() => undefined)
      },
    },
    errorMessage: String,
    ROOT: 1,
    useConversation: () => () => ({ entries: [], live: {}, busy: false }),
    useUiState: (_key: string, initial: unknown) => createSignal<unknown>(initial),
  }
})

class FakeSynth extends EventTarget {
  voices: unknown[] = []
  getVoices = () => this.voices
  cancel() {}
  speak(utterance: { text: string }) {
    harness.said.push(utterance.text)
  }
}

beforeEach(() => {
  vi.resetModules()
  harness.spoken.length = 0
  harness.said.length = 0
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
})

const speakWith = async (synth: FakeSynth) => {
  vi.stubGlobal('speechSynthesis', synth)
  const { speech } = await import('../../voice.solid.tsx')
  const { splitSentences } = await import('../../speech.web.ts')
  speech.setVoice('system')
  speech.setKeyed(true)
  flush()
  const say = () => {
    speech.load('reply', [], true)
    speech.push('reply', splitSentences('Hello there.', true).sentences[0])
  }
  return { speech, say }
}

it('speaks with OpenAI when the browser has no system voices and a key is set', async () => {
  const { speech, say } = await speakWith(new FakeSynth())
  expect(speech.voice()).toBe('system')
  say()
  await vi.waitFor(() => expect(harness.spoken).toEqual(['Hello there.']))
  expect(harness.said).toEqual([])
})

it('keeps the system voice when the browser has voices, including ones that load late', async () => {
  const synth = new FakeSynth()
  const { speech, say } = await speakWith(synth)
  synth.voices = [{ name: 'Late voice' }]
  synth.dispatchEvent(new Event('voiceschanged'))
  flush()
  expect(speech.openaiOn()).toBe(false)
  say()
  expect(harness.said).toEqual(['Hello there.'])
  expect(harness.spoken).toEqual([])
})
