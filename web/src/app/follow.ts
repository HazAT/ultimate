export interface ScrollPlace {
  top: number
  seen: number
  placed?: number
  distance: number
}

export function readerLeft({
  top: currentTopPx,
  seen: topAtLastScrollEventPx,
  placed: programPlacedTopPx,
  distance: distanceFromBottomPx,
}: ScrollPlace): boolean {
  const highestTopBeforeCoalescedScroll = Math.max(topAtLastScrollEventPx, programPlacedTopPx ?? 0)
  const readerMovedUp = currentTopPx < highestTopBeforeCoalescedScroll - 1
  const awayFromBottom = () => distanceFromBottomPx > 1
  return readerMovedUp && awayFromBottom()
}

const nearBottomPx = 70

export function follow(scroll: HTMLElement, content: HTMLElement, changed: () => void) {
  let following = true
  let atBottom = true
  let seen = scroll.scrollTop
  let placed: number | undefined
  const distance = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
  const report = (next: { following?: boolean }) => {
    const nextFollowing = next.following ?? following
    const nextAtBottom = nextFollowing || distance() <= nearBottomPx
    if (nextFollowing === following && nextAtBottom === atBottom) return
    following = nextFollowing
    atBottom = nextAtBottom
    changed()
  }
  const place = (top: number) => {
    scroll.scrollTop = top
    placed = scroll.scrollTop
    seen = placed
  }
  const bottom = () => scroll.scrollHeight - scroll.clientHeight
  const left = () => readerLeft({ top: scroll.scrollTop, seen, placed, distance: distance() })
  let pressed = false
  const press = () => {
    pressed = true
  }
  const release = () => {
    pressed = false
  }
  const selecting = () => pressed && !!getSelection()?.toString()
  const onScroll = () => {
    const top = scroll.scrollTop
    const readerMoved = placed === undefined || Math.abs(top - placed) > 1
    if (readerMoved && left()) report({ following: false })
    else if (readerMoved && !following && top > seen + 1 && distance() <= 1)
      report({ following: true })
    else report({})
    seen = top
    placed = undefined
  }
  const scrollsItself = (element: Element) =>
    element.scrollHeight > element.clientHeight &&
    /auto|scroll/.test(getComputedStyle(element).overflowY)
  const ownerOf = (target: EventTarget | null) => {
    for (
      let element = target instanceof Element ? target : null;
      element;
      element = element.parentElement
    )
      if (element === scroll || scrollsItself(element)) return element
    return null
  }
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY < 0 && ownerOf(event.target) === scroll && scrollsItself(scroll))
      report({ following: false })
  }
  const grow = new ResizeObserver(() => {
    if (following && !selecting()) place(bottom())
    report({})
  })
  scroll.addEventListener('scroll', onScroll, { passive: true })
  scroll.addEventListener('wheel', onWheel, { passive: true })
  scroll.addEventListener('pointerdown', press, { passive: true })
  window.addEventListener('pointerup', release, { passive: true })
  grow.observe(scroll)
  grow.observe(content)
  place(bottom())
  return {
    following: () => following,
    atBottom: () => atBottom,
    left,
    place,
    stop: () => report({ following: false }),
    toBottom: (instant = false) => {
      report({ following: true })
      if (instant) place(bottom())
      else {
        placed = undefined
        scroll.scrollTo({ top: bottom(), behavior: 'smooth' })
      }
    },
    dispose: () => {
      grow.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      scroll.removeEventListener('wheel', onWheel)
      scroll.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
    },
  }
}
export type Follow = ReturnType<typeof follow>
