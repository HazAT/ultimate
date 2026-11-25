/** Dictation's page-wide microphone capture, talk gestures, and durable talk settings. */
import { createRoot } from 'solid-js'
import { useUiState } from '@/sdk/solid'

export { animationFrames, base64, capture, drawWave, MIN_SPOKEN_SECONDS } from './capture.ts'
export type { Recorded } from './capture.ts'
/** Receives a take; `finish` is told when the same sink already owns a retake. */
export type { Sink } from './capture.ts'
export { createTalk } from './talk.ts'

/** Whether the talk shortcut is held down or tapped to toggle recording. */
export const [talkMode, setTalkMode] = createRoot(() =>
  useUiState<'hold' | 'tap'>('ext.dictation.talk', 'hold'),
)
/** The keyboard chord used to talk. */
export const [shortcut, setShortcut] = createRoot(() =>
  useUiState('ext.dictation.shortcut', 'mod+shift+space'),
)
