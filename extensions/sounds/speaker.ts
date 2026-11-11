import type { Cue } from './cues.ts'
import { linesOf } from './narration.ts'
import type { Line } from './narration.ts'

/** How long the narrator gathers cues before speaking, so what arrives together becomes one line. */
const gatherMs = 1500

/** Where a tab keeps the cues it claimed but has not said yet: its own session, which a reload keeps. */
const keptKey = 'ultimate.sounds.unsaid'

/**
 * Speaks lines one at a time with `say`: cues that arrive while it gathers or speaks join the next line. Until a line is
 * said its cues stay in `storage`, so a page that reloads onto a new web bundle in the middle of one (every landing that
 * changes the UI does, about a second after its cue: #572100) can `resume` them.
 */
export function speaker(
  say: (line: Line) => Promise<void>,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
) {
  let unsaid: Cue[] = JSON.parse(storage.getItem(keptKey) ?? '[]')
  let waiting: Cue[] = []
  let busy = false
  const keep = (cues: Cue[]) => {
    unsaid = cues
    storage.setItem(keptKey, JSON.stringify(cues))
  }
  const run = async () => {
    busy = true
    try {
      while (waiting.length) {
        await new Promise((resolve) => setTimeout(resolve, gatherMs))
        const cues = waiting
        waiting = []
        for (const line of linesOf(cues)) {
          await say(line)
          const said = new Set(cues.filter((cue) => cue.sound === line.sound).map((cue) => cue.key))
          keep(unsaid.filter((cue) => !said.has(cue.key)))
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
    keep([...unsaid.filter((cue) => !fresh.some((f) => f.key === cue.key)), ...fresh])
    if (!busy) run().catch((error: unknown) => console.warn('Narrator failed', error))
  }
  return {
    add,
    /** Says what this tab had claimed but not said when it reloaded onto a new bundle; any other load drops it. */
    resume: (switched: boolean) => (switched ? add(unsaid) : keep([])),
  }
}
