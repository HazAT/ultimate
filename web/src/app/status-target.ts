let phoneComposerStatusPortal: HTMLElement | null = null
const listeners = new Set<() => void>()

export function setStatusTarget(element: HTMLElement | null) {
  phoneComposerStatusPortal = element
  for (const listener of listeners) listener()
}

export const statusTarget = () => phoneComposerStatusPortal

export function subscribeStatusTarget(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
