import type { Preview } from './refs.ts'

export const isLoopback = (hostname: string) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(hostname)
export const canFrameLoopbackPreviews = isLoopback(location.hostname)

let previews: Preview[] | undefined
let shown: { preview: Preview; url: string } | undefined
let refetch = () => {}
const listeners = new Set<() => void>()
const changed = () => {
  for (const listener of listeners) listener()
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const getPreviews = () => previews
export const getShown = () => shown
export const refetchPreviews = () => refetch()

export function show(preview: Preview | undefined, url = preview?.url) {
  shown = preview && url ? { preview, url } : undefined
  changed()
}

export function polled(data: Preview[], again: () => void) {
  refetch = again
  previews = data
  if (shown && !data.some((preview) => preview.running && preview.id === shown?.preview.id))
    shown = undefined
  changed()
}
