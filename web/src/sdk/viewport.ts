import { useSyncExternalStore } from 'react'

/**
 * How much room the window has. On a `phone` the sidebar and the panel overlay the conversation; on a `tablet` (an
 * unfolded foldable, a narrow window) the sidebar docks beside it and the panel overlays; on a `desktop` both dock.
 * Below `desktop` their open state is the tab's own, so a phone never folds away the desktop's; it starts closed, except
 * a tablet's docked sidebar (`ownDefault` in actions.ts).
 */
export type Viewport = 'phone' | 'tablet' | 'desktop'

let queries: { tablet: MediaQueryList; desktop: MediaQueryList } | undefined
const media = () =>
  (queries ??= {
    tablet: matchMedia('(min-width: 768px)'),
    desktop: matchMedia('(min-width: 1024px)'),
  })

export function viewport(): Viewport {
  const { tablet, desktop } = media()
  return desktop.matches ? 'desktop' : tablet.matches ? 'tablet' : 'phone'
}

function subscribe(listener: () => void) {
  const { tablet, desktop } = media()
  tablet.addEventListener('change', listener)
  desktop.addEventListener('change', listener)
  return () => {
    tablet.removeEventListener('change', listener)
    desktop.removeEventListener('change', listener)
  }
}

export const useViewport = () => useSyncExternalStore(subscribe, viewport)

/** Whether the device types on a touch keyboard, which focusing an input would slide up over the page. */
export const touchKeyboard = () => matchMedia('(pointer: coarse)').matches

export const overlays = (region: 'sidebar' | 'panels', on: Viewport = viewport()) =>
  on === 'phone' || (region === 'panels' && on === 'tablet')
