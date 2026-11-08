/** Where the way from a dream into a fresh chapter stands, read from the dream document alone. Pure and browser-safe. */
import type { Dream, Prepared, Sleep } from './refs.ts'

/**
 * `woke`: the dream branch is concluded and Fall asleep waits; `preparing`: the user pressed it and @ultimate prepares;
 * `prepared`: a chapter prepared after the dream waits; `sleeping`, `failed`, `asleep`: Fall asleep into it runs,
 * failed or switched. `none`: nothing to do (no dream, still dreaming, or the user stays in this chapter).
 */
export type DreamStage =
  | 'none'
  | 'woke'
  | 'preparing'
  | 'prepared'
  | 'sleeping'
  | 'failed'
  | 'asleep'

/** `concludedSince(id)` is Infinity while conversation `id` is concluded (`useConcludedSince`). */
export function dreamStage(
  doc: { dream?: Dream; prepared?: Prepared; sleep?: Sleep },
  concludedSince: (id: number) => number | undefined,
): DreamStage {
  const { dream, prepared, sleep } = doc
  // A preparation from before the latest dream is stale: that dream's Fall asleep prepares anew.
  if (prepared && (!dream || prepared.at > dream.at)) {
    // Preparing deletes the sleep record, so a sleep here is always into this preparation.
    if (!sleep) return 'prepared'
    if (sleep.phase === 'asleep' || sleep.phase === 'failed') return sleep.phase
    return 'sleeping'
  }
  if (!dream || dream.dismissed || concludedSince(dream.branch) !== Infinity) return 'none'
  return dream.asked ? 'preparing' : 'woke'
}
