import type { Sound } from './cues.ts'
import type { Note } from './engine.ts'

export type { Note } from './engine.ts'

let volume = 1
let engineLoadingOnFirstSound: Promise<typeof import('./engine.ts')> | undefined

export const engine = () =>
  (engineLoadingOnFirstSound ??= import('./engine.ts').then((tone) => {
    tone.setVolume(volume)
    return tone
  }))

export function setVolume(value: number) {
  volume = value
  engineLoadingOnFirstSound
    ?.then((tone) => tone.setVolume(value))
    .catch((error: unknown) => console.warn('Volume failed', error))
}

export const play = async (sound: Sound) => (await engine()).play(sound)

export const say = async (sound: Sound, text: string, pcm?: ArrayBuffer) =>
  (await engine()).say(sound, text, pcm)

export const playNotes = async (notes: readonly Note[], level = 0.18) =>
  (await engine()).playNotes(notes, level)
