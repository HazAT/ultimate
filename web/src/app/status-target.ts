import { useSyncExternalStore } from 'react'

let phoneComposerStatusPortal: HTMLElement | null = null
const listeners = new Set<() => void>()

export function setStatusTarget(element: HTMLElement | null) {
  phoneComposerStatusPortal = element
  for (const listener of listeners) listener()
}

export const useStatusTarget = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => phoneComposerStatusPortal,
  )
