import { cell } from '../../lib/cell.web.ts'

export const specKey = 'spec'
export const defaultSpec = 'uncommitted'

export type ReviewTarget = { file: string; line: number; side?: 'old' | 'new' }
export type ReviewRequest = { spec: string; at?: ReviewTarget }

export const {
  get: getTarget,
  set: setTarget,
  subscribe: subscribeTarget,
} = cell<ReviewTarget | undefined>(undefined, { notifyOnEqual: true })
