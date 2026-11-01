import type { Sound } from './cues.ts'
import type { Note } from './engine.ts'

export type { Note } from './engine.ts'

let volume = 1
let loaded: Promise<typeof import('./engine.ts')> | undefined

/** The Tone.js engine, loaded on first sound: loading it opens an AudioContext. */
export const engine = () =>
  (loaded ??= import('./engine.ts').then((tone) => {
    tone.setVolume(volume)
    return tone
  }))

/** Sets the volume of every sound from 0 to 1, without loading the engine for it. */
export function setVolume(value: number) {
  volume = value
  loaded
    ?.then((tone) => tone.setVolume(value))
    .catch((error: unknown) => console.warn('Volume failed', error))
}

/** Plays `sound`; a browser lets a page play once someone has clicked or typed in it. */
export const play = async (sound: Sound) => (await engine()).play(sound)

/** Says a narrator line after `sound`: `pcm` is the voice, or absent for the browser's own. */
export const say = async (sound: Sound, text: string, pcm?: ArrayBuffer) =>
  (await engine()).say(sound, text, pcm)

/** Plays `notes` as bells at `volume` (the notification sounds use 0.18); the same rule on clicks applies. */
export const playNotes = async (notes: readonly Note[], level = 0.18) =>
  (await engine()).playNotes(notes, level)
