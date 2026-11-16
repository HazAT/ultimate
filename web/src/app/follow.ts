export interface ScrollPlace {
  top: number
  seen: number
  placed?: number
  distance: number
}

export function readerLeft({
  top: currentTopPx,
  seen: topAtLastScrollEventPx,
  placed: libraryPlacedTopPx,
  distance: distanceFromBottomPx,
}: ScrollPlace): boolean {
  const highestTopBeforeCoalescedScroll = Math.max(topAtLastScrollEventPx, libraryPlacedTopPx ?? 0)
  const readerMovedUp = currentTopPx < highestTopBeforeCoalescedScroll - 1
  const awayFromBottom = () => distanceFromBottomPx > 1
  return readerMovedUp && awayFromBottom()
}
