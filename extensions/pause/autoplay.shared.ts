import type { PauseDocState } from './refs.ts'

export const defaultAutoPlayMinutes = 30

export const autoPlayMinutes = (doc: Pick<PauseDocState, 'autoPlay'>) =>
  doc.autoPlay === false ? undefined : (doc.autoPlay ?? defaultAutoPlayMinutes)
