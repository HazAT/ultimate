export const specKey = 'spec'
export const defaultSpec = 'uncommitted'

export type ReviewTarget = { file: string; line: number; side?: 'old' | 'new' }
export type ReviewRequest = { spec: string; at?: ReviewTarget }

let target: ReviewTarget | undefined
const listeners = new Set<() => void>()

export const getTarget = () => target

export function subscribeTarget(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setTarget(next?: ReviewTarget) {
  target = next
  for (const listener of listeners) listener()
}
