import type { Sound } from './cues.ts'
import type { Note } from './engine.ts'

export type { Note } from './engine.ts'

let volumeGain01 = 1
let lazyEngine: Promise<typeof import('./engine.ts')> | undefined

export const engine = () =>
  (lazyEngine ??= import('./engine.ts').then((tone) => {
    tone.setVolume(volumeGain01)
    return tone
  }))

export function setVolume(nextGain01: number) {
  volumeGain01 = nextGain01
  lazyEngine
    ?.then((tone) => tone.setVolume(nextGain01))
    .catch((error: unknown) => console.warn('Volume failed', error))
}

export const play = async (sound: Sound) => (await engine()).play(sound)

export const say = async (sound: Sound, text: string, pcm?: ArrayBuffer) =>
  (await engine()).say(sound, text, pcm)

export const playNotes = async (notes: readonly Note[], gain01 = 0.18) =>
  (await engine()).playNotes(notes, gain01)
