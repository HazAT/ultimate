import type { ConversationId } from '@earendil-works/pi-durable'
import type { Dream, Prepared, Sleep } from './refs.ts'

export type DreamStage =
  | 'none'
  | 'woke'
  | 'preparing'
  | 'prepared'
  | 'sleeping'
  | 'failed'
  | 'asleep'

export function dreamStage(
  doc: { dream?: Dream; prepared?: Prepared; sleep?: Sleep },
  concludedSince: (id: ConversationId) => number | undefined,
): DreamStage {
  const { dream, prepared, sleep } = doc
  const preparedAfterLatestDream = prepared && (!dream || prepared.at > dream.at)
  if (preparedAfterLatestDream) {
    const sleepForPreparation = sleep
    if (!sleepForPreparation) return 'prepared'
    if (sleepForPreparation.phase === 'asleep' || sleepForPreparation.phase === 'failed')
      return sleepForPreparation.phase
    return 'sleeping'
  }
  const concludedNow = Infinity
  if (!dream || dream.dismissed || concludedSince(dream.branch) !== concludedNow) return 'none'
  return dream.asked ? 'preparing' : 'woke'
}
