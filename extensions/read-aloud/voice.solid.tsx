import { createEffect, createRoot, createSignal } from 'solid-js'
import { api, errorMessage, ROOT, useUiState } from '@/sdk/solid'
import { animationFrames } from '../../lib/timers.shared.ts'
import { cell } from '../../lib/cell.web.ts'
import { overshadowed } from '../../lib/errors.shared.ts'
import { SpeakAction } from './refs.ts'
import type { OpenAiVoice } from './refs.ts'
import { createPlayer, fetchedVoice, systemVoice, systemVoices } from './speech.web.ts'
import type { Sentence } from './speech.web.ts'
import { VOICES } from './voices.shared.ts'

export const BLOCKED = 'Tap ▶ to let this page play sound'

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
    audio: new Audio(),
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
  for (const type of ['pointerdown', 'pointerup', 'keydown'] as const)
    addEventListener(
      type,
      () => {
        openai.unlock?.()
        system.unlock?.()
      },
      { capture: true },
    )
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
      void api
        .action(SpeakAction, { voice: openaiVoice() }, { conversationId: ROOT })
        .catch(overshadowed)
    },
  }
})

export type Speech = typeof speech
