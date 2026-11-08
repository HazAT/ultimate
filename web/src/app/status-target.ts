import { useSyncExternalStore } from 'react'

/**
 * Where a phone's status line takes the shown conversation's `composer.status` items: the status line registers it,
 * the main composer portals into it, so the context line folds into the status line instead of taking its own row.
 * Surfaces without a composer leave it empty.
 */
let target: HTMLElement | null = null
const listeners = new Set<() => void>()

export function setStatusTarget(element: HTMLElement | null) {
  target = element
  for (const listener of listeners) listener()
}

export const useStatusTarget = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => target,
  )
