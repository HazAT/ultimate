/** Dictation's page-wide microphone, shortcut routing, talk gestures, and durable settings. */

export { base64, capture, drawWave, MIN_SPOKEN_SECONDS } from './capture.ts'
/** A finished microphone take. */
export type { Recorded } from './capture.ts'
/** Receives a take; `finish` is told when the same sink already owns a retake. */
export type { Sink } from './capture.ts'
/** One press of the microphone: `started` once it records, then `release` sends it or `cancel` discards it. */
export type { Take } from './capture.ts'

/** Whether the talk shortcut and touch use hold-to-record or tap-to-toggle. */
export { talkMode } from './routing.solid.tsx'
/** The keyboard chord used to talk. */
export { shortcut } from './routing.solid.tsx'
/** The talk shortcut, Hold/Tap and sound-cue settings, for another popover to show; `name` names its controls. */
export { DictationOptions } from './settings.solid.tsx'
/** Route an unfocused shortcut to this sink, waking its UI before capture; `undefined` restores the main composer. */
export { setFallback } from './routing.solid.tsx'
