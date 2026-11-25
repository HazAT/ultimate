import { createEffect, createRoot, createSignal } from 'solid-js'
import { api, errorMessage, ROOT, useUiState } from '@/sdk/solid'
import { animationFrames } from '../../lib/timers.ts'
import { cell } from '../../lib/cell.ts'
import { inProcess, overshadowed } from '../../lib/errors.ts'
import { SpeakAction } from './refs.ts'
import type { OpenAiVoice } from './refs.ts'
import { createPlayer, fetchedVoice, systemVoice, systemVoices } from './speech.ts'
import type { Sentence } from './speech.ts'
import { VOICES } from './voices.ts'

export const speech = createRoot(() => {
  const [voice, setVoice] = useUiState<'system' | 'openai'>('ext.read-aloud.voice', 'openai')
  const [storedVoice, setOpenaiVoice] = useUiState('ext.read-aloud.openai-voice', 'cedar')
  const openaiVoice = (): OpenAiVoice => {
    const stored = storedVoice()
    return VOICES.find((known) => known === stored) ?? 'cedar'
  }
  const [rate, setRate] = useUiState('ext.read-aloud.rate', 1.1)
  const [keyed, setKeyed] = createSignal<boolean | undefined>()
  const failure = cell<{ key?: string; message: string } | undefined>(undefined)
  const voices = systemVoices()
  const [voiced, setVoiced] = createSignal(voices.some())
  voices.subscribe(() => setVoiced(voices.some()))
  const openaiOn = () => keyed() === true && (voice() === 'openai' || !voiced())
  const openai = fetchedVoice({
    load: async (text, signal) => {
      const { audio } = await api.action(
        SpeakAction,
        { voice: openaiVoice(), text },
        { conversationId: ROOT, signal },
      )
      return `data:audio/wav;base64,${audio}`
    },
    audio: () => new Audio(),
    failed: (error) => {
      failure.set({ key: player.state.get().key, message: `OpenAI voice: ${errorMessage(error)}` })
      player.stop()
    },
  })
  const system = systemVoice()
  let holding = () => false
  const player = createPlayer({
    rate,
    enabled: () => true,
    listening: () => holding(),
    frame: animationFrames,
    engine: () => (openaiOn() ? openai : system),
  })
  createEffect(openaiOn, () => player.switched())
  return {
    ...player,
    load(
      key: string,
      sentences: readonly Sentence[],
      streaming: boolean,
      hold: () => boolean = () => false,
    ) {
      failure.set(undefined)
      holding = hold
      player.load(key, sentences, streaming)
    },
    failure,
    voice,
    setVoice,
    openaiVoice,
    setOpenaiVoice,
    rate,
    setRate,
    keyed,
    setKeyed,
    voiced,
    openaiOn,
    warm() {
      if (!openaiOn()) return
      inProcess(
        'opening the voice connection early only saves this page time',
        api
          .action(SpeakAction, { voice: openaiVoice() }, { conversationId: ROOT })
          .catch(overshadowed),
      )
    },
  }
})

export type Speech = typeof speech
