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

type Doc = { dream?: Dream; prepared?: Prepared; sleep?: Sleep }

function chapterStage({ dream, prepared, sleep }: Doc): DreamStage | undefined {
  const preparedAfterLatestDream = prepared && (!dream || prepared.at > dream.at)
  if (!preparedAfterLatestDream) return undefined
  const sleepForPreparation = sleep
  if (!sleepForPreparation) return 'prepared'
  if (sleepForPreparation.phase === 'asleep' || sleepForPreparation.phase === 'failed')
    return sleepForPreparation.phase
  return 'sleeping'
}

export function preparedChapterWaits(doc: Doc) {
  const stage = chapterStage(doc)
  return stage === 'prepared' || stage === 'sleeping' || stage === 'failed'
}

export function dreamStage(
  doc: Doc,
  concludedSince: (id: ConversationId) => number | undefined,
): DreamStage {
  const stage = chapterStage(doc)
  if (stage) return stage
  const { dream } = doc
  const concludedNow = Infinity
  if (!dream || dream.dismissed || concludedSince(dream.branch) !== concludedNow) return 'none'
  return dream.asked ? 'preparing' : 'woke'
}
