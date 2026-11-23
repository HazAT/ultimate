import type { Sound } from './cues.ts'

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
