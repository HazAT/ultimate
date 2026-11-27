import { cell } from '../../../lib/cell.web.ts'

export const {
  get: statusTarget,
  set: setStatusTarget,
  subscribe: subscribeStatusTarget,
} = cell<HTMLElement | null>(null, { notifyOnEqual: true })
