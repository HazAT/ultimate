import { pace } from '../../lib/timers.ts'
import type { Cue } from './cues.ts'
import { linesOf } from './narration.ts'
import type { Line } from './narration.ts'

const cueGatherMs = 1500

const unsaidSessionKey = 'ultimate.sounds.unsaid'

export function speaker(
  say: (line: Line) => Promise<void>,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
) {
  let unsaid: Cue[] = JSON.parse(storage.getItem(unsaidSessionKey) ?? '[]')
  let waiting: Cue[] = []
  let busy = false
  const persistUntilSpoken = (cues: Cue[]) => {
    unsaid = cues
    storage.setItem(unsaidSessionKey, JSON.stringify(cues))
  }
  const speakSerialBatches = async () => {
    busy = true
    try {
      while (waiting.length) {
        await pace(cueGatherMs)
        const cues = waiting
        waiting = []
        for (const line of linesOf(cues)) {
          await say(line)
          const said = new Set(cues.filter((cue) => cue.sound === line.sound).map((cue) => cue.key))
          persistUntilSpoken(unsaid.filter((cue) => !said.has(cue.key)))
        }
      }
    } finally {
      busy = false
    }
  }
  const add = (cues: readonly Cue[]) => {
    const known = new Set(waiting.map((cue) => cue.key))
    const fresh = cues.filter((cue) => !known.has(cue.key))
    if (!fresh.length) return
    waiting.push(...fresh)
    persistUntilSpoken([...unsaid.filter((cue) => !fresh.some((f) => f.key === cue.key)), ...fresh])
    if (!busy)
      speakSerialBatches().catch((error: unknown) => console.warn('Narrator failed', error))
  }
  return {
    add,

    resume: (switched: boolean) => (switched ? add(unsaid) : persistUntilSpoken([])),
  }
}
